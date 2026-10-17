/**
 * MATLAB execution core: process lifecycle, output capture, artifact collection,
 * cancellation, and bounded concurrency.
 *
 * Design notes proven on this host:
 *  - MATLAB is launched with `-batch`, which is headless and propagates errors
 *    through the process exit status.
 *  - The wrapper script lives in an ASCII run directory and is invoked by NAME
 *    with `-sd <runDir>`. A filename whose stem starts with `_` cannot be
 *    executed by MATLAB's parser, so generated stems never start with `_`.
 *  - Non-ASCII paths (including CJK working directories) are passed to MATLAB
 *    through the environment, which is proven to round-trip UTF-8 exactly.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { buildRunner } from './matlab-script.js'
import { discoverMatlab } from './matlab-discovery.js'
import { stageInput, unstageText } from './matlab-staging.js'

/** Figure/media extensions collected from the output directory. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'])
/** Document/vector extensions; the first one may be surfaced as the primary figure. */
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'eps', 'svg'])
/** Data extensions. */
const DATA_EXTENSIONS = new Set(['mat', 'csv', 'json', 'txt', 'xlsx'])

/** Media type per image extension, for attachment publishing. */
const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * Bound how many MATLAB processes this plugin runs at once. A MATLAB batch
 * session is a heavyweight, licence-consuming process; serialising also keeps
 * stdout attribution unambiguous.
 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    this.queue = []
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise(resolve => this.queue.push(resolve))
    this.active += 1
  }

  release() {
    this.active -= 1
    const next = this.queue.shift()
    if (next) next()
  }
}

/** Milliseconds of wall clock, derived from a monotonic source. */
function now() {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

/** Create a per-invocation ASCII run directory under the OS temp root. */
function makeRunDir(root) {
  const base = root && root.trim() ? root : join(tmpdir(), 'dsh-matlab-simulink')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, `run-${process.pid}-`))
}

/** Best-effort recursive delete; never throws. */
function removeDir(path) {
  if (!path) return
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* a locked figure file must not fail the tool call */
  }
}

/** Read a text file or return undefined. */
function readTextOrUndefined(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Split raw MATLAB stdout into an ordered event list and a human transcript.
 * Recognized prefixes are stripped from the transcript so the model sees clean
 * output while the structured events stay available.
 */
function parseOutput(raw) {
  const events = []
  const transcript = []
  for (const line of raw.split(/\r?\n/)) {
    const tagged = /^DSH_(INFO|WARN|ERROR|FIGURE|SIGNAL):\s*(.*)$/.exec(line)
    if (tagged) {
      events.push({ kind: tagged[1].toLowerCase(), detail: tagged[2] })
      transcript.push(line)
      continue
    }
    transcript.push(line)
  }
  return { events, transcript: transcript.join('\n').trim() }
}

/**
 * Run one MATLAB batch job.
 *
 * @param {object} options
 * @param {string} options.exe - absolute matlab.exe
 * @param {string} [options.code] - user MATLAB body (mutually exclusive with sourceFile)
 * @param {string} [options.sourceFile] - user .m file to run from a staged ASCII copy
 * @param {string} [options.workDir]
 * @param {string} options.outputDir
 * @param {object} options.figures - figure/export policy
 * @param {boolean} [options.requireSimulink]
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.tempRoot]
 * @param {number} [options.maxArtifactBytes]
 * @param {number} [options.maxInlineImageBytes]
 * @param {(message: string) => void} [options.report]
 * @returns {Promise<object>} structured run result
 */
export async function runMatlabJob(options) {
  const {
    exe, code = '', sourceFile, workDir, outputDir, figures, requireSimulink = false,
    timeoutMs, signal, tempRoot, maxArtifactBytes = 25 * 1024 * 1024,
    maxInlineImageBytes = 6 * 1024 * 1024, report,
  } = options

  const runDir = makeRunDir(tempRoot)
  const stem = 'dsh_runner'
  const runnerPath = join(runDir, `${stem}.m`)
  const errorLog = join(runDir, 'dsh_error.txt')
  const doneLog = join(runDir, 'dsh_done.txt')
  const started = now()

  // A non-ASCII input path is staged into the ASCII run directory: MATLAB's
  // parser refuses to run a script it reaches through a non-ASCII path.
  const mappings = []
  let staged
  if (sourceFile) {
    try {
      staged = stageInput(sourceFile, runDir)
    } catch (error) {
      removeDir(runDir)
      return {
        ok: false,
        failure: `cannot stage ${sourceFile} for MATLAB: ${error.message}`,
        failureKind: 'stage',
      }
    }
    mappings.push([staged.stagedPath, staged.originalPath])
  }

  const source = buildRunner({
    code,
    userScript: staged?.stagedPath,
    userScriptLabel: staged?.originalPath,
    runDir,
    workDir: workDir ?? staged?.originalDir,
    requireSimulink,
    figures,
  })
  writeFileSync(runnerPath, source, { encoding: 'utf8' })

  let child
  let timedOut = false
  let aborted = false
  let spawnError

  try {
    mkdirSync(outputDir, { recursive: true })
  } catch (error) {
    removeDir(runDir)
    return {
      ok: false,
      failure: `cannot create output directory ${outputDir}: ${error.message}`,
      failureKind: 'output-dir',
    }
  }

  const stdoutChunks = []
  const stderrChunks = []
  // Files older than this belong to the user, not to this run.
  const spawnedAt = Date.now()

  try {
    child = spawn(exe, ['-batch', stem, '-sd', runDir], {
      cwd: runDir,
      windowsHide: true,
      env: {
        ...process.env,
        // UTF-8 round-trips non-ASCII working/output paths exactly.
        DSH_MATLAB_WORKDIR: workDir ?? '',
        DSH_MATLAB_OUTDIR: outputDir,
        DSH_MATLAB_RUNDIR: runDir,
      },
    })
  } catch (error) {
    removeDir(runDir)
    return { ok: false, failure: `cannot start MATLAB: ${error.message}`, failureKind: 'spawn' }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  const capture = (stream, sink) => {
    if (!stream) return
    stream.on('data', chunk => {
      sink.push(chunk)
      if (sink === stdoutChunks) report?.(chunk)
    })
  }
  capture(child.stdout, stdoutChunks)
  capture(child.stderr, stderrChunks)
  child.on('error', error => {
    spawnError = error
  })

  const exited = new Promise(resolve => {
    child.on('exit', (code, sig) => resolve({ code, signal: sig }))
  })
  const closed = new Promise(resolve => {
    child.on('close', (code, sig) => resolve({ code, signal: sig }))
  })

  /**
   * Terminate the whole process tree.
   *
   * MATLAB starts helper processes that inherit its stdio pipes, so the child's
   * `close` event can lag far behind the actual exit. `taskkill /F /T` is run
   * synchronously to guarantee the tree is gone before the caller continues,
   * and the pipes are then released explicitly.
   */
  const killTree = ({ flushPipes = true } = {}) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    try {
      spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
        windowsHide: true,
        timeout: 15_000,
        stdio: 'ignore',
      })
    } catch {
      /* taskkill unavailable: fall back to the direct signal */
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    if (flushPipes) {
      // Any bytes already buffered stay captured; the pipes are then released so
      // a lingering grandchild cannot hold the run open.
      setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, 250)
    }
  }

  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    : undefined

  const onAbort = () => {
    aborted = true
    killTree()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  // Prefer the prompt `exit` event. If the pipes stay open afterwards, give the
  // remaining output a moment, then release them and settle.
  const exit = await Promise.race([
    exited,
    closed,
  ])
  if (child.exitCode === null && child.signalCode === null) {
    await closed
  } else {
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1_500))])
    child.stdout?.destroy()
    child.stderr?.destroy()
  }

  if (timer) clearTimeout(timer)
  signal?.removeEventListener?.('abort', onAbort)

  const stdout = stdoutChunks.join('')
  const stderr = stderrChunks.join('')
  const durationMs = now() - started
  const { events, transcript } = parseOutput(stdout)
  const matlabError = readTextOrUndefined(errorLog)?.trim()
  const done = readTextOrUndefined(doneLog) !== undefined

  // outputDir wins name collisions; workDir catches `save('x.mat')` style writes.
  const artifacts = collectArtifacts([outputDir, workDir], { maxArtifactBytes, modifiedAfter: spawnedAt })

  const result = {
    ok: false,
    exitCode: exit.code,
    signal: exit.signal,
    durationMs,
    timedOut,
    aborted,
    stdout,
    stderr,
    transcript,
    events,
    matlabError,
    reachedCompletionMarker: done,
    artifacts,
    runDir,
  }

  if (aborted) {
    result.failureKind = 'aborted'
    result.failure = `MATLAB run cancelled after ${(durationMs / 1000).toFixed(1)}s.`
  } else if (timedOut) {
    result.failureKind = 'timeout'
    result.failure = `MATLAB run exceeded the ${(timeoutMs / 1000).toFixed(0)}s timeout and its process tree was terminated.`
    if (matlabError) result.failure += ` Last MATLAB error: ${matlabError}`
  } else if (spawnError) {
    result.failureKind = 'spawn'
    result.failure = `MATLAB process error: ${spawnError.message}`
  } else if (matlabError) {
    result.failureKind = 'matlab'
    result.failure = matlabError
  } else if (!done) {
    result.failureKind = 'incomplete'
    result.failure = `MATLAB exited with code ${exit.code} before reaching the end of the generated script. ${stderr.trim() || stdout.trim() || 'No diagnostic output was produced.'}`.trim()
  } else {
    // The marker proves the generated script ran to its last statement.
    result.ok = exit.code === 0
    if (!result.ok) {
      result.failureKind = 'exit-code'
      result.failure = `MATLAB finished with exit code ${exit.code} (the requested code called exit() with a non-zero status).`
    }
  }

  if (result.ok) {
    // Primary figure/doc selection and inline-image eligibility are decided here.
    result.primaryFigure = pickPrimary(artifacts)
    result.inlineImages = pickInlineImages(artifacts, maxInlineImageBytes)
  }

  // Point diagnostics at the caller's real paths, never the staging copies.
  if (mappings.length) {
    result.stdout = unstageText(result.stdout, mappings)
    result.stderr = unstageText(result.stderr, mappings)
    result.transcript = unstageText(result.transcript, mappings)
    result.matlabError = unstageText(result.matlabError, mappings)
    result.failure = unstageText(result.failure, mappings)
  }

  removeDir(runDir)
  result.runDir = undefined
  return result
}

/** Stat one directory entry into an artifact descriptor. */
function describeArtifact(dir, name, rank = 0) {
  if (name.startsWith('dsh_run_') && name.endsWith('.m')) return undefined
  if (name === 'dsh_error.txt' || name === 'dsh_done.txt') return undefined
  const path = join(dir, name)
  let info
  try {
    info = statSync(path)
  } catch {
    return undefined
  }
  if (!info.isFile()) return undefined
  const ext = extname(name).slice(1).toLowerCase()
  const category = IMAGE_EXTENSIONS.has(ext)
    ? 'image'
    : DOCUMENT_EXTENSIONS.has(ext)
      ? 'document'
      : DATA_EXTENSIONS.has(ext)
        ? 'data'
        : 'other'
  return {
    name,
    path,
    dir,
    kind: category,
    format: ext,
    bytes: info.size,
    modifiedMs: info.mtimeMs,
    rank,
  }
}

/**
 * Rescan directories touched by a run, newest first.
 *
 * Two roots are scanned because MATLAB writes to two different places: the
 * plugin's export stage writes figures into `outputDir`, while user code that
 * calls `save('x.mat')` writes into the working directory (`pwd`). Both are
 * legitimate results, with `outputDir` winning a name collision.
 *
 * `outputDir` is reported unconditionally — it belongs to this tool call. The
 * working directory is filtered by modification time so pre-existing project
 * files are never claimed as this run's output.
 */
function collectArtifacts(dirs, { maxArtifactBytes, modifiedAfter = 0 }) {
  const artifacts = []
  const seen = new Set()
  let rank = 0
  for (const dir of dirs) {
    if (!dir) continue
    const isOutputRoot = rank === 0
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      rank += 1
      continue
    }
    for (const name of entries) {
      if (seen.has(name)) continue
      const artifact = describeArtifact(dir, name, rank)
      if (!artifact) continue
      if (artifact.kind === 'other') continue
      if (!isOutputRoot && modifiedAfter > 0 && artifact.modifiedMs < modifiedAfter) continue
      seen.add(name)
      if (artifact.bytes > maxArtifactBytes) {
        artifact.oversized = true
        artifact.note = `not published inline: ${artifact.bytes} bytes exceeds the ${maxArtifactBytes}-byte limit`
      }
      artifacts.push(artifact)
    }
    rank += 1
  }
  artifacts.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    return b.modifiedMs - a.modifiedMs
  })
  return artifacts
}

/** Prefer a vector document, then the newest raster. */
function pickPrimary(artifacts) {
  const document = artifacts.find(a => a.kind === 'document')
  if (document) return document
  return artifacts.find(a => a.kind === 'image' && !a.oversized)
}

/** Inline render candidates: publishable rasters within the byte budget. */
function pickInlineImages(artifacts, maxInlineImageBytes) {
  const images = artifacts.filter(a => a.kind === 'image' && !a.oversized)
  images.sort((a, b) => {
    // Prefer PNG for lossless inline rendering, then recency.
    const aPng = a.format === 'png' ? 0 : 1
    const bPng = b.format === 'png' ? 0 : 1
    if (aPng !== bPng) return aPng - bPng
    return b.modifiedMs - a.modifiedMs
  })
  return images.filter(a => a.bytes <= maxInlineImageBytes).slice(0, 3)
}

/**
 * Publish one raster as a durable DSH image attachment so the chat can render it.
 * Returns undefined when the deployment lacks the attachment service or the file
 * is not a publishable raster — callers then fall back to a plain file path.
 *
 * The bytes are read through the host filesystem service when it is available so
 * the user's filesystem policy stays authoritative; a direct read is the
 * fallback for hosts without that service.
 */
export async function publishImage(ctx, artifact) {
  const mediaType = MEDIA_TYPES[artifact.format]
  if (!mediaType) return undefined
  const attachments = ctx?.get?.('attachments')
  if (!attachments || typeof attachments.saveImage !== 'function') return undefined
  const limits = attachments.imageLimits
  if (limits) {
    if (artifact.bytes > limits.maxImageBytes) return undefined
    const allowed = limits.mediaTypes
    if (Array.isArray(allowed) && !allowed.includes(mediaType)) return undefined
  }

  const data = await readArtifactBytes(ctx, artifact)
  if (!data) return undefined
  try {
    return await attachments.saveImage({
      data,
      mediaType,
      name: basename(artifact.path),
    })
  } catch {
    return undefined
  }
}

/** Read artifact bytes via ctx.fs when present, else straight from disk. */
async function readArtifactBytes(ctx, artifact) {
  const fs = ctx?.get?.('fs')
  if (fs && typeof fs.resolve === 'function' && typeof fs.readBytes === 'function') {
    try {
      const target = await fs.resolve(artifact.path)
      return await fs.readBytes(target, undefined, artifact.bytes + 1024)
    } catch {
      /* fall through to a direct read */
    }
  }
  try {
    return readFileSync(artifact.path)
  } catch {
    return undefined
  }
}

/** Concurrency gate shared by every tool in the plugin. */
export function createGate(limit) {
  return new Semaphore(limit)
}

/**
 * Resolve MATLAB for one tool call, producing an actionable error when missing.
 * @returns {{exe: string, root: string, release: string, version: string, source: string}}
 */
export function requireMatlab(config) {
  const found = discoverMatlab({ roots: config.matlabRoots, refresh: config.refreshDiscovery })
  if (!found.ok) {
    const tried = found.tried.length ? ` Tried: ${found.tried.join(', ')}.` : ''
    throw new Error(
      `${found.reason}${tried} Set the MATLAB_ROOT environment variable, add matlab.exe to PATH, `
      + 'or pass config.matlabRoots in cordis.patch.yml.',
    )
  }
  return found
}

/** Default per-call timeout resolution. */
export function resolveTimeout(requested, config) {
  const fallback = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 600_000
  const max = Number.isFinite(config.maxTimeoutMs) ? config.maxTimeoutMs : 3_600_000
  const value = Number.isFinite(requested) && requested > 0 ? requested * 1000 : fallback
  return Math.min(Math.max(5_000, value), max)
}

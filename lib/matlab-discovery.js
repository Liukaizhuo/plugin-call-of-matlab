/**
 * MATLAB installation discovery for Windows.
 *
 * Resolution order (first hit wins):
 *   1. MATLAB_ROOT / MATLABROOT environment variable (config-overridable)
 *   2. `where matlab.exe` — covers a PATH-registered install
 *   3. Windows registry: MATLAB\\MATLABROOT  InstallPath / MATLABROOT
 *   4. Common install roots, newest release first
 *
 * Every candidate is verified by stat()ing `<root>\bin\matlab.exe`, so a stale
 * environment variable degrades to the next source instead of failing the call.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Release directory names look like R2024a / R2023b / 9.14. */
const RELEASE_DIR = /^(R\d{4}[ab])$|^(\d+\.\d+)$/

/** Default roots probed when nothing else resolves. */
const DEFAULT_ROOTS = ['C:\\Program Files\\MATLAB', 'C:\\Program Files (x86)\\MATLAB']

/** Cache: discovery spawns child processes, so it must not run per call. */
let cached = null

/** Normalize a directory path to the `<root>` that directly contains bin\\matlab.exe. */
export function normalizeMatlabRoot(candidate) {
  if (typeof candidate !== 'string') return undefined
  let value = candidate.trim().replace(/^"|"$/g, '')
  if (!value) return undefined
  // A user may point at bin, bin\matlab.exe, or the release root.
  value = value.replace(/[\\/]+$/, '')
  if (/[\\/]bin[\\/]matlab\.exe$/i.test(value)) return value.replace(/[\\/]bin[\\/]matlab\.exe$/i, '')
  if (/[\\/]bin$/i.test(value)) return value.replace(/[\\/]bin$/i, '')
  return value
}

/** Turn an install root into the display version, deriving it from the folder name. */
export function deriveVersion(root) {
  const match = /[\\/]([^\\/]+)$/.exec(root)
  if (!match) return { release: '', version: '' }
  const tail = match[1]
  const named = /^(R\d{4})([ab])$/i.exec(tail)
  if (named) return { release: `${named[1].toUpperCase()}${named[2].toLowerCase()}`, version: '' }
  const numeric = /^(\d+\.\d+)$/.exec(tail)
  if (numeric) return { release: '', version: numeric[1] }
  return { release: '', version: '' }
}

/** True when `<root>\bin\matlab.exe` is a real file. */
function usableRoot(root) {
  if (!root) return false
  try {
    return statSync(join(root, 'bin', 'matlab.exe')).isFile()
  } catch {
    return false
  }
}

/** `where matlab.exe` → install root, or undefined. Never throws. */
function fromPath() {
  try {
    const out = execFileSync('where.exe', ['matlab.exe'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of out.split(/\r?\n/)) {
      const root = normalizeMatlabRoot(line)
      if (usableRoot(root)) return root
    }
  } catch {
    /* not on PATH */
  }
  return undefined
}

/** Registry InstallPath / MATLABROOT values, newest release first. Never throws. */
function fromRegistry() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$keys = Get-ChildItem "HKLM:\\SOFTWARE\\MathWorks\\MATLAB" | Sort-Object -Property Name -Descending',
    'foreach ($k in $keys) {',
    '  $p = Get-ItemProperty $k.PSPath',
    '  if ($p.InstallPath) { Write-Output ("InstallPath=" + $p.InstallPath) }',
    '  if ($p.MATLABROOT) { Write-Output ("MATLABROOT=" + $p.MATLABROOT) }',
    '}',
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of out.split(/\r?\n/)) {
      const root = normalizeMatlabRoot(line.replace(/^[^=]+=/, ''))
      if (usableRoot(root)) return root
    }
  } catch {
    /* registry layout differs or powershell unavailable */
  }
  return undefined
}

/** Newest release under each default root. Never throws. */
function fromDefaultRoots() {
  for (const base of DEFAULT_ROOTS) {
    let entries
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    const releases = entries
      .filter(entry => entry.isDirectory() && RELEASE_DIR.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, 'en'))
    for (const release of releases) {
      const root = join(base, release)
      if (usableRoot(root)) return root
    }
  }
  return undefined
}

/**
 * Resolve the MATLAB installation.
 * @param {{roots?: string[], refresh?: boolean}} [options]
 * @returns {{ok: true, root: string, exe: string, release: string, version: string, source: string}
 *          | {ok: false, reason: string, tried: string[]}}
 */
export function discoverMatlab(options = {}) {
  const { roots = [], refresh = false } = options
  if (cached && !refresh && roots.length === 0) return cached

  const tried = []
  const candidates = []

  for (const root of roots) candidates.push({ root: normalizeMatlabRoot(root), source: 'config' })
  for (const key of ['MATLAB_ROOT', 'MATLABROOT']) {
    if (process.env[key]) candidates.push({ root: normalizeMatlabRoot(process.env[key]), source: `env:${key}` })
  }
  candidates.push({ root: fromPath(), source: 'where.exe' })
  candidates.push({ root: fromRegistry(), source: 'registry' })
  candidates.push({ root: fromDefaultRoots(), source: 'default-root' })

  for (const candidate of candidates) {
    if (!candidate.root) continue
    tried.push(`${candidate.source}=${candidate.root}`)
    if (!usableRoot(candidate.root)) continue
    const { release, version } = deriveVersion(candidate.root)
    const resolved = {
      ok: true,
      root: candidate.root,
      exe: join(candidate.root, 'bin', 'matlab.exe'),
      release,
      version,
      source: candidate.source,
    }
    if (roots.length === 0) cached = resolved
    return resolved
  }

  const failure = {
    ok: false,
    reason: 'No usable MATLAB installation found (expected <root>\\bin\\matlab.exe).',
    tried,
  }
  if (roots.length === 0) cached = failure
  return failure
}

/** True when a filesystem path exists and is a directory. */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** True when a filesystem path exists and is a file. */
export function isFile(path) {
  return existsSync(path) && (() => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })()
}

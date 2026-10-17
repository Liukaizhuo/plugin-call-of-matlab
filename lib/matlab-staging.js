/**
 * Input staging for MATLAB.
 *
 * MATLAB's parser refuses to execute a script whose *path or filename* contains
 * non-ASCII characters ("invalid text character") — the file content is not the
 * problem, the path is. Copying the file into the ASCII run directory under an
 * ASCII-safe name and executing that copy works, while `cd()` into the user's
 * original directory (which does accept non-ASCII paths) keeps relative
 * `save`/`load` resolving against their project.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

/** Characters MATLAB's parser accepts in a path it has to resolve itself. */
const ASCII_ONLY = /^[\x20-\x7E]*$/

/** True when MATLAB can be handed this path directly. */
export function isAsciiPath(path) {
  return ASCII_ONLY.test(String(path))
}

/** Create a throwaway ASCII staging directory. */
export function stageDir(tempRoot) {
  const base = tempRoot && tempRoot.trim() ? tempRoot : join(tmpdir(), 'dsh-matlab-simulink')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `stage-${process.pid}-`))
  return dir
}

/**
 * Copy a user input file into `dir` under an ASCII-safe name.
 *
 * The bytes are copied verbatim, so a UTF-8 source stays UTF-8 (MATLAB R2024a
 * reads UTF-8 source correctly; only the path must be ASCII).
 *
 * @returns {{stagedPath: string, originalPath: string, originalDir: string, originalStem: string}}
 */
export function stageInput(sourcePath, dir) {
  const stem = `dsh_userinput_${randomUUID().replace(/-/g, '').slice(0, 8)}`
  const ext = extname(sourcePath) || '.m'
  const stagedPath = join(dir, `${stem}${ext}`)
  copyFileSync(sourcePath, stagedPath)
  return {
    stagedPath,
    originalPath: sourcePath,
    originalDir: dirname(sourcePath),
    originalStem: basename(sourcePath, ext),
  }
}

/**
 * Copy a generated driver script into the stage directory.
 * @returns {string} the staged path
 */
export function stageDriver(source, dir, stem = 'dsh_driver') {
  const stagedPath = join(dir, `${stem}.m`)
  writeFileSync(stagedPath, source, 'utf8')
  return stagedPath
}

/**
 * Rewrite staged paths back to the caller's real paths inside captured output,
 * so an error message points at the file the user actually knows about.
 */
export function unstageText(text, mappings) {
  if (!text) return text
  let out = String(text)
  for (const [staged, original] of mappings) {
    if (!staged || !original || staged === original) continue
    out = out.split(staged).join(original)
    out = out.split(staged.replace(/\\/g, '/')).join(original.replace(/\\/g, '/'))
    out = out.split(basename(staged)).join(basename(original))
  }
  return out
}

/** Best-effort recursive delete of a staging directory. */
export function cleanupStage(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* a locked file must not fail the tool call */
  }
}

/** Read a text file as UTF-8. */
export function readUtf8(path) {
  return readFileSync(path, 'utf8')
}

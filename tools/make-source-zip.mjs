/**
 * Build the source zip committed alongside the npm tarball.
 *
 * The zip is produced from `git archive`, so it contains exactly the tracked
 * files at a given revision — no build output, no sandbox, no editor noise — and
 * unpacks into a single top-level directory.
 *
 * Usage:
 *   node tools/make-source-zip.mjs                 # zip HEAD
 *   node tools/make-source-zip.mjs --ref v1.0.0    # zip a tag or branch
 *   node tools/make-source-zip.mjs --check         # verify the existing zip
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: packageRoot,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
}

/**
 * List the entry names of a zip archive.
 *
 * Node can inflate but cannot read zip containers, and the external listers are
 * unreliable here (GNU tar cannot read zip; PowerShell 5.1 rejects `param()`
 * together with `-EncodedCommand`). The central directory is a simple,
 * well-specified structure, so it is read directly:
 *
 *   [End of central directory]  -> offset and count of the central directory
 *   [Central directory header]  -> name length, name, then repeat
 *
 * @returns {string[]} entry names in archive order
 */
function listZipEntries(zipPath) {
  const buffer = readFileSync(zipPath)

  // End of central directory: signature 0x06054b50, scanned from the end because
  // a trailing comment may follow it.
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= 0 && offset > buffer.length - 22 - 0xffff; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('end of central directory not found')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)

  const names = []
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${index}`)
    }
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return names
}

function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const refFlag = args.indexOf('--ref')
  const ref = refFlag >= 0 && args[refFlag + 1] ? args[refFlag + 1] : 'HEAD'

  try {
    git(['rev-parse', '--is-inside-work-tree'])
  } catch {
    console.error('not a git repository: initialize and commit before zipping')
    return 1
  }

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const version = manifest.version
  const distDir = join(packageRoot, 'dist')
  const zipPath = join(distDir, `dsh-matlab-simulink-${version}-source.zip`)
  // `git archive` prefixes every path with this, so the zip unpacks into one folder.
  const prefix = `dsh-matlab-simulink-${version}/`

  if (checkOnly) {
    if (!existsSync(zipPath)) {
      console.error(`FAIL missing ${zipPath}`)
      return 1
    }
    console.log(`OK ${zipPath} (${statSync(zipPath).size} B)`)
    return 0
  }

  let revision
  try {
    revision = git(['rev-parse', '--short', ref], { encoding: 'utf8' }).trim()
  } catch {
    console.error(`cannot resolve ref "${ref}" — commit first, or pass --ref <tag>`)
    return 1
  }

  mkdirSync(distDir, { recursive: true })
  // `dist/` is excluded: it holds these same release artifacts, so including it
  // would both bloat the zip and make the archive depend on its own previous
  // revision. The zip is source only.
  const archive = git([
    'archive', '--format=zip', `--prefix=${prefix}`, ref, '--', '.', ':(exclude)dist',
  ], { encoding: 'buffer' })
  writeFileSync(zipPath, archive)

  // A source zip that cannot be listed is worse than none, so verify that the
  // archive really contains the files that make it a usable repository.
  let entries
  try {
    entries = listZipEntries(zipPath)
  } catch (error) {
    console.error(`source zip is unreadable: ${error.message}`)
    return 1
  }

  const required = [`${prefix}package.json`, `${prefix}README.md`, `${prefix}lib/index.js`]
  const missing = required.filter(entry => !entries.includes(entry))
  if (missing.length) {
    console.error(`source zip is missing: ${missing.join(', ')}`)
    return 1
  }
  const files = entries.filter(entry => !entry.endsWith('/'))
  console.log(`wrote ${zipPath} (${statSync(zipPath).size} B, ${files.length} files, from ${ref} @ ${revision})`)
  return 0
}

process.exitCode = main()

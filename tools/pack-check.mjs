/**
 * Pre-publish check: verify exactly what `npm publish` would upload.
 *
 * A published package cannot be un-published cleanly, so this asserts the
 * tarball contents rather than trusting the `files` field:
 *   1. every file the plugin needs to load is present,
 *   2. no development or machine-local file is present,
 *   3. the packed entry module parses,
 *   4. the tarball stays within a sane size budget.
 *
 * Usage:
 *   node tools/pack-check.mjs            # check
 *   node tools/pack-check.mjs --build    # also write the .tgz into dist/
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const buildTarball = process.argv.includes('--build')

/** Files that must appear in the published tarball. */
const REQUIRED = [
  'package.json',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'dsh-plugin.json',
  'docs/INSTALL.md',
  'lib/index.js',
  'lib/tools.js',
  'lib/matlab-core.js',
  'lib/matlab-script.js',
  'lib/matlab-staging.js',
  'lib/matlab-discovery.js',
  'types/index.d.ts',
  'tools/sync-to-profile.mjs',
  'test/harness.mjs',
]

/** Path fragments that must never be published. */
const FORBIDDEN = [
  'node_modules/',
  '.test-sandbox/',
  '.git/',
  '.github/',
  '.vscode/',
  'dist/',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.npmrc',
]

/** Size budget for the published tarball. */
const MAX_TARBALL_BYTES = 512 * 1024

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  })
}

/**
 * Locate npm's CLI entry point.
 *
 * On Windows `npm` resolves to `npm.cmd`, which `execFileSync` cannot spawn
 * without a shell. Running the CLI through the current Node executable is
 * portable and avoids shell quoting entirely.
 */
function findNpmCli() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Run npm through Node. */
function npm(args) {
  const cli = findNpmCli()
  if (!cli) throw new Error('cannot locate npm-cli.js next to the running node executable')
  return run(process.execPath, [cli, ...args])
}

/**
 * Read the entries of a gzipped tar archive.
 *
 * Node has gzip built in but no tar reader, and depending on an external `tar`
 * binary is not portable (it is absent from some Git-for-Windows images). A tar
 * reader for this narrow case is about thirty lines: 512-byte headers, then
 * payload padded to a 512-byte boundary.
 *
 * @returns {Array<{name: string, size: number, body: Buffer}>}
 */
function readTarGz(tarballPath) {
  const raw = gunzipSync(readFileSync(tarballPath))
  const entries = []
  let offset = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    // Two consecutive zero blocks terminate the archive.
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = sizeField ? parseInt(sizeField, 8) : 0
    const bodyStart = offset + 512
    if (!name) break
    entries.push({ name, size, body: raw.subarray(bodyStart, bodyStart + size) })
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function main() {
  const problems = []

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  console.log(`package: ${manifest.name}@${manifest.version}`)

  if (manifest.repository?.url?.includes('OWNER/')) {
    problems.push('package.json repository.url still contains the OWNER placeholder')
  }
  if (manifest.private === true) {
    problems.push('package.json is marked private, so it cannot be published')
  }
  if (!manifest.dsh?.bundle?.patch) {
    problems.push('package.json is missing dsh.bundle.patch, so DSH cannot discover the bundle patch')
  }

  // `--json` output keeps parsing independent of npm's human formatting.
  let report
  try {
    report = JSON.parse(npm(['pack', '--dry-run', '--json']))
  } catch (error) {
    console.error('npm pack failed:')
    console.error(String(error.stdout || '').trim())
    console.error(String(error.stderr || '').trim())
    return 1
  }

  const entries = report[0]?.files ?? []
  const paths = entries.map(entry => entry.path).sort()
  const tarballSize = report[0]?.size ?? 0
  const unpackedSize = report[0]?.unpackedSize ?? 0

  console.log(`\nfiles that would be published (${paths.length}):`)
  for (const entry of entries.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`  ${String(entry.size).padStart(8)}  ${entry.path}`)
  }
  console.log(`\ntarball ${tarballSize} B, unpacked ${unpackedSize} B`)

  for (const required of REQUIRED) {
    if (!paths.includes(required)) problems.push(`missing from tarball: ${required}`)
  }
  for (const path of paths) {
    for (const fragment of FORBIDDEN) {
      if (path === fragment || path.startsWith(fragment) || path.includes(`/${fragment}`)) {
        problems.push(`must not be published: ${path}`)
      }
    }
  }
  if (tarballSize > MAX_TARBALL_BYTES) {
    problems.push(`tarball ${tarballSize} B exceeds the ${MAX_TARBALL_BYTES} B budget`)
  }

  // Import the packed entry module from a real extraction, so a broken file
  // list or a stray syntax error is caught before publishing.
  const tarballName = report[0]?.filename
  if (buildTarball && tarballName) {
    const distDir = join(packageRoot, 'dist')
    mkdirSync(distDir, { recursive: true })
    const built = npm(['pack', '--pack-destination', distDir])
    const builtPath = join(distDir, built.trim().split(/\r?\n/).pop().trim())
    console.log(`\nwrote ${builtPath} (${statSync(builtPath).size} B)`)
    try {
      const entries = readTarGz(builtPath)
      const entry = entries.find(candidate => candidate.name === 'package/lib/index.js')
      if (!entry) throw new Error('package/lib/index.js is absent from the tarball')
      const extracted = join(distDir, 'package', 'lib')
      mkdirSync(extracted, { recursive: true })
      for (const file of entries) {
        if (!file.name.startsWith('package/') || file.name.endsWith('/')) continue
        const destination = join(distDir, file.name)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, file.body)
      }
      const entryUrl = pathToFileURL(join(distDir, 'package', 'lib', 'index.js')).href
      const check = `import(${JSON.stringify(entryUrl)}).then(m => {`
        + ` const missing = ['name','apply','resolveConfig'].filter(k => m[k] === undefined);`
        + ` if (missing.length) { console.error('missing exports: ' + missing.join(',')); process.exit(1) }`
        + ` console.log('packed entry imports OK; tools declared: ' + (m.plugin ? m.plugin.name : 'n/a')) })`
      console.log(run(process.execPath, ['-e', check]).trim())
      rmSync(join(distDir, 'package'), { recursive: true, force: true })
    } catch (error) {
      problems.push(`packed entry failed to import: ${String(error.message).split('\n')[0]}`)
    }
  } else if (tarballName) {
    console.log('\n(run with --build to also write and smoke-test the .tgz)')
  }

  if (problems.length) {
    console.error('\n--- pack check FAILED ---')
    for (const problem of problems) console.error(`  ${problem}`)
    return 1
  }
  console.log('\n--- pack check passed ---')
  return 0
}

process.exitCode = main()

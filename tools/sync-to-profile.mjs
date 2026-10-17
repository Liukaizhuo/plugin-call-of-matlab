/**
 * Copy this plugin into a DSH profile's node_modules so the profile can load it.
 *
 * The canonical source stays in this workspace; the profile copy is a build
 * artifact. Re-run this after editing lib/.
 *
 * Usage:
 *   node tools/sync-to-profile.mjs [--profile <dir>] [--check]
 *
 * Default profile directory: %USERPROFILE%\.dsh\profiles\desktop
 *
 * Implementation notes, each from an observed failure on this host:
 *  - The copy is per-file via copyFileSync. `fs.cpSync` terminated this Node
 *    process outright (exit 127, no diagnostic) when copying into the profile's
 *    node_modules, so a primitive recursive walk is used instead.
 *  - Exit status is set through `process.exitCode`, never `process.exit()`: an
 *    immediate exit discards buffered stdout and hides the failure message.
 *  - The staged copy is verified before publication, so a partial copy can
 *    never replace a working install.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const PACKAGE_NAME = 'dsh-matlab-simulink'

/** Directories copied recursively. */
const PAYLOAD_DIRS = ['lib', 'test', 'tools', 'types', 'docs']
/** Individual files copied as-is. */
const PAYLOAD_FILES = [
  'package.json',
  'dsh-plugin.json',
  'cordis.patch.yml',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
]
/** Files that must exist after copying, or the install is rejected. */
const REQUIRED = [
  'lib/index.js',
  'lib/tools.js',
  'lib/matlab-core.js',
  'lib/matlab-script.js',
  'lib/matlab-staging.js',
  'lib/matlab-discovery.js',
  'package.json',
]

/**
 * The loader entry this plugin needs in the profile patch.
 *
 * The package name is used rather than an absolute path to the source tree:
 * the loader resolves it from the profile's own node_modules, which is exactly
 * the copy this script installs and verifies. An absolute source path would
 * shadow that copy and keep loading unverified files.
 */
function patchEntry() {
  return [
    '- insert:',
    `    - id: ${PACKAGE_NAME}`,
    `      name: "${PACKAGE_NAME}"`,
    '      config:',
    '        matlabRoots: []',
    '        timeoutMs: 600000',
    '        maxTimeoutMs: 3600000',
    '        maxConcurrent: 1',
    '        streamOutput: true',
    '',
  ].join('\n')
}

/** Recursive per-file copy with a size check after each file. */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) {
      copyTree(source, destination)
      continue
    }
    copyFileSync(source, destination)
    const expected = statSync(source).size
    const actual = statSync(destination).size
    if (expected !== actual) {
      throw new Error(`size mismatch for ${entry.name}: ${expected} -> ${actual}`)
    }
  }
}

/** Copy the payload into `destination`, staging through a sibling directory. */
function install(destination) {
  const staging = `${destination}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    mkdirSync(staging, { recursive: true })
    for (const dir of PAYLOAD_DIRS) {
      const from = join(packageRoot, dir)
      if (existsSync(from)) copyTree(from, join(staging, dir))
    }
    for (const file of PAYLOAD_FILES) {
      const from = join(packageRoot, file)
      if (existsSync(from)) copyFileSync(from, join(staging, file))
    }
    for (const file of REQUIRED) {
      if (!existsSync(join(staging, file))) throw new Error(`staged copy is missing ${file}`)
    }
    rmSync(destination, { recursive: true, force: true })
    copyTree(staging, destination)
    for (const file of REQUIRED) {
      if (!existsSync(join(destination, file))) throw new Error(`installed copy is missing ${file}`)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const profileFlag = args.indexOf('--profile')
  const profileDir = profileFlag >= 0 && args[profileFlag + 1]
    ? resolve(args[profileFlag + 1])
    : join(homedir(), '.dsh', 'profiles', 'desktop')

  if (!existsSync(profileDir)) {
    console.error(`profile directory not found: ${profileDir}`)
    return 1
  }

  const target = join(profileDir, 'node_modules', PACKAGE_NAME)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const registered = patch.includes(PACKAGE_NAME)

  if (checkOnly) {
    const problems = []
    if (!existsSync(target)) problems.push(`not installed at ${target}`)
    else {
      for (const file of REQUIRED) {
        if (!existsSync(join(target, file))) problems.push(`missing ${file} under ${target}`)
      }
    }
    if (!registered) problems.push(`no ${PACKAGE_NAME} entry in ${patchPath}`)
    if (problems.length) {
      for (const problem of problems) console.error(`FAIL ${problem}`)
      return 1
    }
    console.log(`OK plugin installed and registered (${target})`)
    return 0
  }

  try {
    install(target)
  } catch (error) {
    console.error(`FAILED to install into ${target}: ${error.message}`)
    console.error('If DSH is running and holding these files open, close it and re-run this script.')
    return 1
  }
  console.log(`copied plugin to ${target}`)

  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, `# DSH profile patch layer\n${patchEntry()}`, 'utf8')
    console.log(`created ${patchPath} with the plugin entry`)
  } else if (!registered) {
    writeFileSync(patchPath, `${patch.replace(/\s*$/, '')}\n${patchEntry()}`, 'utf8')
    console.log(`appended the plugin entry to ${patchPath}`)
  } else {
    console.log(`${patchPath} already registers the plugin`)
  }

  // Prove the installed copy is loadable before declaring success.
  const moduleUrl = pathToFileURL(join(target, 'lib', 'index.js')).href
  const loaded = await import(moduleUrl)
  const missing = ['name', 'apply', 'resolveConfig'].filter(key => loaded[key] === undefined)
  if (missing.length) {
    console.error(`FAILED: installed plugin is missing exports: ${missing.join(', ')}`)
    return 1
  }
  console.log(`verified: ${moduleUrl} exports name, apply, resolveConfig`)
  console.log('\nRestart DSH (or reload the profile) to activate the plugin.')
  return 0
}

process.exitCode = await main()

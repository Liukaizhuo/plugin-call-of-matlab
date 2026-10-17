/**
 * dsh-matlab-simulink — drive a locally installed MATLAB/Simulink from DeepSeek Harness.
 *
 * Bundle entry: exports `name`, `Config`, and `apply`, plus `plugin` metadata.
 * `apply` validates the configuration eagerly (so a typo fails the load instead
 * of the first tool call), resolves the MATLAB installation, and registers the
 * tools under the `tools` service dependency.
 *
 * Configuration is validated without a schema library so the plugin has zero
 * runtime dependencies and loads from a plain path.
 */

import { createTools } from './tools.js'
import { discoverMatlab } from './matlab-discovery.js'

export const name = 'dsh-matlab-simulink'

/** Dependencies are acquired inside apply (through injection), not at import time. */
export const inject = []

const CONFIG_KEYS = new Set([
  'enabled', 'matlabRoots', 'timeoutMs', 'maxTimeoutMs', 'maxConcurrent',
  'tempDir', 'maxArtifactBytes', 'maxInlineImageBytes', 'streamOutput',
  'toolNamePrefix', 'refreshDiscovery',
])

/** Coerce a value to an array of non-empty strings. */
function toStringArray(value, fallback) {
  if (value === undefined || value === null) return fallback
  const list = Array.isArray(value) ? value : [value]
  return list.map(item => String(item)).filter(item => item.trim().length > 0)
}

/** Positive integer with a floor. */
function toPositive(value, fallback, minimum, label) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number, received ${JSON.stringify(value)}`)
  }
  return Math.max(minimum, Math.round(number))
}

/**
 * Validate and normalize the plugin configuration.
 * Throws on unknown keys so a mistyped patch field is caught at load.
 *
 * @param {Record<string, unknown>} [raw]
 */
export function resolveConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `dsh-matlab-simulink: unknown config key "${key}". Known keys: ${[...CONFIG_KEYS].sort().join(', ')}.`,
      )
    }
  }

  const streamOutput = input.streamOutput === undefined ? true : Boolean(input.streamOutput)

  return {
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    /** Explicit install roots; empty means auto-discovery only. */
    matlabRoots: toStringArray(input.matlabRoots, []),
    timeoutMs: toPositive(input.timeoutMs, 600_000, 5_000, 'timeoutMs'),
    maxTimeoutMs: toPositive(input.maxTimeoutMs, 3_600_000, 5_000, 'maxTimeoutMs'),
    maxConcurrent: toPositive(input.maxConcurrent, 1, 1, 'maxConcurrent'),
    tempDir: typeof input.tempDir === 'string' && input.tempDir.trim() ? input.tempDir.trim() : undefined,
    maxArtifactBytes: toPositive(input.maxArtifactBytes, 25 * 1024 * 1024, 1024, 'maxArtifactBytes'),
    maxInlineImageBytes: toPositive(input.maxInlineImageBytes, 6 * 1024 * 1024, 1024, 'maxInlineImageBytes'),
    streamOutput,
    toolNamePrefix: typeof input.toolNamePrefix === 'string' ? input.toolNamePrefix.trim() : '',
    refreshDiscovery: Boolean(input.refreshDiscovery),
  }
}

/** Reported when MATLAB cannot be located; the plugin still loads so the user sees why. */
function reportUnavailable(ctx, found) {
  const lines = [
    'dsh-matlab-simulink: no MATLAB installation was found. The tools are registered, but each run will fail until this is fixed (call matlab_status for the same report).',
    `  reason: ${found.reason}`,
  ]
  if (found.tried?.length) lines.push(`  tried:  ${found.tried.join(', ')}`)
  lines.push('  fix:    set MATLAB_ROOT, put matlab.exe on PATH, or set config.matlabRoots in cordis.patch.yml.')
  for (const line of lines) report(ctx, line, 'warn')
}

/** Prefer the context logger, falling back to the console. */
function report(ctx, message, level = 'info') {
  const logger = ctx?.logger
  if (typeof logger?.[level] === 'function') logger[level](message)
  else if (level === 'error') console.error(message)
  else if (level === 'warn') console.warn(message)
  else console.log(message)
}

/**
 * Cordis plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)

  if (!config.enabled) {
    report(ctx, 'dsh-matlab-simulink: disabled by configuration; no tools registered.', 'info')
    return
  }

  // A configured-but-wrong root is a misconfiguration and must fail loudly.
  if (config.matlabRoots.length) {
    const configured = discoverMatlab({ roots: config.matlabRoots })
    if (!configured.ok) {
      throw new Error(
        `dsh-matlab-simulink: none of the configured matlabRoots contains bin\\matlab.exe: ${config.matlabRoots.join(', ')}`,
      )
    }
  }

  const found = discoverMatlab({ roots: config.matlabRoots })
  if (!found.ok) {
    // Tools are still registered. A missing MATLAB must not make the plugin
    // invisible: an agent that sees no tools cannot discover the problem, while
    // calling any tool returns an actionable reason and `matlab_status` reports
    // what was tried. Removing the tools would leave the user with no clue.
    reportUnavailable(ctx, found)
  }

  ctx.inject(['tools'], scoped => {
    const tools = createTools(scoped, config)
    for (const definition of tools) {
      scoped.effect(() => scoped.tools.register(definition), `dsh-matlab-simulink: ${definition.name}`)
    }
    const where = found.ok
      ? `MATLAB ${found.release || found.version || ''} at ${found.root} (discovered via ${found.source})`
      : 'MATLAB not found yet; call matlab_status for the reason and the fix'
    report(ctx, `dsh-matlab-simulink: ${tools.length} tools registered; ${where}.`, 'info')
  })
}

/** Bundle metadata for the plugin inventory. */
export const plugin = {
  name,
  description: 'Run MATLAB scripts and Simulink models locally and export publication-quality figures.',
  version: '1.0.0',
}

export default { name, apply, resolveConfig, plugin }

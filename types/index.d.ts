/**
 * Type definitions for dsh-matlab-simulink.
 *
 * The host half is a plain-JavaScript Cordis bundle with no runtime
 * dependencies; these declarations describe the module's public surface for
 * editors and for consumers that register the plugin programmatically.
 */

/** Resolved configuration, after validation and defaulting. */
export interface MatlabSimulinkConfig {
  /** Master switch. When false the plugin loads but registers no tools. */
  enabled: boolean
  /**
   * Explicit MATLAB installation roots (the directory that directly contains
   * `bin\matlab.exe`). Empty means auto-discovery.
   */
  matlabRoots: string[]
  /** Default wall-clock timeout per call, in milliseconds. */
  timeoutMs: number
  /** Ceiling a call may request through `timeout_s`, in milliseconds. */
  maxTimeoutMs: number
  /** Maximum concurrent MATLAB sessions. MATLAB sessions are heavyweight. */
  maxConcurrent: number
  /** Directory for per-run staging/working directories. Empty means the OS temp dir. */
  tempDir?: string
  /** Artifacts larger than this are reported as paths only. */
  maxArtifactBytes: number
  /** Rasters larger than this are not published as image attachments. */
  maxInlineImageBytes: number
  /** Forward MATLAB stdout while a run is in progress. */
  streamOutput: boolean
  /** Reserved for tool-name namespacing. */
  toolNamePrefix: string
  /** Re-run installation discovery instead of using the cached result. */
  refreshDiscovery: boolean
}

/** A value the plugin accepts for a Simulink block parameter. */
export type BlockParameterValue = string | number | boolean

/** One Simulink block parameter override. */
export interface BlockParameterOverride {
  /** Block path relative to the model root, e.g. `"Controller/Kp"`. */
  block: string
  /** Parameter name, e.g. `"Gain"`. */
  parameter: string
  /** New value. Numbers and booleans are rendered as MATLAB expressions. */
  value: BlockParameterValue
}

/** One file produced by a run, as reported in a tool result. */
export interface MatlabArtifact {
  name: string
  /** Absolute host path. */
  path: string
  /** Directory the artifact was collected from. */
  dir?: string
  kind: 'image' | 'document' | 'data'
  /** Lower-case extension without the dot. */
  format: string
  bytes: number
  modifiedMs: number
  /** Collection rank: 0 is the run's output directory, 1 the working directory. */
  rank?: number
  /** Present when the artifact exceeded the inline size budget. */
  oversized?: boolean
  note?: string
}

/** Why a run failed, when it did. */
export type MatlabFailureKind =
  | 'matlab'
  | 'timeout'
  | 'aborted'
  | 'spawn'
  | 'incomplete'
  | 'exit-code'
  | 'output-dir'
  | 'stage'

/** Structured result shared by every run-based tool. */
export interface MatlabRunResult {
  ok: boolean
  /** Resolved installation used for the run, as a display string. */
  matlab?: string
  exitCode?: number | null
  durationMs: number
  timedOut?: boolean
  aborted?: boolean
  failureKind?: MatlabFailureKind
  failure?: string
  /** Cleaned MATLAB console transcript. */
  transcript?: string
  stdout?: string
  stderr?: string
  /** MATLAB error report text, when the run failed inside MATLAB. */
  matlabError?: string
  artifacts: MatlabArtifact[]
  /** Vector document or newest raster selected as the headline figure. */
  primaryFigure?: MatlabArtifact
  /** Rasters eligible for inline rendering. */
  inlineImages?: MatlabArtifact[]
}

/** MATLAB installation as resolved by discovery. */
export interface MatlabInstallation {
  root: string
  exe: string
  /** Release label such as `R2024a`, when derivable from the folder name. */
  release: string
  /** Numeric version such as `24.1`, when derivable. */
  version: string
  /** Where the installation was found: `env:MATLAB_ROOT`, `where.exe`, `registry`, ... */
  source: string
}

/** Outcome of installation discovery. */
export type MatlabDiscoveryResult =
  | ({ ok: true } & MatlabInstallation)
  | { ok: false; reason: string; tried: string[] }

/** Plugin identification. */
export declare const name: 'dsh-matlab-simulink'
/** Services acquired inside `apply`; empty because injection happens dynamically. */
export declare const inject: string[]
/** Bundle metadata for the plugin inventory. */
export declare const plugin: {
  name: string
  description: string
  version: string
}

/**
 * Validate and normalize plugin configuration.
 * Throws on unknown keys so a mistyped patch field fails at load, not at the
 * first tool call.
 */
export declare function resolveConfig(raw?: Record<string, unknown>): MatlabSimulinkConfig

/**
 * Cordis plugin entry point. Resolves the MATLAB installation and registers the
 * tools under the `tools` service dependency.
 */
export declare function apply(ctx: unknown, config?: Record<string, unknown>): void

/** Resolve the MATLAB installation. Results are cached unless `refresh` is set. */
export declare function discoverMatlab(options?: {
  roots?: string[]
  refresh?: boolean
}): MatlabDiscoveryResult

declare const plugin_default: {
  name: typeof name
  apply: typeof apply
  resolveConfig: typeof resolveConfig
  plugin: typeof plugin
}
export default plugin_default

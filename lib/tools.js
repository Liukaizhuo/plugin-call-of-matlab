/**
 * Tool definitions for the MATLAB/Simulink plugin.
 *
 * Every tool follows the same contract as the bundled plugins: a name, a model
 * facing description, a JSON-Schema `parameters`, an `output.schema`, an
 * `output.render` that turns the structured value into content blocks, and an
 * `execute` bound to the DSH tool run context (which carries the abort signal).
 */

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  createGate, publishImage, requireMatlab, resolveTimeout, runMatlabJob,
} from './matlab-core.js'
import { buildSimulinkBody } from './matlab-script.js'
import { discoverMatlab } from './matlab-discovery.js'

/** Error text a tool throws; the registry converts it into an error result. */
class ToolError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** Output schema shared by every tool: a permissive structured envelope. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: 'Whether the MATLAB run completed successfully.' },
    matlab: { type: 'string', description: 'Resolved MATLAB installation used for the run.' },
    durationMs: { type: 'number', description: 'Wall-clock duration of the run.' },
    transcript: { type: 'string', description: 'Cleaned MATLAB console transcript.' },
    matlabError: { type: 'string', description: 'MATLAB error report, when the run failed.' },
    artifacts: { type: 'array', items: { type: 'object' }, description: 'Files produced in the output directory.' },
  },
}

/** Shared parameter fragments. */
const FIGURE_PROPERTIES = {
  export_format: {
    type: 'string',
    enum: ['pdf', 'png', 'eps', 'svg', 'jpg'],
    default: 'pdf',
    description: 'Export format for the primary figure. pdf/eps/svg are vector (best for papers); png/jpg are raster at `dpi`.',
  },
  dpi: {
    type: 'integer',
    minimum: 72,
    maximum: 1200,
    default: 300,
    description: 'Raster resolution in DPI. 300 satisfies most journals; use 600 for dense line art. Ignored by vector formats.',
  },
  font_name: {
    type: 'string',
    default: 'Times New Roman',
    description: 'Figure font family, applied to axes and text defaults.',
  },
  font_size: {
    type: 'number',
    default: 12,
    description: 'Figure font size in points.',
  },
  figure_width: {
    type: 'number',
    default: 6,
    description: 'Figure width in inches. Single column is typically 3.5, double column 7.',
  },
  figure_height: {
    type: 'number',
    default: 4,
    description: 'Figure height in inches.',
  },
  reset_graphics: {
    type: 'boolean',
    default: true,
    description: 'Close pre-existing figures before running, so only this run\'s figures are exported.',
  },
}

const RUN_PROPERTIES = {
  working_dir: {
    type: 'string',
    description: 'Absolute directory MATLAB runs in (its `pwd`). Defaults to the directory of the input file, else the output directory.',
  },
  output_dir: {
    type: 'string',
    description: 'Absolute directory that receives figures and MAT/CSV artifacts. Defaults to `<working_dir>/dsh_output`.',
  },
  timeout_s: {
    type: 'number',
    minimum: 5,
    description: 'Wall-clock timeout in seconds. The MATLAB process tree is force-killed on expiry. Defaults to the configured tool timeout.',
  },
}

/** Resolve the output directory, defaulting under the working directory. */
function resolveOutputDir(args, ctx) {
  const workDir = args.working_dir
    ? resolve(args.working_dir)
    : ctx?.cwd
      ? resolve(ctx.cwd)
      : process.cwd()
  const outputDir = args.output_dir ? resolve(args.output_dir) : join(workDir, 'dsh_output')
  return { workDir, outputDir }
}

/** Assemble the figure policy the generator consumes. */
function figurePolicy(args) {
  const format = args.export_format ?? 'pdf'
  return {
    enabled: args.export_figures !== false,
    outputDir: '',
    format,
    dpi: args.dpi ?? 300,
    fontName: args.font_name ?? 'Times New Roman',
    fontSize: args.font_size ?? 12,
    width: args.figure_width ?? 6,
    height: args.figure_height ?? 4,
    resetGraphics: args.reset_graphics !== false,
  }
}

/** Assert a file exists with the expected extension. */
function requireFile(path, code, hint) {
  if (!path) throw new ToolError(hint, code)
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new ToolError(`File not found: ${absolute}`, code)
  if (!statSync(absolute).isFile()) throw new ToolError(`Not a file: ${absolute}`, code)
  return absolute
}

/**
 * Build the content blocks for one MATLAB result.
 *
 * Raster artifacts are published as durable image attachments when the host
 * exposes the attachment service, which is what lets the GUI render the figure
 * inline. Publishing is best-effort: a deployment without attachments still
 * gets the absolute paths as text.
 */
async function renderResult(ctx, args, result) {
  const blocks = []

  if (!result.ok) {
    blocks.push({
      type: 'text',
      text: `MATLAB run failed (${result.failureKind ?? 'error'}).\n${result.failure ?? 'Unknown failure.'}`,
    })
  } else {
    blocks.push({ type: 'text', text: 'MATLAB run completed.' })
  }

  const images = result.inlineImages ?? []
  let published = 0
  for (const image of images) {
    const ref = await publishImage(ctx, image)
    if (!ref) continue
    blocks.push({ type: 'image', attachment: ref })
    published += 1
  }

  const lines = []
  const matlab = result.matlab
  if (matlab) lines.push(`MATLAB: ${matlab}`)
  lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`)
  if (result.timedOut) lines.push('Status: TIMED OUT (process tree killed)')
  if (result.aborted) lines.push('Status: CANCELLED')

  if (result.artifacts?.length) {
    lines.push('Artifacts:')
    for (const artifact of result.artifacts) {
      const note = artifact.oversized ? ` [${artifact.note}]` : ''
      lines.push(`  - ${artifact.kind}/${artifact.format}: ${artifact.path} (${formatBytes(artifact.bytes)})${note}`)
    }
  } else {
    lines.push('Artifacts: none produced.')
  }

  if (result.primaryFigure && !published) {
    lines.push(`Primary figure: ${result.primaryFigure.path}`)
  }
  if (result.matlabError) lines.push(`MATLAB error: ${result.matlabError}`)

  const transcript = (result.transcript ?? '').trim()
  if (transcript) {
    lines.push('MATLAB output:')
    lines.push(transcript.length > 12_000 ? `${transcript.slice(0, 12_000)}\n... [transcript truncated]` : transcript)
  }

  const stderr = (result.stderr ?? '').trim()
  if (stderr) {
    lines.push(`MATLAB stderr:\n${stderr.length > 4_000 ? `${stderr.slice(0, 4_000)}\n... [truncated]` : stderr}`)
  }

  blocks.push({ type: 'text', text: lines.join('\n') })
  return blocks
}

/** Human-readable byte size. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/**
 * Execute one MATLAB job and shape the tool result.
 * @param {object} ctx - plugin context (for the attachment service)
 * @param {object} config - resolved plugin config
 * @param {object} gate - concurrency gate
 * @param {object} args - tool arguments
 * @param {object} exec - DSH tool run context
 * @param {{code?: string, sourceFile?: string, outputDir: string, workDir: string, requireSimulink?: boolean}} job
 */
async function executeJob(ctx, config, gate, args, exec, job) {
  const matlab = requireMatlab(config)
  const policy = figurePolicy(args)
  policy.outputDir = job.outputDir

  const logs = []
  const timeoutMs = resolveTimeout(args.timeout_s, config)
  const signal = exec?.signal

  await gate.acquire()
  let result
  try {
    if (signal?.aborted) {
      result = {
        ok: false,
        failureKind: 'aborted',
        failure: 'The call was cancelled before MATLAB started.',
        durationMs: 0,
        artifacts: [],
        transcript: '',
        stderr: '',
        timedOut: false,
        aborted: true,
      }
    } else {
      result = await runMatlabJob({
        exe: matlab.exe,
        code: job.code,
        sourceFile: job.sourceFile,
        workDir: job.workDir,
        outputDir: job.outputDir,
        figures: policy,
        requireSimulink: job.requireSimulink === true,
        timeoutMs,
        signal,
        tempRoot: config.tempDir,
        maxArtifactBytes: config.maxArtifactBytes,
        maxInlineImageBytes: config.maxInlineImageBytes,
        report: config.streamOutput ? chunk => logs.push(chunk) : undefined,
      })
    }
  } finally {
    gate.release()
  }

  result.matlab = `${matlab.release || matlab.version || 'MATLAB'} at ${matlab.root} (via ${matlab.source})`
  result.requestedTimeoutMs = timeoutMs
  return { result, blocks: await renderResult(ctx, args, result) }
}

/**
 * Reduce a value to lossless JSON.
 *
 * The tool registry rejects a result that is not lossless JSON, and JavaScript
 * `undefined` object properties — which are ubiquitous on a partially-filled
 * result — are exactly what it rejects. Dropping them here mirrors what
 * `JSON.stringify` would do, while non-finite numbers become `null` because
 * JSON has no representation for them.
 */
function toLosslessJson(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(toLosslessJson)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      out[key] = toLosslessJson(entry)
    }
    return out
  }
  // A function, symbol or bigint cannot cross the tool boundary.
  return null
}

/** Wraps a job executor into the definition shape the registry expects. */
function defineJobTool({ name, description, parameters, execute, isConcurrencySafe }) {
  return {
    name,
    description,
    parameters,
    ...(isConcurrencySafe ? { isConcurrencySafe } : {}),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => value?.__blocks ?? [{ type: 'text', text: 'MATLAB tool produced no renderable content.' }],
    },
    execute: async (args, exec) => {
      const { result, blocks } = await execute(args ?? {}, exec)
      // `__blocks` is the exact content the session renders; the rest is the
      // structured value, normalized so the registry's JSON check passes.
      return toLosslessJson({ ...result, __blocks: blocks })
    },
  }
}

/**
 * Create every tool definition for this plugin.
 * @param {object} ctx - plugin context
 * @param {object} config - resolved plugin config
 */
export function createTools(ctx, config) {
  const gate = createGate(config.maxConcurrent)

  const statusTool = defineJobTool({
    name: 'matlab_status',
    description:
      'Report which MATLAB/Simulink installation this plugin will use, how it was discovered, and whether launching it works. '
      + 'Call this first when a MATLAB or Simulink task fails unexpectedly, or to confirm the toolchain before a long run.',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {
        verify_launch: {
          type: 'boolean',
          default: false,
          description: 'Also start MATLAB once to confirm it launches and report its version. Adds roughly 10-60 seconds.',
        },
        toolboxes: {
          type: 'boolean',
          default: false,
          description: 'List installed toolboxes and versions (implies verify_launch).',
        },
        refresh: {
          type: 'boolean',
          default: false,
          description: 'Re-run discovery instead of using the cached installation.',
        },
      },
      additionalProperties: false,
    },
    execute: async args => {
      const found = discoverMatlab({ roots: config.matlabRoots, refresh: args.refresh === true })
      const lines = []
      if (!found.ok) {
        lines.push('MATLAB: NOT FOUND')
        lines.push(found.reason)
        if (found.tried.length) lines.push(`Tried: ${found.tried.join(', ')}`)
        lines.push('Set MATLAB_ROOT, add matlab.exe to PATH, or set config.matlabRoots in cordis.patch.yml.')
        return {
          result: toLosslessJson({
            ok: false, found: false, tried: found.tried,
            artifacts: [], durationMs: 0, transcript: lines.join('\n'),
          }),
          blocks: [{ type: 'text', text: lines.join('\n') }],
        }
      }

      lines.push(`MATLAB root: ${found.root}`)
      lines.push(`Executable:  ${found.exe}`)
      lines.push(`Release:     ${found.release || found.version || 'unknown'}`)
      lines.push(`Discovered:  ${found.source}`)
      lines.push(`Concurrency: up to ${config.maxConcurrent} parallel run(s), default timeout ${(resolveTimeout(undefined, config) / 1000).toFixed(0)}s`)

      const result = {
        found: true,
        matlab: { root: found.root, exe: found.exe, release: found.release, version: found.version, source: found.source },
        ok: true,
        durationMs: 0,
        artifacts: [],
      }

      if (args.verify_launch || args.toolboxes) {
        const verifyCode = args.toolboxes
          ? [
            "disp(['version=' version]);",
            "disp(['release=' version('-release')]);",
            "disp(['charset=' feature('DefaultCharacterSet')]);",
            "disp(['cores=' num2str(feature('numcores'))]);",
            "v = ver; names = sort({v.Name});",
            "fprintf('TOOLBOX: %s\\n', names{:});",
          ].join('\n')
          : [
            "disp(['version=' version]);",
            "disp(['release=' version('-release')]);",
          ].join('\n')

        const probe = await executeJob(ctx, config, gate, {
          working_dir: config.tempDir,
          output_dir: join(config.tempDir ?? found.root, 'dsh-matlab-simulink-probe'),
          export_figures: false,
          timeout_s: Math.min(300, resolveTimeout(undefined, config) / 1000),
        }, { signal: undefined }, {
          code: verifyCode,
          outputDir: join(config.tempDir ?? found.root, 'dsh-matlab-simulink-probe'),
          workDir: config.tempDir,
        })

        result.ok = probe.result.ok
        result.durationMs = probe.result.durationMs
        result.transcript = probe.result.transcript
        result.matlabError = probe.result.matlabError
        const toolboxes = (probe.result.stdout ?? '')
          .split(/\r?\n/)
          .filter(line => line.startsWith('TOOLBOX: '))
          .map(line => line.slice('TOOLBOX: '.length).trim())
        if (toolboxes.length) result.toolboxes = toolboxes
        if (!probe.result.ok) {
          lines.push('', `Launch verification FAILED: ${probe.result.failure}`)
          lines.push(probe.result.transcript || '')
        } else {
          lines.push('', 'Launch verification OK.')
          const info = (probe.result.transcript ?? '').split(/\r?\n/).filter(Boolean)
          lines.push(...info)
          if (toolboxes.length) {
            lines.push('', `Installed toolboxes (${toolboxes.length}): ${toolboxes.join(', ')}`)
          }
        }
      } else {
        lines.push('', 'Launch not verified (pass verify_launch: true to start MATLAB once).')
      }

      const body = lines.filter(line => line !== '').join('\n')
      return { result: toLosslessJson(result), blocks: [{ type: 'text', text: body }] }
    },
  })

  const runScriptTool = defineJobTool({
    name: 'matlab_run_script',
    description:
      'Run an existing MATLAB .m script file in headless MATLAB and collect the figures and data it produces. '
      + 'The script runs in its own directory with the academic figure defaults already applied, so a script that calls plot()/saveas() '
      + 'will still yield exported artifacts. Prefer this over matlab_run_code when the analysis already exists as a file.',
    parameters: {
      type: 'object',
      properties: {
        script_path: { type: 'string', description: 'Absolute path to the .m script to run.' },
        ...RUN_PROPERTIES,
        export_format: FIGURE_PROPERTIES.export_format,
        dpi: FIGURE_PROPERTIES.dpi,
        font_name: FIGURE_PROPERTIES.font_name,
        font_size: FIGURE_PROPERTIES.font_size,
        figure_width: FIGURE_PROPERTIES.figure_width,
        figure_height: FIGURE_PROPERTIES.figure_height,
        reset_graphics: FIGURE_PROPERTIES.reset_graphics,
        export_figures: {
          type: 'boolean',
          default: true,
          description: 'Export every open figure at the end of the run. Turn off for pure computation.',
        },
      },
      required: ['script_path'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const scriptPath = requireFile(args.script_path, 'script-not-found',
        'script_path is required and must point to an existing .m file.')
      const ext = extname(scriptPath).toLowerCase()
      if (ext !== '.m') {
        throw new ToolError(`script_path must be a .m file, received "${basename(scriptPath)}".`, 'script-extension')
      }
      const { workDir, outputDir } = resolveOutputDir(
        { ...args, working_dir: args.working_dir ?? dirname(scriptPath) },
        exec,
      )
      // Executed from a staged ASCII copy: MATLAB's parser rejects scripts
      // reached through a non-ASCII path, but the working directory remains the
      // user's own folder so relative save/load still resolve correctly.
      return executeJob(ctx, config, gate, args, exec, {
        sourceFile: scriptPath,
        outputDir,
        workDir,
      })
    },
  })

  const runCodeTool = defineJobTool({
    name: 'matlab_run_code',
    description:
      'Run MATLAB code directly, without a file on disk. Use it for calculations, quick numerical experiments, control-system analysis, '
      + 'and plotting: any figure left open at the end of the snippet is exported with academic styling. '
      + 'The code runs inside try/catch, so a syntax or runtime error comes back as a readable MATLAB message instead of a bare exit code.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'MATLAB statements to execute. Multiple lines are supported. Do not call exit(); the plugin manages that.',
        },
        ...RUN_PROPERTIES,
        export_format: FIGURE_PROPERTIES.export_format,
        dpi: FIGURE_PROPERTIES.dpi,
        font_name: FIGURE_PROPERTIES.font_name,
        font_size: FIGURE_PROPERTIES.font_size,
        figure_width: FIGURE_PROPERTIES.figure_width,
        figure_height: FIGURE_PROPERTIES.figure_height,
        reset_graphics: FIGURE_PROPERTIES.reset_graphics,
        export_figures: {
          type: 'boolean',
          default: true,
          description: 'Export every open figure at the end of the run. Turn off for pure computation.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const code = typeof args.code === 'string' ? args.code.trim() : ''
      if (!code) throw new ToolError('code is required and must be a non-empty MATLAB snippet.', 'code-empty')
      if (/\bexit\s*\(/.test(code) || /\bquit\b/.test(code)) {
        throw new ToolError(
          'The snippet must not call exit()/quit(); the plugin owns process termination and needs the trailing export stage to run.',
          'code-exit',
        )
      }
      const { workDir, outputDir } = resolveOutputDir(args, exec)
      return executeJob(ctx, config, gate, args, exec, { code, outputDir, workDir })
    },
  })

  const simulinkTool = defineJobTool({
    name: 'simulink_run_model',
    description:
      'Load a Simulink model (.slx/.mdl), optionally override StopTime and block parameters, simulate it, and export the logged signals '
      + 'as MAT files plus CSV tables for inspection. Figures left open by the model or by your own post-processing are exported too. '
      + 'Block paths are relative to the model root, for example "Plant/Gain".',
    parameters: {
      type: 'object',
      properties: {
        model_path: { type: 'string', description: 'Absolute path to the .slx or .mdl model file.' },
        stop_time: {
          type: 'number',
          description: 'Simulation StopTime in seconds. Omit to use the value saved in the model.',
        },
        parameters: {
          type: 'array',
          description: 'Block parameter overrides applied before simulation, e.g. [{"block":"Gain","parameter":"Gain","value":"2.5"}].',
          items: {
            type: 'object',
            properties: {
              block: { type: 'string', description: 'Block path relative to the model root, e.g. "Controller/Kp".' },
              parameter: { type: 'string', description: 'Block parameter name, e.g. "Gain" or "Amplitude".' },
              value: {
                description: 'New parameter value. Numbers are passed as MATLAB numerics, strings verbatim.',
                oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
              },
            },
            required: ['block', 'parameter', 'value'],
            additionalProperties: false,
          },
        },
        output_variables: {
          type: 'array',
          items: { type: 'string' },
          description: 'Logged variable names to report and export, e.g. ["yout","tout"]. Omit to export everything the model logs.',
        },
        sim_options: {
          type: 'object',
          description: 'Extra Simulink.SimulationInput model parameters, e.g. {"Solver":"ode23t","SaveOutput":"on"}.',
          additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
        },
        save_model: {
          type: 'boolean',
          default: false,
          description: 'Persist parameter overrides back into the .slx file. Off by default so a run never rewrites your model.',
        },
        export_data: {
          type: 'boolean',
          default: true,
          description: 'Export logged signals as .mat and .csv files into the signals subdirectory.',
        },
        post_process: {
          type: 'string',
          description: 'Optional MATLAB code appended after the simulation, for example to plot the logged signal. The variable `dsh_out_sim` holds the Simulink.SimulationOutput.',
        },
        ...RUN_PROPERTIES,
        export_format: FIGURE_PROPERTIES.export_format,
        dpi: FIGURE_PROPERTIES.dpi,
        font_name: FIGURE_PROPERTIES.font_name,
        font_size: FIGURE_PROPERTIES.font_size,
        figure_width: FIGURE_PROPERTIES.figure_width,
        figure_height: FIGURE_PROPERTIES.figure_height,
        reset_graphics: FIGURE_PROPERTIES.reset_graphics,
      },
      required: ['model_path'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const modelPath = requireFile(args.model_path, 'model-not-found',
        'model_path is required and must point to an existing .slx or .mdl file.')
      const ext = extname(modelPath).toLowerCase()
      if (ext !== '.slx' && ext !== '.mdl') {
        throw new ToolError(`model_path must be a .slx or .mdl file, received "${basename(modelPath)}".`, 'model-extension')
      }
      const modelName = basename(modelPath, extname(modelPath))
      const { workDir, outputDir } = resolveOutputDir(
        { ...args, working_dir: args.working_dir ?? dirname(modelPath) },
        exec,
      )
      const signalsDir = join(outputDir, 'signals')

      const body = buildSimulinkBody({
        modelPath,
        modelName,
        stopTime: args.stop_time,
        parameters: args.parameters ?? [],
        outputVariables: args.output_variables ?? [],
        signalsDir,
        simOptions: args.sim_options ?? {},
        saveModel: args.save_model === true,
        exportData: args.export_data !== false,
      })

      const code = args.post_process && String(args.post_process).trim()
        ? `${body}\n\n% ---- User post-processing ------------------------------------------------\n${String(args.post_process).trim()}`
        : body

      return executeJob(ctx, config, gate, args, exec, {
        code,
        outputDir,
        workDir,
        requireSimulink: true,
      })
    },
  })

  const exportFigureTool = defineJobTool({
    name: 'matlab_export_figure',
    description:
      'Re-render an existing figure file (for example a loose PDF or PNG produced by an earlier run) at a different size, DPI, font, or format. '
      + 'Use it to satisfy a journal\'s figure requirements without re-running the simulation.',
    parameters: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Absolute path to the figure file to re-render (pdf, png, jpg, eps, svg, fig, or mat).' },
        ...FIGURE_PROPERTIES,
        target_format: {
          type: 'string',
          enum: ['pdf', 'png', 'eps', 'svg', 'jpg'],
          default: 'pdf',
          description: 'Format to re-render the source figure into.',
        },
        ...RUN_PROPERTIES,
      },
      required: ['source_path'],
      additionalProperties: false,
    },
    execute: async (args, exec) => {
      const sourcePath = requireFile(args.source_path, 'figure-not-found',
        'source_path is required and must point to an existing figure file.')
      const ext = extname(sourcePath).toLowerCase().slice(1)
      const { workDir, outputDir } = resolveOutputDir(
        { ...args, working_dir: args.working_dir ?? dirname(sourcePath) },
        exec,
      )

      let code
      if (ext === 'fig') {
        code = [
          `dsh_src = '${sourcePath.replace(/\\/g, '/').replace(/'/g, "''")}';`,
          "fprintf('DSH_INFO: opening figure %s\\n', dsh_src);",
          'openfig(dsh_src);',
        ].join('\n')
      } else if (ext === 'mat') {
        code = [
          `dsh_src = '${sourcePath.replace(/\\/g, '/').replace(/'/g, "''")}';`,
          'dsh_s = load(dsh_src);',
          'dsh_fn = fieldnames(dsh_s);',
          'dsh_done_fig = false;',
          'for dsh_i = 1:numel(dsh_fn)',
          '    dsh_v = dsh_s.(dsh_fn{dsh_i});',
          "    if isa(dsh_v, 'matlab.ui.Figure')",
          '        figure(dsh_v); dsh_done_fig = true; break;',
          '    end',
          'end',
          'if ~dsh_done_fig',
          "    error('DSH:NoFigure', 'No figure handle found inside %s.', dsh_src);",
          'end',
        ].join('\n')
      } else {
        // Raster/vector input: show it so the export stage re-emits it in the
        // requested format and geometry.
        code = [
          `dsh_src = '${sourcePath.replace(/\\/g, '/').replace(/'/g, "''")}';`,
          "fprintf('DSH_INFO: re-rendering %s\\n', dsh_src);",
          'dsh_img = imread(dsh_src);',
          "dsh_f = figure('Visible', 'off', 'Color', 'w');",
          'dsh_ax = axes(dsh_f);',
          'image(dsh_ax, dsh_img);',
          "set(dsh_ax, 'Visible', 'off');",
          "set(dsh_f, 'Units', 'inches');",
        ].join('\n')
      }

      const argsWithFormat = { ...args, export_format: args.target_format ?? args.export_format ?? 'pdf' }
      return executeJob(ctx, config, gate, argsWithFormat, exec, { code, outputDir, workDir })
    },
  })

  return [statusTool, runScriptTool, runCodeTool, simulinkTool, exportFigureTool]
}

/** Exported for the standalone test harness. */
export const internals = { ToolError, resolveOutputDir, figurePolicy, renderResult, formatBytes }

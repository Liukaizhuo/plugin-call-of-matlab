/**
 * Standalone test harness for dsh-matlab-simulink.
 *
 * Drives the plugin through a minimal fake Cordis context so every tool can be
 * exercised against a real MATLAB installation without restarting DSH.
 *
 * Usage:
 *   node test/harness.mjs [scenario ...] [--offline] [--strict]
 *
 *   scenario   run only the named scenarios (default: all)
 *   --offline  run only the checks that need no MATLAB
 *   --strict   treat a missing MATLAB as a failure instead of a skip
 *
 * Scenarios:
 *   load schemas status status-verify code export-figure script
 *   sim sim-params failure syntax-error exit-guard missing-file
 *   abort timeout render non-ascii
 *
 * Exit status is 0 when every check either passed or was skipped. A missing
 * MATLAB skips the run scenarios and still validates the plugin contract, which
 * is what makes this usable as a CI job on a machine without MATLAB.
 *
 * Environment:
 *   MATLAB_ROOT  pin the MATLAB installation used for the run scenarios
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { discoverMatlab } from '../lib/matlab-discovery.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const sandbox = join(pkgRoot, '.test-sandbox')

const argv = process.argv.slice(2)
const offlineOnly = argv.includes('--offline')
const strict = argv.includes('--strict') || process.env.CI_STRICT_MATLAB === '1'
const scenarios = argv.filter(arg => !arg.startsWith('--'))

/** All tools this plugin must publish. */
const REQUIRED_TOOLS = [
  'matlab_status',
  'matlab_run_script',
  'matlab_run_code',
  'simulink_run_model',
  'matlab_export_figure',
]

/** Minimal Cordis context: what the plugin actually touches, nothing more. */
function makeContext() {
  const registered = new Map()
  const logs = []
  const logger = {
    info: message => logs.push(['info', message]),
    warn: message => logs.push(['warn', message]),
    error: message => logs.push(['error', message]),
  }
  const ctx = {
    logger,
    logs,
    get: () => undefined,
    on: () => () => {},
    effect: factory => {
      const disposer = factory()
      return () => (typeof disposer === 'function' ? disposer() : undefined)
    },
    inject: (services, callback) => {
      const scoped = {
        ...ctx,
        tools: {
          register: definition => {
            registered.set(definition.name, definition)
            return () => registered.delete(definition.name)
          },
        },
      }
      callback(scoped)
    },
  }
  return { ctx, registered }
}

/** Call a registered tool the way the registry does. */
async function callTool(registered, toolName, args, signal) {
  const definition = registered.get(toolName)
  if (!definition) throw new Error(`tool not registered: ${toolName} (have ${[...registered.keys()].join(', ')})`)
  const value = await definition.execute(args, { signal, cwd: sandbox, agent: undefined })
  assertLosslessJson(toolName, value)
  const blocks = definition.output.render(args, value)
  return { value, blocks, definition }
}

/**
 * Reproduce the registry's own contract check: a tool result must survive a
 * JSON round-trip unchanged. `undefined` object properties are the usual
 * offender, and they only surface at dispatch time in a live session, so the
 * harness enforces it on every call.
 */
function assertLosslessJson(toolName, value) {
  let round
  try {
    round = JSON.parse(JSON.stringify(value))
  } catch (error) {
    throw new Error(`[${toolName}] result is not JSON-serializable: ${error.message}`)
  }
  const walk = (node, path) => {
    if (node === null) return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], `${path}.${key}`)
      return
    }
    if (typeof node === 'number' && !Number.isFinite(node)) {
      throw new Error(`[${toolName}] non-finite number at ${path}`)
    }
    if (typeof node === 'function' || typeof node === 'undefined') {
      throw new Error(`[${toolName}] non-JSON ${typeof node} at ${path}`)
    }
  }
  walk(round, toolName)

  const undefinedPaths = []
  const findUndefined = (node, path) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => findUndefined(entry, `${path}[${index}]`))
      return
    }
    for (const [key, entry] of Object.entries(node)) {
      if (entry === undefined) undefinedPaths.push(`${path}.${key}`)
      else findUndefined(entry, `${path}.${key}`)
    }
  }
  findUndefined(value, toolName)
  if (undefinedPaths.length) {
    throw new Error(`[${toolName}] undefined properties would fail the lossless-JSON check: ${undefinedPaths.slice(0, 6).join(', ')}`)
  }
}

/** Render content blocks to something printable. */
function summarize(blocks) {
  return blocks.map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return `[image attachment ${block.attachment?.attachmentId ?? '?'} ${block.attachment?.width}x${block.attachment?.height}]`
    return `[${block.type}]`
  }).join('\n')
}

const results = []
const counts = { pass: 0, fail: 0, skip: 0 }

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  results.push({ label, status, detail })
  counts[condition ? 'pass' : 'fail'] += 1
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function skip(label, reason) {
  results.push({ label, status: 'SKIP', detail: reason })
  counts.skip += 1
  console.log(`  [SKIP] ${label}${reason ? ` — ${reason}` : ''}`)
}

/**
 * Run one scenario body. A throw is recorded as a failed check rather than
 * killing the run, so one broken scenario cannot hide the state of the rest.
 */
async function scenario(name, mustRun, body) {
  if (!mustRun) return
  try {
    await body()
  } catch (error) {
    check(`${name}: scenario completed without throwing`, false, error.message)
  }
}

async function main() {
  const run = name => scenarios.length === 0 || scenarios.includes(name)

  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(sandbox, { recursive: true })

  const { ctx, registered } = makeContext()
  apply(ctx, { timeoutMs: 300_000, maxConcurrent: 1 })

  // ---- plugin contract (no MATLAB required) --------------------------------
  console.log('=== plugin load ===')
  check('plugin registered tools', registered.size === REQUIRED_TOOLS.length, `${registered.size}: ${[...registered.keys()].join(', ')}`)
  for (const [level, message] of ctx.logs) console.log(`  [${level}] ${message}`)

  const names = [...registered.keys()]
  for (const expected of REQUIRED_TOOLS) {
    check(`tool present: ${expected}`, names.includes(expected))
  }

  console.log('\n=== schemas ===')
  for (const definition of registered.values()) {
    const ok = definition.parameters?.type === 'object'
      && definition.parameters.properties
      && typeof definition.description === 'string' && definition.description.length > 40
      && typeof definition.execute === 'function'
      && definition.output?.schema && typeof definition.output.render === 'function'
    check(`schema well-formed: ${definition.name}`, Boolean(ok))
  }

  // ---- MATLAB availability -------------------------------------------------
  const found = discoverMatlab({ roots: process.env.MATLAB_ROOT ? [process.env.MATLAB_ROOT] : [] })
  const haveMatlab = found.ok && !offlineOnly

  console.log('\n=== environment ===')
  if (offlineOnly) {
    console.log('  offline mode: MATLAB run scenarios skipped by request')
  } else if (found.ok) {
    console.log(`  MATLAB: ${found.release || found.version} at ${found.root} (via ${found.source})`)
  } else {
    console.log(`  MATLAB: not found — ${found.reason}`)
    if (found.tried.length) console.log(`  tried:  ${found.tried.join(', ')}`)
  }
  if (!haveMatlab && strict) {
    check('MATLAB is available (--strict)', false, found.ok ? 'skipped by --offline' : found.reason)
  }

  /** Skip helper honouring the offline/strict switches. */
  const needsMatlab = reason => {
    if (haveMatlab) return true
    if (strict) return true
    skip(reason, offlineOnly ? 'offline mode' : 'MATLAB not found')
    return false
  }

  if (run('status')) await scenario('status', true, async () => {
    console.log('\n=== scenario: status (discovery only) ===')
    const { blocks } = await callTool(registered, 'matlab_status', {})
    console.log(summarize(blocks))
    const text = summarize(blocks)
    check('status reports an installation or an actionable reason',
      /MATLAB root:/i.test(text) || /MATLAB: NOT FOUND/.test(text))
    if (haveMatlab) check('status finds MATLAB', /MATLAB root:/i.test(text))
  })

  if (run('status-verify')) await scenario('status-verify', needsMatlab('launch verification'), async () => {
    console.log('\n=== scenario: status (verify launch + toolboxes) ===')
    const { blocks } = await callTool(registered, 'matlab_status', { verify_launch: true, toolboxes: true })
    const text = summarize(blocks)
    console.log(text)
    check('launch verified', /Launch verification OK/i.test(text))
    check('toolboxes listed', /Simulink/.test(text) && /Installed toolboxes/.test(text))
  })

  if (run('code')) await scenario('code', needsMatlab('inline code'), async () => {
    console.log('\n=== scenario: inline code with a figure ===')
    const outDir = join(sandbox, 'code-out')
    const { blocks } = await callTool(registered, 'matlab_run_code', {
      code: [
        't = linspace(0, 2*pi, 200);',
        'y = sin(t) .* exp(-0.3*t);',
        "f = figure('Visible','off');",
        "plot(t, y, 'LineWidth', 1.4);",
        "xlabel('Time (s)'); ylabel('Amplitude');",
        "title('Damped Sine'); grid on; box on;",
        "disp(['computed max=' num2str(max(y))]);",
      ].join('\n'),
      output_dir: outDir,
      export_format: 'pdf',
      dpi: 300,
    })
    const text = summarize(blocks)
    console.log(text)
    check('code run succeeded', /MATLAB run completed/.test(text))
    check('figure pdf produced', existsSync(join(outDir, 'figure01.pdf')))
    check('stdout captured', /computed max=/.test(text))
  })

  if (run('export-figure')) await scenario('export-figure', needsMatlab('figure re-render'), async () => {
    console.log('\n=== scenario: re-render an existing figure ===')
    const sourceDir = join(sandbox, 'export-src')
    const produced = await callTool(registered, 'matlab_run_code', {
      code: 'f = figure; bar([3 7 2 9]); title("Source Figure"); grid on;',
      output_dir: sourceDir,
      export_format: 'png',
      dpi: 150,
    })
    const sourcePng = join(sourceDir, 'figure01.png')
    check('source figure produced', existsSync(sourcePng), summarize(produced.blocks).slice(0, 80))

    const outDir = join(sandbox, 'export-out')
    const { value, blocks } = await callTool(registered, 'matlab_export_figure', {
      source_path: sourcePng,
      target_format: 'pdf',
      output_dir: outDir,
      figure_width: 4,
      figure_height: 4,
      dpi: 600,
    })
    console.log(summarize(blocks))
    check('re-render succeeded', value.ok === true, `kind=${value.failureKind} err=${value.matlabError ?? ''}`)
    check('re-rendered pdf produced', existsSync(join(outDir, 'figure01.pdf')))
  })

  if (run('script')) await scenario('script', needsMatlab('user script run'), async () => {
    console.log('\n=== scenario: run an existing .m script ===')
    const scriptPath = join(sandbox, 'my_analysis.m')
    writeFileSync(scriptPath, [
      '% Existing user script',
      'A = [1 2; 3 4];',
      'fprintf("det=%d\\n", det(A));',
      'save("script_result.mat", "A");',
      'f = figure;',
      'plot(eig(A), "o"); title("Eigenvalues"); grid on;',
    ].join('\n'), 'utf8')
    const outDir = join(sandbox, 'script-out')
    const { value, blocks } = await callTool(registered, 'matlab_run_script', {
      script_path: scriptPath,
      output_dir: outDir,
      export_format: 'png',
      dpi: 200,
    })
    const text = summarize(blocks)
    console.log(text)
    check('script run succeeded', /MATLAB run completed/.test(text))
    check('script stdout captured', /det=-2/.test(text))
    check('png figure produced', existsSync(join(outDir, 'figure01.png')))
    // A relative save() must land beside the script, never in the plugin's
    // staging directory (which is deleted when the run ends).
    check('relative save lands in the script folder', existsSync(join(sandbox, 'script_result.mat')))
    check('relative save reported as artifact', /script_result\.mat/.test(text))
    check('no leak into temp staging dir', !/AppData[\\/]Local[\\/]Temp.*script_result\.mat/.test(text))
    check('script run reported ok', value.ok === true, `kind=${value.failureKind}`)
  })

  if (run('sim')) await scenario('sim', needsMatlab('Simulink simulation'), async () => {
    console.log('\n=== scenario: build and simulate a Simulink model ===')
    const buildScript = join(sandbox, 'build_model.m')
    const modelPath = join(sandbox, 'harness_model.slx')
    const modelSlash = modelPath.replace(/\\/g, '/')
    writeFileSync(buildScript, [
      "mdl = 'harness_model';",
      'if bdIsLoaded(mdl), close_system(mdl, 0); end',
      `if exist('${modelSlash}', 'file'), delete('${modelSlash}'); end`,
      'new_system(mdl); load_system(mdl);',
      "add_block('simulink/Sources/Sine Wave', [mdl '/Sine'], 'Amplitude', '1', 'Frequency', '2*pi*0.5');",
      "add_block('simulink/Math Operations/Gain', [mdl '/Gain'], 'Gain', '2');",
      "add_block('simulink/Continuous/Transfer Fcn', [mdl '/Plant'], 'Numerator', '[1]', 'Denominator', '[1 1]');",
      "add_block('simulink/Sinks/To Workspace', [mdl '/Log'], 'VariableName', 'yout', 'SaveFormat', 'Structure With Time');",
      "add_line(mdl, 'Sine/1', 'Gain/1', 'autorouting', 'on');",
      "add_line(mdl, 'Gain/1', 'Plant/1', 'autorouting', 'on');",
      "add_line(mdl, 'Plant/1', 'Log/1', 'autorouting', 'on');",
      "set_param(mdl, 'StopTime', '5', 'Solver', 'ode45');",
      `save_system(mdl, '${modelSlash}');`,
      'close_system(mdl, 0);',
      'disp("MODEL_BUILT");',
    ].join('\n'), 'utf8')

    const built = await callTool(registered, 'matlab_run_script', {
      script_path: buildScript,
      output_dir: join(sandbox, 'model-build'),
      export_figures: false,
    })
    check('model built', /MODEL_BUILT/.test(summarize(built.blocks)))
    check('model file exists', existsSync(modelPath))

    const outDir = join(sandbox, 'sim-out')
    const { blocks } = await callTool(registered, 'simulink_run_model', {
      model_path: modelPath,
      stop_time: 4,
      output_variables: ['yout'],
      post_process: [
        'y = dsh_out_sim.get("yout");',
        'if isa(y, "timeseries"), tt = y.Time; yy = y.Data; else, tt = y.time; yy = y.signals.values; end',
        'f = figure;',
        'plot(tt, yy, "LineWidth", 1.4);',
        'xlabel("Time (s)"); ylabel("Response");',
        'title("Simulink Step Response"); grid on; box on;',
      ].join('\n'),
      output_dir: outDir,
      export_format: 'pdf',
    })
    const text = summarize(blocks)
    console.log(text)
    check('simulation succeeded', /MATLAB run completed/.test(text))
    check('loaded model logged', /loaded model harness_model/.test(text))
    check('simulation finished logged', /simulation finished/.test(text))
    check('logged variables reported', /logged variables:/.test(text))
    check('primary figure pdf', existsSync(join(outDir, 'figure01.pdf')))
    check('mat artifact exported', existsSync(join(outDir, 'yout.mat')))
    check('csv signal table exported', existsSync(join(outDir, 'signals', 'yout.csv')))
    if (existsSync(join(outDir, 'signals', 'yout.csv'))) {
      const csv = readFileSync(join(outDir, 'signals', 'yout.csv'), 'utf8')
      const rows = csv.trim().split('\n')
      check('csv has header + samples', rows.length > 10 && /^time,/.test(csv), `${rows.length} rows`)
    }
    check('stop_time override respected', /StopTime=4/.test(text))
  })

  if (run('sim-params')) await scenario('sim-params', needsMatlab('Simulink parameter override'), async () => {
    console.log('\n=== scenario: Simulink block parameter override ===')
    const modelPath = join(sandbox, 'harness_model.slx')
    if (!existsSync(modelPath)) {
      skip('parameter override applied', 'model absent; run the "sim" scenario first')
      return
    }
    const outDir = join(sandbox, 'simparam-out')
    const { blocks } = await callTool(registered, 'simulink_run_model', {
      model_path: modelPath,
      stop_time: 2,
      parameters: [{ block: 'Gain', parameter: 'Gain', value: 7.5 }],
      output_dir: outDir,
      export_format: 'png',
      dpi: 150,
    })
    const text = summarize(blocks)
    console.log(text)
    // set_param requires a char expression: a numeric literal is rejected by
    // Simulink, so this asserts the generated quoting.
    check('parameter override applied', /override Gain Gain := 7\.5/.test(text), text.match(/override[^\n]*/)?.[0])
    check('run with override succeeded', /MATLAB run completed/.test(text))
  })

  if (run('failure')) await scenario('failure', needsMatlab('runtime error handling'), async () => {
    console.log('\n=== scenario: MATLAB runtime error surfaces cleanly ===')
    const { value, blocks } = await callTool(registered, 'matlab_run_code', {
      code: 'A = notAFunction(3);',
      output_dir: join(sandbox, 'fail-out'),
    })
    console.log(summarize(blocks))
    check('run reported as failed', value.ok === false)
    check('failure kind is matlab', value.failureKind === 'matlab', String(value.failureKind))
    check('error text captured', /notAFunction|Unrecognized|未定义/i.test(value.matlabError ?? ''), String(value.matlabError))
  })

  if (run('syntax-error')) await scenario('syntax-error', needsMatlab('syntax error handling'), async () => {
    console.log('\n=== scenario: MATLAB syntax error ===')
    const { value, blocks } = await callTool(registered, 'matlab_run_code', {
      code: 'if true\n  disp("unterminated")\n',
      output_dir: join(sandbox, 'syntax-out'),
    })
    console.log(summarize(blocks))
    check('syntax error reported', value.ok === false, `kind=${value.failureKind}`)
    check('syntax error carries a diagnostic', Boolean(value.failure || value.matlabError || value.stderr))
  })

  if (run('exit-guard')) await scenario('exit-guard', true, async () => {
    console.log('\n=== scenario: exit() guard ===')
    let threw
    try {
      await callTool(registered, 'matlab_run_code', { code: 'exit(0)', output_dir: join(sandbox, 'x') })
    } catch (error) {
      threw = error
    }
    check('exit() rejected up front', Boolean(threw), threw?.message?.slice(0, 90))
  })

  if (run('missing-file')) await scenario('missing-file', true, async () => {
    console.log('\n=== scenario: missing input file ===')
    let threw
    try {
      await callTool(registered, 'matlab_run_script', { script_path: join(sandbox, 'nope.m'), output_dir: join(sandbox, 'x') })
    } catch (error) {
      threw = error
    }
    check('missing script rejected', Boolean(threw), threw?.message)

    let threw2
    try {
      await callTool(registered, 'simulink_run_model', { model_path: join(sandbox, 'nope.slx'), output_dir: join(sandbox, 'x') })
    } catch (error) {
      threw2 = error
    }
    check('missing model rejected', Boolean(threw2), threw2?.message)

    let threw3
    try {
      const notAScript = join(sandbox, 'actually_a_model.slx')
      writeFileSync(notAScript, 'placeholder', 'utf8')
      await callTool(registered, 'matlab_run_script', { script_path: notAScript })
    } catch (error) {
      threw3 = error
    }
    check('wrong extension rejected', Boolean(threw3), threw3?.message)

    let threw4
    try {
      await callTool(registered, 'matlab_run_code', { code: '   ', output_dir: join(sandbox, 'x') })
    } catch (error) {
      threw4 = error
    }
    check('empty code rejected', Boolean(threw4), threw4?.message)
  })

  if (run('abort')) await scenario('abort', needsMatlab('cancellation'), async () => {
    console.log('\n=== scenario: cancellation kills the MATLAB tree ===')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 12_000)
    const started = Date.now()
    const { value, blocks } = await callTool(registered, 'matlab_run_code', {
      code: 'disp("starting long pause"); pause(120); disp("should never print");',
      output_dir: join(sandbox, 'abort-out'),
      timeout_s: 300,
    }, controller.signal)
    const elapsed = (Date.now() - started) / 1000
    console.log(summarize(blocks))
    check('abort reported', value.aborted === true, `failureKind=${value.failureKind}`)
    check('aborted quickly', elapsed < 60, `${elapsed.toFixed(1)}s`)
    check('run did not succeed', value.ok === false)
    check('cancelled run produced no output artifacts', (value.artifacts ?? []).length === 0)
  })

  if (run('timeout')) await scenario('timeout', needsMatlab('timeout'), async () => {
    console.log('\n=== scenario: timeout kills the MATLAB tree ===')
    const started = Date.now()
    const { value, blocks } = await callTool(registered, 'matlab_run_code', {
      code: 'pause(90);',
      output_dir: join(sandbox, 'timeout-out'),
      timeout_s: 15,
    })
    const elapsed = (Date.now() - started) / 1000
    console.log(summarize(blocks))
    check('timeout reported', value.timedOut === true, `failureKind=${value.failureKind}`)
    check('killed near the deadline', elapsed < 90, `${elapsed.toFixed(1)}s`)
  })

  if (run('render')) await scenario('render', needsMatlab('inline render candidate'), async () => {
    console.log('\n=== scenario: render path with PNG for inline preview ===')
    const outDir = join(sandbox, 'render-out')
    const { value, blocks } = await callTool(registered, 'matlab_run_code', {
      code: [
        'f = figure;',
        'surf(peaks(40));',
        'title("Peaks");',
        'colormap parula;',
      ].join('\n'),
      output_dir: outDir,
      export_format: 'png',
      dpi: 300,
      figure_width: 5,
      figure_height: 4,
    })
    console.log(summarize(blocks))
    check('render produced inline image candidate', (value.inlineImages ?? []).length > 0, JSON.stringify((value.inlineImages ?? []).map(i => i.name)))
    check('render produced a primary figure', Boolean(value.primaryFigure?.path))
  })

  if (run('non-ascii')) await scenario('non-ascii', needsMatlab('non-ASCII paths'), async () => {
    console.log('\n=== scenario: non-ASCII workspace path ===')
    const cjk = join(sandbox, '中文目录')
    mkdirSync(cjk, { recursive: true })
    const scriptPath = join(cjk, '中文脚本.m')
    writeFileSync(scriptPath, [
      'disp("中文脚本已执行");',
      'A = magic(3);',
      'save("cjk_result.mat", "A");',
      'f = figure; plot(1:5, [1 4 9 16 25], "-o"); title("平方"); grid on;',
    ].join('\n'), 'utf8')
    const outDir = join(cjk, '结果')
    const { value, blocks } = await callTool(registered, 'matlab_run_script', {
      script_path: scriptPath,
      output_dir: outDir,
      export_format: 'pdf',
    })
    console.log(summarize(blocks))
    check('CJK script path ran', value.ok === true, `kind=${value.failureKind}`)
    check('CJK output produced', existsSync(join(outDir, 'figure01.pdf')))
    check('CJK relative save lands in its folder', existsSync(join(cjk, 'cjk_result.mat')))
  })

  // ---- summary -------------------------------------------------------------
  const failed = results.filter(result => result.status === 'FAIL')
  const skipped = results.filter(result => result.status === 'SKIP')
  console.log(`\n=== summary: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped (${results.length} checks) ===`)
  for (const failure of failed) console.log(`  FAIL ${failure.label}${failure.detail ? ` — ${failure.detail}` : ''}`)
  for (const entry of skipped) console.log(`  SKIP ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`)

  // Clean up only on success; a failure leaves the sandbox for inspection.
  if (!failed.length) rmSync(sandbox, { recursive: true, force: true })
  else console.log(`\nsandbox kept for inspection: ${sandbox}`)

  if (failed.length) process.exitCode = 1
}

main().catch(error => {
  console.error('harness crash:', error)
  process.exitCode = 1
})

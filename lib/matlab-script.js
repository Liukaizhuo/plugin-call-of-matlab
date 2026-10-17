/**
 * MATLAB source generation.
 *
 * The single escaping rule that matters for single-quoted MATLAB literals is
 * that an apostrophe is doubled; `%` inside a quoted string is a literal
 * percent sign and must NOT be escaped (verified on R2024a).
 */

import { basename, dirname } from 'node:path'

/** Render a JavaScript string as a MATLAB single-quoted char literal. */
export function mstr(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Render a JavaScript array of strings as a MATLAB cell row: {'a','b'}. */
export function mcell(values) {
  return `{${values.map(mstr).join(', ')}}`
}

/** Normalize a path for MATLAB: forward slashes, which MATLAB accepts on Windows. */
export function mpath(value) {
  return String(value).replace(/\\/g, '/')
}

/** Render a numeric literal defensively (never emit NaN/Infinity as bare tokens). */
export function mnum(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${value}`)
  return String(n)
}

/**
 * Render a value as a MATLAB single-quoted *expression* string.
 *
 * Simulink's `set_param` rejects numeric literals outright ("invalid setting in
 * Gain block") and requires a char expression, so every value handed to
 * `set_param` must arrive quoted. Strings pass through verbatim, which lets a
 * caller supply an expression such as `2*pi*0.5` or a workspace variable name.
 */
export function mexpr(value) {
  if (typeof value === 'number') return mstr(mnum(value))
  if (typeof value === 'boolean') return mstr(value ? 'on' : 'off')
  return mstr(String(value))
}

/**
 * Render a value for `Simulink.SimulationInput`/`setModelParameter`, which
 * accepts both a raw numeric literal and a char expression.
 */
function mparamValue(value) {
  if (typeof value === 'number') return mnum(value)
  if (typeof value === 'boolean') return mstr(value ? 'on' : 'off')
  return mstr(String(value))
}

/**
 * Build the guard prologue that runs before user code: working directory,
 * academic figure preferences, and an optional toolbox assertion.
 */
function prologue({ workDir, figures, fontName, fontSize }) {
  const lines = [
    '% ---- DSH prologue -------------------------------------------------------',
    'dsh_ok = false;',
    `dsh_out = ${mstr(mpath(figures.outputDir))};`,
    `if exist(dsh_out, 'dir') ~= 7, mkdir(dsh_out); end`,
  ]
  if (workDir) {
    // The absolute working directory, applied before user code and restored
    // around `run()` so relative file access targets the user's own folder.
    lines.push(`dsh_originalWorkDir = ${mstr(mpath(workDir))};`)
    lines.push('if exist(dsh_originalWorkDir, \'dir\') == 7, cd(dsh_originalWorkDir); end')
  } else {
    lines.push('dsh_originalWorkDir = pwd;')
  }
  lines.push(
    '% Academic figure defaults (best effort: some releases lack these prefs).',
    'try',
    `    setpref('Figure', 'DefaultResolution', ${mnum(figures.dpi)});`,
    `    setpref('Figure', 'DefaultFontName', ${mstr(fontName)});`,
    `    setpref('Figure', 'DefaultFontSize', ${mnum(fontSize)});`,
    'catch',
    'end',
    'try',
    `    set(groot, 'defaultFigurePaperUnits', 'inches');`,
    `    set(groot, 'defaultAxesFontName', ${mstr(fontName)});`,
    `    set(groot, 'defaultTextFontName', ${mstr(fontName)});`,
    `    set(groot, 'defaultAxesFontSize', ${mnum(fontSize)});`,
    "    set(groot, 'defaultAxesLineWidth', 1.0);",
    "    set(groot, 'defaultAxesBox', 'on');",
    "    set(groot, 'defaultFigureColor', 'w');",
    'catch',
    'end',
    'try',
    "    warning('off', 'MATLAB:legend:IgnoringExtraEntries');",
    'catch',
    'end',
  )
  if (figures.resetGraphics) {
    lines.push("try, close all force; catch, end")
  }
  return lines
}

/**
 * Wrap user MATLAB code into a self-contained script.
 *
 * Failure isolation is deliberate: the user block, the artifact block, and the
 * marker block are separately guarded so a plotting failure still reports the
 * computation result, and a user error still leaves a readable DSHError log.
 *
 * @param {object} options
 * @param {string} [options.code] - user MATLAB body (mutually exclusive with userScript)
 * @param {string} [options.userScript] - staged ASCII path of a user .m file to run
 * @param {string} [options.userScriptLabel] - original path, used only in messages
 * @param {string} options.runDir - where the runner writes its own logs
 * @param {string} [options.workDir] - working directory for user code
 * @param {boolean} [options.requireSimulink]
 * @param {object} options.figures - figure/export policy
 * @returns {string} MATLAB source
 */
export function buildRunner(options) {
  const { code = '', userScript, userScriptLabel, runDir, workDir, requireSimulink = false, figures } = options
  const logError = mpath(`${runDir}\\dsh_error.txt`)
  const logErrorSlash = logError.replace(/\\/g, '/')
  const logDone = mpath(`${runDir}\\dsh_done.txt`).replace(/\\/g, '/')

  const lines = ['% DSH MATLAB runner (generated; safe to delete).', ...prologue({ workDir, figures, fontName: figures.fontName, fontSize: figures.fontSize })]

  if (requireSimulink) {
    lines.push(
      '% ---- Toolbox guard -----------------------------------------------------',
      'try',
      "    dsh_v = ver('Simulink');",
      'catch',
      '    dsh_v = [];',
      'end',
      'if isempty(dsh_v)',
      `    dsh_logf(${mstr(logErrorSlash)}, 'Simulink is not installed or not licensed for this MATLAB release.');`,
      `    dsh_logf(${mstr(logDone)}, '1');`,
      '    exit(0);',
      'end',
    )
  }

  // A user script is executed from its ASCII staging copy because MATLAB's
  // parser rejects a script reached through a non-ASCII path.
  //
  // The staging directory is only put on the path — never entered. Entering it
  // would send the script's relative save/load into the plugin's temp area (and
  // then into the bin when the temp area is cleaned up). The working directory
  // stays whatever the prologue established, i.e. the user's own folder.
  // `run(stagedPath)` is equally unusable here: it too moves the working
  // directory to the script's folder for the duration of the call.
  const userBlock = userScript
    ? [
      `dsh_stageDir = ${mstr(mpath(dirname(userScript)))};`,
      `dsh_stageName = ${mstr(basename(userScript, '.m'))};`,
      `dsh_scriptPath = ${mstr(mpath(userScriptLabel || userScript))};`,
      "fprintf('DSH_INFO: running user script (%s)\\n', dsh_scriptPath);",
      'dsh_prevPath = path;',
      'addpath(dsh_stageDir);',
      'try',
      '    eval(dsh_stageName);',
      'catch dsh_userErr',
      '    path(dsh_prevPath);',
      '    rethrow(dsh_userErr);',
      'end',
      'path(dsh_prevPath);',
    ].join('\n')
    : code.trim()

  lines.push(
    '% ---- User code ----------------------------------------------------------',
    'try',
    indent(userBlock, 1),
    '    dsh_ok = true;',
    'catch dsh_me',
    '    dsh_ok = false;',
    '    dsh_msg = dsh_me.message;',
    "    if isfield(dsh_me, 'cause') && ~isempty(dsh_me.cause) && isstruct(dsh_me.cause)",
    "        try, dsh_msg = [dsh_msg sprintf('\\n  cause: %s', dsh_me.cause{1}.message)]; catch, end",
    '    end',
    "    dsh_msg = strrep(dsh_msg, char(10), sprintf('\\n  '));",
    `    dsh_logf(${mstr(logErrorSlash)}, dsh_msg);`,
    "    fprintf(2, 'DSH_ERROR: %s\\n', dsh_msg);",
    'end',
  )

  if (figures.enabled) {
    // Format preference chain: the caller's choice first, then a raster
    // fallback, so a figure is still produced when a format is unavailable.
    const requested = String(figures.format || 'pdf').toLowerCase()
    const chain = [requested]
    for (const candidate of ['pdf', 'png']) {
      if (!chain.includes(candidate)) chain.push(candidate)
    }
    const formatList = `{${chain.map(f => `'${f}'`).join(', ')}}`

    lines.push(
      '% ---- Figure export ------------------------------------------------------',
      'try',
      `    dsh_formats = ${formatList};`,
      "    dsh_figs = findobj('Type', 'figure');",
      "    if isempty(dsh_figs) && ~isempty(get(0, 'CurrentFigure'))",
      "        dsh_figs = get(0, 'CurrentFigure');",
      '    end',
      '    dsh_figs = flipud(dsh_figs(:));',
      '    dsh_produced = 0;',
      '    for dsh_i = 1:numel(dsh_figs)',
      '        dsh_f = dsh_figs(dsh_i);',
      "        if ~isvalid(dsh_f), continue; end",
      '        dsh_idx = dsh_produced + 1;',
      "        dsh_name = sprintf('figure%02d', dsh_idx);",
      '        dsh_saved = false;',
      '        try',
      "            set(dsh_f, 'PaperUnits', 'inches');",
      `            set(dsh_f, 'PaperPosition', [0 0 ${mnum(figures.width)} ${mnum(figures.height)}]);`,
      `            set(dsh_f, 'Position', [100 100 ${mnum(figures.width * figures.dpi)} ${mnum(figures.height * figures.dpi)}]);`,
      "            set(dsh_f, 'Color', 'w');",
      '        catch',
      '        end',
      '        for dsh_k = 1:numel(dsh_formats)',
      '            dsh_ext = dsh_formats{dsh_k};',
      "            dsh_file = fullfile(dsh_out, [dsh_name '.' dsh_ext]);",
      '            try',
      "                if strcmpi(dsh_ext, 'pdf') || strcmpi(dsh_ext, 'eps')",
      "                    exportgraphics(dsh_f, dsh_file, 'ContentType', 'vector', 'BackgroundColor', 'white');",
      "                elseif strcmpi(dsh_ext, 'png') || strcmpi(dsh_ext, 'jpg')",
      `                    exportgraphics(dsh_f, dsh_file, 'Resolution', ${mnum(figures.dpi)}, 'BackgroundColor', 'white');`,
      '                else',
      `                    print(dsh_f, ['-d' dsh_ext], ['-r' num2str(${mnum(figures.dpi)})], dsh_file);`,
      '                end',
      "                fprintf('DSH_FIGURE: %s\\n', dsh_file);",
      '                dsh_saved = true;',
      '                break;',
      '            catch',
      `                fprintf(2, 'DSH_WARN: export as %s unavailable for figure %d\\n', dsh_ext, dsh_idx);`,
      '            end',
      '        end',
      '        if dsh_saved',
      '            dsh_produced = dsh_produced + 1;',
      '        else',
      `            fprintf(2, 'DSH_WARN: figure %d could not be exported in any requested format\\n', dsh_idx);`,
      '        end',
      '    end',
      '    if dsh_produced == 0',
      "        fprintf('DSH_INFO: no MATLAB figure was open at the end of the run.\\n');",
      '    end',
      'catch dsh_ee',
      "    fprintf(2, 'DSH_WARN: figure export stage failed: %s\\n', dsh_ee.message);",
      'end',
    )
  }

  lines.push(
    '% ---- Completion marker --------------------------------------------------',
    `dsh_logf(${mstr(logDone)}, '1');`,
    'exit(0);',
    '',
    'function dsh_logf(dsh_path, dsh_text)',
    "    dsh_fid = fopen(dsh_path, 'w', 'n', 'UTF-8');",
    '    if dsh_fid >= 0',
    "        fwrite(dsh_fid, unicode2native(dsh_text, 'UTF-8'), 'uint8');",
    '        fclose(dsh_fid);',
    '    end',
    'end',
  )

  return lines.join('\n')
}

/** Indent every non-empty line of a block. */
function indent(text, levels) {
  const pad = '    '.repeat(levels)
  return text
    .split(/\r?\n/)
    .map(line => (line.trim() ? pad + line : line))
    .join('\n')
}

/**
 * Build the Simulink-specific body that the runner executes.
 * Kept separate so the runner template stays generic and testable.
 *
 * @param {object} options
 * @param {string} options.modelPath
 * @param {string} options.modelName
 * @param {number} [options.stopTime]
 * @param {Array<{block: string, parameter: string, value: string|number|boolean}>} options.parameters
 * @param {string[]} options.outputVariables
 * @param {string} options.signalsDir
 * @param {object} options.simOptions - raw Simulink.SimulationInput option map
 * @param {boolean} options.saveModel
 * @param {boolean} options.exportData
 * @param {number} options.precision
 * @returns {string} MATLAB source for the user block
 */
export function buildSimulinkBody(options) {
  const {
    modelPath, modelName, stopTime, parameters = [], outputVariables = [],
    signalsDir, simOptions = {}, saveModel = false, exportData = true, precision = 10,
  } = options

  const lines = [
    `dsh_model_file = ${mstr(mpath(modelPath))};`,
    `dsh_model = ${mstr(modelName)};`,
    `[dsh_mdir, ~, ~] = fileparts(dsh_model_file);`,
    'addpath(dsh_mdir);',
    'if bdIsLoaded(dsh_model), close_system(dsh_model, 0); end',
    "load_system(dsh_model_file);",
    "fprintf('DSH_INFO: loaded model %s\\n', dsh_model);",
  ]

  if (stopTime !== undefined && stopTime !== null) {
    lines.push(
      `set_param(dsh_model, 'StopTime', num2str(${mnum(stopTime)}, ${mnum(precision + 6)}));`,
      `fprintf('DSH_INFO: StopTime=%s\\n', num2str(${mnum(stopTime)}));`,
    )
  }

  if (parameters.length) {
    lines.push('% Block parameter overrides (set_param requires a char expression)')
    for (const parameter of parameters) {
      const blockName = String(parameter.block).split('/').pop()
      lines.push(
        `dsh_tgt = [dsh_model '/' ${mstr(parameter.block)}];`,
        `if isempty(find_system(dsh_model, 'SearchDepth', 1, 'Name', ${mstr(blockName)}))`,
        `    fprintf(2, 'DSH_WARN: block not found, override skipped: %s\\n', ${mstr(parameter.block)});`,
        'else',
        `    set_param(dsh_tgt, ${mstr(parameter.parameter)}, ${mexpr(parameter.value)});`,
        `    fprintf('DSH_INFO: override %s %s := %s\\n', ${mstr(parameter.block)}, ${mstr(parameter.parameter)}, ${mstr(String(parameter.value))});`,
        'end',
      )
    }
  }

  if (saveModel) {
    lines.push(
      "save_system(dsh_model, dsh_model_file);",
      "fprintf('DSH_INFO: model saved with overrides\\n');",
    )
  }

  const inputLines = Object.entries(simOptions)
  if (inputLines.length) {
    lines.push(
      '% Simulink.SimulationInput options',
      'dsh_sim_in = Simulink.SimulationInput(dsh_model);',
      `dsh_sim_in = setModelParameter(dsh_sim_in, 'StopTime', num2str(${mnum(stopTime ?? 10)}));`,
    )
    for (const [key, value] of inputLines) {
      lines.push(`dsh_sim_in = setModelParameter(dsh_sim_in, ${mstr(key)}, ${mparamValue(value)});`)
    }
    lines.push(
      "fprintf('DSH_INFO: running sim() with SimulationInput\\n');",
      'dsh_out_sim = sim(dsh_sim_in);',
    )
  } else {
    lines.push(
      "fprintf('DSH_INFO: running sim()\\n');",
      'dsh_out_sim = sim(dsh_model);',
    )
  }

  lines.push(
    "fprintf('DSH_INFO: simulation finished\\n');",
    '% Prove the run reached a usable output object',
    'dsh_names = who(dsh_out_sim);',
    "fprintf('DSH_INFO: logged variables: %s\\n', strjoin(dsh_names, ', '));",
  )

  if (outputVariables.length) {
    lines.push(
      `dsh_want = ${mcell(outputVariables)};`,
      'for dsh_k = 1:numel(dsh_want)',
      '    dsh_vn = dsh_want{dsh_k};',
      '    try',
      '        dsh_val = dsh_out_sim.get(dsh_vn);',
      `        fprintf('DSH_INFO: variable %s -> %s\\n', dsh_vn, class(dsh_val));`,
      '    catch',
      "        fprintf(2, 'DSH_WARN: variable not logged by model: %s\\n', dsh_vn);",
      '    end',
      'end',
    )
  }

  if (exportData) {
    const precisionLiteral = mnum(precision)
    lines.push(
      '% Export simulation data (CSV for humans/DSH, MAT for MATLAB round-trips)',
      `if exist(${mstr(mpath(signalsDir))}, 'dir') ~= 7, mkdir(${mstr(mpath(signalsDir))}); end`,
      'dsh_vars = who(dsh_out_sim);',
      'dsh_exported = 0;',
      'for dsh_k = 1:numel(dsh_vars)',
      '    dsh_vn = dsh_vars{dsh_k};',
      '    try',
      '        dsh_val = dsh_out_sim.get(dsh_vn);',
      '    catch',
      '        continue;',
      '    end',
      '    try',
      "        save(fullfile(dsh_out, [dsh_vn '.mat']), 'dsh_vn');",
      "        fprintf('DSH_INFO: wrote %s.mat\\n', dsh_vn);",
      '    catch dsh_me',
      "        fprintf(2, 'DSH_WARN: could not write %s.mat: %s\\n', dsh_vn, dsh_me.message);",
      '    end',
      '% Normalize the common logged-signal containers into (t, y) columns',
      '    dsh_t = []; dsh_y = [];',
      "    if isa(dsh_val, 'timeseries')",
      '        if ~isscalar(dsh_val)',
      '            dsh_t = dsh_val(1).Time; dsh_y = squeeze(dsh_val(1).Data);',
      '        else',
      '            dsh_t = dsh_val.Time; dsh_y = squeeze(dsh_val.Data);',
      '        end',
      "    elseif isstruct(dsh_val) && isfield(dsh_val, 'time') && isfield(dsh_val, 'signals')",
      '        dsh_t = dsh_val.time; dsh_y = squeeze(dsh_val.signals(1).values);',
      "    elseif isa(dsh_val, 'Simulink.SimulationData.Dataset')",
      '        try',
      '            dsh_el = dsh_val.getElement(1);',
      "            if isa(dsh_el.Values, 'timeseries')",
      '                dsh_t = dsh_el.Values.Time; dsh_y = squeeze(dsh_el.Values.Data);',
      '            end',
      '        catch',
      '        end',
      '    end',
      '    if isempty(dsh_t) || isempty(dsh_y)',
      '        continue;',
      '    end',
      '    try',
      '        dsh_t = dsh_t(:);',
      '        dsh_y = reshape(dsh_y, numel(dsh_t), []);',
      '        dsh_m = [dsh_t dsh_y];',
      '        if ~isreal(dsh_m), continue; end',
      `        dsh_csv = fullfile(${mstr(mpath(signalsDir))}, [dsh_vn '.csv']);`,
      "        dsh_fid = fopen(dsh_csv, 'w');",
      '        if dsh_fid < 0, continue; end',
      "        dsh_hdr = ['time' repmat(',y', 1, size(dsh_y, 2))];",
      "        fprintf(dsh_fid, '%s\\n', dsh_hdr);",
      `        fprintf(dsh_fid, ['%.${precisionLiteral}f' repmat(',%.${precisionLiteral}f', 1, size(dsh_m, 2) - 1) '\\n'], dsh_m');`,
      '        fclose(dsh_fid);',
      "        fprintf('DSH_SIGNAL: %s (%d samples x %d channel(s))\\n', dsh_csv, size(dsh_m, 1), size(dsh_m, 2) - 1);",
      '        dsh_exported = dsh_exported + 1;',
      '    catch dsh_se',
      "        fprintf(2, 'DSH_WARN: signal export failed for %s: %s\\n', dsh_vn, dsh_se.message);",
      '    end',
      'end',
      `fprintf('DSH_INFO: exported %d signal table(s)\\n', dsh_exported);`,
    )
  }

  lines.push('close_system(dsh_model, 0);')

  return lines.join('\n')
}

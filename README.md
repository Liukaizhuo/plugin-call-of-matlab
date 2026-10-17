# dsh-matlab-simulink

**Drive a locally installed MATLAB / Simulink from DeepSeek Harness — run scripts, simulate models, and get publication-quality figures back in the conversation.**

[![CI](https://github.com/Liukaizhuo/plugin-call-of-matlab/actions/workflows/ci.yml/badge.svg)](https://github.com/Liukaizhuo/plugin-call-of-matlab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#requirements)

[中文文档](README.zh-CN.md)

---

## What it does

A DSH plugin (Cordis bundle) that gives an agent five tools for real MATLAB
work: executing `.m` files, running ad-hoc MATLAB code, simulating Simulink
models with parameter overrides, and exporting figures to journal
specifications. Figures are published as image attachments, so they render
inline in the chat instead of only existing as files on disk.

It is **zero-dependency** at runtime: plain ESM, no bundler, no build step, and
it loads directly from a directory path.

| Tool | Purpose |
| --- | --- |
| `matlab_status` | Report the resolved MATLAB installation, how it was found, and optionally verify it launches and list installed toolboxes. |
| `matlab_run_script` | Run an existing `.m` script headlessly and collect the figures and data files it produces. |
| `matlab_run_code` | Run MATLAB code with no file on disk; any figure left open at the end is exported with academic styling. |
| `simulink_run_model` | Load a `.slx`/`.mdl`, override `StopTime` and block parameters, simulate, and export logged signals as MAT + CSV. |
| `matlab_export_figure` | Re-render an existing figure at a new size, DPI, font, or format. |

---

## Requirements

| | |
| --- | --- |
| OS | Windows 10/11 (process control and discovery use `taskkill`, `where.exe`, and the registry) |
| MATLAB | R2023a or newer — uses `-batch` and `exportgraphics`. Verified on R2024a. |
| Simulink | Only needed for `simulink_run_model`; without it the tool reports a clear message. |
| Node.js | `^22.19 \|\| >=24` |
| DSH | Developer preview v0.1 or newer |

MATLAB does **not** need to be on `PATH`: discovery also checks `MATLAB_ROOT` /
`MATLABROOT`, the Windows registry, and the default install roots.

---

## Install

Three ways in, all ending with the plugin in your DSH profile's `node_modules`
and one entry in the profile's `cordis.patch.yml`.

### Option A — from a GitHub Release (no npm needed)

1. Download `dsh-matlab-simulink-<version>.tgz` from
   [Releases](https://github.com/Liukaizhuo/plugin-call-of-matlab/releases).
   Each release carries two assets: the npm tarball, and a
   `-source.zip` of the repository at that tag.
2. Extract the plugin into your DSH profile's `node_modules`:

   ```powershell
   $profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
   $tmp = "$env:TEMP\dsh-matlab-simulink"
   New-Item -ItemType Directory -Force $tmp | Out-Null
   tar -xzf .\dsh-matlab-simulink-1.0.0.tgz -C $tmp
   Copy-Item "$tmp\package" "$profileDir\node_modules\dsh-matlab-simulink" -Recurse -Force
   ```

3. Register the plugin (see [Register the plugin](#register-the-plugin)) and
   restart DSH.

Release artifacts are build output and are deliberately **not committed to the
repository**: the [release workflow](.github/workflows/release.yml) builds them
from the tag and attaches them to the Release.

### Option B — from a cloned repository

```powershell
git clone https://github.com/Liukaizhuo/plugin-call-of-matlab.git
cd plugin-call-of-matlab
node tools\sync-to-profile.mjs
```

`sync-to-profile.mjs` copies the plugin into the profile, verifies every
required file arrived, writes the `cordis.patch.yml` entry, and then imports the
installed module to prove it loads. Use `--profile <dir>` for a different profile
and `--check` to only report status. Restart DSH afterwards.

### Option C — from npm

```powershell
npm install dsh-matlab-simulink
```

### Register the plugin

Add this to your profile's `cordis.patch.yml` (Option B does it for you):

```yaml
- insert:
    - id: dsh-matlab-simulink
      name: "dsh-matlab-simulink"
      config:
        matlabRoots: []      # empty = auto-discovery
        timeoutMs: 600000
        maxConcurrent: 1
        streamOutput: true
```

Then **restart DSH** and check with `matlab_status(verify_launch: true)`.

A fuller walkthrough — including the npm-copy variant, verification output, and
install troubleshooting — is in [docs/INSTALL.md](docs/INSTALL.md).

### Verify the install

Ask the agent to run `matlab_status`, or from the repository:

```powershell
node tools\sync-to-profile.mjs --check
```

---

## Usage

Once DSH is restarted, just describe the work and the agent picks the tool.
Direct examples:

```jsonc
// Frequency-response plot, exported as vector PDF
{ "action": "call", "tool": "matlab_run_code", "args": {
  "code": "s = tf('s'); G = 25/(s^2+4*s+25); bode(G, {0.5, 50}); grid on;",
  "output_dir": "D:\\results", "export_format": "pdf", "dpi": 300 } }

// Run an existing analysis script
{ "action": "call", "tool": "matlab_run_script", "args": {
  "script_path": "D:\\work\\analysis.m", "output_dir": "D:\\results" } }

// Simulate a model with a parameter override, then plot the logged signal
{ "action": "call", "tool": "simulink_run_model", "args": {
  "model_path": "D:\\models\\plant.slx",
  "stop_time": 10,
  "parameters": [{ "block": "Gain", "parameter": "Gain", "value": 7.5 }],
  "output_variables": ["yout"],
  "post_process": "plot(dsh_out_sim.get('yout')); grid on;",
  "output_dir": "D:\\results" } }

// Re-render a figure for a journal
{ "action": "call", "tool": "matlab_export_figure", "args": {
  "source_path": "D:\\results\\figure01.png",
  "target_format": "pdf", "dpi": 600,
  "figure_width": 3.5, "figure_height": 2.8 } }
```

### Figure output

Figures default to **300 DPI, Times New Roman, 6×4 in, vector PDF** — the
combination most journals ask for. `export_format: "png"` switches to raster and
makes the figure render inline in the conversation. If a requested vector format
is unavailable, the plugin falls back to PNG rather than returning nothing.

Simulink runs additionally write, per logged signal:

- `<output_dir>/<signal>.mat` — the raw value, loadable in MATLAB
- `<output_dir>/signals/<signal>.csv` — `time,y1,y2,...` for inspection

---

## Configuration

Set these under the `config:` key of the `cordis.patch.yml` entry.
Unknown keys fail the plugin load rather than being silently ignored.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Load the plugin but register no tools. |
| `matlabRoots` | `[]` | Explicit install roots (the directory containing `bin\matlab.exe`). Empty = auto-discovery. |
| `timeoutMs` | `600000` | Default wall-clock timeout per call. |
| `maxTimeoutMs` | `3600000` | Ceiling a call may request via `timeout_s`. |
| `maxConcurrent` | `1` | Concurrent MATLAB sessions. MATLAB sessions are heavyweight, so serialised by default. |
| `tempDir` | OS temp | Where per-run staging/working directories are created. |
| `maxArtifactBytes` | `26214400` | Artifacts above this are reported as paths only. |
| `maxInlineImageBytes` | `6291456` | Rasters above this are not published as attachments. |
| `streamOutput` | `true` | Forward MATLAB stdout while a run is in progress. |
| `refreshDiscovery` | `false` | Ignore the cached installation and re-run discovery. |

### Discovery order

The first candidate whose `bin\matlab.exe` actually exists wins:

1. `matlabRoots` from config
2. `MATLAB_ROOT`, then `MATLABROOT` environment variable
3. `where matlab.exe`
4. Registry `HKLM\SOFTWARE\MathWorks\MATLAB` (`InstallPath` / `MATLABROOT`)
5. Newest release under `C:\Program Files\MATLAB`

---

## Testing

```powershell
npm test              # full suite; starts real MATLAB, ~5-8 minutes
npm run test:offline  # plugin contract only; no MATLAB needed
npm run test:strict   # fail instead of skipping when MATLAB is absent
npm run pack:check    # assert exactly what npm publish would upload
```

`test/harness.mjs` drives the real plugin through a minimal fake Cordis context
and a real MATLAB installation. Coverage: tool registration and schemas,
installation discovery, inline code, script execution, Simulink model build and
simulation, block-parameter overrides, MAT/CSV export, figure re-render,
non-ASCII paths, runtime errors, syntax errors, the `exit()` guard, missing
files, cancellation, timeout, and inline-render candidates.

Every tool call is also validated as **lossless JSON** — the same check the DSH
registry performs at dispatch time, where `undefined` object properties are
rejected. Catching it in the harness surfaces that class of bug before a live
session does.

Latest result: **62/62 checks passed**, run against both the source tree and the
installed profile copy.

---

## How it works

```
lib/index.js              Cordis entry: name / config validation / apply
lib/matlab-discovery.js   MATLAB installation discovery with caching
lib/matlab-script.js      MATLAB source generation (escaping, runner, Simulink body)
lib/matlab-staging.js     Script staging and path remapping for non-ASCII paths
lib/matlab-core.js        Process control, artifact collection, cancellation, image publishing
lib/tools.js              The five tool definitions, schemas, and result rendering
```

### Behaviour that constrains the implementation

These are not assumptions; each was measured on MATLAB R2024a on Windows, and
each is handled in the code. They are also why a naive implementation of this
plugin does not work.

1. **MATLAB refuses to execute a script reached through a non-ASCII path or
   filename**, reporting "invalid text character" regardless of the file's
   contents. User scripts are therefore staged into the run directory under a
   pure-ASCII name before execution. `cd()` into a non-ASCII directory works
   fine on its own.
2. **`run()` temporarily changes the working directory to the script's own
   folder.** Calling `run(stagedPath)` sent a user script's relative
   `save`/`load` into the plugin's staging directory, which is deleted with the
   run. Staged scripts are now invoked by name with the staging directory only
   added to the path, so the working directory stays the script's own folder.
3. **Simulink's `set_param` rejects numeric literals** — even `StopTime` must be
   a char expression, otherwise it reports an invalid setting for the block.
   Every value passed to `set_param` is quoted; `Simulink.SimulationInput`
   accepts both forms.
4. **A script filename whose stem starts with `_` cannot be parsed by MATLAB**,
   so generated script names never begin with an underscore.
5. **The child `close` event lags far behind the actual exit**, because MATLAB's
   helper processes inherit the stdio pipes. Killing with a signal and awaiting
   `close` delayed cancellation and timeout by one to two minutes. Termination
   now runs a synchronous `taskkill /F /T` before releasing the pipes, so
   cancellation and timeout converge in about a second.
6. **A MATLAB session takes 8–12 seconds to start**, so `matlab_status` does not
   start MATLAB unless `verify_launch: true` is passed.
7. The plugin launches MATLAB with `-batch` (headless). Figures reach disk via
   `exportgraphics` (vector) or `print` (raster), then are published as
   attachments.

### Behaviour when MATLAB is missing

The five tools are registered even when no MATLAB installation is found. That is
deliberate: an agent that sees *no* tools cannot discover why the plugin is
inactive, whereas a call to any tool returns an actionable reason and
`matlab_status` reports what was tried and how to fix it. The plugin log carries
the same warning at load time.

An explicitly configured `matlabRoots` that contains no `bin\matlab.exe` is
treated differently — that is a misconfiguration and fails the plugin load.

---

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture, how to add a tool,
and how to run the suite against your own MATLAB. The short loop:

```powershell
# edit lib/ ...
npm run test:offline
node tools\sync-to-profile.mjs   # copy, verify, register
# restart DSH
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `MATLAB: NOT FOUND` | The tools are registered but every run fails. Set `MATLAB_ROOT`, put `matlab.exe` on `PATH`, or set `config.matlabRoots`; `matlab_status` lists what was tried. |
| `value is not lossless JSON` at dispatch | The running DSH has an older plugin build in memory. Restart DSH, and re-run `node tools\sync-to-profile.mjs`. |
| Tools never appear at all | Confirm the `cordis.patch.yml` entry exists (`--check` reports it) and that DSH was restarted. DSH only hot-reloads when `hmr.root` is configured. |
| `git push` fails with a TLS / revocation error | A second git on `PATH` is being used. Use the one in `C:\Program Files\Git\cmd` (PowerShell picks it up); see [docs/INSTALL.md](docs/INSTALL.md). |
| A run hangs, then times out | Expected for long simulations; raise `timeoutMs` or pass a larger `timeout_s`. Expiry force-kills the MATLAB process tree. |
| Figure is a `.pdf` but nothing renders inline | By design: PDF is vector and not inlined. Use `export_format: "png"` when you want it visible in the chat. |
| Relative paths in my script write to the wrong folder | The script's own directory is the working directory. Pass `working_dir` to override it. |

---

## License

[MIT](LICENSE)

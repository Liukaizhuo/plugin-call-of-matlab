# Changelog

All notable changes to this project are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0]

First public release.

### Added

- Cordis/DSH plugin bundle exposing five tools to a DeepSeek Harness agent:
  - `matlab_status` — resolve and verify the MATLAB installation, optionally
    listing installed toolboxes.
  - `matlab_run_script` — run an existing `.m` script headlessly and collect the
    figures and data files it produces.
  - `matlab_run_code` — run MATLAB code with no file on disk, exporting any
    figure left open at the end.
  - `simulink_run_model` — load a `.slx`/`.mdl`, override `StopTime` and block
    parameters, simulate, and export logged signals as MAT plus CSV.
  - `matlab_export_figure` — re-render an existing figure at a new size, DPI,
    font, or format.
- MATLAB discovery across `matlabRoots`, `MATLAB_ROOT`/`MATLABROOT`, `PATH`,
  the Windows registry, and default install roots, with the result cached.
- Academic figure defaults: 300 DPI, Times New Roman, vector PDF output, with a
  raster fallback chain when a format is unavailable.
- Bounded concurrency (one MATLAB session by default), per-call timeouts, and
  abort-signal handling that force-kills the MATLAB process tree.
- Raster artifacts published as durable DSH image attachments so figures render
  inline in the conversation, with plain paths as the fallback.
- `tools/sync-to-profile.mjs` to install, verify, and register the plugin in a
  DSH profile.
- `test/harness.mjs`: an end-to-end harness driving real MATLAB through a fake
  Cordis context, with an `--offline` mode for CI hosts without MATLAB and a
  lossless-JSON contract check on every tool result.
- `tools/pack-check.mjs`: pre-publish assertion of the exact tarball contents
  plus a smoke import of the packed entry module.

### Fixed

Behaviour discovered while testing against MATLAB R2024a on Windows, each fixed
in this release:

- MATLAB's parser refuses to execute a script reached through a non-ASCII path
  or filename, independent of the file's contents. User scripts are now staged
  under an ASCII name before execution.
- `run()` temporarily changes the working directory to the script's own folder,
  which sent a user script's relative `save`/`load` into the plugin's temporary
  directory and then deleted it. Staged scripts are now invoked by name with the
  staging directory merely added to the path, so the working directory stays the
  script's own folder.
- Simulink's `set_param` rejects numeric literals, including for `StopTime`, and
  requires a char expression. All values handed to `set_param` are now quoted.
- A script filename whose stem begins with `_` cannot be parsed by MATLAB, so
  generated script names never start with an underscore.
- The child process `close` event lagged far behind the actual exit because
  MATLAB's helper processes inherited the stdio pipes, delaying cancellation and
  timeout by one to two minutes. Termination now uses a synchronous
  `taskkill /F /T` before releasing the pipes, converging in about a second.
- Tool results carrying `undefined` properties failed the registry's
  lossless-JSON check at dispatch time. Results are now normalized before they
  leave a tool, and the harness asserts the contract on every call.

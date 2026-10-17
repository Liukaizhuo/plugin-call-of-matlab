# Contributing

Thanks for considering a contribution. This document covers the architecture, the
development loop, and the conventions the test suite enforces.

## Getting set up

```powershell
git clone https://github.com/Liukaizhuo/plugin-call-of-matlab.git
cd plugin-call-of-matlab
node --version          # must be ^22.19 || >=24
npm run test:offline    # plugin contract only, no MATLAB required
```

There is no build step and no dependency install: the plugin is plain ESM with
zero runtime dependencies. `lib/` is both the source and the published artifact.

To run the full suite you need MATLAB R2023a or newer installed locally:

```powershell
npm test
```

If MATLAB is not on `PATH`, point the harness at it:

```powershell
$env:MATLAB_ROOT = "E:\Program Files\MATLAB\R2024a"
npm test
```

## Architecture

| File | Responsibility |
| --- | --- |
| `lib/index.js` | Cordis entry. Validates configuration, resolves MATLAB, registers tools under the `tools` service dependency. |
| `lib/matlab-discovery.js` | Finds `bin\matlab.exe` across config, environment, `PATH`, the registry, and default roots. Caches the result. |
| `lib/matlab-script.js` | Generates MATLAB source: escaping helpers, the runner template, and the Simulink body. |
| `lib/matlab-staging.js` | Stages user input under an ASCII name and remaps paths in captured output. |
| `lib/matlab-core.js` | Spawns MATLAB, captures output, collects artifacts, handles cancellation and timeout, gates concurrency, publishes images. |
| `lib/tools.js` | The five tool definitions: schemas, descriptions, execution, and result rendering. |

The split exists because the MATLAB-side concerns (what source to generate, what
the process does) are testable in isolation from the DSH-side concerns (what a
tool declares and returns).

### Data flow of one run

1. A tool validates its arguments and resolves the working and output
   directories.
2. `matlab-core.runMatlabJob` creates a per-run directory, stages any user input
   under an ASCII name, and generates a driver script via `matlab-script`.
3. MATLAB is spawned with `-batch <driver> -sd <runDir>`. Non-ASCII working and
   output paths are passed through the environment, which round-trips UTF-8.
4. The driver runs the user's code inside `try/catch`, then exports every open
   figure, then writes a completion marker.
5. Node collects artifacts from the output directory and the working directory,
   classifies them, publishes rasters as attachments, and returns a structured
   result.
6. `tools.js` renders that result into content blocks.

## Adding a tool

1. Define it in `lib/tools.js` with `defineJobTool({ name, description, parameters, execute })`.
   - `description` must be long enough to tell a model when to use it (the
     harness asserts a minimum length).
   - `parameters` is JSON Schema, `additionalProperties: false`, with a
     `description` on every property.
   - `execute` receives `(args, exec)` where `exec.signal` is the abort signal.
2. For anything that runs MATLAB, call `executeJob(ctx, config, gate, args, exec, job)`
   with either `{ code }` or `{ sourceFile }`. It handles MATLAB resolution,
   timeouts, concurrency, and rendering.
3. Add the tool name to `REQUIRED_TOOLS` in `test/harness.mjs` and add a scenario.
4. Document it in `README.md` and `README.zh-CN.md`, and add a `tools` entry to
   `dsh-plugin.json`.

## Non-negotiable behaviours

These came from real failures on Windows + MATLAB R2024a. Please keep them intact;
each has a comment in the code explaining why.

- **Never `cd` into, or `run()` from, the staging directory.** `run()` moves the
  working directory to the script's folder, which sends the user's relative
  `save`/`load` into a directory that is deleted with the run. Stage the script,
  `addpath` the staging directory, and invoke by name.
- **Never hand `set_param` a numeric literal.** Simulink rejects numbers even for
  `StopTime`; always pass a quoted char expression.
- **Never generate a script name whose stem starts with `_`.** MATLAB's parser
  rejects such files outright.
- **Never export figures with `exportgraphics(..., 'Resolution', dpi)`.** It
  scales the figure's on-screen pixel size by `dpi / screenDpi`, so the requested
  `figure_width`/`figure_height` and `dpi` are ignored and the page comes out at
  an arbitrary size (a 7×5 in request produced 17.2×9.7 in). Use `print -r<dpi>`
  after pinning `PaperSize`, `PaperPosition` and `PaperPositionMode = 'manual'`
  in inches, which reproduces the request exactly.
- **Never declare an output-schema field with a type the result does not use.**
  The registry validates `output.schema` at dispatch time and rejects the whole
  call on a mismatch. `matlab` is a display string on run results; the structured
  installation is `installation`.
- **Always kill the process tree with `taskkill /F /T` before releasing pipes.**
  MATLAB's helper processes inherit the stdio pipes, so awaiting `close` alone
  delays cancellation by minutes.
- **Always return lossless JSON from `execute`.** The DSH registry rejects
  results containing `undefined` object properties at dispatch time. Route
  results through `toLosslessJson` and let the harness check it.
- **Never let a tool result exceed the artifact budgets** without marking it
  oversized; publishing a huge attachment is worse than reporting a path.

## Testing conventions

- `npm run test:offline` must pass on a machine with no MATLAB. It validates tool
  registration, schemas, argument validation, and the lossless-JSON contract.
- `npm test` runs the real scenarios and needs MATLAB.
- Add a check for every behaviour you fix — the harness is the regression suite.
- The harness keeps `.test-sandbox/` for inspection when something fails and
  removes it on success. Add the directory to `.gitignore` (already done).
- Prefer asserting on structured result fields over scraping console text, but
  assert on console markers for MATLAB-side behaviour, since that is what proves
  the generated script actually did the right thing.

## Style

- Plain JavaScript ESM, no TypeScript source, no dependencies. Types for the
  public surface live in `types/index.d.ts` and are hand-written.
- Comments explain *why*, especially where the code works around MATLAB
  behaviour. Do not narrate *what* the next line does.
- Keep functions small and name things after the domain (`staging`, `artifacts`,
  `transcript`, `failureKind`) rather than after the implementation.
- Error messages must be actionable: say what was expected, what was found, and
  what to do about it.

## Packaging

```powershell
npm run pack:check                  # assert exactly what npm publish would upload
node tools/pack-check.mjs --build   # also write dist/*.tgz and smoke-import it
node tools/make-source-zip.mjs      # write dist/*-source.zip and verify its entries
npm run release:build               # both of the above
```

`pack:check` fails on a missing required file, on any development file leaking
into the tarball, on the `OWNER` placeholder, and on an entry module that does not
import from the packed output. Run it before opening a release PR.

`dist/` is **build output and is git-ignored**. Never commit a tarball or archive:

- the npm tarball belongs on the npm registry (`npm publish`) or as a Release asset;
- the source zip belongs as a Release asset.

Both are produced from a tag by `.github/workflows/release.yml`, so a download is
always traceable to a commit. Committing them would also make the source zip
depend on its own previous revision.

## Releasing

1. Update `CHANGELOG.md`: move `[Unreleased]` entries under the new version.
2. Bump `version` in `package.json`.
3. Run `npm run test:offline && npm run pack:check`.
4. Commit, then tag `v<version>` and push the tag:

   ```powershell
   git tag -a v1.1.0 -m "dsh-matlab-simulink v1.1.0"
   git push origin main v1.1.0
   ```

   The `release.yml` workflow verifies the tag matches `package.json`, builds the
   tarball and the source zip, attaches both to a GitHub Release, and creates the
   release notes. It publishes to npm only when an `NPM_TOKEN` secret exists.

## Reporting bugs

Include the MATLAB release, the output of `matlab_status(verify_launch: true)`,
and the failing tool arguments. If the failure is about paths, state whether they
contain non-ASCII characters — that is a common and specific source of trouble
here.

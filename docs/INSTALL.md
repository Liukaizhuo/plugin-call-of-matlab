# Installing dsh-matlab-simulink

`dsh-matlab-simulink` lets a DeepSeek Harness agent drive a locally installed
MATLAB/Simulink. You need **MATLAB R2023a or newer on Windows**.

There are three ways to install it. All of them end with the same two steps:
the plugin files must sit in your DSH profile's `node_modules`, and the profile's
`cordis.patch.yml` must register it.

---

## 1. From a GitHub Release (no npm needed)

Download `dsh-matlab-simulink-<version>.tgz` from the
[Releases](https://github.com/Liukaizhuo/plugin-call-of-matlab/releases) page —
that asset is exactly what `npm publish` would upload, so no npm client is
required to use it.

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
$tmp = "$env:TEMP\dsh-matlab-simulink"
New-Item -ItemType Directory -Force $tmp | Out-Null
tar -xzf .\dsh-matlab-simulink-1.0.0.tgz -C $tmp
Copy-Item "$tmp\package" "$profileDir\node_modules\dsh-matlab-simulink" -Recurse -Force
```

Then register it (see [Register the plugin](#register-the-plugin)) and restart DSH.

A `-source.zip` asset is attached to the same release if you would rather read
the source without cloning.

## 2. From npm

```powershell
npm install dsh-matlab-simulink
```

npm places the package in the nearest `node_modules`. If that is not your DSH
profile, copy it there:

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item ".\node_modules\dsh-matlab-simulink" "$profileDir\node_modules\" -Recurse -Force
```

## 3. From a clone

```powershell
git clone https://github.com/Liukaizhuo/plugin-call-of-matlab.git
cd plugin-call-of-matlab
node tools\sync-to-profile.mjs
```

`sync-to-profile.mjs` does the whole job: it copies the plugin into the profile,
verifies every required file arrived, writes the `cordis.patch.yml` entry if it is
missing, and then imports the installed module to prove it loads.

```powershell
node tools\sync-to-profile.mjs --profile "D:\other-profile"   # different profile
node tools\sync-to-profile.mjs --check                        # report status only
```

This is also the update path: after `git pull`, re-run it.

---

## Register the plugin

The plugin needs one entry in your profile's `cordis.patch.yml`. `Option 3`
writes it for you; for the other options, add it by hand (or append the contents
of the bundled `cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-matlab-simulink
      name: "dsh-matlab-simulink"
      config:
        # Empty means auto-discovery; pin a release with e.g.
        # matlabRoots: ["E:\\Program Files\\MATLAB\\R2024a"]
        matlabRoots: []
        timeoutMs: 600000
        maxConcurrent: 1
        streamOutput: true
```

The `name` is resolved from the profile's own `node_modules`, so the plugin keeps
working if you move the source tree.

## Restart DSH

DSH only hot-reloads when `hmr.root` is configured, which it is not by default,
so **the plugin activates on the next start**. Then verify:

```
matlab_status(verify_launch: true)
```

A healthy result reports the resolved installation, the discovery path, and the
MATLAB version. `matlab_status(toolboxes: true)` additionally lists installed
toolboxes.

---

## Troubleshooting the install

| Symptom | Cause and fix |
| --- | --- |
| Tools never appear | No `cordis.patch.yml` entry, or DSH was not restarted. `node tools\sync-to-profile.mjs --check` reports both. |
| Tools appear but every call says MATLAB is missing | The plugin registers its tools even without MATLAB so the problem is discoverable. Run `matlab_status` for the reason and set `MATLAB_ROOT`, put `matlab.exe` on `PATH`, or set `config.matlabRoots`. |
| `value is not lossless JSON` at dispatch | The running DSH has an older build in memory. Restart DSH and re-run the sync. |
| `profile directory not found` | Pass `--profile <dir>` pointing at the profile that contains `cordis.patch.yml`. |
| Install copy is incomplete | Re-run the sync; it verifies every required file before declaring success. If DSH is holding files open, close it and retry. |
| `git push` fails with `CRYPT_E_NO_REVOCATION_CHECK` or `unable to get local issuer certificate` | A second git on `PATH` (for example an MSYS2/UCRT64 build) is being used, and it cannot validate GitHub's certificate chain on this network. Use the Git for Windows one at `C:\Program Files\Git\cmd\git.exe`; PowerShell and `cmd` resolve it by default, Git Bash may not. |

## Uninstall

Delete the `dsh-matlab-simulink` `insert` entry from `cordis.patch.yml` and
remove `<profile>\node_modules\dsh-matlab-simulink`, then restart DSH.

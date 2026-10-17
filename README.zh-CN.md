# dsh-matlab-simulink

**让 DeepSeek Harness 直接驱动本机安装的 MATLAB / Simulink —— 跑脚本、做仿真，并把符合学术标准的图直接渲染回对话里。**

[![CI](https://github.com/Liukaizhuo/plugin-call-of-matlab/actions/workflows/ci.yml/badge.svg)](https://github.com/Liukaizhuo/plugin-call-of-matlab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#环境要求)

[English](README.md)

---

## 功能

一个 DSH 插件（Cordis bundle），为 agent 提供 5 个真正干活的 MATLAB 工具：
执行 `.m` 文件、运行临时 MATLAB 代码、带参数覆盖地仿真 Simulink 模型、
按期刊要求导出图形。图形会作为图片附件发布，因此能**直接渲染在对话中**，
而不只是留在磁盘上。

**零运行时依赖**：纯 ESM，无需打包器、无构建步骤，可直接按目录路径加载。

| 工具 | 用途 |
| --- | --- |
| `matlab_status` | 报告解析到的 MATLAB 安装位置与发现途径；可选启动验证并列出已安装工具箱。 |
| `matlab_run_script` | 无界面运行已有的 `.m` 脚本，收集其产生的图与数据文件。 |
| `matlab_run_code` | 直接运行 MATLAB 代码，无需落盘；结束时仍打开的图形会自动按学术样式导出。 |
| `simulink_run_model` | 加载 `.slx`/`.mdl`，覆盖 `StopTime` 与模块参数，仿真并把记录信号导出为 MAT + CSV。 |
| `matlab_export_figure` | 把已有图形按新的尺寸 / DPI / 字体 / 格式重新导出，用于满足期刊要求。 |

---

## 环境要求

| | |
| --- | --- |
| 操作系统 | Windows 10/11（进程控制与发现依赖 `taskkill`、`where.exe` 与注册表） |
| MATLAB | R2023a 或更高 —— 依赖 `-batch` 与 `exportgraphics`。已在 R2024a 实测。 |
| Simulink | 仅 `simulink_run_model` 需要；未安装时该工具会给出明确提示。 |
| Node.js | `^22.19 \|\| >=24` |
| DSH | 开发者预览版 v0.1 或更高 |

MATLAB **不需要**加入 `PATH`：插件还会检查 `MATLAB_ROOT` / `MATLABROOT` 环境变量、
Windows 注册表，以及默认安装目录。

---

## 安装

### 方式 A —— 从 GitHub Release 安装（不需要 npm）

1. 从 [Releases](https://github.com/Liukaizhuo/plugin-call-of-matlab/releases)
   下载 `dsh-matlab-simulink-<版本>.tgz`。
2. 解压到 DSH profile 的 `node_modules`：

   ```powershell
   $profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
   $tmp = "$env:TEMP\dsh-matlab-simulink"
   New-Item -ItemType Directory -Force $tmp | Out-Null
   tar -xzf .\dsh-matlab-simulink-1.0.0.tgz -C $tmp
   Copy-Item "$tmp\package" "$profileDir\node_modules\dsh-matlab-simulink" -Recurse -Force
   ```

3. 在 `$profileDir\cordis.patch.yml` 里登记插件：

   ```yaml
   - insert:
       - id: dsh-matlab-simulink
         name: "dsh-matlab-simulink"
         config:
           matlabRoots: []
           timeoutMs: 600000
           maxConcurrent: 1
           streamOutput: true
   ```

4. 重启 DSH。

### 方式 B —— 从克隆的仓库安装

```powershell
git clone https://github.com/Liukaizhuo/plugin-call-of-matlab.git
cd plugin-call-of-matlab
node tools\sync-to-profile.mjs
```

`sync-to-profile.mjs` 会：复制到 profile → 校验必需文件齐全 →
写入 `cordis.patch.yml` 条目 → 实际 `import` 一次证明可加载。
用 `--profile <dir>` 指定其它 profile，`--check` 只报告状态。之后重启 DSH。

### 方式 C —— 从 npm 安装

```powershell
npm install dsh-matlab-simulink
```

然后按上面同样方式添加 `cordis.patch.yml` 条目。

### 验证安装

让 agent 调用 `matlab_status`，或在仓库目录执行：

```powershell
node tools\sync-to-profile.mjs --check
```

---

## 使用

重启 DSH 后，直接用自然语言描述任务，agent 会自行选择工具。也可直接调用：

```jsonc
// 频响图，导出为矢量 PDF
{ "action": "call", "tool": "matlab_run_code", "args": {
  "code": "s = tf('s'); G = 25/(s^2+4*s+25); bode(G, {0.5, 50}); grid on;",
  "output_dir": "D:\\results", "export_format": "pdf", "dpi": 300 } }

// 运行已有分析脚本
{ "action": "call", "tool": "matlab_run_script", "args": {
  "script_path": "D:\\work\\analysis.m", "output_dir": "D:\\results" } }

// 覆盖参数仿真模型，并画出记录信号
{ "action": "call", "tool": "simulink_run_model", "args": {
  "model_path": "D:\\models\\plant.slx",
  "stop_time": 10,
  "parameters": [{ "block": "Gain", "parameter": "Gain", "value": 7.5 }],
  "output_variables": ["yout"],
  "post_process": "plot(dsh_out_sim.get('yout')); grid on;",
  "output_dir": "D:\\results" } }

// 为投稿重新导出图形
{ "action": "call", "tool": "matlab_export_figure", "args": {
  "source_path": "D:\\results\\figure01.png",
  "target_format": "pdf", "dpi": 600,
  "figure_width": 3.5, "figure_height": 2.8 } }
```

### 图形输出

默认 **300 DPI、Times New Roman、6×4 英寸、矢量 PDF** —— 多数期刊要求的组合。
`export_format: "png"` 改为位图，图形会直接渲染在对话里。
若请求的矢量格式不可用，插件会回退到 PNG，而不是什么都不返回。

Simulink 仿真还会按记录信号额外写出：

- `<output_dir>/<信号名>.mat` —— 原始数据，可在 MATLAB 中加载
- `<output_dir>/signals/<信号名>.csv` —— `time,y1,y2,...`，便于查看

---

## 配置

在 `cordis.patch.yml` 条目的 `config:` 下设置。**未知键会导致插件加载失败**，
而不是被静默忽略。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 则加载插件但不注册任何工具。 |
| `matlabRoots` | `[]` | 显式指定安装根目录（含 `bin\matlab.exe` 的目录）；留空则自动发现。 |
| `timeoutMs` | `600000` | 单次调用默认墙钟超时；超时会强制结束 MATLAB 进程树。 |
| `maxTimeoutMs` | `3600000` | 单次调用可通过 `timeout_s` 申请的上限。 |
| `maxConcurrent` | `1` | 并行 MATLAB 会话数。MATLAB 会话很重，默认串行。 |
| `tempDir` | 系统临时目录 | 每次运行的暂存/工作目录位置。 |
| `maxArtifactBytes` | `26214400` | 单个产物超过此大小则只报路径、不做内联处理。 |
| `maxInlineImageBytes` | `6291456` | 单张图超过此大小则不作为图片附件发布。 |
| `streamOutput` | `true` | 运行期间实时转发 MATLAB 标准输出。 |
| `refreshDiscovery` | `false` | 忽略缓存的安装位置，重新发现。 |

### 发现顺序

取第一个真正存在 `bin\matlab.exe` 的候选：

1. 配置里的 `matlabRoots`
2. 环境变量 `MATLAB_ROOT`，其次 `MATLABROOT`
3. `where matlab.exe`
4. 注册表 `HKLM\SOFTWARE\MathWorks\MATLAB`（`InstallPath` / `MATLABROOT`）
5. `C:\Program Files\MATLAB` 下最新版本

---

## 测试

```powershell
npm test              # 完整套件；会真实启动 MATLAB，约 5-8 分钟
npm run test:offline  # 只测插件契约，不需要 MATLAB
npm run test:strict   # MATLAB 缺失时报失败而非跳过
npm run pack:check    # 断言 npm publish 究竟会上传哪些文件
```

`test/harness.mjs` 用最小假的 Cordis 上下文驱动真实插件与真实 MATLAB，覆盖：
工具注册与 Schema、安装发现、内联代码、脚本运行、Simulink 建模仿真、
模块参数覆盖、MAT/CSV 导出、图形重导出、非 ASCII 路径、运行期错误、语法错误、
`exit()` 防护、缺失文件、取消、超时、内联图渲染候选。

每次调用都会校验返回值是否为**无损 JSON** —— 这正是 DSH 注册表在真实派发时
才会做的检查（`undefined` 属性会被拒绝），放在测试里可以提前暴露该类缺陷。

最近一次完整结果：**62/62 通过**（源目录与已安装副本各跑一遍）。

---

## 构建与发布

```powershell
npm run release:build   # 生成 dist/*.tgz 与 dist/*-source.zip
```

`dist/` 是**构建产物，已被 git 忽略**：npm tarball 属于 npm registry
（`npm publish`）或 GitHub Release 附件，源码 zip 属于 Release 附件。
推送 `v*` 标签时 [release 工作流](.github/workflows/release.yml) 会自动从该标签
构建并挂到 Release 上，因此下载物始终可追溯到某个提交。详细流程见
[CONTRIBUTING.md](CONTRIBUTING.md#releasing)。

---

## 实现结构

```
lib/index.js              Cordis 入口：name / 配置校验 / apply
lib/matlab-discovery.js   MATLAB 安装发现与缓存
lib/matlab-script.js      MATLAB 源码生成（转义、runner 模板、Simulink 主体）
lib/matlab-staging.js     脚本暂存与路径回写（应对非 ASCII 路径）
lib/matlab-core.js        进程控制、产物收集、取消/超时、并发闸门、图片发布
lib/tools.js              5 个工具的定义、参数 Schema 与结果渲染
```

### 约束实现的行为（实测结论）

这些不是推测，而是在 Windows + MATLAB R2024a 上实测得到的行为，代码里都做了对应处理。
也正因如此，**照直觉写的实现在这台机器上跑不起来**。

1. **MATLAB 拒绝执行路径或文件名含非 ASCII 字符的脚本**（报 "文本字符无效"），
   与文件内容无关。因此用户脚本会以**纯 ASCII 文件名**暂存到运行目录后再执行。
   `cd()` 到中文目录本身是正常的。
2. **`run()` 会临时把工作目录切到脚本所在目录**。若直接 `run(暂存路径)`，用户脚本里的
   相对 `save`/`load` 会写进插件暂存目录，随后随运行一起被删除。
   现在把暂存目录加入 path 后**按名调用**，工作目录保持为脚本所在目录。
3. **`set_param` 不接受数值字面量**。即使 `StopTime` 也必须给字符串表达式，
   否则报该模块设置无效。所有传给 `set_param` 的值都会加引号；
   `Simulink.SimulationInput` 则两者皆可。
4. **以 `_` 开头的脚本名无法被 MATLAB 解析**，因此生成的脚本名从不用前导下划线。
5. **子进程 `close` 事件会被 MATLAB 的后代进程拖住**（它们继承了 stdio 管道）。
   只发信号再等 `close`，会让取消/超时延迟 1-2 分钟。现在先同步执行
   `taskkill /F /T` 确保进程树已结束，再释放管道，取消与超时都在约 1 秒内收敛。
6. **MATLAB 会话启动约需 8-12 秒**，因此 `matlab_status` 默认不启动 MATLAB，
   只有显式传 `verify_launch: true` 才启动。
7. 插件以 `-batch` 启动，属无界面模式；图形通过 `exportgraphics`（矢量）
   或 `print`（位图）落到输出目录，再作为图片附件发布到对话。

---

## 开发

架构说明、如何新增工具、如何用自己的 MATLAB 跑完整套件，见
[CONTRIBUTING.md](CONTRIBUTING.md)。最短循环：

```powershell
# 修改 lib/ ...
npm run test:offline
node tools\sync-to-profile.mjs   # 复制、校验、登记
# 重启 DSH
```

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `MATLAB: NOT FOUND` | 设置 `MATLAB_ROOT`、把 `matlab.exe` 加入 `PATH`，或配置 `matlabRoots`。 |
| 派发时报 `value is not lossless JSON` | 运行中的 DSH 内存里是旧版插件。重启 DSH，并重新执行 `node tools\sync-to-profile.mjs`。 |
| 工具始终不出现 | 确认 `cordis.patch.yml` 条目存在（`--check` 会报告），且已重启 DSH。DSH 仅在配置了 `hmr.root` 时才热重载。 |
| 运行卡住后超时 | 长仿真属正常；提高 `timeoutMs` 或传更大的 `timeout_s`。超时会强制结束 MATLAB 进程树。 |
| 图是 `.pdf` 但对话里没有预览 | 设计如此：PDF 是矢量，不做内联。需要可见时用 `export_format: "png"`。 |
| 脚本里的相对路径写到了别处 | 工作目录就是脚本所在目录；需要改变时传 `working_dir`。 |

---

## 许可

[MIT](LICENSE)

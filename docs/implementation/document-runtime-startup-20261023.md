# Document runtime development startup — 2026-10-23

## 工作包

- 关联 Issue：[#224](https://github.com/xuchen-cloud/project_mind/issues/224)；GitHub 状态及发布由主 agent 处理。
- 基线：`77afa4f`；已有 target 选择与测试改动已保留。实现提交为 `ddf405cc0c4c31271e2562fbec1378665848fdec`，本轮源码未再修改。
- 依赖：固定 Node manifest/archive 校验；现有 Record / Source worker 构建与 Office 开发构建路径；本地 npm、各包 lock 和 Office native release。
- 交付：`prepare-desktop-runtime --development` 和 `prepare:dev-runtime`；按本机 darwin arm64/x64、Windows x64、Linux x64 选择固定 Node；准备 Record / Source / Office 开发资源；Tauri 普通与 manual 入口统一准备成功后启动 Vite。
- 非目标：DSH production 安装/stage、Office 发行副本 stage、修改 runtime 校验、系统 Node 替代固定 Node、修改其他工作树、远端写入、应用窗口、Tauri 应用 Cargo 全量。
- 验收：显式 target 与 host 冲突时失败；release 没有显式 target 时失败；开发准备无 DSH production / Office stage；准备失败阻止启动；原发行资源验证保持有效；真实完整开发准备命令成功。
- 验证范围：target / command composition / npm 与 Tauri 启动配置、真实 CLI 错误归档与启动阻断、真实完整准备（含 Office native Cargo release）、本轮新产物的 worker 与分发校验。沿用仍有效的已通过测试，不重复全量构建。
- 环境检查：未发现本工作树的 `tauri dev` 自动重启进程；其他工作树与进程保持原状。

## 实现

- 复用已有 host target 选择实现，接入 `prepare-desktop-runtime.mjs --development`。开发 host 与两个显式 target 环境变量必须一致；release 仍拒绝省略 target。
- 复用原 Node 下载及 checksum / receipt 校验，不改资源校验脚本；开发路径先准备固定 Node，再构建 Record / Source，执行 Record / Source stage，最后执行既有 Office 开发构建。
- Rust Source debug 路径实际读取 `src-tauri/resources/source-extractor` 及共享 Node 收据，因此 Record / Source stage 是开发必要资源。Office debug 路径读取 `packages/agent-host/office-dist`，无需 stage Office 发行副本。
- 开发模式跳过 `prepareDshProduction` 和 DSH stage；发行命令组合保持原有行为。
- 新增 `prepare:dev-runtime`，由 Tauri `beforeDevCommand` 以 `&&` 串行接入 Vite；普通及 `--no-watch` 入口共用此 hook。

## TDD 与有效验证复用

以基线 `77afa4f` 至实现提交 `ddf405c` 的源码 diff 为范围：

| 命令 / 用例 | Red | Green |
| --- | --- | --- |
| `node --test --test-name-pattern='development prepares' scripts/desktop-runtime.test.mjs` | 原命令包含多余的 Office / DSH stage | 1/1 通过 |
| `node --test --test-name-pattern='development CLI' scripts/desktop-runtime.test.mjs` | CLI 不识别 `--development` | 1/1 通过；真实子脚本拒绝错误归档 checksum |
| `node --test --test-name-pattern='Tauri normal' scripts/desktop-runtime.test.mjs` | 缺 `prepare:dev-runtime` | 1/1 通过；真实 npm hook 非零退出且 Vite 替代标记没有生成 |

`npm run test:desktop-runtime` 已通过 25/25，覆盖四种开发 host、target 冲突、release 显式 target、开发命令组合、启动失败阻断和原 DSH staging 校验。实现、配置、依赖声明与锁均未变化，复用该结果。runner 为本机 Node `v26.8.1` / npm `11.19.0`。

## 真实完整准备：2026-10-23 03:13 +08:00

### 相同源码和锁的缓存复用

- root 为 `/Users/xuchen/project_mind`；执行工作树为 `/Users/xuchen/.codex/worktrees/document-runtime-startup/project_mind`。
- 用 Python 调用 `git ls-files -z`，逐文件比较两处实际字节：1,692 个 Office/Markdown 与共享构建相关 tracked 文件一致，其中包括 29 个 Office XLSX native engine 文件及其 Cargo manifest/lock/config。根 `package-lock.json` 与依赖声明也一致。
- 五个 Office/Markdown 包的 `node_modules/.mind-office-lock` 均匹配各自 lock 的实际 SHA-256。
- 固定 Node 归档实际 SHA-256 为 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`，匹配本工作树 manifest。
- 对 root 的 `node_modules`、五个 Office/Markdown 包 `node_modules`、Word/HTML→DOCX 的忽略 `upstream`、固定 Node 归档及 `packages/office-xlsx/native/target` 执行 `cp -cR <root路径> <本工作树路径>`。本轮克隆共 18.07 秒，其中 Office native target 克隆 0.19 秒（约 315 MiB 逻辑大小）。其他 tracked vendor/fork 源码已存在且一致。
- 原脚本继续校验 pinned upstream/vendor/lock；没有重复 npm 安装或网络下载，没有修改 root/fe83/memory 工作树。

### 实际命令与结果

工作目录为上述执行工作树。实际运行命令为：

```sh
/usr/bin/time -l env CARGO_INCREMENTAL=0 npm run prepare:dev-runtime
```

退出码 **0**；墙钟耗时 **27.61 秒**，user **51.83 秒**，sys **4.44 秒**，最大 RSS **861,487,104 bytes**（约 822 MiB）。原 npm、Node、Vite、Office 和 Cargo 子进程均真实执行；没有伪造 spawn 或跳过 native 构建。

实际输出摘录：

```text
> node scripts/prepare-desktop-runtime.mjs --development
Prepared packaged document utility: darwin-arm64
Prepared source extraction resources: darwin-arm64
Verified 93 fixed-source files and generated adapters.
Verified fixed-source DOCX export bundle (731124 bytes).
> @project-mind/office-html2docx@0.0.0 build
Verified 31 GenOffice files at d32d1711f1bf985430757b8c6b3fbddd3831d946
> @project-mind/office-docx@0.0.0 build
Verified 505 GenOffice files at d32d1711f1bf985430757b8c6b3fbddd3831d946
> @project-mind/office-xlsx@0.1.0 build
   Compiling xlsx-sidecar v0.1.0
    Finished `release` profile [optimized] target(s) in 10.94s
> @project-mind/office-pptx@0.1.0 build
Extracted 97 document handlers
Verified 501 GenOffice sources at d32d1711f1bf985430757b8c6b3fbddd3831d946
Verified 4 Web adaptation sources at 86e288908456be5d3b3cccc97e79708e4adf1bc4
Desktop development backend resources prepared for aarch64-apple-darwin (darwin-arm64)
```

- 原脚本实际校验并解压官方固定 Node 归档，重新构建 Record/Source、生成收据和共享资源，再完成 HTML→DOCX、Word、Excel、PPT 及 Office 分发组装。XLSX native release 复用 cloned target 的依赖缓存，只重编译本地 `xlsx-sidecar` crate，耗时 10.94 秒。
- 原始日志保存在本机 `/var/folders/kw/lqtydwgd1sb5hykvcv961q6m0000gn/T/document-runtime-startup-prepare-s7lzkrxf.log`，SHA-256 为 `5a02b423a9db5d63b423bdeefd723d533b7b4f850c0034b16e2a54de7caa8e0c`；关键命令与输出已在本记录中保存。
- 执行前后磁盘可用空间为 1,226.2 → 747.2 MiB（同期净变化，主线程也有构建）。此前磁盘协调期间，仅删除本任务自建克隆和旧生成产物；其他用户缓存未动。
- 开发准备后没有生成 `src-tauri/resources/dsh-assistant` 或 `src-tauri/resources/office-editor`。没有运行 Tauri 应用 Cargo、Vite dev、应用窗口、review 子 agent 或远端写操作。

## 本轮新产物验证

- `packages/agent-host/runtime/darwin-arm64/node --test packages/agent-host/test/record-worker.test.mjs packages/agent-host/test/record-worker-notices.test.mjs packages/agent-host/test/source-worker.test.mjs packages/agent-host/test/office-worker.test.mjs`：**20/20 通过**，包括真实 Record canonical/patch、Source HTML/PDF 中英文、协议边界、notices 与 Office worker 用例。执行器为本轮准备的固定 Node `24.21.0`。
- `node --test scripts/office-distribution.test.mjs`：**14/14 通过**，覆盖完整资产清单、引擎闭包、目标平台、sidecar、许可证及失败保留旧资源。
- `packages/agent-host/runtime/darwin-arm64/node --input-type=module`（stdin 冒烟小用例）：核验 Record/Source bundles、notices 以及 Office 清单内所有文件的 SHA-256；以本轮产物、空 PATH、与 Rust 调用一致的权限沙箱及临时 cwd，成功从 staged Source 路径提取 `中文 runtime startup evidence`，并从 Office 开发路径 inspect `simple.original.docx`、`simple.original.xlsx`、`simple.pptx`。四项均返回单行协议、匹配 requestId、`ok: true`；Office model 非空。临时目录已删除。
- `git diff --check`：通过；完整构建未改变任何 tracked 源码，本轮仅更新本记录。没有需要补回归用例的实现漏洞。

## 平台验证边界

macOS arm64 已完成真实完整准备及本轮产物验证。macOS x64、Windows x64、Linux x64 已通过 host/target 与命令选择测试，尚未作这些平台的完整准备实机验收。

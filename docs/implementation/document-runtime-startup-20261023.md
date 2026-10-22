# Document runtime development startup — 2026-10-23

## 工作包

- 关联 Issue：[#224](https://github.com/xuchen-cloud/project_mind/issues/224)（本轮用户重新授权后已重新打开）；GitHub 状态及发布由主 agent 处理。
- 基线：`77afa4f`；保留已有 target 选择与测试的未提交改动。
- 依赖：固定 Node manifest/archive 校验；现有 Record / Source worker 构建与 Office 开发构建路径；本地 npm 与各包 lock。
- 交付：`prepare-desktop-runtime --development` 和 `prepare:dev-runtime`；按本机 darwin arm64/x64、Windows x64、Linux x64 选择固定 Node；构建 Record / Source / Office 开发资源；Tauri 普通与 manual 入口统一准备成功后启动 Vite。
- 非目标：DSH production 安装/stage、Office 发行副本 stage、修改 runtime 校验、系统 Node 替代固定 Node、修改其他工作树、远端写入、应用窗口、完整 Cargo 与重型 Office 实机构建。
- 验收：显式 target 与 host 冲突时失败；release 没有显式 target 时失败；开发准备无 DSH production / Office stage；准备失败阻止启动；原发行资源验证保持有效。
- 验证范围：用户指定的现有 `desktop-runtime` 测试接缝（target / command composition / npm 与 Tauri 启动配置），新增 CLI 失败与启动阻断用例；相关资源脚本测试；依赖可用时用固定 Node 执行真实 worker 小用例。先 red 后 green，不重复全量构建。
- 环境检查：未发现本工作树的 `tauri dev` 自动重启进程；发现 fe83 的 Vite，保持原状。

## 实现与验证记录

### 实现

- 复用已有 host target 选择实现，接入 `prepare-desktop-runtime.mjs --development`。开发 host 与两个显式 target 环境变量必须一致；release 仍拒绝省略 target。
- 复用原 Node 下载及 checksum / receipt 校验，不改资源校验脚本；开发路径先准备固定 Node，再构建 Record / Source，执行 Record / Source stage，最后执行既有 Office 开发构建。
- Rust Source debug 路径实际读取 `src-tauri/resources/source-extractor` 及共享 Node 收据，因此 Record / Source stage 是开发必要资源。Office debug 路径读取 `packages/agent-host/office-dist`，无需 stage Office 发行副本。
- 开发模式跳过 `prepareDshProduction` 和 DSH stage；发行命令组合保持原有行为。
- 新增 `prepare:dev-runtime`，由 Tauri `beforeDevCommand` 以 `&&` 串行接入 Vite；普通及 `--no-watch` 入口共用此 hook。

### TDD

以本包源码 diff（基线 `77afa4f`）为验证范围：

| 命令 / 用例 | Red | Green |
| --- | --- | --- |
| `node --test --test-name-pattern='development prepares' scripts/desktop-runtime.test.mjs` | 原命令包含多余的 Office / DSH stage | 1/1 通过 |
| `node --test --test-name-pattern='development CLI' scripts/desktop-runtime.test.mjs` | CLI 不识别 `--development` | 1/1 通过；真实子脚本拒绝错误归档 checksum |
| `node --test --test-name-pattern='Tauri normal' scripts/desktop-runtime.test.mjs` | 缺 `prepare:dev-runtime` | 1/1 通过；执行真实 npm hook，错误归档使 hook 非零退出，Vite 替代标记没有生成 |

### 集中验证与产物复用

- `npm run test:desktop-runtime`：25/25 通过，含开发四种 host、target 冲突、release 显式 target、开发命令组合、启动失败阻断、原 DSH staging 校验。测试 runner 为本机 Node `v26.8.1` / npm `11.19.0`。
- 初次 `node --test packages/agent-host/test/record-worker-notices.test.mjs`：1/2 通过；另一项因本工作树尚无构建产物报 `ENOENT`，不是放宽校验后跳过。
- 按用户追加授权，从 fe83 只读复制 `packages/agent-host/{runtime/darwin-arm64,dist,source-dist,office-dist}` 到本工作树的忽略目录；未修改 fe83 内容。复制后用 SHA-256 比对本仓库 pinned manifest 与 Node receipt、Node executable、LICENSE，以及 Office manifest 的所有文件；全部通过。实际 Node 为 `24.21.0`。
- `node scripts/stage-record-runtime.mjs darwin-arm64`：通过，包含 Node receipt / binary / license、Record distribution 校验。
- `node scripts/stage-source-runtime.mjs darwin-arm64`：通过，包含 Source distribution、共享 Node 与收据校验。
- `packages/agent-host/runtime/darwin-arm64/node --test packages/agent-host/test/record-worker.test.mjs packages/agent-host/test/record-worker-notices.test.mjs packages/agent-host/test/office-worker.test.mjs`：15/15 通过；原先缺产物的 notices 测试在此通过。
- `packages/agent-host/runtime/darwin-arm64/node --input-type=module`（stdin 冒烟小用例）：使用现有 worker entry、真实固定 Node、空 PATH、与 Rust 调用一致的权限沙箱及临时 cwd；Source 从 staged 路径成功提取 `<p>中文 runtime startup evidence</p>`；Office 从开发路径成功 inspect `simple.original.docx`、`simple.original.xlsx`、`simple.pptx`，响应 requestId 一致、单行协议、`ok: true` 且 model 非空。已校验 Record / Source bundles、notices 和清单。临时目录已删除。
- `git diff --check`：通过。改动仅为约定的 7 个文件；生成资源不提交。

### 留给主 agent 的验证边界

- 本工作树没有 npm 开发依赖；未执行完整 `npm run prepare:dev-runtime` 正向链路、重新构建 Office、完整 Cargo 或前端全量。重型构建由主 agent 统一安排。
- 真实 worker 验证复用的是已有构建产物，并非本包重新构建；Node 正向准备复用了已校验 receipt 的固定 binary，未重新下载/解压官方归档。错误归档拒绝路径已通过真实 CLI 验证。
- macOS arm64 完成真实资源/worker 小用例；macOS x64、Windows x64、Linux x64 本包仅完成 host/target 与命令选择测试，未作这些平台实机验收。
- 未启动 Tauri、Vite 或应用窗口；未运行 review 子 agent。本记录是实现及验证交接，主 agent 的 Standards / Spec 检查、完整发布门禁及远端发布仍待主 agent 处理。

## 完整正向链路补验准备（后续授权）

- 目标仍关联 #224：在本工作树真实执行 `npm run prepare:dev-runtime`，允许必要 Office 构建，禁止 Cargo/UI/发布。优先复用 root 的相同源码、lock、依赖及 pinned 缓存。
- 用 Python 调用 `git ls-files -z` 并逐文件比较 root 与本工作树实际字节：1,692 个 Office/Markdown 及共享构建相关 tracked 文件一致；根 `package-lock.json`、依赖声明也一致。五个 Office/Markdown `node_modules/.mind-office-lock` 均与各包当前 lock SHA-256 一致。
- root 固定 Node 归档 `packages/agent-host/runtime/archives/node-v24.21.0-darwin-arm64.tar.gz` 的实际 SHA-256 为 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`，与本工作树 manifest 一致。
- 对已核对的 root `node_modules`、五个 Office/Markdown 包 `node_modules` 逐项执行 `cp -cR <root路径> <本工作树路径>`：合计约 22.20 秒；另以同命令克隆两个忽略的 `upstream` 目录和 Node 归档，约 0.14 秒。未复制 Cargo target；未运行 npm install/ci，未改 root 或其他工作树。
- 初次克隆脚本在 `git check-ignore` 检查不存在的 upstream 目录名（缺末尾斜线）时停止；改为检查该目录内的 LICENSE 路径后继续复制。此前未复制 upstream 的 `prepare-source --verify-only` 报缺 LICENSE，完成复制后原校验通过；未改校验规则。
- `node packages/office-docx/prepare-source.mjs --verify-only`：505 个固定上游文件通过。
- `node packages/office-html2docx/prepare-source.mjs --verify-only`：31 个固定上游文件通过。
- `node packages/office-xlsx/scripts/source.mjs`：退出 0，固定 vendor / fork 校验通过。
- `node packages/office-pptx/sources.mjs`：501 个固定 GenOffice 文件与 4 个 Web adaptation 文件通过。
- 本轮尚未执行完整准备命令：现有 XLSX `scripts/build.mjs` 必经 `build-native.mjs`，其中真实调用 `cargo build --locked --release`；与本轮“不要 Cargo”的明确限制冲突。未跳过 native、伪造 spawn 结果或声称完整链路通过，待用户/主 agent 明确该调用的处理方式。
- 磁盘压力：执行期间 `df -h .` 先显示约 1.5 GiB，后降到 195 MiB。仅删除本工作树上一轮生成的 `packages/agent-host/{dist,source-dist,office-dist,runtime/darwin-arm64}` 与 `src-tauri/resources/{agent-host,source-extractor}`，可用空间恢复至约 464 MiB。固定归档及 APFS 克隆的依赖/upstream 缓存保留，待实际链路重新生成产物；未触碰其他用户缓存或 memory 工作树。

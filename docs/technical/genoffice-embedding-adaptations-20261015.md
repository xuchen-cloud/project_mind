# GenOffice Web 与 Tauri 嵌入适配调研

日期：2026-10-15。关联 [#191](https://github.com/xuchen-cloud/project_mind/issues/191)，父需求 [#118](https://github.com/xuchen-cloud/project_mind/issues/118)。本文为只读技术调研，不是 review，也不代表四格式已完成产品验收。

## 先给主 agent 的结论

**已经找到别人完成的 Web 编辑器适配，以及实际发布的 DOCX renderer。应修正“只能从官方 Electron 应用自行拆起”的判断。** 本轮尚未确认一个可直接安装、已验证 Project Mind Tauri 2 + React 19 四格式闭环的发行版。

1. **四格式优先参考 `Nothing1024/dsh-genoffice-engine@86e2889`。** 有实际 Web 构建、浏览器桥、控制适配和导出保存代码，不只是 engine 或 CLI。无需引入整个 DSH 插件即可参考这些适配；其 Apache-2.0 许可已核对。见下方逐格式定位。
2. **`dsh-genoffice@197b2cc` 已有 iframe 编辑器宿主。** 源码包含加载、dirty、显式保存、冲突、重载、关闭控制。它依赖 React 18 / DSH rc.1，插件自身未确认许可，不宜直接当作 React 19 通用 SDK 安装。
3. **Word 另有已发布 renderer：`@clowder-ai/genoffice-docx@0.1.0-alpha.0`。** 实际 npm 包有 `renderer/index.html` 和资源；`content.load → content.settle → receipt` 的字节与版本接口很适合借鉴。仅 DOCX，且 Navigation API 是启动硬依赖。
4. **PrismOffice 有真正的 iframe + JavaScript SDK。** 覆盖 Word/PDF，需 Node/Hono 服务与宿主保存回调，不覆盖本包全部四格式。
5. **`@bitclub.ai/opendesk-office@0.3.4` 是真实封装，但以 Electron 宿主为前提。** 不应仅凭“embeddable”描述判断可直接在 Tauri 中使用。

以上判断来自源码、manifest 和发布产物检查；未在 Project Mind 启动这些候选，也未将仓库自述的兼容性、测试数量或无损保存承诺当作本项目实测。

## 工作范围与可直接复用的位置

- 依赖：官方完整源码快照、GitHub 公开仓库与代码搜索、npm registry。现有 Word/PPT/Excel/Markdown 四 agent 的实现保持独立推进。
- 交付：定位现成 UI/适配、固定版本、保存与宿主差距和推荐路径。
- 非目标：修改实现、下载完整 fork、安装依赖、启动窗口、运行候选测试、commit、发布或关闭 Issue。
- 验收：每个重点候选有可追溯 URL/版本、许可状态与功能分类；将源码存在和实际运行通过分开；不把 backend engine 或 headless 工具称作 UI SDK。
- 验证范围：检查本报告 diff、来源链接和规则一致性；纯文档调研不运行构建或应用测试。

### 本地源码与远端适配不能混为同一份

本机已存在的完整官方源码目录：

```text
$TMPDIR/project-mind-genoffice-parity-upstream/genoffice-d32d1711f1bf985430757b8c6b3fbddd3831d946
官方 commit: d32d1711f1bf985430757b8c6b3fbddd3831d946
```

**该目录是官方 Electron 基线，不包含下面 fork 新增的 Web 桥。** 本轮仅在线读取 fork 的必要文件，没有为 fork 创建本地 checkout，也没有重复下载官方大仓库。代理可用固定 SHA 的 GitHub 页面或对应 `raw.githubusercontent.com` 路径获取单个适配文件。

收口时，PPT agent 已在工作区放入选取的 fork 参考文件，可立即读取：`packages/office-pptx/fork-research/{web-bridge.ts,web-node-shims.ts,web-slides-session.ts,vite.web.config.ts}`。[来源锁](../../packages/office-pptx/fork-source-lock.json) 固定 `86e288908456be5d3b3cccc97e79708e4adf1bc4`；本轮只读核对四文件 SHA-256 均与该锁一致。它们不是完整 fork checkout，也不代表其功能已通过验证；本轮没有改动这些文件。

优先参考的 Web fork：

```text
repository: https://github.com/Nothing1024/dsh-genoffice-engine
commit:     86e288908456be5d3b3cccc97e79708e4adf1bc4
```

| 格式/职责 | 直接定位 | 可复用内容与边界 |
| --- | --- | --- |
| Word | [Docs Web 桥](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/docs/src/renderer/web-bridge.ts)、[控制适配](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/docs/src/renderer/control.ts)、[Web 构建](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/docs/vite.web.config.ts) | 用桥替换 `window.desktop`；控制适配接受当前文档字节导出回调；优先参考打开、保存及 readiness/dirty 接口 |
| PPT | [Slides Web 桥](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/slides/src/renderer/web-bridge.ts)、[控制适配](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/slides/src/renderer/control.ts)、[Node shims](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/slides/src/renderer/web-node-shims.ts)、[Web 构建](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/slides/vite.web.config.ts) | `window.slidesApi` 的浏览器实现；实际引用 `runTxn`、`mapScriptOps`、`buildRenderSlide` 和 engine；不必从两千多行桥的每个接口重新推导 |
| Excel | [Sheets Web 桥](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/sheets/src/renderer/web-bridge.ts)、[Web 构建](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/sheets/vite.web.config.ts) | `window.desktopApi` 浏览器实现；调用 `parseXlsxWorkbook`、`applySaveRequest`；`exportCurrentBytes` 导出当前内容。其浏览器解析/保存路径不等于现有 Rust sidecar 路径，公式与复杂文件需单独比对 |
| Markdown | [Web 桥](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/markdown/src/renderer/web-bridge.ts)、[控制适配](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/markdown/src/renderer/control.ts) | `window.markdownApi` 替换路线；直接取得当前 Markdown 序列化字节。不能因此将富文本往返等同于 Project Mind 的源字节保留要求 |
| 公共 relay | [server.mjs](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/web/server.mjs)、[write-atomic.mjs](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/web/write-atomic.mjs) | SSE 执行器、导出、保存通知；保存支持 SHA-256 `expectedRevision`，并有 mtime 分支和同路径写入队列。Project Mind 应复用自己的 File 服务承担最终提交 |
| 控制客户端 | [genoffice-control.mjs](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/web/sdk/genoffice-control.mjs) | `GenOfficeClient` 封装控制协议的 context/tool/save；导入 `node:crypto`、`node:path`，是 Node 控制客户端，不是 React 组件或浏览器编辑器 SDK |

## 候选核实

### 1. Nothing1024 的两仓方案

| 仓库 | 固定提交/版本 | 许可 | 分类与成熟度 |
| --- | --- | --- | --- |
| [dsh-genoffice-engine](https://github.com/Nothing1024/dsh-genoffice-engine/tree/86e288908456be5d3b3cccc97e79708e4adf1bc4) | `86e288908456be5d3b3cccc97e79708e4adf1bc4`；workspace 多数版本仍为 `0.1.0`，不应拿它替代 SHA | [Apache-2.0](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/LICENSE)，企业目录和依赖另按各自许可 | 已有 Web UI 源码的实验性 fork；不是仅后端 engine，也没有本轮确认的 Tauri 安装包 |
| [dsh-genoffice](https://github.com/Nothing1024/dsh-genoffice/tree/197b2ccc84c430c13c12e5db48ce383102baf03e) | `197b2ccc84c430c13c12e5db48ce383102baf03e`；插件 `0.2.0` | GitHub 许可字段为空，根 `LICENSE` 返回 404，插件 manifest 未列 license；本轮不能确认插件代码复用许可 | 已有 DSH iframe 宿主源码；README 明示 experimental；不是稳定通用 React SDK |

**UI 与编辑链路确实存在。** 插件的 [ControlModeViewer](https://github.com/Nothing1024/dsh-genoffice/blob/197b2ccc84c430c13c12e5db48ce383102baf03e/packages/tab-genoffice/src/tabs/control-mode.tsx) 渲染 iframe，使用 `allow-scripts allow-same-origin allow-downloads`，接收 dirty 状态，保存请求打到 `/api/control/<app>/<docId>/export`；有冲突、另存、重载和同文档打开占用处理。不是“返回 HTML 预览”的后端工具。

**可借鉴宿主关系，但不能直接安装到主应用。** [插件 manifest](https://github.com/Nothing1024/dsh-genoffice/blob/197b2ccc84c430c13c12e5db48ce383102baf03e/packages/tab-genoffice/package.json) 的 React peer 是 `^18.2.0`，DSH 相关 peer 钉在 `0.2.0-rc.1`；Project Mind 当前为 React 19 和 DSH rc.2 依赖。iframe 可隔离不同 React runtime，但 DSH 插件自身加载与平台契约仍需适配。插件 description 还明确写出 docx/xlsx/pptx 走该控制预览，md/pdf/html 使用宿主文档预览；不能从 README 的五族工具表推断五族都由相同 UI 接管。

**源码比文档新。** engine 的 [web/README](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/web/README.md) 仍写 Sheets/Slides 待 Web 化，但对应 Web 构建和桥已经存在；[DSH.md](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/DSH.md) 仍写旧 DSH 版本。应以固定提交的实际源码为准。根 `npm run web` 只顺序构建 shell/docs/markdown；其余需单独构建或运行 workspace Web 构建，不能把缺少某 app 的 `web-dist` 当成适配不存在。[根脚本](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/package.json)

**保存差距。** 当前 `write-atomic.mjs` 已实现内容 hash revision，并非只有 mtime；control 导出携带文件 revision 与编辑状态 revision，收到保存通知后才清对应 dirty。它仍以本机路径与 relay 为业务入口，`docId` 由路径 hash 生成，不具备 Project Mind 的 File 身份、归属、固定历史版本、恢复与原生提交回执。Project Mind 应保留编辑和导出层，将落盘改接现有服务；不能让 relay 绕过 File 版本提交直接写项目文件。[Docs control](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/docs/src/renderer/control.ts)、[保存实现](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/web/write-atomic.mjs)

**Tauri 与功能差距。** Web 构建将 Node builtin 指向浏览器 shims，其中真实 fs/pipeline 调用明确抛错；能编译浏览器 bundle 不表示每个 Electron 能力可用。CSP 允许多类网络连接、relay CORS 只回显 loopback HTTP origin，不能原样推导 `tauri://`/`http://tauri.localhost` 宿主兼容。源码里的 FS Access/下载回退也不等于在 macOS WebKit 中完成 File 保存。已有的四格式实现继续推进，优先抽取明确需要的桥方法；复杂公式、字体、中文输入、图片、导出与保存冲突仍按 #191 的真实样本验收。[Slides shims](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/slides/src/renderer/web-node-shims.ts)、[构建 CSP](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/apps/slides/vite.web.config.ts)、[relay](https://github.com/Nothing1024/dsh-genoffice-engine/blob/86e288908456be5d3b3cccc97e79708e4adf1bc4/web/server.mjs)

### 2. Clowder GenOffice DOCX renderer

- 仓库：[zts212653/clowder-ai-plugins](https://github.com/zts212653/clowder-ai-plugins/tree/47071ae07ca054b4fb0b8b3f523d890381df4bfd/packages/genoffice-docx)，核对主线 SHA `47071ae07ca054b4fb0b8b3f523d890381df4bfd`。
- 发布包：[`@clowder-ai/genoffice-docx@0.1.0-alpha.0`](https://registry.npmjs.org/@clowder-ai%2fgenoffice-docx/0.1.0-alpha.0)，包声明 Apache-2.0；它的源锁固定官方 `v0.8.1039` / `e833fff87f5628cc681e0fd1a063ce64fde5baa4`。[source-lock](https://github.com/zts212653/clowder-ai-plugins/blob/47071ae07ca054b4fb0b8b3f523d890381df4bfd/packages/genoffice-docx/source-lock.json)
- 产物：本轮在内存读取 npm tarball，确认 69 项，约 18.35 MB 解包体积；含 `renderer/index.html`、renderer 资源、manifest、provenance/source-lock，而不是只有 Node API。manifest 的 provider 仅注册 DOCX，surface 为 dedicated-origin iframe，operations 为 load/settle/comment/tracked-change。[固定 npm tarball](https://registry.npmjs.org/@clowder-ai/genoffice-docx/-/genoffice-docx-0.1.0-alpha.0.tgz)

**直接可借鉴的是宿主保存接口。** [host-bridge.ts](https://github.com/zts212653/clowder-ai-plugins/blob/47071ae07ca054b4fb0b8b3f523d890381df4bfd/packages/genoffice-docx/src/host-bridge.ts) 用 `content.load` 取得 `contentIdentity/fileName/ownerRevision/blobDigest/bytes`；`content.settle` 发送 `expectedOwnerRevision/bytes/operationId`，接收 `receiptId/ownerRevision/blobDigest`；版本冲突映射为 `external-modified`。这比移植任意路径读写更贴近 Project Mind。

**实际限制很具体。** 同一桥明确拒绝图片选择、附件、另存、打印/PDF 导出、AI、恢复副本等多类方法；主题/语言变化和关闭检查订阅多为 no-op。安装桥时要求 Navigation API，不存在就抛错，并禁止 fetch/XHR/WebSocket/EventSource 等。需要实现 Clowder 的 bootstrap/MessagePort 握手及字体度量响应；不能只加载 HTML 就宣称功能齐全。React 以独立 bundle 隔离，但 macOS WebKit/Windows WebView2 的 Navigation API 与实际 UI 行为本轮未验证。**成熟度：有发布产物的 alpha、DOCX 专用候选，不是四格式完整替代。** [桥源码](https://github.com/zts212653/clowder-ai-plugins/blob/47071ae07ca054b4fb0b8b3f523d890381df4bfd/packages/genoffice-docx/src/host-bridge.ts)

### 3. PrismOffice 的 iframe 与 JavaScript SDK

仓库：[arun-prabhakar/prism-office](https://github.com/arun-prabhakar/prism-office/tree/089483b0d9a37fcf92cc258594d0b588bc78d921)，SHA `089483b0d9a37fcf92cc258594d0b588bc78d921`，服务 workspace `0.1.0`、private，Apache-2.0。本轮确认源码与构建配置，未确认公共 npm SDK 发行或已部署实例。[服务 manifest](https://github.com/arun-prabhakar/prism-office/blob/089483b0d9a37fcf92cc258594d0b588bc78d921/apps/editor-service/package.json)

这是明确按嵌入设计的 Web 移植：`PrismOfficeAPI.DocEditor` 管 iframe/postMessage；`apps/editor-service` 是 Hono/Node 服务；`packages/web-runtime` 提供浏览器版 DesktopApi/PdfApi；Web 构建输出到服务静态目录。**已声明交付范围只有 `.docx` 和 `.pdf`，不包含 xlsx/pptx/Markdown。** [README](https://github.com/arun-prabhakar/prism-office/blob/089483b0d9a37fcf92cc258594d0b588bc78d921/README.md)、[web-runtime exports](https://github.com/arun-prabhakar/prism-office/blob/089483b0d9a37fcf92cc258594d0b588bc78d921/packages/web-runtime/package.json)

保存依赖宿主提供文件 URL、签名 config 和 callback：编辑器生成字节并上传 `/save-document`，服务回调宿主，宿主从 `/saved/:id` 下载字节并持久化。`document.key` 应随保存换新，dirty=false 表示已推送服务，不能自动解释为 Project Mind 原生版本已经提交；临时保存 URL 默认 TTL 60 秒。接入时需将保存成功应答绑定真实 File 提交，并保留失败与 CAS 语义。[API reference](https://github.com/arun-prabhakar/prism-office/blob/089483b0d9a37fcf92cc258594d0b588bc78d921/apps/editor-service/docs/api-reference.md)

**成熟度与推荐：** 有 SDK/参考宿主/服务的早期源码候选，适合允许本地 Node 服务或服务端部署的 Word/PDF 集成。Tauri 本地文件需要增加受限字节服务与回调入口；不是直接消费 `file://` 或 Tauri IPC 的现成插件。当前四格式包优先参考 Nothing engine，不为这两个格式重新引入一整套服务。Node 22+、JWT 及部署要求见 [安装说明](https://github.com/arun-prabhakar/prism-office/blob/089483b0d9a37fcf92cc258594d0b588bc78d921/INSTALLATION.md)。

### 4. OpenDesk Office npm 封装

发布包：[`@bitclub.ai/opendesk-office@0.3.4`](https://registry.npmjs.org/@bitclub.ai%2fopendesk-office/0.3.4)，Apache-2.0，`gitHead=f02843043d13581d432c894bca42a9070da6d662`，repository 指向 [IntelliOS/GenOffice](https://gitcode.com/IntelliOS/GenOffice)。manifest 报告 648 文件、约 70.23 MB 解包体积；本轮 tarball 获取不完整，未完成整包内容检查。

它确实导出三格式集成面：`./renderer`、`./word-renderer`、`./sheets-renderer`，以及 `./main`、`./word-main`、`./sheets-main`、preload、Vite 配置、DOCX/PPTX engine 与 IronCalc WASM。包 README 提供三类 bootstrap，声明 Sheets 用 JavaScript 字节引擎与 IronCalc WASM 保存/计算、无需原 Rust sidecar；这是有价值的替代路径，但本轮没有验证其公式覆盖和 OOXML 保真。[npm manifest 与 README](https://registry.npmjs.org/@bitclub.ai%2fopendesk-office)

**它还不是 Tauri 即插即用 SDK。** manifest 的 peer 是 `electron >=39`，React/ReactDOM 是 `^19.2.8` dependencies。已读取的 [word-renderer.ts 分发副本](https://cdn.jsdelivr.net/npm/@bitclub.ai/opendesk-office@0.3.4/src/word-renderer.ts) 调用 `window.openDeskOfficeWordHostBridge.prepareDocxPath`，动态加载内部 renderer entry 并等待可见/就绪事件；需要已有宿主桥和构建别名。不能将 `bootstrapOpenDeskOfficeWordEditor` 的存在解读为已提供浏览器字节 load/save 接口。

**成熟度：** 有 npm 版本和明确 Electron 嵌入入口；Tauri 接入仍需替换宿主 main/preload、路径及保存接口。当前适合参考三格式 API 边界和 WASM 路线，不推荐为使用它引入 Electron。

### 5. 其他已核对结果

| 候选 | 固定版本与许可 | 核实结论 |
| --- | --- | --- |
| [relooplab/genoffice-compatible](https://github.com/relooplab/genoffice-compatible/tree/e2f0faf7649be12c4c5c6318c1a06053582e2cba) | `e2f0faf7649be12c4c5c6318c1a06053582e2cba`；根 manifest 声明 Apache-2.0 | 已检查 README/根 manifest，仍描述完整 Electron 套件，脚本为 Electron dev/build/dist。本轮未找到可确认的独立 Web UI SDK，不因名称 compatible 推断已有 Tauri 适配。[manifest](https://github.com/relooplab/genoffice-compatible/blob/e2f0faf7649be12c4c5c6318c1a06053582e2cba/package.json) |
| [DuBearte/genoffice-obsidian](https://github.com/DuBearte/genoffice-obsidian/tree/78aa87142e419f7d6a737e9ff64c74d6713a0ed2) | `78aa87142e419f7d6a737e9ff64c74d6713a0ed2`，`0.1.0`，Apache-2.0 | 为 GenOffice Markdown 增加 wiki 链接、嵌入、vault sidebar；有 renderer/editor 导出，也有 Electron main/preload，Electron peer optional。不是把 GenOffice 嵌入其他应用的全格式适配。Tiptap peer 固定 `3.31.0`，现有 Markdown 字节语义不能直接替换。[manifest](https://github.com/DuBearte/genoffice-obsidian/blob/78aa87142e419f7d6a737e9ff64c74d6713a0ed2/package.json) |
| [`@lumifai/harness-tool-pack-office-editing`](https://registry.npmjs.org/@lumifai%2fharness-tool-pack-office-editing/1.1.0) | `1.1.0`，manifest 为 `UNLICENSED` | headless 工具包；其 README 明说 clean-room、未复制 GenOffice 源码。没有编辑器 UI，排除本轮接入候选 |

`truerain/gen-office-frontend@4bca6b5f91b41c9e0ff4197a5e458104a96ead5c` 的 [README](https://github.com/truerain/gen-office-frontend/blob/4bca6b5f91b41c9e0ff4197a5e458104a96ead5c/README.md) 已确认是 React 18 的韩文后台 UI/CRUD/数据网格框架，同名无关，已排除。搜索还命中 UniWork、GLM Office、genoffice2 等换品牌/AI provider 分支；本轮未对其确认可复用 Web/Tauri 接入面，不升级为推荐候选。

## 官方完整源码的 exports 和构建边界

本轮检查指定本地快照的 workspace manifests、renderer 入口、Vite/Electron 构建配置和 CLI build 脚本。该目录没有 `out/`、`dist/`、`node_modules/` 或 native `target/` 产物；因此以下是**源码与构建目标检查**，不是已构建运行证明。

| 层 | 本地与官方固定源码事实 | 对接入的意义 |
| --- | --- | --- |
| 完整 Electron 应用 | `apps/{docs,sheets,slides,markdown,...}` private，`main=out/main/index.js`，无 editor SDK exports，build 使用 electron-vite；Docs 打包 `out/**` | 安装包是完整应用。renderer dev server 只是被 shell 嵌入的开发入口，不能离开 preload/main 自动工作 |
| DOCX/PPTX engines | private workspace，exports 指向 `src/*.ts`，无独立发布 JS/types 产物契约 | 可固定源码复用，不等于可 `npm install` 的 UI SDK |
| `@genoffice/pptx-render` | exports 为坐标、RenderTree、metrics/layout/build-slide 等；index 明确 Konva adapter 不在该包 | 是渲染数据/布局层，幻灯片实际交互 canvas 在应用 renderer |
| `@genoffice/ui` | private，React peer `^19.0.0`，导出 ColorPicker、FindPanel、Markdown、ribbon hooks 等共享组件/CSS | 是可复用 UI 零件，不导出整套 Docs/Sheets/Slides 编辑器 |
| `@genoffice/xlsx-gateway` | private，通配 exports 指向 TS；官方 Sheets 还构建 Rust xlsx sidecar | 后端保存或 gateway 包不能算表格编辑器 UI |
| CLI/headless/MCP | CLI build 用 esbuild 输出 `dist/genoffice.cjs`，`platform=node`、target node22；定位额外 WASM/sidecar/运行资源 | `runCli()` 可嵌入是命令调用，不是 renderer SDK。部分 render/PDF 转换仍需隐藏 Electron 进程 |

对应第一手固定源码：[Docs manifest](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/package.json)、[Docs 构建](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/electron.vite.config.ts)、[pptx-render index](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/pptx-render/src/index.ts)、[UI exports](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/ui/package.json)、[CLI build](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/build.mjs)。

React 19 本身不是拆官方 UI 的主要阻碍。各 renderer 入口在挂载 React root 前就访问 `window.desktop`、`desktopApi`、`slidesApi`、`markdownApi` 的语言/主题/待打开文件等接口；宿主桥、文件会话、字体资源和保存语义才是必要工作。[Docs main](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/main.tsx)、[Slides main](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/slides/src/renderer/main.tsx)

### 最新官方版本交叉核对

查询时 GitHub latest 为 [v0.11.829](https://github.com/genspark-ai/genoffice/releases/tag/v0.11.829)，发布于 `2026-10-15T12:38:48Z`，release target commit 为 `4dc4b7b3fc3e1b1da5089e652b49a4b4506a9e23`。assets 为 DMG/EXE/AppImage/DEB/RPM，没有该 release 随附的 Web/Tauri SDK 资产。该提交的 [Docs manifest](https://github.com/genspark-ai/genoffice/blob/4dc4b7b3fc3e1b1da5089e652b49a4b4506a9e23/apps/docs/package.json) 仍 private、无 editor exports、采用 electron-vite；[UI manifest](https://github.com/genspark-ai/genoffice/blob/4dc4b7b3fc3e1b1da5089e652b49a4b4506a9e23/packages/ui/package.json) 仍为源码组件 exports。

官方主体 Apache-2.0，`ee/` 使用单独企业许可；商标与字体/第三方资源按各自声明处理。不能将主体许可推及所有目录和品牌。[官方许可说明](https://github.com/genspark-ai/genoffice/blob/4dc4b7b3fc3e1b1da5089e652b49a4b4506a9e23/README.md)、[本地同版 NOTICE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/NOTICE)

## 推荐接入路径与交付边界

**当前四 agent 优先吸收已有 Web 桥，保留正在实现的格式层和原生 File 保存权威。** 不把整个 fork、DSH Sidebar 或另一个文档服务作为本包强制依赖。各格式先比较自己的 Electron preload 方法与上述 bridge 的已实现方法；只移植当前 UI 实际调用的差距，并用当前官方固定源码核对类型，避免把较旧 fork 直接覆盖较新引擎。

建议的保存关系是：

```text
Project Mind 读取指定 File Version 的原始字节与 hash
  → 格式 renderer / 固定源码的浏览器桥
  → 当前编辑状态导出候选原格式字节
  → Project Mind File 提交服务核验归属、版本与 hash/CAS
  → 成功回执推进编辑器 baseline，并只清已提交 revision 的 dirty
```

这是一条推荐接缝，**不是已实现的通用 bytes-save 命令声明**。当前仓库的 `officeFileApi.save` 调用 `file_office_save`，携带结构化 edits；若某 renderer 导出完整字节，应由对应实现包决定怎样接回现有 File 提交能力，不能把 bytes 当作 edits 直接塞入现有接口。[现有调用](../../src/services/officeFileApi.ts)、[编辑会话](../../src/lib/office-edit-session.ts)

优先级：

1. **Word/PPT/Excel/Markdown：** Nothing engine 的 Web bridge / control / Vite 源码作为最直接参考。Excel 浏览器保存/公式路径与现有 Rust 路径分别验证；Markdown 保留项目既定源文件语义。
2. **Word 备选：** Clowder renderer 可提供更小的宿主字节协议；先核验 Navigation API、图片编辑需求和固定旧版上游的差距，再判断是否替换现有 renderer。
3. **允许部署编辑服务的 Word/PDF：** 再考虑 PrismOffice；四格式整体采用它不能满足 #191。
4. **OpenDesk：** 仅在愿意移植 Electron 宿主层或单独考察其 WASM 表格层时继续，不直接作为 Tauri SDK 安装。

进入产品验收前仍需证明：主程序 File 页签可用、保存失败与冲突不丢编辑、关闭重开及固定历史/恢复正确、未改结构保留、中文与图片/表格/公式/页序符合各格式范围，以及目标 WebView 的字体、worker/WASM、快捷键和资源加载正常。此处列的是 #191 的接入差距，不是要求本轮只读调研扩张为实现或 review。

## 搜索范围与证据强度

- **GitHub repository/fork 搜索：** API 查询 `genoffice tauri fork:true`（当次 0）、`genoffice web fork:true`（当次 2，含 PrismOffice/UniWork）、`genoffice embed fork:true`（当次 1，PrismOffice）、`genoffice sdk fork:true`（当次 1，描述为 VBA/VB6 toolbox 的 fork）。这些查询主要覆盖名称、描述等索引，不能排除不带这些词的 fork。另重点定点核对初筛出的五个候选仓库；没有遍历当时约 1,246 个全部 forks。
- **GitHub code 搜索：** 连接器查询 `genoffice tauri`、`"genoffice" "tauri" path:src-tauri`、`"genoffice" "iframe" "save"`、`repo:genspark-ai/genoffice "web:build"`，以及 Nothing engine 的文件名/bridge 查询。Tauri 命中包括计划文档与外部应用打开菜单，未确认可用的嵌入实现；小仓库的零结果不能推翻直接源码证据。
- **npm：** registry 搜索 `genoffice` 当次返回 Clowder、OpenDesk、Lumifai 三项；分别读取完整 manifest/README。精确查询 `@genoffice/ui`、`@genoffice/docs`、`@genoffice/docx-engine` 当次为 404，只能说明这些精确坐标未获取到公开包，不能推断官方所有命名都不存在。[registry search](https://registry.npmjs.org/-/v1/search?text=genoffice&size=100)
- **网络与产物限制：** GitHub CLI 本地 token 无效，改用公开 API/raw 与 GitHub 连接器。EOF/截断对相关请求重试一次；必要文件仍失败时明确保留未验证状态。Clowder tarball 读取成功；OpenDesk tarball 不完整，未确认整个安装闭包。未下载 fork 大仓库，没有执行候选编译、测试或 GUI。

**可支持的最终判断：有值得立即复用的现成 Web 适配和 renderer；在上述范围内，尚未确认已为 Project Mind 技术栈验证完成的全四格式 Tauri 即插即用版本。**

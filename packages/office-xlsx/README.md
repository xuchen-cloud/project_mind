# Office XLSX — 完整 GenOffice Sheets 移植（#191 / #118）

固定官方 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`；完整 Sheets renderer/App、Univer OSS 0.25.1、完整 gateway 和 JSONL native sidecar/IronCalc。固定 Web 适配参考 `Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4`，实际复用浏览器 Node shim，不使用路径 relay。

**2026-10-18 本轮构建/定向验收已收口，按主要求暂冻结待整合，未宣称全部上游能力交付。** 各功能当前证据和具体差距见 [功能矩阵](../../docs/implementation/genoffice-parity-excel.md)。非目标仅完整独立 App 管理/更新/重复 AI 聊天；编辑功能按完整上游推进。

## 构建与固定来源

```sh
npm --prefix packages/office-xlsx ci --ignore-scripts
npm --prefix packages/office-xlsx run build
# native 未变化且已有对应 binary 时：
node packages/office-xlsx/scripts/build.mjs --skip-native
```

`source.mjs` 校验 `upstream.json` 的 Git blob、`patches.json` 的补丁 SHA256、`fork-source-lock.json` 的 fork SHA256；`build-renderer.mjs` 校验实际 renderer vendor 输入都已锁源。vendor 原始 renderer 保持固定，局部 host 适配由精确构建转换实现。源码已随包，不需要联网 prepare。重新获取固定官方源码可运行 `scripts/source.mjs --fetch`；补充 renderer 固定源码可运行 `scripts/pin-renderer.mjs "$GENOFFICE_FIXED_SOURCE"`。

| 产物 | 用途 |
| --- | --- |
| `dist/engine.mjs` | Node ESM；npm 依赖内嵌，外部仅 Node builtins |
| `dist/xlsx-sidecar[.exe]` | native executable；默认相邻，可用 `context.binaryPath` 指定 |
| `dist/browser.mjs`, `browser.css` | 轻量 iframe mount API 与宿主样式，React wrapper 由根 Vite 消费 |
| `dist/renderer.html`, `renderer/**`, `renderer-resources.json`, `renderer-meta.json` | 外部完整 Web renderer、ESM chunks、CSS、原始字体及资源/构建输入清单 |
| `browser.d.mts`, `types.ts` | 公共 Model/Edit/EditorProps；DTO 无 workspace alias 依赖 |
| `THIRD-PARTY-NOTICES.txt`, `LICENSE`, `NOTICE` | 官方、fork、npm/Cargo、Carlito OFL 来源与 license |

完整 dist 交主宿主资源流程复制；不需要运行时源码目录或网络。支持 `OFFICE_RUST_TARGET` 交叉构建，实际 native 验证平台是 macOS arm64；未声称其它平台已实测。

## 字节接口

```ts
inspect(bytes: Uint8Array, context?: Context): Promise<Model>
edit(bytes: Uint8Array, edits: Edit[], context?: Context): Promise<Uint8Array>
recalculate(bytes: Uint8Array, request: RecalculateRequest, context?: Context): Promise<RecalculateResult>
loadRange(bytes: Uint8Array, sheetId: string, area: Area, context?: Context): Promise<Range>
```

坐标从 0 开始。保留 `blank/string/number/formula` 标量 edits，同时支持 `{kind:'gateway',changes,snapshot?}` 完整 typed editing journal。snapshot 用于显示/草稿恢复，保存权威为 schema 验证后的 changes。按原 ZIP 修改；未触及的对象、关系、媒体和扩展 parts 保留。结构与新增表格/透视等需要多阶段时先处理私有 candidate，只向宿主返回最终字节；业务 CAS 由原 File 宿主执行。

不再固定 A1:Z100 或只存 value。inspect 读取全部已用区域，每次 native 读取最多 100000 格，总已用矩形资源预算 2000000；空白画布 1000×26，官方 grid-growth 扩展。官方 renderer 的大表 viewport 流式加载已有50k+真实格 ready、计算和保存证据；宿主 Model 仍先收集预算内源数据，超过2m矩形的源端按需查询未实现。输入 ZIP 最大 64 MiB，超过资源预算明确报错。

inspect 同时提供完整 renderer 所需的只读 metadata、公式 inventory、行轮廓、媒体和透视源。不赋予 renderer 路径权限。UI 优先使用真实 Univer 计算结果（含文本、布尔、错误）；上游原生 IronCalc fallback 经 `onRecalculate` 绑定原 File 只读 worker；本包 recalculate 已验证真实计算及源 bytes 不变，主已接真实原 File/hash 只读 worker，13 项 baseline/异步失效宿主合同通过（主报告）。

## 编辑器与宿主合同

`mount/mountEditor(container,props)` 返回 `{ready,commitEditing,output,update,dispose}`。`ready` 等待完整 App/Univer Steady；所有保存先 `await commitEditing()`，再读取最新 edits，进入 saving 后才设 readOnly。React `XlsxEditor` 保留：

```ts
registerBeforeSave?: (callback: () => Promise<void>) => () => void
onPendingChange?: (pending: boolean) => void
onSaveRequest?: () => void | Promise<void>
onExport?: (file: {name: string; mime: string; bytes: Uint8Array}) => Promise<boolean>
onPrint?: (document: {html: string; title?: string; pageSize?: {widthPt:number; heightPt:number}}) => Promise<void>
onRenderPdf?: (document: {html: string; title?: string; pageSize?: {widthPt:number; heightPt:number}}) => Promise<Uint8Array>
onRecalculate?: (request: RecalculateRequest) => Promise<RecalculateResult>
onInspectImportedWorkbook?: (bytes: Uint8Array) => Promise<Model>
onCaptureScreenSources?: () => Promise<ScreenSourcesResult>
onCaptureScreenSource?: (request: ScreenCaptureRequest) => Promise<ScreenCaptureResult | null>
```

`ScreenSourcesResult`、`ScreenCaptureRequest`、`ScreenCaptureResult` 从 types/browser 导出，与固定官方纯 DTO 一致。截图只转发真实宿主来源/PNG 回执；本包不枚举系统窗口、不申请权限。fixture 只证明 picker→callback→图片保存合同，native 权限与实际采集由宿主验收。

合并工作簿复用官方 Ribbon 入口和合并器；实际 file picker 只传用户选择的 XLSX bytes 给 `onInspectImportedWorkbook`。返回完整 Model 后创建独立临时只读 session，范围/公式/行轮廓/媒体/透视按该 session 查询；合并结束释放。文件名仅 renderer metadata，无原生路径。目标 journal 一次进入原 File/CAS。固定上游仅导入缓存值、样式、合并区域、行高和列宽；公式转值，不导入源表格/图片/图表对象。目标既有对象保留。

选择或打开未改变单元格不产生 pending；真实输入产生 pending，journal 发送后才结算。专属 MessageChannel 在严格且仅一次的窗口握手后建立，避免 WebKit 异步 reply 的 WindowProxy 来源差异；替换/销毁关闭旧通道。已接收的异步请求捕获发起帧 epoch/callback，执行 host IO 前核验仍当前，回执只发原 port。model 引用替换表示原生保存成功后的新基线，宿主同时传 `edits:[]`。独立 File、保存、自动保存开关已从 renderer 移除；默认自动保存及保存快捷键通过 `onSaveRequest` 进入原 File 保存，不通过 renderer 自行写文件。

宿主文件名行菜单调用 `await editor.output(command)`，`command` 为 `'pdf' | 'csv' | 'print'`，经现有专属 MessagePort 执行上游 `export-pdf` / `export-csv` / `print`。PDF/CSV 等待真实生成与导出回执，用户取消正常完成，失败拒绝；print 打开原打印设置后完成，后续原生打印失败在该对话框显示。工作簿替换、关闭会拒绝尚未完成的 handle 请求。预览与只读态允许输出；打印参数在只读态仅用于本次输出，不写回源文档。预览隐藏整个编辑器 header，保留原工作表/缩放；两态状态栏统一 28px 高、12px 文字、24px 按钮。

导出优先等待 `onExport`：true 写入完成，false 用户取消；取消不会再触发 anchor。只有 standalone 无宿主 callback 才用 anchor。CSV 是当前真实字节导出路径，保留单工作表/公式与格式损失提示。PDF 复用官方分页打印 HTML，每页从官方分页结果获得实际有向 pt 尺寸，按连续尺寸组等待 `onRenderPdf` 的有效 PDF bytes，包内 pdf-lib 保序合并为一次 `onExport`；无宿主 PDF 生成器时明确报错，不把浏览器打印当可编程 PDF。

打印使用官方分页后的 cells/visuals/page setup HTML，经资源检查、内嵌字体与图片后等待 `onPrint`。只在 standalone 无 callback 时创建打印文档 frame 并调用其 `window.print()`。本包不调用 Tauri、不接收任意路径；实际 native 打印由宿主实现，headless 浏览器验证不代表 WKWebView 已交付。

## 主题、交互与验收

应用 frontend-design，并遵循现有 `.impeccable.md` / design-system：宿主真实 tokens，文档自身样式独立，连续边缘遮罩、有界列表尺寸/内容观察与 reduced-motion。完整官方工具栏、对话框、图片/图表/形状/表格/透视/迷你图/保护/页面功能均在生产 renderer；接入与逐项通过验收分别记录在矩阵。

针对性验证入口为 `tests/engine.test.mjs`、`parity.test.mjs`、`browser.test.mjs`、`full-renderer.test.mjs`、`output.test.mjs`、`print-output.test.mjs`、`pdf-output.test.mjs`、`query.test.mjs`、`save-request.test.mjs`、`import-workbooks.test.mjs`、`capture-screen.test.mjs`、`document-settings.test.mjs`、`worksheet-structure.test.mjs`、`rules-and-notes.test.mjs`、`frame-requests.test.mjs`。UI 通过真实 headless 操作、原字节保存重开；帧请求用公开 MessagePort 投递复现同步切换/销毁与异步 host IO 的竞争。不用私有 editor API 模拟按钮成功。可用 `OFFICE_WEBKIT_EXECUTABLE` 指定已安装 WebKit。临时截图、日志、draft/print HTML 在忽略的 `tests/output/`。

## 外部 renderer 资源（#118 首开性能）

`mount(element, props, rendererUrl?)` / `mountEditor` 的第三参数允许宿主传入 renderer HTML 的 URL。未传时使用 `new URL(['.', 'renderer.html'].join('/'), import.meta.url).href`，动态路径避免根 Vite 静态复制额外的孤立 HTML；独立 HTTP 使用者应保留 `dist` 相对结构。打包宿主应显式传入资源插件解析后的 URL。File 归属、专属 MessagePort、ready、替换/销毁取消及保存回执协议不变。

`dist/renderer-resources.json` 固定为 `{entry: 'renderer.html', files: [...]}`，其中 `files` 均相对 `dist`，包含入口 HTML、全部 ESM chunks、CSS 和字体/图片。复制或发布时必须保留完整清单及相对目录；不得只复制 HTML。`browser.mjs` 不再导入生成的内嵌 HTML。字体保持上游原始文件，Univer 与全部现有语言资源均保留；原有动态导入现在由 ESM splitting 产出独立 chunks。

现有测试 HTTP server 通过 `tests/renderer-server.mjs` 在宿主路由前服务清单资源；独立使用也可显式传入自定义 URL。构建验证与定向回归包括：

```sh
node scripts/build.mjs --skip-native
node --test --test-concurrency=1 tests/renderer-resources.test.mjs tests/frame-requests.test.mjs tests/browser.test.mjs tests/presentation-mode.test.mjs tests/init-autosave.test.mjs tests/save-request.test.mjs
```

renderer 内置少量 `performance.mark('office-xlsx:…')` 阶段证据：entry、宿主握手、main 动态导入、字体加载完成/超时、React render、runtime attach、生命周期阶段、初始内容加载和 ready。浏览器性能 harness 将这些 marks 写入原始 JSON；这些标记不提前触发计算或修改 ready 条件。

已定位的上游调度：Univer `SingleUnitUIController` 在 workbench 回调和 Ready 后固定等 300 ms 才 mount/activate 并进入 Rendered，再等 3000 ms 才初始化 Steady 特性。当前精确 build adapter 将这两个纯调度延迟改为可取消的绘制后任务；保留真实挂载、全部阶段订阅和完整 Steady 控制器。字体加载 3000 ms guard 不变。

host 仍要求完整 Steady、初始内容加载，并对自动公式模式显式核验初始完整批次的自然 calculation session 已完成且 resultApplied；不会为了 ready 主动计算。已有 preload 完成后的全批重算请求改为尽快释放，早于 Rendered 或已有计算尚在执行时仍等待；未收齐数据的 quiet debounce、手动模式及流式路径保留。`initial-calculation-requested/starting/applied` marks 区分批次收齐、实际启动和应用完成。宿主核验的是 session 的真实 resultApplied 状态；上游公开回调另有 requestIdleCallback 延迟，不代表结果仍未应用。

准确调用链、Steady 消费者、自然计算时序及后续 adapter 修复约束见 [首开诊断](FIRST-OPEN-DIAGNOSIS.md)。隔离的上游调度单元测试为 `tests/steady-scheduling.test.mjs`，不启动浏览器。

### 冻结版本：首开静态图与语言按需加载

本轮仅确认产物图和功能正确性，**native 收益待统一 embedded release 测量**。不能将 emitted 文件数当作冷请求数，也不能将代码字节减少等同于耗时收益。

| esbuild 静态 JS 闭包 | 调整前 / B | 冻结版本 / B |
| --- | ---: | ---: |
| renderer entry | 11,106,594 | 3,817,616 |
| entry + main 及其静态依赖 | 13,488,084 | 9,637,632 |
| 上述 entry + main 内的 i18n | 3,662,164 | 252,946 |

保存模块在非空 journal 的原 flush 串行锁内按需 import；输出模块在相应异步动作中按需 import，保留校验、取消、错误及原宿主回执，PDF 不进入首开静态图。打印仅在输出时将 stylesheet 相对字体 URL 转为内嵌 data URL，保持原字体字节，不增加首开工作。

默认首开仍承担 **zh + en** 的完整字典开销，其余 19 种语言按需加载；全部 21 种语言键和 app/dialog/AI 原始内容保留。非 zh/en 的首次启动在 `getLanguage()` 后、`setModuleLang` 和 React render 前等待完整字典。语言切换沿用 `onLanguageChanged`，同时 gate React 与右键菜单：加载期间显示完整旧语言，完成后发布新语言；快速切换丢弃过期交付，取消订阅阻止待决交付。其他语言每帧按语言缓存 promise/模块，成功字典每语言加载一次；不预取全部语言、不添加自动重试。缺失 chunk 保留旧语言并经既有 MessagePort 向宿主发出 `office-error`，首次加载错误拒绝 ready。当前 File adapter 的默认 `getLanguage` 仍为 zh，未修改语言保存或权威来源。适配只通过带固定匹配校验的 build adapter 进行，vendor 不变。

冻结验证为 **13/13 确定性 + 10/10 定向集成检查**，包级 TypeScript 通过。13 项入口是 `renderer-host-deferred-actions.test.mjs`、`initial-calculation.test.mjs`、`locale-adapter.test.mjs`；10 项入口是 `full-renderer.test.mjs`、`initialization-browser.test.mjs`、`output.test.mjs`、`pdf-output.test.mjs`、`print-output.test.mjs`、`renderer-resources.test.mjs`、`locale-browser.test.mjs`，串行运行，含 Chromium/WebKit 打印。完整可复制命令、覆盖边界和失败修复记录见[首开诊断的冻结验证](FIRST-OPEN-DIAGNOSIS.md#verification-at-freeze)。这些是功能检查，不是浏览器或 Tauri 的正式性能数据。

证据汇总为 `tests/output/lazy-locales-validation.json`；原始当前构建图为 `dist/renderer-meta.json`，初始化记录为 `tests/output/initialization-functional.json`，编辑草稿/截图及打印 HTML/几何/截图也在 `tests/output/`。原始 TAP 在本次实现任务的命令记录中，未另存独立日志；汇总 JSON 不冒充完整 raw。详细文件名与归档限制见[首开诊断](FIRST-OPEN-DIAGNOSIS.md#verification-at-freeze)。不为本次文档交付重新运行构建、浏览器或 native。

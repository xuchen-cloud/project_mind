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
| `dist/browser.mjs`, `browser.css` | 自包含完整 iframe renderer，React wrapper 由根 Vite 消费 |
| `dist/renderer.html`, `renderer-meta.json` | 完整 Web renderer 与构建输入证据；HTML 已嵌入 browser bundle |
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

`mount/mountEditor(container,props)` 返回 `{ready,commitEditing,update,dispose}`。`ready` 等待完整 App/Univer Steady；所有保存先 `await commitEditing()`，再读取最新 edits，进入 saving 后才设 readOnly。React `XlsxEditor` 保留：

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

选择或打开未改变单元格不产生 pending；真实输入产生 pending，journal 发送后才结算。专属 MessageChannel 在严格且仅一次的窗口握手后建立，避免 WebKit 异步 reply 的 WindowProxy 来源差异；替换/销毁关闭旧通道。已接收的异步请求捕获发起帧 epoch/callback，执行 host IO 前核验仍当前，回执只发原 port。model 引用替换表示原生保存成功后的新基线，宿主同时传 `edits:[]`。App 保存按钮必须接 `onSaveRequest` 到原 File 保存，不通过 renderer 自行写文件。

导出优先等待 `onExport`：true 写入完成，false 用户取消；取消不会再触发 anchor。只有 standalone 无宿主 callback 才用 anchor。CSV 是当前真实字节导出路径，保留单工作表/公式与格式损失提示。PDF 复用官方分页打印 HTML，每页从官方分页结果获得实际有向 pt 尺寸，按连续尺寸组等待 `onRenderPdf` 的有效 PDF bytes，包内 pdf-lib 保序合并为一次 `onExport`；无宿主 PDF 生成器时明确报错，不把浏览器打印当可编程 PDF。

打印使用官方分页后的 cells/visuals/page setup HTML，经资源检查、内嵌字体与图片后等待 `onPrint`。只在 standalone 无 callback 时创建打印文档 frame 并调用其 `window.print()`。本包不调用 Tauri、不接收任意路径；实际 native 打印由宿主实现，headless 浏览器验证不代表 WKWebView 已交付。

## 主题、交互与验收

应用 frontend-design，并遵循现有 `.impeccable.md` / design-system：宿主真实 tokens，文档自身样式独立，连续边缘遮罩、有界列表尺寸/内容观察与 reduced-motion。完整官方工具栏、对话框、图片/图表/形状/表格/透视/迷你图/保护/页面功能均在生产 renderer；接入与逐项通过验收分别记录在矩阵。

针对性验证入口为 `tests/engine.test.mjs`、`parity.test.mjs`、`browser.test.mjs`、`full-renderer.test.mjs`、`output.test.mjs`、`print-output.test.mjs`、`pdf-output.test.mjs`、`query.test.mjs`、`save-request.test.mjs`、`import-workbooks.test.mjs`、`capture-screen.test.mjs`、`document-settings.test.mjs`、`worksheet-structure.test.mjs`、`rules-and-notes.test.mjs`、`frame-requests.test.mjs`。UI 通过真实 headless 操作、原字节保存重开；帧请求用公开 MessagePort 投递复现同步切换/销毁与异步 host IO 的竞争。不用私有 editor API 模拟按钮成功。可用 `OFFICE_WEBKIT_EXECUTABLE` 指定已安装 WebKit。临时截图、日志、draft/print HTML 在忽略的 `tests/output/`。

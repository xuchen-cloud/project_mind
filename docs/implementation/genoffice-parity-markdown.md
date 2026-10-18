# GenOffice Markdown 编辑交付 — #191（父 #118）

## 2026-10-18 用户撤除图床工作包（已完成，源码冻结）

- 关联 #191 / 父 #118。用户明确不需要图床设置与上传；本节取代此前图床工作包的交付状态与外部凭据待办，图床不再是当前交付或待解锁项。
- 依赖与分工：主撤除宿主、全局 DTO/services 和原生注册；本包只改 Markdown 组件、独立包与本文，不改根依赖/宿主/原生。
- 交付：删除图床设置 UI、公开 imageHost 类型/prop、上传准备分支、HTTPS 图床读取/失效缓存与专属测试；保留本地选图、source/rich paste/drop 的 data 图片、读取取消和保存等待、源码保真及既有导出/打印。
- 非目标：图床设置、凭据管理和上传（用户本次明确排除）；继续沿用独立 App 管理/更新/重复 AI 聊天的排除范围。暂停新的方言/DOCX 差距实现；不保留新增调查文档，只在原矩阵记录已核实限制。
- 验收：公开编辑器本地图片实际输入/预览/保存重开，旧 FileReader 回执丢弃、pending 释放；远端引用不交给 resolver 或直接加载；受影响导出/保存取消合同不退化。只跑包内图片/资源/导出定向用例、typecheck/UI 检查，不运行根全量、Cargo 或可见应用。未变化的固定源码与分页/原生波形证据复用。

## 工作包

- 关联：[子 Issue #191](https://github.com/xuchen-cloud/project_mind/issues/191)、[父 Issue #118](https://github.com/xuchen-cloud/project_mind/issues/118)；分支 `codex/genoffice-editor-parity`，共享工作树。
- 依赖：`genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`；主 agent 的 `file_text_save` / CAS / `MarkdownFileContent` 宿主、根依赖及最终发布。
- 交付行为：公开 React `MarkdownEditor`；真实源码与块编辑、预览/分屏、格式工具栏、查找替换、行定位、撤销重做、大纲、缩放、表格/图片/公式/图表和块移动；新增 DOCX/PDF/PNG 导出及专用打印 HTML；完整字符串是原文件保存边界。
- 非目标：完整独立 App 的文件管理、更新与重复 AI 聊天（包括其 AI 隐私流程，由用户补充明确排除）。图床设置、凭据管理与上传也由用户本次明确排除。其他未接入能力列入下方具体差距，不将其改写为非目标。
- 归属：仅 `src/components/markdown/**`、`packages/markdown-editor/**`、本文；不修改主宿主、根依赖/lock、DTO 或 Rust，不执行 checkout/commit/reset，不运行根全量 build/test，不启动可见应用/Tauri watch。

### 2026-10-18 本轮增量验收

- 交付：split/preview 的 Mermaid/WaveDrom 实际 SVG；无效图表保留可读源码并显示具体错误；不加载图表外部资源，快速换基线不能显示旧异步结果。
- 依赖：复用本包已锁定的图表 renderer、DSH Markdown parse/render 与 DOMPurify，不新增根依赖。原生打印/PDF payload 增加 A4 的 `pageSize`（pt），HTML 使用相同纸张尺寸；宿主 DTO 由主 agent 接入。
- 验收边界：公开 MarkdownEditor 切模式、只读源码与 onChange、外部 documentKey 替换、真实 SVG；打印/PDF 回调检查物理尺寸。新增定向 TDD、一轮静默浏览器、包 typecheck 与受影响 UI 规范检查；复用未变化的既有证据，不运行根全量。
- 原生目视追加阻塞：主用正式 helper 消费实际 callback HTML 后，WaveDrom 文本/网格有输出但 use 波形全部丢失；文本提取不能证明几何完整。本轮追加只修导出准备的矢量 local-use 展开，保留源字符串；定向红绿、真实 callback 浏览器几何与同一 native helper PDF/PNG 复验，不重编译 Cargo。
- 纸面体验追加：实际产品模板仅有 `@page margin:2cm`，原生零边距覆盖后正文贴边。Markdown 专用打印/PDF HTML 需自行提供每页 20mm 留白与 170mm 正文宽度，长文跨页也应保持；保留矢量、文字和源字符串。验收仍为公开 callback 文档 + 多页正式 native PDF 几何/目视，仅运行受影响合同与包 typecheck；不改通用宿主或其他格式边距。
- 图片异步追加：以延迟真实 FileReader 回执核验原有 paste 的 `preventUpdate` guard；覆盖 documentKey、只读与卸载，pending 必须释放，当前文档输入仍可保存。仅修复已复现的卸载延迟销毁窗口及顶部选图 reader 未取消问题，不新增重复 epoch 框架，不涉及图床/凭据或宿主服务。

## 复用调查与固定来源

上游 `apps/markdown/package.json` 为 private Electron App，没有公开的嵌入组件/SDK exports。`vite.renderer.config.ts` 支持 renderer Web 开发，App 本身依赖 `window.markdownApi` IPC。实际可复用的是 Tiptap 3.31 编辑扩展、块操作、斜杠菜单、sourceSplice、Markdown style serializer、公式/图表节点与查找适配器；这些已经提取复用，不重写成静态预览。

主/research agent 负责现成 Web/Tauri 适配检索，包括 `Nothing1024/dsh-genoffice` 与 `dsh-genoffice-engine` 的浏览器桥。本文包未宣称检查到独立可直接替代的 Markdown SDK，也未切换其来源基线或复制 relay；原生 File/CAS 保存仍由主宿主负责。本包复用的安全预览是仓库已经集成的 DSH `MarkdownText` 及授权资源处理。

[包 README](../../packages/markdown-editor/README.md)、[source-lock](../../packages/markdown-editor/source-lock.json) 记录原始 93 文件 SHA-256、Apache-2.0、LICENSE/NOTICE 和可重建命令。原始副本与生成适配分开保存；`sync-upstream.mjs --check` 同时核对来源与确定性变换。新增上游 DOCX exporter 所需的 docx-engine / zip-gate / custgeom 实际依赖闭包，`build-exports.mjs` 生成浏览器 bundle 并核对输入与许可证；不依赖其他 agent 的私有 vendor 路径。手写 localImage adapter 对应的原始文件亦锁定保存。

## 公共组件契约

```ts
interface MarkdownEditorView {
  mode?: 'source' | 'split' | 'preview' | 'rich';
  zoom?: number;
  scrollTop?: number;
  previewScrollTop?: number;
  outline?: boolean;
  outlineWidth?: number;
  sourceMode?: boolean;
}
interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  readOnly?: boolean;
  resources?: Record<string, string>;
  resolveResource?(reference: string): Promise<string | undefined>;
  documentKey?: string | number;
  line?: number;
  initialView?: MarkdownEditorView;
  sourceMode?: boolean;
  onViewChange?(view: MarkdownEditorView): void;
  registerBeforeSave?(flush: () => Promise<void>): () => void;
  onPendingChange?(pending: boolean): void;
  onExport?(file: {name: string; mime: string; bytes: Uint8Array}): Promise<boolean>;
  onPrint?(document: {html: string; title?: string; pageSize?: {widthPt: number; heightPt: number}}): Promise<void>;
  onRenderPdf?(document: {html: string; title?: string; pageSize?: {widthPt: number; heightPt: number}}): Promise<Uint8Array>;
}
```

- 默认 `split`，源码一直挂载；块编辑首次使用后保持挂载。模式切换不通过 HTML 反推持久化源码。
- 外部 `value` 替换同步但不发出 onChange。`documentKey` 仅随外部文件/版本/基线改变，重置两种编辑器历史；普通保存确认不改 key，同一已发出 source 的确认保留本地 undo。
- `readOnly` 对源码、块输入、查找替换、格式、表格、拖动和公式浮层写操作同时生效。
- `registerBeforeSave` 等待 IME 与图片 paste/drop 的 FileReader 输入落入正文；顶部选图等待处理完成，只有用户点击插入才写正文。版本替换、只读和卸载取消旧输入并释放 pending。
- `resources` 为宿主已授权资源映射；`resolveResource` 仅接收相对引用，不接受 HTTPS、file 或其他协议/绝对路径。预览和导出只使用授权 data/blob 或安全 raster data，不直接读取网络或任意路径。每文档本地缓存与外部基线旧结果丢弃保持；主 agent 负责 readRelated 的预算/归属核验。
- `initialView` 的额外字段可由父 schema 选择保存。自身 sourceMode 确认不会将 rich 错误覆盖为 split。

### 源码往返策略

未修改内容不 normalize。CodeMirror 视图使用 LF 坐标，保存字符串按原始坐标 splice，未改 BOM、混合换行、尾空格与原始文字保留。块编辑从上游 `parseDocText` 提取 envelope/body，保存使用原 source map 与 style serializer，仅变更片段写回；新换行采用原文首次出现的换行风格。预览同样只渲染 body，YAML 在属性面板/源码中保留，不显示为正文。

块模型无法保证任意 HTML 或第三方 Markdown 方言的全编辑无损；变更块/重排块可能采用上游序列化规范。源码模式始终可用；不把无损 no-op 扩大宣称为所有渲染编辑均逐字节保真。

## 根依赖

由主 agent 安装并统一根 Tiptap 为 3.31.0，React optional bubble/floating menu 同样 pin 3.31.0。CodeMirror、Mermaid、WaveDrom、JSON5 与 KaTeX 类型均已提供；完整固定版本清单见包 README。新增导出依赖只装在本包并有独立 lock：html-to-image 1.11.13、pdf-lib 1.17.1、jszip 3.10.1、fast-xml-parser 5.3.4、utif2 4.1.0；重建 esbuild 0.25.12。未改根依赖/lock。共享笔记模块的 Tiptap 升级回归由主 agent 负责。

## 上游逐项功能对照

“已接入”表示存在真实操作路径；自动化/浏览器具体证据单列，不代表每种语法组合均穷尽验收。

| 上游能力 | 当前交付与验收 | 具体限制/剩余 |
| --- | --- | --- |
| 源码编辑、选择、复制粘贴、拖放文字 | CodeMirror 真编辑；Chrome/WebKit 中文输入、选区加粗、undo/redo；混合 BOM/EOL 原始 splice 与真实字节重开 | 不承担编码检测（宿主负责） |
| Tiptap 块编辑 | 固定上游内核；真实中文输入与工具栏改写 source；no-op 不回写 | 任意方言/HTML 改动不保证全字节等同 |
| source / rendered 视图切换 | source / split / preview / rich 四模式；sourceMode 宿主确认不打断 rich | 视图字段是否持久化取决主宿主 schema |
| 标题 H1–H6、正文、引用、代码块 | 源码前缀/选区命令与上游 uiOp；真实写回可撤销 | 各标题层级未逐一浏览器穷举 |
| 粗体、斜体、删除线、行内代码 | 真实选区与块 mark；源码包裹仅插入定界符，避免更改所选原换行 | 含反引号源码采用上游 fenceCodeSpan 长度与 padding；undo 恢复原 EOL |
| 链接 | 选区 setLink；空光标可插入带链接文字；拒绝 javascript/vbscript 插入 | 没有额外复制独立链接管理器 |
| 无序/有序/任务列表、嵌套 | 上游列表与键盘；任务复选；源码前缀 | 源码前缀操作用于当前行，复杂嵌套可直接编辑 |
| 表格插入、行列添加/删除、表头、删除表格 | 原 TableMenu 与命令；真实 DOM 插表/增行/只读验证；有序列表插表保持起始编号 3 与原项 | Markdown 本身不表达跨行跨列/列宽，上游亦只提供可序列化操作 |
| 图片插入、paste/drop | 目标路径、文件选择、源码/块 raster paste/drop；本地 data 与授权相对资源，真实预览/保存重开；旧读取取消/pending 释放 | 首个支持 raster，4 MiB 本地图片读取上限 |
| 列表中插入图片/块 | 修复上游 selection anchor 的隐式 lift：插到完整顶层列表之后；任务项勾选/编号/原文不变；真实文件重开 | 不将同一个列表拆为插图前后两段 |
| 块拖动、上/下移、复制/删除 | 上游 gutter 与快捷键/菜单；headless Chrome 原生拖动已改变顺序；调整 gutter 不覆盖正文 | 外层应用布局与多尺度综合截图由主 agent 汇总 |
| 斜杠菜单 | 上游 suggestion/menu；键盘筛选 `/h2`、Enter 与输入已浏览器验证；共享连续滚动区域 | 新菜单标签沿用中文适配 |
| 数学公式 | 上游 KaTeX 与 TeX 编辑浮层；Chrome 插入 `E=mc^2`；只读关闭浮层/禁止写回 | 部署字体资源由主 Vite 构建处理 |
| Mermaid / WaveDrom | split/preview 复用 DSH 整文档 parse/render，仅替换图表代码块；rich/打印使用相同原 renderer 与安全 SVG 适配。Chrome 实测流程图 421×97、波形 320×60，预览中 24 个内部 use 有真实几何；打印准备再展开为实际矢量 path，WK/AppKit 原生 PDF/PNG 波形已目视通过；无效代码显示解析错误与源码；切文档丢弃旧异步结果，不回写原文 | 不执行图表内活动 HTML、图片节点或外部 CSS 资源；本地 themeCSS/普通标签可用，原代码仍可编辑。任意外部图片应走宿主授权 Markdown 资源 |
| 查找替换、大小写/整词 | 上游 Unicode-safe 查找适配；真选区/替换/全替换，一次 undo，replacement `$&` 保持字面 | 非正则搜索，与当前上游一致 |
| 行定位与大纲 | 可输入行号、跳转源码；解析 ATX/Setext/行内格式标题、跳过代码围栏；点击定位与 pointer/键盘调宽；不改文档 | 宿主可选择持久化 outlineWidth |
| Frontmatter | 与上游一致的原始 YAML 面板；预览不渲染 metadata；未改前缀保真；清空内容移除 envelope 并保留 BOM/正文 | 不经过 YAML 对象解析 |
| 撤销重做、版本切换 | 真 history；同值正常保存确认保留 undo；documentKey 替换（含同内容历史）清空旧历史 | 源码和块编辑分别维护其引擎历史；跨模式改写重新加载另一引擎 |
| 拼写、缩放 | 原生 spellcheck 开关、50–200% 与快捷键；Chrome 缩放操作 | 依赖平台可用词典 |
| 主题/窄窗/滚动 | 仓库真实 color/font/motion token；Lucide；reduced-motion；编辑区/工具栏/大纲/斜杠菜单连续边缘遮罩 | 上游内置图表保留固定内容配色 |
| DOCX / 转换到 Word | 原 `exportDocxBytes`、原 docx-engine；当前草稿解析后输出真正 OOXML；宿主回调或 standalone 下载 | 转换入口交付 DOCX；上游 inline math 为可见 TeX，ordered start 固定为 1，表格图片为 alt。当前 DOCX 图表 callback 的默认 SVG 清洗会删除 WaveDrom use，可能仅留文字无波形；尚未修复，不以 preview/native PDF 的波形通过代替 DOCX 验收。新出口实现暂停 |
| PDF 原生排版 | 新公开 onRenderPdf：真实字体/图片内嵌 print HTML → 等待宿主排版字节 → onExport；组件不转 canvas、不重写返回 PDF。回调、文件字节重开、取消/错误与基线替换合同通过；主已全接 native callbacks。最新 margin callback 已用正式 macOS helper 生成 27,788 字节单页与 80,445 字节 12 页 PDF，文字/波形/各页留白目视通过 | 本 fixture 的实际原生证据见末节；其他文档的综合排版、Windows 与系统打印面板仍由主汇总；合同 fixture 不冒充原生生成证据 |
| standalone PDF / PNG 图片 | 无 onRenderPdf 的浏览器沿用 192 DPI A4 分页栅格 PDF；单页 PNG、多页 PNG ZIP；真实中文/表格/任务/图/公式文件已检查 | 仅 standalone PDF 不能选择文本。分页尽量避开行/图片/表格行，超一页的巨大块仍可能分割 |
| 打印 / Cmd-Ctrl P | 真打印 HTML；主 MarkdownFileContent 已接 printEditorHtml → desktopApi → native command；KaTeX WOFF2 / 图片 data 内嵌。编辑器到真实 service/IPC 边界的等待/失败测试通过；无回调才 iframe print | 当前主原生实现为 macOS WKWebView/AppKit runOperation、Windows WebView2 ShowPrintUI；本包未启动系统弹窗，Windows 无测试机；Windows afterprint 仅证明交互结束，不证明纸张输出 |
| 导出宿主桥 | 主 MarkdownFileContent 已接 exportEditorFile；真实 service/desktopApi 到 IPC 的 DOCX 字节写盘/重开、等待写入确认、取消/错误均通过；readonly 可导出 | 测试仅替换 Tauri native IPC，不等于真实系统 dialog/writeExportFile 验收；有回调绝不回退 anchor。实际原生交付由主 agent 汇总 |
| 图床上传/配置 | 用户明确不需要，已撤除组件 UI、公开 callback、上传路径、HTTPS 图床读取及专属测试 | 当前非目标，不再以账号/凭据列待解锁项；原始固定上游副本仅作出处保留 |
| 隐私遮蔽 mark / AI 流程 | 原 mark/parser/serializer 可识别已有标记 | 用户明确将重复 AI/AI 隐私流程排除，不移植第二套聊天；不宣称本包提供宿主 AI 内容保密隔离 |
| 保存/另存/自动保存 | 组件提供最新字符串与 beforeSave，主宿主管理 native CAS | 独立 App 的 Save As/自动保存偏好未复制到编辑器工具栏 |
| 独立管理、更新、重复 AI 聊天 | 主应用统一承担 | 已声明非目标 |

## 导出菜单、原生桥与资源

核对固定上游 `apps/shell/src/main/index.ts` 的 Markdown File 菜单：`docx`、`pdf`、`png`、`docs` 和单独 print 均有入口。`docxExport.ts`、`exportImage.ts`、`printHtml.ts` 已实际复用；原 Electron PNG 经 printToPDF/pdfjs 转页，浏览器适配用 html-to-image 同等 192 DPI 排版转页，再用 pdf-lib / JSZip 输出文件，不伪装 Electron IPC。导出模块按用户点击动态加载，不改 Markdown 字符串，不调用业务原文件保存。

- `onExport` payload、`onPrint` payload 和原生 PDF 回调类型从公开组件导出为 `MarkdownExportFile` / `MarkdownPrintDocument` / `MarkdownPdfRenderer`。主宿主已接 native export/print 服务；无回调的独立浏览器才使用 anchor 或 `iframe.contentWindow.focus(); iframe.contentWindow.print()`，等待 afterprint 释放 iframe。
- `MarkdownPrintDocument.pageSize?:{widthPt:number;heightPt:number}` 为物理 pt，实际 print/PDF payload 均给 A4：`210*72/25.4 × 297*72/25.4`（约 595.276×841.890）；同一生成点写入 HTML 的 `@page { size:210mm 297mm }`，覆盖上游交给 Electron 选择纸张的 auto，不按屏幕像素换算。主负责 shared service DTO/原生消费。
- `onRenderPdf` 复用与 native print 相同的自包含 HTML。先等待真实排版结果，再将原始 Uint8Array 交 onExport；排版/嵌入失败直接报告，不静默退回栅格 PDF。宿主存在回调时菜单说明为“PDF 保留文字排版”，没有时明确“PDF 为分页图像”；PNG 仍为 192 DPI。外部 documentKey 替换后丢弃正在返回的旧 PDF，不交新会话保存。
- 图片只取宿主授权映射、安全 raster data 或绑定 resolver 的相对引用；HTTPS 不提交 resolver，不直接发网络请求。导出逐项解析相对资源，缺图保留 alt 并报告；native print 缺图或 SVG 隐含外部资源直接报告具体项。
- native print HTML 内嵌实际 KaTeX WOFF2（只从本应用同源打包资源读取），不含 `<base>` 或编辑控件。没有公式时不附带未使用的 KaTeX 字体。字体读取失败不回退到无字体的系统打印。
- 图床设置、凭据管理和上传按用户最新指令撤除，不作为剩余交付或外部解锁条件。本地选图、paste/drop、data 与纳管相对资源保持可用。

## TDD 与实际验证

预先约定 seam：React 编辑器用户操作与 `value/onChange`、保存守卫、真实文件字节保存重开。未对生成的内部函数逐层镜像测试。

- 红绿记录：源码选区包裹曾改写混合 EOL；修为定界符 splice。新 data 图片曾被安全 preview 丢弃；在授权映射中纳入安全 raster 引用。空光标 rich 链接曾无文字；插入真实 link text。frontmatter 曾显示为 hr/标题；统一 body 渲染。公式浮层曾跨只读；即时关闭。Setext 大纲与围栏过滤、含反引号代码 fence、清空 YAML 移除 envelope 均通过各自红绿用例。图片 paste pending 曾绕过保存等待；纳入 pending 并取消外部基线旧输入。
- 主浏览器报告任务项插图后解除列表。新增用例真实复现 2 项降为 1 项，修复 selection anchor 后任务项、勾选、CRLF 与实际文件重开通过；补有序列表插表不改编号/内容。
- 新导出红灯先由公开编辑器缺少导出入口复现；接入后真 DOCX 写盘/重开 ZIP 校验标题、bold、table、hyperlink 与 media。再覆盖最新宿主回调实际写盘、await 确认、取消/错误不 anchor、外部 documentKey 取消旧导出、专用 iframe 准备/释放、native print 真字体字节内嵌与具体资源错误。Vitest 明确处理 KaTeX CSS，避免默认 CSS stub 使打印断言失真。
- 新增 desktop-export 5 项从公开编辑器贯穿真实 exportEditorFile / printEditorHtml / desktopApi，仅用 Tauri 官方 mockIPC 替换原生进程：DOCX 真实写盘重开与写入完成等待；原生 dialog 取消、写入失败；20 个有效 WOFF2（wOF2 文件头）与 data 图的实际 HTML 写盘，等待 print invoke 完成；原生取消/失败不得报成功或浏览器打印。它们不是对 native OS 弹窗的模拟验收声明。
- onRenderPdf 首个合同用例先红：回调未调用且误走 browser raster；实现后通过。4 项覆盖最新 props/readOnly、内嵌字体/图片与 metadata 排除、先等待排版再等待真实文件写入、返回 PDF 字节不变且可重开、排版失败/保存取消不降级、外部基线更换丢弃旧返回值。返回 fixture 是含文本 PDF；组件保持这些字节，不将其重新栅格化。真实原生排版生成与文本选择性仍需主服务验收。
- 当前针对性命令：`npm --prefix packages/markdown-editor test`；`npm --prefix packages/markdown-editor run typecheck`；`npm --prefix packages/markdown-editor run verify:vendor`。最终结果见下方收口。
- UI standards 用仓库原 checker 对 `src/components/markdown` 临时完整副本执行，仅验证本包，不改 checker、不加豁免；所有颜色/emoji/raw motion 违规已修复。
- 独立 headless Chrome：源码中文、选区格式、rich 输入、slash h2、native gutter drag、zoom、Mermaid/WaveDrom SVG 与公式插入。截图保留在本地 `packages/markdown-editor/output/playwright/`（不入版本库）。初次验收 harness KaTeX 字体 403 已通过明确 fs allow 修正，仅为 isolated harness 配置。
- 连续滚动实际读数：源区 top=0 时遮罩 0/1，top=32 时 .5/1；中间 1/1；距底 32 时 1/.5；底部 1/0；反向回顶 0/1。删除到一段并调整视口后为 0/0。遮罩不拦输入/点击/拖动与滚动条。
- 主 agent 另报告列表第二 task 插 data 图片仍保留两项（`output/playwright/markdown-parity/list-image-fixed.json`）；600px WebKit 分屏纵向布局、toolbar 遮罩 0/1 → .125/1 → 1/0；资源正确 File/cache、错误 owner 与真实 4 MiB 预算测试通过。真实 Chrome/WebKit 中文输入、粗体、undo/redo、save/reopen、BOM/CRLF 与 inline data 图片预览通过；主宿主 CAS/历史/保存测试由主 agent 汇总，本文不把包内 fs 测试等同原生端验收。

## 变更文件

- `src/components/markdown/MarkdownEditor.tsx`、`SourceEditor.tsx`、`RichMarkdownEditor.tsx`、`MarkdownPreview.tsx`、`MarkdownOutline.tsx`、`MarkdownExport.tsx`、`useDraftResources.ts`、`scrollEdges.ts`、`markdown-editor.css`。
- `packages/markdown-editor/{README.md,package.json,.gitignore,source-lock.json,sync-upstream.mjs,tsconfig.json,vitest.config.ts,preview.html,preview.tsx,preview.vite.config.ts}`。
- `packages/markdown-editor/tests/{setup.ts,editor.test.tsx,source.test.ts,export.test.tsx,desktop-export.test.tsx,native-pdf.test.tsx,preview-diagrams.test.tsx}`。
- `packages/markdown-editor/{package-lock.json,build-exports.mjs,EXPORT-THIRD-PARTY-NOTICES.md}`，`src/export/{document.ts,browser.ts,diagram-language.ts,upstream-docx.mjs,upstream-docx.d.mts}`，生成的 `src/genoffice/export/**` / `shared/export-image-mime.ts`。
- `packages/markdown-editor/src/adapters/{ui.tsx,localImage.ts,SafeMarkdownPreview.jsx,SafeMarkdownPreview.d.ts,PreviewDiagram.tsx,diagramPreviewSafety.ts,find-text.ts}`、`src/source.ts`、`src/genoffice/i18n/locale.ts`。
- `packages/markdown-editor/upstream/**` 的 93 原始文件与对应 `src/genoffice/**`、`src/agent-core/**` 生成结果，逐文件记录在 source-lock；localImage 原始副本只作 provenance，运行使用手写 adapter。
- 本文。未改其他 agent 拥有文件。

## 收口

2026-10-16：补齐导出/打印组件与桥；9 个新增导出定向用例通过。实际浏览器产物在本地 `packages/markdown-editor/output/playwright/`：`export-browser.docx`（已由现有 Word 包 public inspect 重开）、`export-browser.pdf`（PDF 1.7、A4）、`export-browser.png`（1588×2246）、`export-multipage.zip`（5 个实际 PNG，第一页及末页检查）、`native-print-prepared.html`（真实宿主回调专用 HTML）。standalone print 准备记录证明字体 loaded、图片 decoded、公式/图表存在、无控件/metadata，不能作为 macOS 系统打印弹窗证据。

00:36 本范围 3 文件 **31/31 通过**（原 22 编辑验收 + 新 9 导出/打印验收）。00:43 接线定向 **5/5**，00:44 在主新 jsdom selector patch 环境集中 `npm --prefix packages/markdown-editor test` 4 文件 **36/36 通过**（5.46 秒）。00:47 新 `tests/native-pdf.test.tsx` **4/4 通过**；按主要求复用其余已通过证据，共 40 个不同用例。未把两次运行记为一次全套。引入真实 service 测试后包 typecheck 需要显式纳入项目既有 `src/types/pdfkit-standalone.d.ts`，仅改本包 include；00:47 `typecheck` 通过。`verify:vendor`（93 来源文件、确定性适配、731124 字节 exporter bundle 和完整依赖许可）复用 00:36 结果，来源/生成脚本/bundle 未改。

`output/playwright/export-evidence.json` 继续记录实际浏览器文件大小、SHA-256、PDF 页尺寸、5 个 PNG 名称和真实 onPrint payload 检查；最后的原生专用 HTML 含 20 个 WOFF2 data 字体、可解码 16×16 内嵌图、公式，0 外部 CSS URL / script / base / 编辑控件。此处浏览器 PDF 是旧 standalone 路径产物，不作为新增 native PDF 产物证据。新增菜单说明后已用仓库原 checker 检查 `src/components/markdown` 临时完整副本，UI standards 通过，无豁免；本轮文档本地链接与手写改动空白检查通过。

主已确认 onExport / onPrint / onRenderPdf 原生回调全部接入。当前剩余：主汇总原生 PDF 系统生成文件、导出 dialog/write 和系统打印实机验收（Windows 无测试机）、任意方言块编辑字节保真边界。**不据阶段增量单独关闭 #191/#118 或宣称上游全功能完成**。本轮未运行根全量 build/test，未写宿主/Rust，未启动任何应用窗口或验收 server/browser；复用已有真实下载证据。根构建对本包锁定依赖的 npm ci / verify:vendor 接入由主 agent 负责；本包至此停止代码改动，沿用已通过验证。

## 2026-10-18 恢复核对与输出契约收口（预览增量之前）

- 沿用 #191 / 父 #118、原文件归属与共享工作树。无重置、提交、根全量验证或窗口。根 `build-office-runtime.mjs` 已先安装本包锁定依赖再执行 `verify:vendor`；`MarkdownFileContent` 已将三个真实 native service 传入公开组件，本包不再改这些主负责文件。
- UI 组件、样式与仓库 checker 均保持 10 月 16 日收口版本，沿用已通过的本范围 UI standards；未再次扫描全仓。93 文件来源、确定性生成脚本与 exporter bundle 未变，沿用 vendor 结果。
- 新增且只运行 `desktop-export.test.tsx` 中 `round-trips native PDF base64 through the connected services to exact on-disk PDF bytes`：真实 MarkdownEditor → renderEditorPdf / desktopApi → Tauri mockIPC → exportEditorFile / desktopApi → 实际文件写入、PDF 重开。仅替换 native IPC；先等待排版返回，再等待写入确认，含二进制 PDF 经 base64 往返仍完全相同，无 anchor/iframe 栅格回退，无原 Markdown 改写。回调返回的是含文本 PDF fixture，未冒充原生系统生成文件。
- 实际命令（工作目录 `packages/markdown-editor`）：`../../src-tauri/resources/agent-host/node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/desktop-export.test.tsx -t 'round-trips native PDF base64'`，打包 **Node 24.21.0，新增 1/1 通过，5 项跳过**（1.96 秒）。原 40 个不同用例按主要求复用，本轮累计证据为 41 个不同用例，不称为 41 项重新全跑。新测试临时目录只在本包 output 中创建并清理。
- 新测试改动后使用同一打包 Node 执行包内 `tsc --noEmit -p tsconfig.json`，通过。未改变生产编辑器源码、组件契约或依赖。保留在包内的 5 个浏览器导出/打印 HTML 文件逐一核对大小与 SHA-256，均与 `export-evidence.json` 相符；未依赖已清理的旧 /tmp 文件，也未重启浏览器或下载运行时。
- 本轮变更仅 `packages/markdown-editor/tests/desktop-export.test.tsx`、本文及包 README。现阶段具体差距如下。

| 类别 | 真实缺口与下一步 |
| --- | --- |
| 原生输出验收（主/native agent） | [原生宿主记录](genoffice-print-host.md) 与本文末节分别记录宿主和本轮实际 callback 的证据。最新 A4/SVG HTML 已由正式 macOS helper 消费，波形缺失修复后 PDFKit PNG 目视通过。Windows SYSTEM 面板完成事件及 CDP PDF 运行仍缺实机证据，macOS 系统打印面板未人工验收。 |
| 预览实现（Markdown 范围） | 本轮已补齐，具体源码、SVG 安全边界和红绿/浏览器证据见下节；不再作为未实现能力列出。 |
| 图床实现与外部解锁（历史条目，现已排除） | 用户最新明确不需要，组件支线已撤除；不再安排设置/凭据/上传/读取接线。 |
| 原格式/上游边界 | 任意 HTML/第三方 Markdown 方言的 rich 改写不承诺全字节保真；DOCX 沿用上游公式/图表映射限制；无 native callback 的 standalone PDF 是 192 DPI 栅格；“转换 Word”当前交付 DOCX 下载。具体边界保留在矩阵，不扩大为全功能完成。 |

## 2026-10-18 预览图表与 A4 callback 增量收口

### 实际实现

- DSH 原有 settled parse/render pipeline、数学公式、引用、脚注和授权图片策略保持；只将识别的 Mermaid/WaveDrom CodeBlock 替换为异步图表。嵌套引用/列表也在同一整文档上下文中处理，空围栏有具体错误。
- 复用固定上游 `diagramLanguage/renderDiagram`，不重写图表引擎。等待时保留可读代码，失败显示 renderer 的具体语法错误；取消订阅与 source/language 核验丢弃旧结果，外部 documentKey 更换重新挂载预览。图表只读字符串，不触发 onChange。
- 新 SVG 边界先拒绝可能在 Mermaid 临时 DOM 布局时加载资源的语法，再用 DOMPurify 过滤脚本/活动标签、SVG 外部 href 与 CSS URL。允许内部 `#fragment` 的 use，保留 WaveDrom 实际波形。安全适配也确定性接入 rich 与打印，避免第二次过滤删除波形；本地 themeCSS/普通 `image: 说明` 标签仍可用。没有自行加载 remote/file 图像或执行 WaveJSON 函数。
- `MarkdownPrintDocument` 与两个 callback 公开类型新增可选 pageSize；实际两条路径均生成 A4 pt 与同尺寸 @page，字体/图片内嵌、完成等待和字节原样保存策略保持。没有新增依赖、宿主/Rust/根文件改动。

### 红绿与定向结果

打包 Node **24.21.0**，以下均在本包运行；没有根全量 build/test。

- `preview-diagrams.test.tsx` 首例先红（只有代码块、没有图表），实现后 **7/7 通过**。覆盖公开 source→split→preview、两种真实 renderer/readonly/no-op、nested/reference/footnote/math、无效/空代码、普通 value 替换及 documentKey 替换的延迟结果、安全过滤与 rich→实际 print callback 的波形几何。jsdom 只补 SVG layout API，不伪造图表输出；竞态仅在真实 Mermaid render 返回后暂缓结果交付。
- 第七项在修复前先红：原 DOMPurify SVG profile 删除所有 use，rich 没有波形。修复后 rich 与 print 都保留内部 use，实际引用目标存在。
- 后续放行本地 themeCSS、增加 CSS 转义资源拦截后，仅重跑受影响的 2 项，**2/2 通过**，复用其他 5 项。打印/PDF 首个尺寸断言先红缺 pageSize；两个既有合同尺寸断言修复后 **2/2 通过**（8 项跳过），同时检查真实 HTML A4 CSS。
- DSH preview 接缝变化后回归既有 inline data 插图→预览→写盘重开、相对资源、frontmatter、安全 HTML/协议共 **4/4 通过**（分 3+1 两次定向，其余跳过）。
- 实际命令前缀：`../../src-tauri/resources/agent-host/node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts`。图表文件全跑；尺寸选择 `tests/native-pdf.test.tsx tests/desktop-export.test.tsx -t 'uses the latest native PDF renderer|hands a self-contained current print document'`；既有预览回归选择相应名称。包 `tsc --noEmit -p tsconfig.json`、仓库原 UI standards checker 均通过，无豁免；`sync-upstream.mjs --check` **93 固定来源文件/生成适配通过**。DOCX exporter bundle 输入/生成器未改，复用其既有核验。
- 目前累计 **48 个不同用例**有通过证据（41+7），尺寸断言与既有回归不重复增加计数；没有把复用结果描述成 48 项重新全跑。

### 一轮无窗口浏览器证据（原生目视追加之前）

Headless Chrome、同一会话、公开 MarkdownEditor harness；没有 Tauri、可见窗口或新浏览器下载。`output/playwright/preview-diagrams-evidence.json`、`preview-diagrams-styles.log` 和截图保存本地：

- 流程图 **421×97**、WaveDrom **320×60**；**24 个内部 use**，第一个实际 bbox **20×20**，目标 definition 存在。截图人工查看确认流程图箭头/标签和波形/数据段可见。
- split/preview 两模式真实 SVG；readonly source contenteditable=false，整个图表/换文档过程 **0 次 onChange**，原 BOM/CRLF 字符串不通过 renderer 重写。损坏 Mermaid/WaveJSON 与资源语法均有错误及可读代码，0 个残留旧 SVG。
- 快速加载 70 节点旧图再切当前文档，最终 SVG 只有当前文字；当次 `pendingAtReplacement=false`，因此浏览器只证明快速替换终态，未把它冒充延迟竞态证明；该竞态由上方两项定向用例验证。
- 当时 onPrint 专用 HTML **66,593 UTF-8 字节**，SHA256 `b34a8b5824ea33a79ff976a73997d150808d8a08806e87c7ee627a435b493bbb`，现保留为 `packages/markdown-editor/output/playwright/preview-diagrams-print-before-use-expansion.html`；两张 SVG、24 个波形 use、正确 A4 pt/CSS、0 外部资源/脚本/编辑控件。它后来被真实原生目视证明有波形缺失，不能作为 native 几何通过证据；修复见下节。
- 浏览器无外部请求或 pageerror；本地 themeCSS 与 `image: 说明` 标签实际渲染，转义 CSS 外部 URL 明确报错且 0 请求。补测第一次被 HMR 重置到源码模式导致等待 SVG 超时；切到预览后按当前模式重测通过，没有放宽产品断言。

### 本轮文件与真实剩余

本轮变更：`src/components/markdown/{MarkdownEditor.tsx,MarkdownPreview.tsx,markdown-editor.css}`；`packages/markdown-editor/src/adapters/{SafeMarkdownPreview.jsx,PreviewDiagram.tsx,diagramPreviewSafety.ts}`；`src/export/document.ts`；`sync-upstream.mjs` 与对应生成的 `src/genoffice/editor/CodeBlockView.tsx`；`tests/{preview-diagrams.test.tsx,native-pdf.test.tsx,desktop-export.test.tsx}`；harness `preview.tsx/preview.vite.config.ts`、README 和本文。`output/` 仅本地证据，不作为 vendor 源码。全部在原归属范围。

预览 SVG 缺口已补齐；随后发现的 macOS 原生波形缺失及正式 helper 复验见下节。系统打印面板与 Windows 实机仍待主汇总；该阶段曾记录的外部图床缺口，现已按用户最新指令排除并撤除支线。图表资源限制和任意方言 rich 往返、DOCX 映射/standalone 栅格边界如矩阵所列。不据本轮单独关闭 #191/#118 或声称上游全功能完成。

## 2026-10-18 原生 WaveDrom 几何阻塞修复

主 agent 消费上述真实 callback 后，PDFKit 能提取全部文字，但 PNG 仅有 clk/data/head/body/tail 和虚线网格，所有波形线/数据段缺失。因此撤回对这份旧 HTML 的原生几何通过判断。源码中的波形定义、class 样式、xmlns:xlink 都存在；只改 SVG2 href 的对照仍输出 **23,021 字节**、同样缺波形。问题已隔离在正式 WK/AppKit 沙箱 srcdoc 打印路径对本地 use 实例的呈现；没有把具体 WK 内部原因冒充已证明。

### 修复与定向 TDD

- 只在 `embedPrintDocument`（onPrint/onRenderPdf 共用）内，针对固定上游 WaveDrom 的本地 g/path 引用，克隆实际矢量几何并保留 class、实例 transform 和坐标。引用仅在同一 SVG 中解析，拒绝缺失/循环或非该 skin 支持的引用；不读取外部 URL。原始 defs 保留供 paint/marker 使用，克隆去重 id。不转 PNG、不转换文字，不改源码或 rich/preview 的 SVG。
- 原有公开 rich→print callback 用例改为验收真实 lane path，而非仅存在 use。修复前明确红灯，修复后 **1/1 通过，6 项跳过**；检查两条 lane 均有 path、时钟原路径、20px 实例位移且无 use/image，onChange 不调用。另有 jsdom detached SVG realm 的 matcher 报错改用精确 getAttribute 比较，未削弱几何断言。
- A4 print/PDF 两项既有合同 **2/2 通过，8 项跳过**；包 typecheck 通过。复用其余未变化预览、UI/vendored 源与原编辑验证，不重复全量。harness 排除 output/.playwright-cli 监听，避免写实际 HTML 证据触发自动刷新；未改根配置。

### 真实浏览器及原生输出

- 一次补充 headless Chrome 会话经公开 props 载入原 BOM/CRLF fixture → 分屏图表 → 实际 onPrint。预览保持 **24 use**；专用 HTML 为 **0 use、0 image**，clk/data lane 分别 **12/78 path**。用与原生相同的资源 CSP/sandbox 渲染回调 HTML，时钟首 path bbox **20×20**、stroke 黑色；截图实见完整方波/斜线/彩色数据段。**0 onChange、0 pageerror、0 外部请求**。
- 最新实际 callback：`packages/markdown-editor/output/playwright/preview-diagrams-print.html`，**70,228 字节**，SHA256 `0fcc2ecdbcfab1779c722f39877e6a16acd634477527207f59d7de9fc8a11af2`，仍携带准确 A4 pt/CSS。不是手改 fixture 替代产品准备路径。
- 直接运行已有正式 binary，无 Cargo 重编译、窗口/打印面板/应用 watch：`src-tauri/target/debug/examples/editor_pdf_verify /tmp/project-mind-markdown-native-wave-expanded-20261018 595.2755905511812x841.8897637795276:packages/markdown-editor/output/playwright/preview-diagrams-print.html`。**0.75 秒**，新 fixture PDF **27,683 字节**、**1 页 595×842 pt**（PrintCore 整 pt），复制保留为 `output/playwright/native-wave-fixed.pdf`，SHA256 `c1dd9e261ff5f4ac35076d5df580bc724c5af6b218532c2497510f902baad1e8`。
- Swift PDFKit 读取标题、Mermaid 节点/边文字、clk/data/head/body/tail；缩略图 `native-wave-fixed.png` 已实际查看，方波、斜线区、彩色数据段边框/文字及 Mermaid 几何完整。pdf-lib 检查 **0 image XObject、3 个 font 对象**，证明未以截图代替矢量/文字。PNG 仅作为检查证据，不进入产品 HTML/PDF。
- `output/playwright/native-wave-evidence.json` 保留命令、前后结果、browser/native 几何与文件大小/SHA；旧失败 HTML/href-only PNG 另存，旧 evidence JSON 的引用已指向旧文件，避免覆盖后仍套用旧 hash。补充浏览器与本包服务均已关闭。

本 fixture 的 macOS 原生波形阻塞已解除；Windows 与实际系统打印面板仍由主汇总验收。新增不同用例数不变，仍为 48（本次加强并重跑既有一项）。不扩展图床工作或通用导出框架。

## 2026-10-18 原生纸面边距与 FileReader 冻结点

### 纸面问题与实际修复

- 主随后目视确认旧 `native-wave-fixed.png` 标题贴纸张左缘。不是验收 fixture 故意去边距：固定上游 `printHtml.ts` 的产品模板为 `@page margin:2cm`、`body margin:0`，此前只追加 A4 size；主通用宿主的零边距打印不会给 iframe 的正文增加留白。旧波形证据继续证明矢量修复，不再用作当前纸面体验证明。
- 直接用现有正式 helper 对两种诊断 HTML 验证，table header/footer 重复留白与 box-decoration-break 都不能在此 iframe 打印路径维持续页上下边距，因此未将其当成修复。
- 新增 Markdown 局部 `src/export/paginatePrint.ts`，由 `embedPrintDocument` 在字体/图片嵌入后调用。受 CSP 限制的无脚本、离屏 iframe 仅用于测量当前真实 DOM；资源就绪后将内容实际分配到 A4 页节点，每页 padding 20mm、正文 170×257mm。成品无脚本/外部资源，iframe 随即释放。不是给长图外加 padding，也不是复制全篇再裁切每页。
- 长段落用 DOM Range 在可容纳的文本边界切分，保留原内联标记；普通段落/图片/图表尽量整块移页，标题随正文移动。表格优先整行切分、重复表头/colgroup；单个超高行保留跨页各列的空槽位。列表延续 start，编号本身也留在页内。WaveDrom 仍为已展开的矢量路径。公开 callback 及精确 A4 pageSize 不变，源字符串/BOM/CRLF 不参与重新序列化。

### 真实产物与验证

- 公开 MarkdownEditor 的新增纸面合同先红（没有物理页），实现后 **1/1 通过**。Chrome 和 WebKit 各自通过公开 props 载入 readonly 的 BOM/CRLF fixture，点击真实打印菜单，检查实际回调文档。正文列 **642.53125 CSS px = 170mm**，页内四方向可见内容均保持约 20mm 留白；0 onChange、0 pageerror、0 外部请求。
- 12 页 fixture 含图表、36 段文字、1100 个唯一长段落词标记、32 行表格、80 项列表。浏览器和 PDFKit 提取结果逐项检查全部标记恰好出现一次，表头续页出现、列表 start 为 7/38/70；不是只统计页数。WebKit 另验单个含 1300 词的超高表格行，**6 页、13 个行片段均保持 3 个列槽位，所有词恰好一次**。该补充首轮因 HMR 后未重新安装 harness 回调监听而超时；重新安装监听后通过，未改产品 gate 或超时。
- 最新 WebKit 真实 callback 文件：`output/playwright/native-margin-diagrams-print.html` **71,425 字节**，SHA256 `cdede149469d47555617280ae5789f69add44c48ccb68e171f3ccce167dd40a6`；`native-margin-multipage-print.html` **99,065 字节**，SHA256 `ced36c9a1ae786f68b1a37421618ab981a9533c5530c7a78783f8e5d83b74454`。
- 无 Cargo 重编译，直接运行现有正式 helper：`src-tauri/target/debug/examples/editor_pdf_verify /tmp/project-mind-markdown-native-margins-webkit-20261018 595.2755905511812x841.8897637795276:packages/markdown-editor/output/playwright/native-margin-diagrams-print.html 595.2755905511812x841.8897637795276:packages/markdown-editor/output/playwright/native-margin-multipage-print.html`。
- 实际原生单页 PDF **27,788 字节**、12 页 PDF **80,445 字节**，均为 **595×842 pt**、**0 image XObject**。12 页文本 bounds 的最小左/右/上/下留白分别 **56.636 / 56.895 / 56.399 / 68.867 pt**，约 20mm 以上（字体字形与 PrintCore 整 pt 量化有亚 pt 差）；标题首字完整，未再贴边。已实际查看 PDFKit PNG 的第一页、正文续页、重复表头页及末页连续列表，波形和 Mermaid 仍完整。
- 当前证据：`output/playwright/native-margin-evidence.json`、`native-margin-diagrams.pdf`、`native-margin-multipage.pdf`、`native-margin-diagrams-1.png`、`native-margin-multipage-{2,9,12}.png`。JSON 保留命令、浏览器几何、原生文字边界与全部 SHA；旧 wave 证据不覆盖，主应使用 margin 命名的最新产物。

### 延迟 FileReader 的最小修复

- 新增 `tests/image-async.test.tsx`，使用真实 FileReader/真实 Blob 转码，只延迟交付实际 load 回执。首轮 **4 红、4 绿**：同一 editor 更换 documentKey、只读回执和正常 paste 已绿，证明原 `transaction.getMeta('preventUpdate')` guard 有效；未新增 epoch 框架或重建 editor。
- 红例复现了两个实际缺口：顶部选图在换文档/只读后重开面板仍被旧 data URL 填入；Tiptap 卸载后延迟销毁窗口仍可处理已排队的 load 并 onChange。顶部仅保留单个 reader ref，换 key、只读、卸载、重新选图/面板取消时移除回调并 abort；回执检查活动 reader 和同一 documentKey。Rich 卸载复用已有 preventUpdate 取消信号，正常保存确认不触发此清理。
- 修复后 **8/8 通过**：paste 与顶部选图的 key/readonly/unmount 取消、pending/保存守卫释放、当前 paste 真实字符串写盘重开、当前选图仅按“插入”才提交。原有 paste 保存、源码/rich undo 和保存确认、WaveDrom 实际 print、嵌入字体/图片的 native print/PDF 合同定向通过。新增分页 iframe 的 jsdom 图片解码需在其独立 realm 补相同 IO stub；初次两个合同因此失败，补齐后 **2/2 通过**，没有放宽等待/字节/资源断言。实际解码与分页几何由浏览器/native 证据承担。

### 文件、验证和冻结

- 本次生产变更：`packages/markdown-editor/src/export/{document.ts,paginatePrint.ts}`、`src/components/markdown/{MarkdownEditor.tsx,RichMarkdownEditor.tsx}`。测试：`tests/{native-pdf.test.tsx,image-async.test.tsx,setup.ts}`；包 README 与本文。没有改根依赖/配置、shared DTO、宿主、Rust 或图床 UI。
- 包 `tsc --noEmit -p tsconfig.json` 通过。当前 `src/components/markdown` 临时完整副本运行仓库原 UI checker 通过，无豁免。固定 vendor / exporter bundle 未改，复用通过结果。命令继续使用打包 Node 24.21.0；本轮新增 **9 个不同用例通过**（纸面 1 + 图片异步 8），另复验受影响的 6 项既有用例，累计 **57 个不同用例**有通过记录，未全跑。
- 两个 headless browser session 和本包 Vite 已关闭。源码冻结，主负责统一 build/stage 和 Windows/系统打印面板整合验收。图床支线随后曾实现、现已按用户最新指令撤除，不再安排凭据或服务解锁；其他原有方言、DOCX mapper、standalone 栅格 PDF 边界保持矩阵记录。

## 2026-10-18 图床撤除结果与验证

- 删除 `src/components/markdown/ImageHostSettings.tsx`、`src/components/markdown/imageHost.ts` 与 `packages/markdown-editor/tests/image-host.test.tsx`；原 19 个图床 runner 用例、preview fixture 和两份本地专属 browser 脚本已撤除，不计当前覆盖。
- `MarkdownEditor` 移除 imageHost prop/导出类型/设置按钮与面板、上传准备；`SourceEditor`、`RichMarkdownEditor`、包 `localImage.ts` 回到直接读取本地 data。保留三入口 pending、取消、只读和原始 source 的 BOM/CRLF 修复。`imageInput.ts` 只保留本地图片工具与相对路径判断。
- `useDraftResources` 删除图床 revision/remote cache/单 network slot，保留相对资源缓存和旧文档结果隔离；`MarkdownExport` 移除图床 revision 与共享远端 resolver。`preview.tsx`、样式撤除图床 fixture/UI；本地 data 预览与全部导出 callback 保持。
- TDD：先将既有公开资源用例恢复为“仅 new.png 调用 resolver”，旧实现红例实际 2 次（含 HTTPS）；撤除后通过。打印准备旧合同加强同一边界，HTTPS 不调用 resolver。
- 定向运行 `tests/{image-async,editor,export,native-pdf}.test.tsx`：**53/53**，7.09 秒；其中本地 FileReader 18 项涵盖 source/rich paste、真实字节保存重开/预览、drop、三个入口 4MiB 真 File、chooser 初始 BOM/CRLF、换文档/只读/卸载旧回执与 pending。保留既有 DOCX 真实 OOXML、原生 print/PDF 回调、取消/失败和 baseline 替换合同。
- 末次仅加强远端打印断言与去除测试 Array.at 后，定向复验 local raster drop / safe print iframe **3/3**，2.54 秒；包 typecheck 与 scoped 原 UI checker 已通过。checker 对 Markdown 组件及本地 UI adapter 当前副本运行，没有 checker 豁免或根全量。
- 上游 93 原始文件、生成适配与 exporter bundle 未变；复用既有来源核验。既有真实 native 波形/每页留白/多页分页、PDF/HTML/DOCX/PNG 下载证据按未变化范围继续有效，本次未重跑 native/Cargo/浏览器或根 build/test。
- 旧 `output/playwright/image-host-*` 非脚本产物为已撤除支线的历史 IO fixture 证据，不参与构建，也不代表当前能力或外部 provider 验收。新增出口调查文档及其链接已撤除；已核实限制留在原功能矩阵，未启动新出口实现。

当前源码冻结，供主统一 build/stage。图床明确排除；原有方言 rich 往返、DOCX mapper、standalone 栅格 PDF 与 Windows/系统打印面板实机范围仍如矩阵，不称完整上游全部交付。

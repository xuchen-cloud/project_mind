# Project Mind Markdown editor

用于 Project File 字符串编辑的 React 组件，工作包 [#191](https://github.com/xuchen-cloud/project_mind/issues/191)（父 #118）；完整功能对照与具体差距见 [交付记录](../../docs/implementation/genoffice-parity-markdown.md)。公开入口为 [MarkdownEditor.tsx](../../src/components/markdown/MarkdownEditor.tsx)。

## 来源与适配

- 上游：`https://github.com/genspark-ai/genoffice`，固定提交 `d32d1711f1bf985430757b8c6b3fbddd3831d946`，Apache-2.0；保留 [LICENSE](upstream/LICENSE) 与 [NOTICE](upstream/NOTICE)。
- `source-lock.json` 记录 93 个原始文件的 SHA-256；`upstream/` 为原样源码，`src/genoffice/` 为 `sync-upstream.mjs` 生成的浏览器适配版本，禁止直接修改生成结果。
- 确定性变换包含：内部导入与 UI adapter、ES2021 数组兼容、WaveDrom 类型、只读命令限制、公式浮层释放、图表 SVG 安全过滤、块拖动布局、斜杠菜单共享滚动容器、插入块不解除已有列表格式。变换可从脚本完整审计。
- `src/adapters/localImage.ts` 为固定上游 `localImage.ts` 的手写适配：保留 Markdown 图片/链接序列化，以每实例的宿主资源表替换 Electron IPC；粘贴/拖入本地 raster 图片嵌入 data URL，异步输入参与保存守卫，外部基线替换取消旧输入。原始文件以 referenceOnly 收录。
- `src/adapters/ui.tsx`、`src/genoffice/i18n/locale.ts` 和 `src/source.ts` 为本地集成代码。原始编辑器内核、sourceSplice 和 Markdown style serializer 继续复用。
- 预览复用项目已有 DSH `MarkdownText` 的 settled parse/render pipeline 与 `withResolvedMarkdownImages` 安全资源策略；只替换 Mermaid/WaveDrom 代码块为本包 renderer 的真实 SVG，不拆断引用/脚注上下文。源码持久化不经预览重写。
- 导出复用原 `docxExport.ts` / `exportImage.ts` / `printHtml.ts`。DOCX exporter 与必要引擎闭包以 `build-exports.mjs` 生成独立浏览器 bundle；源文件仍固定在同一 commit，不从其他格式包的私有目录导入。第三方完整许可见 [EXPORT-THIRD-PARTY-NOTICES.md](EXPORT-THIRD-PARTY-NOTICES.md)。

从已核验的完整源码目录重建（不会自行下载大仓库）：

```sh
node packages/markdown-editor/sync-upstream.mjs /absolute/path/to/genoffice-d32d1711f1bf985430757b8c6b3fbddd3831d946
npm --prefix packages/markdown-editor run build:exports
npm --prefix packages/markdown-editor run verify:vendor
```

## 运行依赖

由共享根 `package.json` / `package-lock.json` 安装，包内没有独立 React/Tiptap 副本：

- React / React DOM 19、lucide-react、dompurify、diff 和项目已有 DSH Markdown renderer。
- `@tiptap/{core,react,pm,starter-kit,markdown,extensions,extension-table,extension-list,extension-code-block,extension-image,extension-link,extension-paragraph,extension-mathematics,suggestion}`：3.31.0；根现有 Tiptap 扩展一起对齐。React optional bubble-menu / floating-menu 同样 3.31.0，避免精确 peer 冲突。
- `@codemirror/autocomplete` 6.20.3、commands 6.11.0、language 6.12.4、search 6.7.2、state 6.7.4、view 6.43.11、lang-markdown 6.5.2；lang-json 6.0.2 为同时安装的上游依赖。
- mermaid 11.17.2、wavedrom 3.7.0、json5 2.2.3、katex 0.16.47、`@types/katex` 0.16.8。

导出局部依赖由本包 `package.json` / `package-lock.json` 精确锁定，`npm ci --prefix packages/markdown-editor` 安装，不改变根依赖：html-to-image 1.11.13、pdf-lib 1.17.1、jszip 3.10.1、fast-xml-parser 5.3.4、utif2 4.1.0；生成工具 esbuild 0.25.12。编辑器点击导出后才加载相关模块。

## 宿主契约

`value/onChange` 接收完整原始字符串。宿主承担原生读取、UTF-8/其他编码决策、CAS 保存、文件版本切换与失败反馈。组件不写业务文件，不访问任意路径。

- `documentKey` 仅在外部文件/历史基线替换时改变，重置源码与块编辑器历史。普通保存确认保持 key；同一已发出 value 的确认保留撤销。
- 默认分屏，支持 source / split / preview / rich。兼容 `sourceMode` 布尔宿主控制；自身模式确认不会把 rich 覆盖为 split。
- `resources` 为已授权引用到可显示 URL 的表。可选 `resolveResource(reference)` 仅接收相对路径，返回宿主授权 data/blob URL 或 undefined；HTTPS、file 等协议和绝对路径不提交 resolver，组件不直接读取网络或任意文件路径。每文档相对资源缓存与旧基线结果丢弃保留。
- `readOnly` 同时关闭源码、块输入、格式/替换和浮层写操作。历史加载本身不调用 onChange。
- `registerBeforeSave` 等待 IME 与图片粘贴/拖入的待提交输入；`onPendingChange` 报告同一状态。
- `initialView` / `onViewChange` 类型为公开 `MarkdownEditorView`，包含 mode、zoom、scrollTop、previewScrollTop、outline、outlineWidth、sourceMode。是否持久化各字段由主宿主 schema 决定。
- `onExport?: (file: {name:string; mime:string; bytes:Uint8Array}) => Promise<boolean>`：宿主导出写入，true 完成、false 用户取消、reject 显示失败；均不回退 anchor。只有未提供回调的 standalone 浏览器使用下载；Tauri/Wry 必须接此桥。公开导出类型 `MarkdownExportFile`。
- `onPrint?: (document: {html:string; title?:string; pageSize?:{widthPt:number;heightPt:number}}) => Promise<void>`：宿主系统打印。实际 payload 总是给出 A4 的 `210*72/25.4 × 297*72/25.4` pt（约 595.276 × 841.890），HTML 同时明确 `@page size:210mm 297mm`，不使用屏幕像素推算。打印专用 HTML 清除编辑控件并内嵌图片/实际 WOFF2 字体；不能内嵌的具体项报错。提供回调时不调用 iframe print；没有回调才等待字体/图片后 `iframe.contentWindow.print()`。公开导出类型 `MarkdownPrintDocument`。
- `onRenderPdf?: (document: MarkdownPrintDocument) => Promise<Uint8Array>`：宿主原生 PDF 排版，公开类型 `MarkdownPdfRenderer`。使用同一份 A4 尺寸、真实字体/图片内嵌打印 HTML，等待返回 PDF 字节后原样交 `onExport`，不重新栅格化；失败不回退浏览器 PDF。没有回调的 standalone 浏览器保留 192 DPI PDF 路径。

未修改的源码不会 normalize。源码模式按实际编辑坐标 splice 原始字符串，保留未改内容的 BOM/混合换行/空白。块模式保留原始 envelope 与未改块，变更区域采用固定上游 serializer；新换行采用原文首次出现的换行。任意 HTML、第三方 Markdown 方言和重排后的块不承诺全字节等同；可始终用源码模式保真编辑。

## 导出与打印

公开菜单覆盖固定上游的 DOCX、PDF、PNG、转换 Word 和 print。DOCX 是可继续编辑的 OOXML；转换 Word 在此通过同样的 DOCX 交付。提供 `onRenderPdf` 时使用宿主原生 PDF 排版并保持返回字节；standalone PDF 为 192 DPI A4 分页栅格。单页 PNG 为 `.png`，多页图片为含有逐页 PNG 的 `.zip`。系统打印与原文件保存均由宿主承担。原 Markdown 不因导出改变，readonly 历史可导出。

standalone 栅格 PDF 不支持选择文本；原生 PDF 的文本选择与分页由宿主排版实现和实机验收。DOCX 保留上游 mapper 的能力与限制（例如 inline math 为可见 TeX，不能转换的公式/图表保留源码）；独立 GenOffice Docs App 自动开页未复制到本编辑器。split/preview、rich 和打印现在均渲染实际 Mermaid/WaveDrom SVG，保留安全的 WaveDrom 内部引用；无效图表显示具体错误和源码，快速换文档丢弃旧结果。图表内活动 HTML、图片节点与外部 CSS 资源被明确拒绝，原始代码仍保留；本地 themeCSS 和普通文本标签可用，不任意加载远程资源。本地选图和 source/rich paste/drop 直接保留 raster data，单图上限 4MiB，支持 PNG/JPEG/GIF/WebP/BMP；纳管相对资源继续由宿主授权解析。图床设置、凭据管理与上传由用户最新明确排除，组件支线与专属测试已撤除。

原生回调的专用文档在资源就绪后排成实际 A4 DOM 页，每页自身留白 20mm、正文宽 170mm，不依赖 NSPrintInfo 或 `@page margin`。长段落按文本 Range 分页保留标记，表格按行拆分并重复表头，列表续页延续序号；每页仍是真文字/矢量 SVG，源 Markdown 不改写。原生宿主无需给 Word/PPT 等其他格式添加边距。

## 验证

```sh
npm --prefix packages/markdown-editor test
npm --prefix packages/markdown-editor run typecheck
npm --prefix packages/markdown-editor run verify:vendor
```

测试通过公开 React 编辑操作、onChange、保存守卫以及真实临时文件字节写入/重开验收。浏览器验收 harness `preview.tsx` / `preview.vite.config.ts` 仅用于 headless，未启动 Tauri 或用户可见窗口。运行痕迹、缓存、截图在 `.gitignore` 中排除；可按需保留到本地 `output/playwright/`。

`tests/desktop-export.test.tsx` 贯穿编辑器、真实宿主 services 和 desktopApi，仅替换 Tauri native IPC；`tests/native-pdf.test.tsx` 验收原生 PDF HTML/字节回调与失败/取消/基线替换。包 typecheck 显式复用项目既有 PDFKit 全局类型声明。系统打印弹窗、真实 native PDF 生成与原生文件对话框的实机验收由主宿主汇总，IPC 合同测试不能代替它们。

2026-10-18 恢复核对阶段新增并运行 native PDF base64 → 真实 service → 导出 service → 实际字节写盘重开的一项接线用例（Node 24.21.0，1/1）；包 typecheck 通过。当时的原 40 项、UI standards 与 vendor 结果按未变化范围复用，具体命令和真实缺口见交付记录。根 `build:office` 已接入本包锁定安装与 vendor 核验，未运行根构建。

同日后续补齐预览图表：新增 7 项公开组件用例通过；A4 print/PDF 2 项原有合同定向通过，4 项既有图片/安全预览/frontmatter 回归通过，包 typecheck、UI checker 与 93 文件来源/生成适配核验通过。累计 48 个不同用例有通过证据，未全量重跑。一次 headless Chrome 会话确认可见流程图/波形、只读不回写、错误源码、快速替换和真实 A4 专用打印 HTML；`output/playwright/preview-diagrams-evidence.json`、截图及 `preview-diagrams-print.html` 保留本地证据。异步延迟竞态由真实 renderer 延迟返回的定向用例覆盖；浏览器当次快速替换未捕获 pending 窗口，不冒充该竞态的浏览器证明。原生 PDF/系统打印的实机验收仍归主汇总。

原生目视随后发现 local use 在 WK/AppKit 打印中丢失，已在打印/PDF 共用准备点将固定 WaveDrom 引用展开为矢量 g/path，保留文字/样式/位移；不改源码和预览，不转图片。加强原合同红绿 1/1、尺寸合同 2/2 与 typecheck 通过。最新真实 callback HTML 70,228 字节，正式隐藏 native helper 得到 27,683 字节、1 页 595×842 pt 的 PDF；PDFKit PNG 已目视完整方波、数据区与 Mermaid，PDF 中 0 image XObject、文字仍可提取。当前证据见 `output/playwright/native-wave-evidence.json`、`native-wave-fixed.pdf/.png`；旧 66,593 字节/24 use 的浏览器证据不作为原生几何通过声明。Windows 和系统打印面板仍待主汇总。

同日纸面修正取代上一段贴边的产物：最新 `native-margin-diagrams-print.html` / `native-margin-multipage-print.html` 经正式现有 helper 输出 27,788 字节单页、80,445 字节 12 页 PDF，PDFKit 目视第一页/正文续页/重复表头/末页列表均有留白，0 image XObject；文字标记逐项无丢失/重复。Chrome 与 WebKit 真实 callback 均通过，另验超高表格单行的 6 页内容和列槽位。证据在 `output/playwright/native-margin-evidence.json`，不要将旧 `native-wave-fixed.png` 当作当前纸面体验。

新增纸面合同 1 项、延迟真实 FileReader 8 项通过，累计 57 个不同用例有有效通过记录，未全跑。原 paste 的 preventUpdate guard 已证明覆盖同 editor/documentKey 替换与只读；卸载时复用该取消信号关闭 Tiptap 延迟销毁窗口。顶部本地选图仅持有单个活动 reader，在换基线、只读、卸载和面板取消时解除回调并 abort，正常保存确认不重建编辑器。typecheck、当前 Markdown UI 副本的原 checker 通过；既有受影响合同/undo/波形/保存用例定向复验，其余证据按范围复用。这是图床支线前的冻结记录；图床现按用户最新指令排除。

`preview.html?native-print` 使用真实公开 onPrint 桥，通过 `markdown-print-prepared` CustomEvent 记录专用 HTML，供无窗口验收；它不调用系统打印弹窗。包测试复用根 jsdom 与主维护的 DOM interaction patch，不另装 jsdom。

### 2026-10-18 用户撤除图床后的冻结点

公开 imageHost prop/类型、设置 UI、上传准备分支与 HTTPS 图床资源支持已删除；保留本地数据图片、FileReader 取消/pending、BOM/CRLF、编辑和原有导出。删除原图床专属测试 19 项，不再将其计作当前交付。

受影响的 `image-async` / `editor` / `export` / `native-pdf` 四文件 **53/53** 定向通过，包 typecheck、当前组件与本地 UI adapter 副本的原 UI checker 通过。来源/导出 bundle 未改，原 native 分页/波形等证据继续复用；未运行根全量或可见应用。末次小范围复验见交付记录。原 `image-host-*` 本地证据仅记录已撤除历史，不参与构建。

剩余方言/DOCX mapper 限制继续记于原交付矩阵，新出口实现暂停。图床不作为凭据待解锁项。

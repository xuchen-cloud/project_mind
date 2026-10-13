# PDF 集成候选调查与最小运行验证（2026-10-13）

关联 [#118](https://github.com/xuchen-cloud/project_mind/issues/118)，按本轮用户要求扩展 F03 候选选型到 PDF。当前 Issue/需求正文仍主要列 HTML、Markdown、Word、Excel、PPT；本报告记录新增 PDF 调查，不修改需求或宣称格式功能交付。执行范围是官方源码网络核验、现有代码只读调查和独立表单往返试验；未启动应用、未做 review、未改主源码或 root package、未运行全量构建或 Office 检查。

## 1. 推荐：分清三层能力，保留 GenOffice 原文修改候选

| 层次 | 用户行为 | 推荐 | 本轮证据与状态 |
| --- | --- | --- | --- |
| 预览 | 阅读页面、缩放、复制文字、固定历史版本与页定位 | 复用主程序和 DSH 已共享的 PDF.js 6.2.108 预览 | 已有代码路径；本轮只读调查，未新增 UI 验收 |
| 标注或表单 | 高亮、绘制、添加说明、填写已有 AcroForm | 优先直接 PDF.js annotation/editor 层与 `saveDocument()`；pdf-lib 补明确缺口 | 两库各两份英文表单往返通过；批注 GUI、中文填写和 WebView 尚未验收 |
| 原文修改 | 改动 PDF 页面已有正文对象、删除原文字而保留邻近内容 | **推荐 GenOffice PDFium core 局部原文编辑**，暂不导入整套 Electron 应用 | 已实际执行英文与中文嵌入子集原文替换，内容通过；英文原框外 4px 差异保留 limited。见第 8 节 |

“简单编辑”若包含改正已有中文正文，仅表单/批注无法满足。已有 PDF.js 预览降低预览适配成本，不构成放弃 GenOffice 原文修改的理由。建议沿用一个共享页面预览，按实际能力增加独立编辑会话和候选字节导出；原文 core 已完成第 8 节无 GUI 试验；接下来补产品宿主接缝。

PDF.js 官方编辑器类型包含 FreeText、Highlight、Ink、Stamp 等批注类型；FreeText 是新增文本批注，不能据此声称修改原正文。`PDFDocumentProxy.annotationStorage`、`getFieldObjects()`、`saveDocument()`提供表单/批注保存路径，后者返回完整 PDF 字节。[固定版本类型](https://github.com/mozilla/pdf.js/blob/v6.2.108/src/shared/util.js)、[Viewer 编辑器](https://github.com/mozilla/pdf.js/blob/v6.2.108/web/pdf_viewer.js)、[固定版本 API](https://github.com/mozilla/pdf.js/blob/v6.2.108/src/display/api.js)。

## 2. 主程序与 DSH 当前已有的是只读 PDF

调查对象为本次共享工作树，包含主 agent 正在进行的未提交修改；下列结论描述读取时的代码，不替代其测试验收。

| 位置 | 实际能力 | 本包需要的接缝 |
| --- | --- | --- |
| [ProjectFileContent](../../src/components/document/ProjectFileContent.tsx) | 按扩展名/MIME 识别 PDF；以 workspace/project/fileId 绑定；读取指定 versionNumber/expectedContentHash，校验返回身份/版本/hash；把原件 bytes 交给 DshFilePreview；页定位、缩放/位置恢复、刷新及外部打开 | 当前没有 PDF 编辑状态、字段修改或保存处理器 |
| [DSH preview](../../packages/dsh-ui/preview/index.jsx) 与 [PDFBody](../../packages/dsh-ui/upstream/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx) | Canvas 页面、TextLayer、分页、缩放与适宽 | 增加选定 AnnotationLayer/AnnotationEditorLayer 和会话 dirty/save 状态，而非另建权威文件库 |
| [PDF runtime](../../packages/dsh-ui/upstream/client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts) / [document](../../packages/dsh-ui/upstream/client/ui-sidebar-documentpreview/src/client/pdf/document.ts) | 专有 worker、bytes 副本、取消加载/渲染、清理；当前 PdfDocument 类型仅暴露 numPages/getPage | 编辑会话须保留真实 PDFDocumentProxy、annotationStorage 和导出能力，协调原有生命周期 |
| [source-pdf](../../src/lib/source-pdf.ts) | Node 文本抽取、预算/页定位、needs_ocr/encrypted 等状态 | 是检索/引用原文能力，不是页面编辑器 |
| [FileBytes 类型](../../src/lib/file-types.ts) / [projectFileApi](../../src/services/projectFileApi.ts) | 固定历史字节读取；文件移动/重命名等版本/hash 条件 | 尚无直接向 PDF UI 暴露的二进制编辑保存适配 |

已有 [pdf-real.node.test.ts](../../packages/dsh-ui/preview/pdf-real.node.test.ts) 使用真实 PDF.js 和 Canvas 检查预览；本轮仅读取其源码，未重复运行。现有 runtime 的 `isEvalSupported` 兼容字段不能独立证明 PDF.js 6 的脚本隔离；编辑功能应沿用受控 bytes/worker 和宿主权限边界，实际链接、表单动作和宿主能力仍需相应行为验收。

## 3. GenOffice 固定 SHA 的真实 PDF 组成

固定源码：`d32d1711f1bf985430757b8c6b3fbddd3831d946`。已网络核验官方 GitHub 原始文件，并用固定 checkout 的 `git show SHA:path`交叉读取。`apps/pdf/package.json`描述为 PDF.js viewer，但不能只凭描述判定功能范围：其 private 应用 `@genoffice/pdf` 有 PDF.js `^6.2.108`、pdf-lib `^1.17.1`、EmbedPDF PDFium `^2.15.1`、HarfBuzz `^0.10.3`及内部包依赖。这些是上游声明范围；追加执行固定了 PDFium 2.15.1/HarfBuzz 0.10.3 等实际版本，见第 8 节。[官方 package](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/package.json)。

### 3.1 预览、批注与表单

`PdfPage.tsx`直接使用 PDF.js Canvas/TextLayer；渲染选择 `AnnotationMode.ENABLE_FORMS`，因为自定义 FormLayer 负责交互 widget，防止保存后画两遍字段。Renderer 还包含 DrawLayer、表单设计、图片编辑、RedactionLayer 和自有编辑状态。仅需要预览时可直接复用同一底层 PDF.js，无需带入完整应用。[PdfPage](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/renderer/PdfPage.tsx)。

`save-pdf.ts`用 pdf-lib 写 highlight/underline/strikeout、便笺、绘制及字段值/设计；存在真实 `/Annot`、`/QuadPoints`、外观 `/AP /N`写入。因此既有页面上浮层，也有实际 PDF 保存实现。其默认字段外观使用 Helvetica；中文编码失败时设置 NeedAppearances，让阅读器尝试重建，并不等于已正确嵌入中文字体。[保存源码](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/main/save-pdf.ts)。

### 3.2 确实存在原正文对象修改

`text-edit.ts`导出 `validateTextEdits(bytes, edits)`、`applyTextEdits(bytes, edits)`、`verifyTextEdits(bytes, edits)`。输入有 pageIndex、PDF user-space rect、oldText、newText、fontSize，以及可选样式。它以 PDFium 原文字对象/几何匹配目标，调用 `_FPDFText_SetText`、`_FPDFPage_RemoveObject`、`_FPDFPage_InsertObject`、`_FPDFPage_GenerateContent`，再序列化候选字节；属于原对象修改/重建能力，超出了批注添加。[正文 core](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/main/text-edit.ts)、[输入与结果协议](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/shared/ipc.ts)。

边界很具体：可复用字体的原对象直接 SetText 路径要求单对象、ASCII 且替换字符已由同字体绘制；非 ASCII（含中文）、多行和部分样式变化走对象重建。重建会选嵌入或本机字体、重新定位，不是 Word 式段落排版，也没有普遍无损保证。匹配失败、字形不覆盖等情况返回 skipped；扫描图像没有可匹配正文。中文原文修改必须单独测试，不能由本轮英文表单通过推导。

### 3.3 实际宿主与独立运行判断

| 部分 | 实际构成 | 改装代价/判断 |
| --- | --- | --- |
| PDFium | `@embedpdf/pdfium` Emscripten JS + `pdfium.wasm`；核心使用 heap、指针、FPDF 和 PDFiumExt 接口，初始化读取 WASM bytes | 不是必须新编译 native addon；可先在 Node 脚本中加载官方 WASM。接口与对应 WASM 版本须一致 |
| 字体 | `font-cmap.ts`、`font-locate.ts`转接 `@genoffice/font-metrics`；Node fs/Buffer，安装字体索引、TTF/OTF/TTC face 提取、覆盖判断 | 私有 workspace 包也要提取/解析，不能只复制 text-edit.ts；WebView 不具有同样的本机字体读取能力 |
| HarfBuzz | `font-subset.ts`读取 `hb-subset.wasm`并 WebAssembly.instantiate；TrueType 子集及 CFF charset 修正 | 必須带上 WASM、字体处理与缓存/串行执行，不可只用浏览器 CSS 字体假定导出成立 |
| Electron 应用宿主 | pdf-main.ts 的 IPC/path 权限、保存、最近文件等；wasm-path.ts dev 下 resolve、打包后使用 process.resourcesPath | 这些需替换为 Mind 的受控候选输入/输出；不应把 Electron IPC、任意原件路径或自动覆盖引入 Tauri |
| 渲染编辑交互 | React 的选字、坐标转换、换行/度量、浮层与保存刷新 | 引擎独立成功仍不等于用户已能在主程序操作；后续再适配共享 preview 与选区 |

证据：[WASM 路径](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/main/wasm-path.ts)、[HarfBuzz 子集](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/main/font-subset.ts)、[字体转接](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/main/font-locate.ts)、[font-metrics 包](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/font-metrics/package.json)、[字体读取](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/font-metrics/src/font-locate.ts)、[Electron 主进程](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/main/pdf-main.ts)。

**独立运行现已由第 8 节最小 Node core 试验确认；产品宿主改装仍待完成**：正文入口没有直接 import Electron；其字节 API、Node fs 和 WASM 构成可提取的最小宿主。公开源码不是一个已发布稳定 `pdf-engine` SDK；TypeScript 无扩展名导入、workspace 包解析和 WASM 资源需小规模打包/harness 处理。提取 core 的代价小于带入整个 Electron PDF 应用，但明显大于仅增加 PDF.js 表单。Tauri 最小候选可先用已有 Node carrier/隔离 worker 跑 core；若改为纯 WebView，字体 bytes 提供和资源加载要重做；若改为 Rust/PDFium native 则是另一个移植工程，本轮不建议先扩大该路线。

一个容易遗漏的接缝：`applySaveRequest()`只返回候选与 skips；**最终原文/图片回读验证位于 `savePdfToPath()`调用的 private `verifyContentEdits()`中**。独立接入不能拿 applySaveRequest 的字节就宣布完整保存；须保留/提取相同验证，并将任何用户目标 skipped 标记为未完成。atomic write 也仅防局部写入，不等于 Mind File 的版本/hash CAS。

## 4. 直接 PDF.js 与 pdf-lib 的适用范围

| 候选 | 合适用途 | 不应宣称的能力 |
| --- | --- | --- |
| PDF.js 6.2.108 | 延续共享预览；官方 annotation editor、AcroForm 的 annotationStorage/saveDocument 链 | 新增 FreeText 不等于改页面原文；API 能保存不等于现有 DSH 已有编辑 UI |
| pdf-lib 1.17.1 | 字段值、明确的批注字典/外观辅助、页面/图片/新增文字等操作 | 官方不提供普通页面正文的通用删除/修改 API；默认字段字体不支持中文；不能自行解密 encrypted PDF |
| GenOffice PDFium core | 局部原文字对象匹配、替换/删除/重建，推荐局部原文编辑 | 两份受控样例内容通过，整体 limited；不能默认覆盖全部字体、扫描 PDF 或复杂段落。见第 8 节 |

pdf-lib 官方明确区分表单字段修改和表单以外页面文字修改；加密文档限制仍成立，不使用 `ignoreEncryption`绕过。`PDFTextField`的默认 Helvetica/WinAnsi 限制可通过自定义可嵌入字体另行试验，但“设置字段 Unicode 值”与“所有阅读器显示正确”是两个验收点。[官方限制](https://github.com/Hopding/pdf-lib#limitations)、[PDFTextField 文档](https://pdf-lib.js.org/docs/api/classes/pdftextfield)。

按源码标签，GenOffice PDF 应用/内部 font-metrics 为 Apache-2.0，PDF.js 为 Apache-2.0，pdf-lib 为 MIT；源码范围和运行版本记录用于后续依赖/资源保留。本轮按个人自用要求执行，没有授权调查阻断，也没有绕过 PDF/运行时限制。整套依赖打包与第三方通知仍属于未来实际分发清单，不影响本次候选结论。[PDF.js LICENSE](https://github.com/mozilla/pdf.js/blob/v6.2.108/LICENSE)、[pdf-lib LICENSE](https://github.com/Hopding/pdf-lib/blob/v1.17.1/LICENSE.md)。

## 5. 无 GUI 表单实际往返结果

证据目录：[packages/pdf-validation](../../packages/pdf-validation/README.md)。实际执行 bundled Node **v24.19.0**（系统 Node 是 v26.8.1，未混用为本轮版本），darwin arm64；PDF.js **6.2.108**、pdf-lib **1.17.1**、Python **3.12.14**、独立 pypdf **6.10.0**。未安装新依赖。

两份受控原件均 2 页：simple 有英文静态正文、customer 文本框、approved checkbox 和第二页；complex 另含未编辑中文、图片、URI 链接和目录。实际目标为 customer **Alice→Bob**、approved **Off→Yes**。PDF.js widget id 由 getFieldObjects 得到，本样本为 customer `6R`、approved `13R`；id 只在对应原件/编辑会话有效，不能成为跨版本业务定位。

| 样本/引擎 | 保存 + 独立重开耗时（ms） | 页数 | 结果 |
| --- | --- | --- | --- |
| simple / PDF.js | 54.89 + 225.78 | 2→2 | passed：受控英文字段/checkbox |
| complex / PDF.js | 5.95 + 108.88 | 2→2 | passed：同上，未改复杂内容断言通过 |
| simple / pdf-lib | 13.08 + 94.73 | 2→2 | passed：受控英文字段/checkbox |
| complex / pdf-lib | 3.64 + 101.46 | 2→2 | passed：同上，未改复杂内容断言通过 |
| complex / pdf-lib 默认字体写“中文填写” | 导出抛错 | 未产生候选 | **failed**：`WinAnsi cannot encode "中" (0x4e2d)` |
| simple / pdf-lib 白矩形+新文字 | 独立抽取新旧两段文字 | 2→2 | **limited**：原文仍存在，不是原文修改 |

断言没有以文件非空替代内容检查。pypdf 比对原/候选的页尺寸、静态文字、解码后的页面内容流 SHA、图片像素 SHA、非 widget 批注/链接及目录；另核对字段值、AP 中 Bob 文本和 checkbox `/AS=/Yes`及可用 `/Yes`外观。四份候选全部通过这些有限断言；原件完整 SHA 不变。新增外观断言时复用了同 SHA 候选，没有重复 SDK 导出。[详细结果](../../packages/pdf-validation/results.json)、[复杂 PDF.js 前后读取](../../packages/pdf-validation/complex.pdfjs-form.checks.json)、[覆盖反例](../../packages/pdf-validation/overlay.checks.json)。

PDF.js 实际运行发出 `_getAppearance: OffscreenCanvas is not supported, annotation may not render correctly.`；AP 结构中确有 Bob，视觉显示仍未验证。本节首次表单试验标 **limited**，当时未测中文表单字体嵌入、批注 GUI、GenOffice 原文修改、视觉保真、Tauri WebView、业务 CAS、签名或 XFA；后续原文 runtime 与有限视觉补证见第 8 节。这四个英文表单通过不能外推中文表单，更不能外推中文原文编辑。

| 文件 | SHA-256 |
| --- | --- |
| simple.original.pdf | `4ade196ca0dc73b88ca5a93f4ba1d6333992dacf9b49e6899475db78d9cb4c31` |
| complex.original.pdf | `39cc5a2215b176d5589dd9fa3a306ec8cf738c4fb4e6a1d1c3cdcce573d92b71` |
| simple.pdfjs-form.pdf | `949a8132e614410b81942fd3a435f95549addebde0b68f35a55401939350612f` |
| complex.pdfjs-form.pdf | `fe54ba137c2731339d286426c3f2cbbbba438def43ee91ff74784c2ca3decf5b` |
| simple.pdflib-form.pdf | `33ef6a1d668129fae33fd4fce0a3aa1e50799b9e17671ad0f0b86cd8f9fb471a` |
| complex.pdflib-form.pdf | `b2152c190c859d5336acf3002c46b2a3f69f5e99764ab3aed689b99ba89890b8` |

可跑命令（仓库根目录；原件已存在，生成器拒绝覆盖）：

```sh
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node packages/pdf-validation/validate.mjs
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 packages/pdf-validation/fixture.py compare packages/pdf-validation/complex.original.pdf packages/pdf-validation/complex.pdfjs-form.pdf packages/pdf-validation/complex.pdfjs-form.checks.json
```

## 6. GenOffice 原文编辑：已执行方法与剩余验证

下列方法中的最小真实 core、受控英文/中文嵌入子集替换、独立重开及提取最终文字 verifier **已执行，结果见第 8 节**，没有 native build 或 Electron。完整 save-pdf/applySaveRequest、图片验证分支、GUI/WebView 与 File CAS 接入尚待；进一步字体/多对象范围保留为未验证。

1. 在新隔离 harness 中固定相同 SHA，提取 text-edit、font-cmap、font-locate、font-subset、wasm-path，以及实际引用的 shared/ipc、radicals、x-layers 和 font-metrics 依赖闭包；解析 workspace 包。用一次小型 TS bundling 处理无扩展名 import，保留 `@embedpdf/pdfium`动态依赖。只安装该 harness 的固定 PDFium **2.15.1**、pdf-lib **1.17.1**、HarfBuzz **0.10.3**及必要打包工具，不修改主项目包。
2. 独立脚本先调用 `loadPdfium()`核对 FPDF/扩展导出、WASM SHA、冷启动耗时与内存。保持上游实际 `thisProgram: 'genoffice-pdf'`初始化；源码解释它避免 Emscripten 把中文 argv 路径错误当 ASCII。WASM 用明确包内路径加载，不用伪造 Electron 对象掩盖宿主依赖。
3. 准备两份可唯一定位目标的 PDF：simple 单对象英文等长改字，先保证新字母已在同字体其他文字中出现以覆盖原字体 SetText 路径；complex 使用实际嵌入中文子集字体，另含未编辑中文段落、图片、链接、表单和第二页。不要拿本轮 CID 非嵌入中文样例假定覆盖了嵌入子集。另测新增子集外中文字符以触发重建/字体回退，并记录实际采用字体与 font SHA。
4. 用独立 pypdf visitor 或 PDF.js TextContent 取得目标 PDF user-space rect，记录 pageIndex、oldText、新文和字号；rect 明确为 PDF user space，不是屏幕像素。先 `validateTextEdits`，再 `applyTextEdits`；任何 skipped 对目标均算 failed/limited。把输出另存，调用 `verifyTextEdits`，然后 pypdf/Poppler 独立核对新文出现、旧目标整句消失、未改文本/页数/图片/链接/字段保留。对象重建后页面流 SHA 可能改变，应检查未改业务内容和非编辑区域，而不能直接沿用表单试验的所有内容流不变断言。
5. 单独验证最终保存链：`applySaveRequest(original,{textEdits:[...]})`和 `savePdfToPath(original,candidate,request)`对照，保留后者最终回读校验。静态源码中的“原对象保留”注释不能代替实测。最后由两个独立阅读器无 GUI 渲染比较修改区域及未改区域，检查 CJK 字形、颜色、行间距、旧字残留；纯抽取成功不等于视觉保真。
6. 加一个 controlled mismatch（错误 oldText/rect）与一个确无字体覆盖的目标：确认返回明确 skips/错误、原件 SHA 不变，不把其余内容导出成功当该编辑成功。收口记录候选 hash、实际库版本、字体/资源、timing、编辑定位、失败和最小范围。核心通过后才安排共享 preview 的人工选区编辑、坐标/缩放、保存刷新与 macOS WebKit/Windows WebView2 验收。

**预计改装范围**：最小 Node runtime 是依赖闭包、资源路径与试验脚本，暂无必须写 Rust/PDFium native 的源证据；产品接入另需字体资源供给、受控 Node worker 生命周期和 GUI/DSH→File save 薄适配，不能归为“换一个 React 组件”。当前不存在本包执行阻塞；原文 runtime 的解锁条件是隔离环境备齐对应 WASM/内部字体模块及受控中文嵌入样本，不是许可调查或应用 native build。

## 7. 主程序与 DSH：同一 File ID / CAS 保存

现有 [FileContentService](../../src-tauri/src/file_content.rs)已有 begin/append/finish/update：begin 绑定 object、expectedVersionNumber、expectedContentHash、候选 length/contentHash；update 绑定同 object/基线及 stagedContentId，最终进入原生版本提交。源码当前上限为 100 MiB 候选、1 MiB 分块。已有服务不表示 PDF UI 写入口已经完成；应补可信 GUI 薄适配，并复用 DSH 原有受控宿主通信，遵循 [Workspace/atomic receipt ADR](../adr/0009-bind-agent-operations-to-workspace-and-atomic-receipts.md)。

建议一次会话路径为：

```mermaid
flowchart LR
  F[同一 File ID + 固定 version/hash] --> R[读取该版本 PDF bytes]
  R --> E[共享预览 + 独立编辑会话]
  E --> C[PDF.js 或 GenOffice 导出候选字节]
  C --> V[目标编辑与未改内容验证]
  V --> S[原生 begin / append / finish / update]
  S --> N[同 File 新版本 + 新 hash]
```

- 会话只管理基线和未保存编辑；PDF.js widget/object id、GenOffice objNum/rect 均不作为新的 File 身份。主程序与 DSH 读写同一 object，使用各自明确的版本/hash 基线。
- 引擎保存到受控候选 bytes/临时副本；禁止先覆盖用户真实原件再补版本。GenOffice atomic write只用于临时候选；最终是否生效由 File 服务 CAS 决定。
- 保存成功后才更新基线、重开候选并清除 dirty；失败/skipped/版本冲突保留 pending，不报告全部成功。外部软件或 DSH 改动使基线过期时，不静默覆盖。
- 固定历史 PDF 只读；恢复调用已有原生恢复机制生成同 File 新版本，再建立新会话。关闭/切 Workspace 时协调 worker 与未保存内容，避免旧会话导出覆盖新对象。

GenOffice 最小原文 runtime 已实际完成，详见第 8 节。当前推荐现有 PDF.js 预览 + GenOffice core 局部原文编辑；英文表单保存保留为独立有限能力。受控中文内容/渲染证据已通过，英文原框外 4px 变化仍 limited；完整 save-pdf、GUI/WebView、字体/资源供给及本节 File CAS 接缝尚未交付，#118 保持开放。

## 8. 追加执行：GenOffice 局部原文 runtime 已跑通，整体 limited

本节更新前文初始候选状态。用户已授权原文执行；**当前推荐明确为现有 PDF.js 预览 + GenOffice core 局部原文编辑**，批注/表单不能替代中文正文修改。证据归档：[genoffice-pdf-validation](../../packages/genoffice-pdf-validation/README.md)。只在新目录和 `/tmp/project-mind-genoffice-pdf-validation-20261013`写入，未改主源码/root package，未启动应用、Electron 或 native build，未做 review/新子 agent。

### 8.1 真实宿主与字体

实际版本：bundled Node **v24.19.0** / darwin arm64，PDFium **2.15.1**、HarfBuzz **0.10.3**、pdf-lib **1.17.1**、esbuild **0.25.12**。固定 SHA 公开 text-edit、字体/共享模块与真实 font-metrics 被打包到隔离 Node ESM harness；未修改原函数、未 shim FPDF/font-locate、未注入字体覆盖。依赖安装 9 包，`--ignore-scripts`；PDFium 使用官方已编译 WASM，原生编译未发生。初始化 **50.95ms**；一次运行收尾 RSS 约 **179.6 MiB**，不是持续内存基准。[源码锁](../../packages/genoffice-pdf-validation/source-fetch.lock.json)、[依赖锁](../../packages/genoffice-pdf-validation/dependency.lock.json)、[打包输入](../../packages/genoffice-pdf-validation/build-inputs.json)。

WASM SHA：PDFium `5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa`；HarfBuzz subset `3a5d246b0e4c0017084775e9f2c7fce96e45d09b1a354fd9e2e440c88fb9890d`。未归档 WASM/node_modules/上游大 bundle。

中文原件是 ReportLab 生成的 **实际 TrueType 嵌入子集**，`/AAAAAA+ArialUnicodeMS`、`/FontFile2`，不是之前 CID nonembed 样例。字体实际来自 `/System/Library/Fonts/Supplemental/Arial Unicode.ttf`，23,278,008 bytes，SHA `876af2cd4854644e7f3e7feb2f688997fdb3343c6df6693611209c9dfb47ccec`，OS/2 fsType=8；未改变字体 bytes 或 restriction flags。替换含原目标/原子集没有的“星辰”，上游默认字体查找真实取到该文件；输出新 Type0/FontFile2 为 21,596 bytes，SHA `79bd8f7a34c85050be2e56d54df86d2a9d6d08aedf1efc51782c0352f0fa9d43`，原未改文字所用旧子集仍保留。字体不随证据分发。[字体锁](../../packages/genoffice-pdf-validation/font.lock.json)、[输出字体/运行记录](../../packages/genoffice-pdf-validation/results.json)。

获取源码时 Python raw HTTP 有 7 个文件 IncompleteRead，锁中逐一保留具体错误；执行使用同固定 SHA 的只读 git object 对照，无源补丁。完整 save-pdf.ts 后续由 Node fetch 成功获取。下载问题已解锁，没有以许可调查阻断或绕过运行时错误。

### 8.2 原文实际修改与独立读取

| 样本 | 目标 | validate/apply/verify（ms） | pypdf/Poppler 原文检查 |
| --- | --- | --- | --- |
| simple：英文单对象 | `SIMPLE ORIGINAL TEXT`→`SIMPLE REPLACED TEXT` | 9.33 / 5.32 / 0.96 | passed；旧整句消失，新整句存在；未改全文有序一致 |
| complex：中文嵌入子集 | `中文目标：山川日月保持原样。`→`中文目标：星辰日月保持原样。` | 2.92 / 148.52 / 1.22 | passed；真实非 ASCII 对象重建；旧整句消失、新整句存在，未改全文有序一致 |

两次实际调用 `validateTextEdits/applyTextEdits/verifyTextEdits`均成功，skipped 空；Node exit 0。pypdf 独立检查原/候选均 2 页，页尺寸/顺序、未改中文与英文、图片像素 SHA、链接、widget/表单值及目录保留。Poppler **26.05.0** 再抽取全文，目标外有序全文一致；pdfimages 两组均 1 张 80×40 RGB 图。原件 SHA 保持不变，不以候选非空为通过。[pypdf 英文](../../packages/genoffice-pdf-validation/simple.core-edited.checks.json)、[pypdf 中文](../../packages/genoffice-pdf-validation/complex.core-edited.checks.json)、[Poppler/像素结果](../../packages/genoffice-pdf-validation/external-results.json)。

| 文件 | SHA-256 |
| --- | --- |
| simple.original.pdf | `78c4cec264850169452048e7e266a01b93edeb10595f6c528f175b3073848305` |
| simple.core-edited.pdf | `d5dd1bfc769791a144568c788bdf7e2bcc037a43d65fa16336d0dd4c403b6e7d` |
| complex.original.pdf | `db97c42390689d88168781d4ec3cb6f6b093593203ee0dc6be18630aeda82fac` |
| complex.core-edited.pdf | `1f8b909fad8093714abe428980ddd87caa1231bb145c23bda7672b12c76426be` |

错误 oldText 正对照得到真实 `the edited text could not be located on the page`，apply 返回一个 skipped，候选与原件 SHA 相同；这个结果只算拒绝/跳过保护通过，不算内容编辑成功。

### 8.3 实际渲染与有限视觉观察

Poppler headless 渲染四份原/候选各两页，均 exit 0；均有默认 fontconfig config 缺失警告。**本组嵌入中文与旧 CID nonembed 样例不同**：主 agent 实际查看中文 source/candidate 第 1 页、candidate 第 2 页与英文对比图，确认“山川→星辰”清晰，未改正文、蓝图片、Alice 表单及第二页中文可见，所查看图没有观察到新增水印。[主 agent 观察](../../packages/genoffice-pdf-validation/visual-main-agent.json)、[中文小对比 PNG](../../packages/genoffice-pdf-validation/evidence/visual/complex.page1-comparison.png)、[英文小对比 PNG](../../packages/genoffice-pdf-validation/evidence/visual/simple.page1-comparison.png)。

- 中文第 1 页差异 bbox `[121,60,148,73]`全部在目标内；目标区外 0 差，第 2 页 0 差。
- 英文替换字符数相同但新字形总宽增加。差异 bbox `[105,61,221,73]`，原目标框外仍有 `[217,61,221,64]`（4px）差异；**原断言保留 false，external overall=limited**，没有扩大框或删除断言改称 passed。图中没有观察到遮挡，只能说明这个样例可读，不能声称任意固定框保真。

另收到主 agent 对**上一轮 PDF.js simple 表单单候选/单页**的独立补证：Alice→Bob 与 checkbox 勾选实际可见，像素差仅字段 bbox `[69,205,442,239]`，静态英文 body 无差、source/candidate hash 与第 5 节一致，未重跑 SDK。该有限视觉结果只适用于这一个候选第 1 页，不推及四组合、中文表单或复杂 CID 样例；后者仍有 Missing Adobe-GB1/font 警告。[独立记录](../../packages/pdf-validation/visual-main-agent.json)。第 5 节 pdf-lib 中文 default-font **failed**继续有效。

### 8.4 最终 private verifier：真实提取路径已尝试

为避免引入完整 save-pdf 依赖闭包，`final-verify.mjs`从固定官方源码**精确提取 finalPageIndex/verifyContentEdits 函数体，仅添加 export**。真实 text-edit 动态依赖仍被打包，未运行的 `./image-edit`保持 external，未虚构实现。提取函数体 SHA `d9a74dcd03b1e5515755ad9eaf055dab5ce06334604cf018238c029ed2bed7b0`；完整 save-pdf 源 SHA `3b6ee1034ecedc239174ff213d732b787713c978f1025423d36e0cc3793ac2f4`。

两份 core 候选经 pdf-lib 使用上游最终保存配置 `useObjectStreams:false, updateFieldAppearances:false`后，实际 private 文字验证通过；missing-newText 正对照真实抛出 `save-verify-failed pages=1: replacement text missing ...; the file was not written`。这是函数级正/负证据，**未运行完整 applySaveRequest/savePdfToPath、图片验证分支或 Mind 生效保存**，也未给两份额外 final-stage 文件声称独立 Poppler/视觉通过。[提取脚本](../../packages/genoffice-pdf-validation/final-verify.mjs)、[结果](../../packages/genoffice-pdf-validation/final-verify-results.json)。

### 8.5 收口推荐与产品接入边界

**最小适用范围已从“尚待运行”推进为受控英文及中文嵌入字体的局部原文替换可行，整体 limited。** 不需要为最小 core 开始 native build 或运行完整 Electron 应用。主程序继续共享 PDF.js 预览，编辑时使用 GenOffice core；最终采用仍需实现并验收：实际字体 bytes/默认查找供给、固定两份 WASM 打包、选区到 PDF user-space 与旧文匹配、skips 明确保留、真实最终 verifier 接入、同 File ID 的版本/hash staged/CAS 生效及保存后重开。

本次没有扩大扫描 PDF、任意字体、多对象复杂排版、GUI/DSH/WebView 或 CAS 验证。库/PNG 已完成且由主 agent 看图后复用；只做归档语法、链接、hash 与源闭包核对。[findings](../../packages/genoffice-pdf-validation/findings.md)、[命令/复现](../../packages/genoffice-pdf-validation/README.md)。

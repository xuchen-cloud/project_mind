# GenOffice Word / DOCX 编辑移植

关联子 Issue #191，父 #118。固定 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`。

## 工作包与边界

- 依赖：office-docx 格式包、固定完整 renderer、主 agent 的共享 File/CAS/恢复/版本与原生输出服务。共享分支 `codex/genoffice-editor-parity`，Word 只拥有本包、`DocxEditor*`、本文档。
- 交付：复用原上游真实 App、Ribbon、命令、对象 NodeView 和 buildDocBytes；解除旧段落/marks-only 限制；真实 DOCX 保存重开和未改部件保留。兼容原 `{model,edits,onChange,readOnly}`。
- 非目标：完整独立 App 文件/窗口管理、更新、重复 AI 聊天；用户2026-10-18最新明确排除整文件加密文档、图床设置/上传及PPT演讲者视图。普通settings编辑限制/writeProtection与本地/远程图片粘贴保留。
- 公共验收 seam：用户选中/输入/命令/拖动/缩放 → 草稿 → `inspect/edit` 真实字节保存重开；输出用真实字节和宿主回执。mock 平台服务只证明接法，不等于平台能力已实现。
- 验证范围：本包 build/test、单文件 tsc、显式 headless 验收；无根全量 build/test、可见应用、Tauri watch、git 操作。

## 当前状态（2026-10-18 19:39 CST，本轮最终源码/dist冻结）

远程图片与撤除整文件加密UI的必要定向验收已结束，自有Word构建、测试和server均已停止。Word生产源码/dist及新native模块/tests冻结；主可集中`build:office → stage`，需更新office-docx/dist。主已实际执行native远程图片12/12通过。本次冻结不是#191全功能完成声明，真实剩余平台差距及未穷尽验收分列在文末。

已实现完整上游 renderer 的 iframe 隔离、native save receipt、PDF 分组与真实 PDF 合并、192DPI PNG ZIP、HTML/图片原字节导出、选页打印 HTML、系统字体/真实 face metrics 回调。主 agent 已接 native output/font 服务。历史只读输出曾被整条 Ribbon inert 阻挡，现已将四个输出入口与编辑区域分离，并通过 Chromium/WebKit 的 HTML/PDF/PNG/选页打印及原件不写入用例。

本轮异步远程图片/FileReader 粘贴、保存等待及失败拒绝已通过；表格列宽拖动、选择行、合并/拆分真实保存重开已双浏览器通过。PDF 新 `pageSize` 分组 pt 参数已在 Chromium 断言通过，混合尺寸仍按原顺序合并。初始只读后解锁被宿主覆盖 View editable 卡住、inert wrapper 后窄屏 Ribbon 标签换行，均已有红绿回归与修复；只读四输出/恢复编辑、两轮安全链接保存重开、1440/480布局及连续遮罩均双浏览器通过。

**原生中文 PDF 字体与粗体复制问题已取得真实红绿证据。** 原 CJK CFF 的空 ToUnicode 已用同源 TrueType 打印派生字体解决，主 PDFKit 与本包 pypdf/PDFium 均能提取正文/表格/页眉页脚。随后发现 Regular 字体合成粗体会重复绘字4次；打印副本对缺 Bold face 的 CJK 文本改用单次 fill+stroke，实际 native PDF 断言现为1次，PDFium两页PNG已目视通过。原始屏幕字体与 DOM 样式不变。最新正式 HTML/PDF 的 SHA 和命令见下。

altChunk 已补公开转换回调与缺桥提示，真实 HTML→DOCX helper 由 Hume 实现 `packages/office-html2docx/**`，主宿主已接 lazy import。实际 helper→富文本/列表/表格/图片展开→另段编辑保存→原 chunk 保留→重开，Chromium 与最新 helper 的 WebKit26.5 完整流均已通过。曾先纠正 fixture PNG 的坏 CRC，再定位 WebKit 禁脚本 child realm 的 Image.onload 等待问题；helper owner 已修复并通过其自身定向用例，本包复验真实构建产物，不以 converter mock 代替。

本轮另修主线程发现的 external replacement/dispose 生命周期污染：每次 iframe mount 有独立身份、ready 和取消状态；旧回调不访问新 File options，异步 helper/native 返回后检查身份；beforeSave 捕获 mount 并在 await 后检查，失效立即拒绝。renderer destroy 后不再 render/ready/change/pending/error/save，真实序列化回执也检查销毁状态。延迟真实转换/JSZip 序列化后替换/关闭的四个公共场景，加上 renderer 仍 attached 时 destroy 的等待/晚到字节边界，共5例，两浏览器各5/5。最后一例先暴露 WebKit 私有flush仍可挂起，已补 renderer-local stopped promise，让销毁主动拒绝flush等待；不依赖浏览器停止旧realm的任务。

## 上游复用与出处

完整 `App.tsx` / Ribbon / PaginationPreview / extensions / table-ops / image-drop / convert / file-actions / review-actions 和完整保存状态均复用。原来源505文件以 Git blob SHA1/字节长度逐个验证；`upstream/` 不打补丁，局部 `renderer-build.mjs` 精确替换/AST adapter 可重建，匹配变化即构建失败。fonts 非运行 README 不复制，LICENSE/NOTICE 保留。

浏览器选图、剪贴板图片、HTML helper 抽自固定 `Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4`，原文和 SHA256 位于 vendor-web/web-source-lock；不复用任意路径 relay。独立 Tiptap3.31/React19.2/pdfjs/pdf-lib 由本包 lock 固定，主 App Tiptap 不升级。

CFF→TrueType 的打印专用派生字体位于 `print-fonts/`，固定原件/输出 SHA256、字体工具版本和转换脚本；保留 OFL 来源。所有 glyph、cmap→GID、hmtx/vmtx 和 units-per-em 验证保持，曲线近似上限0.0005em。正常 Node build 只校验，无 Python 运行依赖。含屏幕+打印字体的 editor.mjs 约40.8MB（此前32.7MB），在 Word 首次打开时加载；需主整合观察资源耗时。

## 功能矩阵

“已复用、未逐项操作验收”是测试覆盖状态；下方“剩余实现”才是确定的缺失能力。

| 上游能力 | 实现/实际证据 |
| --- | --- |
| 正文/单元格中文选中输入，Enter，新段落，undo/redo | 完整 renderer；Chromium155/WebKit26.5 真实拖选、中文输入、两次 DOCX 保存、第一次保存后 undo/第二次保存后 redo、未改 ZIP 部件比对通过 |
| 字体/字号/粗斜下划线/颜色/高亮/段落/样式 | 完整 Ribbon 与原命令保留；粗体/居中保存重开通过；原生字体列表在真实 picker 中出现，metrics 桥真值/null/reject 通过；其余格式命令未逐项操作验收 |
| 标题/段落/列表/分页符 | 原 schema/commands/save 保留，旧结构 guard 已解除；新增段落/格式结构 fixture 保存通过；列表和新增分页符尚未逐项 UI 验收 |
| 表格插入/行列/选择/合并拆分/拖动尺寸 | 真实单元格文字、Ribbon 加行、列边界拖动、选择行、合并、拆分保存重开均双浏览器通过；行高等变体未逐项验收 |
| 图片选中/插入/缩放/拖动/环绕 | 真实 handles、120% zoom 坐标、图片拖动环绕、文件 chooser 插入，双浏览器真实保存通过；远程 HTML 图片和 bitmap FileReader 粘贴/保存等待/下载失败拒绝 Chromium 通过 |
| 无CORS图片宿主接线与归属 | onFetchImage优先宿主、原message可见且失败保存拒绝；Chrome/WebKit各4组真实粘贴→DOCX media/重开、下载中只读、替换/关闭晚回执通过。Native public-IP/pin/redirect/budget/File/slot/hash边界主实际12/12通过；集中App调用由主验收 |
| settings编辑保护与排除加密UI | 打开密码/确认及误导提示由局部adapter移除，vendor原文不改。Chrome/WebKit真实保护对话框字段/tooltip、既有writeProtection保留、新只读限制保存重开通过；整文件加密为用户明确非目标 |
| 分页/页面与节/页眉页脚 | 真实3页2节显示，所有未改 section/HF ZIP 比对；活动页眉编辑、只读锁后提交、beforeSave、横向纸张保存双浏览器通过；更多 HF/节变体待操作覆盖 |
| 查找替换/比较 | 真实查找替换并保存；比较真实 DOCX chooser、diff，不写当前 File，Chromium 通过 |
| 批注/脚注 | 真实批注创建、脚注 prompt、两次保存；comments/footnotes XML 和原件保留 Chromium 通过 |
| 修订/尾注/字段/公式/形状/文本框/绘图/参考文献 | 原组件、上下文、保存选项保留；子编辑器提交接 beforeSave。尚未逐组实际验收，不宣称已全部验证；Zotero 另有外部实现缺口 |
| 图表 | 包 API 改值99、chart/embedded workbook 同步保存通过；不支持 series/category 结构变更明确拒绝；完整图表 UI 未逐项验收 |
| 源链接与受保护内容 | model/原件 href 和 OOXML 保留；隔离 DOM 移除导航/事件属性，NodeView update/子编辑器适用；完整 App 的专用双浏览器链接脚本两轮保存重开通过，无脚本执行/导航/外部请求/弹窗 |
| 保存/IME/readOnly/宿主回执 | 活动子编辑器同步 flush；IME 拒绝；异步图片等待/失败传播；成功 inspect receipt 只推进基线，保留 iframe/caret/undo，外部版本替换重建；native Promise success/reject 通过 |
| 外部替换/关闭的异步归属 | mount 身份守卫、独立 ready 与取消；延迟 altChunk/真实 JSZip 后 replacement/dispose，旧等待拒绝、不触发新 File change/pending/error/save/ready，双浏览器通过 |
| altChunk HTML/MHT | 原引擎 MIME/charset/data 图片解码、inline parse 和原始 HTML/MHT/aFChunk/anchor 保存保留；真实 helper 富文本/列表/表格/图片展开、另段编辑、原件保留、重开 Chrome/WebKit 完整集成通过 |
| 历史只读输出 | HTML/PDF/PNG ZIP/选页 print 真实回调通过，正文与修改工具仍 locked，edits=[]/pending=false/原件字节相同；初始只读后恢复编辑通过。宿主锁用独立 PM editable predicate，不覆盖上游保护条件；双浏览器通过 |
| HTML/图片另存 | 完整 HTML 内容/表格/样式/图片/分页后段落；图片原 PNG 字节/MIME；native 成功/取消/失败/不 anchor 下载 Chromium 通过 |
| PDF/整页 PNG | 上游实际页片分组、10页 chunk/失败分割、pdf-lib 合并；混合尺寸360×504/450×600真 PDF fixture 顺序及 PNG960×1344/1200×1600@192DPI 通过。原生 pageSize=twips/20；真实 native PDF CJK 正文/表格/HF可提取、粗体完整段落只1次、2页595×842pt、PDFium视觉通过 |
| 打印 | 原 PrintDialog 选第1/3页→无 App 控件/脚本、全 data 字体图片、外部请求0、native Promise success/fail；使用正式native command生成的真实 PDF文字/两页PNG通过。真实打印面板人工验收及 Windows 无实机待验收 |
| 主题/隔离/滚动 | 父 data-theme/.dark/字体 token 实时同步；CSS iframe 隔离；连续边缘遮罩反向/16px=.25/resize/reduced-motion通过。最新四输出按钮1440/480双浏览器无重叠、标签单行、不遮挡Ribbon，截图已目视核对 |

## 实际验证与复用

均在本包范围执行，不以根套件替代诊断。产物 `packages/office-docx/test/output/browser/` 为忽略目录，环境变量和 opt-in 命令见本包 README。

| 命令/脚本 | 已实际结果 |
| --- | --- |
| `node packages/office-docx/build.mjs` | 2026-10-18 通过：505固定来源，完整 renderer/worker/CSS/字体/打印派生字体校验。上游不修改 |
| `npm --prefix packages/office-docx test` | 17/17通过；本轮未变引擎/legacy源码，复用结构、chart、快照约束、未改部件/安全结果 |
| 单文件 `tsc --noEmit --jsx react-jsx --module ESNext --moduleResolution Bundler --target ES2022 --lib ES2022,DOM --strict --skipLibCheck src/components/office/DocxEditor.tsx` | 新 onRenderPdf/fonts/metrics/altChunk/pageSize props 通过（最后新增 print asset 不影响类型） |
| 单文件 `tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck full-editor.ts`（包目录） | 本轮 mount identity/ready/cancellation 类型通过。尝试连 renderer-host 直接 ad hoc tsc 会展开未配置 @genoffice aliases 的上游树，并不构成完整 renderer 类型检查通过；该树以固定来源 build 和实际浏览器验收验证 |
| `browser-parity.mjs` | Chromium155/WebKit26.5通过主编辑、IME、两次保存/历史、主题/字体/只读；最终 lifecycle build 后 Chromium 再通过两次真实保存、第一次保存后undo、第二次后redo、caret/iframe保留与errors=[]。WebKit新边界由lifecycle5/5+真实altChunk保存覆盖，未重复无变化的全套 |
| `browser-objects.mjs` | Chromium/WebKit通过图片 resize/zoom/drag/chooser、表格加行、活动页眉锁后提交、横向保存。相关源码本轮未变，复用 |
| `browser-tables.mjs` | 本轮 Chromium155.0.8059.80/WebKit26.5通过列宽鼠标拖动、选择行、合并/拆分和真实 DOCX 重开 |
| `browser-paste.mjs` | 本轮 Chromium155.0.8059.80通过远程 fetch gate、FileReader gate、save 等待、失败拒绝、真实 DOCX 重开。caret 用拖选+ArrowRight确认；不在已有图片 node selection 上断言应新增图片 |
| `browser-readonly-output.mjs` | 本轮 Chromium/WebKit通过 HTML/PDF/PNG ZIP/选第2页打印，未开放修改命令/正文，edits/pending/原件字节检查通过；新增初始只读→可编辑红例修复后通过 |
| `browser-native-pdf.mjs` | Chromium/WebKit真 PDF fixture 分组/合并/PNG ZIP/失败、系统字体/metrics 桥通过；本轮 Chromium pageSize pt 断言通过。该fixture本身不证明native中文复制；实际native证据见下 |
| `browser-native-print.mjs` | 本轮最终派生字体/pageSize/打印粗体后 Chromium通过：选页1/3、真实HTML文件、data内嵌资源/外网0、native Promise/失败、屏幕粗体style不变，记录HTML SHA/尺寸。原生字体验证另见下一节 |
| `browser-native-export.mjs` / `browser-output.mjs` | native HTML写入/取消/失败，图片原字节写入，无anchor替代；standalone浏览器HTML/图片/原打印dialog边界通过。相关导出代码未改，复用 |
| `browser-review.mjs` / `browser-compare.mjs` | Chromium通过真实查找替换/批注/脚注保存，真实比较 chooser/diff/不改当前File；未变代码，复用 |
| `browser-receipt.mjs` | Chromium真实 native save Promise等待/true/原样reject通过；请求保存逻辑未变，复用 |
| `browser-affordance.mjs` / `browser-output-layout.mjs` | 连续遮罩/reduced-motion通过；输出新按钮1440/480双浏览器布局、hit target、单行标签断言和最新截图通过；已目视核对wide/narrow起点/末端 |
| `browser-link-acceptance.mjs` | 本轮 Chromium/WebKit完整App、初始只读与Protected NodeView安全链接、解锁编辑、两轮真实保存重开通过；errors/externalRequests/popups全空 |
| `test/verify-native-pdf-text.py <actual-native.pdf>` | 旧原件正文乱码红；派生字体正文转绿；再加粗体完整段落count=1断言，旧native=4红，最新正式native=1绿。PDFium同为1次，全文与视觉见下一节 |
| `browser-alt-chunk.mjs` | Chromium通过缺 converter 可见提示、真实 DOCX receipt 的显示/编辑保存/原件保留。该 callback fixture 不实现 HTML→DOCX |
| `browser-alt-chunk-real.mjs` | 使用独立 helper 实际已构建的 `dist/index.mjs`，最终Word build + 最新helper Chromium155/WebKit26.5均通过真实富文本/列表/表格/图片转换、Word展开、另段编辑、原HTML/relationship/anchor保留、重开，pageerrors=[]；结果JSON含两浏览器 |
| `browser-lifecycle.mjs` | TDD red：延迟转换与真实 JSZip 两种旧 beforeSave 在 replacement 后均1.2s超时；renderer attached destroy 时 WebKit 私有flush仍pending也先红。最终两浏览器各5/5：conversion/serialization × replacement/dispose + renderer attached destroy。旧ready不释放新ready；旧change/pending/error/save不污染新File；旧等待及时reject，新实际source显示并可flush；destroy后晚到ZIP不能成功flush |
| `browser-native-image.mjs` | 先红：原版走浏览器fetch而未调宿主。Chrome155/WebKit26.5各4组通过，core3组后仅新增readonly组，不重复无变化core；证据`native-image-final-results.json`。Word回执mock与主真实native12/12分开记录 |
| `browser-protection.mjs` | 红：整文件打开密码仍可见；adapter修后Chrome155/WebKit26.5通过无打开密码项/tooltip误导、普通修改密码字段保留、真实writeProtection不丢、新只读限制保存重开生效。点击实际可见label而非被装饰控件覆盖的input |

### 最终构建冻结点

最后一次包构建包含onFetchImage与保护UI撤除，使用仓库打包Node（包目录下等价命令：`../../src-tauri/resources/agent-host/node build.mjs`），505固定来源校验与构建成功。此后只改定向测试与本文档，没有再改生产源码。构建产物 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `packages/office-docx/dist/editor.mjs` | `2d039a90a98978f0656d57574b9c680a57278b4cc76ea8400b26716d16841d3d` |
| `packages/office-docx/dist/renderer-resource.mjs` | `4422ebee9e7d8dea88a00db8db4aeacc2ca578d2d4e893df48cf735767917ec5` |
| `packages/office-docx/dist/engine.mjs` | `8bb8778b7b6bb8260bca377b0e0bafc6aa9c36f16e24c6c4498f257f65f0f170` |
| 本次集成消费的 `packages/office-html2docx/dist/index.mjs`（其他 agent 所有） | `8e4035e428a69cff2808add240b3b6022d3070a3f1538e3c8eb4d2d4573f64d7` |

最终定向命令：普通 `browser-server.mjs`，再以 `OFFICE_ACCEPTANCE_URL` / `OFFICE_PLAYWRIGHT_MODULE` 运行 `browser-lifecycle.mjs`（Chromium 与 `OFFICE_BROWSER=webkit` 各5例），`browser-parity.mjs`（Chromium）；独立 `OFFICE_DOCX_ALT_CHUNK=rich` server 运行 `browser-alt-chunk-real.mjs`（默认按顺序跑两浏览器）。结果分别在 `test/output/browser/lifecycle-{chromium,webkit}-results.json`、`parity-results.json`、`alt-chunk-real-results.json`。Node24.21.0、Chrome155.0.8059.80、WebKit26.5；不下载浏览器、不跑根build/test。最终限定范围 `git diff --check` 通过。17/17格式单测、之前对象/布局/只读/输出/原生字体证据在相关实现未变化处复用，不重复无变化全套。

### 最新正式原生 PDF 字节证据

2026-10-18，macOS 26.5.2 / 系统 WKWebView，直接复用已编译的无窗口 helper（不跑 Cargo、不显示应用/打印面板）。helper binary SHA256 `85f0ce5b9fdbf3a549314333f02a6f9b087d1d027d38bad24b5d9b9cbf0bd011`。消费的是正式 `buildPrintDocument` 经原 PrintDialog 选择1/3页、onPrint生成的文件，不是手写HTML。

```sh
src-tauri/target/debug/examples/editor_pdf_verify \
  packages/office-docx/test/output/native-pdf-final \
  595.45x841.7:packages/office-docx/test/output/browser/native-print.html
python packages/office-docx/test/verify-native-pdf-text.py \
  packages/office-docx/test/output/native-pdf-final/fixture-2.pdf
```

- 正式 HTML `test/output/browser/native-print.html`：8,772,405 bytes，SHA256 `0d9f6e4f49376283d6b328c045e1443229816627104d71767a4ca37a8e36bb77`；onPrint pageSize=595.45×841.7pt；全data资源、外网0、无编辑控件/脚本。
- 实际 PDF `test/output/native-pdf-final/fixture-2.pdf`：34,230 bytes，SHA256 `d91708742950fafe89c199f76c68d0319c2204894401472f0ea443990e0c72f0`；2页，595×842pt（PrintCore整pt取整）。
- pypdf断言正文、表格、页眉页脚、第三页内容均有，粗体完整段落“未修改段落：山川日月保持原样。”正好1次。原CFF字体红例正文乱码；首次TTF原生粗体count=4红；打印专用单次描边后count=1绿。pypdf对另一些系统Japan1标题有解码限制，标题另用PDFium检查，不吞掉限制。
- PDFium全文同一粗体count=1，正文/主标题正确；1.5倍两页 `page-1.png` / `page-2.png` 已目视核对标题、正文粗体、表格、图片、HF及分页。主线程2026-10-18独立PDFKit复验最新上述PDF：2页595×842，粗体count=1，正文/张三/第三页/HF精确存在，第一页PNG中文/粗体/表图/HF目视正常；复用该证据，不再重复原生字体测试。
- 打印专用副本：对使用Regular派生CJK且缺Bold face的文字禁用字重合成，使用0.01em单次fill+stroke；不修改原屏幕字体/DOM，`browser-native-print`同时核验原粗体style不变。不是去掉粗体、rasterize正文或在PDF后补伪造文字。

## 公共保存与输出契约

- `registerBeforeSave(callback)`：宿主 await；提交活动表格/文本框/HF/工具输入，IME 组合拒绝。`onPendingChange`覆盖未形成草稿的输入和异步工作；失败不变成成功快照。`onSaveRequest?:()=>void|Promise<void>`：上游 save 等真实 native/CAS receipt，错误原样 reject。
- `snapshot {baselineHash,base64}` 唯一 edit，严格 source/hash/base64/ZIP/输出DOCX/原件保护检查；File native CAS 是最终权威。成功后新 model 精确匹配 last snapshot + edits=[] 只 acknowledge；真正外部 version replacement 重建。
- mount 失效会拒绝旧 beforeSave，不等待已移除 iframe 的 Promise jobs；旧 mount 的 ready/change/pending/error 被丢弃，save/output/font/conversion 请求拒绝，异步回执不能再进入新 File。成功保存 receipt 仍留在同一 mount，不取消 undo/caret。
- `onExport({name,mime,bytes:Uint8Array}):Promise<boolean>`：true 已写入，false 用户取消，reject 实际失败。所有桌面输出优先该回调，只有 standalone 无回调才 anchor 下载；无任意路径权限。
- `onPrint({html,title?,pageSize?:{widthPt,heightPt}}):Promise<void>` 与 `onRenderPdf(same):Promise<Uint8Array>`：打印从真实选中 pv-page 得纸张；PDF group twips/20（pt=1/72in）。HTML 是完整真实页片/print CSS/data资源；不是简单body截图；scale归1。混合 PDF 每组 native render 后合并保留纸型/顺序。
- `onGetSystemFonts():Promise<string[]>`，`onFontMetrics(family):Promise<FaceVerticalMetrics|null>`：main 已接真实原生枚举/head/hhea/OS2，失败传播。固定 renderer 的 line-metrics 仍按原实现，不能把新增 metrics 桥说成已替换原有所有排版算法。
- `onConvertAltChunkHtml(html):Promise<Uint8Array|null>`：HTML/MHT 已由上游做 charset/MIME/image-data 解码。回执必须是真 DOCX；null/失败有可见提示，原件 chunk 不移除。主宿主已 lazy import 真 helper，宿主定向16/16通过；Word实际浏览器流结果见上表。

## 用户最新非目标：整文件加密

用户2026-10-18撤除此能力，不再记作实现缺口，不新增打开密码/加解密意图或原生桥。保护对话框中整文件“打开密码/确认”及误导提示由局部适配层移除；普通settings.xml的writeProtection/documentProtection、编辑限制及其密码保留。固定vendor原文不改。定向UI/保存证据见本轮补充。

## 远程图片粘贴：包内接线和native边界已通过

公开`onFetchImage(url)->Promise<{mime,base64}>`，有宿主回调时优先native，不隐式CORS fallback；结构化错误原message可见，beforeSave等待插入/失败拒绝。Chrome155/WebKit26.5各4组真实粘贴/保存重开、native拒绝、替换/关闭晚回执与下载中变只读通过。主已注册新native模块并实际运行全模块12/12通过，覆盖slot owner/有界File流hash与安全网络/归属边界；详见[远程图片包](genoffice-remote-images.md)。集中App宿主实际调用验收由主整合。

## 确定剩余实现、触发 UI、字节/状态与解锁

日常编辑的确定剩余平台能力是系统拼写建议/词典/语言桥；普通输入、图片与格式保存不依赖它。Zotero属于引用操作的外部服务条件。本包按主要求不继续扩大这两项实现；远程图片集中App宿主调用/发布和未穷尽UI覆盖由主整合。整文件加密不再列为缺口。

### 1. 系统拼写（系统建议/词典/语言桥未接）

- 真实 UI：编辑正文，对拼错英文右键；上游菜单显示建议、加入词典、全部忽略、语言。原 `spellcheck=true` 仍在，但普通 contenteditable 下划线不提供 Electron 的建议数据和字典 API。
- 原生事件 `onContextMenuRequest({seq,misspelledWord,suggestions})` 必须对应 renderer 的 `claimContextMenu(seq)`；只有当前右键 seq 才回填，不能把旧词建议给新的选区。
- 方法：`spellLanguages()->{active:string[],available:string[]}`（macOS available=[]，OS自行选语言）；`spellSetLanguages(langs)->same`；`spellAddWord(word)->boolean`；`spellIgnoreWord(word)->boolean`；`spellReplace(replacement)->void`；`respellKick()->void`。不能返回固定空列表或虚假true。
- 上游 `editor/spell-replace.ts` 已有真实 PM word-range、marks保留、undo事务 fallback；Electron Blink先 replaceMisspelling，150ms未变才fallback。Tauri可让native只返回实际系统检查建议/词典/语言结果，本包用真实PM范围替换，避免跨窗口native selection权限；但需要主确定 macOS NSSpellChecker / Windows spellchecker 命令/当前文档seq事件契约。当前没有该系统桥，Proxy报错不算交付。

### 2. Zotero 外部服务

UI为引用/参考文献中的 Zotero 操作。`zoteroCommand` allowlist `addEditCitation|addEditBibliography|refresh|setDocPrefs|removeCodes`，返回 `{ok,errorCode?:connection-refused|unsupported-command|operation-failed,error?}`。原上游连 `127.0.0.1:23116`，transactionId+payloadLength大端frame/JSON；向当前文档发 `{requestId,command,args:unknown[]}`，回 `{requestId,ok,result?,error?}`。解锁需用户本机运行兼容 Zotero 服务、受限 native TCP桥、当前文档/请求归属核验和关闭清理；不能虚造 citation 成功。

## 尚未穷尽的验收（与缺失实现分开）

样式/列表全变体、更多 HF/分节/边距/页码、修订accept/reject、尾注、字段/公式、形状/文本框/墨迹、图表完整UI等保留原组件/命令/完整保存字段，但尚未逐项操作验收。实际 Windows 输出/字体/打印无测试机；macOS原生PDF已取得上述真实文字/视觉证据，真实打印面板仍需人工。主整合/发布和全 App 检查不由本 agent 执行，本文不作 #191 全功能完成声明。

## 本 Word 工作包变更文件

以下均在拥有范围内；共享根package/lock/DTO/宿主及既有Rust未由本agent改动。最新授权新增`editor_remote_image.rs`和局部tests，主负责注册/编译。`upstream/`原文保持校验，无静默修改。

- 宿主与完整renderer：`src/components/office/DocxEditor.tsx`；`packages/office-docx/{editor-types.ts,full-editor.ts,renderer.tsx,renderer-host.ts,renderer-pdf.ts,renderer-print.ts,secure-extensions.ts,scroll-edges.ts,renderer.css,editor-shell.css}`。
- 格式包与兼容入口：`packages/office-docx/{engine.ts,model.ts,types.ts,editor.ts}`。
- 固定来源/构建/许可证：`packages/office-docx/{build.mjs,renderer-build.mjs,pin-renderer-source.mjs,extract-web-helpers.mjs,prepare-print-fonts.py,source-lock.json,web-source-lock.json,web-helpers.mjs,write-notices.mjs,package.json,package-lock.json}`；`vendor-web/{web-bridge.ts,NOTICE,LICENSE}`。
- 打印字体：`print-fonts/{README.md,LICENSE-OFL.txt,source-lock.json,NotoSansCJKsc-Regular-subset.woff2,NotoSerifCJKsc-Regular-subset.woff2,GenOfficeSansKR-Regular-subset.woff2,GenOfficeSerifKR-Regular-subset.woff2,GenOfficeCheLatinKR.woff2}`（均为本包相对路径）。
- 验收入口/fixtures：`packages/office-docx/test/{browser-harness.tsx,browser-server.mjs,lifecycle-harness.ts,engine.test.mjs,parity.test.mjs,verify-native-pdf-text.py,fixtures/alt-chunk.mjs}`。
- 用户操作回归：`packages/office-docx/test/browser-{parity,objects,tables,paste,review,compare,receipt,link-acceptance,affordance,output,output-layout,readonly-output,native-export,native-print,native-pdf,alt-chunk,alt-chunk-real,lifecycle}.mjs`。
- 文档：`packages/office-docx/README.md`、本文档。正式HTML/PDF/PNG与结果JSON位于忽略的 `test/output/`，可由以上命令重建；不提交缓存/运行进程。

## 2026-10-18 远程图片工作包（接19:03冻结点）

主已授权仅本包`onFetchImage`能力解冻，scope与安全契约见[原生远程图片工作包](genoffice-remote-images.md)。新增native模块/tests已就绪供主统一编译；本agent未运行Cargo。Word生产源码与dist局部构建已完成，Chrome155/WebKit26.5各4组真实paste/失败/生命周期回归已通过；此前PDF字体、once-copy、宽窄输出布局、real altChunk结果继续有效，未重复运行。

19:39最终冻结：主真实native全模块12/12（2.63s）通过，本agent已读日志；Word Chrome/WebKit各4组图片回归通过。额外整文件加密UI撤除及普通settings保护保存重开两浏览器通过。未扩拼写/Zotero新实现；没有进行中的构建/浏览器/server。

本次新改动还包括：`src-tauri/src/editor_remote_image.rs`、`src-tauri/src/editor_remote_image/{tests.rs,tests/document.rs}`；Word `test/browser-{native-image,protection}.mjs`及两份harness，`renderer-build.mjs`的ProtectDialog/tooltip适配；README、本文及远程图片文档。全包dist已由本包build更新，主stage需消费新的editor/renderer资源与声明文件，engine SHA未变。保护UI改动不触及图片/输出实现，因此复用其已通过结果，不重跑无变化全套。

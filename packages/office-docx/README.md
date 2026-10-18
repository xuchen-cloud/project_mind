# Office DOCX 编辑器

子 Issue #191，父 #118。完整上游 Word App/Ribbon/分页 renderer 隔离在同源 iframe；宿主 File 拥有身份、CAS、冲突、恢复与持久化。当前功能与未完成项以 [功能矩阵](../../docs/implementation/genoffice-parity-word.md) 为准，完整源码复用不代表所有编辑/平台入口均已验收。

## 固定来源与构建

```sh
npm --prefix packages/office-docx ci --ignore-scripts
npm --prefix packages/office-docx run build
npm --prefix packages/office-docx test
```

`build` 自动准备并逐个校验 `source-lock.json` 中505个原始文件的Git blob SHA1/字节长度，固定 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`。默认首次从固定GitHub raw下载；缓存存在时只校验。离线提供同一commit源码：

```sh
node packages/office-docx/prepare-source.mjs --source /path/to/fixed-genoffice-checkout
node packages/office-docx/prepare-source.mjs --verify-only
```

上游缓存不打补丁。`renderer-build.mjs` 用精确匹配/AST变换实现可重建的宿主适配，变换点变化会使构建失败。`pin-renderer-source.mjs` 可从固定checkout再生成来源闭包，非运行README不复制，LICENSE/NOTICE保留。`vendor-web/web-bridge.ts` 为固定 `Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4` 原文，`web-source-lock.json` 固定SHA256；`extract-web-helpers.mjs` 从中抽取浏览器选图、图片剪贴板与HTML下载helper，不复用任意路径relay。

依赖只在本包独立lock固定，Tiptap3.31与主App Record隔离。构建收集源码/npm许可证到`dist/THIRD-PARTY-NOTICES.txt`。`upstream/`、`dist/`、`node_modules/`、`test/output/`为本包忽略的可重建缓存/产物。

## 运行时接线

将本包整个`dist/`复制到宿主`office-dist/docx/`。

| 产物 | 用途 |
| --- | --- |
| `engine.mjs` | 内存inspect/edit；npm库已打包，只依赖Node内建模块 |
| `full-editor.mjs` | 轻量完整编辑器宿主；默认加载相邻 `renderer.html`，可通过第三参数传入同源 URL |
| `renderer.html` / `renderer.mjs` / `renderer.css` | 外部完整 renderer；HTML 仅引用 CSS 和模块脚本，屏幕字体保留原 CSS/assets 加载方式 |
| `renderer-resources.json` | `{entry:"renderer.html",files:[相对路径]}`，完整资源闭包供宿主原样 staging；不含 engine、legacy bundle 或构建元信息 |
| `print-fonts.json` / `print-fonts/` | 屏幕字体到打印派生字体的路径映射及原字节；输出请求时才读取映射和所需字体 |
| `editor.mjs` | 兼容 legacy mountEditor 与自包含 mountFullEditor；约39MiB，主产品使用 slim 入口 |
| `editor-shell.css` | React宿主section/iframe尺寸及错误样式 |
| `editor-document.css` | 保留给legacy mountEditor；完整iframe内部已包含文档样式 |
| `runtime-manifest.json` | 引擎资源/sidecar及编辑器CSS清单 |
| `*.d.ts` / `*.d.mts` | 公共API与类型 |
| `THIRD-PARTY-NOTICES.txt` | 固定来源和依赖许可证 |

完整入口为 `dist/full-editor.mjs`：`mountFullEditor(element, options, rendererUrl?)`。不传第三参数时加载 `new URL('./renderer.html', import.meta.url)`，直接将 package dist 放在同源静态服务器即可使用。主产品 wrapper 通过 `?office-resource` 获取 staging 后的 HTML URL 并传入第三参数；staging 必须将 `renderer-resources.json` 中全部文件原样输出到同一目录，保留相对路径。该宿主模块不引用 renderer HTML 字符串、React 或字体数据。parent 在 iframe 导航前同步设置 frame options；保存 ack、只读、替换、销毁和等待输出共用 legacy 的生命周期实现。

打印/PDF/图片输出沿用 `buildPrintDocument` 的已加载字体、字重、unicode-range 和使用字符筛选；外链 CSS URL 按其 `stylesheet.href` 解析。只有输出需要时读取 `print-fonts.json`、获取对应派生字体并生成自包含 HTML。失败沿用可见错误和原生回执路径，不回退到错误的屏幕字体。legacy 自包含入口继续使用其原 Blob URL 字体映射。

完整 renderer 的 `EditorOptions.presentationMode?: 'preview' | 'edit'` 默认 edit；preview 强制只读，保留分页计数和缩放，隐藏整个编辑 Ribbon；文件输出统一由宿主第一行图标菜单调用，不渲染第二行。`DocxEditor` 透传该属性并纳入 update 依赖。切换复用同一 iframe/live editor，不切换上游 readMode，不重设文档宽度、zoom、fit 选择或 undo 历史。底部缩放对话框属于只读可用的 view dialog。预览与编辑均使用同一完整外部 renderer；slim 仅拆出宿主与静态资源，不另建预览渲染器。旧 mountEditor 行为保持原实现，返回 LegacyEditorController（不包含完整 renderer 的 output）。

## 内存格式 API

```ts
const model = await inspect(bytes); // DocxModel，含原始sourceBase64和SHA256 baselineHash
const textBytes = await edit(bytes, [
  {type:'text',nodeId:model.nodes[0].id,expectedText:model.nodes[0].text,text:'中文文字'},
]);
const structureBytes = await edit(bytes, [{type:'document',document:nextDocument}]);
// 完整renderer产出：必须单独使用，绑定原件baselineHash
const fullBytes = await edit(bytes, [{type:'snapshot',baselineHash:model.baselineHash,base64}]);
```

每次`edit`重新解析调用者原件字节，保留original/anchors，通过上游SavePlan写原ZIP；不从展示JSON重建整个包。document edit允许正文/标题/列表/分段/表格结构及已有图片几何变化；opaque原件payload仍受保护。已有chart的值和嵌入workbook一同更新，不支持的series/category结构明确拒绝。完整renderer使用上游buildDocBytes，包含页眉页脚、页面/节、批注、修订、notes、样式、引用、墨迹等真实保存状态。

snapshot路径验证唯一edit、严格JSON/base64、基线hash、原件写保护和输出DOCX；它是同一受信renderer生成的完整格式草稿，不能替代native文件CAS。源编辑保护仍执行。UTF/JSON/schema/ZIP解压预算边界保留，错误不静默降级。

## React 与保存契约

```tsx
<DocxEditor model={model} edits={edits} onChange={setEdits} readOnly={saving}
  registerBeforeSave={registerBeforeSave}
  onPendingChange={setPending}
  onSaveRequest={() => save()}
  onExport={file => exportFile(file)}
  onPrint={document => printDocument(document)}
  onRenderPdf={document => renderEditorPdf(document)}
  onGetSystemFonts={() => desktopApi.listSystemFontFamilies()}
  onFontMetrics={family => desktopApi.editorFontMetrics(family)}
  onConvertAltChunkHtml={html => convertAltChunkHtml(html)} />
```

旧四props仍可用。可选`registerBeforeSave(callback)`返回注销函数；保存前必须await callback，活动表格/文本框/页眉等子输入提交后生成完整草稿，IME组合中拒绝保存。异步图片插入仍在进行时等待完成。`onPendingChange`通知尚未形成草稿的输入/异步工作，`readOnly`锁正文、子编辑器、Ribbon修改工具和编辑对话框；独立输出入口和打印范围对话框仍可用，输出不写原件。`onSaveRequest`返回宿主真正保存Promise；上游内部save等待回执，错误原样拒绝。

原生成功后重新inspect实际已写字节，并一起传新model及`edits:[]`。新model.sourceBase64精确等于最后发出的snapshot时只确认基线，保留iframe、selection和undo/redo；真正外部版本替换重建编辑器并清历史。失败保持原model/edits。renderer始终以初始source/anchors生成累积编辑快照，外部baselineHash随成功回执推进。

每次mount独立绑定ready/回调身份；外部替换或关闭使旧beforeSave立即拒绝，旧异步转换、序列化、native回执不能发布到新File、释放新ready或调用新保存。成功保存receipt不使当前mount失效。

`onExport?: (file:{name:string;mime:string;bytes:Uint8Array})=>Promise<boolean>`：true表示宿主已写入，false表示用户取消，reject表示实际失败。HTML/图片另存优先await该回调；仅未提供宿主回调时使用standalone浏览器下载。native负责用户授权目标和原子写入，renderer不传任意路径。

`onPrint?: (document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}})=>Promise<void>`优先接收真实选定分页页片、print CSS和data内嵌字体/图片；await native回执后上游对话框才关闭，reject保留对话框并显示失败。HTML不含App编辑控件/脚本；未能内嵌的必需资源明确失败。无回调才使用standalone window.print，不能当作WKWebView桌面打印验收。`pageSize` 来自真实选中页片，pt=1/72英寸。

`onRenderPdf?: (document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}})=>Promise<Uint8Array>` 返回真实PDF字节。保留原分页分组、10页chunk/失败分割与混合纸型顺序，group的twips/20传native，再用pdf-lib合并；原pdf.js按192DPI生成逐页PNG，ZIP经onExport写入，无任意目录会话。native PDF文字/视觉必须单独验证，mock真PDF fixture仅证明回调/合并/PNG流程。

`onGetSystemFonts?:()=>Promise<string[]>`、`onFontMetrics?:(family:string)=>Promise<FaceVerticalMetrics|null>` 接真实宿主字体枚举/字体表度量。`onConvertAltChunkHtml?:(html:string)=>Promise<Uint8Array|null>` 接真实HTML/MHT转换临时DOCX；上游保留原件chunk。缺桥/失败有可见提示；真实 converter 在独立office-html2docx包实现，不能以fixture回执声称转换完成。

`onFetchImage?:(url:string)=>Promise<{mime:"image/png"|"image/jpeg"|"image/gif";base64:string}>` 接宿主受限公网图片读取。原件身份与版本由宿主/native核验；本包等待pending操作和图片插入、拒绝只读/失效mount；native错误原message显示且拒绝保存，不吞成null或回退浏览器。仅standalone没有回调时保留CORS fetch。

## UI、隔离与平台差距

完整上游Ribbon、分页、表格/图片handles、页眉页脚和编辑对话框均复用；不隐藏可保存的缩放/拖动。父文档实际`data-theme`/`.dark`、字体及颜色token同步，iframe内CSS不进入主App。所有有界滚动区域提供随剩余距离连续变化的边缘遮罩，ResizeObserver/内容变化更新，reduced-motion取消动画和smooth滚动。

源链接保留在DOCX model/原件中，特权渲染DOM去除导航/事件属性；正常、protected NodeView和子编辑器适用同一局部adapter。不改上游原文、没有全局DOM monkeypatch。

原生PDF/PNG/打印回调、字体列表和metrics已接主宿主。真实macOS PDF的CFF CID正文ToUnicode与合成粗体重复复制已修复：[可重建打印专用TrueType派生字体](print-fonts/README.md)+打印副本单次fill/stroke，原屏幕字体不变；实际native PDF的正文/表格/HF/第三页、粗体完整段落只1次，pypdf/PDFium及主线程PDFKit与PNG目视通过，SHA见功能矩阵。实际altChunk helper的富文本/列表/表格/图片、另段编辑、原件保留、重开Chrome/WebKit完整流通过。Zotero TCP桥、系统拼写API仍有明确实现差距，本包不继续扩展这些新实现。远程图片onFetchImage接线与双浏览器各4组真实粘贴/保存/生命周期通过，主实际native全模块12/12通过。用户2026-10-18明确排除整文件加密文档，不再记为缺口；保护对话框移除打开密码项与误导提示，普通settings编辑限制/writeProtection保留。完整独立App管理/更新/重复AI聊天及图床设置/上传也是非目标。

## 针对性验证

当前包单测17/17通过；主编辑/两轮保存/历史在Chromium155和WebKit26.5通过。对象、输出和平台调用的最新结果见功能矩阵，不沿用旧局部编辑器的验收声称完整App通过。

浏览器脚本显式opt-in，不在build/test中启动浏览器：

```sh
node packages/office-docx/test/browser-server.mjs
# 使用该server输出的URL及已有Playwright，不自动下载浏览器
OFFICE_ACCEPTANCE_URL=http://127.0.0.1:PORT \
OFFICE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
OFFICE_WEBKIT_EXECUTABLE=/path/to/existing/webkit/pw_run.sh \
node packages/office-docx/test/browser-parity.mjs
```

`browser-parity.mjs`验证主输入/两轮真实DOCX保存/undo/redo/主题；`browser-objects.mjs`验证图片/表格/页眉/页面；`browser-receipt.mjs`验证native save Promise；`browser-affordance.mjs`验证连续遮罩/reduced-motion；`browser-output.mjs`验证浏览器输出边界；`browser-native-export.mjs`验证宿主导出成功/取消/失败；`browser-native-print.mjs`验证选页/data资源/pageSize/回执；`browser-native-pdf.mjs`验证真PDF fixture混合页合并/192DPI PNG/字体桥；`browser-readonly-output.mjs`验证只读四输出且原件不写入；`browser-tables.mjs`验证列宽/选择/合并/拆分；`browser-paste.mjs`验证异步I/O与保存等待/失败；`browser-output-layout.mjs`生成1440/640/490截图并核对宿主输出handler、hit target/连续遮罩。

这些脚本共享server当前bytes，**同一server顺序执行**。poisoned链接用独立`OFFICE_DOCX_POISONED_LINKS=1` server运行`browser-link-acceptance.mjs`。输出在`test/output/browser/`，不启动可见应用或Tauri；root集成检查由主agent执行。

原生PDF文本检查（使用带pypdf的现有Python runtime）：`python test/verify-native-pdf-text.py /path/to/actual-native.pdf`；altChunk专用server设`OFFICE_DOCX_ALT_CHUNK=1`，其fixture回执测试仅验证Word接法/原件保留，不代替真实转换helper。

真实altChunk设`OFFICE_DOCX_ALT_CHUNK=rich`，运行`browser-alt-chunk-real.mjs`，使用独立helper的实际dist（先由其owner构建）；`OFFICE_BROWSER=webkit|chromium`可只重跑受影响浏览器。`browser-lifecycle.mjs`用普通server的`/lifecycle`专用入口，延迟真实converter/JSZip后替换字节不同的model或dispose；`OFFICE_LIFECYCLE_CASE=conversion|serialization`仅重跑相应边界。

最新远程图片回归：`browser-native-image.mjs`验证宿主回执、真实DOCX media/重开、原错误可见、只读和晚回执；`OFFICE_IMAGE_CASE=paste|lifetime|readonly`只重跑对应组。Chrome155/WebKit26.5各4组通过。`browser-protection.mjs`验证无整文件打开密码UI、普通writeProtection保留、新编辑限制保存重开，两浏览器通过。Native受限下载模块由主实际注册编译，`editor_remote_image`全模块12/12通过（2.63s）；本agent未运行Cargo。该远程图片/保护工作包于2026-10-18 19:39完成，历史指纹见Word矩阵；当前冻结点见下。

## 2026-10-18 宿主输出与紧凑 chrome（#191）

- 范围：仅 packages/office-docx；主负责宿主第一行统一图标菜单。本包没有 File 菜单入口，file-menu.tsx、构建引用和死菜单 CSS 已删除。不改 pinned upstream、字体/打印内容逻辑、root/src/docs，不运行根构建/stage/native GUI/全测。
- renderer-build.mjs 从固定 TypeScript JSX AST 精确选择并删除 AiPanel 外层 ai-dock、AiAskPopover、home AI group 和紧邻 following separator，以及 QAT 保存/autosave/分隔线；节点数量和 following separator 不符即构建失败。Clipboard 等真实编辑组与 QAT undo/redo 保留。
- 状态栏两态统一28px高、12px文字和24px控件；page、zoom 固定，其他信息/视图控件置于 pm-status-info 的有界横向滚动区，复用 scroll-edges 连续渐变、反向归零和尺寸/内容更新。预览无 Ribbon 第二行，两态仍复用同一完整文档/分页/zoom。
- 正式接口：EditorController.output(command: 'pdf' | 'images' | 'html' | 'print' | 'preview'): Promise<void>。mountFullEditor 在请求时捕获当前 Mount，沿用 ready + runCurrent + cancelled 生命周期；等待真实 renderer-host.output，不在 src 宿主直接访问 iframe globals。preview 通过同一 FileActionContext.setShowPagePreview 打开原分页预览；print 打开原选页打印对话框，PDF/图片/HTML 仍走已有原生回调与回执、取消和可见错误路径。旧内容编辑器 mountEditor 不具备完整输出，返回原有方法的 LegacyEditorController 类型，无伪造输出实现。
- 测试宿主通过 DocxEditor.registerOutput 注册真实 handler；output-command.mjs 调用该 handler 并记录 pending/resolved/rejected，不重造菜单。presentation-harness 则直连正式 mountFullEditor controller，覆盖 ready 前预览与销毁取消未完成输出。
- 真跑命令与最终结果见本节后续收口记录；浏览器证据位于 test/output/browser/，与真实系统打印/主 App 菜单验收分开记录。

### 本轮真实验证与冻结

固定 Node 24：在仓库根目录设置 `NODE_BIN="${NODE_BIN:-src-tauri/resources/agent-host/node}"`；下列命令均在仓库根目录执行。

- `"$NODE_BIN" packages/office-docx/build.mjs` 成功，505固定上游来源校验通过；本轮只构建本包一次。
- `"$NODE_BIN" packages/office-docx/test/browser-server.mjs` 提供 headless 测试宿主（最终 http://127.0.0.1:53787）；环境统一为 `OFFICE_ACCEPTANCE_URL`、`OFFICE_PLAYWRIGHT_MODULE`、`OFFICE_WEBKIT_EXECUTABLE`，分别指向当前测试宿主、已安装 Playwright 模块及 WebKit 启动器，由运行环境提供路径。
- `"$NODE_BIN" packages/office-docx/test/browser-output-layout.mjs`：Chromium155/WebKit26.5，1440/640/490均通过；无File/AI/QAT保存/autosave/前导分隔线，Clipboard/QAT两按钮保留，状态栏28px/12px/24px、page/zoom固定、信息横向滚动及连续边缘渐变/反向归零、真实输出preview、字体popover有效。最初测试把上游redo中文误写为“重做”，实际为“恢复”，已按固定上游文案修正测试，无产品失败。
- `"$NODE_BIN" packages/office-docx/test/browser-presentation.mjs`：两浏览器通过同iframe/document/live editor、三页正文、两态手动40%和整页fit保持、实际QAT undo/redo、独立readOnly锁、490px两态、preview无第二行；分页几何最大偏移均0。新output在ready前调用preview会等待；HTML原生回执未到保持pending，销毁后及时reject，晚回执不能改为成功。errors=[]。
- `"$NODE_BIN" packages/office-docx/test/browser-readonly-output.mjs`：两浏览器经真实宿主registerOutput/controller.output调用HTML/PDF/PNG ZIP/第2页打印均通过；原件字节相同，edits=[]、pending=false、正文与编辑控件锁定，随后可解锁编辑。
- `"$NODE_BIN" packages/office-docx/test/browser-native-export.mjs`：Chromium通过真实HTML/原PNG字节、await receipt、取消与失败可见、无anchor fallback。
- `git diff --check -- packages/office-docx` 通过。产物meta无file-menu.tsx，适配CSS无死菜单选择器；未跑root build/stage、Cargo、native GUI、全测或提交/发布。

证据：test/output/browser/output-layout-{chromium,webkit}-results.json 与各尺寸PNG、presentation-{chromium,webkit}-results.json 与490PNG、readonly-output-results.json、native-export-results.json。系统菜单/打印面板及HMR稳定reload由主集中验收，本包不把fixture回执声明为真实系统打印成功。

上述格式包验证之后，又接入共享 `packages/editor-chrome` 的缩放与工具栏样式；当前集成验证见 `docs/implementation/genoffice-review-fixes-20261018.md`。自建headless server已停止。

- 当前共享 chrome 构建 dist/editor.mjs SHA256：`7d68fcbc1e0c7f6e10c179034fdfd898c960650c9408d54624017e0db938f088`
- 当前共享 chrome 构建 dist/renderer-resource.mjs SHA256：`39c08c0a439dbe9e68db39c840fb267a8b3f6450d0d9ae6aaf2a0af4f57136c7`

## External renderer 本包验收

工作包：Word 首开性能，复用 #191/#118 的完整 renderer；依赖现有固定 upstream 与打印派生字体。交付为 slim 入口、可搬移资源 manifest、按需打印字体加载。本包不修改根 wrapper/Vite staging，不改变格式引擎、字体字节或原生实现，不以浏览器数据代替 Tauri 性能结论。

命令在仓库根目录执行，使用上述 `NODE_BIN` 设置；以下记录验证范围，不代表本次文档整理重新运行验证。

- `"$NODE_BIN" packages/office-docx/build.mjs`：只构建本包，验证固定来源、字体 provenance 和许可证。
- `"$NODE_BIN" --test packages/office-docx/test/build.test.mjs packages/office-docx/test/editor.test.mjs`：slim 依赖边界、manifest/CSS 资源闭包、全部屏幕字体原字节、5 对打印字体哈希、legacy 编辑和独立 worker 搬移。
- 显式启动 `test/browser-server.mjs` 后，设置既有 `OFFICE_ACCEPTANCE_URL`、`OFFICE_PLAYWRIGHT_MODULE`、`OFFICE_WEBKIT_EXECUTABLE`，运行 `browser-external-renderer.mjs`、`browser-presentation.mjs`、`browser-lifecycle.mjs`、`browser-receipt.mjs`、`browser-native-print.mjs` 和 `browser-readonly-output.mjs`。全部为 headless 浏览器；native 回调使用测试宿主，不启动原生窗口。
- browser server 将 `?office-resource` 映射到 `/word-renderer/renderer.html`，仅服务 manifest 中的 renderer 文件；`/standalone` 使用未打包的 `full-editor.mjs` 验证默认相邻 URL。源码 lifecycle/presentation harness 显式传同源静态 URL。
- preview 关闭后，上游异步重建 canvas 分页 decorations；presentation 验收先等待原有两条真实边界，再执行原几何/缩放/实例断言。

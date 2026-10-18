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
| `editor.mjs` | legacy mountEditor + 完整mountFullEditor；自包含renderer、CSS、字体和parse worker，约39MiB（含屏幕字体和打印专用派生字体） |
| `editor-shell.css` | React宿主section/iframe尺寸及错误样式 |
| `editor-document.css` | 保留给legacy mountEditor；完整iframe内部已包含文档样式 |
| `runtime-manifest.json` | 引擎资源/sidecar及编辑器CSS清单 |
| `*.d.ts` / `*.d.mts` | 公共API与类型 |
| `THIRD-PARTY-NOTICES.txt` | 固定来源和依赖许可证 |

`DocxEditor.tsx` 相对动态导入`dist/editor.mjs`并挂载完整renderer，Vite可解析；无需根Tiptap升级或额外静态资源路由。完整上游字体为Blob URL，iframe销毁时浏览器释放其文档资源。

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

`browser-parity.mjs`验证主输入/两轮真实DOCX保存/undo/redo/主题；`browser-objects.mjs`验证图片/表格/页眉/页面；`browser-receipt.mjs`验证native save Promise；`browser-affordance.mjs`验证连续遮罩/reduced-motion；`browser-output.mjs`验证浏览器输出边界；`browser-native-export.mjs`验证宿主导出成功/取消/失败；`browser-native-print.mjs`验证选页/data资源/pageSize/回执；`browser-native-pdf.mjs`验证真PDF fixture混合页合并/192DPI PNG/字体桥；`browser-readonly-output.mjs`验证只读四输出且原件不写入；`browser-tables.mjs`验证列宽/选择/合并/拆分；`browser-paste.mjs`验证异步I/O与保存等待/失败；`browser-output-layout.mjs`生成1440/480截图并核对hit target/连续遮罩。

这些脚本共享server当前bytes，**同一server顺序执行**。poisoned链接用独立`OFFICE_DOCX_POISONED_LINKS=1` server运行`browser-link-acceptance.mjs`。输出在`test/output/browser/`，不启动可见应用或Tauri；root集成检查由主agent执行。

原生PDF文本检查（使用带pypdf的现有Python runtime）：`python test/verify-native-pdf-text.py /path/to/actual-native.pdf`；altChunk专用server设`OFFICE_DOCX_ALT_CHUNK=1`，其fixture回执测试仅验证Word接法/原件保留，不代替真实转换helper。

真实altChunk设`OFFICE_DOCX_ALT_CHUNK=rich`，运行`browser-alt-chunk-real.mjs`，使用独立helper的实际dist（先由其owner构建）；`OFFICE_BROWSER=webkit|chromium`可只重跑受影响浏览器。`browser-lifecycle.mjs`用普通server的`/lifecycle`专用入口，延迟真实converter/JSZip后替换字节不同的model或dispose；`OFFICE_LIFECYCLE_CASE=conversion|serialization`仅重跑相应边界。

最新远程图片回归：`browser-native-image.mjs`验证宿主回执、真实DOCX media/重开、原错误可见、只读和晚回执；`OFFICE_IMAGE_CASE=paste|lifetime|readonly`只重跑对应组。Chrome155/WebKit26.5各4组通过。`browser-protection.mjs`验证无整文件打开密码UI、普通writeProtection保留、新编辑限制保存重开，两浏览器通过。Native受限下载模块由主实际注册编译，`editor_remote_image`全模块12/12通过（2.63s）；本agent未运行Cargo。源码/dist于2026-10-18 19:39冻结，主集中build/stage，详细指纹见Word矩阵。

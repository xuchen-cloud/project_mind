# GenOffice 原生 HTML 打印与 PDF 宿主

## 工作包

- 关联 Issue：[#191](https://github.com/xuchen-cloud/project_mind/issues/191)，父需求 #118；共享分支 `codex/genoffice-editor-parity`。
- 依赖：四格式生成完整打印 HTML（CSS、data 图片及实际使用的字体）；主 agent 注册两个 native command、runtime adapter 与格式宿主 props。Windows 直接依赖 `webview2-com = "=0.38.2"`，与 Wry 0.54.4 使用同版，主已添加。
- 文件归属：本 agent 负责 `src-tauri/src/editor_print.rs`、本文及用户追加授权的验收 example `src-tauri/examples/editor_pdf_verify.rs`。原先创建的 `src/services/editorPrint.ts` / test 已移交主 agent，当前由主维护 adapter 接入与验证。
- 交付：独立随机 label 的文档 Webview；隐藏加载、sandbox 隔离、真实资源 ready；系统原生打印面板；无面板原生 PDF base64 输出；结束和失败后销毁临时窗口。
- 非目标：File/CAS、格式 HTML 生成器、任意路径服务、主应用 DOM、根依赖和注册修改、通用打印框架、Issue 发布。用户禁止本包启动 review agents、可见应用或 Tauri watch、git 操作及根全量验证。
- 验收：100 MiB UTF-8 HTML 输入预算与 100 MiB PDF 解码后输出预算；一个文档 slot，无无限队列；caller 来自 Tauri 自动注入；无外部请求、输入脚本、导航、新窗口、下载或 IPC 权限；ready 不依赖 sleep；不得用 `window.print()`；面板完成后才释放文档。PDF 必须用真实 WKWebView 验证纸张、分页和内容。

## 接口与边界

```text
desktop_print_editor_html(app: AppHandle, window: Window,
  input: { html: string, title?: string, pageSize?: { widthPt: number, heightPt: number } }) -> Result<(), String>
desktop_render_editor_pdf(app: AppHandle, window: Window,
  input: { html: string, title?: string, pageSize?: { widthPt: number, heightPt: number } }) -> Result<string /* PDF base64 */, String>
```

`window` / `app` 由 Tauri 注入，JSON 禁止额外字段。仅允许主窗口 `main` 与实际项目窗口 `project-<正整数>`；前端不能提交 caller 或文件路径。title 上限 1024 UTF-8 字节。pageSize 每边须为 1–14400 pt 有限值；CSS px 乘 0.75 转为 pt。None 表示平台默认纸张，不承诺从 @page 推断；固定纸张格式必须传真实尺寸。每次操作一个纸张尺寸，Word 复用现有同尺寸页组及 pdf-lib 顺序合并。格式包负责图片、字体与完整 HTML，宿主不会下载资源或用主应用页面代替。

100 MiB 输入预算按用户要求与本包文档/export 边界对齐。早期 10 MiB 会拒绝实际 Word/Excel 多页字体输入，不能作为普通文件预算。只允许一个打印/PDF 文档同时工作；bootstrap、IPC、浏览器和 base64 仍会有额外内存副本，100 MiB 是输入/输出字节上限，不是峰值内存承诺。

原生自选 `tempfile` 私有目录，PDF 保存完成后先检查文件大小，再做有界读取，检查 PDF 头及末尾 EOF 后编码。所有正常成功与错误路径均清理目录和文档窗口；清理失败不吞错。PDF 头/EOF 只验证传输完整性，页数、尺寸和内容由真实验收 PDF 解析验证。

## 文档隔离与 ready

临时 label 为 `editor-print-<128bit随机值>`，不匹配任何应用 capability。父文档只有受控 bootstrap 和一个 `sandbox="allow-same-origin"` iframe，没有 `allow-scripts` / `allow-modals` / forms / popups。HTML 作为 JSON 字符串进入 native 初始化脚本，不能通过 `</script>` 逃逸。

父与子都使用 `default-src 'none'`，仅允许 `img-src data:`、`font-src data:` 与 `style-src 'unsafe-inline'`；父额外允许 `frame-src about:`，子禁止子 frame/object/base/form。父也必须声明 data 图片字体，因为 srcdoc 继承父 CSP，子 meta 不能放宽父限制。

ready 等待所有 img.decode、CSS background-image data URL 解码、FontFace.load 与 document.fonts.ready；资源失败向 native 返回 failed。之后按实际 DOM 矩形的 subpixel 高度设置 iframe，并在 beforeprint 再匹配排版；不能用整数 scrollHeight 导致整页文档溢出尾部空白页。显式 pageSize 同时控制父 @page 和 iframe 排版宽度。格式 @page 规则仍复制到父，但 named @page 不会让父 iframe 对应元素取得该命名页；不能依赖它提供混合纸张。加载超时 30 秒。

父页使用固定、无脚本的 data HTML 触发真实 WK navigation/document-start；主已正式启用 Tauri webview-data-url feature。初始化脚本用一次性 window 标记防重入，并用 DOM API 构造父 head/body，不再 document.open/write/close（实际 WK 曾重复触发 srcdoc 导航）。隐藏 Webview 禁用后台节流。

信号使用每任务随机 URL `https://editor-print.invalid/<nonce>/{ready,failed,afterprint}`；native 精确匹配并阻止实际导航。其他导航只允许固定 bootstrap 和 srcdoc，新窗口和下载均拒绝。输入 iframe 无脚本，无法读取随机 native 信号或触发 IPC。

## 平台 API 与生命周期

### macOS

本机源码：Tauri 2.10.3 WebviewWindow.print 仅投递 dispatcher；Wry 0.54.4 `wkwebview/mod.rs` 调用 `runOperationModalForWindow:delegate:nil...` 并允许独立线程，返回不代表面板完成。本包通过 with_webview 在 UI 线程取得 WKWebView，自行创建 NSPrintOperation，启用 canSpawnSeparateThread，并注册真实 completion delegate；等待该回调后才清理文件与窗口。delegate 可能由打印线程调用，通过 oneshot 返回结果，不使用 timer 猜面板生命周期。

**已纠正的具体故障**：早期使用同步 runOperation，真实隐藏 A4 已 ready 后会持续写大量空页。[Apple 文档](https://developer.apple.com/documentation/appkit/nsprintoperation/canspawnseparatethread)明确只有 runModal 才允许派生打印线程，即使给 runOperation 设置 canSpawnSeparateThread 也不会生效。[WebKit WKPrintingView 源码](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WKPrintingView.mm)显示：主线程预览路径异步计算 page rects，尚无结果时先报告 NSIntegerMax；次线程打印路径才会等待完整 PDF 页数据。改为异步操作与 delegate 后，实际 A4、16:9、Word 与 Markdown 的原生 PDF 生成均能完成并退出；同步 runOperation 路径已移除。

打印使用系统面板；completion 的 false 无法可靠区分取消和系统失败，返回“打印已取消或系统打印失败”，不计为打印成功。PDF 使用 NSPrintInfo copy、NSPrintSaveJob / NSPrintJobSavingURL，关闭 showsPrintPanel 与 showsProgressPanel，不显示临时窗口。显式 pageSize 设置 NSPrintInfo.paperSize 与零边距；WK preferences.shouldPrintBackgrounds=true。

**纸张约束已实证**：仅复制 iframe 的 CSS @page 不足以设置 NSPrintInfo。基线 16:9 和 named mixed 均落成默认 A4，A4 双页多出空页；修复后的真实 PDF 结果见下表。混合纸张由调用方已有页组生成独立 PDF 再顺序合并，不能给一个 macOS 操作传 named @page 就声称完成混合纸张。

### Windows

Wry 0.54.4 的 Windows print 实际 eval window.print，故本包直接调用 ICoreWebView2_16.[ShowPrintUI](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_16) SYSTEM 模式。ShowPrintUI 不接受纸张设置对象；pageSize 传入顶层 CSS，但系统面板实际纸张及缩放取决于用户/打印机设置，尚未实机核验。API 返回仅表示调用成功；受控父文档等待 afterprint 再清理，最长 10 分钟。

[Microsoft 维护者讨论 #4027](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/4027) 建议 afterprint 通知 native，并给出 **BROWSER 模式**示例；[官方打印指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/print) 未保证 SYSTEM 模式一定触发该事件。因此 SYSTEM 的完成/取消事件及超时后面板归属仍待 Windows 实机验收，不宣称已验证安全完成时机。

PDF 调用宿主专用 CDP Page.printToPDF，printBackground / preferCSSPageSize 为 true、margin 全零、ReturnAsBase64，显式 pageSize 时写入 paperWidth/Height=pt/72，preferCSSPageSize=false；等待 COM 完成回调（120 秒超时），不依赖 afterprint、不开放调试端口。[Chromium 上游测试](https://chromium.googlesource.com/chromium/src/+/07e00304378460e29748e2a9499453b0fe985a25/chrome/browser/devtools/protocol/devtools_printtopdf_browsertest.cc)可佐证参数语义；本机无 Windows，不能据此宣称 WebView2 实际分页或功能已通过。

## 已有验证与复用范围

- 最终 Rust 定向 **8 项通过**（0 failed，1210 filtered out，0.03s）：输入 UTF-8/100 MiB 预算/caller、精确信号、bootstrap 隔离、PDF 编码/完整性/100 MiB 输出边界、拒绝路径和 caller JSON、显式 pageSize 的有限值/范围/JSON 字段。`rustfmt --check` 两个 Rust 文件通过。编译仅有其他模块既有 dead_code warnings。
- 初期 service 定向 3 项通过；主随后接 runtime adapter 并报告两文件 37 项通过。本 agent 不重复修改或重跑主负责的 service 测试。
- 实际 headless Chromium 与 WebKit 各 4 项 bootstrap 验证通过：data PNG + 真实 Montserrat WOFF2 ready、脚本不可执行；外部图片失败且无外部请求；损坏 data 图片失败；长文档高度完整。只替换原生 signal transport，不替换 CSP/iframe/资源等待逻辑。这不是系统 WKWebView 或原生打印验收。
- 已复用格式 agent HTML，在 Chromium 与 WebKit 中真实加载图片、所有字体 ready：Word 两个选页版本 16,723,121 字节，SHA256 `c546d8d92960faf09842029a001c0a443d43af837695b8eeb2b9ad8d76926999`；Excel 两页 11,025,389 字节，SHA256 `31ad7014d0b235069e33bd2b181e5adffbc1719a85dc0a7ea5d2adda51504085`。格式 agent 此后已更新 Word fixture，以上仅对应当时字节，不冒充当前版本证据。

## 2026-10-18 真实 native 验收

环境为 macOS 26.5.2 (25F84)、Apple Silicon、系统 WKWebView；Tauri 2.10.3 / Wry 0.54.4。example 直接 #[path] 包含正式模块并调用正式 command；hidden main、ActivationPolicy::Prohibited，PDF 无窗口、打印/进度面板、主应用、数据库、前端服务或 watch。生产不设置 Prohibited。最终已删除临时 native debug 日志。

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml \
  --config 'profile.test.package.project_mind_alpha.debug=0' --lib editor_print --quiet
cargo run --offline --manifest-path src-tauri/Cargo.toml --profile test \
  --config 'profile.test.package.project_mind_alpha.debug=0' \
  --example editor_pdf_verify -- /tmp/genoffice-native-pdf-geometry \
  595.5x841.5:packages/office-docx/test/output/browser/native-print.html \
  packages/markdown-editor/output/playwright/native-print-prepared.html
```

正式 `editor_print.rs` SHA256 为 `e65cc9df7b7e59640073270b83c679ff0abe2cdc9a655e5081515bad6050fbf9`；example SHA256 为 `71b01dd5b7353ab4f3942efef94ead5b874673f520c25e6c8caac8dc5238cdb6`。Windows 最终增量检查可对照此正式模块版本。

复验可直接执行 `src-tauri/target/debug/examples/editor_pdf_verify` 加相同参数，不需重新编译。fixture 参数可为 `WIDTH_PTxHEIGHT_PT:HTML_FILE`；没有尺寸前缀即平台默认。内建 A4 双页、16:9；混合验收用 office-docx 已有 pdf-lib 将这两个真实原生 PDF 依次 copyPages 合并，并由 PDF.js 解析 MediaBox、页数、文本/图片操作。

| 原生输出 | 字节数 | 页数与 MediaBox (pt) | 实际证据 |
| --- | ---: | --- | --- |
| A4 | 12,692 | 2 × 595×842 | 两段英文分别在第一页/第二页，无尾部空页 |
| 16:9 | 10,474 | 1 × 720×405 | 文本 `16:9 native text` 可提取 |
| mixed 合并 | 20,595 | 595×842, 595×842, 720×405 | 原始顺序和三个文本一致 |
| Word 选页 fixture | 257,756 | 2 × 595×842 | 第一节、第二节分别在两页；1 个图片绘制，真实嵌入字体；PNG 页眉页脚、正文、表格、图片可见 |
| Markdown fixture | 30,468 | 1 × 595×842 | 中文、表格、checkbox、图片、KaTeX 可见；6 个字体资源、1 个图片绘制 |

PrintCore 将部分小数纸张尺寸取为整数 pt；当前实测与输入尺寸差不超过 0.5 pt。Word 输入是两个 794×1122 CSS px 页，显式传 595.5×841.5 pt；它的选择页生成由格式 agent 完成，此处消费实际输出，不模拟内容。

输入版本（不能以旧 fixture 测试冒充当前内容）：

- Word `packages/office-docx/test/output/browser/native-print.html`：9,520,449 UTF-8 字节，SHA256 `7724c92d8298bd72d590abb53399821e1f6e725cabafdf7203dc50a832a3513f`。
- Markdown `packages/markdown-editor/output/playwright/native-print-prepared.html`：372,162 字节，SHA256 `cd5e1bdc2f765671e72d133c289d4716c9a266381db71e09b935f6c6cf6a5697`。
- 输出 SHA256：A4 `eebfa88c4884e8912393afe88882e0d0c6f839d9b520e2f60951a11a12e8791b`；16:9 `70c0e2e191f8e320e661971c8633d1c4b8ef708f04bdc278fa47842934162791`；mixed `59911080f2c8ae26109323b94fd6f4e554a50e3ca357240c639eb6d64e6c1c47`；Word `3f8bd4095653cd3871d2a77531e084d1244d0a18049d1ff34bff050e4cf9b669`；Markdown `bf4842bb691251b107d58f6212195b109b258b37c5d5b0697d5c5e5721da7500`。

### 真实剩余缺口：Word 内嵌 CJK 字体的文本语义

**视觉正确不等于可复制中文正确。** PDFium 渲染的 Word 页眉页脚、正文与图片正确；PDF.js/PDFium 文本提取却有大量错误，主 agent 的系统 PDFKit 也无法正确读取正文，不能把 text items 数量当文本选择验收。

pypdf 检查真实 PDF 字典得到：`/C4 /NotoSerifCJKsc-Regular` 的 ToUnicode 流没有 bfchar/bfrange 映射；HiraginoSans-W4/W6 没有 ToUnicode，使用 Adobe Japan1 CID 信息；部分 PingFang 保留映射，标题可提取。进一步最小对照：

1. 相同 native command、纯系统 Hiragino/PingFang/Songti HTML，中文可提取（部分字采用 Unicode 兼容字形）。
2. 只复用 Word 当前内嵌 `Noto Serif CJK SC` font-face 的最小 HTML，`Embedded: 中文正文春风拂面` 稳定提取为 `Embedded: ╥丵堭丵但겚䥶ꨳ`；拉丁字母有映射，中文映射丢失。

输入字体也已解包核对：[WOFF2 标准目录/压缩规则](https://www.w3.org/TR/WOFF2/#table_dir_format)下，当前字体为 OTTO/CFF，所有表无附加 transform；解压保留原始表。platform 0/encoding 3 和 platform 3/encoding 1 的 format 4 cmap 均能正确查到中文 glyph。只换成相同字体表的 OTF 容器，仍提取相同乱码，排除单纯 WOFF2 容器因素。

进一步对齐内容流、输入 cmap 与 CFF charset：

| 字符 | 输入 cmap → GID | CFF charset → CID | 原生 PDF 内容流代码 |
| --- | ---: | ---: | --- |
| 中 | 1206 | 9573 | 0x2565 = 9573 |
| 文 | 5127 | 20021 | 0x4e35 = 20021 |
| 正 | 5900 | 22573 | 0x582d = 22573 |
| 春 | 5242 | 20294 | 0x4f46 = 20294 |
| 风 | 12521 | 44186 | 0xac9a = 44186 |

输入中文 cmap 完整，CFF 子集仍保留原字体 CID；原生输出写 CID，但未生成相应 ToUnicode。拉丁字符恰好 CID=GID，映射保留。证据支持此 GID/CID 不一致组合触发 WK/AppKit 输出映射缺口；并不等于这种 CID 字体格式本身非法。

**诊断对照已转绿**：仅在 `/tmp` 的解压字体中把 CFF charset CID 改为对应 GID，保持 cmap、字形及排版表不变、重算 SFNT checksum。同一正式 native command 输出的 ToUnicode 随即包含 `<04b6><04b6><4e2d>` 等中文映射，PDFium 与系统 PDFKit 均精确提取 `Embedded: 中文正文春风拂面`，视觉字形正确。未改正式 native 或格式包。这是最小字体封装修正的可行性证据，不冒充真实 Word 产品输出已修复。

临时复验材料：`/tmp/genoffice-inspect-woff2.cjs`、`/tmp/genoffice-normalize-cid.cjs`、`/tmp/genoffice-embedded-identity-cid-unicode.html`、`/tmp/genoffice-native-identity-cid-unicode/fixture-2.pdf`。若临时目录被清理，可由上表和以下步骤重建：从真实 Word HTML 提取 Noto Serif CJK SC font-face；解压其无 transform 的 WOFF2 表为 OTF；遍历 CFF format 1 charset 的每个 range，把首 CID 改为累计首 GID 而保留 range 长度；更新 CFF/head checksum；嵌入最小文本 HTML，再运行正式 helper 和精确文本断言。

因此不是单一 PDF.js 解码问题，也不是 HTML 输入已经乱码。正式字体候选/封装修正由 Word agent 核查，native helper 可直接复验候选；还须消费真实 Word 最新 HTML，再核验全文/视觉/分页。宿主不会猜测 PDF CID→Unicode 或重写文本掩盖错误。产品缺口尚未关闭，旧 Word fixture 的可选择/搜索/复制中文不算验收通过。

### Windows 与集成状态

- 主 agent 通过独立临时 crate 的 #[path] **直接包含正式** editor_print.rs/editor_font_metrics.rs，`cargo check --target x86_64-pc-windows-msvc` 成功（52 秒）；核心版本 tauri 2.10.3 / wry 0.54.4 / webview2-com 0.38.2 / windows 0.61.3。日志 `/tmp/genoffice-windows-modules-check.log`。这是模块编译，不是 Windows 安装包链接或运行。
- Windows 无实机：ShowPrintUI SYSTEM afterprint/取消/超时生命周期，CDP PDF 实际可用性、资源与纸张仍待验。
- 主负责 pageSize 公开 adapter/service 与四格式 callback 类型/传递，固定页必须来自真实排版尺寸。helper 手填尺寸的通过不能代替格式产品调用已传字段的证据。
- 新 Excel/PPT pageSize 打印 HTML 待格式 agent 提供后，复用已编译 helper 检查原生页数、尺寸、图表/图片与文本；不复跑旧 Word/Markdown 字节作为替代。
- macOS 真实系统打印面板的人工验收仍待安排，本包按用户要求只做无窗口 PDF 验收。
- 原生字体/图片管线、预算、异步完成、A4/16:9/顺序合并已取得真实证据；上述缺口仍需主整合，不能据此宣布 #191 完成。

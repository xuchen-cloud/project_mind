# #191 Word altChunk 浏览器 HTML → DOCX

## 工作包

- 交付：独立 `packages/office-html2docx`，供 Word 已有 `onConvertAltChunkHtml` 使用；纯浏览器输入 HTML、输出 DOCX bytes。
- 依赖：GenOffice 固定版本源码、独立 npm lock、DOMPurify、html-to-image、docx 9.7.1。宿主负责动态 import、用户操作、取消与错误展示。
- 范围：仅新包和本文档；不修改 Word、root manifests、原生服务、File 或 File Version。没有 ElectronDriver、通用 RPC、持久缓存或自动保存。
- 验收：中文、粗体、列表、表格、data 图片真实转换并读回 OOXML；合法链接保留；HTML 不能执行脚本、事件、导航或外部请求；图片/截图失败报错；取消销毁 iframe；固定上游闭包和完整许可。

## 固定来源与构建

实际读取并复用 [genspark-ai/genoffice 的 html2docx](https://github.com/genspark-ai/genoffice/tree/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/html2docx)，commit `d32d1711f1bf985430757b8c6b3fbddd3831d946`。转换主体包括原始 `convert.ts`、`extract.ts`、`generate.ts`、全部 browser helpers/core 与 generation 模块；复杂布局分类、截图决策、IR 和 OOXML 生成均使用上游实现。

`source-lock.json` 锁定 31 个源文件（含 LICENSE、NOTICE、架构、package 元数据），逐个验证字节数和 Git blob SHA-1。`prepare-source.mjs` 仅获取固定 commit 的这些文件，不运行上游安装脚本。上游源码保持逐字节不变，`upstream/` 和 `dist/` 均为可重建产物。Electron/Playwright drivers 不属于浏览器构建闭包。

`build.mjs` 绑定浏览器 driver，内联可信 `?raw` helpers，校验 metafile 的上游输入均在锁中。唯一 Node 适配是上游纯 PNG 生成所需的 `node:zlib` 两个函数：`deflateSync` 使用 fflate，`crc32` 使用 crc-32；Buffer 由 bundle 内模块注入，不修改宿主 window。生成 PNG 已通过独立 Node inflate/CRC 校验。

依赖由包内 `package-lock.json` 固定；运行时直接依赖为 docx 9.7.1、DOMPurify 3.4.11、html-to-image 1.11.13、buffer 6.0.3、fflate 0.8.2、crc-32 1.2.2。build 输出：

- `dist/index.mjs`，ES2022 浏览器 ESM。
- `dist/index.d.mts`，从 `types.ts` 复制，支持宿主路径动态 import 的类型检查。
- `dist/source-lock.json` 和 `dist/index.meta.json`，锁定来源与实际构建闭包。
- `dist/THIRD-PARTY-NOTICES.txt`，包含上游 Apache-2.0 LICENSE/NOTICE 和构建实际使用的 npm runtime 包完整 LICENSE。缺失许可会使构建失败。

## API 与结果语义

```ts
interface ConvertAltChunkOptions { signal?: AbortSignal }
function convertAltChunkHtml(
  html: string,
  options?: ConvertAltChunkOptions,
): Promise<Uint8Array | null>;
```

仅输入 UTF-8 HTML 与 AbortSignal，不接受路径、远端 URL、session、原生 API 或凭据。输出沿用上游 DOCX 生成。清洗后无文字、结构或视觉内容时才返回 `null`；有效内容转换失败会抛错。上游会捕获部分截图失败并继续生成，driver 额外保留实际错误，公共边界重新抛出，避免成功返回缺图文档。上游隐藏坏图前，driver 已严格验证图片元数据与解码。

每个调用独立建 iframe，`finally` 销毁；AbortSignal 在开始前、进行中均拒绝 `AbortError`，取消立即移除 iframe 并取消可信 helper 计时器。并发调用不共享页面状态。

## 浏览器信任边界

离屏 iframe 为同源 `about:srcdoc`，仅 `sandbox="allow-same-origin"`，不授予 `allow-scripts`、form、popup 或 top navigation。其初始文档由固定字符串建立 CSP：

```text
default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline';
img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none';
media-src 'none'; worker-src 'none'
```

输入在该 iframe realm 中使用 DOMPurify 解析和清洗，再移入同一个 iframe；不在特权主文档解析、插入或执行任意输入。`evaluate/addScript` 仅供 bundle 内锁定 converter 与可信 helpers 调用，序列化的函数体不包含用户 HTML；参数单独传递。浏览器禁止页面脚本和事件执行，但允许父页面调用该 realm 的 Function 执行可信 helpers。该行为已在真实 Chrome 中验证。

由于无脚本 sandbox 禁止子页面安排回调，driver 仅桥接可信 helper 的函数计时器至父页面时钟，拒绝字符串计时器，并跟随调用生命周期清理。HTML 不能获得这个能力。

清洗移除 script、嵌套文档、对象、外部 stylesheet、base、音视频、事件、刷新导航、资源 srcset、form 提交目标等。HTML profile 不接收 SVG/MathML；SVG data 图片也不在允许集合内。metadata 只保留标题及 author/description/keywords，保留 HTML 根节点语言和样式。输入不能替换 CSP。

`http://`、`https://`、`mailto:`、`#fragment` 合法锚点保留并生成真正 `w:hyperlink`/书签，DOMPurify 改名后的 fragment 同步调整。JavaScript、协议相对和不合法 href 被清除。iframe 捕获 click、auxclick、submit 并 preventDefault。WebKit 的无脚本 sandbox 也会抑制父页面安装的 DOM 事件监听器，所以所有保留链接额外固定 `target="_blank"`、`rel="noopener noreferrer"` 并移除 download；sandbox 未授予 popup，原生链接激活因此不能导航或发请求，同时真实 href 仍供上游提取。包含原始 `target="_self"` 的点击用例已在两浏览器验证；文档内关系的最终导航策略由 Word 宿主负责。

## 资源与预算

- HTML UTF-8 输入和最终 DOCX 均限制 64 MiB，超限明确报错。
- 图片只允许规范 base64 的 PNG/JPEG/GIF/WebP data URL；拒绝外部/相对 URL、空值、不规范 base64、损坏图片及 SVG data URL。单项编码数据、全部唯一图片解码 RGBA 总量均不超过 64 MiB。
- 严格校验后的栅格 data URL 在宿主 realm 的 Image 中检查元数据/解码，不插入 DOM、不接收 HTML。WebKit 会抑制无脚本 iframe 中的图片事件回调，使用子 realm Image 会使 load 等待不结束；该实际失败已通过这一隔离解码修复。输入 HTML 的解析和渲染继续只发生在受限 iframe。
- CSS 中 `url()` 复用相同 data 图片校验，支持真实背景图；真实截图已验证红色背景像素。外部 CSS 资源、`@import`、image-set、转义声明及未支持的 at-rule 明确报错，避免静默丢图。支持常规 style、media、supports、page 规则。
- 每次截图和显示图片使用 2 倍像素比；宽高各至多 16384、RGBA 像素至多 64 MiB；截图编码字节总量至多 64 MiB。画布、图片加载/解码、PNG 编码失败都会抛错。
- html-to-image 只读取清洗后的 iframe 内容，禁止字体嵌入和外部资源。页面 clip 保留原页面布局及 foreignObject 尺寸，在固定尺寸的 HTML wrapper 上使用 CSS left/top 平移，再按输出 SVG 尺寸裁剪。WebKit 不按 SVG viewBox/x/y 平移 foreignObject 内的 HTML，原实现虽输出正确尺寸却截断徽标；修复后的完整徽标/卡片真实像素已在两浏览器验证，不按裁剪宽度重新排版页面。

这保证真实支持上述资源集合；需要网络字体、外部图片、SVG/MathML 等内容不属于当前安全输入能力。原生平台和字体差异仍会影响浏览器排版，不宣称与 Electron 像素一致。

## TDD 与定向验证（2026-10-18）

公开验收接缝为 `convertAltChunkHtml`、其真实 DOCX/OOXML 及浏览器隔离/取消行为。初始实现对真实中文转换抛出 Not implemented（RED），接入完整上游闭包后通过。后续用例实际复现并修复显示图片像素预算漏检、HTML title 被 profile 丢失、页面截图缩窄 foreignObject 导致徽标被裁掉。没有以吞错或空 DOCX 放宽断言。

本机环境：macOS，固定 Node **v24.21.0**（`src-tauri/resources/agent-host/node`），真实 Chrome **155.0.8059.80** 和已有 Playwright WebKit **26.5**（缓存 `webkit-2336`），均为 headless。Chrome 使用包内 Playwright core **1.61.1**；WebKit 复用与 Word 相同的现有 runtime runner。没有安装新浏览器。测试启动临时 localhost harness，无可见窗口，完成后关闭浏览器与 server。未运行 Windows；Playwright WebKit 通过不等于已验证 Tauri WKWebView 完整应用。

在 `packages/office-html2docx` 执行：

```sh
../../src-tauri/resources/agent-host/node build.mjs
../../src-tauri/resources/agent-host/node node_modules/typescript/bin/tsc --noEmit
../../src-tauri/resources/agent-host/node --test test/*.test.mjs
```

初轮 Chrome **12/12** 通过，约 8.1 秒。补 WebKit 后真实复现并修复上述图片回调、原生链接激活和 foreignObject 裁剪差异。

WebKit 与 Word 使用同一已有运行器，实际命令（包目录）：

```sh
OFFICE_BROWSER=webkit \
OFFICE_PLAYWRIGHT_MODULE=/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
OFFICE_WEBKIT_EXECUTABLE=/Users/xuchen/Library/Caches/ms-playwright/webkit-2336/pw_run.sh \
../../src-tauri/resources/agent-host/node --test test/browser.test.mjs
```

最终结果：WebKit **11/11 浏览器项通过**，约 8.4 秒；bundle/source/notice/declaration **1/1 通过**。build 和 TS 通过。Chrome 仅回归受改动影响的 7 项，**7/7 通过**；无改动的脚本/取消/输入预算/纯色背景结果复用前轮。Chrome 定向命令为 `node --test --test-name-pattern='Chinese bold|only empty|CSS data|PNG encoder|page-coordinate|safe external links|preserved hyperlink' test/browser.test.mjs`，Node 前缀同上。无 root 全量构建/测试、Cargo、git 操作或可见应用启动。

验收覆盖：

1. 中文、strong、列表编号、表格及 data 图片转换，读回 OOXML 并解码 PNG 验证实际红色像素。
2. 恶意 script/event/meta refresh/base/link/iframe/object/SVG/form 不执行、不导航、不请求外网。
3. 进行中和预取消均 AbortError，iframe 清零。
4. 仅空内容返回 null；外部/坏图/超大显示图片抛错且清理。
5. HTTP/mailto/internal anchor 保留真实 OOXML 关系，JavaScript 链接不保留。
6. CSS data 背景产生真实像素；不支持的 CSS 资源明确错误。
7. PNG 编码器真实失败时抛错，不返回缺图文档。
8. 页面 clip 保留完整悬出徽标、卡片颜色与原尺寸。
9. UTF-8 输入超预算在 iframe 创建前拒绝。
10. 点击保留链接不能导航转换 iframe。
11. HTML 根节点纯色背景生成合法 PNG，CRC/deflate 与中文标题均读回通过。
12. 31 个上游文件哈希、实际 source closure、无 Node/Electron/Playwright 运行时导入、完整许可和声明输出。

可复查产物（忽略的本地文件）：`packages/office-html2docx/test/output/{chromium,webkit}/` 内的 `converted.docx`、`overhang.png`、`browser-environment.json`。测试按 `OFFICE_BROWSER` 参数化；默认 Chromium，可通过 `OFFICE_PLAYWRIGHT_MODULE`/`OFFICE_WEBKIT_EXECUTABLE` 复用已有 runner。宿主 OfficeFileContent 已由主整合接动态 import；Word 使用真实 helper 的完整 altChunk 导入、root build 和最终原生产品验收由主/Word agent 集中执行，本文的 helper OOXML 验收不能替代这些集成结果。**本包可交主运行 build:office；须使用本轮 WebKit 修复后重新生成的 bundle。**

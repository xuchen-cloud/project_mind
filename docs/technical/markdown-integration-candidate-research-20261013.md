# Markdown 集成候选调研与独立验证（2026-10-13）

## 1. 工作包与结论

关联 Issue：#118。依赖既有 Project File、DSH 预览、原始源码读取与 FileContentService。仅写本报告和 `packages/markdown-validation`；主程序接入、GUI 验收、全量构建、其他格式重测及 review 均不在本包交付范围。

**建议：Markdown 直接复用现有 DSH GFM 安全预览，补源码编辑与统一 File/CAS 保存。需要行号、搜索、快捷键时直接增加 CodeMirror 6；本轮不引入 GenOffice Markdown 应用。** 现有解析和资源路径已经接入 Project File，缺口主要是人工可编辑源码和提交入口。GenOffice 对 `.md` 的主编辑模型是 Tiptap，源码侧栏也会重新解析成富文本；它的块级原文复用有价值，但不是任意源码编辑的字节保留保证。

这项判断基于两类证据：固定 SHA 的源码调用链，以及本包实际执行的 31 项断言。后者覆盖现有 parser/React SSR 预览、六种源字节样本的局部修改保存，以及 GenOffice 纯源码 helper；**未执行 GenOffice 完整 Markdown 编辑器、Electron 保存、CodeMirror DOM 或主程序 File/CAS 保存**。[机器结果](../../packages/markdown-validation/results.json)、[复跑说明](../../packages/markdown-validation/README.md)。

个人自用不以许可审核作为本包阻断。GenOffice 公开 core 为 Apache-2.0，本包保留 LICENSE/NOTICE，未使用 ee 或修改许可检查。选择取决于编辑模型与接入成本。[固定提交 LICENSE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/LICENSE)

## 2. 现有 Project Mind 能力：源码静态核验

### 2.1 预览、源码与定位

[ProjectFileContent.tsx](../../src/components/document/ProjectFileContent.tsx) 已将 `.md/.markdown` 交给 `DshFilePreview`。工具栏的“源码 / 行定位”切换到 text preview，并非可编辑组件，也没有人工 Markdown 保存动作。Markdown 渲染块的定位不等于源文件行号；当前界面明确提示行定位切换源码视图。

[file-source.ts](../../src/lib/file-source.ts) 与 [file_source_read.rs](../../src-tauri/src/file_source_read.rs) 按明确 File 版本/hash 分页取得完整 UTF-8 原文，不进行 Markdown 转换、清洗或换行归一化。它可以成为编辑器加载依据。用于索引的抽取文本、Record 富文本投影均不应成为 `.md` 保存依据。当前链路只覆盖有效 UTF-8；其他编码文件不能据此承诺无损编辑。

DSH [parse.ts](../../packages/dsh-ui/upstream/client/ui-primitives/src/markdown/parse.ts) 使用 `mdast-util-from-markdown` + micromark GFM / mdast GFM，带现有中文强调兼容扩展；完成态还加数学解析。`MarkdownText` / `render.tsx` 将 AST 映射为 React 元素，代码高亮走已有 Shiki。原始 HTML 节点按文本呈现，没有把 Markdown 直接塞入可执行 HTML。官方 parser 与 GFM 扩展分别提供 CommonMark AST 和表格、任务列表等语法，前台组件仍负责渲染和安全策略。[from-markdown 官方源码](https://github.com/syntax-tree/mdast-util-from-markdown)、[GFM 扩展官方源码](https://github.com/syntax-tree/mdast-util-gfm)

DSH text preview 已有一基行号节点和滚动定位。它是只读定位能力；之后源码编辑器还需光标/选区、版本绑定和编辑后的行号计算，不能把现有只读定位算作编辑功能已交付。

### 2.2 图片资源：已有实际归属边界

[resources.mjs](../../packages/dsh-ui/preview/resources.mjs) 从 Markdown AST 收集 inline/reference 图片，并以独立副本改写为已解析资源的 data URL；未解析图片显示 alt。不替换代码围栏中的伪图片，也不改写待保存源文件。

ProjectFileContent 在原文件 Workspace/Project 归属下调用 `projectFileApi.resolveRelated`；资源须为登记且 ready 的 File，按版本/hash 读取。已有 64 项、单项 4 MiB、总计 32 MiB 的预览限制。作者写入的 `data:image` 可传入，外部图片由 Project File adapter 报警并移除图片节点，显示 alt。底层通用 Markdown renderer 本身允许 http(s) 图片，**这个不主动取外网的结论只适用于经过 Project File 资源准备的调用链**。

历史版本缺少关联资源快照时现有代码显示警告，不能用当前附件静默替代历史图片。路径编码、相对路径、归属和真实字节由现有资源接口处理；源码保存保留作者写法，不能把预览 data URL 写回源文。本包只实测 PNG 映射，不证明所有 MIME/SVG、符号链接、网络请求和原生鉴权场景。

发现一项实际差异：资源 helper 对重复 reference definition 取最后一项，而 CommonMark/现有渲染引用收集取第一项。因此重复定义可能预览到不同图片。该差异已进入机器诊断，主源码未修改。接入前应让资源准备与预览遵循同一引用定义语义。GFM 规范规定重复标签优先首定义。[GFM 官方规范：引用定义](https://github.github.com/gfm/#link-reference-definitions)

### 2.3 已安装编辑器与依赖

本次读取实际 `node_modules` 版本而非仅看 semver 声明，详见 [provenance.json](../../packages/markdown-validation/provenance.json)。

| 现有组件/依赖 | 实际用途与复用判断 |
| --- | --- |
| React / react-dom 19.2.4 | 当前预览及本包 SSR 已实际调用 |
| mdast-util-from-markdown 2.0.3、mdast-util-gfm 3.1.0、micromark-extension-gfm 3.0.0 | 当前 GFM 预览可直接复用 |
| Shiki 4.3.1、KaTeX 0.16.47 | 当前代码/数学呈现；本包没有视觉验收 |
| Tiptap React 3.21.0，其他扩展声明含 3.22.1 | [RichEditor](../../src/components/rich-editor/RichEditor.tsx) 操作 Record JSON/HTML 等投影；不能把富文本序列化当作源 `.md` 的字符保留 |
| Lexical 0.49.0 + plain-text/history | DSH 会话输入编辑器的 runtime/keymap；复用其内容投影会带入会话引用等业务语义，未验证为文件源码编辑器 |
| DOMPurify 3.4.11 | 已安装不等于所有预览都调用；本次 Markdown 的安全依据为 AST→React 与链接策略 |
| CodeMirror state/view/lang-markdown | 当前未安装；需要新增依赖，没有宣称已接入 |

## 3. GenOffice 固定 SHA：真实栈与保存/导出路径

固定提交：`d32d1711f1bf985430757b8c6b3fbddd3831d946`。本包获取 84 个公开文件，按上游 Git tree blob SHA1 核对；缓存可由 fetch-source 重建，锁定清单在 [source-lock.json](../../packages/markdown-validation/source-lock.json)。源码事实均指该提交，不将后续 README 宣传或最新依赖版本当成此 SHA 的能力。

### 3.1 `.md` 富文本与源码侧栏是同一 Tiptap 模型

`@genoffice/markdown` 是 private Electron 应用包，包声明包含 React 19.2.4、Tiptap 3.31.0、Electron `^43.7.6`、electron-vite `^5.0.0`；不是像 PPT engine 一样可直接接入的独立 Markdown 编辑 SDK。其包还依赖宿主、agent、project-store、UI、DOCX 等模块。这里是 manifest 依据，未安装整个应用核对其 resolved 版本。[固定提交包声明](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/package.json)

实际 `.md` 调用链：

```text
原文 → parseDocText（BOM/EOL/frontmatter envelope）
     → stripLegacyFencedDivs → Tiptap setContent(markdown)
     → buildSourceMap
编辑 → bodyMarkdown：source map 可用则 spliceMarkdown，否则 getMarkdown()
保存 → serializeMarkdown → serializeDocText → markdownApi.save
     → Electron main 校验/资源迁移 → writeTextAtomic
```

`SourcePane` 是 textarea。修改后 `applySourceText` 再解析到 Tiptap，并重建 source map；它不是持有原始 `.md` 字符串直接保存的平行编辑器。[App.tsx](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/App.tsx)、[SourcePane.tsx](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/components/SourcePane.tsx)、[sourceView.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/markdown/sourceView.ts)

`sourceSplice` 在块级匹配成功时复用未改块原文、块间 glue 和部分作者风格；无法建立 token/source 对应时返回 null，App 回退全篇 serializer。改动块也需要重新序列化。源码自身记录了普通序列化对列表标记、强调、转义和不支持构造的重写风险。该设计适合减少富文本改动影响，不能推出原文所有字符均不变。[sourceSplice.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/markdown/sourceSplice.ts)

另有 experimental no-op snapshot：需 `mdapp.experimentalRoundTrip === '1'`，默认关闭；doc/envelope 均相同才返回原始 source。编辑后仍走常规序列化。它与 source-map 的块复用是不同机制。frontmatter 被单独保留；legacy callout/toggle fenced div 会迁移/删除 wrapper，是主动格式转换。[roundtripSerializer.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/markdown/roundtripSerializer.ts)、[docText.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/markdown/docText.ts)

Tiptap 官方使用文档也将输入解析和 `getMarkdown()` 导出作为文档模型转换接口；其存在不等于作者源码逐字符保留。[Tiptap Markdown 官方接口](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage)

### 3.2 plain/JSON 才使用 CodeMirror 源码模式

`PlainTextEditor.tsx` 使用 CodeMirror 6 的 state/view/commands/search 等，加载 plain 或 JSON；manifest 含 `lang-json`，未含 `lang-markdown`。此路径通过 `readSourceText/writeSourceText` 记录 BOM、一个全局 EOL 和结尾换行，再调用 `markdownApi.save`。不能因应用装了 CodeMirror 就认为 `.md` 编辑经过 CodeMirror 原文保存。[PlainTextEditor.tsx](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/source/PlainTextEditor.tsx)、[source-text.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/shared/source-text.ts)

### 3.3 图片、主进程和输出格式

LocalImage 保留作者相对 src，DOM 加载由 `md-asset://` 和文档目录解析；粘贴/另存可复制或重写附件路径。带尺寸图片会输出 HTML `<img>`，因为普通 Markdown 图片语法不表达宽高。采纳此富文本能力将改变现有“原始 HTML 只按字面展示”的预览语义。[localImage.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/renderer/editor/localImage.ts)

Electron main 维护窗口允许读写的路径，保存时可迁移图片资源并 atomic write；其 IPC/path 权限不是 Project Mind FileID/CAS。PDF 使用打印/导出链，PNG/JPEG 使用图像导出链；DOCX 由编辑器 JSON 转 DOCX engine 构建并保存。这些是衍生输出，不证明原始 `.md` 往返。CLI Markdown→DOCX 同样使用 app 的扩展/转换器，并有本地图片政策和未渲染图示的回退。本包未执行这些导出。[markdown-main.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/markdown/src/main/markdown-main.ts)、[CLI Markdown 转换模块](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/markdown.ts)

## 4. 具体选择比较

| 路径 | 源码权威/保存 | 预览与编辑能力 | 接入判断 |
| --- | --- | --- | --- |
| 现有 DSH 预览 + textarea | 可由独立原文缓冲保存；DOM 换行仍需策略 | 已有 GFM/资源/源码定位；textarea 无内置行号/高亮 | 最小人工编辑可起步，保存入口和字符测试仍需实现 |
| 现有 DSH 预览 + 直接 CM6 | 保留源文本为权威，transaction 可追踪改动；不能只凭 toString 承诺字节一致 | 添加 state/view、commands、lang-markdown；按需求启用 history/search/行号/高亮 | 需要经常源码编辑时优先；不用抽取 GenOffice 外壳 |
| 当前 Record Tiptap / DSH 会话 Lexical | 文档/会话节点投影不是原文件源字节 | 已有富文本/输入体验，业务语义各异 | 不直接作为 `.md` 保存模型 |
| GenOffice Markdown app | Tiptap + 部分 source splice + envelope | 富文本、源码侧栏、数学/图示和衍生导出 | 当前最小目标收益不足；需更换宿主/资源/CAS，原字符保证仍须另做 |

CodeMirror 6 是模块化源码编辑器，Markdown 语言支持与预览、存储分开提供；不会替代现有 GFM preview 或 File 服务。其 Text 模型和 `lineSeparator` 是行文本/全局分隔符机制，不能直接表示作者每一处不同 EOL；默认字符串化也不能作为混合换行字节保留的证明。实现时保留原字节和每处行分隔信息，通过 transaction/delta 映射修改；新增行遵循显式约定，未改字节直接沿用。官方站参考页本次抓取返回 403，接口细节同时核对维护者源码；GitHub 仓库页面已标为归档镜像，不把它说成当前开发主站。[官方文档入口](https://codemirror.net/docs/guide/)、[官方 state 源码镜像](https://github.com/codemirror/state/blob/main/src/state.ts)、[Markdown 语言包源码镜像](https://github.com/codemirror/lang-markdown)

本次没有安装或运行 CodeMirror，因此这是基于接口和调用路径的方案判断。CodeMirror 和 textarea 的中文 IME、撤销/重做、光标、粘贴、切换预览等仍需实际 WebView 用例。

## 5. 原字符与安全边界：实现时应明确的行为

| 项目 | 建议的行为与真实边界 |
| --- | --- |
| 原字节/no-op | 保存权威为完整 UTF-8 源缓冲；无变化返回原字节，避免新增无意义版本。只改指定片段，禁止 AST→Markdown 重印全文 |
| 换行/BOM/空格 | 保留 BOM、CRLF/LF/CR及混合换行、末尾换行、tab、尾随双空格。不能以全局 EOL 格式自动覆盖未改处；没有相应编辑映射前不宣称任意编辑字节保持 |
| GFM 表格/列表/任务 | 预览可复用现有 AST；源码保存保留对齐冒号、转义竖线、列表编号/缩进、checkbox 拼写。点击预览任务状态若将来增加，必须定位源范围修改 |
| 代码块/中文 | 保留 fence 长度和 info、内部反引号/空白；中文/emoji 不归一化。parser position/editor 为 UTF-16，原生分页字符数为 Unicode scalar，hash/chunk 为 UTF-8 byte，三者需显式映射 |
| 相对图片/引用 | 源码保留作者 URL/title/reference 写法；仅预览副本换 data URL。统一首定义语义；历史资源无快照时展示限制。普通引用链接导航不等于图片资源已授权 |
| 原始 HTML | 默认按字面呈现。脚本/iframe/event属性不转成活动节点，源缓冲保留原文。如果新增 HTML 预览模式，必须另走现有安全 HTML 能力与测试，不能直接 raw HTML 注入 |
| URL/外网 | 沿用现有链接 allowlist 和 Project File 图片资源路径；http(s) 链接仍可呈现，是否打开由 host 决定。本次未发起外网请求测试 |
| 扩展语法 | frontmatter 在现有 GFM preview 不自动成为元数据面板；脚注跳转、安全 SVG、Mermaid/自定义 fenced div 的完整呈现未验收。原字符保留与语义支持分别描述 |

source helper 中出现“byte for byte”注释不能取代边界测试。输入清洗只用于预览副本，不能写回文件；历史版本只读，恢复走已有版本恢复服务。

## 6. 独立实际执行结果

命令：本包内获取固定源码、安装本包 esbuild、`npm run build`、`npm run probe`。Node `v26.8.1`；esbuild `0.27.7`。bundle 引入真实现有代码，CSS/font 仅在无头 probe 置空。执行记录包括 38 个实际源文件 SHA256；没有 UI/视觉验收。[provenance](../../packages/markdown-validation/provenance.json)

### 6.1 通过的 31 项断言

- 六种样本（LF、CRLF、BOM+CRLF、无尾换行、混合换行、classic CR）各三项：no-op 字节相等、只替换“项目进展正常→项目进展更新”、原件 SHA256 未变，共 18 项。采用 Buffer 字节片段拼接，真实保存/重读，未调用 DOM 编辑器。
- 真实 parser 核对 GFM 表格和转义竖线、checked/unchecked 任务、围栏内伪图片、blockquote、有序列表起始值。
- 真实资源 helper 核对路径解码、reference 图片、仅改预览副本。
- 真实 `MarkdownText` SSR + jsdom 核对表格、disabled checkbox、两张 PNG data URL、中文/引用链接；原始 script/iframe/img-event 文本没有活动节点，也没有 JS href/event 属性。

完整输出与样本见 [results.json](../../packages/markdown-validation/results.json)、[evidence](../../packages/markdown-validation/evidence/lf.original.md)、[SSR HTML](../../packages/markdown-validation/evidence/preview.html)。31 项通过描述的是以上范围，GenOffice helper 的差异另列诊断，未包装成 GenOffice 全栈通过。

### 6.2 GenOffice 纯 helper 实测与未解问题

下表是同一真实源码样本直接调用 helper 再比较完整字符串；未经过完整 Tiptap/Electron 链。

| 样本 | readSourceText→writeSourceText | parseDocText→serializeDocText |
| --- | --- | --- |
| LF | 相等 | 相等 |
| CRLF | 相等 | 相等 |
| BOM+CRLF | 相等 | 相等 |
| 无尾换行 | 相等 | 相等 |
| 混合 EOL | **不相等** | **不相等** |
| classic CR | **不相等** | 相等（仅此 helper 对，不能外推完整编辑器） |

`readSourceText` 将所有 `\r\n?` 归一成 LF，再选单一 LF/CRLF 写出，故混合和 classic CR 损失。`docText` 的 envelope 也只有一个 EOL 字段，混合样本不相等。无变化 snapshot 可以走另一分支，但不能据此覆盖实际编辑后的风险。

资源 helper 重复引用诊断：输入首定义 `images/first.png`、后定义 `images/second.png`，实际资源收集得到后者；与规范首定义不一致。该项在 `limitations.duplicateReferenceImages.matchesFirstDefinition=false` 保留，未改主源码。

未执行的范围：完整 GenOffice Markdown open/edit/save、CodeMirror/textarea DOM、中文 IME/undo、主程序人工保存命令、原生 File/CAS冲突、实际附件路径/权限/MIME读取、PDF/PNG/DOCX 导出。当前没有声称这些能力已完成或受阻于许可。

## 7. 主程序接入最小范围：统一 FileID/CAS，DSH 同能力

以下为后续实现建议，不是本包已有交付。

1. 从现有 `fileDocumentApi.sourceRead` 获取明确 FileID/version/hash 的原文；草稿绑定同一基线，预览只读派生。Record 与 File 身份/内容模型继续分开。
2. 主窗口与 DSH 共用一个源码编辑 adapter 和同一保存服务。adapter 输入包含 object、baseline version/hash、raw source、资源 resolver、定位；输出为 source delta/候选 bytes，不能各自建立磁盘路径保存或第二份文件。
3. 增加人工保存薄入口，复用已有 FileContentService 的校验/落盘/CAS；前端现有 fileDocumentApi 没有直接人工 Markdown save，不能直接宣称现成 invoke 可用。已有 agent `file.content.begin/chunk/complete` 只是上传暂存，`output.stage file_update` 才进入既有输出提交流程。人工入口应复用底层服务，不必引入 agent 输出业务流程。[file tools](../../src-tauri/src/agent/file_tools.rs)、[FileContentService](../../src-tauri/src/file_content.rs)、[fileDocumentApi](../../src/services/fileDocumentApi.ts)
4. 提交携带 expected version/hash。CAS 冲突保留本地草稿，提示重新载入/对比，不能覆盖新版本；成功产生同一 File 的新版本，刷新预览/定位。历史版本保持只读，恢复沿用已有 restore。
5. 接入验收集中覆盖加载与 no-op、中文编辑、换行/空白/引用/图片字符不变、未改 bytes 不变、冲突保草稿、历史定位、DSH 同接口、IME/undo；只补真实受影响范围。先修重复引用解析差异，再把该用例变成回归断言。

图片上传/插入、所见即所得工具栏、数学/图示新增支持和复杂导出不属于“最小源码编辑+预览”的必需接入范围。它们需要独立定义源文本变更和资源 File 生命周期。

## 8. 其他格式是否统一使用 GenOffice

**按格式选择，不统一替换。** Markdown 已有可复用的安全阅读、资源和源码能力，GenOffice 应用反而增加宿主替换和转换风险。PPTX 可保留 GenOffice 作为此前验证范围内的备选：simple core 编辑保存及 thin SVG adapter 的实际无水印证据有效，但不是完整 GenOffice app 或复杂 chart UI 已通过；复杂格式保留独立限制和 SDK 原始诊断。[PPTX 已归档证据](../../packages/genoffice-pptx-validation/README.md)

DOCX/XLSX/PDF 继续依据各自公开引擎、现有能力和对应验证选择，不从 Markdown 或 simple PPT 成功外推全格式。此文未重测它们，也未改变[既有 Office 候选报告](./office-integration-candidate-research-20261013.md)；个人许可偏好不改变格式往返、资源、原生宿主和 CAS 的技术事实。

## 9. 复跑与证据边界

[validation README](../../packages/markdown-validation/README.md) 提供从固定核心文件获取到 esbuild/probe 的实跑命令；[source-lock](../../packages/markdown-validation/source-lock.json) 固定 Git blob；[GENOFFICE-LICENSE](../../packages/markdown-validation/GENOFFICE-LICENSE) / [NOTICE](../../packages/markdown-validation/GENOFFICE-NOTICE) 保留上游声明。

本包新目录内只安装 esbuild，读取项目已安装依赖，没有修改根 package/lock。上游缓存、node_modules、build 忽略，不复制整个应用。源码引用对应研究时工作树快照，参与 probe 的源码 hash 记录在 provenance；主程序并行修改后复跑须核对该范围。主源码、既有报告及 PPTX harness 均未写入；没有启动 review 或更多 agents。

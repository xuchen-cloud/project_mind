# GenOffice 编辑器完整接入工作包

关联 #191；父需求 #118。基线 `40a36d7`，分支 `codex/genoffice-editor-parity`。

## 交付

Word、PPT、Excel 分格式对照 GenOffice 上游已有编辑功能并移植，新增 Markdown 编辑。优先复用上游完整编辑器和已适配的可嵌入版本；不能把首轮“简单文字修改”的边界当成本包规格。每种格式的功能矩阵记录对应源码、实际接入、保存能力和验证结果。

## 依赖与职责

- 上游固定来源 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`，与当前格式引擎一致。独立核对现成 Web/Tauri 适配及新版本。
- 四个实现 agent 分别拥有格式 package 和对应编辑器；共享宿主、根依赖、原生 File 保存、最终整合由主 agent 负责。
- 使用现有 File ID、版本/hash CAS、操作回执、保存恢复和历史边界。格式引擎生成候选原件，不能维护第二套业务文件。
- 本次授权为实现分工；Standards / Spec 检查由主 agent 完成，不自动启动 review agent。

## 非目标

GenOffice 独立应用启动器、升级器、账户和重复 AI 会话不移植；不为交互问题迁移桌面框架。上述非目标不排除其文档编辑功能。

**2026-10-18 用户最新范围优先：PPT 演讲者视图、加密文档、图床设置与上传均不支持，已停止并撤除对应新增产品支线。三项不再作为 #191 的缺口或发布阻塞。保留本地图片、常规幻灯片放映及普通未加密文档的编辑/保存/导出。下文较早图床、密码和 presenter 开发记录仅为过程历史，以本段及末尾撤除记录为准。

## 验收与验证范围

1. 四格式上游功能矩阵逐项检查，记录真实缺口；阶段增量不能记为完整交付。
2. 真实文件的选择、中文输入、直接编辑、拖动/缩放、格式命令、剪贴板、快捷键和撤销重做按格式验证；界面功能必须实际保存并重开。
3. Markdown 源码编辑/预览保存为同一 File；保留源码、不转 Record，原始换行与 BOM 的处理有明确证据。
4. 最新版本编辑、保存/关闭 flush、失败保留草稿、异步刷新不覆盖草稿、历史只读、外部变更 CAS、连续多次保存。
5. 开发先运行格式定向检查；整合后集中执行受影响完整验证。无源码/配置变化的通过证据复用。
6. 浏览器检查先静默执行 Chromium/WebKit；实际 macOS WKWebView、Windows WebView2/打包各自记录，不用其中一项替代另一项。可见窗口验收集中执行并提前告知。

## 进度

- 已检查运行进程：没有 `tauri dev` 自动重启进程。
- 已同步 `origin/develop` 并建立实现分支；已分派四个格式实现任务及一个现成适配调查任务。
- 当前未完成完整格式交付、平台验收或发布。

## 保存链路验证（开发中）

- 新增 GUI `file_text_save`：固定版本/原件 hash、原生实际归属授权、FileContent stage/CAS、历史与幂等回执；不接受前端路径或权限声明。
- `cargo test --manifest-path src-tauri/Cargo.toml --config 'profile.test.package.project_mind_alpha.debug=0' --lib file_text --quiet`：12 passed（新增 Markdown 4 项、命令输入 1 项、既有文字补丁相关 7 项），对应 `file_text.rs` / `file_text_commands.rs` / lib 注册的当前未提交改动。
- 初次默认 debug 测试因本机链接临时空间不足失败；仅对根 package 禁用测试调试符号后通过，依赖及发布配置未修改。
- Markdown 宿主与父页生命周期仍在接入；上述 native 证据不代表界面或四格式验收完成。

## 已发现的现成适配

`Nothing1024/dsh-genoffice` 与 `Nothing1024/dsh-genoffice-engine` 提供脱离 Electron 的 Web 编辑器和 DSH iframe 接入；项目自述为 experimental。调查核实具体源码与提交后决定复用范围。其 relay 的路径读写不能替代本项目固定 File 的原生保存边界。

- `vitest run src/components/document/ProjectFileOffice.test.tsx src/lib/office-edit-session.test.ts src/components/office/OfficeFileContent.test.tsx --maxWorkers=1`：14 passed。覆盖宿主原有 Office 生命周期；实际格式组件在这些宿主用例中 mock，不视为编辑器交互证据。
- `ProjectFileMarkdown.test.tsx`：6 passed；`MarkdownFileContent.test.tsx`：4 passed（格式组件 mock，实际宿主+保存服务边界 mock）。覆盖隐藏/关闭/重开、异步重读期间新草稿、外部应用打开前保存、冲突保留、失败阻止切版本、相同请求 ID 重试、保存冻结、只读、源码 BOM/CRLF 不改写与清空、连续保存后基线推进。

- 根 Tiptap 依赖统一固定 `3.31.0`，匹配上游 Markdown。React 的两个可选 menu 包也显式固定，避免浮动到 peer 不兼容的 `3.32.0`。原笔记 `@tiptap/pm/markdown` 导入已改为直接 `prosemirror-markdown@1.13.4`，沿用升级前 lock 中相同实现版本。
- 共享依赖变动对应 `RichEditor.test.tsx` + `richTextContent.test.ts`：142 passed；之前独立的 `StableRecordBlocks` / `noteImageAssets` / `record-document` 21 passed。前者初次因旧模块路径失效不能加载，修复导入后通过；不放宽断言。
- 根 Vitest 排除独立格式包及其 vendored tests，避免把包内 Node/browser runner 错当 jsdom；格式包各自测试仍通过 `test:office:formats` 收口执行。

- Word/PPT 宿主新增 pending / beforeSave 接入。定向 TDD：新 2 项先失败（输入未进快照），接线后 `OfficeFileContent.test.tsx` 6 passed；Word 内保存请求也走相同 File 保存。
- `ProjectFileContent.test.tsx` 43 passed，旧 Markdown 源码预览 DOM 断言 1 项失败；将预期更新为新真实可编辑源码 textbox 后，该项定向重跑 passed。未修改其他 43 项的相关路径。
- 原生 `file_office`：9 passed，3 个既有 opt-in/subprocess fixture ignored。待打包全部格式后还需运行 2 项真实 utility 格式验收，不能把默认忽略算作通过。
- `tsc --noEmit` 当前通过（宿主及根依赖整合阶段）；格式 agent 后续源码/构建变动仍需最终检查。

## 已发现的既有非阻塞问题

全仓 `check:portable-paths` 的既有需求文档中有 8 项机器路径/系统路径记录；源于基线已合并工作包。本包新增文档已改为相对路径或环境变量，定向检查 0 项。保留固定上游来源时发现 Word 字体 README 含系统路径，已交格式 agent 处理源码清单，不静默修改上游。既有文档路径单独安排后续工作包；不把全仓失败写作通过。

## 2026-10-16 主宿主整合与浏览器证据

- Word / PPT 内部保存请求已返回宿主真实 `save()` Promise；定向成功/失败回执用例新增后 `OfficeFileContent.test.tsx` 10 passed。回执到达前不报告成功，失败保留草稿。
- Markdown 新插入的相对图片路径接入现有 `readRelated`：与初次读取共享 64 项 / 单项 4 MiB / 总量 32 MiB 预算及缓存，核验真实 project/File/版本、完整字节、图片 MIME 和主文件位置。编辑生命周期单独管理取消，隐藏后保留的草稿不依赖已中止的加载 signal。
- `ProjectFileMarkdown.test.tsx` 新增关联图片 3 项：正常读取及缓存、伪造归属拒绝、超预算拒绝。初次缓存用例错误地把初始正文读取也计入资源读取次数；断言改为真实关联 File 调用次数后 3 passed。其余原 6 项及 Markdown 宿主 4 项在该次整合中通过；根 `tsc --noEmit` 通过。
- `check:ui-standards` 当前通过。所有 agent 后续变动仍需收口核对。

### Markdown 真实浏览器（静默）

使用临时 Vite harness 加载真实 `MarkdownEditor` 和应用 tokens，headless Playwright CLI 操作；harness 的保存为本地字符串存储，**不是 Tauri 原生保存**。原生边界另有上文 12 项测试。

- Chromium：实际选择/中文输入、工具栏粗体、块编辑、undo/redo、查找并全部替换、图片插入和 data 图片预览、保存；只读时尝试输入内容不变。
- WebKit：源码/块编辑中文输入、粗体、undo/redo、保存与页面重开一致；BOM 与原 CRLF 保持，console/page error 0。
- 导出的源码已写为真实 `.md` 后读回逐字节比较，BOM/CRLF 和未改前缀保留。窄 600px 分屏上下排列可用；工具栏连续遮罩在左端 start/end=0/1、滚动 8px=0.125/1、右端=1/0。
- 证据位于忽略的 `output/playwright/markdown-parity/`：`source-export.txt`、`browser-edited.md`、`bytes-verification.json`、`webkit-source.json`、`chromium-rich.png`、`webkit-narrow-split.png`。这些证据不替代 native/WKWebView/Windows WebView2 验收。
- 浏览器发现并交 Markdown agent 修复：YAML 前置信息被渲染为正文（已在两个引擎确认修复）；任务列表内插图会取消当前项格式（已修复，Chromium 真实操作确认保留两个 task 项及原文，`list-image-fixed.json`）。

### 架构整合决策

Word / PPT 已使用完整固定上游 renderer 与同源隔离文档。Excel 当前 preset+journal 增量仍缺图片、图表、透视、打印等自定义 UI，不能满足本包规格；已要求改为优先复用完整 Sheets renderer + 浏览器桥，保留已实现的原格式 gateway、类型与日志成果。新增功能矩阵的“已接入”与“已验收”分别记录，尚未收口、审查或发布。

- `npm run test:desktop-runtime`：15 passed，包含 Windows node.exe / ConPTY / target staging 的既有跨平台契约；不是 Windows 实机 WebView2 或安装包运行证明。

## 共享前端集中回归（2026-10-16）

- `npm run test:unit -- --maxWorkers=2`：204 文件，1743 passed / 2 failed。失败分别为已移除 PPT 简版界面的旧 motion 特例测试，以及 App 多项目常驻切换用例 15 秒超时。
- 前者已删除废弃的 PPT 专属 layout transition 放行规则，并改为验证同一声明在原路径也必须拒绝；`scripts/check-ui-standards.test.mjs` 定向 20 passed。未放宽检查或复活旧 UI。
- 后者不改源码/断言/超时：单独运行原失败项 7.13 秒通过，继续运行 App 全文件以排除套件累积影响；其他 1743 项的通过证据复用。
- 主审查新增 Markdown 宿主的卸载异步边界：保存已发出后组件卸载，晚到回执不得再发布给旧父页。卸载使 identity 失效，新增用例后 `MarkdownFileContent.test.tsx` 5 passed。

### App 超时的诊断与修复

完整 App 文件两次重现超时，停止格式 agent 的构建和浏览器服务后仍失败。CPU profile 指向 jsdom 的 selector 在每个被查询的 `DOMParser` 文档上注册九个相同用途的 Window 交互监听器；后续注册的线性扫描不断增长。独立解析/查询 50 个文档实际注册 450 个，新的回归先红。仅升级 jsdom 不足以修复：30.1.3 的惰性 selector 仍在查询时重复注册。

开发依赖固定 jsdom 30.1.3 / dom-selector 10.0.3。`scripts/patch-test-dom.mjs` 对固定 SHA-256 原文做最小修复：每个 Window 共享交互状态监听器，文档查询缓存仍独立；安装与 `test:unit` 自动应用，版本或原文变化会失败，生产不带 jsdom 时跳过。原始实现见 [dom-selector 的 EventHandler](https://github.com/asamuzaK/domSelector/blob/v10.0.3/src/js/event.js)。不更改 App 源码、断言或超时。

修复后 `inert-documents.node.test.ts` 与整个 `App.test.tsx` 合计 49 passed，整套 23.75 秒；查询结果与真实焦点切换仍验证。由于测试环境已变化，之前 1743 项的环境证据需要在最终集中回归中重新确认，而非沿用旧环境结果。

### 原生导出整合

查阅本机 Tauri/Wry 源码确认：macOS 未配置下载 handler 时，WebView 会取消 HTML download 导航。因此四格式增加 `onExport` 宿主回调，浏览器 anchor 仅留给无宿主的独立使用；不能以 Playwright 下载通过作为 Tauri 导出已交付。

主宿主 `editorExport.ts` 复用现有原生保存对话框与原子 `desktop_write_export_file`，不新增任意路径 relay；导出写新副本，`overwrite:false` 防止绕过 File/CAS 覆盖已登记原件。用户取消返回 false，真实写入成功才返回 true，错误交回编辑器显示。单份 100 MiB 预算与 Office 原件边界一致。定向宿主/导出测试共 20 passed，含 exact bytes、Windows 路径和文件名、取消、延迟回执、写入失败与预算拒绝。

新增独立实现 agent 负责原生打印宿主：专用临时文档窗口、禁脚本/外部资源的内容沙箱、真实排版资源就绪与原生打印面板；四格式只生成自身的打印 HTML 并接回调。目前仍在实现，不以 `window.print()` 当作桌面验收。

### 共享回归收口与启动包

- 修复测试 DOM 后再次全量：207 文件 / 1754 项，1752 passed；仅两个失败为 CSSOM 30 序列化 RGB 可选空白与新打印测试误用字符串拒绝的 Error 断言。前者保留精确 RGB 值，仅规范逗号空白，FileIcon 15 passed；打印改为检查原字符串拒绝，后续 adapter 回归 34 passed。未放宽时间或隐藏真实失败。
- 四格式 `onExport` / `onPrint`、Excel `onSaveRequest` 已接主宿主；宿主/设置/导出打印定向回归 6 文件 / 75 passed。`editorPrint` 经现有 desktopApi adapter，UI 标准检查通过；不允许新业务组件直接导入 Tauri。
- 生产图检查发现默认 vendor 合并将 Markdown Mermaid/WaveDrom/CodeMirror 的独有依赖带入启动：vendor 13,224 KB。构建按真实静态依赖图剔除仅 Markdown 使用的依赖，仍共享的依赖保持原有分块；vendor 降到 8,391 KB。编辑器均保留动态加载。
- 主入口原 260,270 字节超出既有 250 KiB 门槛；设置外壳与设置路由桥改为打开时加载。首次请求显示可关闭的加载对话框，随后保留组件以继续关闭过渡；主入口实测约 253,090 字节，门槛未修改。最终格式构建稳定后仍需最终生产检查。
- 用户明确 Windows 暂无测试机，先完成跨平台实现。Windows 实机 WebView2 操作仍待外部环境，不把浏览器 Chromium 或静态 staging 用例等同实机通过。
- 已安排原生打印实现扩展专用排版文档 PDF 字节返回，解除 Word / Excel 原桌面 PDF 平台桥的缺口；当前仍在实现，未称为完成。

### 原生输出与字体接缝续接

- 四编辑器现已全部传 `onRenderPdf={renderEditorPdf}`。PDF 服务只请求隔离原生排版文档的真实 PDF bytes，目的地选择仍由统一导出服务处理；Native 命令不接受 renderer 路径。新增 PDF 等待、二进制字节、错误与命令映射后 adapter 37 passed；加上字体与宿主定向回归共 53 passed。
- Word 已接现有系统字体枚举和新增真实 face metrics 回调。原生字体模块首轮 10 passed；主按上游 `nameID 1/16` 全语言 exact family 规则发现本地化别名缺口，已交实现 agent 修复，不能以空值 fallback 当成同等实现。
- 主目视实际完整编辑器截图发现两项当前体验问题，已交各自实现 agent：Excel 顶栏 CSV/打印按钮重叠；PPT 对原件凭空显示母版空标题/副标题占位符。两者均未当作已验收。
- Excel 已提供 engine `recalculate` 真 IronCalc 接口；主安排补只读 File 固定源字节的原生重算桥，不允许传业务路径、不写新 File 版本、异步后重新核验归属和固定源。

### 当前整合增量

- Excel `onRecalculate` 已接 `officeFileApi.recalculate` 和原生命令注册。回调读取当前 session 的固定基线，正常保存推进后使用新 version/hash；计算期间关闭/换文件或保存改变基线时拒绝旧结果。`OfficeFileContent.test.tsx` 13 passed，根 `tsc --noEmit` 通过。原生重算实现和定向 Rust/worker 检查由对应实现 agent 收口，尚未以此宿主 mock 测试替代。
- 主复查最新截图：Excel 的 CSV/打印顶部文字已不重叠；PPT 已不在实际内容上显示空占位符提示。格式 agent 继续验证真实 placeholder 可编辑、历史替换及保存后状态，未提前宣称完整格式通过。
- 干净 checkout 构建需要 Markdown 的独立导出依赖；`build:office` 已同样按 lock 安装并执行其来源验证。新增公共安装逻辑后 desktop/runtime 静态验收 15 passed；最终实际生产构建尚待各格式稳定。

## 2026-10-18 恢复执行

- 上次因账号额度中断。用户明确恢复并授权原子 agent 继续，六个实现任务均从原文件/职责接续；不重置已有改动，不启动 review agent。
- 恢复时无 `tauri dev` 或遗留验收服务。临时目录证据已清理；各包保存的 HTML/截图/构建物仍在。已通过检查仅在代码、依赖、配置与环境一致时复用。
- 当前默认 Node 为 26.8.1；打包的 Node 24.21.0 仍可用。集中验收使用固定版本，平台与浏览器证据继续分开记录。

### 主宿主续接：HTML 转换、工作簿导入与截图

- Word `onConvertAltChunkHtml` 已按需导入独立锁定的 `office-html2docx` 浏览器 helper。首次打开宿主不会主动转换，实际转换错误原样交回；不经转换器写 File。build:office 安装/构建该 helper，格式收口脚本纳入其测试；已有 desktop/runtime 构建契约 15 passed。
- Excel 用户选择的工作簿 bytes 经 `desktop_inspect_imported_workbook` 调用固定 `office.inspect/xlsx`，不接受路径、File 标识或写权限。服务检查空输入/100 MiB 边界，原有 worker 继续核验严格 base64/格式；新原生用例 4 passed、服务/adapter 新 5 项先红后绿。真实格式 utility opt-in 已加相同字节检查，待最终 staging 执行，不能以 mock worker 代替。
- Excel 截图 callback 已接 `desktop_editor_capture_sources/source`；宿主加载不触发采集，仅 UI 的用户操作请求来源/所选 opaque ID。拒绝、消失源和 native 错误保留各自结果。adapter 新 2 项先红后绿；共享 OfficeFileContent 当前 17/17 passed，包含上述三条接线及既有保存/重算边界。根 `tsc --noEmit` 当前通过。
- 截图原生模块已注册，macOS 编译通过。首轮 8 项纯单元测试中 PNG 结束写入预算和缩略图比例两项失败；复现后修复 encoder Drop 吞错与强制尺寸缩放，原两项及完整 8 项均通过。没有调用 OS 截图/权限 API。Windows 直接引用正式 print/font/capture 模块的交叉 check 首次 15.61 秒通过；上述修复后增量 1.98 秒通过。这不是整应用或 Windows 实机验收。
- 消费 Word 正式 `native-print.html`（SHA256 `4418050070b2243acf1ba6eee71dfdabc4f63787ad6a2580c51e8a4cf1d305e4`）运行隐藏 WK/AppKit helper：2 页 595×842 pt、30,714 字节，PDFKit 完整提取中文正文/表格/页眉/页脚，第一页实际图面检查正确。打印专用 TrueType 字体解决此前 CJK 映射缺失；粗体段落复制重复仍在检查，未提前称作全部输出验收完成。
- Markdown 正式修复后的原生 PDF 为 27,683 字节、1 页 A4、0 image XObject；主已目视确认 Mermaid 与 WaveDrom 方波/斜线/彩色数据段完整。另发现纸面内容贴边，已交格式 agent 检查实际页边距与分页。原生证据详见各格式文档。
- 正式 Tauri 依赖启用 `webview-data-url`，让隔离打印文档的产品构建与此前验收命令一致。隐藏 WKWebView PDF 的实际页数、纸张与内容检查仍是未完成项。
- Windows 目标检查：独立临时 crate 直接通过 `#[path]` 引用正式 `editor_print.rs` / `editor_font_metrics.rs`，复用当前 lock 的 Tauri 2.10.3、Wry 0.54.4、webview2-com 0.38.2、windows 0.61.3；`cargo check --target x86_64-pc-windows-msvc` 通过。此证据仅为两个实际模块的编译，不包括整应用链接、安装包或 Windows 操作；后续相关源码改动仍需增量复核。
- 新增连续保存红例：在 beforeSave 尚未完成时两次请求会重复提交输入/重复发布回执，两个宿主均已实际复现。保存操作现覆盖整个 beforeSave + File commit，同一 session 合并请求，外部新 session 不复用旧操作。Office / Markdown 宿主 20 passed，根类型检查通过。
- 原生输出增加物理 `pageSize: {widthPt,heightPt}`，统一以 1/72 英寸计；格式生成器按真实页面设置传入，避免屏幕缩放或 macOS 默认 Letter 改变纸张。共享 adapter 保留尺寸的回归 38 passed。
- 隐藏 WKWebView 已生成真实 A4 双页、16:9 单页和按组混排 PDF；主已目视 Word/Markdown 的图片、表格和公式。但 Word 的部分中文正文在 PDF.js 提取时乱码、系统 PDFKit 提取缺失，视觉正常；该字体/ToUnicode 问题仍在定位，不能将此路径记为文本保真通过。
- 原生 agent 已定位内嵌 Noto CFF 字体 CID/GID 不同；临时调整字体 charset 后，同一 native command 的 PDFKit/PDFium 中文提取转绿。Word agent 正接正式候选，不能将诊断材料当完整产品通过。
- Excel 外部工作簿来源增加只读 bytes inspect：固定 xlsx/OfficeUtility，无路径、File 注册或写入。新增 native 4 passed、service/adapter 5 个新用例红绿（选择匹配共 6 passed），宿主接线后 OfficeFileContent 15 passed。真实 XLSX utility 验收纳入原格式 opt-in，待统一 stage。完整 picker/来源路由和合并保存由 Excel agent 收口，详见 [工作包](genoffice-workbook-import.md)。
- 新 altChunk helper 采用独立锁定的官方 html2docx/source closure；`build:office` 已增加本包安装及构建，独立测试不被根 Vitest 收集。构建脚本变化后 desktop/runtime 定向 15 passed；helper 与实际 Word 接线尚在实现。
- 主消费 Markdown 新 `preview-diagrams-print.html`（66,593 字节）生成真实 native PDF（23,021 字节，1 页 595×842 pt），系统 PDFKit 中文及图表标签可提取。但目视 PDF PNG 发现 WaveDrom 仅有标签/网格，波形线条缺失；已交格式 agent 修复，不能以 SVG 中 use/definitions 存在认定原生输出正确。Mermaid 流程图可见。实际证据在临时目录，后续以修正后的输入/输出重新记录。
- 系统/窗口截图 native bridge 已作为下一独立实现包交原生 agent，复用现有 ScreenCaptureKit / Windows API；当前仅实现与静默编译，不自动采集桌面或弹权限，真实用户操作仍需验收。

### Excel 原生输出的整合检查

- 正式 `tests/output/print-document.html`（SHA256 `7318ed85976654bbd94ce81c5f0a77f072bf8445239122ddc96c33f74eaf1763`）经隐藏 WK/AppKit helper 生成 33,464 字节、1 页 1008×612 pt 的 PDF；表格中文、样式和数值可见。
- 主目视发现右方图表被截成窄条，已交 Excel agent 核实打印范围和对象边界；不能以回调包含 chart / image HTML 作为原生图表输出验收。该检查不调用系统打印面板或截图权限。


## 2026-10-18 集中构建与原生输出复核

- 固定 Node 24.21.0 执行 `npm run build:office` 全部通过，包括 altChunk helper、Word、XLSX native sidecar 和 PPT；随后 `npm run stage:office-runtime -- darwin-arm64` 通过。格式包当时均已冻结，Markdown 图床 UI 与独立新能力仍在开发，不能把本轮构建算作后续改动的验证。
- `office_real_` 两项 opt-in 原生 utility 验收实际执行：PPT 单项通过；三格式项已通过 DOCX，运行到 XLSX 时发现保存回执 model 与重新 inspect 的 model 不同，在原断言失败。正在定位，尚未重跑或放宽比较；XLSX 导入和 IronCalc 路径已实际执行到该断言之前。
- 主复核正式 native Word PDF：2 页、595×842 pt，中文段落/表格/页眉页脚保留；此前粗体段落文本抽取重复四次的问题已修复，同一粗体句现在仅出现一次，视觉粗体仍保留。正式打印 HTML SHA-256 `0d9f6e4f49376283d6b328c045e1443229816627104d71767a4ca37a8e36bb77`，PDF SHA-256 `d91708742950fafe89c199f76c68d0319c2204894401472f0ea443990e0c72f0`。
- 主目视 Markdown 正式 native 输出：图表页完整包含 Mermaid 与 WaveDrom，长文 12 页均保持约 20 mm 页边距；1100 个独立单词、36 段、32 表格行、80 列表项在格式 agent 的 PDFKit 验证中均仅出现一次。表头重复、列表续号与逐页切分均来自矢量 DOM 排版，未将整篇转为位图。
- XLSX 默认打印区域遗漏 oneCellAnchor 实际像素范围的缺陷已修复。主重新使用正式 native helper 验证最新 HTML（SHA-256 `76fc8748f6c3be6b9d9dc32f332040a63a8ab822b4aeab3e11d163320377cc26`）：表格、完整图表与形状均显示。100% 逐列分页时图表右端 9.2 pt 会落第二页，这是范围的真实续页；显式 Fit Columns 的单页输出已由格式 agent 验证，不强制全局缩放或删除第二页。
- PPT 保存过程中光标、正反向选区、同一个文本编辑 DOM、撤销/重做保留的实际 Chromium/WebKit 回归已通过。异步旧文档、ack 早于宿主 Promise 完成以及失败回执均有定向用例。

### 同一工作包的定向修复回执

- XLSX 唯一差异为 `rendererData.file.sessionId`：每次 native open 的随机会话 ID 泄入了数据快照。修复为源 SHA-256 派生、符合原 schema 的稳定 UUIDv8；真实 sidecar 仍使用内部随机 ID。新增双 inspect / 保存后 inspect 深相等先红后绿，engine+parity 19 项通过，本包 build/typecheck 通过；未修改 native 深相等断言。
- 仅同步最新 XLSX dist、重新生成完整 distribution manifest 并再次 staging 后，使用已编译、FileOffice 代码未变的原生 lib 测试二进制定向重跑 `file_office::tests::office_real_formats_native_save_reopen_and_retained_history`：1 passed，4.54 秒。此前 PPT 独立 1 passed 复用。真实 DOCX/XLSX/PPT 固定源保存、重新 inspect、保留历史、XLSX 只读导入与 IronCalc 路径现已实际通过。后续新能力仍需自己的验收。
- Word 远程图片固定 desktopApi command 与宿主 File/版本接线新增 3 项先红后绿。首轮全文件 57 passed / 1 failed 暴露卸载后保存的 callback 仍可开始新请求，增加 mounted 生命周期守卫后宿主 19 项通过；adapter 39 项的既有通过证据复用。拒绝历史版本、旧页面晚到回执和卸载后发起请求，保存确认后使用新 baseline。该处为 IPC mock 验证，真实 native downloader 和编辑器真实粘贴尚待整合。


## 2026-10-18 用户缩减范围与支线撤除

- 用户明确排除 PPT 演讲者视图、加密文档、图床设置与上传。已中断对应实现任务；保留此前通过的格式编辑、保存/重开、caret/undo、Markdown 本地选图/粘贴及原生输出修复。
- 主宿主撤除图床 settings/upload/read API、Markdown File 上传绑定、公开图床读取、共享类型和服务、原生命令/DB 注册、Workspace 专属取消 hooks，以及仅用于图床的 hmac/multipart 依赖。普通纳管相对图片和 data 图片继续沿用原资源边界；旧图床通过记录不能作为当前产品能力。
- 各格式 agent 按独立文件范围清理 presenter、crypto、Markdown 图床代码，保留主编辑器已验证成果；针对受影响边界补验证，不重跑未变动的全量格式/原生输出证据。

- 撤除图床后共享宿主/adapter 回归：`MarkdownFileContent`、`ProjectFileMarkdown`、`ProjectFileContent`、`ProjectFileOffice`、`desktopApi` 共 103 passed；`OfficeFileContent` 与导出/打印/工作簿导入服务共 34 passed。两组命令覆盖不同文件，无重复计数。未启动应用窗口或 OS 权限 API。

- 清理后的根 TypeScript 与 UI standards 检查通过。Word 远程图片命令已注册；`cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --config 'profile.test.package.project_mind_alpha.debug=0' --lib editor_remote_image --quiet`：12 passed，覆盖真实本地受控 HTTP、重定向/地址/字节/时限、File 归属/实际哈希、取消与单 slot；无外部图片账号或窗口操作。


### 本轮集中收口与主自检

- 三个排除项的实现和产品入口均已撤除。Markdown 本地图片/资源/导出 53 项通过，末次受影响断言 3 项复验通过（属于同组，不累加）；Word Chrome/WebKit 图片各 4 组、去加密 UI/普通编辑保护保存重开各 1 组；PPT 两浏览器普通放映进出/翻页/无演讲者按钮均通过。各 agent 最终确认生产源码冻结，无遗留 server、浏览器或构建。
- 固定 Node 24.21.0 的 `npm run build` 通过，含 Markdown 93 文件与真实 DOCX 导出 bundle 核验、31 文件 altChunk helper、Word 505 固定源、XLSX sidecar 和 PPT 501 固定源/97 handlers，以及根 TypeScript / Vite。之前 native 真实三格式 File 保存/重开/历史与导入/重算的通过记录复用：本轮 engine 源码及保存边界未变。
- `npm run check:bundle-boundaries` 通过：编辑器保持 lazy，主入口 248 KiB / 250 KiB，未放宽预算。`npm run stage:office-runtime -- darwin-arm64` 通过；最新 Word/PPT renderer 与完整 manifest 已进入桌面运行资源。
- Standards 主自检：固定 vendor 未改写；适配变换与本地主机能力分开；无直接业务 UI Tauri 导入、明文图床配置、加密 worker 或 audience 能力残留；File/CAS、版本、只读、取消、资源预算与真实错误保持。定向类型/规范、native 边界和差异空白检查通过，没有本轮剩余代码发现。
- Spec 主自检：本次用户明确排除的三项已落实，普通放映、本地图片与原有编辑/保存/输出保留。#191 的其他真实缺口继续按四格式矩阵记录（如系统拼写/Zotero、超过 2m 的源端按需查询及平台实机验收）；本轮不将它们改成非目标，也不宣称整个 Issue 已完成、合并或关闭。没有启动 review 子 agent。

- 阶段暂存包含此前未追踪的固定来源和生成物后，完整 `git diff --cached --check` 报告原版 OFL/MTX 许可证、固定 exporter bundle/notices、可复建 XLSX 生成文件及有效 PDF xref 中的原始空白。保留这些精确原字节与来源校验，不为格式化破坏许可证/hash/PDF 偏移；自有两个测试文件多余 EOF 空行已修复。排除上述明确固定/生成工件的自有改动 diff check 通过。

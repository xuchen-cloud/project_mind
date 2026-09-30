# 桌面端 RichEditor 右键粘贴需求决策记录

- 状态：共同理解已确认
- 确认日期：2026-08-06
- 工作分支：`issue20`
- 基线提交：`0493ba4`
- 正式 PRD 与跟踪入口：[GitHub Issue #22](https://github.com/xuchen-cloud/project_mind/issues/22)（不是已关闭的 #20）
- 决策来源：围绕当前 11 个 unstaged 文件进行的逐项 `grilling` 访谈

## 问题陈述

Project Mind 是 Tauri 桌面应用。当前 RichEditor 的右键菜单“粘贴”若依赖 WebView 原生 Paste 命令，会触发原生权限提示；当前未提交实现改为通过桌面剪贴板桥读取 HTML、文本和图片，但右键路径与 `Ctrl/Cmd+V` 仍存在用户可观察差异。

最关键的已知缺口是：`runEditorPasteCommand` 读到任意非空 HTML 后就提前结束，而 `handlePastedHtml` 只真正处理图片或表格。普通富文本 HTML 因此可能什么都不插入，也不会回退到纯文本。此外，新增测试目前只覆盖 `HTML = null` 时的桌面纯文本右键粘贴，尚未覆盖完整的格式选择、回退、图片、Markdown、错误与插入语义。

## 事实依据

1. 当前分支为 `issue20`，HEAD 为已推送的 `0493ba4`。
2. 当前 11 个未提交文件全部为 unstaged；其中 9 个直接实现桌面剪贴板桥与 RichEditor 右键粘贴，另有 `.codex/environments/environment.toml` 和 `.gitignore`。
3. 已关闭的 GitHub #20 是 Todo lifecycle Issue，与本需求无关。
4. RichEditor 被 Workspace QuickNote、Project QuickNote、Workspace Record、Project Record 与新建 Record 共同复用。
5. 键盘粘贴现有路径支持图片文件、HTML、Markdown 和纯文本；普通 HTML 可由 Tiptap 默认粘贴路径处理。
6. `@tauri-apps/plugin-clipboard-manager` 的 `readImage()` 一次返回一张原生位图；HTML 路径可以包含多张图片。插件不提供多文件剪贴板集合读取。
7. `arboard 3.6.1` 分别实现了 macOS、Windows 和 Linux 的 HTML 剪贴板读取；Windows 使用 `HTML Format`（CF_HTML）。Tauri 剪贴板插件提供 Windows 图片读取基础。
8. 当前图片资产接口可以把无原生文件路径的剪贴板图片导入 Workspace 或 Project 的受管存储。
9. 当前 Markdown 序列化器可稳定表达标题、段落、列表、引用、粗体、斜体、删除线、链接、代码、任务列表和 GFM 表格；图片和附件使用现有文字占位约定。字体、颜色、字号、下划线和高亮没有标准 Markdown 映射。
10. 仓库发布门禁是完整本地验证、TDD、Standards / Spec 双轴 review；当前没有 CI 或外部人工 review 门禁。

## 已确认决策

### D-01 产品与编辑器范围

右键粘贴属于 Tauri 桌面应用能力，覆盖所有可编辑的 RichEditor：Workspace QuickNote、Project QuickNote、Workspace Record、Project Record 和新建 Record。只读编辑器不允许粘贴。仓库中的非 Tauri 分支仅服务开发与测试，不代表独立浏览器产品端。

### D-02 与快捷键粘贴的契约

右键“粘贴”在用户可观察行为上必须与 `Ctrl/Cmd+V` 一致，包括内容格式选择、富文本保留、Markdown、图片与表格处理、选区替换、插入位置、撤销与重做、变更通知和自动保存。底层读取机制可以不同。

唯一明确例外：Finder 等文件管理器同时复制多个图片文件形成的多文件剪贴板不在本 Issue 范围内；键盘路径已有文件集合能力，但当前桌面剪贴板接口不提供该集合。

### D-03 内容格式选择与回退

1. HTML 包含有意义的文字或结构时，粘贴完整、清理后的 HTML。
2. HTML 中的图片和表格继续使用专用导入逻辑。
3. HTML 本质上只是单张图片包装、HTML 缺失或不可用时，可使用原生位图。
4. 没有可用 HTML 时，纯文本按现有规则判断 Markdown；普通文本按纯文本插入。
5. 某一种格式读取或处理失败时继续尝试安全的后续格式，不能因读到普通 HTML 就静默结束。
6. HTML 中包含多张图片时，必须按原顺序全部处理。

### D-04 富文本与 Markdown 内容模型

粘贴内容必须进入 RichEditor 的规范内容模型，并能按照现有 Markdown 序列化规则确定性表达。保留段落、标题、列表、引用、粗体、斜体、删除线、链接、代码、任务列表和允许的表格等语义结构。

外部 HTML 中没有稳定 Markdown 对应物的字体、颜色、字号、下划线、高亮和复杂样式在粘贴时规范化掉。不为本需求新增私有 Markdown 语法，也不追求来源应用外观的像素级复制。

### D-05 图片持久化与未来导出

1. 粘贴图片必须在 RichEditor 中原生展示。
2. 图片应通过现有资产接口进入受管存储，并保留路径、MIME 类型、标题和关联对象等可用元数据。
3. 保存并重新打开内容后，图片仍必须可展示。
4. 不能把会失效的临时 `blob:` 引用当作成功结果。
5. 当前 Issue 为未来 Markdown 导出保留完整图片元数据，但不实现 Markdown 文件生成、资源目录命名、重名处理或图片复制。
6. 后续导出功能应根据受管图片元数据复制图片并生成相对 Markdown 图片链接；当前 Markdown 字段继续遵守既有图片占位约定。
7. 独立图片无法持久化时，不插入并提示失败。图文 HTML 的图片无法安全保存时，继续尝试保留可安全插入的 HTML 或纯文本，避免文字丢失，但不得留下重新打开即损坏的图片。

### D-06 选区、落点与异步一致性

1. 在当前选区内右键时，粘贴替换该选区。
2. 在选区外或没有选区时，光标定位到右键点击处并插入。
3. 粘贴目标绑定到用户点击菜单时的选区或右键位置；剪贴板读取或图片导入期间即使用户移动光标或继续编辑，也不能把内容插到新的光标处。
4. 若原目标无法在后续编辑事务中安全映射，则中止并提示失败。
5. 一次右键粘贴对应一次可撤销编辑；重做也应整体恢复。

### D-07 错误、空内容与反馈

1. 空剪贴板正常无动作，不显示错误。
2. 单一格式读取失败时继续尝试其他格式。
3. 所有可用格式均因错误而无法读取或插入时，只显示一次“粘贴失败”提示。
4. 成功粘贴不增加成功 Toast。

### D-08 剪贴板权限与隐私

桌面剪贴板只在用户明确点击右键菜单“粘贴”时读取一次。不得在菜单打开、编辑器聚焦、页面加载或后台轮询时预读。右键路径不得调用可能触发 WebView 原生 Paste 权限提示的 `document.execCommand("paste")`。

### D-09 macOS 与 Windows

功能契约同时覆盖 macOS 和 Windows，且 Windows 是主要使用端。实现和自动化测试必须考虑 Windows CF_HTML、DIB/PNG 图片、换行与路径差异，不得依赖 macOS 专用剪贴板格式或 WebView 偶然行为。

当前任务不以真实 Tauri/WebView 手工测试作为完成门禁。自动化测试与仓库完整验证通过后即可按发布流程合入；发布后由产品负责人在正式环境验证。自动化测试无法真实证明所有 OS/WebView 组合都不会弹出原生提示，这项残余风险已明确接受。

### D-10 自动化验收范围

自动化测试必须覆盖：

1. 普通富文本 HTML 的插入与 Markdown 映射。
2. HTML 不可用时的纯文本回退。
3. HTML 图片、表格和多图顺序。
4. 单张原生位图导入、受管持久化和重新打开后展示。
5. Markdown 与普通纯文本。
6. HTML、文本和图片并存时的语义优先级。
7. 选区替换、右键落点和异步目标稳定性。
8. 一次粘贴对应一次撤销与重做。
9. 逐格式读取或处理失败后的继续回退。
10. 全链路失败时的单次错误提示。
11. 空剪贴板无动作。
12. 仅在明确粘贴动作时读取剪贴板。
13. 不调用 `document.execCommand("paste")`。
14. Windows 格式差异对应的平台中立逻辑或代表性 fixture。

### D-11 未提交文件归属

`.codex/environments/environment.toml` 中将默认 Run 动作改为 `npm run dev:tauri` 的变更纳入本 Issue。仓库没有 `npm start` 脚本，且默认桌面启动方式与功能开发直接相关。

`.gitignore` 中忽略 `/product-site/` 的变更与本需求无关，排除在本 Issue 之外，后续独立处理。

## 范围外

1. 独立浏览器产品端。
2. Finder 等文件管理器的多文件剪贴板读取。
3. Markdown 文件导出、图片资源复制、导出目录布局与文件重名策略。
4. 新增私有 Markdown 语法以表达任意 HTML 样式。
5. 改变复制或剪切功能的产品行为。
6. 把 `/product-site/` 忽略规则并入本需求。
7. 将已关闭的 GitHub #20 重新用于本需求。

## 当前验证基线与缺口

已知基线：前端 58 个文件、455 个测试通过；Rust 97 个测试通过；生产构建、`cargo check`、UI standards、bundle boundaries 和 `git diff --check` 均通过。

这些结果只证明当前变更没有破坏既有验证，不证明本需求已经完成。D-10 所列场景补齐并全部通过后，才满足 Spec 验收；随后仍需按仓库发布流程完成 Standards / Spec 双轴 review。

## 已确认测试 seam

主要行为 seam 是渲染后的 RichEditor 右键菜单。测试从建立光标或选区、打开菜单并点击“粘贴”开始，在 desktop API 边界注入 HTML、文本、RGBA 图片、空内容与错误，并通过编辑器内容、RichEditorValue、Markdown、图片资产元数据、撤销历史和 Toast 断言用户可观察结果。

desktop API 只补应用自有适配器契约测试，不重复 RichEditor 行为场景，也不重新测试 `arboard` 或 Tauri 插件内部的 CF_HTML 与 DIB 解码。

## 发布结果

本记录已通过 `to-spec` 综合为新的 [GitHub Issue #22](https://github.com/xuchen-cloud/project_mind/issues/22)，并已添加 `ready-for-agent` 标签。

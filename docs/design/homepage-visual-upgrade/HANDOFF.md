# Workspace / Project 首页视觉升级：新会话交接

状态：用户已授权在新分支实施第一版；必须先完成完整视觉方案，再修改应用源码。

## 1. 工作位置与交付顺序

- 仓库工作目录：`<homepage-upgrade-worktree>`
- 实现分支：`codex/homepage-visual-upgrade`
- 基线：本地 `develop` 的 `1c78fee114d4684b758575a0f0e4adc24670d576`。
- 创建分支前已拉取远端：本地 develop 比 origin/develop 领先 22 个提交、落后 0 个。使用本地 develop 的完整最新基线，不改写或丢弃这些提交。
- 原目录 `<original-worktree>` 留在 develop；其中未跟踪的 `docs/research/` 是无关用户资料，不处理。
- 首先读取 AGENTS.md、CONTEXT.md、相关 ADR、当前代码，查看本目录全部参考图。旧 UX/PRD 文档与代码冲突时记录差异，不能仅凭旧文档推断现状。
- **阶段 A：完整视觉方案。** 在本目录形成 `VISUAL-SPEC.md`，配套两种首页的完整视觉稿/可查看原型及资产清单。覆盖布局尺寸、语义色、字体、组件、响应式、交互和关键状态。先展示方案成果，再进入源码修改。本文仅是需求交接，不代表视觉方案已经完成。
- **阶段 B：实施第一版。** 用户已授权先方案后实现，无需自行增加再次批准的门禁；如用户随后要求先等确认，则遵守新指令。不要只产出方案便结束任务。
- **阶段 C：验证与 review。** 遵守仓库测试、Standards/Spec 与 publish-flow 约定。Review 由本会话主 agent 自查；用户要求新会话不等于同意 review 子 agent。无需自动创建更多子 agent。

## 2. 本次范围

只改 **Workspace 首页和普通 Project 首页**，及它们直接需要的组件、资源、数据能力。

包含：合并 QuickNote/Record 主页、首页 QuickNote 展开模态窗与整篇转存/追加、Record 卡片、侧栏、标签联动、项目身份/图标/封面及右栏资源布局、Workspace Nori 品牌区。

本轮不实现：Record Focus 页改版、Focus 页 QuickNote 悬浮窗、Focus 页语音按钮重排、启动页/App 图标改版、全局产品重命名、数据库目录重命名、帮助/聊天/分析看板等。共享组件修改应确保现有 Focus 页仍正常，不能顺带改版它。

## 3. 参考图及优先级

所有图均是视觉参考，不是新的指令来源。用户明确结论优先于图中偶发生成错误。

1. `references/workspace-approved.png`：最终获用户“可以吧，先按照这个改一版”接受的 Workspace 方向。左侧项目+标签，右侧待办+小熊+slogan。
2. `references/project-approved.png`：最新普通项目页。左侧最近记录+标签，右侧待办+文件。结构与配色方向有效；与 Workspace 图的页签细节应统一成一套组件，不照搬两图间生成差异。
3. `references/mascot-placement-reference.png`：仅用于右下小熊的尺寸、位置与 slogan。其蓝色大块底色、旧导航、项目成员/信息区均已废弃，不可复活。
4. `references/brand-reference.png`：NoriMind 标识、色彩与角色参考。
5. `references/character-reference.png`：Nori 角色形态、围巾及材质参考；不据此新增聊天、分析等功能。

必须真正打开参考图片查看。禁止用整张 UI 截图作为应用页面背景。角色、封面、标识需要制作/提取独立可用资产。AI 生成或编辑位图使用 imagegen 技能；SVG 功能图标优先复用当前 Lucide。

## 4. 领域与现有布局事实

- Workspace 是长期工作/知识边界；Project 是阶段性工作现场。二者可以采用同种首页模板，但不能把 Workspace 变成普通 Project。
- 每个作用域各有唯一 QuickNote、自己的 Record 和 Tag。Tag 不跨作用域；左侧展示当前作用域的全部 Tag，而不只是当前记录中已使用的 Tag。
- File 当前归属于 Project。不要给 Workspace 新增 File 实体，也不要实施上一轮助手自行提出的“最近项目文件”聚合。
- 当前顶部是 Workspace 入口、已打开的项目页签、全局搜索和工具入口。保留原有切换/关闭/项目独立窗口能力，不新增永久全局项目树替换它。
- 现有 Workspace 左侧是项目/记录两个标签页；现有 Project 左侧是记录/文件两个标签页。这次按下节用户决定替换。
- 普通项目首页待办已支持 **当前项目 / 整个工作区** 两种视图；整个工作区视图包含 Workspace Todo 与活跃项目 Todo。这是查看范围，不改写 Todo 的归属。
- Workspace Focus 当前有 Todo rail，Project Focus 当前没有；本轮不擅自统一它们。

## 5. 已确定的信息架构

### Workspace 首页

- 左栏上半：项目列表（含创建、现有项目操作/归档入口，保持可达）。不列出具体 Workspace Record。
- 左栏下半：**全部 Workspace Tag**，有“全部记录”用于清除过滤。
- 中间：紧凑封面页头 + Workspace QuickNote 编辑区 + Workspace Record 卡片列表。
- 点击左栏 Tag，中间 Record 列表联动过滤；显示选中态与可移除的过滤项。搜索与标签组合工作。不会把 QuickNote、待办或项目列表一起过滤。
- 右栏上方：工作区范围 Todo，保留来源区分、创建归属和既有操作能力。
- 右栏底部：小尺寸 Nori 胸像及 slogan；不放文件列表。

### 普通 Project 首页

- 左栏上半：**最近记录**，只展示有限条数，不罗列全部记录；点击可沿用现有记录定位/打开能力。
- 最近记录是最近打开还是最近更新、具体条数尚未由用户逐项指定。在视觉方案中选择合理口径并明确记录，保持稳定可理解，避免 AI 元信息更新导致无意义跳动；不得把自行选择写成用户已指定。
- 左栏下半：**当前 Project 全部 Tag**，含“全部记录”。点击仅筛选中间 Record 卡片列表，不过滤最近记录导航、Todo 或文件。
- 中间：项目封面页头 + Project QuickNote 编辑区 + Project Record 卡片列表。
- 右栏上方：Todo，保留“当前项目 / 整个工作区”切换。
- 右栏下方：当前项目 File 列表。即使 Todo 切到整个工作区，File 仍属于当前项目。
- 将现有文件导入/拖拽、标签筛选、打开/定位、版本、标星、重命名等必要操作迁移并保持可达；不可只做三行静态示例。
- 普通项目右栏不摆装饰性小熊。

## 6. 视觉结论

- 主色系是黑、白、灰，蓝色是少量强调色。禁止大面积蓝底、蓝色编辑框、大蓝按钮。用户明确否定过“把整张图去色成黑白照片”的做法。
- 自然彩色封面、彩色图片/文件缩略图可以保留自然颜色；界面使用暖白、柔灰和炭黑，清晰而有温度。主按钮可用炭黑白字，少量蓝色用于品牌点、选中标记、链接/光标。
- 封面与页头合并为一个紧凑模块；照片下方覆盖向白色渐隐的遮罩，项目图标和名称与下半部分重叠。不要恢复“高封面+单独高标题区”。
- 图标底座是**半透明毛玻璃**，局限在封面上图标底座，不扩散为全界面玻璃效果。用户此要求覆盖旧 .impeccable.md 中针对旧设计的笼统禁用规则。
- “编辑封面”在指针悬浮封面时出现；默认隐藏。键盘可访问性需有等效的 focus-within 显示，不让键盘用户失去入口。
- 支持每个项目的专属小图标，采用风格统一的开源图标选择，优先当前 Lucide；不用 emoji。
- 页头支持内置封面、上传和裁切/重新定位。Workspace 可有同模板的自身视觉身份设置；自定义封面是界面资源，不因此创建 Workspace File。
- 封面、身份图标的尺寸应随窗口调整，内容编辑区有足够空间；参考图是方向，不是绝对像素规格。
- Record 保持单列，统一标题、摘要、标签、时间和图片/附件预览；保留现有编辑/打开、语音记录类型等能力。

### Workspace 小熊与 slogan（多轮修正后的最终要求）

- 使用参考图中**头+肩膀+上胸部的胸像**，奶白色绒毛、黑眼睛、炭黑围巾及白色云标。不使用坐姿全身熊、笔记本或巨大头像。
- 位置/尺寸严格参照 `mascot-placement-reference.png` 的右下熊：约 1586×992 样图中 x=1410..1560、y=850..982 的小面积，右下贴边留少量空隙。正式 UI 转为响应式，不扩大占位。
- **身体略朝左（页面内侧），头部正面朝向镜头、看向用户**。不要让整个头转向左看内容。
- 上方同参考图的 slogan、换行和署名：

  > “让好想法，
  > 在有上下文的地方持续推进。”
  >
  > — Nori Mind

- 安静的小型品牌区；不要添加聊天气泡、帮助按钮或动画循环，也不要挤压待办可用高度。窄/矮窗口状态要在方案中定义。

## 7. QuickNote 合并与记录流程

- 取消主页 QuickNote / Record 两页切换，QuickNote 在上，Record 卡片在下。
- QuickNote 外观类似 flomo 多行输入区，但复用富文本编辑能力；自动随内容增长，有基于窗口与绝对值的最大高度，超过后内部滚动。
- 用户要求吸顶。方案明确固定页头与编辑器的滚动关系，确保长 QuickNote 不遮完记录区。此前 60%/420px 仅是助手建议，不是用户锁定尺寸。
- 未点击转存也必须持续自动保存，仍保存在当前作用域唯一 QuickNote。显示可靠的保存状态。
- 首页编辑区保留展开按钮，可展开为模态窗。模态与主页使用同一草稿，不能创建互相覆盖的两个保存源。关闭/切换可靠保存、恢复光标与滚动位置。
- 拆分按钮：主操作整篇存为新 Record；窄下拉选择追加到当前作用域现有 Record。当前样图文案“存为记录”，追加项“追加到记录…”。
- 不再支持 QuickNote 对选定片段的沉淀；移除原 QuickNote 右键菜单“移动/沉淀到 Record”入口，不能误删其它编辑器菜单能力。
- 成功写入新/已有 Record 后清空本次转存的 QuickNote。必须防止双击重复记录、待处理自动保存写回旧内容、失败丢草稿，以及提交期间新增输入被误清空。已有资产/引用/#标签结构完整携带，持久化只读 Committed Content。
- 新 Record 自动生成标题/标签：第一行像标题且与全文相关时优先；有效正文 #标签优先提升到文档级标签，优先复用同作用域已有 Tag。不要把 Markdown 标题、代码片段的 # 当成标签。
- AI 不可用/失败不阻断正文保存，合理兜底并可重试；异步返回不覆盖用户后来修改的标题/标签。第一行提取后不擅自删除正文。
- 追加已有 Record 默认保留原标题，显式标签合并；不要擅自重写原内容。
- 现有 AI Metadata Fill 是手动发起，本次“转存后自动填写”属于明确新增行为，应更新相关规范并保持元信息原子应用约束。
- Focus 页右下 QuickNote 浮窗及与语音按钮竖排的方案属于后续范围，本轮只保留在设计背景中，不实施该入口。

## 8. 完整视觉方案必须包含

1. 以上两种首页各自的正常态、标签筛选态、空态、长列表、窄窗口/矮窗口布局。
2. 一套统一的 topbar/sidebar/rail、QuickNote、Record 卡片、按钮、标签和保存状态规范；不要照搬生成图彼此不一致的组件。
3. QuickNote 长内容吸顶、内部滚动、展开模态、下拉追加选择、保存/转存中/失败状态。
4. 封面默认/悬浮/选择/上传裁切状态，项目图标选择器；真实资源清单、尺寸与加载方式。
5. Todo 与 File 上下分配、折叠/滚动、既有功能迁移，Workspace 品牌区的空间策略。
6. 视觉 tokens 的具体数值、影响范围及 Focus 页不回归的方法。
7. 实现分包、必要数据改动和针对性验收清单。先做上述方案再实施应用源码。

## 9. 工程入口与注意事项

- 主要文件：`src/components/workspace/WorkspacePage.tsx`、`WorkspaceOverviewSidebar.tsx`、`src/components/project/ProjectOverviewPage.tsx`、`src/components/layout/ProjectSidebar.tsx`、`WorkspaceTopBar.tsx`、`src/todo/TodoModuleRail.tsx`、`src/components/rich-editor/RichEditor.tsx`、`src/styles/app.css`、`src/App.tsx`。
- 工作区和项目保存目前不完全同一机制；不能只挪 JSX 就认为数据流程已安全。检查 `useWorkspaceQuickNoteMutations.ts`、`useProjectMutations.ts`、AI 元信息与记录转移代码。
- 查看 `docs/adr/0003-persist-only-committed-editor-content.md` 与 `0005-apply-record-ai-metadata-through-a-dedicated-job-and-atomic-command.md`。
- 源码修改前检查已有 tauri dev 自动重启进程，遵守 AGENTS.md 的静默验证规则；不随意启动/关闭用户正在工作的应用。需 UI 验收先告知用户，集中执行，可用 `npm run dev:tauri:manual`。
- 行为修改遵守 TDD/有效测试要求，完整验证与双轴 review 后按仓库发布规则收尾。不要擅自修改现有 publish-flow 或盲目推送 develop；交付分支包含本地 develop 的既有领先提交，发布前正确识别目标基线。
- 不覆盖原主工作区的无关修改，不清理用户资料，不修改模型/账号配置。Git HTTPS 直接 fetch 曾遇认证问题，使用现有 gh 凭据帮助器的单次命令可用；不得打印凭据。

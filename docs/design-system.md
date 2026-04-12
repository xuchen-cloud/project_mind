# Project Mind Alpha Design System

## 1. 目的与边界

这是一套服务于当前产品实现的轻量 Design System。

它的职责是：

- 记录已经落在代码中的视觉基础与组件约束
- 统一当前 UI 语义，而不是发明新的抽象层
- 帮助后续实现保持一致性

它当前不承担以下职责：

- 不定义多主题系统
- 不定义完整 token 平台规范
- 不定义复杂响应式设计语言
- 不扩展不存在的组件家族

本文件以以下实现为准：

- [`src/styles/app.css`](../src/styles/app.css)
- [`src/ui/components`](../src/ui/components)
- [`src/components/ai`](../src/components/ai)
- [`src/components/document`](../src/components/document)
- [`src/components/layout`](../src/components/layout)
- [`src/components/rich-editor`](../src/components/rich-editor)
- [`scripts/check-ui-standards.mjs`](../scripts/check-ui-standards.mjs)

## 2. 设计方向

当前产品界面应保持以下气质：

- 稳定、克制、可信
- 信息密度适中，但不压迫
- 强调项目状态与推进结果，而不是做成通用 SaaS 仪表盘
- 优先帮助用户判断“现在该看什么、下一步做什么”

延续且已映射到当前实现的方法论包括：

- `state before detail`
- `fast capture, deliberate structure`
- `layered information`
- `calm density`
- `local confidence`

补充约束：

- 能用一行表达清楚的内容，不拆成“标签 + 值 + 说明”三层结构
- 已经只读的实体，不伪装成可编辑表单
- 不为显而易见的操作补解释性废话
- 如果一个色点加名称就能成立，就不要再额外引入卡片、字段标题或状态文案
- `记录` 是当前编辑体验基准；`结论` 是记录的轻量编辑变体；`文件材料` 是同语系的对象列表变体

### 2.1 极简表达

这套产品默认采用“先减法，再布局”的表达方式，尤其适用于设置页、列表页、轻量浮层。

具体规则：

- 先问“一个信号能不能说清楚”，再决定要不要加第二个信号
- 优先一行表达，再考虑两行，最后才考虑独立卡片或说明块
- 占位词、色点、badge、按钮文案已经能传意时，不再重复补字段标题和帮助文案
- 只读信息用文本、badge、色点呈现，不用输入框、下拉框伪装成“可编辑”
- 操作尽量贴着对象本身出现，不把“保存 / 删除 / 新增”拆进另一个说明层
- 如果一段说明不改变用户判断、不降低真实风险，就默认删掉
- 不为“看起来完整”新增实体；只为“更清楚”新增实体
- 一个有效信号，优先于三层解释
- 颜色、状态这类视觉 token 的选择，优先使用同风格的轻量浮层，并在选项中直接展示色点或预览，不使用破坏界面一致性的系统原生下拉

### 2.2 内联展开规则

内联展开内容默认采用“短驻留”交互，而不是长期悬挂在页面里；但记录列表是例外，允许始终保留一条展开结果。

具体规则：

- AI 概览、Todo 历史进展这类内联展开内容，失焦后自动隐藏
- 自动隐藏的触发包括：点击展开区外部、焦点移动到展开区外部
- `Dialog`、路由级页面、页面主区块不适用这条规则
- 记录列表在任意时刻最多保留一条展开结果，切换展开对象时直接替换
- 当前仅记录条目支持“置顶”；Todo 历史进展不支持
- 置顶的意义是调整记录排序，不影响展开态是否保留

### 2.3 Workspace First Frame

当前视觉语言已经明确转向 `workspace-first`，因此“先进入工作区，再进入项目”是正式叙事，不是一次性的 onboarding 文案。

具体规则：

- Workspace Gate 应该被做成明确的起始页，而不是一个临时弹窗
- Workspace 名称、根路径、最近使用记录属于一级上下文，应稳定出现在顶栏或入口页
- `Today`、`Ask`、全局搜索、设置都属于 Workspace 级工具，不属于单个项目
- 当用户尚未进入任何项目时，界面仍应显得“可继续工作”，而不是纯空白占位
- Workspace 相关安全动作，例如锁定 / 解锁 AI secrets，属于基础设施操作，应该收在轻量菜单中，不与业务按钮混排

## 3. Foundations

### 3.1 色彩

当前主色定义在 `:root` 中，核心 token 包括：

| Token | Value | 用途 |
| --- | --- | --- |
| `--color-bg` | `#ffffff` | 主内容背景 |
| `--color-bg-subtle` | `#fbfbfa` | 次级背景、外层工作台背景 |
| `--color-bg-muted` | `#f7f6f3` | 轻卡片、弱提示背景 |
| `--color-canvas` | `#f5f5f4` | 画布类浅底色 |
| `--color-border` | `rgba(55, 53, 47, 0.09)` | 默认边框 |
| `--color-border-strong` | `rgba(55, 53, 47, 0.16)` | 强边框、hover 边框 |
| `--color-text` | `#37352f` | 主文本 |
| `--color-text-muted` | `rgba(55, 53, 47, 0.65)` | 次级文本 |
| `--color-text-soft` | `rgba(55, 53, 47, 0.45)` | 弱化文本 |
| `--color-accent` | `#2383e2` | 重点操作、激活态 |
| `--color-danger` | `#d44c47` | 错误、失效 |
| `--color-success` | `#0f7b6c` | 成功、正常状态 |
| `--color-warning` | `#9b6b24` | 需关注状态 |

使用原则：

- 绝大多数界面采用浅色暖白背景
- 强调色只用于选中、聚焦、关键 CTA 和少量辅助高亮
- 危险色主要用于错误与失效，不用于常规强调
- `bg` 用于主内容和常规卡片本体
- `bg-subtle` 用于工作台、轻 hover、轻展开预览层
- `bg-muted` 用于明确编辑态、行内改名、弱提示容器
- 不为“编辑中”额外发明新色；优先使用现有背景层级拉开状态差异

### 3.2 字体

当前字体体系：

- `--font-ui`
  - `SF Pro Text` + 系统中文回退
  - 默认 UI 字体
- `--font-serif`
  - `"Source Serif 4"` + 中文衬线回退
  - 当前主要作为可选排版资源
- `--font-mono`
  - 系统等宽字体栈

富文本额外提供以下字体预设：

- `workspace_sans`
- `work_sans`
- `noto_sans_sc`
- `source_serif`

### 3.3 字号层级

当前 Tailwind theme inline 中的文字层级：

| Token | Size | Line Height | 用途 |
| --- | --- | --- | --- |
| `caption` | `0.6875rem` | `1rem` | 超小标签、计数、眉题 |
| `ui` | `0.75rem` | `1.125rem` | 控件文字、次级说明 |
| `body` | `0.875rem` | `1.375rem` | 主体内容 |
| `title` | `1rem` | `1.5rem` | 区块标题 |
| `headline` | `1.25rem` | `1.75rem` | 页面级标题 |
| `display` | `1.5rem` | `2rem` | 项目主标题 |

### 3.4 圆角与阴影

当前圆角 token：

- `--radius-4`
- `--radius-6`
- `--radius-8`
- `--radius-12`

当前阴影 token：

- `--shadow-sm`
- `--shadow-md`

使用原则：

- 表单、按钮、轻卡片以 `6px` / `8px` 为主
- Dialog 与较大浮层使用 `12px`
- 只有浮层和模态使用明显阴影

### 3.5 动效

当前统一缓动：

- `--ease-soft`
- `--ease-decel`

当前系统级动效包括：

- `spin`
  - 加载旋转
- `focus-flash`
  - 路由聚焦后的高亮闪现

使用原则：

- 动效只承担反馈与状态提示
- 避免华而不实的装饰性动画

## 4. Primitives

### 4.1 `Button`

文件：

- [`src/ui/components/Button.tsx`](../src/ui/components/Button.tsx)

当前支持：

- 变体：`primary` / `secondary` / `ghost` / `subtle` / `danger`
- 尺寸：`sm` / `md`
- 可带 `leadingIcon` / `trailingIcon`
- 可 `block`

使用原则：

- `primary` 只给主操作
- `secondary` 用于常规表单操作
- `ghost` 用于工具栏和弱动作
- `danger` 用于删除、移除、破坏性动作

### 4.2 `IconButton`

文件：

- [`src/ui/components/IconButton.tsx`](../src/ui/components/IconButton.tsx)

当前支持：

- 变体：`secondary` / `ghost` / `subtle` / `danger`
- 尺寸：`sm` / `md`

适用场景：

- 顶栏图标操作
- 卡片工具操作
- 行内次级操作

### 4.3 `Dialog`

文件：

- [`src/ui/components/Dialog.tsx`](../src/ui/components/Dialog.tsx)

当前特征：

- 居中模态
- 带遮罩和轻模糊
- 支持标题、描述、footer
- 支持点击蒙层关闭
- 支持 `Escape` 关闭

### 4.4 `SurfaceCard`

文件：

- [`src/ui/components/SurfaceCard.tsx`](../src/ui/components/SurfaceCard.tsx)

当前支持：

- 默认背景 `bg`
- `subtle` 弱背景
- 可切换 `as`

适用场景：

- 区块容器
- 列表卡片
- 轻量浮层内容容器

### 4.5 `StatusBadge`

文件：

- [`src/ui/components/StatusBadge.tsx`](../src/ui/components/StatusBadge.tsx)

当前 tone：

- `neutral`
- `accent`
- `success`
- `warning`
- `danger`

语义约束：

- `neutral`
  - 一般标签、中性元信息
- `accent`
  - 激活态、当前上下文
- `success`
  - 正常、可用、已就绪
- `warning`
  - 需关注、阻塞风险、未完成关注态
- `danger`
  - 错误、失效、异常

### 4.6 `SectionHeader`

文件：

- [`src/ui/components/SectionHeader.tsx`](../src/ui/components/SectionHeader.tsx)

当前结构：

- `eyebrow`
- `title`
- `description`
- `actions`

用于统一区块头部信息结构。

### 4.7 `TextField` 与 `SearchField`

文件：

- [`src/ui/components/TextField.tsx`](../src/ui/components/TextField.tsx)
- [`src/ui/components/SearchField.tsx`](../src/ui/components/SearchField.tsx)

当前特征：

- 高度统一为 `7` / `8`
- hover 强边框
- focus 使用 accent 边框
- SearchField 内置搜索图标和 loading 旋转态

### 4.8 `ToolbarButton`

文件：

- [`src/ui/components/ToolbarButton.tsx`](../src/ui/components/ToolbarButton.tsx)

用于富文本工具栏中的等权工具按钮。

### 4.9 `EmptyState`

文件：

- [`src/ui/components/EmptyState.tsx`](../src/ui/components/EmptyState.tsx)

当前特征：

- 支持默认图标
- 支持紧凑版 `compact`
- 支持附带操作按钮

### 4.10 `PopoverPanel`

文件：

- [`src/ui/components/PopoverPanel.tsx`](../src/ui/components/PopoverPanel.tsx)

用于：

- 搜索结果浮层
- 归档项目浮层
- 轻量菜单

### 4.11 `ActionContextMenu`

文件：

- [`src/ui/components/ActionContextMenu.tsx`](../src/ui/components/ActionContextMenu.tsx)

用于：

- 文件卡片右键菜单
- 富文本图片 / 表格上下文菜单
- 对象级轻量危险操作与二级动作

约束：

- 菜单本体不承担复杂表单
- 危险操作用 `danger` tone 明确表达，不靠额外确认文案堆叠
- 键盘导航、Escape 关闭、视口内定位是默认能力

### 4.12 `DeleteContextMenu`

文件：

- [`src/ui/components/DeleteContextMenu.tsx`](../src/ui/components/DeleteContextMenu.tsx)

用于：

- 把“删除”从普通动作里单独抬出来
- 在不进入完整 Dialog 的前提下承接轻量破坏性确认

### 4.13 `ProjectStarButton`

文件：

- [`src/ui/components/ProjectStarButton.tsx`](../src/ui/components/ProjectStarButton.tsx)

用于：

- 文档标星
- 轻量收藏态切换

约束：

- 标星是局部对象状态，不升级成页面级 badge 或提示卡
- 默认只用图标反馈，不额外补“已标星”说明文案

## 5. Layout Patterns

### 5.1 Workspace Top Bar

文件：

- [`src/components/layout/WorkspaceTopBar.tsx`](../src/components/layout/WorkspaceTopBar.tsx)

当前承担：

- 项目切换
- `Today` 入口
- `Ask` 入口
- 新建项目
- 顶部搜索
- 归档项目入口
- 设置入口
- Workspace 菜单

不应在这里堆入复杂业务面板。

### 5.2 Project Sidebar

文件：

- [`src/components/layout/ProjectSidebar.tsx`](../src/components/layout/ProjectSidebar.tsx)

当前承担：

- 项目概览入口
- Activity 列表
- 折叠 / 展开侧栏
- 当前 Activity 高亮

侧栏强调“快速定位”，不是详情承载区。

### 5.3 Status Bar

文件：

- [`src/components/layout/StatusBar.tsx`](../src/components/layout/StatusBar.tsx)

当前承担：

- 当前全局反馈状态
- 当前上下文
- 工作台摘要信息

状态栏使用 `FeedbackStore` 作为单一事实源。

### 5.4 Settings Dialog

文件：

- [`src/components/settings/SettingsDialog.tsx`](../src/components/settings/SettingsDialog.tsx)

当前结构：

- 左侧 section nav
- 右侧内容区
- 分为：
  - 活动标签
  - 文件标签
  - 记录类型
  - AI 设置
  - 富文本样式

设置页默认规范：

- 已有项优先做成紧凑行，而不是一项一个“迷你表单卡片”
- 已有轻量字典项优先使用“一行一个对象”的结构，例如“色点 + 名称 + 必要动作”
- 设置导航优先做成单行入口，不为每个入口额外补一段解释
- 新增区与已有项分开即可，不为简单新增再引入多余说明块
- 默认先展示已有对象，不默认摊开新增表单；创建动作优先收在当前区块的 `新建` 入口里
- 点击 `新建` 后，只在当前 section 内展开一个最小 composer；创建成功后立即收起
- 轻量编辑优先原位完成：默认展示态，进入编辑态后自动保存；复杂编辑才展开成右侧详情或二级编辑区
- 只在真正需要用户输入时使用字段标签；占位词足够清楚时不重复写一层标题
- 概览信息只保留会影响判断的状态，不做纯装饰性的总结卡、说明卡、快照卡
- 删除、保存、切换等动作尽量靠近当前对象，避免跨区操作
- 低风险元数据默认自动保存，不为此单独追加一层“保存”按钮
- 自动保存场景不再额外回显“保存成功”层级，只保留同步状态或失败反馈
- 复杂且高风险的提交才保留显式保存，例如密钥、外部接入配置、不可逆操作
- 同一语义优先上收到区块级开关，不在每一行重复放一组等价的模式选择
- 成对或成组的参数优先并排收拢，例如段前 / 段后、H1 / H2 / H3，不把一组信号拆成散落字段

### 5.5 Inline Object Patterns

适用对象：

- Activity 记录结果
- 结论列表
- 文件材料卡片 / 行

设计目标：

- 在同一工作台里，让阅读态、hover、编辑态、次要操作使用一致语法
- 让对象编辑显得明确，但不过度膨胀成完整表单页
- 用局部信号表达状态，不额外堆 badge、说明文案或装饰块

视觉规则：

- 阅读态 hover 使用轻高亮，不抢主色，不制造假选中
- 编辑态统一使用浅底 surface、细边框、统一圆角
- 焦点反馈优先靠边框和轻 ring，不靠深底色
- 右键菜单承载对象级次要动作，例如标星、删除、标签调整
- 不为项目级状态额外加 badge；优先用对象局部信号表达，例如蓝色导线
- 导线一律保持直线，不使用弧线或装饰性折线

保存与退出约定：

- 富文本对象优先支持 `blur` 完成保存
- `Ctrl+Enter` / `Cmd+Enter` 是明确完成编辑的快捷方式
- `Esc` 表示放弃当前修改并退出编辑
- 不为轻量对象编辑默认增加“保存 / 取消”按钮，除非该对象本身是完整表单

模块落点：

- `记录` 使用最完整的 inline editor 体验，包含编辑头部、toolbar 与 autosave
- `结论` 复用记录的 surface 语言，但保留更轻的点击即编辑模型
- `文件材料` 复用同层 hover 与编辑态语言，但保留文件对象自己的上下文菜单与版本能力

### 5.6 Workspace Gate

文件：

- [`src/App.tsx`](../src/App.tsx)

当前承担：

- Workspace 起始页
- 最近使用 Workspace 列表
- 新建 / 打开 Workspace 主操作

设计规则：

- 起始页允许比工作区内部更“宽松”和更“欢迎进入”，但仍然保持同一套颜色和字体体系
- 最近使用列表应该像“继续工作”的入口，而不是文件浏览器
- 与 Workspace 相关的安全或迁移提示应放在轻卡片中，不打断主 CTA

### 5.7 AI Artifact Surfaces

文件：

- [`src/components/ai/AiArtifactCard.tsx`](../src/components/ai/AiArtifactCard.tsx)
- [`src/components/project/ProjectOverviewPage.tsx`](../src/components/project/ProjectOverviewPage.tsx)
- [`src/components/activity/ActivityPage.tsx`](../src/components/activity/ActivityPage.tsx)
- [`src/components/today/TodayPage.tsx`](../src/components/today/TodayPage.tsx)

适用对象：

- `Activity Summary`
- `Project Brief`
- `Today`

视觉规则：

- AI 概览是“工作台摘要卡”，不是聊天气泡
- 状态徽标、刷新按钮、时间信息应稳定出现在头部
- `stale` 和 `error` 采用浅色状态条提示，不把整张卡切成红底或黄底
- 引用信息优先做成可回跳对象列表，而不是长脚注

### 5.8 Ask Dialog

文件：

- [`src/components/ai/AskPanel.tsx`](../src/components/ai/AskPanel.tsx)

当前承担：

- Workspace / Project / Activity 范围切换
- 单轮问题输入
- 答案与引用展示

设计规则：

- Ask 是“范围内检索式提问”，不是开放式聊天产品
- 范围切换应该在输入区之前明确出现
- 回答区优先展示可读性和引用回跳，不强调连续对话历史
- 当能力未配置或 secrets 未解锁时，优先显示下一步动作，而不是堆技术报错

### 5.9 Document Import Tag Dialog

文件：

- [`src/components/document/DocumentImportTagDialog.tsx`](../src/components/document/DocumentImportTagDialog.tsx)

当前承担：

- 批量导入前的标签选择
- 导入文件清单预览
- 跳转文件标签设置

设计规则：

- 这是“导入前一步”，不是完整管理页
- 一屏内完成选择、确认或跳转设置
- 标签选项需要直接展示色点，不依赖用户记忆颜色

### 5.10 Rich Text Asset Patterns

文件：

- [`src/components/rich-editor/RichEditor.tsx`](../src/components/rich-editor/RichEditor.tsx)
- [`src/components/rich-editor/extensions/ManagedImage.ts`](../src/components/rich-editor/extensions/ManagedImage.ts)
- [`src/components/rich-editor/extensions/Attachment.ts`](../src/components/rich-editor/extensions/Attachment.ts)
- [`src/components/rich-editor/extensions/ManagedTable.ts`](../src/components/rich-editor/extensions/ManagedTable.ts)

适用对象：

- 记录中的图片
- 记录中的附件
- 记录中的表格

设计规则：

- 图片、附件、表格都属于“正文内对象”，需要遵守正文排版节奏
- 图片与表格支持局部上下文菜单和尺寸调整，但不引入漂浮工具面板常驻占位
- 附件默认表现为轻量块对象，重点传达“这是什么文件、能否打开”
- 插入型对象的控制信号应尽量靠近对象本身，不额外在页面外层重复出现

## 6. State Language

### 6.1 Feedback 状态语言

来源：

- [`src/state/feedback-store.ts`](../src/state/feedback-store.ts)

当前 tone：

- `neutral`
- `success`
- `warning`
- `error`

映射原则：

- `neutral`
  - Ready、空闲、等待下一步
- `success`
  - 保存成功、创建成功、写入成功
- `warning`
  - 进行中、需关注
- `error`
  - 操作失败、外部资源异常

### 6.2 Activity 状态语言

当前 Activity 状态语义由 `label + colorKey` 共同表达。

表现规则：

- `label`
  - 直接表达业务状态，例如“待启动”“已归档”
- `colorKey`
  - 决定侧栏、标签、摘要中的展示颜色
- 不再把状态强行折叠成“正常 / 需关注”两类隐藏语义

### 6.3 Todo 状态语言

当前 Todo 只有两态：

- `unfinished`
- `finished`

不要在实现中假设存在 `doing / blocked / cancelled` 等中间态。

### 6.4 Document 状态语言

当前 Document 健康状态：

- `normal`
- `missing`

当 `missing` 时：

- 使用 `danger` 呈现
- 保留明显异常提示
- 不把它伪装成普通文件状态

### 6.5 Workspace Security 状态语言

当前 Workspace secrets 只有两种正式状态：

- `locked`
- `unlocked`

表现规则：

- `locked`
  - 不用夸张警报样式
  - 重点表达“需要先解锁才能继续”
- `unlocked`
  - 只作为可继续执行 AI 能力的前提，不额外做炫耀式提示

### 6.6 AI Artifact 状态语言

当前 AI Artifact 正式状态：

- `fresh`
- `stale`
- `error`

映射原则：

- `fresh`
  - 使用 `success`，表达“当前内容与源数据一致”
- `stale`
  - 使用 `warning`，表达“可继续读，但建议刷新”
- `error`
  - 使用 `danger`，表达“最近一次生成失败”

### 6.7 AI Job 状态语言

来源：

- [`src/lib/aiJobs.ts`](../src/lib/aiJobs.ts)
- [`src/state/ai-job-store.ts`](../src/state/ai-job-store.ts)

当前状态：

- `queued`
- `running`
- `succeeded`
- `failed`

映射原则：

- `queued`
  - 表示已接受请求，但还未开始执行
- `running`
  - 表示当前正在生成或测试
- `succeeded`
  - 表示最近一次请求完成
- `failed`
  - 表示最近一次请求失败，应优先给出重试路径

## 7. Engineering Guardrails

来源：

- [`scripts/check-ui-standards.mjs`](../scripts/check-ui-standards.mjs)

当前必须遵守：

- 页面业务组件不直接引入 `@tauri-apps`
- 原生能力优先收敛在 service 或 infra helper 内
- 不使用非 Lucide 图标库
- 除明确例外文件外，不写硬编码颜色
- 不继续使用旧设计系统命名残留
- 源文件中不引入 emoji

当前边界现实上已有两个 infra 级例外，需要继续收敛并让脚本对齐：

- [`src/lib/aiJobs.ts`](../src/lib/aiJobs.ts)
- [`src/hooks/useWindowFileDrop.ts`](../src/hooks/useWindowFileDrop.ts)

当前脚本明确防止的旧模式包括：

- `color-ink`
- `bg-surface`
- `text-ink`
- `surface-sidebar`
- `useAppStore`
- `lib/api`
- `state/app-store`

## 8. 当前限制

这套 Design System 目前仍是产品内系统，而不是平台级系统。

当前限制包括：

- 没有独立 token 编译链
- 没有暗色主题
- 没有完整的响应式断点设计规范文档
- 没有组件级 Figma-to-code 对应体系
- 没有复杂数据可视化组件规范

后续若系统继续扩展，应优先在当前文件基础上演进，而不是重新发明另一套命名体系。

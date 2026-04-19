# Project Mind Alpha 产品 PRD

## 1. 文档定位

这是一份基于 `2026-04-19` 当前代码实现整理的现状基线 PRD，用来描述 Project Mind Alpha 已经具备的产品能力、当前明确未做的范围，以及接下来 `1` 到 `2` 个版本的演进方向。

本文档只记录三类内容：

- 当前前台已经可用的能力
- 数据层或基础设施已经存在、但前台尚未完整开放的能力
- 与现有实现直接相连的近期规划

不再保留与当前系统不符的理想态描述。

## 2. 产品定位

Project Mind Alpha 是一个 `workspace-first`、本地优先的项目推进工作台。

它不是通用笔记工具，也不是完整的项目管理平台。当前产品核心目标是：

- 围绕 `Workspace` 打包项目推进过程中的数据、文件、AI 配置与本地状态
- 围绕 `Project` 组织项目推进过程中的资料、记录和结果
- 围绕 `Activity` 承接一次具体会议、评审、对齐或处理动作
- 把原始记录沉淀为 `Conclusion` 和 `Todo`
- 让用户在项目级持续看到当前状态，而不是反复翻会议纪要

当前技术形态为：

- 桌面应用：`Tauri + React + TypeScript`
- 本地结构化数据：`SQLite`
- 本地文件托管：Workspace 根目录、项目目录、Activity 目录、受控附件路径
- AI 接入：本地配置 provider profile，本地执行检索与总结流程
- 本地优先，不依赖服务端运行

## 3. 目标用户

当前产品主要面向以下用户：

- 项目负责人
- 产品经理 / 方案经理
- BA / 跨团队协调者
- 需要频繁开会、整理资料、跟踪后续动作的人

核心使用场景是：

- 在 Workspace 内持续维护多个项目上下文
- 在 Activity 中连续记录会议、评审和讨论过程
- 从记录中沉淀结论与待办
- 管理项目 / Activity 文件材料及其版本
- 借助 AI 生成候选结论 / Todo、活动总结、项目概览和今日摘要
- 在 Workspace / Project / Activity 范围内直接发起 Ask 检索式提问

## 4. 当前信息模型

### 4.1 核心对象

- `Workspace`
  - 本地工作区根目录
  - 包含数据库、元数据、缓存、日志、AI 密钥和最近使用状态
- `Project`
  - 项目容器
  - 包含名称、状态、根目录、摘要、归档状态
- `Activity`
  - 项目中的一次具体工作事件
  - 包含标题、时间、活动属性、活动状态、折叠状态、记录置顶状态、目录名
- `Note`
  - Activity 内原始记录
  - 当前由 `RecordType` 驱动，可配置标签、颜色和模板
- `Conclusion`
  - Activity 中沉淀出的明确结论
  - 可标记为“提升到项目首页”
- `Todo`
  - 项目或 Activity 范围内的待推进事项
  - 当前为两态：`unfinished` / `finished`
- `TodoProgress`
  - Todo 的阶段性进展记录
- `Document`
  - 项目级或 Activity 级文件材料
  - 当前包含托管路径、原始路径、版本目录、标星状态、健康状态、标签集合
- `FileTag`
  - Workspace 级文件标签字典
  - 可用于文件导入和后续筛选 / 右键打标
- `RecordType`
  - Workspace 级记录类型字典
  - 决定记录标签、颜色和默认模板
- `AI Profile / Binding / Feature Settings / Execution Settings`
  - AI 接入配置、能力绑定、可见性开关、并发设置和密钥存储策略
- `AI Artifact`
  - 由 AI 生成并缓存的结构化结果
  - 当前包括 `activity_summary`、`project_brief`、`daily_brief`

### 4.2 当前关系

- `Workspace` 1:N `Project`
- `Workspace` 1:N `FileTag`
- `Workspace` 1:N `RecordType`
- `Workspace` 1:N `AI Provider Profile`
- `Project` 1:N `Activity`
- `Activity` 1:N `Note`
- `Activity` 1:N `Conclusion`
- `Project` 1:N `Todo`
- `Todo` 可选关联 `Activity`
- `Project` 1:N `Document`
- `Document` 可选关联 `Activity`
- `Document` N:N `FileTag`
- `Todo` 1:N `TodoProgress`
- `AI Artifact` 可绑定到 `Activity`、`Project` 或 `Workspace Day`

## 5. 当前已实现能力

### 5.1 Workspace 与导航

- 首次进入应用时必须先打开或新建 Workspace
- Workspace 创建时会初始化：
  - `.project-mind/workspace.json`
  - `.project-mind/workspace.sqlite3`
  - `.project-mind/cache/ai`
  - `.project-mind/logs`
  - `.project-mind/tmp`
- 支持展示最近使用的 Workspace 列表
- 支持从顶部 Workspace 菜单：
  - 打开当前 Workspace 根目录
  - 切换 Workspace
  - 锁定 AI secrets
- 顶部工作台支持展示活跃项目页签
- 当 Workspace 已打开时，顶部始终提供 `Today` 入口；`daily brief` 开关只影响 Today 页内 AI 卡片是否展示
- 在 AI Assistant 功能开启时，顶部提供 `Ask` 入口
- 支持查看归档项目列表并恢复项目
- 支持全局设置入口
- 支持按项目记忆当前会话中的最近访问位置，覆盖：
  - 项目总览
  - Activity 页面
  - 记录专注页
  - `todo / conclusion / document` 的 `focus` 锚点
- 支持顶部工作台搜索，覆盖：
  - 项目
  - Activity
  - 结论
  - Todo
  - 文件

### 5.2 项目管理

- 支持在当前 Workspace 内创建项目
- 创建时在 Workspace 根目录下生成同名项目文件夹
- 支持行内编辑项目名称
- 项目简介已升级为富文本，并采用默认展示态单框点击即编
- 项目标题旁展示可直接切换的状态标签
- 支持项目归档与恢复
- 支持在项目页查看：
  - 项目富文本简介
  - Activity Feed
  - 项目级文件区
  - 结论时间线
  - 项目级 Todo Rail
  - `Project Brief` AI 概览卡（功能开启时）

### 5.3 Activity 管理

- 支持在项目页内创建 Activity
- 当前创建字段为：
  - 活动属性，可选
  - 标题
  - 时间
- 创建 Activity 后会自动生成对应目录名并落到项目目录下
- Activity 左侧边栏提供“新建 Activity”入口，展开态与收起态都可触达
- Activity 详情页当前支持：
  - 查看和编辑标题
  - 调整活动属性
  - 调整活动状态
  - 调整时间
  - 维护独立的富文本简介
- 活动状态来自可配置字典，由名称和颜色共同表达
- 活动列表和侧边栏使用对应颜色标签展示状态
- Activity 文件区之外，会在有内容时额外提供默认折叠的“项目文件”区，用于展示当前项目下的项目级标星文件

### 5.4 Note 记录

- 每个 Activity 下支持多条 Note
- Note 类型来自记录类型设置，默认包含：
  - `quick_note`
  - `meeting_minutes`
- 支持为每种记录类型维护独立模板、颜色和默认标识
- 支持在 Activity 页创建、编辑和切换已有记录；当 Activity 暂无记录时，可从空态直接新建默认记录
- 记录标题保留独立单行输入框，`Tab / Enter` 可直接跳转到正文编辑区
- 支持根据内容自动推导记录标题，也支持显式标题
- 支持将文件插入到富文本记录中
- 支持在富文本记录中插入和管理：
  - 图片
  - 附件
  - 表格
  - 任务列表
- 支持粘贴截图并转成受控图片资源，空白编辑器也可直接粘贴图片
- 富文本编辑器统一支持 `[[...]]` 内部引用，覆盖记录、项目简介、Activity 简介、Today 快记和 workspace notes 等入口
- 支持将一条记录置顶显示
- 支持独立的记录专注页路由，已保存记录与草稿都可进入；Activity 行内编辑与专注页之间共享未保存会话
- 支持从已保存记录触发 AI 提炼

### 5.5 结论沉淀

- 支持在 Activity 页手动新增 Conclusion
- Activity 级新增结论默认提升到项目首页；Project 级新增结论默认不提升
- 结论支持置顶，Project / Activity 两端统一按 `isPinned DESC, createdAt DESC` 排序
- 支持在项目页按 Activity 分组浏览结论时间线
- 支持在项目页和 Activity 页对已有结论做行内编辑
- 支持从 AI 候选中确认写入结论

### 5.6 Todo 管理

- 支持在项目级创建 Todo
- 支持在 Activity 级创建 Todo
- Today 页面支持按项目卡片直接新建 Todo，创建时默认落为项目级 Todo
- Todo 当前字段包括：
  - 内容
  - 两态状态：`unfinished` / `finished`
  - 优先级
  - 可选所属 Activity
- 支持：
  - 更新内容
  - 切换状态
  - 通过优先级标签直接调整优先级
  - 通过活动来源菜单直接改绑所属 Activity，或清空回项目级
  - 追加、修改、删除最新进展与历史进展
- Todo 正文与进展继续以文本存储，但已支持 `[[...]]` 内部引用的插入、展示与点击跳转
- 项目页和 Activity 页都通过侧边 Todo Rail 展示未完成与已完成事项
- Today 页面提供工作区级 Todo 聚合视图，并支持从项目级 / Activity 级条目跳转到对应页面

### 5.7 文件管理

- 支持在项目级或 Activity 级导入文件
- 支持原生窗口拖拽导入
- 当 Workspace 已配置文件标签时，导入前会弹出批量标签选择对话框
- 当前导入行为为复制到项目受控目录
- Activity 级导入文件默认标星；Project 级导入文件默认不标星
- 支持文件标签：
  - 导入时批量挂载
  - 列表筛选
  - 右键增删标签
- 支持点击文件打开托管文件
- 支持从文件卡片右键打开文件所在位置
- 支持从文件卡片右键显式新增版本，并在新增后浏览版本列表
- 支持双击文件名重命名 `baseName`
- 支持标星 / 取消标星
- 支持删除文件，并将受控当前文件与历史版本移到系统回收站
- 删除文件卡片时不会删除原始来源文件 `originalPath`
- 支持识别文件健康状态：
  - `normal`
  - `missing`
- 记录内嵌图片也会进入受控文档体系，并保存在项目隐藏目录下
- 文件可作为内部引用目标，并沿用现有 `document-*` 锚点进行定位

### 5.8 搜索与定位

- 当前搜索入口位于顶部工作台
- 当前搜索结果可跳转到：
  - 项目总览
  - Activity 页面
  - 指定记录专注页
  - 指定结论锚点
  - 指定 Todo 锚点
  - 指定文件锚点
- 当前富文本与 Todo 文本编辑入口支持统一内部引用选择器：
  - 输入 `[[` 后搜索记录 / 结论 / Todo / 文件
  - 保存稳定对象标识与显示标签
  - 点击引用后，记录跳转到专注页；结论 / Todo / 文件跳转到现有页面并复用 `focus` 锚点

### 5.9 AI

#### 已实现的前台能力

- `Suggestion Generation`
  - 从单条 Note 生成候选结论
  - 从单条 Note 生成候选 Todo
  - 自动补齐记录标题建议
  - 用户确认后写入当前 Activity
- `Summary`
  - 在 Activity 页生成 `Activity Summary`
  - 在项目页生成 `Project Brief`
  - 在 Workspace 级生成 `Today`
  - 结果带状态：`fresh / stale / error`
  - 支持手动刷新和引用回跳
- `Assistant`
  - 提供 `Workspace / Project / Activity` 三种 Ask 范围
  - 回答尽量附带可回跳的本地引用
  - 当前只保留最近一条回答

#### 当前支持的 provider family

- `OpenAI-compatible`
- `Claude-compatible`
- `Gemini-compatible`

#### 当前配置能力

- 支持配置 AI provider profile
- 支持测试模型连通性
- 支持配置默认能力绑定和按能力单独绑定
- 支持控制 AI 能力总开关、Summary 子功能开关、Suggestion 子功能开关
- 支持配置后台 AI 作业全局并发量 `1` 到 `4`

#### 当前安全能力

- Workspace 打开后默认不解锁已保存密钥
- API Key 采用 Workspace 密码加密存储
- 保存 API Key、测试连接和执行 AI 能力前，需要先解锁当前 Workspace secrets

### 5.10 设置

当前设置页分为五个分区：

- `活动标签`
  - 管理活动属性字典
  - 管理活动状态字典
- `文件标签`
  - 管理 Workspace 级文件标签字典
  - 为文件导入、筛选和右键打标提供复用源
- `记录类型`
  - 管理记录类型名称、颜色和模板
  - 支持默认记录类型切换
- `AI 设置`
  - 管理 provider profile
  - 管理能力绑定
  - 管理能力可见性和子功能开关
  - 管理作业并发
  - 查看 Workspace 加密模式
- `富文本样式`
  - 配置正文、标题、列表的字体、字号、行距和段前后距

## 6. 已建模但未完整暴露的能力

以下能力当前在数据层、命令层或基础设施层已经存在，但前台没有形成完整用户能力，不应写成“已实现”：

- 文档重新定位
  - 后端已有 `document_relocate`
  - 当前前台仍以“提示重新导入”作为主要修复方式
- AI 作业队列
  - 当前已有排队、运行、成功、失败的作业状态模型
  - 但前台没有独立的“作业中心 / 历史队列”页面
- 历史 legacy 迁移兼容
  - 数据层仍保留部分历史字段与迁移逻辑，用于兼容旧数据

## 7. 当前明确未做

- 文件角色 UI
- 项目级 Conclusion 直接创建入口
- 文档失效后的完整重新定位引导 UI
- 五态 Todo
- Todo 截止时间
- Todo 描述字段
- 导出向导
- 云同步
- 多人协作
- 权限体系
- Ask 多轮对话历史
- 高级筛选系统 / Saved Views

## 8. 当前产品约束

### 8.1 交互约束

- 未打开 Workspace 之前，业务页面不会进入可操作状态
- 保存的 AI 密钥需要先用当前 Workspace 密码解锁后才能继续使用
- 已创建的记录不会在原位切换成另一种记录类型；当前方式是新建另一条记录
- AI Summary 默认是按需刷新，不做后台自动推送式更新
- Ask 默认只保留最近一条回答，不形成连续会话上下文
- 文件健康状态可见，但修复动作仍不完整

### 8.2 架构约束

- 当前前端业务编排仍较多集中在页面组件和 mutation hooks
- React Query 失效策略仍偏手工
- Tauri 后端仍以集中式命令入口和大型 `Database` 对象为主
- 部分 legacy schema、迁移兼容和边界例外尚未完全收敛

## 9. 下一阶段演进

以下规划只覆盖未来 `1` 到 `2` 个版本，并直接对齐当前实现的缺口。

### 9.1 文件恢复与角色体系

- 为失效文件补完整的重新定位流程
- 明确文件角色语义，并提供前台可见的角色编辑入口
- 继续收敛版本浏览、版本生成和修复动作的入口层次

### 9.2 AI 工作流深化

- 为 Ask 增加会话历史和更稳定的上下文延续
- 为 Summary 增加更明确的刷新策略和更丰富的摘要入口
- 把当前分散的 AI 入口整理成一致的可见性与反馈体系

### 9.3 后端分层

- 把当前集中式数据库对象拆分为：
  - commands
  - repositories
  - domain services
  - file / AI infra
- 缩小数据库锁作用范围，减少长耗时 I/O 对整体响应的阻塞

### 9.4 前端查询层收敛

- 收敛 query key 定义
- 减少页面内散落的 `invalidateQueries`
- 逐步把页面编排下沉到 screen hooks 或组合层

### 9.5 Workspace 交付能力

- 补充更清晰的 Workspace 打包、迁移和交接说明
- 评估显式导出 / 导入向导是否需要进入正式产品流

## 10. 文档使用原则

从当前版本开始：

- 本文档是产品现状与近期规划的基线
- 任何新功能进入本文档之前，必须先在代码或明确实现方案中有事实依据
- 数据层预留能力必须明确标注为“未完整暴露”或“后续规划”，不得直接写成“已实现”

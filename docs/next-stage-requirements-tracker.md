# Project Mind 下一阶段需求规划与实施跟踪

## 1. 文档定位

本文档用于承载 Project Mind 下一阶段改版的需求规划与实施进度跟踪。

它不是现状 PRD，也不是历史增量需求归档，而是后续执行时的主文档。我们后面每做完一轮实现，都要同步更新本文档中的状态表，而不是只在聊天中汇报。

本文档包含三类信息：

- 下一阶段要做什么
- 每个需求的目标结果是什么
- 当前做到哪一步、如何验证、还有什么风险

## 2. 统计摘要

| 统计维度 | 数量 |
| --- | ---: |
| 总条目数 | 21 |
| 未开始 | 1 |
| 规划中 | 0 |
| 进行中 | 0 |
| 部分完成 | 4 |
| 已完成 | 16 |
| 已跳过 | 0 |

## 3. 实施跟踪总表

说明：

- `当前状态` 固定使用：`未开始` / `规划中` / `进行中` / `部分完成` / `已完成` / `已跳过`
- `本轮结果` 只记录最近一次真实落地情况
- 聊天里的口头汇报不算正式完成，只有本表更新才算完成登记

| 编号 | 模块 | 需求项 | 目标结果 | 当前状态 | 本轮结果 | 验证方式 | 备注 / 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NAV-01` | 总览 / 导航 | `Today` 前台统一改名为 `总览`，并作为固定入口保留 | 顶部始终可见总览入口，前台文案统一为总览，旧 `/today` 路由继续兼容 | 已完成 | 已完成入口与文案切换，并保留旧路由兼容 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前只完成入口与文案统一，后续“总览”内容仍会继续扩展 |
| `NAV-02` | 总览 / 导航 | 项目 tab 改为按打开显示 | 顶部只显示已打开项目，点击项目后进入 tab，支持关闭 tab | 已完成 | 已完成 opened project tabs 与关闭逻辑 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 目前只支持单窗口内 tab 管理，多窗口联动未开始 |
| `NAV-03` | 总览 / 导航 | 总览页左侧项目树 | 总览页左侧展示项目树，可从项目树打开项目 | 已完成 | 已完成总览页左侧项目树首版 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 目前是首版项目树，后续还可继续增强层级与筛选 |
| `TODO-01` | Todo 重构 | Todo 默认稳定排序 | 项目、活动、工作区 Todo 默认按 `createdAt DESC` 稳定排序，不因编辑变化位置 | 已完成 | 已完成前端排序与关键后端查询切换 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前已覆盖关键主列表，后续若新增列表需继续遵循同一排序原则 |
| `TODO-02` | Todo 重构 | 新增 Todo 支持多行输入 | 总览页与侧边 Todo Rail 的新建 Todo 输入支持多行，`Cmd/Ctrl+Enter` 提交 | 已完成 | 已完成总览与 Todo Rail 多行输入改造 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前改造覆盖新建输入，后续 Todo 详情态若扩展也要保持一致 |
| `TODO-03` | Todo 重构 | Todo Rail 支持拖拽调宽 | 右侧 Todo Rail 可拖拽调宽，宽度偏好持久化 | 已完成 | 已完成拖拽调宽与偏好存储 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前仅右侧 Todo Rail 支持拖宽，总览 Todo 侧边化仍未开始 |
| `LAYOUT-01` | 页面布局 / 工具条 | 侧边栏收起更窄 | 项目侧边栏与 Todo Rail 收起态比当前更窄 | 已完成 | 已完成两处收起宽度收窄 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前为宽度微调，后续若侧栏结构变化需要复核视觉平衡 |
| `LAYOUT-02` | 页面布局 / 工具条 | 总览页宽度设置 | 总览页支持 `自适应 / 宽 / 全宽` 三种宽度偏好 | 已完成 | 已完成总览页宽度切换首版 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前只覆盖总览页，项目页 / 活动页页面宽度设置仍未统一 |
| `EDITOR-01` | 编辑器体验 | Markdown 纯文本粘贴识别 | 粘贴 Markdown 纯文本时自动按 Markdown 解析，重点支持表格 | 已完成 | 已完成 Markdown 粘贴判定首版与 HTML 渲染接入 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前为首版判定，后续仍需继续补边界输入与复杂 Markdown 场景 |
| `EDITOR-02` | 编辑器体验 | 标题回车跳正文首行 | 标题行 `Enter/Tab` 后光标进入正文首行开头，而不是末尾 | 已完成 | 已完成焦点事件从 `end` 改为 `start` | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 已覆盖标题跳正文主路径 |
| `EDITOR-03` | 编辑器体验 | 编辑器缩进支持 | 列表内支持 `Tab / Shift+Tab` 缩进与反缩进 | 已完成 | 已完成列表缩进键盘处理 | `npm run build`；`npm run test:unit -- src/components/layout/WorkspaceTopBar.test.tsx src/App.test.tsx src/components/today/TodayPage.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/todo/TodoRail.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前主要覆盖列表缩进，其他块类型缩进策略后续再定 |
| `NOTE-01` | 默认笔记 / 记录 | 项目默认笔记替代简介区 | 项目页不再保留独立简介区，改为顶部常驻默认笔记，始终可编辑且不单独展示笔记标题 | 部分完成 | 已将项目页顶部简介体验调整为常驻默认笔记，支持内联编辑与最大化编辑，页面不再展示独立笔记标题 | `npm run build`；`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/activity/ActivityPage.test.tsx` | 当前先沿用现有项目 summary 存储；后续仍需补 Project.defaultNoteId / Note 级迁移 |
| `NOTE-02` | 默认笔记 / 记录 | 活动默认笔记与最大化编辑 | 活动页顶部常驻同名默认笔记，支持最大化编辑，不单独展示笔记标题 | 部分完成 | 已将活动页顶部简介体验调整为常驻默认笔记，支持内联编辑与最大化编辑，页面不再展示独立笔记标题 | `npm run build`；`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/activity/ActivityPage.test.tsx` | 当前先沿用现有 Activity brief 存储；后续仍需补 Activity.defaultNoteId / Note 级迁移 |
| `NOTE-03` | 默认笔记 / 记录 | 选中内容另存为活动 / 追加到项目笔记 | 支持从总览笔记选区另存为活动，也支持将选中内容追加到现有项目默认笔记 | 已完成 | 已补齐项目默认笔记“选区新建 Activity”：右键选区后可创建 Activity，并将选区 markdown/html 写入活动默认笔记；总览选区另存与追加项目笔记能力保持可用 | `npm run build`；`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/today/TodayQuickNotePanel.test.tsx src/components/today/TodayPage.test.tsx src/components/rich-editor/RichEditor.test.tsx` | 当前沿用 Activity brief / Project summary 兼容字段，后续 Note 实体迁移由 NOTE-01 / NOTE-02 收口 |
| `TODO-04` | Todo 重构 | Todo 子项替代 progress | 原 `progress` 重构为可勾选子项，未完成子项默认在主 Todo 下方展示 | 已完成 | 已完成 `todo_progresses` 到可勾选 Todo 子项的兼容重构：新增状态 / 完成时间 / 排序字段，未完成子项默认展示，已完成子项折叠展示并可恢复 | `npm run build`；`npm run test:unit -- src/components/todo/TodoListItem.test.tsx src/components/todo/TodoRail.test.tsx src/components/todo/TodoInlineProgressEditor.test.tsx src/components/today/TodayTodoSection.test.tsx`；`cargo test --manifest-path src-tauri/Cargo.toml todo_progress_status_tracks_subitem_completion -- --nocapture` | 保留旧命令名兼容现有调用；后续若需要拖拽排序，可继续扩展 `orderIndex` 写入接口 |
| `FILE-01` | 文件管理 | 项目左侧 `Files` tab | 项目左侧边栏改为 `Activities / Files` 双 tab，正文区移除原文件模块 | 已完成 | 已完成项目侧栏 `Activities / Files` 双 tab，并移除项目正文区旧文件模块；文件主入口统一收口到侧栏 Files tab | `npm run build`；`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/layout/ProjectSidebar.test.tsx src/App.test.tsx` | 页面拖拽导入与导入标签弹窗仍保留，避免项目根文件导入能力回退 |
| `FILE-02` | 文件管理 | 文件项目级统一展示与标签筛选 | 文件统一在项目级展示，支持搜索、标签筛选、文件类型图标与活动同名推荐标签 | 已完成 | 已完成 Files tab 的 Activity 同名推荐标签筛选，并接入文件在项目根 / Activity / 跨 Activity 之间移动的真实 API | `npm run build`；`npm run test:unit -- src/App.test.tsx src/components/layout/ProjectSidebar.test.tsx` | 跨项目移动不在本行验收范围，后续如需要可新增子项 |
| `CONTACT-01` | 联系人 | `@` 联系人自动补全与自动建档 | 在笔记 / Todo 中输入 `@` 时可按姓名、拼音全拼、拼音缩写搜索联系人；首次出现支持自动创建 | 已完成 | 已在 RichEditor 与总览 / Todo Rail 文本框接入 `@` 自动补全选择器：复用 `[[` 同款触发 / 键盘导航 / 插入机制，新增 `ContactMention` 富文本节点、`@[contact:id｜label]` 纯文本 token 与内联渲染；前端用 `pinyin-pro` 将中文姓名转拼音全拼 / 缩写后写库；选择器内可一键“新建联系人”就地建档；并新增设置内“联系人”维护页（增改 / 删除 / 列表）。点击 mention 暂跳转到联系人维护页。 | `npm run build`；`npm run test:unit -- src/lib/pinyin.test.ts src/lib/contactMentions.test.ts src/components/todo/TodoRail.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/today/TodayQuickNotePanel.test.tsx src/components/today/WorkspaceNotesPanel.test.tsx`（全量 342 通过） | 独立联系人页 / 按人搜索 Todo 仍可后续增强；mention 点击目前统一进入联系人维护页 |
| `DESKTOP-01` | 桌面能力 / 多窗口 | 锁屏 / 休眠自动保存 | 锁屏、休眠、窗口失焦恢复等场景下，未提交内容可自动保存或恢复 | 部分完成 | 已补齐 Todo Rail 与总览 Todo 新建草稿的本地自动保存 / 恢复，并在窗口失焦、页面隐藏、pagehide 时 flush 草稿；本轮进一步为共享 RichEditor 的生命周期自动保存补上 `pagehide` flush，使所有笔记编辑器在应用关闭 / 锁屏 / 休眠导致页面卸载时也会落盘未保存正文。 | `npm run build`；`npm run test:unit -- src/components/rich-editor/RichEditor.test.tsx src/components/todo/TodoRail.test.tsx src/components/today/TodayTodoSection.test.tsx`（全量 343 通过） | Web 层生命周期事件（blur / visibilitychange / pagehide）已覆盖；Tauri 原生锁屏 / 休眠系统事件的专项接入仍需后续在 Rust 侧补齐 |
| `SPECIAL-01` | 特殊项目 | 内置“资料”项目 | workspace 内固定存在一个“资料”项目，无活动，基于标签与搜索管理笔记 | 部分完成 | 已完成 `Project.kind = normal/reference`、单例“资料”项目自动创建 / demo reset 后补齐、禁止资料项目创建 Activity / 归档 / 重命名，并完成资料项目的笔记型项目页与侧边栏差异视图 | `npm run build`；`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/layout/ProjectSidebar.test.tsx`；`cargo test --manifest-path src-tauri/Cargo.toml reference_project_is_singleton_and_disallows_activity_lifecycle -- --nocapture`；`cargo test --manifest-path src-tauri/Cargo.toml reset_and_seed_demo_data_replaces_existing_workspace_data_with_demo_fixture -- --nocapture` | 多笔记标签筛选与搜索仍需后续补项目级资料笔记模型；当前先以资料项目默认笔记承载资料沉淀 |
| `WINDOW-01` | 桌面能力 / 多窗口 | 多窗口支持 | 支持多窗口打开项目，主页常驻，项目可在窗口中独立打开与查看 | 未开始 | 尚未开始 | 未验证 | 需要先明确窗口间状态共享与打开策略 |

## 4. 详细需求说明

### 4.1 总览 / 导航

- 总览作为固定主页常驻，前台统一使用 `总览` 文案。
- 顶部项目 tab 只展示已打开项目，不再默认展示所有项目。
- 总览页左侧展示项目树，用于打开项目。
- 后续仍需补：
  - tag 再次点击返回项目首页
  - 首页项目树与多窗口协同

### 4.2 默认笔记 / 记录

- 项目页需要一个与项目同名的默认笔记，替代原简介区。
- 活动页需要一个与活动同名的默认笔记，替代原 Activity 简介区。
- 默认笔记在页面上不单独展示笔记名称，保持常驻编辑态，支持最大化编辑。
- 需要支持：
  - 从项目默认笔记选区新建活动
  - 从总览笔记选区另存为活动
  - 将选中内容追加到现有项目默认笔记
- 上述选区动作已完成首版接入，当前仍沿用 Activity brief / Project summary 兼容字段承载默认笔记内容。

### 4.3 Todo 重构

- Todo 统一收口到项目级展示。
- Todo 默认排序按创建时间稳定，不再因编辑位置跳动。
- 新增 Todo 支持多行输入。
- Todo Rail 支持拖拽调宽，宽度偏好持久化。
- 后续需要继续做：
  - `按项目分组 / 合并展示`
  - `Todo 子项替代 progress`
  - `桌面悬浮 Todo`
  - `按人搜索 Todo`

### 4.4 文件管理

- 项目侧边栏已改为 `Activities / Files` 双 tab。
- 文件统一在项目级展示，不再把 Activity 当作文件主归属。
- 文件通过项目内标签体系管理，系统自动提供与 Activity 同名的推荐标签。
- Files tab 已支持文件类型图标、项目级搜索 / 筛选，以及项目根 / Activity / 跨 Activity 的归属移动。
- 后续如果要支持跨项目移动，可新增独立子项继续推进。

### 4.5 编辑器体验

- 粘贴 Markdown 纯文本时，需要自动识别并按 Markdown 解析渲染，重点支持表格。
- 标题按 `Enter / Tab` 时，焦点应进入正文首行开头。
- 列表支持 `Tab / Shift+Tab` 缩进。
- 后续仍需补：
  - 表格右键菜单体验继续完善
  - 更完整的 Markdown 边界场景

### 4.6 页面布局 / 工具条

- 项目侧栏与 Todo Rail 收起态要更窄。
- 总览页支持宽度偏好。
- 后续仍需补：
  - 项目页 / 活动页页面宽度设置
  - 顶部悬浮工具条自动隐藏 / 顶部唤起 / 固定

### 4.7 联系人

- 联系人首版以 `@` 提及为主入口。
- 支持录入：
  - 姓名
  - 邮箱
  - 工号
  - 角色
  - 部门
- 已完成联系人实体与搜索 API 首版，支持存储姓名、拼音全拼、拼音缩写、邮箱、工号、角色、部门。
- 已接入 `@` 自动补全（笔记 / Todo）、拼音全拼 / 缩写搜索、首次出现就地建档（前端 `pinyin-pro` 转拼音），以及设置内联系人维护页。
- 后续可继续增强：
  - 独立联系人详情页
  - 按人搜索 Todo

### 4.8 桌面能力 / 多窗口

- 锁屏、休眠、窗口切换时要自动保存或恢复未提交内容。
- 后续支持多窗口打开项目。
- 总览主页仍然是单一入口，项目可在窗口中独立打开。

### 4.9 特殊项目

- 增加一个内置单例“资料”项目。
- “资料”项目没有活动，只有笔记。
- 完全基于标签筛选与搜索组织内容。

## 5. 更新规则

每次后续实现都按下面流程更新本文档：

1. 开始做某项前，先把该行 `当前状态` 改为 `进行中`。
2. 实现完成后，更新该行 `本轮结果`，只写最近一次真实交付内容。
3. 跑完验证后，补 `验证方式`。
4. 根据完成度将状态更新为 `部分完成` 或 `已完成`。

补充规则：

- 如果一轮实现覆盖多个条目，允许同时更新多行，但每一行都要分别写清楚结果。
- 如果一个需求太大，需要继续拆分，就新增子行，不覆盖原行历史。例如：
  - `TODO-04A` 子项数据结构
  - `TODO-04B` 子项 UI 展示
  - `TODO-04C` 历史 progress 数据迁移
- 聊天里的完成汇报不算正式状态更新，只有本文档中的表格回填才算完成登记。

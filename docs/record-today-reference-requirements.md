# Project Mind Alpha 记录 / Today / 引用增量需求文档

## 1. 文档定位

本文档是基于最新代码复核后的增量需求文档，用于指导下一轮 `记录 / Today / Todo / 结论 / 引用` 相关能力的实现与联调。

### 当前实施进展

- 2026-04-19：已完成 `3.6.1 内部引用`，并收口 Todo 卡片最近一轮交互。
  - RichEditor 与 Todo 正文 / 进展现已统一支持 `[[` 唤起引用选择器，覆盖 `记录 / 结论 / Todo / 文件`，插入后保存稳定对象标识，并在点击时复用现有项目路由、记录专注页与 `focus` 锚点跳转；同时补齐引用选择框紧凑排版、Todo 编辑态真实内联标签编辑，以及 Todo 卡片优先级 / 活动来源的直接下拉切换交互。
  - 前端验证：`npm run test:unit -- src/components/rich-editor/RichEditor.test.tsx src/components/todo/TodoInlineContentEditor.test.tsx src/components/todo/TodoInlineProgressEditor.test.tsx src/components/todo/TodoListItem.test.tsx src/components/activity/ActivityPage.test.tsx src/components/project/ProjectOverviewPage.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx src/components/today/WorkspaceNotesPanel.test.tsx src/components/today/TodayQuickNotePanel.test.tsx src/components/today/TodayPage.test.tsx`
  - 后端验证：`cargo test internal_reference_search_supports_scope_and_all_supported_kinds --manifest-path src-tauri/Cargo.toml`，`cargo test internal_reference_resolve_returns_current_routes_after_todo_and_document_moves --manifest-path src-tauri/Cargo.toml`
- 2026-04-18：已按第二轮人工验证收口 `3.1-04 / 3.2-01 / 3.2-02 / 3.3.2-01 / 3.5.2-02 / 3.6.2-01`。
  - 已将记录全页编辑最终收口为独立记录专注页；项目 / Activity 简介统一为单框点击即编；Today Todo 新建改为项目卡片右上角 `+` 入口且不再选择 Activity；项目级标星文件收敛进同一张文件卡片；并补强空白新记录的剪贴板图片导入链路。
  - 前端验证：`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/activity/ActivityPage.test.tsx src/components/activity/ActivityPage.fullpage.integration.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNotesPanel.image-persistence.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/rich-editor/RichEditor.test.tsx`
- 2026-04-18：已完成 `3.1 记录与编辑器` 中“记录全页编辑模式”，支持当前记录独占主区、`Esc` 退出、正文宽度拖拽与宽度偏好持久化。
  - 前端验证：`npm run test:unit -- src/state/ui-store.test.ts src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNotesPanel.image-persistence.test.tsx src/components/activity/ActivityPage.test.tsx`
- 2026-04-18：`3.1-04` 已按新方案重做为 Notion 式“记录专注页”。
  - 记录编辑不再复用 Activity 内覆盖层，而是改为独立路由的记录专注页；保留应用顶栏，正文改成单列居中页面布局，去掉显式保存按钮，改用自动保存状态提示。
  - Activity 行内编辑与记录专注页之间新增共享会话缓存，支持从行内编辑进入专注页时保留未保存标题 / 正文，并在返回 Activity 后恢复当前记录编辑会话。
  - 前端验证：`npm run test:unit -- src/components/activity/ActivityPage.test.tsx src/components/activity/ActivityNotesPanel.test.tsx src/components/activity/ActivityNoteFocusPage.test.tsx`
  - 构建验证：`npm run build`
- 2026-04-18：已完成 `3.6.2 内部引用、粘贴与复制` 中“空内容编辑器可直接粘贴图片，并尽量保留原始清晰度”。
  - 前端验证：`npm run test:unit -- src/components/rich-editor/RichEditor.test.tsx src/components/activity/ActivityPage.test.tsx`
  - 后端验证：`cargo test clipboard_note_image_import_preserves_heic_extension_when_name_is_blank --manifest-path src-tauri/Cargo.toml`
- 2026-04-18：已完成 `3.6.3 内部引用、粘贴与复制` 中“富文本复制到纯文本时保留列表编号与基础结构，且避免多余空符号”。
  - 前端验证：`npm run test:unit -- src/lib/richTextContent.test.ts src/components/rich-editor/RichEditor.test.tsx`
- 2026-04-17：已完成 `3.1 记录与编辑器` 中“记录标题输入框按 `Tab / Enter` 直接跳转正文编辑区且标题不换行”。
  - 前端验证：`npm run test:unit -- src/components/activity/ActivityNotesPanel.test.tsx`
- 2026-04-17：已完成 `3.1 记录与编辑器` 中“当前 `Activity` 无记录时，点击空态提示区域按默认记录类型直接新建记录并进入编辑”。
  - 前端验证：`npm run test:unit -- src/components/activity/ActivityNotesPanel.test.tsx`
- 2026-04-17：已完成 `3.2 项目 / Activity 简介` 中“项目标题旁新增项目状态标签，展示当前已有 `status` 值”。
  - 前端验证：`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx`
- 2026-04-17：已完成 `3.7 侧边导航` 中“Activity 左侧边栏增加‘新建 Activity’入口，展开态与收起态都可触达”。
  - 前端验证：`npm run test:unit -- src/components/layout/ProjectSidebar.test.tsx src/App.test.tsx`
- 2026-04-17：已完成 `3.5.1 结论` 中“Activity 级新增结论默认开启提升到项目层 / 项目级标星”。
  - 前端验证：`npm run test:unit -- src/components/activity/ActivityPage.test.tsx`
- 2026-04-17：已完成 `3.5.2 文件` 中“Activity 级导入文件默认 `isStarred = true`”。
  - 前端验证：`npm run test:unit -- src/components/activity/ActivityPage.test.tsx src/components/project/ProjectOverviewPage.test.tsx`
- 2026-04-17：已完成 `3.4 Todo 与进展` 中“Todo 进展内容为空时不新增 / 不保存”的保存规则补齐。
  - 前端验证：`npm run test:unit -- src/components/todo/TodoInlineProgressEditor.test.tsx`
- 2026-04-17：已完成 `3.4 Todo 与进展` 中“Todo 删除保留右键入口，但删除时不再弹确认框”。
  - 前端验证：`npm run test:unit -- src/components/todo/TodoRail.test.tsx`
- 2026-04-17：已完成 `3.1 记录与编辑器 / 3.7 侧边导航` 中“按项目记忆最近访问页面”的会话内导航行为，项目页签切回时会优先回到该项目最近访问的总览 / Activity / `focus` 锚点页面，并在切换 workspace 时清空该记忆。
  - 前端验证：`npm run test:unit -- src/App.test.tsx src/state/ui-store.test.ts`
- 2026-04-17：已完成 `3.5.2 文件` 中“Activity 页面新增项目级标星文件展示区，默认收起，且与 Activity 自身文件列表分开展示”。
  - 前端验证：`npm run test:unit -- src/components/activity/ActivityPage.test.tsx`
- 2026-04-17：已完成 `3.3.2 Today Todo` 中“Today 页面支持直接新增 Todo，创建时必须选择项目，且可选绑定 Activity”。
  - 前端验证：`npm run test:unit -- src/components/today/TodayTodoSection.test.tsx src/components/today/TodayPage.test.tsx`
- 2026-04-17：已完成 `3.4 Todo 与进展` 中“Todo 进展支持右键菜单修改 / 删除，覆盖最新进展与历史进展”。
  - 前端验证：`npm run test:unit -- src/components/todo/TodoInlineProgressEditor.test.tsx src/components/todo/TodoListItem.test.tsx src/components/todo/TodoRail.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/today/TodayPage.test.tsx src/components/project/ProjectOverviewPage.test.tsx src/components/activity/ActivityPage.test.tsx src/services/projectMindApi.test.ts`
  - 后端验证：`cargo test todo_update_progress_persists_changes_and_refreshes_todo_timestamp --manifest-path src-tauri/Cargo.toml`，`cargo test todo_delete_progress_removes_only_target_progress --manifest-path src-tauri/Cargo.toml`
- 2026-04-17：已完成 `3.3.2 Today Todo / 3.4 Todo 与进展` 中“Todo 支持修改所属 Activity，也可清空回项目级 Todo”。
  - 前端验证：`npm run test:unit -- src/components/todo/TodoInlineProgressEditor.test.tsx src/components/todo/TodoListItem.test.tsx src/components/todo/TodoRail.test.tsx src/components/today/TodayTodoSection.test.tsx src/components/today/TodayPage.test.tsx src/components/project/ProjectOverviewPage.test.tsx src/components/activity/ActivityPage.test.tsx src/services/projectMindApi.test.ts`
  - 后端验证：`cargo test todo_update_activity_rebinds_within_project_and_can_clear_to_project_level --manifest-path src-tauri/Cargo.toml`
- 2026-04-17：已完成 `3.5.1 结论` 中“项目页与 Activity 页的结论统一支持置顶，排序按 `isPinned DESC, createdAt DESC`，并在编辑区 / 右键菜单提供置顶切换”。
  - 前端验证：`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/activity/ActivityPage.test.tsx src/services/projectMindApi.test.ts`
  - 后端验证：`cargo test conclusion_list_orders_pinned_first_then_created_at --manifest-path src-tauri/Cargo.toml`，`cargo test project_overview_groups_prioritize_pinned_project_conclusions --manifest-path src-tauri/Cargo.toml`
- 2026-04-17：已完成 `3.2 项目 / Activity 简介` 中“Project 简介升级为富文本编辑与回显”。
  - 前端验证：`npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/services/projectMindApi.test.ts`
  - 后端验证：`cargo test project_update_summary_can_rename_project_and_refresh_updated_at --manifest-path src-tauri/Cargo.toml`，`cargo test project_update_summary_preserves_existing_rich_text_when_only_renaming --manifest-path src-tauri/Cargo.toml`，`cargo test project_rename_moves_document_paths_and_rewrites_internal_asset_refs --manifest-path src-tauri/Cargo.toml`，`cargo test project_rename_fails_when_target_folder_already_exists_without_mutating_state --manifest-path src-tauri/Cargo.toml`
- 2026-04-17：已完成 `3.2 项目 / Activity 简介` 中“Activity 新增独立富文本简介，并与 AI 概览保持分离”。
  - 前端验证：`npm run test:unit -- src/components/activity/ActivityPage.test.tsx`
  - 后端验证：`cargo test activity_update_meta_persists_brief_and_preserves_it_on_title_changes --manifest-path src-tauri/Cargo.toml`，`cargo test activity_rename_moves_folder_and_document_paths --manifest-path src-tauri/Cargo.toml`，`cargo test activity_rename_fails_when_target_folder_already_exists_without_mutating_state --manifest-path src-tauri/Cargo.toml`
- 2026-04-17：已完成 `3.3 Today 工作台` 中“Today 固定单例快记”，并补齐 Today 四区布局。
  - 前端验证：`npm run test:unit -- src/components/today/TodayQuickNotePanel.test.tsx src/components/today/TodayPage.test.tsx src/services/projectMindApi.test.ts`
  - 后端验证：`cargo test today_quick_note_is_singleton_and_stays_out_of_workspace_notes --manifest-path src-tauri/Cargo.toml`，`cargo test workspace_notes_round_trip_create_update_delete_and_sort --manifest-path src-tauri/Cargo.toml`

### 需求状态总表

说明：

- `当前状态` 分为 `已完成` / `部分完成` / `未开始`。
- `建议批次` 中的 `下一轮` 是基于当前依赖关系和实现连续性给出的建议优先级，不代表锁死排期。

| 统计维度 | 数量 |
| --- | ---: |
| 总需求条目数 | 28 |
| 已完成 | 27 |
| 部分完成 | 0 |
| 未开始 | 1 |
| 建议下一轮优先处理 | 0 |
| 建议放到后续轮次 | 1 |

| 编号 | 需求摘要 | 当前状态 | 说明 | 建议批次 | 人工验证 |
| --- | --- | --- | --- | --- | --- |
| `3.1-01` | 记录标题保持独立单行输入框 | 已完成 | 当前代码已具备该基础能力。 | 已完成 | 完成 |
| `3.1-02` | 记录标题输入框按 `Tab / Enter` 跳转正文 | 已完成 | 已补齐键盘行为与测试。 | 已完成 | 完成 |
| `3.1-03` | 当前 `Activity` 无记录时，空态直接新建默认记录并进入编辑 | 已完成 | 已补齐记录空态、Todo 空态、结论空态的点击直达新建链路，并补测试。 | 已完成 | 通过 |
| `3.1-04` | 记录全页编辑模式，重做为独立“记录专注页” | 已完成 | 已放弃 Activity 内覆盖层方案，改为独立路由的记录专注页：保留应用顶栏，正文单列居中，页面空白点击不退出，取消显式保存按钮，改为自动保存状态提示；并通过共享会话缓存打通 Activity 行内编辑与专注页之间的未保存内容延续。 | 已完成 | 通过 |
| `3.1-05` | 记录编辑器支持选区级 `AI 润色 / AI 修改`，无选区时禁用 | 未开始 | 现有 AI 能力还未下沉到选区级编辑交互。 | 后续轮次 |  |
| `3.1-06 / 3.7-02` | 按项目记忆最近访问页面，且仅在当前会话内生效 | 已完成 | 已实现项目页签切回恢复最近总览 / Activity / `focus` 锚点，并在切换 workspace 时清空。 | 已完成 | 通过 |
| `3.2-01` | Project 简介升级为富文本编辑与回显 | 已完成 | 已按第二轮反馈收敛为单框点击即编：移除显式“编辑简介”按钮、移除额外编辑壳层与可见工具栏，保留原有富文本存储链路、失焦保存与快捷键提交。 | 已完成 | 通过 |
| `3.2-02` | Activity 新增独立富文本简介，并与 AI 概览保持分离 | 已完成 | 已按第二轮反馈收敛为与 Project 简介一致的单框点击即编样式：无显式“编辑简介”按钮、无嵌套编辑框、无可见工具栏，并继续与 AI 概览分开展示。 | 已完成 | 通过 |
| `3.2-03` | 项目标题旁展示项目状态标签 | 已完成 | 已将项目状态改成可直接修改的标签下拉，而不再只是只读展示。 | 已完成 | 通过 |
| `3.3-01` | Today 页面始终可访问，且不受 `daily brief` 开关影响 | 已完成 | `/today` 路由、顶部入口与页面显示逻辑已覆盖该要求；`daily brief` 开关仅影响 AI 卡片，不影响 Today 页面整体存在。 | 已完成 | 通过 |
| `3.3-02` | Today 作为综合页包含固定快记、Today Todo、workspace notes、AI 今日概览 4 个区域 | 已完成 | 已补齐固定单例快记区域，Today 现已具备 4 个独立区域。 | 已完成 | 通过 |
| `3.3.1-01` | Today 固定单例快记（单例、始终编辑、不替代 workspace notes） | 已完成 | 已按反馈简化 Today 顶部与快记区样式：移除多余标题、说明、日期和外层圆角包裹，保留固定单例编辑体验。 | 已完成 | 通过 |
| `3.3.2-01` | Today Todo 支持直接新增，创建时必须选择项目、可选绑定 Activity | 已完成 | 已按第二轮反馈将新建入口改为项目卡片右上角 `+` 图标按钮，创建表单只保留内容 / 优先级 / 保存 / 收起，不再在创建阶段选择 Activity，默认直接创建为项目级 Todo。 | 已完成 | 通过 |
| `3.3.2-02` | Today Todo 支持从项目级 / Activity 级条目跳转到对应页面 | 已完成 | 现有跳转逻辑已覆盖项目级与 Activity 级 Todo，并补上项目标题点击直达项目页。 | 已完成 | 通过 |
| `3.3.2-03 / 3.4-04` | Todo 支持修改所属 Activity，也可清空为项目级 | 已完成 | 已补齐同项目内改绑 / 清空为项目级的接口，并收口为活动名后箭头直接弹出下拉菜单、选择后立即切换，无需额外进入编辑态。 | 已完成 | 通过 |
| `3.3.3-01` | `AI 今日概览` 仅在 AI 开启时显示，且不影响 Today 页面整体存在 | 已完成 | Today 页与 AI 卡片显示逻辑已通过测试覆盖。 | 已完成 | 通过 |
| `3.4-01` | Todo 删除不再弹确认框 | 已完成 | 已移除确认框，保留右键删除入口。 | 已完成 | 通过 |
| `3.4-02` | Todo 进展支持右键修改 / 删除，覆盖最新与历史进展 | 已完成 | 已补齐最新进展与历史进展的右键编辑 / 删除交互、接口与测试。 | 已完成 | 通过 |
| `3.4-03` | 进展新增与修改都遵循“空内容不新增 / 不保存” | 已完成 | 已补齐保存规则与测试。 | 已完成 | 通过 |
| `3.5.1-01` | 结论支持置顶，包含字段、排序、编辑区按钮，以及 Project / Activity 两端统一行为 | 已完成 | 已保留右键菜单置顶能力，并按反馈移除编辑区显式置顶按钮与正文上方显眼标记，改为展示态右上角的轻量提示。 | 已完成 | 通过 |
| `3.5.1-02` | Activity 级结论默认提升到项目层；Project 级默认不提升 | 已完成 | Activity 默认值已补齐，Project 级默认 false 维持现状。 | 已完成 | 通过 |
| `3.5.2-01` | 文件默认标星规则：Activity 级 `true`，Project 级 `false` | 已完成 | 两端默认值都已明确落地。 | 已完成 | 通过 |
| `3.5.2-02` | Activity 页面新增“项目级标星文件”区，默认折叠且不与活动文件混排 | 已完成 | 已按第二轮反馈改成真正的单卡片结构，并进一步收口为“项目文件”折叠区：仅在当前项目存在项目级标星文件时显示，默认收起，不与活动文件主列表混排。 | 已完成 | 通过 |
| `3.6.1-01` | `记录 / 结论 / Todo / 文件` 支持 `[[...]]` 内部引用的触发、插入、保存与跳转 | 已完成 | 已补齐统一引用选择器、稳定对象标识、RichEditor 内联引用节点、Todo 正文 / 进展 token 渲染与点击跳转；记录跳到专注页，结论 / Todo / 文件复用现有项目路由与 `focus` 锚点。 | 已完成 | 通过 |
| `3.6.2-01` | 空内容编辑器可直接粘贴图片，并尽量保留原始清晰度 | 已完成 | 已按第二轮反馈继续补强空白新记录的正文聚焦与粘贴兜底：新建草稿后增加正文 focus request、编辑器 `autofocus` 重试，以及空白文档剪贴板图片导入的选择光标兜底；同时保持原始 mime type / `HEIC, HEIF` 后缀保真。 | 已完成 | 通过 |
| `3.6.3-01` | 富文本复制到纯文本时保留列表编号与基础结构，避免多余空符号 | 已完成 | 已为编辑器复制链路补齐结构化纯文本序列化，保留有序列表编号、嵌套列表缩进与基础换行。 | 已完成 | 通过 |
| `3.7-01` | Activity 左侧边栏新增“新建 Activity”入口，展开态与收起态都可触达 | 已完成 | 已在两种侧边栏形态下接入创建入口。 | 已完成 | 通过 |
| `3.7-03` | 项目内切换 / 从 Today 跳转 / 从搜索跳转时刷新最近访问页面记忆 | 已完成 | 已由统一路由记忆机制覆盖。 | 已完成 | 通过 |

当前代码已经具备以下基础能力：

- Today 综合页框架
- 记录独立标题输入框
- workspace notes 列表能力
- 富文本编辑器剪贴板图片导入基础链路

因此，本轮需求不是从零设计，而是在现有实现基础上补齐交互细节、默认规则、数据结构和页面组织方式，形成更完整的“记录 - 沉淀 - 跳转 - 回看”工作流。

## 2. 本轮目标

本轮改动聚焦 5 条主线：

- `记录编辑体验升级`
- `项目 / Activity 简介富文本化`
- `Today 工作台增强`
- `Todo / 进展可维护性`
- `结论 / 文件 / 内部引用规则统一`

目标是在现有 `Project / Activity / Note / Conclusion / Todo / Document` 架构上，统一编辑体验、跳转行为和默认规则，减少重复操作，提升记录与沉淀效率。

## 3. 需求范围

### 3.1 记录与编辑器

- 记录保留独立标题输入框，位于正文上方，仅单行展示。
- 在记录标题输入框中：
  - 按 `Tab` 时，焦点直接跳到正文编辑区，不换行。
  - 按 `Enter` 时，焦点直接跳到正文编辑区，不换行。
- 当当前 `Activity` 下没有记录时，点击空态提示文案区域，按默认记录类型直接新建记录并进入编辑。
- 记录支持“全页编辑模式”，只覆盖记录编辑器，不扩展到项目简介、Activity 简介、结论、Today 快记。
- 全页编辑模式下：
  - 编辑器填满主内容区。
  - 顶部工具栏固定。
  - 页面内容区独立滚动。
  - 记录编辑区支持水平拖拽调宽。
  - 宽度偏好长期记忆，重启应用后继续沿用上次设置。
- 记录编辑器支持选区级 AI 能力，首版支持：
  - `AI 润色`
  - `AI 修改`
- 选区级 AI 只在用户已选中文本时可执行；无选区时入口禁用。
- 项目切换行为改为“按项目记忆最近访问页面”，范围包括：
  - 项目总览
  - 具体 Activity
  - `note / todo / conclusion / document` 的 focus 锚点
- 页面记忆仅在当前应用会话内有效，不要求跨重启恢复。

### 3.2 项目 / Activity 简介

- Project 简介从纯文本升级为富文本，使用统一 RichEditor 能力进行编辑和回显。
- Activity 新增独立“简介 / 概览”富文本区域，用于记录活动背景、当前状态与上下文，不复用记录正文。
- Activity 的 AI 概览与 Activity 简介是两套独立能力：
  - AI 概览用于自动总结
  - Activity 简介用于人工维护的结构化信息
- 项目标题旁新增项目状态标签，展示并支持切换当前已有 `status` 值。
- 本期不扩展状态配置体系，但允许在标题区直接切换已有状态。

### 3.3 Today 工作台

- Today 页面始终可访问，不依赖 AI `daily brief` 开关决定是否存在。
- Today 页面统一作为工作区综合页，包含 4 个区域：
  - `固定单例快记`
  - `Today Todo`
  - `workspace notes 列表`
  - `AI 今日概览`

#### 3.3.1 Today 固定单例快记

- Today 页面新增固定单例快记能力，命名为 `Today Quick Note` 或等价实体。
- 该快记在 Today 中固定只有一份。
- 快记区域始终处于编辑状态。
- 快记内容滚动更新，不通过该入口新建多条文件。
- 单例快记是新增能力，不替代现有 workspace notes 列表能力。

#### 3.3.2 Today Todo

- Today Todo 继续展示整个工作区的全局待办。
- Today Todo 支持直接新增 Todo。
- 在 Today 中新增 Todo 时：
  - 必须从某个项目卡片下发起。
  - 创建阶段不再单独选择 Activity，默认直接创建为项目级 Todo。
- Today Todo 中：
  - 项目级 Todo 可点击项目入口，跳转至对应项目总览。
  - Activity 级 Todo 可点击跳转至对应 Activity。
  - Todo 支持通过活动来源菜单修改所属 Activity，也可清空回项目级。

#### 3.3.3 AI 今日概览

- `AI 今日概览` 仅在 AI 功能开启时显示。
- AI 今日概览是否显示，不影响 Today 页面整体存在。

### 3.4 Todo 与进展

- Todo 删除保留右键入口，但删除时不再弹确认框，执行即删。
- Todo 进展支持右键菜单操作，覆盖：
  - 最新进展修改 / 删除
  - 历史进展修改 / 删除
- 进展新增与进展修改使用同一保存规则：
  - 内容为空时不新增
  - 内容为空时不保存
- Todo 当前展示的关联 Activity 支持点击后重新选择归属：
  - 可改绑到同项目下其他 Activity
  - 可清空为项目级 Todo

### 3.5 结论与文件

- 现有“提升到项目层 / promotedToProject”与本次新增“置顶”属于两套不同能力，文档与实现中必须明确区分。

#### 3.5.1 结论

- 项目页与 Activity 页中的结论统一支持“置顶”。
- 结论新增 `isPinned` 能力。
- 结论列表排序统一为：
  - `isPinned DESC`
  - `createdAt DESC`
- 结论当前支持通过右键菜单切换置顶，并在展示态提供轻量置顶提示。
- Activity 级新增结论默认开启“提升到项目层 / 项目级标星”。
- Project 级新增结论默认不提升到项目层。
- “活动级结论默认标星”在本产品语义中继续映射为“默认提升到项目层 / 项目级标星”。

#### 3.5.2 文件

- Activity 级导入文件默认 `isStarred = true`。
- Project 级导入文件默认 `isStarred = false`。
- Activity 页面新增“项目级标星文件”展示区：
  - 默认收起折叠
  - 用于展示当前项目下已标星的项目级文件
- Activity 自身文件区仍只展示活动级文件，不与项目级标星文件混在同一列表中。

### 3.6 内部引用、粘贴与复制

#### 3.6.1 内部引用

- `记录 / 结论 / Todo / 文件` 统一支持内部引用。
- 输入 `[[` 后唤起统一引用选择器。
- 选择对象后插入内部引用。
- 内部引用必须保存稳定对象标识。
- 引用渲染为可点击跳转的内部链接。
- 点击引用后，沿用现有项目路由和 `focus` 锚点跳转机制。
- 内部引用覆盖 `记录 / 结论 / Todo / 文件`。

#### 3.6.2 粘贴图片

- 空内容编辑器可直接粘贴图片，不需要先输入任意字符。
- 剪贴板图片导入后应尽量保留原始清晰度，避免明显降质。

#### 3.6.3 复制到纯文本

- 从富文本复制到纯文本编辑器时：
  - 不应出现多余空符号
  - 应正确保留有序列表编号
  - 应尽量保留纯文本结构可读性

### 3.7 侧边导航

- Activity 左侧边栏增加“新建 Activity”入口。
- 展开态与收起态都必须可触达。
- 以下行为都需要刷新该项目在当前会话中的最近访问页面记忆：
  - 项目内切换 Activity
  - 从 Today 跳转
  - 从搜索结果跳转

## 4. 公共接口 / 类型 / 数据结构变化

### 4.1 Project

- Project 简介升级为富文本字段，新增富文本存储能力，例如：
  - `summaryMarkdown`
  - `summaryHtml`
- 同时保留可用于搜索、摘要和列表展示的纯文本提取结果。

### 4.2 Activity

- Activity 新增独立富文本简介字段，例如：
  - `overviewMarkdown`
  - `overviewHtml`

### 4.3 Conclusion

- `Conclusion` 新增 `isPinned`。
- 项目页与 Activity 页查询排序改为：
  - `isPinned DESC`
  - `createdAt DESC`

### 4.4 TodoProgress

- 新增 Todo 进展更新接口。
- 新增 Todo 进展删除接口。

### 4.5 Todo

- 新增修改 `activityId` 的接口。
- 接口需要支持：
  - 重新绑定到其他 Activity
  - 清空为项目级 Todo

### 4.6 Today Quick Note

- 新增 Today 单例快记实体与对应读写接口。
- Today 单例快记与现有 workspace notes 列表并存，不替代旧列表能力。

### 4.7 RichEditor

- 新增选区级 AI 处理接口，输入包含：
  - `selectedText`
  - `actionType`
  - `optionalContext`
- 新增内部引用节点 / 序列化格式，统一采用 `[[...]]` 触发插入。

### 4.8 本地偏好设置

- 新增记录编辑区宽度的本地持久化存储，用于保存用户拖拽后的宽度偏好。

## 5. 规则与默认值

- 记录编辑区宽度支持拖拽调宽。
- 宽度偏好长期记忆，跨应用重启保留。
- 全页编辑模式首期只覆盖记录编辑器。
- 项目最近访问位置只在当前应用会话内记忆，不要求跨重启恢复。
- Today 单例快记与现有 workspace notes 列表并存。
- AI 能力首版按选区级实现。
- Activity 的 AI 概览与 Activity 简介是两套独立能力。
- “活动级结论默认标星”继续映射为“默认提升到项目层 / 项目级标星”。

## 6. 验收口径

- 记录标题在 `Tab / Enter` 下都直接跳转正文，且标题不换行。
- 当前 Activity 无记录时，点击空态提示文案可直接创建默认记录。
- 记录支持全页编辑模式，工具栏固定，页面内容区滚动正常。
- 记录页宽度支持拖拽调宽，设置后重启应用仍保留。
- 项目切换后再切回，可恢复本会话上次停留的项目总览 / Activity / 锚点。
- Project 与 Activity 简介都支持富文本编辑、保存与回显。
- Today 页面同时包含：
  - 固定单例快记
  - Today Todo
  - workspace notes 列表
  - AI 今日概览
- Today 固定单例快记始终可编辑，且始终只有一份。
- Today Todo 支持直接新增；项目级 Todo 可跳项目；Activity 级 Todo 可跳 Activity。
- Todo 删除不弹确认框。
- Todo 进展支持修改 / 删除；空进展不会新增或保存。
- Todo 支持修改所属 Activity，也可改回项目级。
- 结论支持置顶，排序遵守“置顶优先 + 创建时间倒序”。
- Activity 级结论 / 文件默认标星规则正确。
- Activity 页面默认折叠展示项目级标星文件。
- `[[` 可插入、保存并跳转 `记录 / 结论 / Todo / 文件` 内部引用。
- 空编辑器可直接粘贴图片。
- 粘贴图片后的清晰度符合预期，不出现明显降质。
- 从富文本复制到纯文本时，不出现多余空符号，并保留列表编号与基本结构。

## 7. 实施说明

- 本文档描述的是基于现有代码形态的增量需求。
- 实现时应优先复用当前已有：
  - Today 综合页结构
  - workspace notes 列表能力
  - RichEditor 现有富文本与图片处理能力
  - note / todo / conclusion / document 的 focus 跳转机制
- 不应因为引入 Today 单例快记而删除已有 workspace notes 列表能力，除非后续另有独立产品决策文档明确要求替换。

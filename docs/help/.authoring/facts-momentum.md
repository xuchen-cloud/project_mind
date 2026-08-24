# 推进旅程共享事实表
- 产品基线：`9b359e83e76bf35bee7d46a9a97659af3916f784`
- 复核日期：2026-08-21
- 演示案例：虚构的“智能客服知识库升级”Workspace，以及其中同名 Project
- 适用文章：`momentum/record-or-todo.md`、`momentum/todo-scope.md`、`momentum/project-files.md`
- 术语来源：`CONTEXT.md`

本表只把锁定基线中可见、可到达的产品行为写成对外事实。实现代码用于解释已经由界面或测试证明的行为；只有底层命令、没有可见入口的能力不进入帮助正文。

## Record、Todo 与 QuickNote

| 事实 | 对外写法 | 证据 |
| --- | --- | --- |
| Record 用于保留已经判断值得独立查找和引用的信息；Todo 用于跟踪需要完成的明确行动。 | 用“保留判断 / 跟踪行动”做选择。同一段内容可以拆成一条 Record 和一条 Todo。 | `CONTEXT.md` 的 Record、Todo 定义。 |
| Workspace 与 Project 都有各自的 QuickNote、Record 和 Todo 作用域。 | 内容依赖某个阶段性结果时，在对应 Project 中创建 Project Record 或 Project Todo；否则使用 Workspace 对象。 | `CONTEXT.md`；基线 `src/components/today/WorkspacePage.tsx`、`src/components/project/ProjectOverviewPage.tsx`。 |
| QuickNote 的选区菜单可见操作是“移动到记录”；可以创建 Record 或追加到已有 Record，成功后会从 QuickNote 移除选区。 | 不暗示 QuickNote 能一键转 Todo。明确行动需要在右侧 `Todo List` 中另行创建。 | 基线 `src/components/project/ProjectOverviewPage.tsx:468-531,740-754`、`src/components/today/WorkspacePage.tsx:249-310,626-640`、`src/components/record/MoveSelectionToRecordCard.tsx`；`src/components/rich-editor/RichEditor.test.tsx` 的“移动到记录”菜单测试。 |
| Workspace 或 Project 的 Record 入口会在当前作用域创建对应 Record。 | Workspace 中创建 Workspace Record；“智能客服知识库升级”Project 中创建该 Project 的 Project Record。 | 基线 `src/components/today/WorkspacePage.tsx`、`src/components/project/ProjectOverviewPage.tsx`；Project 左侧栏有“记录”和“新增记录”：`src/components/layout/ProjectSidebar.tsx:860-910`。 |

## Todo 的可达操作、归属与 View

| 事实 | 对外写法 | 证据 |
| --- | --- | --- |
| Todo 位于右侧 `Todo List`，可在未完成和已完成之间查看，并可创建、编辑、完成、设优先级、补充进展、管理 Tag 和删除。 | 本组三篇只写创建与归属；推进细节链接到 `progress.md`。 | 基线 `src/components/todo/TodoRail.tsx`、`src/todo/TodoModuleRail.tsx`；`src/components/todo/TodoRail.test.tsx`。 |
| Workspace 页面始终打开 Workspace View，不显示 Current Project View 切换。 | 在 Workspace 页面看到的是 Workspace View。 | 基线 `src/components/today/WorkspacePage.tsx:733-740`；`src/components/today/WorkspacePage.test.tsx:241-261`。 |
| Project 页面可在 Workspace View 与 Current Project View 之间切换。切换按钮位于 `Todo List` 标题栏。 | 切换 View 只改变当前显示集合，不改变任何 Todo 的归属。 | 基线 `src/components/project/ProjectOverviewPage.tsx:927-938`、`src/components/todo/TodoRail.tsx:625-650`；`src/components/todo/TodoRail.test.tsx:271-288`、`src/components/project/ProjectOverviewPage.test.tsx:280-292`。 |
| Workspace View 包含 Workspace Todo 和未进入 Archive 的 Project 所拥有的 Project Todo；不包含已 Archive Project 的 Project Todo。 | Workspace View 是聚合视图，不等于“只看 Workspace Todo”。 | 基线 `src/todo/todo-module.ts:134-162`；`src/todo/todo-module.test.ts:104-151`。 |
| Current Project View 只包含当前 Project 的 Project Todo。 | 不包含 Workspace Todo 或其他 Project 的 Project Todo。 | 基线 `src/todo/todo-module.ts:164-175`；`src/todo/todo-module.test.ts:104-151`。 |
| 在 Current Project View 创建 Todo 时，归属固定为当前 Project，创建器不显示“Todo 归属”。 | 这是创建当前 Project Todo 的最直接路径。 | 基线 `src/todo/TodoModuleRail.tsx:51-71`；`src/todo/TodoModuleRail.test.tsx:33-57`。 |
| 在 Workspace View 创建 Todo 时，默认归属为 Workspace；创建器显示“Todo 归属”，可显式选择一个未进入 Archive 的 Project。 | 不选择 Project 会创建 Workspace Todo；选择“智能客服知识库升级”才会创建该 Project 的 Project Todo。 | 基线 `src/todo/TodoModuleRail.tsx:47-71`、`src/components/todo/TodoRail.tsx:890-958`；`src/components/todo/TodoRail.test.tsx:225-269`、`src/components/today/WorkspacePage.test.tsx:319-341`。 |
| Workspace View 的可选 Project 来源会过滤已 Archive Project。 | 已 Archive Project 不会出现在“Todo 归属”的可选 Project 中。 | 基线 `src/todo/todo-module.ts:134-139`、`src/todo/TodoModuleRail.tsx:47-50`；`src/todo/todo-module.test.ts:104-151`。 |
| 同一 Project Todo 会同时投影到 Workspace View 和所属 Project 的 Current Project View。 | 从另一个 View 看到或编辑它，不会复制、移动或改归属。 | 基线 `src/todo/todo-module.test.ts:154-217,269-320`。 |
| Todo 中的 `#Tag` 按最终归属解析。Workspace Todo 使用 Workspace Tag；Project Todo 使用所属 Project 的 Project Tag。 | 先确认归属，再输入或选择 Tag。 | `CONTEXT.md`；基线 `src/todo/todo-module.ts:179-225`、`src/todo/todo-module.test.ts:218-267`、`src/components/todo/TodoRail.test.tsx:309-378`。 |

## Project File

| 事实 | 对外写法 | 证据 |
| --- | --- | --- |
| File 只归属于一个 Project。当前公开入口是 Project 左侧栏的“文件”页签。 | 先打开“智能客服知识库升级”Project，再从左侧栏进入“文件”。不要称 File 为“附件”或 Document。 | `CONTEXT.md`；基线 `src/components/layout/ProjectSidebar.tsx:860-924`；`src/components/layout/ProjectSidebar.test.tsx:310-327`。 |
| “文件”页签可通过“导入文件”选择一个或多个本地文件，也可把本地文件拖到 Project 左侧栏，界面会自动切到“文件”。 | 主步骤使用“导入文件”；拖放作为同一入口的替代操作。 | 基线 `src/components/layout/ProjectSidebar.tsx:360-423,900-924`；`src/components/layout/ProjectSidebar.test.tsx:156-225`。 |
| 若当前 Project 已有 Project Tag，导入会打开“选择导入标签”，所选 Tag 一次应用到本批全部 File；也可以不选。没有可用 Project Tag 时直接导入。新导入 File 默认不标星。 | 批量导入前确认这批 File 是否应共享同一组 Project Tag。 | 基线 `src/components/document/DocumentImportTagDialog.tsx`、`src/hooks/useDocumentImportFlow.ts:43-119`；`src/components/document/ManagedDocumentSection.test.tsx:288-319,529-562`。 |
| Project 左侧栏的搜索框文案为“搜索文件或标签”，实际匹配 File 名称和 Project Tag 文本；下方 Tag 筛选只作用于当前 Project。 | 已知名称时搜索；只记得分类时点击 Project Tag。 | 基线 `src/components/layout/ProjectSidebar.tsx:232-245,885-952`；`src/components/layout/ProjectSidebar.test.tsx:329-375`。 |
| File 的右键菜单提供“标星/取消标星”，标星 File 排在未标星 File 前面。 | 对需要反复打开的少数 File 标星。 | 基线 `src/components/layout/ProjectSidebar.tsx:215-228,1192-1203`；`src/components/document/ManagedDocumentSection.test.tsx:160-188,350-372`。 |
| 点击正常 File 会打开其当前受管内容；右键“打开文件所在位置”会在系统文件管理器中定位当前 File。 | “打开文件所在位置”是当前可见的定位入口，不表述为改变 File 归属或重新链接路径。 | 基线 `src/components/layout/ProjectSidebar.tsx:422-454,1134-1144`；`src/components/document/ManagedDocumentSection.test.tsx:190-205,409-450`。 |
| File 缺失时显示“失效”。点击会提示“当前文件路径已失效，请重新导入该文件”；“打开文件所在位置”“重命名”“复制为新版本并打开”不可用。 | 当前基线没有可见的“重新定位/修复此 File”入口。需要继续使用材料时，以不同文件名重新导入为新的 File；旧条目不会自动修复。 | 基线 `src/components/layout/ProjectSidebar.tsx:424-430,1090-1096,1134-1168`、`src/components/document/ManagedDocumentSection.tsx:316-324,780-811`；`src/components/document/ManagedDocumentSection.test.tsx:493-526`。 |
| 实现中存在 `document_relocate` 命令和 mutation，但在锁定基线的可见 Project File 菜单与页面中没有调用入口。 | 不把“重新定位”写成现有功能。 | 基线 `src/hooks/useDocumentMutations.ts:41-64`、`src/services/projectMindApi.ts:196-199`；对 `src/**/*.tsx` 的调用检索没有结果。 |
| 右键“复制为新版本并打开”会复制当前 File 内容，创建并打开下一版；它不是选择另一份本地文件替换当前版。 | 需要在当前内容上继续修改时使用。 | 基线 `src/components/layout/ProjectSidebar.tsx:456-470,1154-1168`；`src/components/document/ManagedDocumentSection.test.tsx:452-479`；`src-tauri/src/db.rs:2983-3129,15550-15595`。 |
| File 有多个版本后会显示 `vN`；点击版本号打开版本列表，选择旧版本只会打开该版本，不会把它恢复为当前版本。 | 用版本列表查阅历史依据，不承诺“回滚”或“恢复”。 | 基线 `src/components/document/DocumentSharedComponents.tsx:220-304`；`src/components/document/ManagedDocumentSection.test.tsx:132-160`。 |
| 普通 File 导入会把材料纳入 Project 的受管位置：Project 外来源会复制；已经位于 Project 内但不在目标位置的来源可能被移动。 | 文章只承诺“导入后由 Project 持续管理”，不承诺导入永远不移动来源。 | 基线 `src-tauri/src/db.rs:2498-2577,8819-8860`；`src-tauri/src/db.rs:13971-14015`。 |

## 不进入本组三篇的能力

- 不写 QuickNote 一键转 Todo；基线没有该入口。
- 不把 Workspace View 写成 Workspace Todo 的同义词。
- 不写已 Archive Project 的 Project Todo 会出现在 Workspace View。
- 不写 File 可跨 Project，或把 File 称为“附件”“Document”。
- 不写缺失 File 可以通过“重新定位”修复；该命令没有可见入口。
- 不把打开旧 File Version 写成回滚、恢复或改变当前版本。
- 不展开 File 重命名和删除等低频菜单；缺失场景如需移除旧条目，转到排障文说明即时删除风险。

## 本轮验证

在与产品基线相同的 `src/` 上运行：

```text
npm run test:unit -- src/todo/todo-module.test.ts \
  src/components/todo/TodoRail.test.tsx \
  src/components/today/WorkspacePage.test.tsx \
  src/components/project/ProjectOverviewPage.test.tsx \
  src/components/layout/ProjectSidebar.test.tsx \
  src/components/document/ManagedDocumentSection.test.tsx
```

结果：6 个测试文件、101 项测试全部通过。

# “接住、沉淀与找回信息”事实表

- 产品基线：`9b359e83e76bf35bee7d46a9a97659af3916f784`
- 复核日期：2026-08-21
- 演示案例：虚构的“智能客服知识库升级” Workspace
- 公开文章：`capture/quicknote.md`、`capture/record.md`、`context/search.md`

本文先记录事实，再据此写公开帮助文章。证据行号均对应锁定基线。

## QuickNote

| 已核验事实 | 证据 | 写作结论 |
| --- | --- | --- |
| Workspace 页面在主区域提供“QuickNote / Record”切换；QuickNote 是无标题编辑区。 | `src/components/today/WorkspacePage.tsx:563-670` | 入口写成“打开 Workspace，选择 QuickNote”，不写成 Daily Note。 |
| Workspace QuickNote 读取最近一条特定类型数据；再次保存会更新同一条，首次保存才创建。数据库测试确认两次 upsert 的 id 相同，而且它不进入 Workspace Record 列表。 | `src-tauri/src/db.rs:2037-2114`；`src-tauri/src/db.rs:16569-16611` | 明确为 Workspace 中唯一、持续可改的缓冲区，不暗示每天新建。 |
| 每个 Project 的 QuickNote 直接保存在该 Project 的字段中，保存时更新当前 Project。 | `src/components/project/ProjectOverviewPage.tsx:236-258,390-405` | 每个 Project 各有一个 Project QuickNote；它只适合已明确属于该 Project 的临时内容。 |
| Workspace 与 Project QuickNote 都配置约 120 秒延迟自动保存，并在编辑器失焦、窗口失焦或页面隐藏时触发保存。Workspace 保存后显示“工作区 QuickNote 已保存”；Project 保存后显示项目信息已同步。 | `src/components/today/WorkspacePage.tsx:648-669`；`src/components/project/ProjectOverviewPage.tsx:757-765`；`src/hooks/useWorkspaceQuickNoteMutations.ts:11-20`；`src/hooks/useProjectMutations.ts:42-50` | 不承诺逐字实时保存；提示用户离开前观察保存反馈。 |
| QuickNote 的显式选区动作是“移动到记录”；成功后先创建或追加 Record，再从 QuickNote 删除选区并保存。 | `src/components/today/WorkspacePage.tsx:250-311,633-642`；`src/components/project/ProjectOverviewPage.tsx:468-533,747-756` | P0 只说明何时应沉淀；不展开 P1 的移动操作，也不声称可一键转 Todo。 |

## Record

| 已核验事实 | 证据 | 写作结论 |
| --- | --- | --- |
| Record 分 Workspace Record 与 Project Record。创建调用分别为 `workspaceRecordUpsert` 和带 `projectId` 的 `projectRecordUpsert`。 | `src/components/today/WorkspacePage.tsx:378-387`；`src/components/project/ProjectOverviewPage.tsx:408-427`；`CONTEXT.md`“信息沉淀” | 创建前先选择归属；Workspace Record 不属于任何 Project，Project Record 只属于当前 Project。 |
| Workspace 和 Project 左侧栏的“记录”区域都有“新增记录”按钮；按钮会先创建空 Record，再直接打开独立专注页。相关 UI 测试覆盖两条路径。 | `src/components/today/WorkspaceOverviewSidebar.tsx:293-315`；`src/components/layout/ProjectSidebar.tsx:824-855`；`src/components/today/WorkspacePage.test.tsx:993-1011`；`src/App.test.tsx:804-900` | P0 采用同一条最短创建路径，不依赖隐藏的 compose URL。 |
| Record 浏览卡片可原地编辑；标题失焦、Tag 变化、点击卡片外、`Cmd/Ctrl+Enter` 退出编辑时保存。 | `src/components/record/RecordListItem.tsx:185-205,239-273,404-438` | 说明保存是自动触发的，并以“已保存”反馈为准。 |
| 卡片标题栏的“打开专注页”按钮与双击卡片可进入专注页；侧栏中双击 Record 也可进入专注页。 | `src/components/record/RecordListItem.tsx:300-339,444-462`；`src/components/layout/ProjectSidebar.tsx:923-945`；`src/App.test.tsx:902-1004` | 专注页用于处理较长内容；单击侧栏条目仍停留在 Record 浏览视图。 |
| Workspace 与 Project Record 专注页均支持标题、Tag、正文编辑，约 120 秒延迟自动保存，并显示“保存中 / 已保存 / 保存失败”；返回或切换目标前会先请求保存。 | `src/components/today/WorkspaceRecordFocusPage.tsx:174-261,530-613`；`src/components/project/ProjectNoteFocusPage.tsx:166-322,429-543` | 建议看到“已保存”后再离开；不虚构单独的“保存”按钮。 |
| Record 浏览卡片的右键菜单有“删除”，选择后直接调用删除；Project 侧栏右键也有删除。当前 Record 删除流程没有二次确认或撤销入口。 | `src/components/today/WorkspaceOverviewHistory.tsx:286-303`；`src/components/project/ProjectOverviewPage.tsx:903-920`；`src/components/layout/ProjectSidebar.tsx:1099-1122`；`src-tauri/src/db.rs:2116-2131` | 把删除写成高风险动作：先确认对象与归属；专注页本身不提供删除入口。 |

## 三层搜索

| 层级 | 实际入口与范围 | 证据 | 写作结论 |
| --- | --- | --- | --- |
| 1. 当前正文 | 在 RichEditor 内按 `Cmd+F` 或 `Ctrl+F` 打开“文本搜索”。只匹配当前编辑器的文本节点，不含 Record 标题、Tag 或其他对象；可显示数量并逐个前后跳转。 | `src/components/rich-editor/RichEditor.tsx:1367-1372,1656-1801,4370-4464`；`src/components/rich-editor/editorSearch.ts:13-32` | 已知内容就在当前 QuickNote/Record 时先用这一层。 |
| 2. 当前侧栏 | Workspace 侧栏“记录”搜索仅筛 Workspace Record，匹配标题、正文和 Tag；Project 侧栏“记录”搜索仅筛当前 Project Record，匹配标题、正文和 Tag。两处均可再点 Tag 筛选。 | `src/components/today/WorkspacePage.tsx:202-218`；`src/components/today/WorkspaceOverviewSidebar.tsx:293-344`；`src/components/layout/ProjectSidebar.tsx:217-230,271-282,824-900` | 已知归属但不知道是哪条 Record 时使用；筛选不会改变 Record 归属。 |
| 3. Workspace 范围 | 顶栏右侧搜索在 Workspace 页签中调用 `workspace_search` 且 `projectId=null`。可见对象覆盖：Workspace QuickNote（正文、Tag）、Workspace Record（标题、正文、Tag）、Project（名称与 QuickNote 内容）、未 Archive Project 的 Project Record（标题、正文、Tag）、Workspace Todo 与未 Archive Project 的 Project Todo（正文、进展、Tag）、File（名称、版本文件名、Tag）和 Contact（姓名、拼音及资料字段）。结果按匹配强度和更新时间排序，最多 16 条；Archive Project 内容默认排除。 | `src/App.tsx:294-309,1010-1020`；`src-tauri/src/db.rs:4245-4801`；`src-tauri/src/db.rs:14491-14654,14657-14743` | 公开文章不照抄顶栏遗留的 Activity / Conclusion 占位词；用当前领域对象逐项说明覆盖字段。 |
| 顶栏的 Project 边界 | 当 Project 页签处于当前页时，顶栏请求会带当前 `projectId`；后端此时只保留当前 Project 的 Project Todo 结果，不是 Workspace 全局搜索。数据库测试覆盖此边界。 | `src/App.tsx:296-302`；`src-tauri/src/db.rs:4770-4776`；`src-tauri/src/db.rs:14785-14868` | 要做 Workspace 范围搜索，先切到顶栏“Workspace”页签，再输入关键词。 |

## 验证记录与公开边界

- 已运行相关前端测试：`WorkspacePage.test.tsx`、`ProjectOverviewPage.test.tsx`、`WorkspaceRecordFocusPage.test.tsx`、`ProjectNoteFocusPage.test.tsx`、`ProjectSidebar.records.test.tsx`、`RichEditor.test.tsx`，共 6 个文件、155 项，全部通过。
- 当前 `src/` 与锁定基线一致；`src-tauri/tauri.conf.json` 有基线后的配置差异，但不影响本文所述交互。后端搜索范围以锁定基线代码与数据库测试为准。
- 顶栏仍显示遗留的 Activity / Conclusion 搜索文案和结果类型；依 `docs/help/PLAN.md` 第 9 节，这些不作为当前用户对象写入公开文章。
- 未做真实数据截图；三篇正文均可无图执行，因此不留截图占位。

## 待核验项

- 尚未在打包后的 macOS / Windows 应用中逐项走查按键显示差异；正文只采用代码与通过测试共同支持的 `Cmd+F` / `Ctrl+F`。
- 顶栏搜索在 Project 页签中只返回当前 Project Todo，虽然已有后端测试证明，但与输入框的宽泛占位文案不一致；若产品后续修正，应优先复核 `context/search.md`。

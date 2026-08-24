# “进入与第一次成功”事实表

- 产品基线：`9b359e83e76bf35bee7d46a9a97659af3916f784`
- 复核日期：2026-08-21
- 事实优先级：可见 UI 与重复操作结果 → 同基线自动化测试 → `CONTEXT.md` → 实现代码
- 统一案例：Workspace 为虚构的“客户成功”，其中的阶段性 Project 为“智能客服知识库升级”。QuickNote 写目标与当前判断；Record 为“高频问题初步盘点”；Project Todo 为“整理退款进度类问题的标准答案”。

## 高风险事实与证据

| 事实 | 基线证据 | 写作约束 |
| --- | --- | --- |
| Workspace Gate 只有在当前没有成功打开的 Workspace 时显示；启动时会尝试重新打开上次使用的 Workspace。Gate 提供“打开已有 Workspace”“新建 Workspace”和“最近使用的 Workspace”。 | `src/App.tsx:914-957`；`src/components/workspace/WorkspaceGatePage.tsx:52-108`；`src-tauri/src/lib.rs:1061-1075` | 不把 Gate 写成主界面中随时可达的切换页。最近列表只在 Gate 可见时使用。 |
| 创建 Workspace 时可填写或选择根目录，密码不能为空；成功后在根目录下创建 `.project-mind`，其中包含元数据、数据库、AI 缓存、日志和临时目录。若元数据已存在，不能重复创建。 | `src/components/workspace/WorkspaceDialogs.tsx:23-85`；`src-tauri/src/workspace.rs:11-18, 67-113, 233-239` | 正文只承诺用户可观察的 `.project-mind` 和进入 Workspace；内部文件清单只留在事实表，不扩展成备份说明。 |
| Workspace 密码用于验证并解锁 Workspace Secrets，从而加密/解密保存的 AI API Key。打开已有 Workspace 不要求该密码，且打开后 Secrets 初始为锁定状态。普通 Workspace 数据库和内容不因该密码而整体加密。 | `src/components/workspace/WorkspaceDialogs.tsx:67-80, 105-146`；`src-tauri/src/lib.rs:179-209, 511-530`；`src-tauri/src/secret_crypto.rs:22-67`；`src-tauri/src/workspace.rs:117-166` | 必须明确“不是登录密码，也不加密整个 Workspace”。不写成整库访问控制。 |
| 进入 Workspace 后，当前主界面没有打开其他 Workspace 或返回 Gate 的入口。Workspace 标题下的根目录路径只会调用系统文件管理器打开目录。 | `src/App.tsx:914-1010`（Gate 与主界面互斥，主界面 Top Bar 无切换动作）；`src/components/today/WorkspacePage.tsx:532-548`；`src/components/layout/WorkspaceTopBar.tsx:180-310` | 不提供虚构的主界面切换步骤，也不把根目录路径说成切换入口。 |
| Workspace 页面左侧栏有“项目 / 记录”；Project 页面左侧栏有“记录 / 文件”。Workspace 与 Project 主区都可在 QuickNote 和 Record 之间切换。 | `src/components/today/WorkspaceOverviewSidebar.tsx:271-317`；`src/components/layout/ProjectSidebar.tsx:806-866`；`src/components/today/WorkspacePage.tsx:550-585`；`src/components/project/ProjectOverviewPage.tsx:626-681` | “在哪里看到”与“属于哪里”分开写；不把侧栏或 View 说成移动内容。 |
| Workspace 页面右侧固定为 Workspace View。Project 页面默认 Current Project View，可切到 Workspace View。Workspace View 汇集 Workspace Todo 与未 Archive Project 的 Project Todo；Current Project View 只含当前 Project Todo。 | `CONTEXT.md` 的 Workspace View / Current Project View；`src/components/today/WorkspacePage.test.tsx:241-252`；`src/components/project/ProjectOverviewPage.test.tsx:272-298`；`src/components/todo/TodoRail.test.tsx:172-297` | View 只改变集合，不改变 Todo 归属。Workspace View 新建 Todo 默认归属 Workspace，选择 Project 后才创建 Project Todo；Current Project View 新建即归属当前 Project。 |
| 点击“新建项目”会立即创建“未命名项目”（重名时递增编号），打开 Project 并聚焦“项目名称”供重命名；当前可见流程不使用创建表单。 | `src/components/today/WorkspacePage.tsx:434-451`；`src/hooks/useProjectMutations.ts:27-40`；`src/lib/projectDefaultName.ts:1-16`；`src/components/today/WorkspacePage.test.tsx:667-686`；`src/components/project/ProjectOverviewPage.test.tsx:400-424` | 不沿用旧草稿中的“创建项目”表单、初始 QuickNote 或状态选择步骤。 |
| Project QuickNote 在失焦、窗口失焦或可见性变化时保存。直接从 Project 左侧栏点“新增记录”会先创建空 Record 并打开专注页；编辑后页面显示“保存中… / 已保存 / 保存失败”。 | `src/components/project/ProjectOverviewPage.tsx:683-767`；`src/App.tsx:727-745, 1168-1176`；`src/components/project/ProjectNoteFocusPage.tsx:390-458`；`src/App.test.tsx:877-896` | 10 分钟闭环采用直接新建 Record；写完 QuickNote 后 Record 是独立新建，因此 QuickNote 仍保留。 |
| QuickNote 明确选区后，可见“移动到记录”，能追加到已有 Record 或新建 Record；成功后选区从 QuickNote 移除并保存。 | `src/components/project/ProjectOverviewPage.tsx:458-536, 717-728, 939-949`；`src/components/record/MoveSelectionToRecordCard.tsx:1-151` | 能力在基线可达，但属于后续独立操作文章；本组只避免把它写成复制，也不让 10 分钟闭环依赖选区操作。 |
| 顶栏 Project 页签的关闭按钮只从 `openProjectIds` 移除页签；若关闭当前页签则回到 Workspace。它不调用 Archive 或 Delete。 | `src/components/layout/WorkspaceTopBar.tsx:220-276`；`src/App.tsx:659-670`；`src/state/ui-store.ts:242-253`；`src/components/layout/WorkspaceTopBar.test.tsx:315-345` | Project 篇必须把“关闭页签”与 Archive、删除分开。 |
| 在 Workspace 项目列表右键可“归档”。Archive 是立即执行、可恢复的状态变化；归档列表提供“打开”和“恢复”，归档不删除内容。Archive Project 不再进入活跃项目列表，其 Todo 不在 Workspace View 中。 | `CONTEXT.md` 的 Archive；`src/components/today/WorkspaceOverviewSidebar.tsx:124-155, 449-589`；`src/hooks/useProjectMutations.ts:54-82`；`src/components/today/WorkspacePage.test.tsx:720-864`；`src/todo/todo-module.test.ts:104-139` | 不把 Archive 写成“完成”。提醒归档动作没有确认框；恢复从“归档项目”对话框完成。 |
| 在 Workspace 项目列表右键可“删除”，随后必须在“删除项目”对话框确认。确认后项目目录移入系统废纸篓，项目以及 Record、Todo、File 关联从当前 Workspace 移除；产品内没有恢复删除 Project 的入口。 | `src/components/today/WorkspaceOverviewSidebar.tsx:124-155, 487-528`；`src/components/today/WorkspacePage.test.tsx:500-544`；`src-tauri/src/db.rs:1480-1494, 11771-11789` | 删除前就近说明后果；不承诺从系统废纸篓还原目录就能恢复 Workspace 中的 Project。建议不确定时用 Archive。 |

## 同组文章责任

| 文章 | 只解决 | 不重复 |
| --- | --- | --- |
| `10-minute-start.md` | 用真实 UI 完成 QuickNote → 独立 Record → Project Todo → 再次找到二者 | 不展开密码、作用域规则或生命周期管理 |
| `workspace.md` | 创建、打开 Workspace，并理解密码和当前切换边界 | 不教 Project 内容组织 |
| `scopes-and-views.md` | 分清对象归属与 Todo View | 不复述完整创建步骤或 Project 生命周期 |
| `projects.md` | 创建、打开、关闭页签、Archive、恢复和删除 Project | 不展开 Record/Todo 的编辑方法 |

## 待核验项

- 无阻塞项。基线 UI 组件与相关自动化测试已经交叉核验。
- 未用桌面应用录制截图；四篇文章均按无图可执行写作，因此没有截图占位。

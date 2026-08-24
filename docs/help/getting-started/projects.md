# 创建、打开与 Archive Project

你可以为有明确结果的阶段性工作创建 Project，并随时关闭它的页签；当 Project 不再属于当前活跃工作范围、但内容仍要保留时使用 Archive。Archive 可恢复，但不表示完成。删除则会从当前 Workspace 移除 Project 及其内容关联，不能与关闭页签或 Archive 混为一谈。

## 创建并打开 Project

1. 回到顶栏“Workspace”，在左侧栏选择“项目”。项目列表和“新建项目”按钮出现。
2. 点击“新建项目”。Project Mind 会立即创建并打开“未命名项目”；如果已有同名项目，名称会带递增编号。
3. 在已聚焦的“项目名称”中输入“智能客服知识库升级”，按 `Enter`。新名称保存，Project 保持打开。

以后从 Workspace 左侧项目列表点击“智能客服知识库升级”，它会在顶栏成为打开的 Project 页签，主区和左右侧栏切到这个 Project 的上下文。

## 关闭页签不会改变 Project

点击顶栏中“智能客服知识库升级”页签右侧的关闭图标。页签消失；如果它原本是当前页签，页面回到 Workspace。

这个动作只关闭访问入口。Project 仍在 Workspace 左侧项目列表中，Record、Todo、File 和 Archive 状态都不变。再次点击项目名称即可重新打开。

## 用 Archive 移出活跃范围

当 Project 不再属于当前活跃工作范围、但内容仍要保留时，使用 Archive。它不表示 Project 已完成，也不要求 Project 之后一定恢复。

1. 在 Workspace 左侧“项目”列表中右键“智能客服知识库升级”。“项目操作”菜单出现。
2. 点击“归档”。操作会立即执行，并显示“项目已归档”；该 Project 从活跃项目列表移出。

<!-- VISUAL P0-PROJECTS-01
type: 真实 UI 状态对照
capture: 左图为活跃项目右键后的“项目操作”菜单并突出“归档”；右图为“归档项目”对话框，同一 Project 行中可见“打开”“恢复”。
purpose: 证明 Archive 的入口与恢复入口位于两个不同位置。
asset: ../assets/getting-started/archive-and-restore-project.png
alt: Project 的归档菜单与归档项目恢复对话框
text-review: 补图后复核 Archive 与恢复步骤中的菜单名、按钮名和动作是否立即执行；不要用截图方位替代按钮文字。
status: pending-user-capture
-->

Archive 不删除 Project 内容。它的 Project Todo 不再出现在 Workspace View 中，而且打开 Archive Project 时不能在 Current Project View 新建 Todo。

> “归档”没有二次确认。如果你只是想收起顶部页签，请使用页签上的关闭按钮。

## 打开或恢复 Archive Project

1. 在 Workspace 左侧“项目”底部点击“归档项目”。“归档项目”对话框列出已 Archive 的 Project。
2. 只想查看时，点击“打开”。Project 会临时打开，但仍保持 Archive 状态。
3. 需要让它重新进入活跃工作范围时，回到同一对话框点击“恢复”。完成后显示“项目已恢复”，Project 重新出现在活跃项目列表中。

恢复只改变 Archive 状态，不会重建或复制 Project 内容。

## 删除 Project 前先确认后果

删除用于你确定不再让当前 Workspace 管理这个 Project 的情况。若只需要让它退出活跃工作范围，优先使用 Archive。

1. 在 Workspace 左侧活跃项目列表中右键目标 Project，在“项目操作”菜单点击“删除”。“删除项目”确认对话框出现，并显示 Project 名称和目录。
2. 核对目标后点击“删除项目”。Project 目录会移到系统废纸篓；Project 中的 Record、Todo 和 File 关联也会从当前 Workspace 移除，页面回到 Workspace。

Project Mind 当前没有恢复已删除 Project 的入口。即使目录仍可能出现在系统废纸篓中，也不要把“还原目录”当作恢复 Workspace 关联的可靠方法。

## 三种动作的区别

| 动作 | Project 内容 | 活跃项目列表 | 可在 Project Mind 中恢复 |
| --- | --- | --- | --- |
| 关闭页签 | 保留 | 保留 | 直接再次打开 |
| Archive | 保留 | 移出 | 可在“归档项目”中恢复 |
| 删除 | 目录移到系统废纸篓，关联从当前 Workspace 移除 | 移出 | 没有恢复入口 |

<!-- VISUAL P0-PROJECTS-02
type: Mermaid 或可编辑 SVG 示意图
diagram: 从“活跃 Project”分出三条路径：关闭页签→仍在活跃项目列表；Archive→退出活跃范围且可恢复；删除→目录移入系统废纸篓、产品内无恢复入口。Archive 路径不得标成“完成”。
purpose: 让用户快速比较三个容易混淆的动作和可恢复性。
asset: ../assets/diagrams/project-lifecycle-actions.svg
alt: 关闭页签、Archive 与删除 Project 的状态变化
text-review: 补图后复核“三种动作的区别”表；若图已完整表达状态变化，表格保留准确后果，不再增加同义解释。
status: pending-user-capture
-->

## 接下来

- 上一级：[开始使用](README.md)
- 上一篇：[看懂界面、归属与 View](scopes-and-views.md)
- 下一步：[用 QuickNote 接住还没想清楚的内容](../capture/quicknote.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

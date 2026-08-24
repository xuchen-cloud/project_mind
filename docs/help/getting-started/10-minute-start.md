# 10 分钟完成第一次工作闭环

完成下面这条最短路径后，你会留下项目背景、一条可再次打开的 Project Record 和一个可持续跟踪的 Project Todo。QuickNote 不会被清空或移动。

下面用“客户成功”Workspace 中的“智能客服知识库升级”Project 演示。你可以替换成手头正在推进、并且有明确结果的工作。

## 1. 进入一个 Workspace

如果你已经看见 Workspace 主界面，直接进入下一节。否则：

1. 在起始页点击“新建 Workspace”。“新建 Workspace”对话框随即打开。
2. 在“Workspace 根目录”旁点击“选择”，选择用于“客户成功”的本地目录；输入非空的“Workspace 密码”。根目录和密码都准备好后，“创建 Workspace”即可提交。
3. 点击“创建 Workspace”。成功后，起始页关闭，Workspace 主界面出现。

<!-- VISUAL P0-START-01
type: 真实 UI 截图
capture: Workspace Gate 全窗口，保留“新建 Workspace”“打开已有 Workspace”和最近列表；最近路径使用虚构目录或裁掉路径列。
purpose: 证明第一次使用的两个入口在哪里，以及完成创建后会离开 Gate。
asset: ../assets/getting-started/workspace-gate.png
alt: Workspace Gate 中的新建、打开和最近 Workspace 入口
text-review: 补图后复核本节三个步骤的按钮文字和先后顺序；如果截图已清楚展示入口，正文只保留动作与结果，不重复描述布局。
status: pending-user-capture
-->

这个密码保护保存在 Workspace 中的 AI API Key，不是普通内容的登录密码。完整边界见[创建与打开 Workspace](workspace.md)。

## 2. 创建“智能客服知识库升级”Project

1. 在 Workspace 左侧栏选择“项目”，点击“新建项目”。Project Mind 会立即创建并打开一个“未命名项目”，项目名称处于可编辑状态。
2. 输入“智能客服知识库升级”，按 `Enter`。页面标题变为新名称，Project 仍保持打开。

Project 是围绕明确结果建立的阶段性工作现场。这里的 Record、Todo 和 File 都会属于这个 Project。

## 3. 用 Project QuickNote 接住当前上下文

1. 确认主区上方选中“QuickNote”。新 Project 会先显示这个视图。
2. 在编辑区输入：

   ```text
   目标：减少客服重复查找答案的时间。
   当前判断：先整理高频问题，再决定知识库结构。
   ```

3. 点击编辑区外。失焦会触发保存；再次回到编辑区时，刚才的内容仍在 Project QuickNote 中。

<!-- VISUAL P0-START-02
type: 真实 UI 截图
capture: “智能客服知识库升级”Project 的 QuickNote 视图；正文只放“目标”和“当前判断”，左右侧栏同时可见，右侧 Todo 尚未创建或为空。
purpose: 证明 Project QuickNote 的入口、作用域和完成后的界面状态。
asset: ../assets/getting-started/project-quicknote.png
alt: 智能客服知识库升级 Project 的 QuickNote 与 Todo List
text-review: 补图后复核本节对“新 Project 默认视图”和保存反馈的描述；不要逐项复述截图中的侧栏。
status: pending-user-capture
-->

此时先不用整理格式。QuickNote 的职责只是接住尚未决定最终形式的内容。

## 4. 新建一条独立的 Project Record

1. 在 Project 左侧栏选择“记录”，点击“新增记录”。一条空 Record 会被创建，并在专注页打开。
2. 输入标题“高频问题初步盘点”，在正文写下“过去一周的咨询主要集中在退款进度与账号登录”。页面先显示“保存中...”，完成后显示“已保存”。

<!-- VISUAL P0-START-03
type: 真实 UI 截图
capture: “高频问题初步盘点”Project Record 专注页，显示标题、两行示例正文和“已保存”状态；裁掉真实路径。
purpose: 证明新增 Record 后打开的页面，以及用户应等待的成功状态。
asset: ../assets/getting-started/first-record.png
alt: 高频问题初步盘点 Project Record 的专注页和已保存状态
text-review: 补图后复核“新增记录”后的页面跳转、占位词和保存状态原文；若状态文案有差异，以截图对应基线为准。
status: pending-user-capture
-->

这条 Record 直接归属于“智能客服知识库升级”。它不是从 QuickNote 移出的内容，所以前一步的 QuickNote 仍原样保留。

## 5. 建立一个 Project Todo

1. 返回 Project 页面，在右侧“Todo List”确认当前是 Current Project View。Project 页面默认使用这个 View；如果按钮提示当前是 Workspace View，点击视图按钮切回 Current Project View。
2. 点击“新增代办”，输入“整理退款进度类问题的标准答案”。
3. 点击“创建”或按 `Enter`。输入框收起，新 Todo 出现在“未完成”列表中。

在 Current Project View 中创建的 Todo 直接属于当前 Project，不需要再选择归属。

## 6. 离开后再次找到二者

1. 点击顶栏“Workspace”。在右侧 Workspace View 的“未完成”列表中找到刚创建的 Todo。若想按 Project 定位，可点击“分组显示”，再到“智能客服知识库升级”组中查看。
2. 在左侧“项目”列表点击“智能客服知识库升级”。Project 重新打开。
3. 在 Project 左侧“记录”中点击“高频问题初步盘点”。Record 专注页再次出现，标题和正文仍可继续编辑。

<!-- VISUAL P0-START-04
type: 真实 UI 状态对照
capture: 左半为 Workspace View 的未完成列表中刚创建的 Project Todo；右半为“智能客服知识库升级”Project 记录侧栏中的“高频问题初步盘点”。两边使用同一演示数据。
purpose: 证明离开创建现场后，Todo 和 Record 都能再次找到。
asset: ../assets/getting-started/find-record-and-todo.png
alt: 在 Workspace View 与 Project 记录侧栏再次找到 Todo 和 Record
text-review: 补图后复核本节找回路径，尤其确认 Workspace View 当前是分组还是平铺；正文不得假定可选的显示偏好。
status: pending-user-capture
-->

至此，你完成了第一次闭环：QuickNote 留住当前上下文，Record 保存可独立找回的信息，Project Todo 跟踪下一步，而且两者都能在离开后再次找到。

## 接下来

- 上一级：[开始使用](README.md)
- 下一步：[创建与打开 Workspace](workspace.md)
- 继续记录：[用 QuickNote 接住还没想清楚的内容](../capture/quicknote.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

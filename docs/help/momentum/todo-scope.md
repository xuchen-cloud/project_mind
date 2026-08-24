# 把 Todo 放回真正属于的地方

推进某个明确 Project 结果的行动，创建 Project Todo；个人事务、跨 Project 事项或不需要建立 Project 的行动，创建 Workspace Todo。`Workspace View` 和 `Current Project View` 只是查看范围，不会改变 Todo 的真实归属。

## 先选归属，再看 View

| 概念 | 它表示什么 |
| --- | --- |
| Workspace Todo | 直接属于 Workspace，不依赖任何 Project |
| Project Todo | 只属于一个 Project，用来推进该 Project 的结果 |
| Workspace View | Workspace Todo，加上所有未进入 Archive 的 Project 所拥有的 Project Todo |
| Current Project View | 只属于当前 Project 的 Project Todo |

因此，一条 Project Todo 出现在 Workspace View 中，并不会变成 Workspace Todo。它仍然使用所属 Project 的 Project Tag，也仍随该 Project 管理。

## 创建“智能客服知识库升级”的 Project Todo

最直接的做法是在对应 Project 中创建：

1. 打开“智能客服知识库升级”Project。
2. 在右侧 `Todo List` 查看地球图标的提示。若当前是 `Workspace View`，点击图标切换到 `Current Project View`。
3. 点击 `Todo List` 右上角的“新增代办”按钮。
4. 输入“整理退款进度类问题的标准答案”，然后点击“创建”。

Current Project View 的创建器不显示“Todo 归属”；这里创建的 Todo 直接属于当前 Project。

## 从 Workspace View 创建时，显式确认归属

Workspace 页面始终显示 Workspace View。Project 页面也可以切到 Workspace View，以便同时查看 Workspace Todo 和各个未进入 Archive 的 Project Todo。

在 Workspace View 中创建 Todo 时：

1. 点击“新增代办”。
2. 找到“Todo 归属”。默认值是 `Workspace`。
3. 如果行动属于“智能客服知识库升级”，搜索并选择这个 Project；如果行动不依赖任何 Project，保留 `Workspace`。
4. 输入行动并点击“创建”。

只有显式选择 Project，才会创建 Project Todo。已进入 Archive 的 Project 不会出现在可选归属中。

<!-- VISUAL P0-TODO-01
type: 真实 UI 状态对照
capture: 左图为“智能客服知识库升级”Project 的 Current Project View 新建 Todo，创建器不显示“Todo 归属”；右图为 Workspace View 新建 Todo，显示并展开“Todo 归属”选择，列表中可见同一 Project。
purpose: 证明创建位置如何影响默认归属，以及何时必须显式选择 Project。
asset: ../assets/momentum/todo-scope-create.png
alt: Current Project View 与 Workspace View 创建 Todo 时的归属差异
text-review: 补图后共同复核“创建 Project Todo”和“从 Workspace View 创建”两节；确认视图按钮、创建按钮和归属字段实际文案，不假定分组/平铺偏好。
status: pending-user-capture
-->

## 确认你看到的还是同一条 Todo

“整理退款进度类问题的标准答案”创建为 Project Todo 后：

1. 它会出现在“智能客服知识库升级”的 Current Project View。
2. 切到 Workspace View 后，它仍会出现；分组显示时位于“智能客服知识库升级”组。
3. 回到 Workspace 页面，也能在 Workspace View 中看到它。

这些入口展示的是同一条 Todo。切换 View、完成它或编辑它，都不会复制、移动或重新归类它。

## 接下来

- 上一级：[让 Project 继续向前](README.md)
- 上一步：[这句话应该成为 Record，还是 Todo](record-or-todo.md)
- 下一步：[把散落 File 变成可找回的项目现场](project-files.md)
- 相关：[看懂界面、归属与 View](../getting-started/scopes-and-views.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

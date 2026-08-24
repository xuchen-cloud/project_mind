# 看懂界面、归属与 View

判断内容时只要分清两件事：对象真正属于 Workspace 还是某个 Project，以及当前 View 暂时显示哪些 Todo。切换页面或 View 不会移动、复制或重新归类任何对象。

## 先用页面确认创建范围

顶栏用于回到“Workspace”、打开或关闭 Project 页签、搜索和进入设置。主区与左侧栏会随当前页面变化：

| 当前页面 | 主区 | 左侧栏 | 新建内容的归属 |
| --- | --- | --- | --- |
| Workspace | QuickNote / Record | 项目 / 记录 | Workspace QuickNote、Workspace Record |
| 某个 Project | QuickNote / Record | 记录 / 文件 | 当前 Project 的 Project QuickNote、Project Record、File |

<!-- VISUAL P0-SCOPES-01
type: Mermaid 或可编辑 SVG 示意图
diagram: 外层 Workspace，包含 Workspace Record/Todo/Tag 与两个彼此独立的 Project；Workspace View 用虚线汇集 Workspace Todo 和未 Archive Project Todo；Current Project View 只圈当前 Project Todo；中心标注“View 不改变归属”。
purpose: 解释对象归属和 Todo 查看范围是两套不同关系。
asset: ../assets/diagrams/scope-and-todo-views.svg
alt: Workspace 与 Project 对象归属及两种 Todo View 的关系
text-review: 补图后复核本节表格与“再用 View 确认 Todo 集合”；图承担关系总览，正文保留定义和判断规则，删除重复枚举。
status: pending-user-capture
-->

例如，在“智能客服知识库升级”页面点击“新增记录”，得到的是这个 Project 的 Project Record；从 Workspace 页面的“记录”中点击“新增记录”，得到的是 Workspace Record。之后从搜索或别的入口打开它，都不会改变归属。

## 再用 View 确认 Todo 集合

Todo View 只决定右侧“Todo List”显示哪些 Todo：

| View | 在哪里看到 | 显示内容 |
| --- | --- | --- |
| Workspace View | Workspace 页面固定使用；Project 页面也可切换到 | Workspace Todo，以及所有未进入 Archive 的 Project 的 Project Todo |
| Current Project View | 只在 Project 页面使用，且为默认 View | 只属于当前 Project 的 Project Todo |

在 Project 页面，点击 Todo List 标题栏中的 View 按钮，可以在 Current Project View 与 Workspace View 之间切换。切换后列表内容发生变化，但 Todo 的归属不变。

“整理退款进度类问题的标准答案”属于“智能客服知识库升级”：

1. 在该 Project 的 Current Project View 中能看到它。
2. 切到 Workspace View 后仍能看到它；若当前采用分组显示，它位于“智能客服知识库升级”组。
3. 回到 Workspace 页面也能看到它。

三处显示的是同一条 Project Todo，不是三份副本。

## 新建 Todo 时看清归属

- 在 Current Project View 点击“新增代办”，新 Todo 直接属于当前 Project。
- 在 Workspace View 点击“新增代办”，归属默认为“Workspace”。只有在“Todo 归属”中明确选择某个未 Archive 的 Project，才会创建该 Project 的 Project Todo。

因此，“从哪里看到”不能代替“创建时选了什么归属”。Todo 的完整选择规则见[把 Todo 放回真正属于的地方](../momentum/todo-scope.md)。

## 其他对象也遵守作用域

- Workspace Record 适合不依赖某个阶段性 Project 的长期内容；Project Record 只属于一个 Project。
- Workspace Tag 只用于 Workspace 范围对象；Project Tag 只用于一个特定 Project 内的 Record、Todo 和 File。同名不代表同一个 Tag。
- File 只属于一个 Project。
- Internal Reference 只建立可导航连接，不改变归属。Workspace 范围对象可以引用 Project 对象；Project 范围对象只能引用同一 Project 内的对象。

拿不准时，先问：这条内容是否依赖一个有明确结果、会结束的 Project？如果依赖，先进入对应 Project 再创建；如果不依赖，就留在 Workspace。

## 接下来

- 上一级：[开始使用](README.md)
- 上一篇：[创建与打开 Workspace](workspace.md)
- 下一步：[创建、打开与 Archive Project](projects.md)
- 相关：[把 Todo 放回真正属于的地方](../momentum/todo-scope.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

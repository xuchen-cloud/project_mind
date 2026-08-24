# 这句话应该成为 Record，还是 Todo

想保留一个判断、事实或上下文，创建 Record；想持续跟踪一个需要完成的动作，创建 Todo。如果一句话同时包含“为什么这样做”和“下一步做什么”，把依据放进 Record，把动作另建为 Todo。

## 用一个问题做判断

问自己：**这条内容以后需要被完成吗？**

| 你的答案 | 放在哪里 | 例子 |
| --- | --- | --- |
| 不需要完成，但以后要查找、引用或继续修订 | Record | “退款进度类问题需要先统一答案口径，再扩充知识库。” |
| 需要完成，并且要一直跟踪到结束 | Todo | “整理退款进度类问题的标准答案。” |
| 还没想清楚 | QuickNote | “退款问题：口径、知识来源、更新频率？” |

<!-- VISUAL P0-DECISION-01
type: Mermaid 或可编辑 SVG 示意图
diagram: 起点“这条内容现在是什么”；未想清楚→QuickNote；需保留判断/事实/上下文→Record；需跟踪到完成→Todo；同一句同时含判断和行动→拆成 Record + Todo。箭头只表达判断，不暗示一键转换功能。
purpose: 把 Record/Todo/QuickNote 的选择规则压缩成可反复使用的判断图。
asset: ../assets/diagrams/quicknote-record-todo-decision.svg
alt: 在 QuickNote、Record 与 Todo 之间判断内容去向
text-review: 补图后复核判断表和“同一句话里既有判断，也有行动”；图负责分流总览，正文保留例子和“没有一键转 Todo”的产品边界。
status: pending-user-capture
-->

在“智能客服知识库升级”Project 中，前两条分别成为 Project Record 和 Project Todo。这样回看时既能找到当时的判断，也能看见尚未完成的下一步。

## 同一句话里既有判断，也有行动

例如你写下：

> 退款进度类问题需要先统一答案口径，下周整理标准答案。

可以拆成：

1. 创建 Project Record，记录为什么要先统一口径、依据来自哪里，以及当前判断。
2. 在右侧 `Todo List` 创建 Project Todo：“整理退款进度类问题的标准答案”。
3. 如果材料属于这个 Project，下一步把支撑行动的 File 留在同一 Project 中。

Record 可以继续修订，但它不表示行动是否完成；Todo 用来跟踪行动，也不需要承载完整的判断背景。

## 从 QuickNote 开始时

QuickNote 适合先接住还没决定形式的内容。选中其中一段后，当前可见菜单提供“移动到记录”，可以创建 Record 或追加到已有 Record；成功后，选区会从 QuickNote 移除。

QuickNote 当前没有“一键转 Todo”。当内容已经变成明确行动时，请在右侧 `Todo List` 中另行创建 Todo，并在创建时确认它真正属于 Workspace 还是某个 Project。

## 接下来

- 上一级：[让 Project 继续向前](README.md)
- 下一步：[把 Todo 放回真正属于的地方](todo-scope.md)
- 相关：[用 QuickNote 接住还没想清楚的内容](../capture/quicknote.md)
- 相关：[把值得保留的内容沉淀为 Record](../capture/record.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

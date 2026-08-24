# 从当前内容开始逐步扩大搜索

找信息时先从最小范围开始：先查当前正文，再筛当前 Workspace 或 Project 的 Record，最后回到“Workspace”页签使用顶栏搜索。范围越小，结果越容易判断；只有前一层没有找到时才扩大。

## 1. 在当前正文中查找

确定关键词就在当前打开的 QuickNote 或 Record 时：

1. 点击正文，使编辑器获得焦点。
2. 在 macOS 按 `Cmd+F`，在 Windows 按 `Ctrl+F`。
3. 输入关键词，例如 `支付流水`。搜索面板会显示“当前结果 / 总结果”，并高亮正文中的匹配。
4. 按 `Enter` 跳到下一个结果，按 `Shift+Enter` 回到上一个结果；按 `Esc` 关闭。

这一层只查当前编辑器的正文，不查 Record 标题、Tag、其他 Record 或 Todo。

## 2. 在当前作用域筛 Record

知道信息属于哪里、但忘了是哪条 Record 时，使用左侧栏：

1. 在 Workspace 或目标 Project 的左侧栏选择“记录”。
2. 在“搜索记录”中输入标题、正文或 Tag 中的关键词。
3. 如果结果仍多，点击搜索框下方的 Tag 进一步收窄。
4. 单击结果回到 Record 浏览位置；双击可打开专注页。

Workspace 侧栏只筛 Workspace Record；Project 侧栏只筛当前 Project Record。输入相同关键词不会跨 Project 查找，也不会改变任何 Record 的归属。

在示例中，如果你知道 `退款失败排查顺序` 属于“智能客服知识库升级”，就在这个 Project 的“记录”侧栏搜索 `支付流水`。

## 3. 在 Workspace 范围找回对象

连归属也不确定时，先点击顶栏“Workspace”页签，再使用右上角搜索框。不要在 Project 页签中把它当作全局搜索：当前基线下，Project 页签的顶栏搜索只返回当前 Project Todo。

Workspace 页签的顶栏搜索实际覆盖：

- Workspace QuickNote 的正文与 Tag；
- Workspace Record 的标题、正文与 Tag；
- Project 的名称与 Project QuickNote 内容；
- 未进入 Archive 的 Project Record 的标题、正文与 Tag；
- Workspace Todo，以及未进入 Archive 的 Project Todo 的正文、进展与 Tag；
- File 的名称、版本文件名与 Tag；
- Contact 的姓名、拼音和资料字段。

选择结果会打开相应的 QuickNote、Record、Project、Todo 或 File；Contact 结果会进入联系人设置。顶栏最多展示 16 条排序后的结果，且默认不含 Archive Project 中的内容。没有命中时，换用更具体的标题片段或 Tag；若你知道作用域，回到第二层通常更有效。

例如，在“Workspace”页签搜索 `支付流水`，可以同时找回相关的 Workspace Record、未 Archive Project Record 或 Todo；看到“智能客服知识库升级”来源后，再进入对应对象继续工作。

<!-- VISUAL P0-SEARCH-01
type: 真实 UI 三联图
capture: 对同一关键词“支付流水”分别截图：当前编辑器的 Cmd/Ctrl+F；“智能客服知识库升级”Project 的记录侧栏筛选；切回 Workspace 页签后的顶栏搜索结果。每格只突出搜索框、范围提示和代表性结果。
purpose: 证明三层搜索的范围逐步扩大，而不是三个等价入口。
asset: ../assets/context/search-three-levels.png
alt: 在当前正文、Project 记录侧栏和 Workspace 顶栏逐步扩大搜索
text-review: 补图后从“1. 在当前正文中查找”到本节末整体复核；以截图确认快捷键提示、占位词、结果类型和 Project 页签边界，必要时重排三节篇幅。
status: pending-user-capture
-->

## 接下来

- 上一步：[把值得保留的内容沉淀为 Record](../capture/record.md)
- 下一步：[把 Todo 放回真正属于的地方](../momentum/todo-scope.md)
- 相关判断：[这句话应该成为 Record，还是 Todo](../momentum/record-or-todo.md)
- 上一级：[组织、连接与找回](README.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

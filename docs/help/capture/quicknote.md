# 用 QuickNote 接住还没想清楚的内容

还没判断一段信息最终应该放哪里时，先写进 QuickNote。Workspace 和每个 Project 都各有一个 QuickNote；它们是持续更新的临时缓冲区，不会按天新建，也不是 Record 或 Todo 列表。

## 先选对入口

- 内容还不属于任何阶段性 Project：打开顶栏“Workspace”，选择主区域右上方的“QuickNote”。
- 内容已经明确属于某个 Project：打开该 Project，再选择“QuickNote”。

<!-- VISUAL P0-QUICKNOTE-01
type: 真实 UI 状态对照
capture: 同尺寸双图；左图保留顶栏“Workspace”和 Workspace QuickNote，右图保留“智能客服知识库升级”页签和 Project QuickNote。两边正文各放一条易区分的虚构内容。
purpose: 证明两种 QuickNote 的入口相似，但真实归属不同。
asset: ../assets/capture/workspace-vs-project-quicknote.png
alt: Workspace QuickNote 与 Project QuickNote 的入口对照
text-review: 补图后复核“先选对入口”和示例段落；正文继续解释归属判断，不重复描述两张图的每个侧栏元素。
status: pending-user-capture
-->

在“智能客服知识库升级”Project 中，先把刚收到的信息写进 Project QuickNote：

> 客服反馈：退款失败时，知识库没有提示先核对支付流水和订单状态。还要确认失败码 3107 的处理口径。

这时不用先起标题、选 Tag 或判断最终结构。先保住背景和原话即可。

## 等待保存反馈

QuickNote 会自动保存。停止输入约两分钟，或离开编辑区、切换窗口时，都会触发保存。离开前留意应用的保存反馈。如果显示保存失败，保持应用打开，先把关键文字复制到另一个本地文件；再回到编辑区做一次小改动，点击编辑区外重新触发保存。看到成功反馈后再关闭；仍然失败时，按[遇到问题时先检查什么](../trust-and-help/troubleshooting.md)继续处理。

再次打开同一 Workspace 或 Project 的 QuickNote，编辑的是原来的缓冲区，不会创建新的一条。需要保留旧版本时，应把已判断清楚的内容沉淀为 Record，而不是继续覆盖 QuickNote。

## 什么时候离开 QuickNote

用一个简单问题判断：这段内容现在是在“等待判断”，还是已经有明确用途？

- 仍需补背景、核实来源或决定归属：继续留在 QuickNote。
- 已形成可独立理解、以后还要查找或引用的判断：沉淀为 Record。
- 已变成需要跟踪到完成的明确行动：建立 Todo。

在示例中，“退款失败先核对支付流水与订单状态”适合进入 Project Record；“确认失败码 3107 的处理口径”需要有人继续推进，更适合建立 Project Todo。当前 P0 路径不假设 QuickNote 可以一键转为 Todo。

## 接下来

- 上一步：[创建、打开与 Archive Project](../getting-started/projects.md)
- 下一步：[把值得保留的内容沉淀为 Record](record.md)
- 相关判断：[这句话应该成为 Record，还是 Todo](../momentum/record-or-todo.md)
- 上一级：[记录与沉淀](README.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

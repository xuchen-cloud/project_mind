# 把值得保留的内容沉淀为 Record

当一段信息已经能独立说明背景、依据或判断，就把它保存为 Record。先决定归属：跨项目长期复用的内容放进 Workspace Record；只服务于一个阶段性结果的内容放进对应的 Project Record。

## 先判断归属

仍以“智能客服知识库升级”Project 为例：

- “退款失败的通用诊断框架”如果会被多个项目长期复用，适合 Workspace Record。
- “本次知识库升级采用先查支付流水、再查订单状态的排查顺序”只服务于当前交付，适合“智能客服知识库升级”Project Record。

Record 的归属由创建入口决定：在 Workspace 的“记录”中创建 Workspace Record，在目标 Project 的“记录”中创建 Project Record；之后从其他入口查看它不会改变归属。

## 创建并写入 Record

1. 打开 Workspace 或目标 Project。
2. 在左侧栏选择“记录”。
3. 点击搜索框右侧的“新增记录”按钮。应用会立即创建一条空 Record，并打开专注页。
4. 在“记录标题”中输入 `退款失败排查顺序`。
5. 在正文补齐足够的上下文，例如：

   > 适用于智能客服知识库升级。用户反馈退款失败时，先核对支付流水是否成功，再核对订单状态；失败码 3107 的处理口径仍待确认。

6. 需要分类时再添加当前作用域内的 Tag；不要为了完成创建而预先建立大量 Tag。

<!-- VISUAL P0-RECORD-01
type: 真实 UI 连续步骤
capture: 三段连续状态：Project 记录侧栏中的“新增记录”入口；新 Record 专注页的标题与正文编辑状态；页头“已保存”。使用“高频问题初步盘点”示例。
purpose: 证明创建入口、编辑页面和成功状态是一条连续路径。
asset: ../assets/capture/create-and-save-record.png
alt: 从 Project 记录侧栏新建 Record 并确认已保存
text-review: 补图后复核本节六个步骤，尤其是按钮文案、专注页占位词和保存状态；将图片已清楚展示的界面位置从正文压缩为动作描述。
status: pending-user-capture
-->

专注页适合编辑较长内容。标题、Tag 和正文修改会自动保存；停止输入约两分钟、离开编辑区、切换窗口或返回列表时会触发保存。看到页头显示“已保存”后，再继续下一项工作。

## 回到列表继续修订

点击专注页左上方的返回按钮，会回到对应 Workspace 或 Project 的 Record 视图。你也可以在 Record 卡片中直接修改短内容；点击卡片外或按 `Cmd+Enter` / `Ctrl+Enter` 退出编辑时会保存。

Record 不是封存的成品。新证据出现后可以继续修订，但应让正文保持相对完整，使之后只看到这一条 Record 的人也能理解它。

## 删除前先确认

专注页没有删除入口。返回 Record 视图后，在目标 Record 卡片上打开右键菜单并选择“删除”；Project 侧栏中的 Record 也可通过右键菜单删除。

删除会立即执行，当前流程没有二次确认或撤销。先核对标题与归属；如果只是暂时不想处理，保留 Record 更安全。

## 接下来

- 上一步：[用 QuickNote 接住还没想清楚的内容](quicknote.md)
- 下一步：[从当前内容开始逐步扩大搜索](../context/search.md)
- 相关判断：[这句话应该成为 Record，还是 Todo](../momentum/record-or-todo.md)
- 上一级：[记录与沉淀](README.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

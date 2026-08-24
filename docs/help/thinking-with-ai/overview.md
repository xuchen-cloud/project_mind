# AI 能做什么，不能做什么

Project Mind 的 AI 是编辑器中的一次性协作工具：你明确选中一段文字，或右键一张图片，再让 AI Editor Skill 修改原文或生成回答。它不是会自行浏览整个 Workspace 的助手，也不是独立的多轮聊天入口。

## 从一个明确目标开始

假设“智能客服知识库升级”Project Record 中有这段待整理内容：

> 退款失败时先查支付流水。订单状态也要核对。失败码 3107 的口径还没确认。

要让 AI 帮你整理：

1. 在 QuickNote 或 Record 中选中这段文字。
2. 右键选区，在“技能”中选择一个已启用的 AI Editor Skill；也可以选择“使用 AI 编辑”，输入一次性的要求。
3. 等待结果出现，再决定接受、插入、复制或关闭。

没有文字选区时，文字 AI 不会替你决定处理范围。右键图片时，入口会变成图片 Skill 和“使用 AI 解读”；一次只处理当前这张图片。

<!-- VISUAL P0-AI-01
type: 真实 UI 状态对照
capture: 左图为明确文字选区的右键菜单，显示一个已启用的演示 AI Editor Skill 和“使用 AI 编辑”；右图为单张嵌入图片的右键菜单，显示图片 Skill 和“使用 AI 解读”。不要出现真实 Provider、模型或 API Key。
purpose: 证明文字与图片 AI 都从用户明确指定的目标开始，且入口不同。
asset: ../assets/ai/text-and-image-skill-entry.png
alt: 文字选区与单张图片的 AI Editor Skill 入口
text-review: 补图后复核“从一个明确目标开始”和“图片会连同有限上下文一起发送”；以截图校正菜单分组与文案，但正文仍需说明发送范围不能仅凭菜单判断。
status: pending-user-capture
-->

## 文字选区不一定等于发送的全部字符

为了保留标题、列表、表格、图片等结构，Project Mind 会把文字选区扩展为它所在的完整 Markdown 块，再交给 AI。结构中的非文字内容会以要求保留的占位符出现。

当前文字流程不会额外发送整篇正文，但也不要把它理解成“只发送鼠标高亮的几个字”。在运行前，先检查选区所在的完整段落或列表项是否适合交给所选 Provider。

例如，只高亮“失败码 3107”时，实际目标可能是包含它的整段退款说明。若同一段还有客户姓名或内部编号，应先移除敏感信息，或把可发送内容拆到单独一段。

## 图片会连同有限上下文一起发送

Image Interpretation 会读取右键的单张本地图片，叠加你保存的可见标注，再按 Provider 要求缩放和编码。请求还可能包含：

- 图片前后各一段有限的正文上下文；
- 可见标注的数据；
- Skill 名称、提示词、结果模式与输出规则；
- 相邻非文字内容的中性标签。

支持 PNG、JPEG、WebP、BMP 和 GIF。SVG、AVIF、HEIC 与 HEIF 当前不能用于 Image Interpretation。图片宽度只是显示样式，不会缩小发送范围；AI 生成的是文字，不会修改原图像素。

## Provider 会收到什么

运行 AI 编辑时，相关内容会离开本机并发送到你在“AI 模型配置”中选择的 Provider。Provider 会收到目标内容、Skill 指令、结果规则和模型信息；图片任务还会收到单张图片及上述附近上下文。

API Key 保存在当前 Workspace 中，并由 Workspace 密码加密；发送请求时仍需按 Provider 的协议用于认证。Provider 是否保留请求、用于日志或训练，取决于该服务和你的账户条款。处理客户资料前，应先按所在组织的规则确认是否允许发送。

更完整的本地保存与密码边界见[资料保存在什么地方](../trust-and-help/local-data.md)。

<!-- VISUAL P0-AI-02
type: Mermaid 或可编辑 SVG 示意图
diagram: 左侧为本地 Workspace 与 Committed Content；中间为用户主动选择文字/图片并运行 Skill；右侧为外部 Provider。文字路径标“完整 Markdown 块”，图片路径标“单图 + 可见标注 + 有限附近正文”；返回结果先进入待确认区，接受/插入后才回到 Committed Content。
purpose: 解释本地与外部 Provider 的数据边界，以及 AI 结果为什么不会自动写入正文。
asset: ../assets/diagrams/local-ai-provider-boundary.svg
alt: Project Mind 本地内容与外部 AI Provider 的数据流边界
text-review: 补图后共同复核“Provider 会收到什么”和“AI Modification 与 AI Answer”；图负责数据流，正文保留例外、Provider 条款和确认动作，避免重复箭头文字。
status: pending-user-capture
-->

## AI Modification 与 AI Answer 都要你确认

- AI Modification 是替换建议。结果会先显示为临时预览；你可以“对比”“撤销”，只有点击“接受”才成为 Committed Content。
- AI Answer 是补充回答。你可以先“复制”检查，只有点击“插入”才进入正文；“关闭”不会改动正文。
- “自动决定”可能同时给出两种结果，它们仍分别遵循接受与插入规则。

Committed Content 是允许保存的正文视图。自动保存、切换页面、关闭编辑器和 Record Export 都不会把尚未接受的 AI Modification 或尚未插入的 AI Answer 当作正文保存。生成失败时可先重试；如果提示目标或范围已经变化，关闭结果，重新选择文字或右键图片后再运行。

## 什么时候不该用 AI

以下情况先用普通编辑、Record 或 Todo 更合适：

- 你还没有决定 AI 可以看到哪些内容；
- 需要连续追问、检索整个 Workspace 或让 AI 自动执行多步操作；
- 需要修改图片像素，而不是从图片生成文字；
- 结果必须是确定事实，但你尚未准备人工核对依据；
- 当前离线，或所选 Provider 不可达。

在示例中，可以让 AI 把退款说明整理成候选结构，但“失败码 3107 的正式口径”仍应由你核对依据后写入 Record。AI 建议不是已确认事实。

## 接下来

- 上一级：[与 AI 一起编辑](README.md)
- 下一步：[资料保存在什么地方](../trust-and-help/local-data.md)
- 快速回答：[常见问题](../trust-and-help/faq.md)
- 遇到异常：[遇到问题时先检查什么](../trust-and-help/troubleshooting.md)
- 相关操作：[把值得保留的内容沉淀为 Record](../capture/record.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

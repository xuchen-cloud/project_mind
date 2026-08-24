# 遇到问题时先检查什么

先保住当前内容，再从作用域、路径、保存状态和配置逐层检查。下面按“最常见且最安全”到“较少见”排列；不需要删除或手工修改 `.project-mind` 中的任何文件。

<!-- VISUAL P0-TROUBLE-01
type: 真实 UI 四状态拼图
capture: 四格分别显示正文“保存失败”、Project File“失效”、AI 模型配置处于锁定状态、Record Export 提示图片无法读取。每格只保留状态、对象标题和安全恢复入口，不出现真实内容或凭证。
purpose: 帮助用户先辨认自己属于哪类故障，再跳到对应小节。
asset: ../assets/trust/troubleshooting-states.png
alt: 保存失败、File 失效、AI 锁定和导出图片错误的界面状态
text-review: 补图后复核四个对应排障小节的错误原文和第一步；如果真实错误文案与计划不同，更新标题或首句，不让截图与正文出现两套术语。
status: pending-user-capture
-->

## 内容或 Todo 突然看不到了

先确认 View、作用域和 Archive 状态，内容通常只是没有出现在当前范围。

1. Todo 看不到时，确认当前是 Workspace View 还是 Current Project View。后者只显示当前 Project Todo。
2. Record 看不到时，打开它真正所属的 Workspace 或 Project，再用左侧栏筛选。
3. 仍不确定归属时，回到顶栏“Workspace”页签搜索标题、正文或 Tag。
4. 若内容属于 Archive Project，先检查该 Project 的 Archive 状态；Workspace 搜索默认不包含其中内容。

不要为了“找回来”先新建同名 Record 或 Todo，以免之后难以判断哪一条是原对象。完整搜索顺序见[从当前内容开始逐步扩大搜索](../context/search.md)，Todo 范围见[把 Todo 放回真正属于的地方](../momentum/todo-scope.md)。

## 最近使用的 Workspace 打不开了

重新选择实际 Workspace 根目录；最近列表只记路径，不保存内容副本。

1. 在起始页点击“打开已有 Workspace”。
2. 选择原来的 Workspace 根目录，而不是其中某个 Project 子目录。
3. 确认根目录内仍有 `.project-mind/workspace.json`。
4. 如果你刚移动或复制过整个 Workspace，选择新位置；最近列表仍会保留旧路径。

若找不到 `.project-mind/workspace.json`，先停止创建或覆盖目录，回到系统文件管理器确认是否选错位置。不要手工新建元数据文件，也不要用同名空 Workspace 覆盖原目录。操作入口见[创建与打开 Workspace](../getting-started/workspace.md)。

## Record 或 QuickNote 显示“保存失败”

保持应用和当前页面打开，先复制关键文字，再恢复 Workspace 目录的可写状态并重新触发保存。

1. 暂时不要退出应用。把尚未确认保存的关键文字复制到另一个本地文件。
2. 确认 Workspace 所在磁盘仍已连接、目录可写且有可用空间。
3. 回到编辑器做一次很小的普通编辑，然后点击编辑区外或返回列表，触发再次保存。
4. 等到状态显示“已保存”，再继续切换页面或退出。

若页面上还有 AI 临时预览，先决定“接受”“插入”或“撤销”。未确认的 AI 结果不会写入 Committed Content；普通编辑仍应先另外复制留底。不要直接替换、移动或删除 `workspace.sqlite3`。

## Project File 显示“失效”

先从可靠来源重新导入为新的 File，确认新 File 可打开后，再决定是否清理旧条目。

1. 找到仍可用的原始材料，例如“退款问题口径草案.pdf”。
2. 打开“智能客服知识库升级”Project 的“文件”。
3. 点击“导入文件”，以不同文件名重新导入。
4. 打开新 File，核对内容和 Project Tag。
5. 旧的失效条目不会自动修复；需要清理时，先确认它不再承担版本依据。

失效 File 的“打开文件所在位置”和“复制为新版本并打开”不可用。删除旧条目不会修复路径。更多边界见[把散落 File 变成可找回的项目现场](../momentum/project-files.md)。

## Record Export 失败或提示图片无法读取

先解决正文保存和目标目录问题；图片缺失时再决定取消还是生成占位版本。

1. 若错误包含“导出前保存失败”，回到上一节恢复保存，直到显示“已保存”。
2. 重新选择一个存在、可写且空间充足的目标目录。
3. 若列出无法读取的图片，选择“取消导出”以修复图片，或明确选择“继续生成占位版本”。
4. 其他临时错误可在导出对话框中点击“重试”。

Record Export 只生成一条 Record 的副本，不是 Workspace Backup。当前的备份与迁移边界见[资料保存在什么地方](local-data.md)。

## “使用 AI 编辑”不可用或要求解锁

先解锁已保存的 AI API Key，再确认模型配置、能力声明和默认绑定。

1. 点击顶栏“设置”，打开“AI 模型配置”。
2. 若 AI API Key 显示为锁定，点击旁边的解锁按钮并输入当前 Workspace 密码。
3. 确认接入配置处于“启用”，并至少声明“文本”；处理图片还必须声明“图片”。
4. 确认“默认模型”和图片所需的默认模型已就绪，或 Skill 绑定了可用配置。
5. 点击“测试”；图片任务可点击“测试图片能力（会产生调用）”。测试会向 Provider 发起实际请求。
6. 若失败，核对 Base URL、默认模型、API Key、网络和 Provider 服务状态，再重试。

忘记密码时，普通 Workspace 内容仍可打开，但已保存的 AI API Key 无法解锁。当前没有可见的密码找回或重置入口，不要修改 Workspace 元数据尝试绕过。

## 图片 AI 菜单提示格式或原图不可用

换用受支持且有本地原图路径的图片，再从新图片上右键运行。

- 支持 PNG、JPEG、WebP、BMP 和 GIF。
- SVG、AVIF、HEIC 与 HEIF 当前不支持。
- 若提示“图片没有可读取的本地原图”，先重新插入来源有效的图片。
- 若提示“图片已发生变化”，关闭旧结果，重新右键当前图片。

不要只改文件扩展名伪装格式。Image Interpretation 会读取真实像素并校验目标是否变化。

## AI 处理失败、结果消失或无法写回

原文仍以 Committed Content 为准；先复制有用回答，再根据提示重试或重新选择目标。

1. “修改失败”或“处理失败”时，可以点击“重试”。
2. AI Answer 已显示时，可先点“复制”保留，再决定是否重新运行。
3. 若提示修改范围、图片位置或目标已失效，关闭结果，重新选择文字或右键图片。
4. 若附近内容已变化，重新核对结果；不要直接接受旧上下文生成的修改。
5. 自动结果格式无法解析时，只能复制原始内容，不能插入正文。

关闭、失败或切换上下文时，未接受的 AI Modification 会回到原文，未插入的 AI Answer 不会保存。完整边界见[AI 能做什么，不能做什么](../thinking-with-ai/overview.md)。

## Internal Reference 点不开或保存时报失效

移除失效引用，再从当前允许的作用域重新选择有效目标。

1. 确认目标 Record、Todo 或 File 没有被删除。
2. Workspace 范围对象可以引用 Project 对象；Project 范围对象只能引用同一个 Project 内的对象。
3. 若提示“引用已失效”，删除旧引用并重新选择；不要仅修改显示文字。
4. Workspace Todo 不能新增指向 Archive Project 的引用；先确认 Project 状态和引用必要性。

如果只是一次“打开引用失败”，保持内容不变并稍后重试；反复失败时按上面的目标与作用域检查。

## 仍然无法恢复时

停止继续改动 Workspace 目录，保留错误原文和出现问题前的操作顺序。确认所有仍可编辑的重要文字已经复制到另一个本地文件后，退出应用，并完整复制当前 Workspace 根目录作为问题现场；不要只复制数据库，也不要清理缓存、日志或临时目录。这份副本用于保留现场，不代表存在受支持的恢复流程。

提交问题时可说明：应用版本、操作系统、问题发生在 Workspace 还是某个 Project、可见错误文字，以及是否涉及 AI、File 或 Record Export。不要附上真实 API Key、Workspace 密码或未经脱敏的客户资料。

## 接下来

- 上一级：[数据、信任与帮助](README.md)
- 上一步：[常见问题](faq.md)
- 下一步：[返回帮助中心首页](../README.md)
- 数据边界：[资料保存在什么地方](local-data.md)
- AI 边界：[AI 能做什么，不能做什么](../thinking-with-ai/overview.md)
- 找回内容：[从当前内容开始逐步扩大搜索](../context/search.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

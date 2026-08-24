# 常见问题

这里先给直接答案；需要操作步骤时，再进入对应文章。

## Project Mind 会把我的 Workspace 自动上传到云端吗？

不会。主要资料保存在你选择的本地 Workspace 根目录中，当前没有自动云同步承诺。

只有你主动运行 AI 编辑时，相关请求内容才会发送到所选 Provider；检查应用更新也需要联网。完整保存位置与数据边界见[资料保存在什么地方](local-data.md)。

## 没有网络时还能继续工作吗？

可以继续大多数本地工作。你仍可打开已存在的 Workspace，编辑 QuickNote 与 Record、管理 Todo、搜索、整理 Project，并使用可访问的本地 File。

AI 调用、AI 连接测试和应用更新需要网络及对应服务可达。离线期间先把“失败码 3107 待确认”留在“智能客服知识库升级”Project Record 或 Project Todo 中，联网后再运行 AI，不会阻塞本地记录。

## 我选中文字运行 AI 时，究竟会发送哪些内容？

会发送选区所在的完整 Markdown 块，而不一定只有鼠标高亮的字符。请求还包含 Skill 名称与提示词、结果模式、格式规则、结构占位符、所选模型，以及 Provider 认证所需的信息。

当前文字流程不会额外发送整篇正文。若完整段落中含有不应外发的客户资料，请先移除或拆段，再运行 AI。详见[AI 能做什么，不能做什么](../thinking-with-ai/overview.md)。

## 我让 AI 解读一张图片时，还会发送附近正文吗？

会。除右键的单张图片外，请求还可能带上可见标注、图片前后各一段有限正文、Skill 指令和结果规则。

相邻非文字内容只作为中性标签进入附近上下文。PNG、JPEG、WebP、BMP 和 GIF 可用；SVG、AVIF、HEIC 与 HEIF 当前不支持 Image Interpretation。

## Workspace 密码会加密我的全部资料吗？

不会。Workspace 密码用于校验解锁，并加密保存在数据库中的 AI API Key；它不加密正文、SQLite 数据库本身、Project File、嵌入图片、缓存、日志或导出文件。

若设备上资料敏感，请同时使用操作系统的磁盘加密和账户权限。当前也没有可见的密码找回入口，应妥善保管密码。

## 忘记 Workspace 密码后还能打开资料吗？

可以打开普通 Workspace 内容，但不能解锁已保存的 AI API Key。Workspace 密码只用于受保护的 AI API Key，不是打开普通内容的登录密码。

当前没有可见的密码重置或找回入口。不要修改 `.project-mind/workspace.json` 或 SQLite 来绕过校验；需要继续使用 AI 时，应先找回原密码。

## AI 生成的内容会自动写进 Record 吗？

不会。AI Modification 必须点击“接受”，AI Answer 必须点击“插入”，才会成为 Committed Content 并允许保存。

“复制”AI Answer 只复制结果；“关闭”或“撤销”会保留原正文。即使临时预览已经显示在编辑器中，保存和 Record Export 也会排除尚未确认的结果。

## AI 可以直接修改图片或查看整个 Workspace 吗？

不可以。当前 Image Interpretation 只从一张明确选择的图片生成文字，不修改图片像素；AI Editor Skill 也不会自行遍历整个 Workspace。

需要处理文字时先选区，需要处理图片时右键单图。需要全局找资料时，请用[从当前内容开始逐步扩大搜索](../context/search.md)。

## 导出一条 Record 能备份整个 Workspace 吗？

不能。Record Export 只是单条 Record 的本地可携带副本，不包含其他 Record、Todo、Project、数据库、AI 配置或全部 File。

当前没有受支持的 Workspace 备份、恢复或迁移功能。若只是通过文件系统另存资料，应在确认保存并退出应用后保留整个 Workspace 根目录，而不要只复制导出的 PDF、DOCX、Markdown/ZIP 或 SQLite；这种副本也不构成已验证可恢复的 Backup。

## 为什么我在当前 Project 里看不到一条 Todo？

通常是 View 与归属不同。Current Project View 只显示当前 Project Todo；Workspace View 会显示 Workspace Todo 和所有未进入 Archive 的 Project Todo。

切换 View 不会移动 Todo。先按[把 Todo 放回真正属于的地方](../momentum/todo-scope.md)确认它的真实归属，再决定在哪个 View 查看。

## 为什么 Workspace 搜索找不到 Archive Project 里的内容？

因为 Workspace 顶栏搜索默认不包含 Archive Project 中的内容。Archive 只是让 Project 可逆地退出活跃范围，不表示完成或删除。

先检查 Project 是否已进入 Archive；需要继续工作时按[创建、打开与 Archive Project](../getting-started/projects.md)恢复到活跃范围，再搜索。

## QuickNote 可以一直当作长期资料库吗？

不建议。QuickNote 是当前作用域中唯一的可变缓冲区，适合先接住还没决定去向的内容；值得长期保留的信息应沉淀为 Record，需要持续跟踪的行动应建立 Todo。

“失败码 3107 待确认”可以先留在“智能客服知识库升级”Project QuickNote；确认背景和依据后，再按[把值得保留的内容沉淀为 Record](../capture/record.md)。

## 我可以从一个 Project 引用另一个 Project 的内容吗？

不可以。Project 范围对象只能引用同一个 Project 内的对象；Workspace 范围对象可以引用 Project 对象。

若需要跨 Project 复用“退款失败通用诊断框架”，应把它沉淀为 Workspace Record，再分别在各 Project 中保留本项目的判断，但不要制造跨 Project Internal Reference。

## 接下来

- 上一级：[数据、信任与帮助](README.md)
- 上一步：[资料保存在什么地方](local-data.md)
- 下一步：[遇到问题时先检查什么](troubleshooting.md)
- AI 边界：[AI 能做什么，不能做什么](../thinking-with-ai/overview.md)
- 找回内容：[从当前内容开始逐步扩大搜索](../context/search.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

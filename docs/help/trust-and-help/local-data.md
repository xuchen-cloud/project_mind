# 资料保存在什么地方

Project Mind 的主要资料保存在你选择的 Workspace 根目录中，当前没有自动云同步，也没有受支持的 Workspace 备份或迁移功能。单条 Record 导出和单个 SQLite 文件都不是完整 Workspace 副本。

## Workspace 根目录里有什么

以“客户成功”Workspace 中的“智能客服知识库升级”Project 为例，Workspace 根目录包含 Project 目录、受管 File，以及应用创建的 `.project-mind` 目录。不要手工编辑其中的应用数据文件。

| 位置 | 保存什么 | 需要知道的边界 |
| --- | --- | --- |
| `.project-mind/workspace.sqlite3` | QuickNote、Record、Todo、Project、Tag、Internal Reference、联系人、AI 配置与其他结构化设置 | 是主要数据库，但不是全部资料 |
| `.project-mind/workspace.json` | Workspace 标识、版本、安全模式和密码校验信息 | 不是正文，也不应手工修改 |
| `.project-mind/embedded-note-assets/` | Workspace QuickNote、Workspace Record 中插入或粘贴的图片 | Project 内容的嵌入图片保存在对应 Project 下的同名目录 |
| `.project-mind/cache/image-thumbnails/` | 为显示图片生成的缩略图 | 缩略图不是原图 |
| `.project-mind/cache/ai/` | 当前版本预留的 AI 缓存目录 | 不应视为可恢复的 AI 历史 |
| `.project-mind/logs/`、`.project-mind/tmp/` | 当前版本创建的日志与临时空间 | 不保证其中一定有可用诊断记录，不建议手工清理 |
| `.project-mind/backups/` | 数据库结构升级前自动生成的 SQLite 快照 | 只覆盖数据库，不是完整 Workspace Backup |

Project 中受管的 File、File Version 和 Project 内容里的嵌入图片还会分布在对应 Project 目录中。因此，只复制 `.project-mind/workspace.sqlite3` 会遗漏材料和图片。

<!-- VISUAL P0-DATA-01
type: 可编辑 SVG 目录与边界示意图
diagram: 左侧画完整 Workspace 根目录，包含 `.project-mind`、Project 子目录、受管 File 与嵌入图片；右侧单独画外部 AI Provider。用实线表示本地保存，用仅在用户运行 AI 时出现的箭头连接 Provider；明确 Record Export 只从单条 Record 向外生成副本，不覆盖整个 Workspace。
purpose: 解释“主要资料在本地”不等于“只复制 SQLite 就完整”，并与外部 AI 数据流区分。
asset: ../assets/diagrams/workspace-storage-boundary.svg
alt: Workspace 根目录、本地数据文件与外部 AI Provider 的边界
text-review: 补图后复核“Workspace 根目录里有什么”“哪些操作需要联网”和“Record Export 为什么不是 Workspace Backup”；图承担位置总览，正文保留不支持备份/迁移的谨慎边界。
status: pending-user-capture
-->

应用的系统数据目录另有一个 `workspace-session.json`，只记录最近和最后打开的 Workspace 路径。它不是业务资料副本；最近列表里的路径失效，也不表示 Workspace 内容已经删除。

## Workspace 密码保护什么

Workspace 密码用于验证解锁，以及加密保存在 Workspace 数据库中的 AI API Key。每次打开 Workspace 后，普通内容可以先加载；要继续使用已保存的 Key、测试 AI 连接或执行 AI 编辑，需要输入密码解锁。

它不会加密以下内容：

- SQLite 中的 QuickNote、Record、Todo 与其他正文；
- Project 目录和受管 File；
- 嵌入图片、缩略图、缓存、日志或临时文件；
- 你导出的 Markdown/ZIP、DOCX 或 PDF。

因此，不要把 Workspace 密码当作整盘加密。需要保护本机文件时，应使用操作系统的账户权限、磁盘加密和组织规定的设备安全措施。当前版本也没有可见的密码找回或重置入口；请妥善保存密码，否则已保存的 AI API Key 无法解锁。

## 哪些操作需要联网

不调用外部服务时，Workspace 的日常工作由本地目录和 SQLite 支撑。打开已有内容、编辑 QuickNote 与 Record、管理 Todo、搜索、整理 Project 和使用本地 File，都可以在离线状态下继续进行。

以下操作需要相应服务可达：

- 调用 AI Provider；
- 在“AI 模型配置”中测试文字或图片连接；
- 检查和下载应用更新。

离线工作不等于自动同步或异地备份。重新联网后，Project Mind 也不会自动把 Workspace 上传到某个云端。

## 需要在其他位置保留资料时

当前版本没有受支持的 Workspace 备份、恢复或跨设备迁移流程。如果你仍需在文件系统中另存资料，至少应先等待内容显示“已保存”、处理完 AI 临时结果并退出 Project Mind，然后把整个 Workspace 根目录作为一个整体保留；只复制数据库、Project 子目录或导出文件都会遗漏内容。

这份文件系统副本不等于已经验证可恢复的 Backup。跨设备时，路径规则、系统字体和外部程序关联也可能不同；不要删除原 Workspace，直到你已经在目标环境中自行核对关键 Record、嵌入图片和 Project File。最近列表只保存本机路径，不会复制或同步内容。

## Record Export 为什么不是 Workspace Backup

Record Export 只把一条 Workspace Record 或 Project Record 的 Committed Content 生成为 Markdown/ZIP、DOCX 或 PDF。它不包含其他 Record、Todo、Project、数据库、AI 配置或全部受管 File。

例如，导出“退款失败排查顺序”可以得到便于交付的文档，却不能用来恢复“客户成功”Workspace 或其中的“智能客服知识库升级”Project。需要另存资料时，先理解上一节的当前边界。

## 接下来

- 上一级：[数据、信任与帮助](README.md)
- 上一步：[AI 能做什么，不能做什么](../thinking-with-ai/overview.md)
- 下一步：[常见问题](faq.md)
- 遇到异常：[遇到问题时先检查什么](troubleshooting.md)
- 相关操作：[创建与打开 Workspace](../getting-started/workspace.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

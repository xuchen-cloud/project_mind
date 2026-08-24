# 信任与恢复旅程事实表
- 产品基线：`9b359e83e76bf35bee7d46a9a97659af3916f784`
- 复核日期：2026-08-21
- 演示案例：虚构的“智能客服知识库升级”Workspace
- 用途：约束 `thinking-with-ai/overview.md`、`trust-and-help/local-data.md`、`trust-and-help/faq.md` 与 `trust-and-help/troubleshooting.md` 的公开表述

## 可公开事实与证据

| 主题 | 可公开表述 | 边界与写作提醒 | 基线证据 |
| --- | --- | --- | --- |
| AI 可达入口 | AI Editor Skill 可在 QuickNote 与 Record 的富文本编辑器中使用。先显式选中文字并右键，可运行菜单中的 Skill 或选择“使用 AI 编辑”；右键一张嵌入图片，可运行图片菜单中的 Skill 或选择“使用 AI 解读”。顶栏“设置”中有“AI 模型配置”和“AI 技能”。 | 当前没有独立多轮聊天入口。没有文字选区时，文字 AI 菜单不出现；图片入口一次只针对右键的那一张图片。 | `CONTEXT.md` 的 AI 编辑术语；`src/components/rich-editor/RichEditor.tsx:3855-4014, 6081-6147, 6725-6810`；`src/components/settings/SettingsDialog.tsx:44-84`；`src/App.test.tsx:410-412, 650-669` |
| 文字目标 | 用户必须先做非空文字选区。为保留标题、列表、表格、图片和附件等结构，实际 AI 目标会扩展为选区所在的完整 Markdown 块；选区中的非文字节点以要求保留的占位符进入请求。 | 不可承诺“只发送鼠标高亮的字符”。当前文字流程把 `documentContext` 设为 `null`，不会为文字任务额外发送整篇正文。 | `src/components/rich-editor/editorRewrite.ts:50-85`；`src/components/rich-editor/RichEditor.tsx:3056-3073, 3143-3165, 5594-5605`；`src/components/rich-editor/RichEditor.test.tsx:4439-4555` |
| 图片目标 | 图片流程一次处理一张有本地原图路径的图片。支持 PNG、JPEG、WebP、BMP 和 GIF；发送前会校验图片没有变化，叠加可见标注，并按 Provider 类型缩放、编码。 | SVG、AVIF、HEIC、HEIF 当前不可用于 Image Interpretation。AI 只生成文字结果，不改变图片像素。图片宽度样式不影响发送内容。 | `src-tauri/src/ai_provider.rs:52-97, 442-482`；`src/components/rich-editor/RichEditor.tsx:3039-3054, 3130-3163, 6875-6885`；`src/components/settings/AiSettingsPanel.tsx:993-996`；`CONTEXT.md` |
| Provider 收到的文字请求 | 所选外部 Provider 会收到系统约束、Skill 名称与提示词、结果模式及格式规则、扩展后的目标 Markdown，以及结构占位符。请求还包含所绑定模型，认证信息按 Provider 协议发送。 | 文本目标最多截取 20,000 个字符，Skill 名称最多 200 个字符，Skill 提示词最多 4,000 个字符。不要写成“整篇正文会发送”，也不要写成“只有选中文字会发送”。Provider 如何存储、记录或训练数据取决于用户选择的服务及其条款。 | `src-tauri/src/ai_provider.rs:539-572, 1719-1806`；各 Provider 请求体与认证：`src-tauri/src/ai_provider.rs:677-930` |
| Provider 收到的图片请求 | 除单张规格化图片外，Provider 还会收到 Skill 信息、结果规则、可见标注数据，以及图片前后各不超过约 2,000 个字符的完整正文块。相邻图片和附件只以中性标签进入附近上下文。 | 本地图片路径用于本机读取和校验，不作为图片内容字段发送；不要承诺附近上下文一定为空。标注既会叠加到像素，也会作为结构化上下文进入请求。 | `src/components/rich-editor/RichEditor.tsx:3130-3163, 6888-6942`；`src-tauri/src/ai_provider.rs:52-97, 1765-1806`；`src/components/rich-editor/RichEditor.test.tsx:1014-1124` |
| AI Modification | “修改原文”结果先以临时预览替换可见目标，用户可以“对比”“撤销”或“接受”。只有点击“接受”后，它才成为 Committed Content。 | 流式生成中的预览也不等于已保存正文；失败、关闭或上下文切换会恢复原内容。 | `src/components/rich-editor/RichEditorRewriteWidget.tsx:208-290`；`src/components/rich-editor/RichEditor.tsx:3560-3715`；ADR-0003 |
| AI Answer | “生成回答”结果先显示在卡片中，用户可以复制、插入或关闭。只有点击“插入”后，回答才进入正文；复制不会改变正文。图片得到的文字同样不会改动图片本身。 | 自动模式可能同时产生 AI Modification 与 AI Answer，两部分仍分别需要接受或插入。无法解析的自动结果只能复制，不能写入正文。 | `src/components/rich-editor/RichEditorRewriteWidget.tsx:163-205, 212-290`；`src/components/rich-editor/RichEditor.tsx:3560-3687`；ADR-0002、ADR-0003 |
| Committed Content | 保存、切换、关闭、导出和其他父级保存读取的是 Committed Content：普通编辑保留，未接受的 AI Modification 投影回原文，未插入的 AI Answer 不进入正文。 | 不要把编辑器中的流式预览当作已保存内容。Record Export 也只读取保存后的 Committed Content。 | `src/components/rich-editor/RichEditor.tsx:1875-1964, 2351-2364, 5436-5459`；`src/components/project/ProjectNoteFocusPage.test.tsx:270-291`；`src/components/today/WorkspaceRecordFocusPage.test.tsx:244-256`；ADR-0003、ADR-0004 |
| Workspace 根目录 | 用户选择的 Workspace 根目录是长期数据边界。应用在其中创建 `.project-mind` 隐藏目录；Project 目录及受管 File 也位于 Workspace 根目录之下。复制或移动 Workspace 时应把整个根目录作为一个整体，并先确认内容已保存、退出应用。 | 当前没有云同步承诺。不要只复制 SQLite，嵌入图片、受管 File 和版本可能位于其他子目录。 | `src/components/workspace/WorkspaceGatePage.tsx:46-55`；`src-tauri/src/workspace.rs:80-123`；`src-tauri/src/db.rs:2498-2576, 8624-8692` |
| SQLite 与元数据 | `.project-mind/workspace.sqlite3` 保存 Workspace 的结构化业务数据与本地设置；`.project-mind/workspace.json` 保存 Workspace 标识、版本、安全模式和密码校验信息。数据库升级前会在 `.project-mind/backups` 自动创建 SQLite 快照。 | 升级快照只覆盖数据库，不是完整 Workspace 副本；不要引导用户手工编辑数据库、元数据或快照。 | `src-tauri/src/workspace.rs:14-17, 63-90`；`src-tauri/src/db.rs:420-445, 10552-10577` |
| 嵌入图片 | Workspace QuickNote / Workspace Record 中插入或粘贴的图片会复制到 `.project-mind/embedded-note-assets/workspace`；Project 内容中的嵌入图片会复制到对应 Project 下的 `.project-mind/embedded-note-assets/...`。正文保存本地路径引用。 | 只复制数据库会遗漏这些图片。图片缩略图不是原图。 | `src-tauri/src/db.rs:2579-2884, 8656-8692`；`src/components/rich-editor/noteImageAssets.test.ts:144-224` |
| 缓存 | 新建 Workspace 会创建 `.project-mind/cache/ai`。图片显示还会按需生成 `.project-mind/cache/image-thumbnails` 缩略图。 | 基线中 `cache/ai` 仅创建，未发现生产写入；不要把它描述成持久 AI 历史。不要建议用户通过删除缓存排障。 | `src-tauri/src/workspace.rs:80-107`；`src-tauri/src/lib.rs:445-477`；`src-tauri/src/ai_jobs.rs:19-26, 88-106` |
| 日志与临时目录 | 新建 Workspace 会创建 `.project-mind/logs` 与 `.project-mind/tmp`，作为本地日志和临时空间的预留目录。图片缩略图生成还会短暂使用 `.tmp` 文件。 | 基线未发现向 Workspace `logs` 或 `tmp` 写入生产内容的路径；不可承诺其中一定有诊断日志，也不建议用户清空。 | `src-tauri/src/workspace.rs:80-107`；`src-tauri/src/lib.rs:451-477` |
| 应用级会话文件 | 系统应用数据目录只保留 `workspace-session.json`，记录最近和最后打开的 Workspace 根路径；业务数据库不放在这里。应用启动会尝试重新打开最后一个 Workspace。 | 最近列表是路径记录，不是内容副本。路径失效时应通过“打开已有 Workspace”重新选择实际根目录。 | `src-tauri/src/workspace.rs:36-60, 170-194`；`src-tauri/src/lib.rs:64-67, 133-165, 1058-1076` |
| Workspace 密码边界 | Workspace 密码用于校验解锁，并派生密钥加密保存在 SQLite 中的 AI API Key。每次打开 Workspace 时，内容可以加载，但已保存的 AI secrets 默认锁定；要保存 Key、测试连接或运行 AI，需再次解锁。 | 密码不加密 SQLite 正文、Project 目录、受管 File、嵌入图片、缓存或日志。当前没有可见的密码重置/找回入口，不可声称忘记密码后能恢复已保存 Key。 | `src/components/workspace/WorkspaceDialogs.tsx:29-88, 101-154`；`src/components/settings/AiSettingsPanel.tsx:567-580, 727-731`；`src-tauri/src/workspace.rs:155-168, 234-255`；`src-tauri/src/secret_crypto.rs:10-99`；`src-tauri/src/lib.rs:179-216` |
| 离线能力 | Workspace 打开后，QuickNote、Record、Todo、Project、Tag、本地搜索以及对本地 File 的管理都由本地目录与 SQLite 支撑，可以在不调用外部 AI 的情况下继续使用。 | AI Provider 调用、AI 连通性测试和应用更新检查需要相应网络服务可达。离线不等于自动同步或异地备份。 | 本地命令与数据库：`src-tauri/src/lib.rs:505-1048`、`src-tauri/src/db.rs`；外部 AI HTTP：`src-tauri/src/ai_provider.rs:600-674`；更新插件：`src-tauri/src/lib.rs:1050-1057` |
| Record Export | Record Export 从单条 Workspace Record 或 Project Record 的 Committed Content 生成 Markdown/ZIP、DOCX 或 PDF 本地副本。缺失图片时可取消，或继续生成带占位提示的版本。 | Record Export 不是 Workspace Backup，不包含 Workspace 中其他对象、数据库、AI 配置或所有受管 File。 | `CONTEXT.md`；`src/features/record-export/RecordExportDialog.tsx:60-184`；`src/components/project/ProjectNoteFocusPage.test.tsx:270-291`；ADR-0004 |

## 常见故障与真实恢复路径

| 现象 | 最安全的恢复顺序 | 不建议做 | 证据 |
| --- | --- | --- | --- |
| 内容“找不到” | 先确认当前是 Workspace View 还是 Current Project View，再确认对象真实归属；从当前作用域筛选，最后回到 Workspace 顶栏搜索。Archive Project 默认不进入 Workspace 搜索结果。 | 不要先移动、重建或删除对象。 | `docs/help/context/search.md`；`docs/help/momentum/todo-scope.md`；`src-tauri/src/db.rs:4245-4259` |
| 最近的 Workspace 打不开 | 选择“打开已有 Workspace”，重新选中实际根目录；确认该目录仍包含 `.project-mind/workspace.json`。若目录被移动，最近列表中的旧路径不会自动更新。 | 不要创建同名空 Workspace 覆盖原目录，不要手工改 `workspace.json` 或 SQLite。 | `src/components/workspace/WorkspaceGatePage.tsx:60-78, 105-130`；`src-tauri/src/workspace.rs:125-139, 170-194` |
| 正文显示“保存失败” | 保持页面与应用打开，先把尚未确认的关键文字复制到另一个本地文件；确认 Workspace 所在磁盘可写且有空间，再做一次小编辑并离开编辑区触发保存，直到显示“已保存”。 | 不要以重启作为第一步，不要直接替换或删除 SQLite。 | `src/components/project/ProjectNoteFocusPage.tsx:200-215, 451-456`；`src/components/today/WorkspaceRecordFocusPage.tsx:190-205, 543-548`；`src/components/rich-editor/RichEditor.tsx:1875-1973` |
| File 显示“失效” | 确认原始材料仍可用，然后在正确 Project 中通过“导入文件”重新导入；先保留旧条目，核对新 File 可打开后再决定是否清理。 | 当前失效条目的打开位置和创建版本入口不可用；不要用删除旧条目来尝试修复路径。 | `src/components/document/ManagedDocumentSection.tsx:315-347, 558-570`；`src/components/document/ManagedDocumentSection.test.tsx:500-513`；`docs/help/momentum/project-files.md` |
| Record Export 失败 | 若提示导出前保存失败，先恢复正文保存；确认目标目录存在、可写并有足够空间。缺失图片时选择取消，或明确接受“占位版本”；其他错误可在原对话框中“重试”。 | 不要把成功导出的单条 Record 当作 Workspace 恢复副本。 | `src/features/record-export/RecordExportDialog.tsx:60-184`；`src-tauri/src/record_export.rs:690-720`；相关导出测试 |
| AI 菜单不可用 | 先到“设置”→“AI 模型配置”解锁 Secrets；确认配置已启用、声明文本/图片能力并完成默认绑定。再用“测试”或“测试图片能力（会产生调用）”核对 Base URL、模型、Key 与网络。 | 不要反复改正文来“激活”AI；图片不支持时不要改扩展名伪装格式。 | `src/components/rich-editor/RichEditor.tsx:3017-3035, 4630-4644`；`src/components/settings/AiSettingsPanel.tsx:521-735, 993-1029` |
| AI 处理失败或目标变化 | 未接受的 AI Modification 不会覆盖 Committed Content。可先“重试”；若提示目标或范围失效，关闭结果，重新选择文字或右键图片后再运行。AI Answer 可先“复制”保留。 | 不要把正在流式显示的结果当作已保存。 | `src/components/rich-editor/RichEditorRewriteWidget.tsx:106-205`；`src/components/rich-editor/RichEditor.tsx:3040-3045, 3270-3275, 3460-3473, 3688-3715`；ADR-0003 |
| Internal Reference 失效或无法保存 | 先确认目标没有被删除，且引用符合范围：Workspace 对象可引用 Project 对象；Project 对象只能引用同一 Project。失效引用应移除后重新选择有效目标。 | 不要用跨 Project 的相似对象冒充原引用。 | `CONTEXT.md`；`src/hooks/useInternalReferenceNavigation.ts:13-53`；`src-tauri/src/db.rs:2392-2434` |

## 明确不进入公开正文的推断

- 不宣称 Workspace 密码加密全部资料。
- 不宣称存在 Workspace 级自动备份、云同步、回收站或密码找回。
- 不把 `.project-mind/backups` 的数据库迁移快照写成完整 Workspace Backup。
- 不把 `cache/ai` 写成持久 AI 会话历史；基线只创建该目录。
- 不建议用户删除、重命名或手工编辑 `.project-mind` 内的任何文件来排障。
- 不把单条 Record Export 写成 Workspace Backup。
- 不根据 README 或 PRD 的遗留描述补写当前界面不可达的 AI 能力。

## 待核验项

以下项目在固定基线代码和测试中无法得到足够强的用户可见证据，因此正文保持保守：

1. macOS 与 Windows 安装包中，`.project-mind` 的隐藏属性和直接显示方式是否完全一致。
2. 在只读目录、磁盘空间耗尽和 SQLite 被其他进程占用时，界面返回的具体错误文字。
3. 真实 Provider 对请求的保留、训练和日志政策；这些由用户选择的 Provider 及其账户条款决定。
4. 跨设备复制 Workspace 时不同系统路径、系统字体和外部程序关联的兼容性。
5. `logs`、`tmp` 与 `cache/ai` 在后续发布版本中的实际用途和清理策略。

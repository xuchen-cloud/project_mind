# Project Mind AI 能力方向讨论稿

日期：2026-09-28。状态：早期方向讨论，保留为历史参考，不代表当前行为。当前范围以 [主规格](../requirements/ai-work-context-spec.md)、[工程契约](../requirements/ai-work-context-engineering-spec.md) 和 [交付验收](../requirements/ai-work-context-delivery.md) 为准；执行入口为 [父Issue #97](https://github.com/xuchen-cloud/project_mind/issues/97)。Overview是独立AI知识层，不复用QuickNote；当前计划不包含首页“继续工作”卡片。

## 产品目标

让 Project Mind 成为人和 Agent 共用的工作上下文：在 Project 内理解目标、资料、历史判断和下一步行动；在 Workspace 内理解跨项目工作和用户主动积累的长期信息。内置会话与外部 Agent 读取同一套业务对象，产出回到 File、Record、Todo，并保留来源和引用。

“了解整个上下文”应表示可按需检索完整的授权范围，而非每次把所有内容放入模型提示词。Workspace 范围也不等于自动读取电脑上的全部资料或其他 Workspace。

## 当前基础与缺口

依据 [领域语言](../../CONTEXT.md)、[系统设计](../system-design.md)、[业务接口](../../src/services/projectMindApi.ts)、[数据库实现](../../src-tauri/src/db.rs)。

- 已有 Workspace / Project、QuickNote / Record / Todo / File、File Version、内部引用、模型配置与 AI Job。
- SQLite 是业务事实源，File 内容在托管文件系统中。Record 不是原生 Markdown 文件；现有 Record Export 是可携带副本。
- 当前 AI Editor Skill 面向编辑器选区和图片，不能直接充当持久多轮 Agent 会话。
- 当前 `workspace_search` 覆盖 Record 等文本，但 File 查询主要匹配文件名、版本名和标签，尚不能等同于附件全文理解。
- 已有 `internal_reference_search` / `internal_reference_resolve`。本轮未找到独立的反向引用查询接口；完整的关系遍历能力需要单独核验和补充。
- Workspace 可以引用 Project 对象；Project 对象只能引用同一 Project 的对象。跨项目综合成果适合保存为 Workspace Record。
- 现有 WorkspaceRuntime 依赖 Tauri AppHandle；支持无界面 CLI 需要抽离或适配运行时，不是仅把前端接口换个名字。

## 一套业务能力，多个入口

```text
内置会话（Pi 候选） ─────────┐
外部 Agent → Mind CLI / MCP ├→ 共用业务服务 → SQLite + 托管 File
资料处理与自动整理任务 ──────┘       ↕
                           上下文检索与来源索引
```

业务服务统一负责作用域、对象 ID、读取、检索、写入、版本与变更通知。CLI、MCP、内置 Agent 使用相同规则，避免各自直接修改 SQLite 或各自实现一套 Record 保存逻辑。

需要区分两个接入方向：

1. **向外开放**：外部 Agent 调用 Project Mind CLI / MCP，读取上下文、创建 Record、注册 File、跟踪 Todo。
2. **向内连接**：Project Mind 启动或连接 Agent 执行任务。Pi 是内置运行时的候选；其他 Agent CLI 通过独立适配器提供能力。

对外提供 MCP server，与应用主动连接第三方 MCP server 是两个功能；后一项按具体使用场景再扩展，不应混在“开放 MCP”的首期范围内。

## 上下文组织

Project 上下文以项目目标、状态、当前 QuickNote、未完成 Todo、近期 Record 和 File 目录构成入口。根据问题再展开命中的正文、File Version 和内部引用。QuickNote 应标明临时内容；Archive 默认不进入活跃上下文，但可显式检索。

Workspace 上下文首先给出活跃项目概览、Workspace Record / Todo 和最近变化；按问题检索选定项目。跨项目读取不改变对象归属，也不自动放宽 Project Internal Reference 的合法范围。

每份上下文返回可定位来源、更新时间/版本、裁剪情况和资料处理状态。长内容采用“概览 → 搜索 → 精读 → 沿引用补充”的流程。摘要和索引可以重建；原始 Record、File、Transcript 仍是依据。

默认不跨 Workspace 检索。个人长期偏好或背景只来自用户放入 Workspace、并允许用于 Agent 的内容；从多次会话推测的偏好先作为候选信息。

## CLI 与 MCP 建议

命令名仅为设计草案，不表示现有可执行程序：

```sh
mind project list --workspace <workspace> --json
mind context get --workspace <workspace> --project <id> --json
mind search "方案取舍" --workspace <workspace> --project <id> --json
mind record get <id> --workspace <workspace> --json
mind record create --workspace <workspace> --project <id> --body-file result.md
mind file import result.docx --workspace <workspace> --project <id>
mind mcp serve --workspace <workspace>
```

资源按 Workspace / Project / Record / File / Todo / Reference 命名；聚合任务可增加“上下文概览”“带来源检索”“导入后整理”等高层操作。提供稳定 JSON、schema/help、明确错误码、分页、取消、写入幂等键与预期版本检查。对象必须在指定 Workspace 中解析，不能依赖“桌面此刻打开了哪个项目”。

MCP 先提供少量语义清晰的工具；只读内容可通过 resources 暴露，常用任务可提供 prompts。不要机械暴露所有数据库方法。写入经过同一业务服务，并使桌面页面缓存及时更新。

分阶段运行方式：第一步可连接已运行的桌面本地服务；后续再提供独立无界面 runtime。后者必须解决数据库并发、文件版本登记、任务生命周期、密钥解锁和 UI 变更通知。首期不应宣称支持关闭应用后的后台自动运行。

## 内置 Agent 与多个 Agent CLI

Pi 的具体能力见 [参考调研](ai-capability-reference-research.md)。候选架构是 Tauri 管理一个独立的 Agent 进程，通过 SDK 包装层或 RPC 传递会话事件和工具调用；React 展示会话，Rust 业务服务掌管实际业务写入。

默认向内置 Agent 暴露 Project Mind 领域工具。需要文件生成或命令执行时，再显式提供限定输出目录和相应执行能力；仅在提示词中约束目录不能形成真实的访问边界。

多 Agent 连接至少要区分：

| 连接方式 | 能力边界 |
| --- | --- |
| 在外部 Agent 中打开 | 带入项目目录和上下文入口；不保证应用能跟踪结果 |
| 应用内启动 CLI 任务 | 可跟踪任务结束和输出；流式输出、恢复、取消视 CLI 协议而定 |
| SDK / 结构化 RPC 接入 | 适合会话流、工具调用、审批/中断、恢复的深度集成 |
| 外部 Agent 使用 Mind MCP/CLI | Agent 自行编排，Project Mind 提供数据和业务操作 |

连接配置记录可执行路径、参数、协议、工作目录、能力检测和认证状态；不要将所有 Agent CLI 假定为相同协议。只有显式回传会话摘要或任务结果的外部 Agent，应用才有足够信息自动沉淀；不能承诺捕获任意外部聊天。

模型配置与 Agent 连接配置分开。尽量复用现有 AI Profile 的模型选择与密钥管理，而不是因接入 Pi 重做编辑器 AI。现有 Editor Skill Job 保持其短期编辑语义。

## 会话、产出和知识沉淀

会话负责探索过程；Record 负责值得长期保留的成果。会话历史应可恢复并保留用户原话、工具结果和产出关系，不应让摘要替代原始会话。

建议支持按会话或 Project 开启自动沉淀：任务完成或用户明确结束一段讨论时，创建或更新一条“AI 会话整理”Record，包含问题、确认的判断、未决问题、候选 Todo、来源和生成文件引用。区分用户明确确认的决定与 Agent 建议，避免把猜测记录成用户事实；流中断不等于任务完成。

自动整理使用会话 ID 与已处理消息范围去重；继续对话时增量处理。用户已修改的 Record 内容不应被无条件覆盖。自动新建内容需要独立的产品策略，不能通过编辑器自动保存绕过待确认 AI Modification / Answer 的规则。

用户提出“生成一份文档并保存在本项目”时，Agent 可以完成文件生成 → 注册 File → 建立 File Version / 产出关系 → 在会话 Record 中加入引用。只有写磁盘而没有注册，不算完成产品内交付。同名文件避免静默覆盖。

Record 通过业务接口保存；如用户需要真实 `.md` 文件，再生成 Record Export。若将来引入可编辑 Markdown 镜像，必须另行设计冲突处理与唯一事实源，不能把导出误当双向同步。

内部引用使用经过解析验证的稳定对象标识，而非由模型猜测标题。来源进一步记录 File Version、页码/段落或 Transcript 时间段。展示双向链接需要可查询的反向索引，不能只让模型输出 `[[标题]]`。

## 资料自动化处理

用户已确认参考 [Karpathy 的 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。它是知识维护模式而非可直接安装的应用；在 Mind 中借鉴持续维护可追溯理解的思路。除逐文件摘要，还应维护跨来源的主题综述、概念关联、矛盾与待验证问题，这些可落为带来源的 Record。Workspace/Project 可保存维护规则，定义资料摄入、成果落位、引用与更新约定。

```text
File 导入/版本变化、Record 保存、Transcript 完成
    → 提取内容并定位来源
    → 更新可重建检索索引
    → 生成摘要、候选关联和待处理问题
    → 根据自动化设置沉淀 Record / 提议 Todo
    → 标记旧派生内容过期，按需重建
```

原始资料、机器生成的摘要、用户确认的结论保持可辨。机器摘要不能相互引用后被误认为多个独立事实来源。新文件处理按内容哈希和版本增量执行，任务可取消、重试、去重；失败时保留原文件并明确哪些资料尚未被理解。

首期覆盖 Record 与可提取文本的 PDF/Markdown/文本文件；扫描件 OCR、复杂表格、音视频等按实际需求扩展。先验证关键词全文检索与引用回溯，再根据真实检索失败引入语义检索。

自动化默认先做内容提取和索引；是否自动保存摘要 Record、生成正式 Todo，应作为用户可设置的行为。现有 Tag 的作用域保持不变。

## 菜单与设置

建议将设置组织为“模型”“Agent 连接”“CLI 与 MCP”“自动整理”；Project 可以覆盖 Agent、自动整理策略与上下文范围。

菜单是任务入口：选中文字进行现有 AI 编辑；Record 可“带入会话”；File 可“整理资料”；Project 可“总结进展/生成产出/用外部 Agent 打开”。配置描述动作名称、出现位置、输入范围、执行方式、目标 Agent 和结果落位。菜单项绑定受支持的操作/任务模板，不等同于保存一段任意 shell 字符串。

继续复用现有 AI Editor Skill 作为选区任务；跨文件、多步骤任务应独立配置，避免改变该领域对象的既有含义。

## 建议推进顺序

1. **可理解**：共用读取接口、Project 上下文、带来源搜索、最小 CLI/MCP。验收：外部 Agent 回答项目目标、现状、未决问题时能追溯来源，并遵守作用域。
2. **可产出并回存**：Pi 最小内置会话、Record 新建、File 注册、版本检查、桌面刷新。验收：一次会话生成项目文件，并产生有来源和文件引用的 Record。
3. **可持续整理**：导入提取、增量索引、自动会话沉淀、反向引用检索、失败重试。验收：文件更新后能识别旧结论使用的版本，重复事件不产生重复 Record。
4. **可扩展执行**：更多 Agent CLI、可配置任务菜单、无界面后台运行。验收：连接能力真实可检测，取消和恢复有明确行为。

第一个演示场景：在项目内发起“根据现有资料生成方案，并保存到项目” → Agent 找到相关 Record/File → 回答带来源 → 生成 File → 保存总结 Record 和文件引用 → 外部 Agent 可通过同一 CLI/MCP 继续该工作。

## 需要继续收敛的选择

- 用户已确认参考 [nexu-io/open-design](https://github.com/nexu-io/open-design) 和 Karpathy LLM Wiki；仍需收敛希望借鉴的菜单是模型/Agent 选择、MCP 设置还是可配置任务入口。
- 自动沉淀的默认触发点，以及允许自动保存的内容范围。
- 首期是否要求桌面应用关闭时仍能运行；这直接影响 runtime 抽离范围。
- 首个要连接的外部 Agent，以及其所需的深度是“打开继续工作”还是“应用内运行并回传结果”。

## 与现有决策的关系

不修改现有正式领域文档和 ADR。若后续方案选择后台覆盖编辑器正文，将与 [ADR-0003](../adr/0003-persist-only-committed-editor-content.md) 冲突；如果重新设计默认模型选择，需要重议 [ADR-0001](../adr/0001-resolve-ai-models-by-default-role-and-skill-override.md)。Record 文件化/双向同步也超出现有 [ADR-0004](../adr/0004-generate-record-exports-from-one-document-model.md) 的只读导出边界。

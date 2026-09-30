# AI 能力参考调研

- 核对日期：2026-09-28。
- 状态：讨论阶段的外部证据；不是已经实现的能力，也不构成技术选型决定。
- 范围：飞书 CLI、Open Design、LLM Wiki、Pi Agent 的官方文档与源码。未安装这些项目，未运行集成验证。

## 参考对象身份

| 用户提到的名称 | 本次采用的一手来源 | 确定程度 |
| --- | --- | --- |
| 飞书 CLI | [larksuite/cli](https://github.com/larksuite/cli) | 官方仓库明确由 larksuite 维护，与描述一致。 |
| Open Design | [nexu-io/open-design](https://github.com/nexu-io/open-design) | 用户已提供准确链接并确认。 |
| llm wiki | [Karpathy 的 llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | 用户已提供准确链接并确认；它是一种知识维护模式说明，不是成品应用。 |
| Pi Agent | [earendil-works/pi](https://github.com/earendil-works/pi) | 原 `badlogic/pi-mono` 地址当前跳转到此仓库；以下以当前官方文档为准。 |

## 飞书 CLI：适合借鉴的调用设计

官方提供三层命令：面向任务的快捷操作、映射平台接口的命令、原始 API 调用。还提供机器可读结果、分页、`--dry-run` 和 `schema` 参数自省；错误与成功使用明确的结果信封。来源：[官方中文 README](https://github.com/larksuite/cli/blob/main/README.zh.md)。

对 Project Mind 的建议（推导）：先把“读取 Project 上下文”“创建带来源的 Record”“登记产出 File”做成少量稳定任务命令；再提供对象级操作。`--json`、显式 scope、有限分页、稳定对象 ID、可识别错误、写入预览比命令数量更重要。Mind 目前不是大型开放平台，不必照搬原始 API 逃生通道，更不应将任意 SQL 暴露为 Agent 接口。

## Open Design：必须分清两个连接方向

**外部 Agent 使用应用能力。** 官方提供 CLI/Skills/MCP，并在 Settings → MCP server 中提供按客户端生成、带绝对路径的配置；`od mcp install <agent>` 有预览与卸载选项。来源：[官方 README](https://github.com/nexu-io/open-design#platform-compatibility)。

**应用使用外部 Agent 执行任务。** Runtime adapter 以声明式定义描述二进制探测、参数、流格式和能力；共享引擎处理启动、调用及解析。不同 CLI 的协议和能力仍有差别，不能假定一次适配天然支持任意 CLI。来源：[官方 Agent Adapters](https://github.com/nexu-io/open-design/blob/main/docs/agent-adapters.md)。

已核实的 MCP 路径是 stdio adapter 转发到运行中的本地 daemon HTTP API；工具包含项目、文件、当前界面上下文及产出相关操作。daemon 不可达时，schema 可列出但业务调用失败。该源码还区分只读重试与可能已提交的写入，避免连接失败后盲目重复变更。来源：[mcp.ts](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/mcp.ts)。

可借鉴到 Mind 的设置（设计建议，非复刻承诺）：分别设置“内置助手”“连接外部 Agent”“向外开放 Mind”；显示连接状态、作用域、能力和配置预览。用户所说“菜单的配置方式”究竟指模型/CLI 选择、MCP 配置还是技能菜单，尚未确定；目前仅核实了前两类相关入口。

## LLM Wiki：借鉴持续维护，而非另建事实源

2026-09-28补充：渐进披露、index-first、关联知识页及qmd固定版本源码的详细核对见 [专项调研](llm-wiki-progressive-disclosure-research.md)。下文为最初概括；当前Mind设计以主规格及工程契约E3～E5为准，派生知识层独立维护，不要求每份摘要转成Record。

Karpathy 原文描述三层：保留原始来源、由 LLM 维护的关联知识页、指导维护的 schema；主要操作是摄入、带引用查询和检查过时/矛盾/孤立内容。回答中的有用成果可以继续沉淀为知识页。原文明确没有规定唯一实现和目录结构。来源：[llm-wiki 原文](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。

对 Mind 的建议（推导）：File/File Version 保留材料依据；抽取文本与检索索引作为可重建派生层；Record 承载值得保留的摘要、判断和关联；维护任务依据来源版本更新派生内容，并记录何时、由哪些材料形成。不要把 AI 摘要重新当成原始证据，也不要为了复刻 Markdown wiki 另建一套与 SQLite 并行的权威知识库。

## Pi：可用作运行时，但业务语义仍属于 Mind

当前官方包为 `@earendil-works/pi-coding-agent`。SDK 支持 Node.js/Bun 进程内嵌入，可替换工具、资源加载、模型和会话存储，提供流式事件、取消、继续与会话分支。来源：[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)。

Rust/Tauri 可以通过 `pi --mode rpc` 控制独立子进程。协议为严格 LF 分隔 JSONL，命令响应与会话事件分开；`prompt` 成功表示已接收，不表示执行完成；当前文档使用 `agent_settled` 判断不会自动继续。宿主负责进程异常、超时和退出。来源：[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)。Open Design 自身也有使用 `--mode rpc` 的 [Pi runtime 定义](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/defs/pi.ts)，可作为适配实例。

Pi 的工作目录不是文件权限边界，Project Trust 也不限制工具运行时可访问的路径；它没有默认逐次工具授权弹窗。来源：[官方安全边界](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)。因此“设置 cwd 到项目目录”不能实现 Mind 的 Project 隔离。应优先提供受作用域约束的领域工具，并单独决定通用 shell/文件工具的开放范围。扩展可注册工具，并在 `tool_call` 阶段修改或阻止调用；这仍不等于操作系统级隔离。来源：[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。

**选型判断（推导）：** Pi 是可行候选。Tauri 中较自然的原型是 Pi 子进程，或运行 Pi SDK 的 Node sidecar；需要实际验证打包体积、启动、事件映射、停止/恢复、凭据隔离和版本兼容。不能视为可直接运行在 WebView 的浏览器库，也不能认为它自动具有 Mind 的 Record、File Version、Internal Reference 或 MCP 开放能力。

Pi 会话历史与上下文压缩也不等同于用户可查找引用的 Record。自动总结应由 Mind 的领域工作流生成，关联原会话、来源对象与产出 File；自动创建新 Record 和自动覆盖既有用户正文应分开定义。

## 与本仓库约束的衔接

这些是基于本仓库领域文档的约束，不是外部项目事实：

- [CONTEXT.md](../../CONTEXT.md) 定义 File 属于 Project；Workspace 的长期信息当前以 Workspace Record 等对象表达。若需要 Workspace File，属于新增领域能力。
- Internal Reference 允许 Workspace 对象引用 Project 对象；Project 对象只能引用同一 Project 内对象。跨项目知识汇总应先在 Workspace 完成，不能默认允许 Project 全局检索和引用。
- [ADR-0003](../adr/0003-persist-only-committed-editor-content.md) 要求只持久化已确认的编辑器内容。新增 Agent 自动写回语义必须单独确定，不能借会话总结绕过既有正文确认规则。
- [ADR-0001](../adr/0001-resolve-ai-models-by-default-role-and-skill-override.md) 已定义模型 Profile 与默认/Skill override。运行时选择与模型选择属于不同维度，新增设置应解释两者如何协作。

建议共享同一领域服务：GUI、CLI、MCP、内置 Agent 都通过它读取对象与提交变更。上下文摘要是带作用域、来源和时效的派生视图；对话是会话；长期成果进入现有 Record/File，避免每种接入各维护一套状态。

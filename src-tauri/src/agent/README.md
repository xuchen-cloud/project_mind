# AI 工作上下文代码框架

本目录承接[工程契约](../../../docs/requirements/ai-work-context-engineering-spec.md)。AI-02 的基础持久化、权限和共享服务已接入，运行时与业务写工具仍按各自工单推进；进度由 [#97](https://github.com/xuchen-cloud/project_mind/issues/97) 及子工单维护。

## 已接通的最小路径

```text
agentApi.contextGet(binding, question)
  → agent_context_get（本地 GUI 适配器）
  → RequestContext / ScopeGrant / Workspace generation 校验
  → AgentDomainService.context_get
  → WorkspaceContextRepository（现有 Workspace 数据库）
  → 有界 L0：独立项目身份 + 已有 Overview 的授权定位与覆盖状态
```

`agent_status_get` 返回当前 Workspace UUID/本次打开 generation、能力清单和 runtime/bridge 可用性。`agent_context_get` 读取独立身份及有界 Overview 快照，并核对来源归属、排除和失效元数据；不调用项目整页、原文提取或 File 字节读取。Workspace 入口也只返回身份，不聚合项目。每个新 WorkspaceRuntime 生成独立 generation，关闭或重新打开后旧 binding 失效。

Project 有已发布 Overview 时，L0 返回首个可见 profile 的 ≤300 字符定位；未建立时保留 not_built，覆盖未证明完整时不标 ready。`agentApi.overviewGet` → `agent_overview_get` → `OverviewService.get` 提供目录及显式选择后的有界读取，默认不返回正文。L0 返回最多 8 个实际 node:/overview: 导航 ID，推荐已接通的 Overview 与 knowledge.get/search；没有节点时不虚构。它没有模型费用，也不修改用户资料。调用方应在用户提出问题后请求 L0，不能在空会话 mount 时预加载正文。

## 模块和接入顺序

| 位置 | 当前职责 | 后续工单 |
| --- | --- | --- |
| `models.rs` / `errors.rs` | scope、对象/版本化来源、消息引用、统一响应/带 details 的错误 | AI-02 |
| `access.rs` | 显式 Workspace 代际和范围/操作授权；对象真实归属校验入口 | AI-02 |
| `repository.rs` / `service.rs` | 与 Tauri 无关的共享服务；元信息 repository 接缝 | AI-02/03 |
| `commands.rs` / `../db/agent*.rs` | GUI adapter、真实对象归属、Schema 26、CAS/幂等事务/outbox | AI-02 |
| `settings.rs` / `instructions.rs` / `changes.rs` | 用户 scope 配置、上下文说明、授权分页变更补读 | AI-02 |
| `context.rs` | AI Overview 独立 DTO、L0 上限、每 run 字符预算 | AI-04 |
| `maintenance.rs` | 来源变化、水位批次与成功后确认的 repository 契约 | AI-03/04/11/12 |
| `sessions.rs` / `model_history.rs` / `source_trace.rs` | Pi 原文搜索回读、可信输入来源账本、分段摘要契约 | AI-05/08 |
| `runtime.rs` | Run 状态机、运行时适配器、带 Workspace 代际的事件 | AI-01/05/13 |
| `outputs.rs` | 正文树块操作、CAS、File Version 基线、成果及收据契约 | AI-07/16/17/19 |
| `capabilities.rs` | 操作权限与实现状态的共同发现入口 | AI-09 |
| `../bin/mind.rs` | `mind --version` / `mind capabilities --json` | AI-09 |
| `../../../packages/agent-host` | 独立 Node 包，JSONL 帧验证、握手和关闭 | AI-01/05 |
| `../../../src/services/agentApi.ts` | typed Tauri API、结构化错误 | AI-06 |
| `../../../src/lib/agent-query-keys.ts` | Workspace + generation + scope 的查询隔离 | AI-06 |

## 会话记忆接入

`session.search` → `session.messages.read` 从独立历史索引定位，再经 Pi checkpoint 校验读取原文。schema 35 记录 Host 实际交付给 Run 的来源依赖；每次 provider 请求前调用内部 `session.context.check`，过滤无权历史并检查当前 Run 已观察来源。该内部检查不暴露为模型工具，也不占业务工具次数。

R10 维护批次从原始消息生成 `KnowledgeNode.session_summary`，与 Overview 同事务发布；`source.search`/`source.read` 支持 `session_summary`。用户通过已有知识详情查看计划、建议、决定、操作收据及替代状态。来源排除同时影响派生读取与继续会话，可信 GUI 的原文查看保留。实现边界、开源依据与验收状态见[会话记忆设计](../../../docs/conversation-memory.md)；CLI/MCP transport 仍由 R12 接入。

## 不应绕过的边界

- QuickNote 的 `summary*` 历史列和 `quickNote*` API 仍属于用户缓冲区。Schema 26 通过既有升级备份和事务 savepoint 建立基础公共表，默认关闭助手，不初始化会话或入队；Overview/知识/Record 版本表由各自工单建立。升级与重开不会重新引入已退役的 Activity/Conclusion 表。
- `RequestContext` / `ScopeGrant` 不支持反序列化。GUI 适配器可由用户选定 scope 创建本地只读 grant；外部 bridge 必须从连接凭据读取真实 grant，Pi 必须绑定 run grant，不能复制 GUI 授权逻辑。
- 外部对象参数先由存储解析真实归属，再通过 `authorize_object` 验证，不能只相信参数中提供的 Project ID。Workspace 内容权限不隐式授权所有项目；项目列表须显式给出。
- `RuntimeAdapter` 只描述运行接口，`RunState.transition` 只检查状态转移。AI-05 必须在最终消息和工具结果持久化、SDK settled 后才能提交 completed；还需持久化和取消结算。当前没有活动 run 或后台计时器。
- `OutputIntent` / `RecordPatch` 是未开放的写入契约。节点白名单、Record 版本、File staging/恢复、幂等收据和事务 outbox 完成前不得注册为可执行工具。File 更新复用既有 File Version；HTML 保存源码，隔离预览由 AI-18 接入。
- `capabilities.implemented` 描述共享服务状态，不代表 CLI/MCP transport 可用。`context.get`、`context.overview.get`、`knowledge.get/search`、配置/说明读写和 `changes.list` 当前通过 GUI 命令调用。CLI 没有读取 Workspace 文件、开启第二个数据库或建立网络监听；`mind mcp serve` 在 stderr 明确报不可用并退出 3，stdout 保持空。
- Agent Host 不进入 Vite 依赖图。运行时是否开放由 AI-01 的捆绑 Node、真实模型、SessionStore codec 和安装包验证共同决定，不把本机开发 Node 当成发布方案。
- 尚未接入助手面板或首页入口，因此产品不会显示无法完成任务的聊天框，也不会新增“继续工作”卡片。

## 本地验证

```sh
npm run test:agent
npm run build
npm run check:bundle-boundaries
cargo run --manifest-path src-tauri/Cargo.toml --bin mind -- --version
cargo run --manifest-path src-tauri/Cargo.toml --bin mind -- capabilities --json
```

以上命令不会启动 Tauri 应用窗口。后续完成 AI-01 技术验证，并推进 AI-16 块版本和 AI-03/04 知识层；接口契约通过后再开放写入及聊天 UI。

## 基础持久化契约

- `agentApi.settingsGet/settingsUpdate` 读取或保存所选 scope 的用户配置；CAS 基线为 `revision`，新 scope 是 0，首次保存为 1。只允许 GUI 修改，模型/外部连接即使携带相同操作字符串也不能改变执行策略。目标 Record 和最多五个 pins 从业务表解析真实归属。
- `instructionsList/instructionUpsert/instructionDelete` 保存与 QuickNote 分离的用户上下文说明，正文最多 2000 Unicode 字符。ID 随机、归属不可移动、更新/删除有 CAS；分页上限 100。
- 配置与说明提交在同一个短事务中写业务数据、成功 receipt 和 outbox。相同 caller/request/payload 重试直接返回原结果；换 payload 或 operation 返回 `IDEMPOTENCY_CONFLICT`。失败会全部回滚，成功收据不裁剪。metadata outbox 的 `agent_settings/<scope>` / `agent_instruction/<id>` 是配置键，不是可引用的业务 SourceRef。
- `changesList` 对授权 scope 在 SQL 中过滤，单页最多 200；返回 cursor/hasMore/resetRequired。消费端不能拿这份 scoped 返回值推断其他项目标题或对象。业务写入口及提交后事件分发由 AI-03/07 接入，不能把当前 metadata outbox 误当作全量业务变更流。
- 基础 session/run/message/output 表只提供约束：可移动相对 session_path、同 Workspace 一个活动 run、会话级联及 message evidence 清理；不开放假会话/写成果能力。Overview 和 QuickNote 始终分别存储。

## 本地来源服务阶段（AI-03，尚未开放）

`../source_service.rs` 与 `../db/sources.rs` 为已初始化 Record 提供有界正文/块/段落读取、固定修订游标、真实归属与最新策略复核；`../source_search_index.rs` 是可重建的 FTS5 trigram 缓存。当前 head 替换旧缓存，不逐次保留 autosave 正文；显式保留版本另带 Record Version。来源服务核对正文及 metadata 修订，返回前再次核对 Workspace binding，缓存不授予访问权限或成为独立事实源。

这些内部方法尚未注册为工具，source.search/read 的 implemented 仍为 false。File 登记 hash、旧 Record 基线、其他来源、typed reference、GUI 业务事件和持久后台队列仍在 AI-03 内继续实现。排除策略须走 GUI 共享服务的 settings.write/CAS/幂等事务；缓存 payload 统计不能替代数据库实际文件大小。详情见 [来源实施记录](../../../docs/technical/source-extraction-implementation.md)。

知识的确定性发布、来源检查和有界读取见[Overview/知识实施记录](../../../docs/technical/ai-overview-implementation.md)。knowledge.search 未命中时只返回 sourceFallbackRequired；真实原文回退仍受 source 工具开放门槛约束。

# 会话记忆：原文检索与派生知识

更新：2026-10-09。状态：GUI 回读与历史树索引已实现；R11b2～b4 的模型访问、增量摘要和 Overview 集成已完成确定性集成验证，真实模型往返与目标平台验收仍待完成。交付顺序和验收见[交付计划 R11](requirements/ai-work-context-delivery.md#r11-会话成为可追溯知识--105102)；产品目标和 E5 规则分别见[主规格](requirements/ai-work-context-spec.md)与[工程契约](requirements/ai-work-context-engineering-spec.md#e5)。本文件细化检索先行的切入点。

## 决定与边界

Pi JSONL 是会话原文的唯一权威。R11a GUI 回读已按锚点定位原始讨论（`a645733`）；现有数据库也有经过校验的**当前分支** Pi 消息投影。搜索索引先从该投影建立；schema 34 将索引归属改为会话，并从 JSONL 分批回填完整历史树，切换当前分支不会清除旧分支索引。SQLite 索引是**可删除、可重建的搜索投影**，记录可检索的用户/助手正文及必要元数据。搜索命中后仍从经过校验的 JSONL 读取原文，不拿索引摘录当事实。索引和摘要都能在来源变化后重建，重试不制造新的原始消息身份；压缩、重试分支不改旧引用。分段摘要、当前结论和 Project Overview 是后续可选择的派生层，模型调用失败时原文检索仍可工作。

每个可引用范围带 `workspaceId、scope、sessionId、branchId、messageId、ordinal/片段范围、contentHash`；范围 hash 用于发现原文改变或引用失效，不能只用一个短内容 hash 当全局身份。增量游标表示**处理进度**，不是结论的证据。读取单页上限 50 条消息、12000 字符；超长消息切片并保留消息 ID、片段范围和全文 hash。搜索返回少量标题/摘录/命中身份、覆盖状态和下一步读取线索，工具不允许模型扩大页大小或搜索作用域。直接引用精确决定、原话或执行结果时回读相应原文与实际 Operation Receipt。

索引沿用已有 SQLite FTS5 trigram 与中文短词 `LIKE` 回退路径，必须在中文短词、句中匹配和混合文字上有效；[SQLite trigram 文档](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)说明少于三个 Unicode 字符的完整查询不能由该 tokenizer 匹配，不能把默认 FTS 命中当作中文可用性的证明。现有实现参考 [SourceIndex 检索](https://github.com/xuchen-cloud/project_mind/blob/main/src-tauri/src/source_search_index.rs)。新投影消息同事务摄入，历史分支从 JSONL 分批补齐并持久记账；新增消息按稳定 ID 增量对账。索引损坏或版本变更可从原文重建。未覆盖、索引失败、原文失效分别返回真实状态，未命中不能推断“从未讨论”。搜索排序和显示不应让工具/自动运行日志压过用户讨论。先用原文定位让 A61 可用，再逐段添加摘要。

## 历史树索引的已实现边界

内部 `session.history.scan` 不打开模型会话，不要求 Profile。它校验 Pi checkpoint，按 JSONL 顺序返回各分支的用户/助手正文；不索引工具结果、思考内容及失败助手文本。消息自己的 entry ID 是可回读分支锚点，ordinal 按该分支祖先链计算。单次响应至多 200 个片段、262144 个 Unicode 字符，游标持久保存 entry offset 和消息内字符位置；完整消息 hash 校验通过后才进入 FTS。每页输出遍历最多 1000 个条目，但 checkpoint 仍按现有文件上限完整读取与校验，不宣称流式文件扫描。

`agent_session_scan_state` 保存已校验 checksum、entry count 与下一页游标。checkpoint 追加后，用原始 JSONL 字节前缀 hash 证明旧进度仍有效，再从原位置继续；历史被改写返回冲突。外部读取期间不持有 Workspace/DB 锁，提交时复核 Workspace、checkpoint、扫描状态和活动 Run。会话删除级联清理索引及游标，当前分支切换保留旧消息。GUI 一次查找推进一页，覆盖不足显示“继续查找”；全部覆盖后才开放结果分页。索引覆盖与查询命中分别表达。

GUI 搜索保留原生已知 Run 身份；未知历史归属保持空值，不把内容或时间猜测当归属证明。`session_message` 的来源身份及策略校验已支持当前和历史分支，要求 `session.read` 与相应来源操作授权；排除不影响可信 GUI 搜索。另有独立的模型 `session.search`、`session.messages.read` 工具，从已授权消息索引定位并从 Pi JSONL 校验回读，不能复用 GUI grant；历史索引缺口有覆盖状态，读取按消息和字符预算分页。R12 外部 CLI/MCP 已接入这两个模型历史工具，调用仍须具备 `session.read` 授权；入口见[工具注册](../src-tauri/src/agent/bridge/registry.rs)、[CLI 路由](../src-tauri/src/agent/bridge/cli.rs)与[MCP 路由测试](../src-tauri/src/agent/bridge/mcp_tests.rs)。

## 当前实现与待验证边界

R11b2 在 schema 35 建立 Native Run 的观察标记和扁平来源依赖，只保存 ObjectRef 与可选版本，不保存正文。可信 Host 在 Run 开始时记录初始来源，在工具结果交付模型前记录实际来源；每次 provider 调用前按实际进入上下文的消息 entry ID 复核历史依赖、对象归属、删除、撤回和 AI 排除。允许的历史来源会继承到当前 Run。旧 assistant/tool 没有可信完整来源账本时从模型上下文省略，旧 user 消息仍按自身来源政策逐条判断；GUI 原文历史保持可见。该边界也用于独立的模型历史搜索与读取，不能以索引里的 run_id 推定完整来源。

R11b3/b4 复用 `agent_change_log` → `source_registry` → Project Overview pending：完整消息初次索引或有效正文变化时产生 source 事件，分片扫描完成前不发；切换当前分支不把旧历史误作删除，真实会话删除在级联前写 tombstone。存量已完整索引消息按 registry/hash 批量补种；Overview 调度能发现未扫完的 Pi checkpoint 和待补种消息。共享 R10 维护批次从原文读取并捕获实际页，把每条消息或长消息片段作为本轮最小处理单元；虽然读取接口上限是 50 条/12000 字符，当前维护批次**每批只处理一条消息或一个片段**。摘要以 `KnowledgeNode.session_summary` 不可变版本保存，类型化陈述区分计划、建议、明确决定、用户报告和成功的原生操作收据；同当前分支的前序消息才可作为替代目标。摘要和 Overview 在同一 R10 原子发布事务结算，不增加独立摘要 worker。知识详情仍走原 GUI 渐进分页入口，派生内容按当前来源策略动态过滤；模型 `source.search`/`source.read` 可定位和读取摘要。

以上接入已完成确定性集成验证：Rust 全库 795 项通过，3 处失败修正后来源 150 项和会话发布集成 1 项通过；30 个依赖外部运行条件的忽略项仍单列。Node Pi 42 项、协议/worker 16 项、打包原文链路 1 项、相关前端/API 61 项通过；原文卡去重后知识 UI 12 项及 TypeScript 检查通过。生产构建与桌面资源检查通过，实际前端组件的无窗口浏览器单页/分页场景通过（模拟 IPC）。详细证据和验证范围见交付计划 R11。预算复用 R10 的批次和 Workspace 上限；每 Project 每 UTC 日最多 5 次摘要模型调用，失败尝试计入，普通业务与已生成草稿不因摘要配额停止。

仍缺真实供应商往返及 Windows/macOS 目标设备验收；R12 外部 CLI/MCP 已接入 `session.search` 和 `session.messages.read`，使用时仍须具备 `session.read` 授权。因此不把这些确定性结果当作完整 R11 产品验收或关闭关联 Issue。

2026-10-09 [整体审视](requirements/ai-work-context-delivery.md#intent-audit-20261009)另确认一项实现差距：当前每生成批次一条消息/片段、每日最多 5 次摘要调用，尚不能把正常多轮会话高效整理为有上下文的消息段。原文检索可以先回答历史问题，但不能据此宣布摘要维护已达到预期。下一步在现有 R10 批次内合并同会话、同分支、授权一致的有界增量，继续保留来源身份、失败续跑和日额度；不引入第二套记忆存储或独立摘要调度器。

## 来源、结论和失效

摘要按消息段更新，短会话的实质决定同样进入待处理。条目分清用户**计划**、模型**建议**、用户明确**决定**、以及由原生成功收据证明的**实际完成**；明确用户报告可作为“用户报告已完成”而非原生执行收据。失败或取消的 Run 不变成成功。摘要声明引用到的原始消息，涉及资料时也引用资料原始 SourceRef。引用验证能证明可追溯和范围归属，**不能证明模型归纳正确**；纠正或冲突时回读原文并更新当前结论。新决定可使旧结论标记为已替代，旧理由及当时语境仍可检索。没有新消息或有效正文变化时不重复生成/发布。

AI 检索/读取边界由可信 Host 的调用者身份与 Scope Grant 决定，模型参数和会话正文都不能扩大它。Project 仅见本 Project；Workspace 仅组合明确授权的直属和项目范围；外部连接需要 `session.read`。AI 来源排除与权限过滤同时作用于模型可见的搜索标题、摘录、原文读取、摘要、Overview 和旧派生版本的动态展示；只隐藏链接但留下混合来源结论仍是泄漏。**可信 GUI 中用户查看自己的原始会话或 File 历史仍可见，不受 AI 来源排除影响**；真实删除另按对象生命周期处理。会话/消息删除或 AI 排除后，立即从 AI 检索投影移除或禁止可见，并对其派生条目执行来源过滤/失效；不能等待夜间模型维护。对 AI 的旧引用返回失效。已独立保存的 Record/File 和操作收据依其自身生命周期处理，不因会话删除自动消失；来源卡片应如实显示失效。真实权限过滤是本包前置约束，但全库会话依赖图和“一律禁用所有旧会话”不是原文索引上线前置：先对已知 session/范围/派生来源做确定性边界，无法证明安全的混合条目保守不返回。

## 外部证据与复用判断

| 来源 | 已核对的机制 | 对本项目的取舍 |
| --- | --- | --- |
| [Hermes `session_search_tool.py`，固定提交 `3b0dc776`](https://github.com/NousResearch/hermes-agent/blob/3b0dc776b6602b0dd05429d7842bb143d73434b7/tools/session_search_tool.py) | FTS 发现、会话归并/降权、锚点附近窗口和更深层读取分开；返回命中和有限上下文。 | 借鉴“发现→有界回读”与噪音降权；不复制其会话 DB/谱系规则，Mind 以真实 Project/Workspace 授权为准。 |
| [DeepSeek Harness SQLite 查询包，固定提交 `5badb150`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/session-query) 与[模型工具包](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/session-query/tool-session-query) | 派生 SQLite 索引可由来源对账重建；模型工具在可信调用方边界校验范围，并分开 search/read。 | 借鉴重建与工具边界；不移植 `cwd` 相等作为 Mind 权限，也不照搬完整事件 trace 工具集。 |
| [Pi Observational Memory，固定提交 `022da5e`](https://github.com/elpapi42/pi-observational-memory/tree/022da5e5554d04dfdc876ed7dac4a42c6b83dfd4) | 来源 ID 回读、进度水位与证据分离、分支内投影；少量 `fold/projection/recall` 等纯逻辑可作参考。 | 可改写/移植小型确定性来源校验逻辑；其投影仅当前分支，`drop` 是可见性裁剪并非隐私删除，压缩 hook 可能同步补处理，不能当跨会话记忆系统直接接入。 |
| [Letta 会话](https://docs.letta.com/concepts/conversations/) 与 [MemFS](https://docs.letta.com/concepts/memfs/)，[LangMem 延迟处理](https://langchain-ai.github.io/langmem/guides/delayed_processing/) | 会话与持久记忆分层；背景整理可合并/延后。 | 借鉴层次与维护节奏，复用本项目 R10 持久批次；不引入另一套 MemFS/worker。 |
| [OpenCode 压缩说明](https://opencode.ai/v2/docs/compaction) | 压缩通过摘要让活跃会话继续，旧上下文经压缩后有损。 | 不把模型上下文压缩当跨会话原文索引或长期记忆；Mind 仍从 Pi JSONL 回读。 |
| [Mem0 固定提交 `b7ad69a`](https://github.com/mem0ai/mem0/tree/b7ad69afda6b6ed030347c66d48a13e4de9dec08) 与 [Graphiti 固定提交 `1026ae7`](https://github.com/getzep/graphiti/tree/1026ae7ae25e7e4cfcc1c7ebe00347b8a90f52a0) | 都提供来源/关系建模思路，但分别增加向量存储和图后端等集成成本。 | 借鉴稳定来源 ID、时间效力和删除失效；本轮不整包移植，不新增向量/图服务或用户画像。 |

外部源码是设计证据，不是本项目功能测试。上述固定版本源码链接可复核具体机制。R11 的真实验收仍须以本项目的中文检索、权限、删除、回读和模型会话往返为准。

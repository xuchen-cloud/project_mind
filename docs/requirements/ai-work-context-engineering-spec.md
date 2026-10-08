# AI 工作上下文：工程契约

更新：2026-10-08。状态：实施中，内部服务与产品接入进度不同。与[主规格](ai-work-context-spec.md)、[交付与验收](ai-work-context-delivery.md)共同构成开发依据。这里集中定义接口、数据、并发、预算与故障处理；Issue状态以GitHub为准，2026-10-08代码核对与后续执行顺序见交付计划D2a～D2d。

文中的E编号是稳定工程主题编号。产品流程先读主规格，实现具体模块时按下面目录进入；不存在“较后补充章节覆盖前文”的规则。

- [E1 领域边界与现有代码](#e1)
- [E2 持久数据与迁移](#e2)
- [E3 知识结构与渐进读取](#e3)
- [E4 定期维护与Workspace记忆](#e4)
- [E5 会话摘要与历史回读](#e5)
- [E6 Pi运行时与生命周期](#e6)
- [E7 成果提交、幂等与事件](#e7)
- [E8 Record块编辑、版本与并发](#e8)
- [E9 File更新与已有版本复用](#e9)
- [E10 Todo修订与统一撤销](#e10)
- [E11 HTML交互稿与隔离预览](#e11)
- [E12 统一API与错误语义](#e12)
- [E13 CLI、MCP与连接配置](#e13)
- [E14 助手界面与失败恢复](#e14)
- [E15 后续批次的接入边界](#e15)
- [E16 性能、观测与参考](#e16)

<a id="e1"></a>

## E1 领域边界与现有代码

QuickNote与AI Overview是不同概念，不共享对象ID、正文存储、保存命令或编辑状态。

| 对象 | 当前/规划存储 | 可写入口 | 禁止行为 |
| --- | --- | --- | --- |
| Project QuickNote | 当前projects.summary/summary_markdown/summary_html历史列；API quickNote* | 现有用户编辑/发布流程 | 不将旧列迁移成Overview，不让维护任务覆盖正文 |
| Workspace QuickNote | 当前workspace_notes中的today_quick_note单例 | 现有QuickNote服务 | 不复用为Workspace Overview或长期记忆容器 |
| AI Overview | 新agent_overviews及版本/依赖表 | 独立Overview维护服务 | 不调用project_update或QuickNote upsert保存概览 |

代码证据：src-tauri/src/models.rs的ProjectRecord/ProjectListItem通过serde将summary*映射为quickNote*；ProjectUpdateInput保留summary*输入alias以兼容旧客户端。src/components/project/ProjectOverviewPage.tsx是项目主页组件，其名字不代表AI Overview。创建Agent DTO时使用AiProjectOverview/AiWorkspaceOverview，避免与页面和ProjectRecord混名。

当前未实现AI Overview，没有发现Overview写入QuickNote的路径；不为文档整理做无关数据库改名。后续若重命名内部Rust字段，需保留serde别名、数据库兼容与原有QuickNote迁移/保存测试。新增来源读取时QuickNote可作为标注“临时想法”的输入，但不得由此推断确认目标，也不得自动改写、清空或发布它。

| 当前入口 | 已有能力 | 实施要求 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` / `WorkspaceRuntime` | Workspace、数据库、AI job、生命周期 | 新增领域服务与事件接口，不把整个 lib.rs 重写作为前置 |
| `src-tauri/src/db.rs` / `models.rs` | Record/Todo/File、导入、版本、搜索、引用 | 复用实体写逻辑；新增模块承接 AI 领域；迁移沿现有版本机制 |
| `src/services/projectMindApi.ts` | Tauri typed wrapper | 新 Agent 页面走 `agentApi.ts`，底层仍统一 Tauri command |
| `src/components/project/ProjectOverviewPage.tsx` | Project 首页与 QuickNote | 仅放助手入口；Overview查看/纠正在助手内按需打开，不新增首页卡片 |
| `src/components/workspace/WorkspacePage.tsx` | Workspace 页面 | M2 增加同构助手入口 |
| `src/components/settings/SettingsDialog.tsx` / `AiSettingsPanel.tsx` | 模型和编辑技能 | 新增“项目助手”“外部连接”两个分区；保持现有模型/编辑技能 |
| `src/lib/internalReferences.ts` 与编辑器扩展 | 引用序列化/跳转 | 复用 canonical 表示，补齐 workspace Record 的引用解析与反向索引 |
| `src/features/record-export/*` | Record 统一导出模型 | 复用 Markdown/HTML 语义；不能在 Rust 或 Node 中直接调用依赖 DOM 的模块 |
| `src/lib/record-save-coordinator.ts` | Committed Content 保存屏障 | 内置发起任务前 flush 当前 Workspace 编辑；外部读取明确只见已保存状态 |
| `src/lib/queryKeys.ts` / `docs/cache-strategy.md` | 页面驻留与缓存 | 增加 Agent scoped keys 与业务变更通知；禁止全应用定时刷新 |

检查时数据库当前版本为 25；开发时使用最新版本的下一个可用编号，不硬编码所有并行任务都迁移到 26。对外quickNote*及内部历史summary*均表示QuickNote，不是AI Overview。

这是实现契约，不增加逐工具确认弹窗：只读工具在已选范围内直接执行；默认review对同一用户任务的写入方案一次确认，主动选择collaborate后在已授权范围直接执行，不逐对象/块重复询问。每次原生写入仍有CAS、版本和收据；改变范围或长期自动化策略通过设置，任务确认不能扩大grant。

- 资料内容不授予操作能力；tool dispatcher 绑定 run grant，禁止让模型通过参数扩大 scope 或 savePolicy。
- 不自动加载磁盘 AGENTS.md、第三方 Pi extensions 或 MCP server；当前产品规则通过 Host 明确注入。
- API keys 和连接 token 不进入消息、tool results、日志和导出。日志记录 ID、耗时和错误码，不默认记录正文。
- 会话和来源 excerpt 按 Workspace 现有存储策略保存，不宣称正文端到端加密；现有密钥加密不能等同于整个 Workspace 加密。
- partial text 每250ms或4Ki字符落盘一次，完成消息优先持久化；关闭前 flush。无文本变化不写。
- 引用排除/授权缩小后停止受影响活动run；含该来源历史的会话改为只读，继续按钮新建空历史会话并重新取当前授权上下文，不能把旧摘要和tool result继续发送给模型。原历史仍可由用户查看，删除会话提供明确清理；这不声称能撤回已经发送给Provider的内容。源删除同样不自动重放已删除正文。
- usage 包含 token count（Provider 可用时）和模型名；费用未知就显示“未提供”，不估造精确账单。
- Overview维护只更新派生知识层，不因“待办可能过时”修改原Todo。任务中的Record/File/Todo修改仍走可逆领域服务。索引可重建；Overview版本、水位、纠正及长期记忆与会话/业务内容一起备份。

<a id="e2"></a>

## E2 持久数据与迁移

以下均为新增表/字段，名字是建议的正式实现契约。SQLite JSON 用 TEXT + schema 校验；事务内校验多态外键对应实体。时间用 UTC RFC3339；本机路径不进入 Workspace 表。

| 表 | 关键字段及约束 |
| --- | --- |
| `agent_scope_settings` | scope_key PK（workspace / project:<id>），enabled，goal_record_id nullable，pinned_refs_json，summary_policy（on_success 默认 / manual），overview_interval_hours（24默认/48）、overview_local_time（03:00默认）、overview_timezone，execution_mode（review 默认 / collaborate / read_only），revision；goal 同 Project，pins≤5 |
| `agent_context_instructions` | id，scope_key，text≤2000，enabled，revision，created_at/updated_at；用户输入，不由模型直接确认 |
| `agent_source_policies` | object_key PK，excluded bool，updated_at；先验证对象存在和 scope |
| `agent_sources` | object_key PK，scope_key，current_revision，file_version nullable，status，coverage_json，extractor_version，indexed_at，error_code；revision 改变立即使依赖 stale |
| `agent_source_chunks` | id PK，object_key，revision，ordinal，locator_json，text；UNIQUE(object_key,revision,ordinal)，关联 FTS5；只保存当前可检索修订，引用另有 evidence |
| `agent_jobs` | id，kind（extract/overview/session_summary/maintenance），scope_key，dedupe_key UNIQUE，state，attempt，not_before，payload_json，error；重试最多3次，5s/30s/120s，模型生成默认不自动重试计费 |
| `agent_sessions` | id TEXT PK（随机128位十六进制），scope_key，title，runtime_id，profile_override_id nullable，state（active/archived），session_path 相对路径，checkpoint_json，created_at/updated_at |
| `agent_runs` | id PK，session_id FK，client_request_id，state，context_manifest_json，grant_json，started_at/finished_at，usage_json，error_code；UNIQUE(session_id,client_request_id)，每 Workspace 最多1个活动 run |
| `agent_run_events` | run_id、seq、event_json、created_at；PK(run_id,seq)，保留30天；UI断线补读，过期返回snapshotRequired |
| `agent_messages` | id PK，session_id FK，run_id nullable，runtime_entry_id，role，content_json，state（partial/complete），ordinal，created_at；UNIQUE(session_id,runtime_entry_id)；runtime 投影 |
| `agent_session_summaries` | session_id + branch_id联合PK，summary_revision，through_entry_id，content_json，coverage，updated_at；当前摘要投影，可检索并进入Overview，不伪造Pi compaction；分段/历史见E5/E12 |
| `agent_outputs` | id PK，run_id，ordinal，kind（record/file/todo），intent（create/record_patch/file_update/todo_update），target_ref/base_revision/file_expected_hash，payload_json，sources_json，state（staged/committing/committed/failed），object_ref_json nullable，revision INTEGER默认1，UNIQUE(run_id,ordinal) |
| `agent_operation_receipts` | request_id、caller_id复合PK（Workspace数据库隔离），payload_hash，operation，state，result_json，error，created_at；不同 payload 重用 id 返回冲突；保存成功收据长期保留 |
| `content_reference_edges` | source_object_key，target_object_key，relation（internal_reference/evidence/derived_from），locator_json，target_revision nullable；复合唯一键；内部引用与推导依据分开 |
| `agent_evidence` | id PK，owner_kind（message/output/overview），owner_id，source_ref_json，excerpt；删除原文保留引用失效状态；删除对应会话连带删除其 message evidence，不删已保存成果 evidence |
| `agent_change_log` | seq INTEGER PK AUTOINCREMENT，object_key，scope_key，operation，revision，created_at；提交同事务 outbox，用于刷新/索引/撤销授权，按E7消费 |
| `agent_connection_grants` | id PK，client_label，scope_grant_json，operations_json，enabled，created_at，revoked_at；不存明文 bearer token |

迁移：每个 schema 批次沿现有 backup/savepoint 路径执行；旧工作区默认关闭，无会话且不自动入队；重跑迁移幂等。禁止把 Query 缓存或 runtime 对象保存到业务表。新表查询加 scope/time/foreign-key 索引；session 删除级联其 run/message/summary/staged output，committed object 独立保留。

### 知识与会话扩展表

- `agent_overviews(scope_key PK,current_revision,as_of_seq,status,coverage_json,policy_revision,updated_at)`与`agent_overview_versions(scope_key,revision,items_json,source_manifest_json,as_of_seq,model_profile_id,created_at)`保存不可变快照，旧overview不递归成为独立source；快照随Workspace备份，首期不自动裁剪。
- `agent_overview_dependencies(scope_key,item_id,source_object_key,source_revision,parent_overview_scope,parent_item_id,parent_revision)`支持原始依赖与逐层失效；来源权限每次读取仍校验。
- `agent_overview_pending(scope_key,object_key,first_seq,last_seq,operation,latest_revision)`与业务outbox同事务更新；Overview自身写入只通知父Workspace，不再将自己当Project业务变化，防止无限更新循环。
- `agent_memory_items(id,scope_key,kind,text,source_refs_json,confirmation,status,suppression_key,revision,last_supported_at)`在M2建立；用户纠正/抑制独立保存，不由模型覆盖。以上为规划数据结构，不修改现有领域事实基线。

- `agent_session_summary_segments(id,session_id,branch_id,start_entry_id,end_entry_id,revision,summary_json,message_refs_json,source_refs_json,coverage,input_hash,status)`保存分段当前摘要；历史版本独立保留，唯一(session,branch,range,inputHash)。FTS按segment索引，最新状态与历史时态可区分。

新增`agent_knowledge_nodes(scope_key,node_id,kind,title,one_line,summary,body_sections_json,revision,status,source_refs_json)`和版本/有类型边；kind为topic/decision/source_summary。Overview条目与会话分段通过统一注册表暴露为节点，沿用原表权威数据，不复制出第二套会话或Record。内容仍在SQLite，Markdown可作展示/导出，不另建并行权威wiki目录。

Record版本表见E8；Todo修订、撤回与操作收据扩展见E10。

<a id="e3"></a>

## E3 知识结构与渐进读取

```ts
type Scope = { kind: 'project'; projectId: number } | { kind: 'workspace' };
type ObjectRef = {
  workspaceId: string; scope: Scope;
  kind: 'project'|'quick_note'|'record'|'todo'|'file'|'transcript'|'session_summary'|'session_message';
  id: string; // 既有数字 ID 以十进制字符串传输；不是标题或路径
};
type SourceRef = {
  object: ObjectRef;
  revision: string; // sha256:...；File另带fileVersion，Record另带recordVersion/blockId
  fileVersion?: number;
  recordVersion?: number;
  blockId?: string;
  locator?: { kind: 'paragraph'; start: number; end: number }
          | { kind: 'page'; page: number; start: number; end: number }
          | { kind: 'time'; startMs: number; endMs: number }
          | { kind: 'messages'; sessionId: string; branchId: string; startMessageId: string; endMessageId: string };
  title: string; excerpt: string; // 每条 evidence 快照最多 2000 字符
};
```

Kind、scope、projectId、id 必须由服务端联表确认；参数中的 Scope 不授予权限。引用须指向本次上下文或 tool read 返回的 SourceRef；模型虚构的 ID 不能成为可点击引用。object_key 规范为 `<workspaceId>/<scope_key>/<kind>/<id>`，禁止只用数字ID作为跨表键。业务层把结构化引用转换为现有内部引用表示，兼容历史 token，禁止客户端自行拼猜。Workspace Record采用新增 `[[workspace_record:<id>|<label>]]` token，避免与Project Record的note:id碰撞；编辑器、解析/导航、搜索、后端校验及导出一起兼容，旧token含义不变。

Record/QuickNote 修订基于规范化 Committed Content 和语义元信息；Todo 包括状态、期限、子项；File 使用实际字节 hash + File Version；Project 包括名称、状态、Archive。时间戳不是唯一的并发控制依据。原 Record 编辑后保存的 evidence 摘录可用于说明当时依据，Record完整正文版本由E8提供，evidence摘录不替代版本快照。

### 知识结构

每Project一份current Overview，profile是其中相对稳定的部分，不维护互相矛盾的两份自由文本。

| 区域 | 内容 | 证据要求 |
| --- | --- | --- |
| profile | 项目要解决的问题、目标、背景、范围、约束、术语 | 指向目标/方案Record；自动归纳标inferred，未确定标unknown |
| progress | 已完成的重要工作、当前阶段、关键决定及理由、阶段变化 | 指向Record、Voice Record/Transcript时间段、File Version或正式会话消息 |
| knowledgeMap | 关键问题/主题→最值得读取的资料入口及读取理由 | SourceRef含对象、版本、block或时间定位；不是全量正文 |
| actions | 下一步、阻塞、未完成Todo、需要重新评估的长期停滞事项 | 真实TodoRef和当前状态；重要性推断写出依据，不能仅凭久未修改降级 |
| openQuestions | 未决问题、冲突证据、已失效/被取代的判断 | 保留冲突两侧来源，不静默选一方为事实 |

统一`OverviewItem { id, section, text, epistemicStatus: recorded|user_confirmed|inferred|unknown, sourceRefs, dependencyItemIds, validState: current|stale|disputed|unsupported, updatedAt }`。只有明确用户消息/用户纠正可生成user_confirmed；模型多次复述不提高确认程度。条目有稳定ID，更新保留未受影响项，不反复重新措辞所有内容。

`Overview { scope, revision, schemaVersion, items, asOfSeq, sourceManifestHash, builtAt, coverage, pendingCount, modelProfileId }`。以下是维护/存储预算，不是每次会话注入量：默认Project正文预算6000 Unicode字符（硬上限8000，不含有界引用元信息），Workspace正文4000（硬上限6000）；知识入口默认≤20，超出提供分页读取。已引用资料不等于全部读过，coverage记录已处理/排除/不支持/待处理数量及范围。用户可以查看来源、纠正、排除或重建，无需把它保存成普通Record。

### 最小入口

`context.get(scope,query?,budgetChars?)`默认只返回最小知识入口：scope身份、≤300字符项目定位、更新时间/覆盖状态、相关主题/知识节点的一行描述与ID（最多8项）、相关变更提示及继续检索入口。不自动带完整Overview、全部Todo、固定资料正文、历史会话或Workspace记忆。

默认整个data序列化≤2000 Unicode字符，硬上限3000（包含目录/元信息，超出少返回并标hasMore）。创建空会话不发模型请求、不预读知识正文；用户提问后才按问题取入口。query可用于确定性的标题/关键词/别名匹配，无需先调用一个模型生成整份上下文；未命中可搜索而非猜测全项目无资料。

完整Overview的存储预算不等于首轮注入预算。后续由Agent依问题选择知识节点/摘要、局部原文或有界全文，允许直接按明确对象ID跳读，不强制每次走完整层级。读取层级、停止规则、预算及CLI/MCP契约见E3。资料始终作为数据，不可通过其中指令改变权限或维护schema。

### 读取层级与停止规则

| 层级 | 返回内容 | 何时需要 |
| --- | --- | --- |
| L0 最小入口 | 项目定位、相关节点标题/一行用途/ID、新鲜度、搜索入口 | 用户提问后；空会话不加载 |
| L1 关联知识 | 选中的Overview条目或主题/决定综合页，结论、分歧与链接 | 判断问题相关性、跨来源关系；不读取所有页 |
| L2 单源/会话摘要 | 某份资料或某段讨论讲了什么、覆盖范围、章节/消息定位 | 决定应核对哪里，摘要足够则可停止 |
| L3 局部原文 | 指定block/段落/页码/消息范围及必要相邻上下文 | 精确事实、原话、冲突、最新状态核验 |
| L4 完整原文 | 明确选择的一个对象全文，分页并记录完整性 | 全文审阅、全局结构修改或局部不足以支撑回答 |

层级不是强制流水线。用户指明HTML File要求修改时可直接读取源码；指定消息可直达原文；概括项目方向可停在已有有效知识条目。用户要精确引文、修改目标或材料已经变化时必须核对相应原文/版本。只有摘要支持的回答标其来源层级，不声称已通读。不要为了验证一句话默认读取整份文档，也不要为了省预算忽略问题所需证据。

知识页应是跨来源积累的综合理解，不仅是文档摘要列表。Overview保留入口，主题页保存比较、决定与证据冲突，单源摘要帮助定位原文；关系提供可导航ID和一句“为何相关”。目前只需维护有实质价值的主题，不因每个名词创建一页。

### 工具预算与选择性读取

- `context.get`按4.2返回L0。完整Overview使用`context.overview.get(scope,sections?,itemIds?,cursor?,budgetChars?)`，默认只给章节目录；只有调用者明确选择section/item才返回正文。无参数不能偷偷返回全部Overview。Workspace入口同样有界，不自动拼所有Project概览或个人记忆。
- `knowledge.search(scope,query,kinds?,cursor,limit)`默认最多8条卡片，每卡snippet≤240字符，响应data默认≤3000；支持标题/别名/关键词，未命中回退`source.search`，不把索引当完整世界。大目录分页/搜索，不先下载全索引；同义词与中文召回用真实fixture验证。
- `knowledge.get(nodeId,view: outline|summary|content,sectionIds?,cursor?,budgetChars?)`默认summary，≤1200字符；content默认≤4000，硬上限8000。返回kind、version、sourceRefs、coverage、stale、related节点卡片≤5及nextCursor；不递归取related正文。
- `source.read`/`session.messages.read`明确range或view，默认局部读取≤4000字符；单次硬限12000。`view=full`表示逐页完整阅读意图，仍受分页限制，只有到末页才有complete=true。HTML源码保持原字节/版本规则；原有单工具上限不是要求每次填满。
- 每run自动检索的累计返回数据预算默认24000字符，配置硬上限60000；初始入口、工具摘要、原文、元信息都计入。Host按当前模型窗口另算token预算并为回答留余量，不能把字符数当token数。预算不足返回有界状态，助手依据已读资料说明限制或分阶段继续，不伪称完成全篇审阅。用户无需逐次确认读取。
- 用`node/object + revision + range + view`记录已读集合；不默认重复下载同一内容，不把新旧全文反复拼到当前资源上下文。会话原始工具日志保持真实，模型请求的资源投影可去重；Pi适配须验证投影不会损坏tool call/result配对。
- CLI提供`knowledge search/get --view --section --cursor`和选择性`context overview get`；MCP同构schema默认返回小结果，批量读取必须显式IDs、总预算、不递归。不得在MCP tool description/system prompt里预塞完整项目知识或全量索引。

### 新鲜度

1. 新会话创建不加载项目正文。用户实际提问后，内置run先`context.get(scope,query)`读取最小入口；CLI/MCP同样以最小入口为默认，后续按问题选择性展开。
2. Agent按问题选择knowledgeMap的一行入口，按需读取主题综合节点/单源或会话摘要，再决定是否调用`source.read`/`record.blocks.get`/`file.source.read`读取局部或完整原文。Overview用于理解和导航；精确日期、原话、关键决定和修改基线需核对原始来源。
3. 入口只列与问题/选中节点有关的变更提示，delta其余部分按需分页；读取相关Todo时返回当前状态。依赖已变的知识条目标stale，不能继续作为当前事实；未展开的项目变化不全部塞入首轮。
4. 问答本身不触发完整Overview重建。首次尚未建立时用目录/检索回答；缺失事实说明覆盖不足。用户明确“刷新项目认知”可排队合并刷新；运行中的问答固定context快照，不被后台替换。
5. user correction独立于模型overview版本保存并优先输入；恢复某个Overview历史版本不能丢掉后续用户纠正，恢复后按当前来源水位标stale。

### 提取和检索

- 全文索引选 SQLite FTS5 trigram，必须在打包的 SQLite 上实测；中文/英文混合覆盖，不以仅空格分词的效果作为合格。长度 1～2 字的查询用有界 `LIKE` 回退；限制返回 50 项，超过时提示收窄。不执行模型生成 SQL。
- 首期支持 UTF-8 Markdown/txt/HTML（≤10 MiB）和有文本层 PDF（≤50 MiB、≤500 页）。PDF 复用已经安装的 `pdfjs-dist` 在 Node utility worker 中运行；不复用 Agent 的模型线程。
- 单任务提取硬限时 60s，单个文件提取总文本 ≤2 Mi Unicode 字符。达到上限标 `partial` 并保存覆盖范围，不能显示“已完整读取”。扫描 PDF 标 `needs_ocr`，密码 PDF 标 `encrypted`，未知编码标 `unsupported_encoding`。
- chunk 最大 1800 字符，重叠 200，保持页码/段落/时间段边界。MD/HTML索引提取不执行脚本，跳过script/style活动内容，引用/链接保留文本含义；修改HTML时另走原始源码读取，不能把清洗后的索引文本写回文件。
- 每 Workspace 最多一个提取 worker；记录更新 500ms 合并索引事件。File 导入/版本变化自动提取；历史存量在启用助手后按所选scope预算分批建立索引，默认当前Project；排除项不入队，无需逐文件确认。
- 不自动扫描 Workspace 外目录。已登记托管 File 被外部修改时：读取前和项目激活时 stat 检查，变化后计算 hash；若与登记版本不符标 `changed_unregistered`，不把新字节冒充旧版本。用户点击现有版本管理入口登记新版本后重新提取。
- searchable包括已提交业务正文、ready/partial extraction及带原始消息范围的会话摘要；会话摘要独立kind并按scope检索，不混为Record。流式半成品/机器草稿不索引。Source exclusion对packet/search/read/引用展开与派生摘要统一生效。
- Search 返回 title、excerpt、score、SourceRef、coverage；排序优先精确标题与用户指定来源，再全文相关度、更新时间；File 默认只检索当前版本，历史版本需显式指定。

<a id="e4"></a>

## E4 定期维护与Workspace记忆

**初始化**：启用助手时为已选范围自动排队一次。先读取对象目录和元信息，按目标/固定背景/近期决定/活跃Todo分批读取资料，形成partial Overview；随后按预算补齐未覆盖内容，不要求一次模型输入读完全项目。优先级是读取顺序，不表示旧资料永远忽略。新空Project不调用模型。初始化可取消/续跑，输入游标持久化。

**调度默认**：本地时区每日03:00检查，维护间隔24h，可选48h和时间；仅有未消费业务变化的Project进入队列，无变化零模型调用。第一次启用包含此维护策略，无每次确认。应用未运行或Workspace未打开则不执行，下一次打开在用户任务之外合并补跑一次，不补齐过去每一天。M4才支持应用关闭时Host运行；不承诺电脑休眠时唤醒。

**每批更新**：

1. 捕获scope目标水位targetSeq，从持久pending及未完成输入游标读取待处理内容，合并其后同对象多次编辑；不能只查询上次asOfSeq之后的日志而漏掉先前partial留下的资料。一天改50次同Record只读取最新已提交版本一次，删除/排除事件保留。正文hash不变或仅文件名变化可确定性更新引用，无需模型。
2. 输入旧Overview、用户纠正、变更对象的最终状态/语义diff、受影响条目及必要来源；Record可用块diff，File没有可用文本diff则读取受限新版本。只变更相关条目，未变更来源按需展开，不默认重读全部正文。旧Overview是上下文，不作为独立新证据。
3. 模型输出`upsertItems/removeItemIds`及来源引用，服务验证schema、来源范围/版本、条目依赖和字符预算；最多一次结构修复。一次已持久化的维护批次最多提交一个Overview版本，CAS基于旧overviewRevision。targetSeq表示本次业务变化上界，不是唯一的发布身份；同一targetSeq可以因预算分成多个续批，每批实际消费不同输入并产生下一版。
4. 处理期间又有业务变化，则本次最多提交到已捕获targetSeq，并保留后续dirty；条目按依赖显式标滞后。发布只确认本批实际处理的对象/范围，未读范围保留进度；asOfSeq单独不能证明该水位前资料已经完整消费，必须结合pending和coverage。相同水位没有新源变更时也能继续未读部分，不能靠生成假业务事件解锁续跑。
5. 单scope每批模型总输入上限48000字符（含重复上下文），至多3次调用（修复也计入），Workspace批次总上限20次调用/20min，可配置；按最久未处理排序轮转。超过预算保留partial和游标，继续在后续批次完成。前台run优先，后台在调用边界让出；不占用Voice实时处理队列。
6. 沿现有持久作业保存稳定batchId（作业ID与批次序号即可）、输入游标、targetSeq和policy/correctionRevision；发布以`scope + batchId`幂等，并绑定完整payload和基线。重试同批返回原收据；换payload冲突；不同续批仍受head CAS及最新策略约束。失败保留旧版、同批身份和待处理进度，不立即循环重试计费。无模型/密钥锁定则挂起，恢复条件满足后继续。无需新增另一套调度系统。
7. change log只保留30天，维护专用pending对象集合与删除标记不得随之过早裁剪，直到相关scope成功消费。水位已超日志保留且专用记录不完整时，以source manifest对比上次依赖重建增量；无法证明完整性则标needs_rebuild，分批重新建立，不声称最新。

默认后台安静运行；失败或明显证据冲突可在助手里显示状态，不每夜发送一条通知。用户手动刷新复用同一队列/预算，不绕过权限或并发控制。

2026-10-08契约修正：以上批次身份规则解决“partial后续跑”与“同水位只能发布一次”的冲突，产品范围不变。当前e26380d代码的唯一约束仍是scope/targetSeq/policy/correction，须在交付包R10a迁移并补真实服务回归；本文更新不表示实现已修复。来源manifest和coverage由真实读取/处理结果计算，模型不能自行申报完整覆盖；目录完整、索引完成、知识整理完成分别展示实际状态。

### Workspace分层认知

Workspace输入包含两部分：①各授权Project Overview的变化；②Workspace直属Record、Todo及明确会话结论的变化。先处理Project，再更新Workspace；只读取发生变化的项目条目及必要原始来源，不把每个项目全文再扫描一次。项目失败时记录其旧revision/滞后，其他项目照常更新。

Workspace Overview组织跨项目关系、当前工作分布、长期领域/兴趣、可复用方法、用户明确的工作习惯和关键知识入口。项目归档后可退出活跃工作清单，但仍有来源支持的通用方法/经验可以保留；必须保留来源归档状态，用户撤销授权或排除来源另按即时失效处理。

长期记忆条目增加`kind: background|domain|interest|method|preference|knowledge_pointer`、适用scope、sourceRefs、confirmation、lastSupportedAt和status；明确表达的偏好可标确认，重复行为只作为待验证推断。一段模型建议、一次随口提问或多层摘要循环不能自动变成用户长期偏好。过时内容变stale/superseded，不能无限累积成互相冲突的“用户画像”。用户纠正、停用或“不要再记住这一点”需持久抑制键，防止下一轮从同一来源重新生成。

每个Workspace记忆条目与Project概览条目保留最终原始来源和派生链。删除/排除/撤回/授权收缩立即失效其依赖，不等待夜间任务；只剩无权来源的条目完全不返回正文、标题或摘录。混合授权来源不能只隐藏引用却返回混合结论：保守整条省略，或用仍可见证据重新生成后返回。只授权项目子集的连接只组合有权限的条目，不读取全Workspace自由文本摘要。Project默认不继承Workspace个人记忆，沿现有领域边界执行。

### 摄入、索引与健康检查

每日/隔日摄入批次更新受影响知识节点、来源摘要和入口索引，再提交Overview；稳定节点不重写。缺少摘要时返回not_built及原文定位，Agent可直接读相关原文，不为回答先整库建wiki。Overview与节点在一个发布revision下引用已存在节点版本，失败保留上一致快照；pending只有对应批次成功才消费。

目录说明“有什么、去哪读”，日志记录“何时摄入/更新/核查”，二者分开。知识维护日志只保存对象、版本、动作和结果，不记录模型私有推理。确定性lint检查失效来源、孤立/断链、未覆盖来源；语义矛盾检查进入有预算批次。query产出的新知识先有消息/业务成果作为证据，再进入维护，不把AI答案反复当独立事实。维护schema由应用版本化提供，资料不能自行修改规则。

原文的raw只读层在Mind对应不可变的来源版本/消息证据；当前Record/File仍允许按用户任务版本化编辑，不能照搬为禁止用户改资料。M1先用既有FTS5/中文回退与链接导航；原文推荐qmd可作检索实现参考，尚不决定引入向量模型、额外Markdown目录或独立搜索进程。

<a id="e5"></a>

## E5 会话摘要与历史回读

`Project Overview的主题/决定入口 → 相关会话摘要/主题分段 → 指定原始消息范围`。

例如“上次为什么没做权限管理？”：Overview找到“权限管理暂缓”的条目及会话引用；摘要说明当时比较的方案、用户的决定和未决前提；需要确认措辞时读取引用范围的几条消息。回答附“9月某次会话 · 相关讨论”链接，点击打开会话并定位/高亮消息，而非只跳到聊天底部。若Overview未保留这个细节，则检索历史摘要，不因概览里没有就声称没讨论过。

每份摘要包含`topics、userIntent、decisions、alternativesAndReasons、openQuestions、completedOperations、artifactRefs、messageRefs`。所有有实质判断的条目附原始MessageRef；用户计划、已确认决定、AI建议、实际完成分别标注。实际完成需成功操作收据或明确用户报告，AI说“已完成”本身不充当工具执行证据。引用外部资料的聊天结论还保留资料SourceRef；同一证据经过Record/会话/Overview重复引用不计为多个独立证据。

### 摘要更新

- 新消息持久化只更新dirty/through-entry水位，不每个token总结。满足E5阈值后合并执行；夜间维护先更新有变化的会话摘要，再更新Project Overview，最后Workspace Overview。每个环节都在共享预算内，无需用户点击“结束会话”。
- 长会话分为有界消息段：按稳定消息顺序至多50条或12000字符一段（超长单消息分片并保持messageId/片段范围），摘要正文≤2500字符；保留旧段及消息引用，不将整个会话永远压成一小段而丢掉早期讨论。当前会话摘要是最近状态/主题索引，段摘要供检索。
- 增量只读新消息段、相关旧摘要及必要被纠正的原始消息；不每次重读全部会话。更正早期结论时建立supersedes关联，旧段仍保留“当时的判断”，最新入口显示已被取代，历史提问可定位当时版本。
- 提交摘要同时写source-change/pending事件，把本次内容变化交给E4批次，不立即强制重做Overview。会话无新内容或生成同hash不写新版、不重复触发。没有实质知识的闲聊可标processed/noKnowledge，不塞进Overview。
- 历史会话先按预算分批建立摘要；未覆盖段标coverage。新问题涉及尚未摘要的近期消息时，可用会话标题/时间/有界原始消息搜索定位，不宣称“摘要未命中=从未谈过”。模型上下文压缩不是该摘要机制，不能依赖Pi compaction代替可检索记忆。
- 摘要输入排除系统提示、凭据、无关完整工具日志和未完成文本；工具结果只取成功收据/相关对象引用。失败run的已保存用户表达和已成功产出可在下一批处理，保留run状态，绝不把取消理解成任务完成。

### 消息身份、权限与删除

`MessageRef { workspaceId, scope, sessionId, branchId, messageId, ordinal, contentHash }`使用持久ID，编辑/重试/分支不能重新指向另一条消息。概览引用同时保留summaryRevision/segmentId与原始消息范围；摘要重建不改变消息链接身份。

Project检索只见同Project会话；Workspace可聚合其授权范围内的会话，Project不反向继承Workspace会话。内置助手默认可读当前scope历史会话；外部“单Project协作”连接预设包含明确展示的`session.read`，只读连接可选择含/不含历史会话。没有session.read时，过滤依赖该会话的摘要/Overview条目正文，不能只藏消息链接却泄露结论。

会话或消息被删除/排除时，失效其summary segments、FTS与派生Overview/Workspace记忆；原会话涉及被排除资料时同样沿依赖失效，不能通过用户/助手的转述旁路恢复。旧Overview版本仍需动态权限过滤。已独立保存的Record/File不因删除会话而删除，但原会话引用显示失效；删除原文与“从所有独立成果忘记此事”是不同操作，不能承诺后者自动发生。外部Agent只索引通过适配器明确回传的会话/消息，不扫描其他CLI全部私有聊天记录。

### 读取接口

- `source.search(kinds:[session_summary])`按主题/关键词找摘要段，返回会话标题、时间范围、相关摘要、summaryRevision、MessageRefs、superseded状态、coverage；统一search默认可以混合命中业务资料和会话摘要，不把新近排序当唯一相关性。
- `session.messages.read(sessionId,branchId,fromMessageId,toMessageId,cursor)`只读指定区间，单页≤50条/12000字符，返回hasMore与固定内容修订；`source.read`可解析summary SourceRef，不自动展开整段原始聊天。链接由应用resolver生成，不让模型拼造会话ID。
- CLI提供`session summary get`、`session messages read`及`search --kind session_summary`；MCP提供对应只读工具。与现有session.get的GUI全会话分页分离，外部读取明确有界。

自动总结阈值：成功run新增≥4条正式消息或≥4000字符合并排队；短会话在定期维护补齐。每Project每日最多5次，超出保留dirty和coverage、轮转续跑；后台阶段摘要不等于正式Record。

<a id="e6"></a>

## E6 Pi运行时与生命周期

基础代码入口和当前可执行范围见[框架说明](../../src-tauri/src/agent/README.md)。框架不等于本节运行时、持久化及安装包能力已交付。

新增目录建议如下（允许按既有 lint 约定调整文件名，但不合并职责）：

```text
src-tauri/src/agent/
  models.rs repository.rs service.rs commands.rs
  context.rs sources.rs extraction.rs references.rs
  runtime.rs outputs.rs bridge.rs events.rs
src/services/agentApi.ts
src/lib/agent-types.ts
src/components/agent/
  AgentPanel.tsx AgentConversation.tsx
  SourcePreview.tsx OutputCard.tsx AgentSettingsPanel.tsx
src/hooks/useAgentEvents.ts
packages/agent-host/        # 独立 package.json/lock；SDK 与 utility worker，后端资源
src-tauri/src/bin/mind.rs   # CLI + MCP adapter
```

- `AgentDomainService` 接收已验证 `RequestContext { workspaceId, workspaceGeneration, scopeGrant, caller, requestId }`。命令不绑定浏览器窗口；数据库/路径从绑定 WorkspaceRuntime 获得，绝不根据调用瞬间的活动页猜测。
- 前端 Tauri、CLI bridge、Pi tool dispatcher 都调用同一服务。不要把所有现有 db.rs 方法重构后才开工，只为本期读/建/索引和变更事件抽 seam。
- Pi SDK 运行在应用捆绑 Node LTS 的独立进程；`packages/agent-host` 独立构建，SDK 不得进入 Vite 主 bundle。M0 锁定 SDK/Node 版本及资源清单，通过 Tauri sidecar/resources 打包并记录许可证。
- 使用自有 `mind-agent-host/v1` JSONL 协议，不让 Rust 直接依赖 Pi 所有内部事件。命令：initialize、session.open、run.start、run.cancel、session.close、shutdown。反向请求：tool.call；响应：tool.result。每帧包含 protocolVersion、requestId，run 事件带 sessionId/runId/seq。
- 生命周期映射为 run.started/text.delta/tool.started/tool.completed/message.completed/run.completed/run.failed/run.cancelled。只有 SDK 确认 settled 且 Host 已持久化终态后，才发 run.completed；接收 prompt 不等于完成。
- 使用 custom ResourceLoader、内存 settings/credential store、明确工具白名单，禁用全局/项目 resource discovery 和默认工具。Project `cwd` 不作为权限保护。
- 模型凭据由 Rust 在解锁后通过管道传给本次进程；不进 argv、日志、Workspace 明文配置或 Pi 用户目录。切换 Workspace 或锁密钥后销毁会话凭据引用。进程环境使用明确 allowlist。
- 先支持现有 OpenAI-compatible Profile 的工具调用映射；其他 provider_family 显式显示是否支持。M0 以一个真实兼容服务和一个 mock 验证，不因 Provider 标记 supports_text 就假定支持工具。
- Pi SessionManager JSONL 是模型恢复历史的权威文件，路径为 `.project-mind/agent/sessions/<session-id>/session.jsonl`。SQLite 存会话元数据、UI 消息投影、run/工具收据；不得分别修改两份对话。终态时做 checkpoint 并持久化 JSONL checksum/offset；恢复校验后重建 UI 投影；损坏保留原文件并禁用继续，不静默丢弃历史。
- Pi 原生会话头/系统段可能包含 cwd 等绝对路径；持久层由 Host 的 SessionStore codec 将此类系统字段存成 Workspace/Project 相对引用，载入内存时解析。用户消息不得被字符串全局替换。M0 必须验证迁移Workspace后恢复、session JSONL/系统提示/工具结果无Host注入的本机绝对路径；若不能提供受支持codec，则该方案不能通过M0，不能直接默认写Pi原始路径。
- 初期每 Workspace 一个活动用户 run；第二个请求返回 RUN_BUSY 而不是无限排队。后台总结/Overview维护同属 Agent 队列，用户 run 优先，后台作业在边界让出；不占用 Voice 转写实时通路。
- 工具请求默认 30s 超时，模型首响应 60s、无任何有效进展 120s、run 总时长 10min、工具调用上限 30 次。超限保留结果并显示继续入口，不无限运行。
- 取消先 SDK abort，5s 后终止子进程树；终止不能把已经完成的 output commit 回滚成未保存。切 Workspace 的代际标识使所有旧响应失效。

### Run状态机

`preparing → running → completed`；preparing可到failed/cancelled，running可到failed/cancelling，cancelling结算所有已开始commit后到cancelled；进程丢失或重启发现未终结run时标interrupted。任何终态不可再次变为running，继续/重试必须新建run并通过收据复用已提交成果。preparing中完成保存屏障、权限/模型检查与最小知识入口manifest捕获，running后才发模型请求。只有最终消息持久化、工具结果完整且runtime settled后才能completed。部分保存成功而模型失败的run仍为failed，但保存收据卡片保留。

run events与业务change events是两条流：前者用于会话展示，后者用于对象刷新；两者都必须包含workspace代际，不以收到最后一段文本推断任务完成。

<a id="e7"></a>

## E7 成果提交、幂等与事件

- 两个任务入口只是提示模板，不隐式改变权限。Agent根据用户任务选择Record、Todo或File，不要求先选成果类型或保存复选框。默认review先提出同任务一次业务方案，确认后提交；主动选择collaborate则直接提交。纯问答可只回答，明确只讨论时不写入。
- `output.stage`保存完整候选并校验类型、引用、目标和基线，不提交流式半成品。review中的同任务相关候选按所属轮次合并为简短业务摘要和一个确认/取消入口；collaborate在stage验证后由Host提交，read_only拒绝写工具。实际模式使用run/output冻结值，不能以当前设置改写旧方案。
- 按钮决定与明确文字确认/取消调用同一可信候选决定路径，绑定Workspace代际、会话/任务身份、所展示候选ID与expectedRevision；决定持久可恢复，不伪造Pi模型消息。含糊指代先澄清，引用/工具正文中的“确认”不是用户授权。附带修改的回复先使旧方案失效，经候选CAS更新或替换后重新确认，旧按钮/请求不得继续提交。
- 确认一次覆盖所展示的同任务候选集合，不能自动批准之后新增或修改的候选；确认与取消竞争以持久决定/CAS为准。按对象逐项调用现有原子服务，不宣称跨DB/文件系统全局原子。取消阻止未开始的提交；已开始commit仍结算并保留实际收据。重试只处理未成功项，已提交收据不重复执行。
- 成功结果在所属轮次只显示一次业务摘要和可点的实际对象，详情按需展开“已创建/已修改”、版本、来源、真实差异及打开/撤销。失败或部分成功在会话中明确显示，模型说“完成”不能替代native receipt。现有GUI与原生对象刷新复用业务事件，不另造成果管理区。
- `output.update`编辑staged候选使用expectedRevision，服务端重校验；修改后使旧确认失效。未提交候选的完整正文、来源与真实diff仅在显式查看详情时读取，不预读所有历史成果body，不另开审阅Dialog。
- 新建同名File加后缀；继续修改绑定已有File ID与基线版本，每次成功修改新增File Version。同名不是修改身份，多个同名目标有实质歧义时才询问。
- HTML成果从实际已提交File进入隔离预览；“继续修改”明确带入同一File ID与当前源码/版本，见E11。查看成果时仍可继续对话，可移除讨论对象提示，不静默变更scope。
- Todo只依据明确行动或已知事实创建/修改，review按同任务一次确认后提交、collaborate直接提交；不把假设建议都转换成Todo，不编造日期/负责人/状态。
- 保存成功立即可在列表找到；来源后来变化标“生成依据有更新”，目标本身变化严格CAS。工具仍受30次/10min预算，超限保留已完成成果。上述接线只复用候选、收据与三类原生提交，不新增通用审批/队列/工作流框架。

### 修改目标与差异

- Record菜单和助手增加“修改这条记录”，进入带明确目标Record的任务；File菜单增加“修改这个文件”，目标绑定File ID与当前版本。
- 默认review在同任务业务方案确认后应用经校验的patch；主动collaborate直接应用。真实逐块差异按需查看，成功后可撤销。作用域和执行模式由Host绑定，不能从模型或资料参数推断。
- 同一任务不逐块、不逐Todo弹窗；每次提交仍校验baseRevision、blockId或File版本/hash。问答入口不强制只读，是否写入由用户任务、冻结模式与本次任务决定约束。
- 外部连接分开授予 `content.create`、`record.patch`、`file.update`；Record恢复另需 `record.restore`，File恢复另需 `file.restore`。修改权限包括已授权对象中的块删除，不含整条记录/文件删除、归档、密码/设置操作。连接可限定Project内所有Record/File或具体对象，UI展示范围；一次run可处理范围内多个与任务相关的对象，每个操作必须绑定具体对象及基线。
- 同一个Record的一组操作一次应用、一次撤销/版本回退；跨Record或Record+File批处理按对象分别提交，不宣称跨文件系统/数据库的全局原子性。部分成功逐项显示收据，重试只处理未成功项。
- 预览由base snapshot与经服务验证的patch计算，不能仅展示模型自行描述的“我修改了什么”。显示修改/新增/删除块数量、目标标题、基线修订与受影响引用。
- 版本入口放在Record更多菜单“版本历史”，展示时间、来源（手动编辑/内置助手/外部连接/恢复）、变更摘要、基线与结果；点击查看只读内容与差异，恢复时明确“恢复正文并创建新版本”。File复用现有版本入口并补当前版本/历史版本比较和恢复为新版本操作；文本逐行diff，二进制展示类型/大小/hash及可用预览，不承诺通用语义diff。

### 业务事件

- 在数据库事务内写实体、引用边、收据和 change log；提交后通知 Tauri `mind:changed`。没有提交成功不得发成功事件。
- Record 变更标识与引用边统一由 `ObjectRef.key()` 生成（如 `<workspaceId>/project:7/record/42`）；打开工作区时迁移旧 `record:project:7:42` / `record:workspace:42` 日志，保留原 seq、时间和 revision。
- GUI 所有相关写入口也必须更新 change log，包括 QuickNote、Record 正文/metadata、Todo 及子项、File 导入/新版本/改名/删除、Project 改名/Archive、Transcript 完成。不能只监听 Agent 写入。
- 事件携带 workspaceId、generation、seq、changedRefs；前端验证当前 Workspace 后只 invalidate 相关 projectPage/workspacePage/todo/search/reference/overview keys。
- 隐藏页面只标脏，重新可见时 fetch；打开窗口按 lastSeq 补读。change log 保留30天，超出范围返回 resetRequired，并刷新该 Workspace 缓存；删除标记在来源 registry 中保留用于引用失效。
- 不在模型网络请求、PDF 提取或文件 hash 阶段持有数据库 Mutex；读快照→外部处理→带预期 revision 提交。
- 内部 `record.create` 的 Markdown 转 HTML 需要一套无 DOM canonical converter。选择与现有编辑器语义兼容的实现，并通过 fixture 验证引用、列表、表格、代码、图片。不是将 Markdown 字符串直接填入 HTML 字段。

### 新文件提交恢复

数据库事务不能包住文件系统原子性。`output.commit` 使用 durable receipt + staging：

1. 创建 committing receipt，写 `.project-mind/tmp/agent/<operation-id>/...`，计算 hash，fsync。
2. 为目标文件名保留注册信息，所有普通文件列表只显示 ready；原子 rename 到同磁盘目标。
3. 在短事务中写 documents/document_versions、引用、committed receipt、change log；暂不复用可能移动外部源文件的导入默认行为。
4. 崩溃恢复按 receipt/hash 检查：已存在且 hash 正确则完成登记；只有 staging 则继续；缺失则 failed 可重试；同路径不同 hash 不覆盖，要求选择新名字。

实现可调整 staging 的内部表，但必须通过每一步 crash injection 测试。取消时若已进入提交临界区允许结算完成并返回真实收据；不能承诺回滚已落盘文件。

<a id="e8"></a>

## E8 Record块编辑、版本与并发

### 稳定块模型

使用当前Tiptap/ProseMirror结构定义正文树，给所有可寻址block节点分配128位随机 `blockId`，在HTML保存为 `data-block-id`。paragraph、heading、codeBlock、blockquote、list/item、table/row/cell、image/attachment等均需覆盖；文本和mark不是独立block。parent/ordinal由正文树派生，不能用标题、文本hash、数组下标或当前DOM位置代替ID。

新增 `record_document_heads` 存已提交canonical document JSON与 `headRevision`；notes/workspace_notes现有HTML/Markdown由同一树生成，作为兼容投影，在同一数据库事务写入。相同Workspace内Project/Workspace Record键仍带scope，数字ID不可混用。JSON schemaVersion随编辑器schema兼容策略记录。

- 初始化：旧HTML经共享editor schema解析，生成ID并验证再次序列化后语义未损失；创建baseline版本。未知自定义节点必须保留原始attrs/content，做不到则只读并给迁移诊断，不能静默丢表格、图片标注或附件。
- 同一块文字编辑、移动、变更mark保留ID；split左/原块保留ID、新块生成ID；merge保留最前块ID，其余ID退休。复制粘贴创建新ID，剪切移动保留ID（同Record）；跨Record粘贴/移动在目标生成新ID。撤销删除可恢复原ID，同一文档任何时刻不重复。
- 旧HTML只在首次初始化或显式导入时转换，正常保存不能重新生成所有ID。整篇Markdown导入视为新内容，有明确ID变化，不用模糊文本匹配冒充稳定锚点。
- 编辑器新增 `getCommittedDocumentJson()`，复用ADR-0003的Committed Content投影；当前 `getDocumentJson()` 是live editor JSON，可能含未接受AI预览，绝不能直接用于版本、CLI读取或patch基线。
- canonical解析/序列化提取为无DOM共享模块，Node utility worker和编辑器使用同一schema/转换fixture；Rust对操作与引用/作用域做再次验证。HTML/Markdown/JSON同事务更新，不能维护三个各自可写的事实源。

### Patch

```ts
type RecordPatch = {
  record: ObjectRef; // kind=record，拒绝QuickNote/Transcript
  baseRevision: number; // headRevision，严格CAS
  requestId: string;
  operations: Array<
    | { op: 'replace'; blockId: string; expectedBlockHash: string; block: BlockInput }
    | { op: 'delete'; blockId: string; expectedBlockHash: string }
    | { op: 'insert_after'; anchorBlockId: string; blocks: BlockInput[] }
    | { op: 'append'; parentBlockId: string | null; position?: 'start'|'end'; blocks: BlockInput[] }
    | { op: 'append_inline'; blockId: string; expectedBlockHash: string; text: string }
  >;
};
// BlockInput=经白名单editor schema校验的节点树；新节点ID由Host分配。
// replace保留目标根ID（节点type改变也保持该逻辑块ID），替换子树的旧子ID退休、新子树分配新ID。
```

- `append(parentBlockId:null)`追加至正文末尾；非null只允许能容纳所给block的容器末尾。`insert_after`在anchor的同父节点下插入；首部插入可用空文档append或单独的position=start参数，正式schema固定采用 `append` 的可选 `position:'start'|'end'`，默认end。
- `append_inline`只向paragraph/heading/codeBlock尾部追加纯文字；代码块保持字面文本，paragraph/heading不解析任意HTML。其他容器必须用block append。替换部分句子可读取整个目标paragraph后replace，不提供不稳定的字符offset patch。
- 最多100个操作、1MiB有效payload；缺ID、重复目标、同时操作祖先和后代、对本patch中新建块继续寻址、anchor同时被删/替换等模糊组合一律INVALID_PATCH。所有目标按同一个base snapshot解析后应用；新块ID在结果中返回。
- strict CAS：任意并发正文修改导致REVISION_CONFLICT，返回最新headRevision及冲突目标（在授权范围内），零操作生效。首期不静默rebase，即使看似改的是其他块；用户/Agent重读后重新生成patch。删掉已被人修改的块也不能盲目重试。
- 先纯校验与预演，后在短事务中再次CAS→写新head/兼容投影→版本快照→引用边→receipt/outbox。requestId在caller+workspace命名空间幂等；相同id不同payload拒绝。无实际内容变化返回noChange，不新增版本。
- 返回beforeRevision/afterRevision、createdBlockIds、deletedBlockIds、beforeVersion/afterVersion、changedRefs和receipt。历史引用定位可携带recordVersion + blockId，不再只有易漂移的段落序号。
- 删除列表项/行/表格块按整个子树处理；删掉最后一项/行后移除空list/table容器并返回其退休ID，空table cell规范化为一个空paragraph；预览必须显示这些结构修复，不能产生非法空容器。删除所有顶层内容时规范化为一个新空paragraph，原块ID退休；结果明确返回该规范化。

### 版本快照与恢复

区分headRevision与用户可见Record Version：每次已提交正文保存（包括GUI自动保存）都CAS增加headRevision，版本历史在重要边界形成不可变快照，不按每次按键生成一条历史。

1. 迁移/首次建立块模型创建baseline；普通手动编辑开始前保留baseline，编辑中当前head立即按既有autosave节奏持久化，空闲30s、持续编辑满60s、离开编辑器、打开历史、退出/切Workspace时封存checkpoint；同内容hash不重复。
2. 每次Agent/CLI/MCP patch、接受既有编辑器AI修改、QuickNote追加到Record、显式恢复，都在事务里确保“修改前”和“修改后”快照存在；每个动作是可追踪版本边界，不并入手动编辑组。
3. 首期版本范围是正文JSON/HTML/Markdown、defaultCodeLanguage和托管资源引用；标题记录为当时显示快照，标签/当前标题修改不单独生成正文版本，也不在恢复正文时被回滚。Title/Tag元信息更新不能无条件携带旧正文再写回。
4. `record.versions.list/get/compare`只读分页，compare按block ID展示增加/删除/移动/修改；`record.version.restore(versionId,baseRevision,requestId)`把历史正文写为新head并创建新的Record Version，历史列表不倒退、不重写旧版本。
5. 恢复保留该历史快照的block IDs；只在恢复后当前树内验证唯一性。历史版本可继续精确解析已删除块；普通Internal Reference仍指当前Record，evidence携带版本才能指当时内容。
6. 原始Transcript及Voice Source Track不允许patch；Voice Record的可编辑正文按普通Record版本化。Meeting Minutes Snapshot保持既有只读派生规则。QuickNote本身暂不版本化，但追加进Record必须版本化。
7. 托管图片/附件的物理清理必须同时检查当前正文和所有保留版本；从当前块删除图片不删除历史仍引用的资产。File历史引用按既有File Version生命周期；用户显式删除整个File后历史显示来源缺失，不能声称恢复了被删除的外部文件。
8. 首期不自动裁剪历史、不在删除会话时删除Record版本；提供容量统计。快照可压缩/按内容hash去重，恢复仍校验hash。意外退出后当前head仍是最后一次autosave，启动时封存待完成编辑checkpoint，不回滚到旧历史版本。

Record 幂等回执只持久化稳定提交凭证（作用域、Record ID、提交 revision、body hash 和版本/元信息结果），不复制正文树或 HTML/Markdown/纯文本；正文通过 head / version 单独读取。重试仍返回原提交 revision，不把当前 head 冒充原结果。既有完整正文回执在工作区打开时校验 hash 后压缩，容量统计包含保存回执占用。

新增表：`record_document_heads(record_key PK,head_revision,document_json,body_hash,schema_version,edit_session_id,checkpoint_due_at,updated_at)`；`record_versions(id PK,record_key,version_number,head_revision,document_snapshot,html,markdown,code_language,title_snapshot,body_hash,origin,actor_json,operation_id,restored_from_version_id,created_at, UNIQUE(record_key,version_number))`；`record_version_assets(version_id,asset_ref, UNIQUE(version_id,asset_ref))`。current head与snapshot都用Workspace相对资源路径，不注入本机路径。Record实体删除沿既有删除流程清理本实体历史；本计划不开放Agent整对象删除。

### GUI与Agent并发

所有正文写入口都接入同一CAS服务：Project/Workspace Record upsert、RecordSaveCoordinator、QuickNote append、编辑器AI接受和版本恢复。不存在“Agent有CAS但GUI仍能无条件覆盖”的旁路。

- 内置应用patch前向所有持有目标Record的窗口请求flush Committed Content，并短暂获取该Record提交锁；有未接受AI预览时，返回EDITOR_REVIEW_PENDING，保留patch候选并定位该编辑器，不自动接受/丢弃预览。
- 外部patch同样走当前Workspace的保存协调：窗口有dirty正文时先请求flush（不含预览）。flush导致revision变化则返回冲突；2s无响应返回EDITOR_BUSY；有未决AI预览也返回EDITOR_REVIEW_PENDING。不存在打开窗口时可直接CAS；绝不把其他窗口未保存草稿当作可覆盖旧值。
- 共享写入服务强制执行 patch、版本恢复和已有 Record 的 QuickNote 追加协调，入口只提供窗口适配接口。纯转换后、提交锁前请求 flush，等待后重新验证 Workspace binding，再获取锁并执行最终 CAS；幂等回放直接返回原凭证。GUI autosave 负责响应 flush，不递归请求协调；headless 适配器明确确认无窗口并继续 CAS。
- GUI排队autosave从所基于的headRevision开始CAS；前一条由同一coordinator成功写入时更新链上的expectedRevision；外部更改后的旧队列不能无条件追写。冲突保留本地draft并展示“查看差异/重载/另存Record”，不丢输入、不自动last-write-wins。
- patch提交成功后清洁编辑器接收新head并通过事务映射光标；脏编辑器只显示冲突提示。headless M4没有窗口时跳过UI协调，仍保留CAS。

<a id="e9"></a>

## E9 File更新与已有版本复用

`file.update`目标必须是已有File ID，携带expectedVersionNumber与expectedContentHash。新文件用file.create；二者不能用“同名”自动推断，修改后File ID不变，current_version_number+1，旧内容保留在现有history_dir_path。

- `file.patch_text`首期支持已登记UTF-8 md/txt/html/htm：`edits:[{oldText,newText,occurrence?:number}]`精确匹配（多处且未给occurrence报AMBIGUOUS_MATCH），或 `appendText`；所有定位基于同一base字节快照，编辑范围重叠则拒绝。无模糊匹配、不默认改换行/编码/BOM；空oldText拒绝，追加只用appendText。
- `file.update`还支持完整替换字节，格式不限于md/txt（保持目标原文件类型/扩展名，跨类型变更应新建File）：CLI读取外部Agent产出的DOCX/PDF/图片等，通过上传获得一次性stagedContentId，再提交为新File Version。可保存任意已允许文件类型不等于内置Agent能编辑所有格式；内置首期支持md/txt/html/htm源码生成与修改，其他格式通过外部编辑产物提交。
- 上传上限100MiB，分块1MiB、校验长度与SHA-256，10min过期，绑定connection/run和目标File/期望版本，不能跨scope复用；上传API接收字节，不接收远程请求指定的任意本机绝对路径。超限要求使用现有本地文件版本导入界面，不无限内存base64。
- staged新内容必须在Workspace托管临时目录，不能在Agent工具中原地改当前managed_path。拿到File级锁后校验DB版本与实际磁盘hash，未知外部修改返回FILE_CHANGED_UNREGISTERED；用户先用现有版本流程登记，再重新读取修改。
- 从现有 `Database::document_add_version` 抽出共享VersionCommitService，保留其base_name、versioned_file_name、history_dir_path、File ID和现有版本展示；为普通GUI“添加版本”和Agent更新统一加入CAS/receipt/journal。不能另建一套AI文件版本表，也不能只套SQL事务就声称文件操作原子。
- durable journal记录原版本路径/hash、staging路径/hash、目标路径、预期/新版本号。准备新内容→锁与二次CAS→旧文件归档→新文件落位→DB事务更新documents/document_versions/receipt/change log→完成。每一步崩溃通过journal确定完成或恢复旧版；相同requestId最多新增一个版本。取消进入提交区后结算并显示真实收据。
- 新内容hash与当前相同返回noChange不增加版本。历史版本仍可打开、引用；新增版本只使“读取最新内容”的索引重新处理，旧evidence不改指向。
- `file.version.restore`把指定历史版本内容提交为一个新的File Version，同样CAS与journal，不将current_version_number倒退；恢复历史路径不移动/破坏原历史字节。

<a id="e10"></a>

## E10 Todo修订与统一撤销

**执行规则**：新启用或未显式配置时默认`executionMode=review`（确认后执行）。用户可主动选择`collaborate`（自动执行）或`read_only`，保留已有明确选择的自动模式，升级不重置用户选择。Project可覆盖Workspace默认；Host捕获有效模式到run grant/output，设置改变不回写正在运行或历史候选。review同用户任务一次方案确认；外部连接仍由已配置操作集约束，不新增逐Todo/块审批。Overview后台维护继续按独立维护策略运行；任务确认不改变维护策略或扩大范围。

**Todo**：`todo.create`复用原生创建；内置review在任务确认后调用，主动collaborate直接调用；新增`todo.update`允许内容、期限、子项及完成状态修改，必须有expectedRevision。模型只能依据明确任务或已有事实改变状态，不能把“建议完成”当“已经完成”。所有GUI入口也走revision递增；新增`todo_revision_heads`及操作前后快照，不能假设现有Todo已有版本机制。重复requestId、重复回传同一成果只生成一次；同会话同消息范围的同一行动用持久dedupeKey复用，措辞变化也先检索已有Todo再决定是否新建。

**操作收据**：扩展`agent_operation_receipts`，记录operationId、run/connection、目标、operationKind、before/after revision或File Version、before/after snapshotRef、payload hash、摘要、撤销状态和恢复收据。会话删除不删除已提交对象或其撤销依据。写入和收据原子提交；File沿E9的journal。协作模式写工具仅在撤销依赖已就绪后开放，不能以“之后补撤销”作为M1完成。

**修改撤销**：Record/File恢复该操作前版本并创建新版本；Todo恢复操作前字段/子项快照并增加revision。撤销前要求当前revision/hash仍等于该操作after值；若已有后续人工或其他Agent修改，返回UNDO_CONFLICT、显示差异，不能用旧快照覆盖后来的工作。重复撤销返回原收据，不再生成版本。Agent遇冲突可以重读、提出新的有边界修改，不能自动强制回滚。Record/File复用原生已有版本恢复，修改前后版本和历史均保留；同一任务（run）内同一对象多次修改只定位任务前版本/快照并恢复一次，不逐操作反向执行或新增通用撤销框架/版本库。

**新增撤销**：新增对象需要可恢复撤回，不调用现有永久删除。增加`agent_object_withdrawals(object_key PK,creation_operation_id,withdrawn_at,restore_operation_id,revision)`；撤回保留对象内容、File字节及版本，从正常列表、Todo统计、上下文和搜索移除，直接引用显示“已撤回”并保留恢复入口。所有GUI/API查询采用共同可见性过滤；历史仍可查看。恢复后重建索引/发出事件，不重新分配对象ID。不自动清理撤回对象。对象被后续修改，或有本次撤销范围外的新入链时，返回冲突并保留，不能静默隐藏其他工作正在使用的对象。

**撤销本次更改**：UI按run展示已完成操作，每项可单独撤销，可一次选择撤销整个run。批量先预检对象修订和引用依赖，同一对象的连续修改合并恢复到批次前；新建后修改合并为撤回。先撤销产生引用的一方，再撤销被引用新对象；运行中有新改动仍逐对象CAS。循环引用组先校验整个组，再事务性撤回可见性。跨对象恢复不能宣称全局原子，发生部分成功显示逐项收据和剩余冲突，不把批量标全部成功。

**中断**：取消/断网/崩溃不自动撤销已完成操作，保留“已完成N项、未完成M项”。新run使用旧收据恢复，不能重做已提交创建。版本和撤回机制都不依赖模型在线。

**边界**：默认review仅同用户任务确认一次，不新增逐操作审批或审阅弹窗；权限不足、找不到目标、同名歧义、版本冲突是具体错误/澄清。资料中的指令不能扩大范围。现有AI Editor Skill的未接受选区预览仍按ADR-0003隔离；独立Agent通过领域服务提交已授权操作，不使用live editor预览绕过保存屏障。现有CONTEXT中的AI Modification仍专指Editor Skill，实施时应在新ADR明确这一区别。

<a id="e11"></a>

## E11 HTML交互稿与隔离预览

1. 用户说“根据这个需求做一个可点击的HTML交互稿”，Agent读项目来源，生成UTF-8 `.html/.htm`（单文件≤2MiB，内联CSS/JS、演示数据），经暂存校验形成候选。默认review按E7/E10对本次任务一次会话确认后提交`file.create`；只有用户主动选择的collaborate模式直接提交。实际保存成功后File列表显示它，会话显示“已保存 · v1”和预览入口，不再要求第二次保存确认。内容仍存现有File，不创建新的“原型”业务实体。
2. 用户在File菜单或预览点击“继续修改”，附加File ID、当前版本/hash及源码来源；预览保持打开。用户说“把筛选改为多选”，Agent读取原始源码、保留无关逻辑，通过`file.patch_text`或`file.update`提交；同File ID生成v2，不另建同名文件。聊天已明确引用唯一HTML时可直接继续，存在多个同名候选才询问目标。
3. 源码与索引分离：复用R07固定版本源读取helper，`file.source.read(FileRef,version,cursor?)`返回未经脚本清洗的UTF-8源码，单页≤24000字符，携带完整hash/字节数/版本、已读范围/complete/nextCursor；未读全不得声称已理解全文件或加载成完整预览。分页固定同一版本/hash，过期返回SOURCE_CHANGED并显式重载，跨对象/版本异步响应丢弃。聊天不默认展开整段代码；源码视图只读，编辑可交给Agent或现有外部编辑流程。
4. `FileHtmlPreview`接非模态主工作区与现有同scope会话侧栏，不另建聊天或编辑器。有“预览/只读源码”、当前版本、刷新、375/768/1440宽度及自适应选项、“继续修改”和版本历史入口。窄窗口在会话与预览间切换，不挤出三个不可用面板。按实际容器尺寸缩放，标明所选CSS viewport宽度。
5. 默认预览最新已提交版本，流式token与staging不逐帧重载。新版本提交后显示更新并加载；切换历史预览时固定File Version，后续新版本不得把用户看的旧版替换掉。恢复旧稿走既有`file.version.restore`生成新版本，引用仍可定位旧版。
6. 首期完整支持单HTML内联样式/脚本、嵌入图片、表单本地校验、弹窗、标签切换、筛选、模拟增删和hash路由。不依赖CDN即可演示。现有含相对资源、外部CDN、fetch/后端或多页路由的HTML仍允许导入、源码修改、版本化保存；预览明确列出未加载依赖，不声称完整支持工程项目。M1不承诺npm安装、打包构建或多文件原子发布。用户需要时可由Agent将可获取且被授权的资源内联为自包含稿，保留前一版。
7. `file.create`扩展名白名单扩为md/txt/html/htm；扩展名与MIME一致，HTML内容按原始字节保存，不用Record富文本sanitizer删除JS。已有HTML完整替换沿100MiB上传通路；内置生成2MiB限制不限制已有文件版本能力。超过可读/模型预算时明确说明可处理片段。
8. 校验文件可读、非空、编码、大小与HTML文档结构，提供预览加载/脚本错误诊断；语法可解析不等于交互验收通过。开发fixture必须验证点击、输入、筛选和恢复版本。Agent只有实际收到对应预览测试结果才可说“已验证交互”；否则说“已保存，可预览”。

### 预览隔离

开工先复用R07源/版本/restore与R04d～g会话接缝，用实际fixture比较隔离候选再确定单一实现；本节列出必须满足的边界与候选参数，不宣称iframe或原生WebView已验证。前端fixture、真实IPC文件链路、真实模型任务及macOS WebKit/Windows WebView2安装环境分别记录证据，不能互相替代；执行拆分见交付计划R08a～d。

- iframe候选在无应用能力的surface中执行，设置`sandbox="allow-scripts"`，不加`allow-same-origin`、forms、popups、downloads或top-navigation权限；不把生成HTML注入主应用DOM。以srcdoc承载自包含内容并维持opaque origin，不暴露Tauri IPC、连接凭据、Workspace绝对路径或任意文件读取接口；是否满足实际平台约束由fixture与安装环境验证。
- 预览层附加CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。策略仅作用于预览副本，不修改保存的源文件。内联事件可运行，不开放eval；阻止外部网络、子frame和真实表单提交。同时验证父WebView CSP不会使合法内联交互全部失效，允许脚本的放宽仅用于该隔离surface。
- iframe sandbox和connect-src本身不能拦截所有frame自身导航。宿主必须对预览surface加网络请求/导航拦截：只允许初始受控内容、data/blob资源和同文档hash变化，拒绝外部URL导航与请求；在实际WebKit/WebView2验证链接、location、meta refresh等路径。若不能可靠约束子frame，则验证无应用能力的专用WebView及宿主层拦截候选；未能证明等价边界前不开放预览，不能只靠前端click监听。
- srcdoc构造时由可信代码把限制策略放在内容前；导入文档的meta不能放宽策略。拦截资源失败显示依赖状态；工具诊断和postMessage都视为不可信数据，即使来源窗口匹配也不能触发文件写入或提升权限。停止、关闭及切版本销毁iframe。
- HTML不能依靠预览访问本地持久存储或真实业务API；交互状态是本次演示内存。刷新/切版本会重置演示状态，界面如实提示。M0或AI-18先在实际Tauri/WebKit平台做隔离与内联交互smoke；若iframe候选不能证明隔离，则验证独立且无Tauri capabilities的预览WebView及等价CSP，不把候选fallback视为已经安全，不能退回有应用权限的主页面。
- 依据：[MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)、[MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)。候选参数须由实际打包平台测试确认；恢复仍用既有服务及冻结的expectedVersion/hash，隔离选型不改变版本CAS或原始源码保存契约。

<a id="e12"></a>

## E12 统一API与错误语义

| 方法 | 输入要点 | 返回/语义 |
| --- | --- | --- |
| `project.list` / `record.get` | scopeGrant、cursor / scoped Record ref | 项目目录 / 已提交正文与revision；record.get等价source.read的记录专用入口 |
| `context.get` | scope、query?、budgetChars? | L0最小知识入口；默认2000/硬上限3000字符 |
| `context.settings.update` | scope、expectedRevision、goal/pins/policy | 新 revision；冲突返回原值 |
| `context.instruction.upsert/delete` | scope、id?、text、expectedRevision | 用户纠正说明；仅 GUI 可写 |
| `source.search` | scope、query、kinds?、cursor?、limit默认8/≤50、budgetChars默认3000 | 命中卡片+coverage+nextCursor，不自动加载命中文档全文 |
| `source.read` | ObjectRef、revision?、locator?、cursor? | 受限正文 + SourceRefs；每页≤12000字 |
| `source.policy.update` | ObjectRef、excluded | GUI 专用；立即影响后续工具调用 |
| `source.reindex` | scope/ObjectRef | jobIds，已相同 hash 直接返回 ready |
| `reference.list` | ObjectRef、direction、cursor | 作用域内的入/出链；无权目标不泄露标题/数量 |
| `session.create/list/get/archive/delete` | scope、cursor/id | 元信息/消息；归属创建后不可改 |
| `session.summary.get/refresh` | sessionId、branchId、revision? | 当前摘要/分段目录或更新job；scope校验，不获取全部原始历史 |
| `run.start` | sessionId、clientRequestId、text、selectedRefs、mode、savePolicy | runId；mode/savePolicy从用户设置派生，模型不可提升；预检全部完成后才发模型请求 |
| `run.cancel/get/events` | runId、afterSeq? | 状态/事件补读；cancel 幂等 |
| `output.stage` | runId、ordinal、kind、title、body、citations | staged output；仅当前 runtime 可调用 |
| `output.update` | outputId、expectedRevision、title/body/safeName | 仅GUI可编辑staged成果；服务端重新校验引用/格式并revision+1 |
| `output.commit` | outputId、requestId、expectedOutputRevision | objectRef + receipt；GUI按任务持久决定提交，collaborate下Host直接提交；须符合冻结模式、候选CAS与grant |
| `record.create` / `todo.create` | scope、body/title、citations、requestId | 对外 create 操作，走同一 canonical converter/业务事务 |
| `file.create` | projectId、safeName、utf8Content、citations、requestId | 首期≤2 MiB、md/txt/html/htm；不接受任意绝对路径 |
| `connection.create/revoke/list` | scopeGrant、operations、clientLabel | GUI 专用；仅创建时交付本机凭据引用 |
| `changes.list` | afterSeq、limit≤200 | 应用补读已提交变更，过滤权限 |

所有对外返回统一 `{apiVersion:1,requestId,ok,data?,error?}`；错误为 `{code,message,retryable,details?}`。不以自由文本识别错误。

错误码至少：INVALID_ARGUMENT、NOT_FOUND、SCOPE_DENIED、WORKSPACE_NOT_OPEN、WORKSPACE_CHANGED、PROFILE_UNAVAILABLE、SECRETS_LOCKED、TOOL_CALL_UNSUPPORTED、SOURCE_NOT_READY、SOURCE_CHANGED、REVISION_CONFLICT、RUN_BUSY、RATE_LIMITED、RUNTIME_UNAVAILABLE、RUNTIME_INCOMPATIBLE、CANCELLED、IO_FAILED、IDEMPOTENCY_CONFLICT、OUTPUT_COMMIT_FAILED。

分页 cursor 是携带查询条件 hash + 最后排序键 + snapshotSeq 的不透明 base64url JSON；参数变更或 manifest 失效要求从第一页重查。排序有 ID 兜底，不能只按同秒时间戳分页。

### 修改与版本接口

| 方法 | 关键输入/返回 |
| --- | --- |
| `record.blocks.get` | RecordRef、revision?、cursor；返回block树/ID/hash/headRevision，默认整段定位不按DOM offset |
| `record.patch.preview` / `record.patch` | RecordPatch；preview无正文副作用，apply需record.patch授权与二次CAS |
| `record.versions.list/get/compare` | RecordRef、versionIds、cursor；含来源和按块diff |
| `record.version.restore` | RecordRef、versionId、baseRevision、requestId；创建新正文版本 |
| `file.patch_text` | FileRef、expectedVersion/hash、edits或appendText、requestId；返回新File Version或noChange |
| `file.content.stage` | 字节分块、hash、FileRef/expectedVersion；返回限时stagedContentId |
| `file.update` | FileRef、expectedVersion/hash、stagedContentId、requestId；共用File Version服务 |
| `file.versions.list/get` / `file.version.restore` | 当前既有版本查询的scope wrapper / 指定旧版本恢复为新版本 |

新增错误码：INVALID_PATCH、BLOCK_NOT_FOUND、BLOCK_HASH_MISMATCH、EDITOR_BUSY、EDITOR_REVIEW_PENDING、AMBIGUOUS_MATCH、FILE_CHANGED_UNREGISTERED、STAGED_CONTENT_EXPIRED、UNSUPPORTED_DOCUMENT_SCHEMA。REVISION_CONFLICT统一承载CAS失败；错误不包含越权对象内容。

CLI增加 `record blocks get`、`record patch --patch-file ... [--dry-run]`、`record versions list/get/compare`、`record restore --version ... --base-revision ...`；File增加 `file patch --patch-file ...`、`file update --id ... --source-file ... --expected-version ... --expected-hash ...`、`file versions list/get`、`file restore`。这些命令继承workspace/project/connection/request-id参数；file update的本地source-file在CLI进程读出上传，不把任意路径交给server读取。

MCP新增 `mind_record_blocks_get`、`mind_record_patch`（dryRun）、`mind_record_versions_list/get/compare`、`mind_record_version_restore`、`mind_file_patch_text`、`mind_file_content_stage`（分块）、`mind_file_update`、`mind_file_versions_list/get`、`mind_file_version_restore`；每个斜杠展开为独立工具；与E10/E12节统一从注册表生成CLI/MCP schema。工具write/destructive hints如实标注，权限仍由Host验证；没有record.restore授权的patch不能以伪造operation触发历史恢复。

### Todo与撤销接口

| 方法 | 输入及语义 |
| --- | --- |
| `file.source.read` | FileRef、version、cursor；原始UTF-8源码与固定版本hash，不执行HTML |
| `todo.update` | TodoRef、expectedRevision、字段patch、requestId；校验子项归属，整体原子、快照、收据 |
| `operation.list` | scope、runId?、cursor；只返回调用者可见对象的操作与撤销状态 |
| `operation.undo` | operationId或同run的一组operationIds、expectedHeads、requestId；逐对象结果，不允许借撤销越权读取其他scope |
| `operation.restore_created` | creationOperationId、expectedWithdrawalRevision、requestId；恢复已撤回对象，幂等 |

CLI对应`file source read`、`todo update --patch-file`、`operation list/undo/restore-created`；MCP对应`mind_file_source_read`、`mind_todo_update`、`mind_operation_list/undo/restore_created`，与GUI/内置工具共享服务。撤销权限默认限连接自身操作和原授权对象；撤销其他主体操作须已有GUI用户权限或明确管理授权。撤销不能变成任意历史恢复的权限旁路。错误增加UNDO_CONFLICT、OBJECT_WITHDRAWN、PREVIEW_DEPENDENCY_UNAVAILABLE。

### 知识接口

`context.overview.get/refresh`、`knowledge.search/get`的选择字段、分页与预算见E3；`session.summary.get/refresh`与`session.messages.read`见E5。Overview维护设置、历史查看/恢复为GUI管理接口；外部refresh需context.refresh授权，普通读取不产生模型费用。

<a id="e13"></a>

## E13 CLI、MCP与连接配置

- M1 使用仅监听 `127.0.0.1` 的随机端口 HTTP JSON bridge；应用外网不可访问，不提供浏览器 CORS。校验 Host、拒绝带非应用 Origin 的请求，token 必须通过 Authorization header。
- 本机发现文件保存 runtime 实例、端口和 endpoint version，属于 Local Session，不能复制进 Workspace。连接 secret 只存 OS credential store；CLI 配置包含 grantId，不含明文 secret；同本机用户可读取凭据，不能宣称隔离该用户启动的任意程序。
- 每个 grant 绑定 Workspace UUID、可见 Project 集合和操作集；创建连接时默认推荐“单Project协作”预设，含读取、新建、Record/File/Todo修改与本连接操作撤销；用户可选择只读或自定义。Workspace 级授权用户显式选择。权限底层分开记录create、record.patch、file.update、todo.update、operation.undo及可选任意历史restore；块删除包含在patch内，整Record/File对象删除、密钥设置、任意路径和shell仍不暴露。
- Workspace 切换使运行请求返回 WORKSPACE_CHANGED，不能自动转接新 Workspace。请求超时后客户端查询 receipt，不能自动重复非幂等变更。
- CLI 没有解锁模型密钥的 API；纯数据读写不要求模型密钥解锁，内置模型任务要求解锁。首期 CLI 不开放启动内置 run，避免外部任务隐式产生模型费用。

### CLI

```sh
mind --version
mind doctor --workspace <path> --connection <grantId> --json
mind schema context.get --json
mind project list --workspace <path> --connection <grantId> --json
mind context get --workspace <path> --project <id> --connection <grantId> --json
mind search '发布方案' --workspace <path> --project <id> --connection <grantId> --json
mind record get <id> --workspace <path> --project <id> --connection <grantId> --json
mind record create --title '方案' --body-file result.md --workspace <path> --project <id> --connection <grantId> --request-id <id> --dry-run --json
mind file create --name result.md --body-file result.md --workspace <path> --project <id> --connection <grantId> --request-id <id> --json
mind todo create --body-file todo.md --workspace <path> --project <id> --connection <grantId> --request-id <id> --json
mind reference list --kind record --id <id> --direction incoming --workspace <path> --project <id> --connection <grantId> --json
mind mcp serve --workspace <path> --connection <grantId>
```

`--body-file -` 读 stdin，文本不经 shell 拼接；`--dry-run` 只校验和预览，不创建任何业务对象，正式写仍须重新校验。JSON stdout 只含结果；诊断 stderr。exit code：0成功、2参数、3连接/Workspace、4权限、5冲突、6可重试故障、130用户取消。body 文件由 CLI 本地读取成内容；服务端不接受模型指定的任意路径。

CLI 通过安装目录绝对路径可用；设置提供复制命令和安装到用户 PATH 的可逆操作，不静默写 shell 配置。不将机器相关路径写入 Workspace 文档。

### MCP

使用维护中的 Rust MCP SDK 封装 stdio adapter，M0/AI-09 锁定版本。支持标准初始化和协议版本协商；初始兼容基线 2025-11-25。stdout 只承载 JSON-RPC，日志 stderr。首期不实现远程 Streamable HTTP MCP、sampling、elicitation 或外部 MCP client 聚合。

基础工具为（E12及E10/E12节扩展修改、历史、源码、撤销工具；完整列表由能力注册表生成）：`mind_project_list`、`mind_context_get`、`mind_search`、`mind_source_read`、`mind_reference_list`、`mind_record_create`、`mind_file_create`、`mind_todo_create`。schema 与 CLI 来自同一 Rust DTO/JSON Schema 定义；读工具声明 readOnlyHint，写工具不能误标只读。所有 schema 注释说明作用域、预算、来源和重试规则。

可选资源仅提供稳定上下文入口 `mind://<workspaceId>/projects/<id>/context`，仍须权限校验。首期不强制依赖 MCP resources/prompts，因为工具已能完成所有流程。

设置“外部连接”：启用开关、运行状态、每个连接的范围/读写权限/撤销、CLI 检测、复制通用 MCP JSON 配置。仅复制配置为首期必做；自动写入某 Agent 的配置属于 AI-14，须备份并只修改自己的键。

<a id="e14"></a>

## E14 助手界面与失败恢复

- GUI固定vendor官方Pi Web UI 0.75.3的MessageList、Messages与StreamingMessageContainer少量展示源码，保留来源/版本标记与MIT许可证；使用Lit 3.3.1，经React薄适配接收现有会话DTO和流式事件。此选型只覆盖展示层，运行时仍固定pi-coding-agent 0.99.1；不导入legacy browser Agent、IndexedDB会话/凭据storage或provider，也不把SDK移入Vite主bundle。
- Project Mind提供安全Markdown leaf、中文工具折叠renderer与scoped样式token，复用现有对象resolver、来源与操作控件；不以旧UI中的任意HTML、工具执行或文件访问替代Mind边界。vendor限上述展示所需源码，不导入整套旧AgentInterface/ChatPanel/Artifacts运行环境；组件适配验证、Tauri/原生链路和真实模型验收分别判断。
- 稳定非模态右侧面板，可展开到主工作区域；业务页面保持可操作，不采用Dialog遮罩/焦点锁承载会话。与Todo Rail沿现布局协调，避免两个不可用右栏。窄屏单栏保留返回业务入口；按736/1200/1540集中验收，不另定义固定像素布局。
- 同一会话在面板收起/展开和布局切换时保留draft与scroll，关闭面板不取消run；切项目不改变活动会话归属。Workspace代际、会话与run匹配仍过滤旧事件/响应。
- 顶部仅项目/会话标题、历史、新会话和更多。历史按最近更新时间30条分页并按需展开，消息按50条加载；模型/probe、知识维护与技术设置移入设置或更多菜单，不常驻主消息轴。空态两个入口与输入框可见，零完整知识预读。
- 用户消息浅底；助手正文通过正常Markdown排版。以稳定消息ID和用户任务轮次组织正文、折叠工具过程、方案与收据摘要；历史分页无重复控件，不把所有run的操作放到聊天尾部，不造另一份模型消息历史。
- 工具仅显示“查找资料/读取文件/准备方案”等业务摘要，详细JSON/来源按需展开且不含凭据/内部路径；错误在折叠态仍可见。方案确认/取消和实际结果位于所属轮次，结果只展示一次实际业务摘要与对象链接，按E7绑定冻结模式和候选决定。
- Record/File菜单“带入助手”使用同scope空闲会话及可移除来源/目标提示；当前会话scope不同或运行时新建同scope会话，不能静默切范围。成果打开实际Record/Todo/File页面；查看/编辑旁可继续对话，继续修改绑定实际对象与当前基线。R08才接隔离HTML，不以GUI收口提前执行HTML。
- 运行可继续写草稿，不允许同会话并发发送。首版显式停止当前run、等待已开始操作settled后发送草稿，不隐式入队、自动续发或实现steering框架。
- 未在底部时不强制滚动，提示新内容；在底部时跟随正文和异步方案/结果高度变化。用户展开工具/历史与切换布局仍保留阅读位置；有界列表沿现渐变遮罩，内容/尺寸变化后更新。
- 引用按需预览，再打开实际原文；File显示固定版本/页码，旧版可查看、变化/缺失/删除明确标识。未展开来源不预读全部正文。
- 加载、折叠和布局位移复用motion token，reduced-motion降级；标题与卡片左对齐，不新增设计系统。

助手“项目知识”菜单按需显示Overview更新时间、coverage、来源/纠正/排除与刷新入口；不在Project首页增加知识卡片。空态和设置均不默认把完整Overview发给模型。

| 情况 | 显示与恢复 |
| --- | --- |
| 没有模型/密钥锁定 | 显示配置/解锁入口；现有笔记、文件和确定性的最近变化仍可用 |
| 模型不支持工具 | 明确指出当前 Profile，保留问题草稿；可选择其他 Profile |
| 文件尚未处理/格式不支持 | 引用面板显示状态；回答中不暗示读过正文 |
| 网络错误/模型限流 | 保留已收到的片段，标“未完成”；重试创建新 run，不重放写操作 |
| 用户停止 | 结算已开始提交，保留片段和真实收据，区分已完成/未完成/已取消；不显示“已完成任务”，草稿由用户结算后发送 |
| Sidecar 崩溃/应用意外退出 | 下次启动将活动 run 标 interrupted；用户选择继续，默认不自动重试 |
| Workspace 切换/关闭 | 先停止任务并等待工具写入结算，再执行现有保存屏障；不能把旧事件写进新 Workspace |
| Project Archive | 已有会话可只读查看；恢复项目后可继续，普通检索不加入归档对象 |
| Project/会话删除 | 停止相关任务；删除引用关系或留删除标识；已保存的 Record/File 不因删除会话被删除 |

<a id="e15"></a>

## E15 后续批次的接入边界

Workspace会话默认先读Workspace Overview，再按问题进入相关Project Overview或Workspace Record/Todo，最后读原始来源。Workspace不是项目摘要的简单拼接：它同时承载非Project的长期领域、兴趣知识、方法、工作背景与明确偏好。

更新输入为旧Workspace Overview、发生变化的Project Overview条目、Workspace直属资料增量及用户纠正。项目先更新、Workspace再聚合；某项目失败则保留其旧修订并标滞后，不阻塞其他项目。按E4每日/隔日批次运行，无变更不调用模型。

Project不能反向读取Workspace记忆；Workspace只能读取已授权项目集合，不能把全Workspace摘要泄露给只授权部分项目的连接。排除、删除、撤回来源即时影响派生概览/记忆可见性，详见E4。

综合产出仍保存为Workspace Record/Todo；File必须归Project，当前不增加Workspace File。长期知识原文使用Workspace Record及现有引用；维护层独立保留来源、确认程度、适用范围和失效状态，不把推测当用户事实，不要求用户逐个建立主题。

### 外部Agent与任务菜单

先接入用户自行安装的 Pi CLI（结构化 RPC）和 Claude Code（非交互结构化输出）两种运行时，与内置 SDK 适配器共用生命周期测试。Claude 适配器使用 `-p --output-format stream-json --verbose --include-partial-messages`，以最终 result 和进程状态判定完成，保存返回 session ID 并显式 resume；参数需先通过已安装版本的 help/capability 验证，不兼容则禁用。正文经 stdin，非 shell 拼接。其他 Agent 可通过 Mind MCP/CLI 使用项目，不假定协议相同。

RuntimeAdapter 契约：detect、capabilities、start、send、cancel、resume、dispose；capabilities 含 structuredEvents/toolBridge/resume/cancel/fileOutput/scopeEnforced。用户配置只描述 executable、argv 数组、protocol 和环境变量名引用，不允许 WebView 直接执行 shell 字符串。

若接入具有自带 shell/file 工具的外部 CLI，标为“外部执行”，不声称 Mind scope 限制其操作系统文件访问。应用在独立 task staging 目录启动，只把用户选定的快照提供进去；结果经已配置的成果回传契约和共同写入服务自动登记、保留版本并可撤销；协议无法可信定位成果时提供手动导入。不得绕过该CLI自身审批。无法在所选协议关闭任意文件工具时，不开放“与内置同等受控”的运行模式。

可配置任务菜单采用 `TaskPreset {id,name,description,placements,inputKinds,promptTemplate,runtimeId,outputKind,mutationIntent,savePolicy,enabled,order}`。placements 仅 Project/Record/File 菜单和会话空态；模板变量白名单（project.name/selection/sourceRefs/userInput），纯文本展开，不能执行表达式。默认任务固定两个，用户最多自建20个；现有 AI Editor Skill 保持选区编辑语义。

### 无界面Host

抽出 `WorkspaceHost` 拥有 DB/文件变更队列/事件 outbox，GUI、CLI 都是 client。每 Workspace 一个本机服务拥有写锁；GUI 连接已存在 Host，不能在同一 Workspace 再创建平行 DB runtime。使用 OS 文件锁 + 实例 token，PID 仅用于诊断，避免 stale PID 误判。

`mind serve --workspace <path>` 前台运行；`mind serve --stop/status` 管理自己实例。首期后台服务不随系统自动启动。CLI 退出不终止已明确启动的服务；GUI 关闭是否保持 Host 由用户开关，默认结束。

没有界面时密钥通过本机 credential store 和用户此前授权的非交互策略获得；没有授权返回 SECRETS_LOCKED，不从 stdout/argv 传密码。可先支持无模型的读取/创建/版本化修改、提取索引，再开放有预算上限的维护。复用 M1 API v1 与 receipt，不引入另一份数据库。

<a id="e16"></a>

## E16 性能、观测与参考

本节是验收目标，不是已测得指标。M0 固定测试机器配置，记录版本、冷/热状态和语料规模。

- 3000 条 Record + 200 份文本资料样例：本地 context.get 热态 p95≤300ms，search p95≤500ms；不包含模型响应。
- 知识状态读取≤200ms；Overview维护和首模型token 不承诺固定秒数，但立即提供进行状态，超过60s有明确超时。
- 每秒最多20次流文本 UI 更新，避免每 token 整页 rerender；非可见项目不执行聊天 DOM 更新。
- Agent SDK 不进入主前端 chunk；继续通过现有主入口250KiB边界检查。Agent 面板动态加载。
- 本机日志指标：检索耗时、来源读取成功率、引用解析失败率、成果保存/冲突、取消耗时、恢复结果；无远程埋点默认上传。
- 用户验证：准备3个真实项目，由用户完成历史问题定位、查找依据、生成并找回文件。记录用时和纠正次数，不用“聊天条数/自动生成 Record 数”作为成功指标。

参考（一手资料，2026-09-28核对）：

- [飞书CLI](https://github.com/larksuite/cli/blob/main/README.zh.md)：借鉴可发现命令、schema与结构化结果。
- [Open Design runtime adapters](https://github.com/nexu-io/open-design/blob/main/docs/agent-adapters.md)：借鉴连接方向分离、能力探测和适配层，不能照搬其他CLI的权限绕过参数。
- [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：借鉴来源/关联理解/维护规则及摄入、查询、检查；本文的对象与默认自动化策略是Mind自己的设计。
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[安全边界](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)：验证嵌入方式、历史恢复、工具和资源边界。精确SDK签名和可发布版本由AI-01锁定。
- [Pi会话格式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)：恢复与路径codec验证依据。
- [Claude Code非交互接口](https://code.claude.com/docs/en/headless)：AI-13结构化输出与恢复参考，不预先承诺任意版本兼容。
- [MCP stdio规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：外部协议边界。

GUI参考（2026-10-08按官方源码核对，行为借鉴范围见E14与[交付R04d～g](ai-work-context-delivery.md#r04-gui)）：

- [Pi Web UI包](https://www.npmjs.com/package/@earendil-works/pi-web-ui)与[移除Web UI workspace的官方提交](https://github.com/earendil-works/pi/commit/b141e1fa2460868686ffd19c5d4ced743eee6c24)：固定0.75.3展示源码/MIT的复用依据，与0.99.1运行时的版本边界；不代表同版完整GUI可直接接入。
- [OpenCode session-permission-dock](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/composer/session-permission-dock.tsx)：借鉴会话内明确决定与低干扰提示，不照搬逐工具权限或“始终允许”策略。
- [DeepSeek Harness ui-chat](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/README.md)、[TurnProcessNodeView](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx)、[ApprovalPanel](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-approval/src/client/ApprovalPanel.tsx)：借鉴真实Session分组、过程折叠、滚动恢复和原位决定；不引入其queue、approval waterfall或请求组装机制。
- [Hermes Web ChatPage](https://github.com/NousResearch/hermes-agent/blob/main/web/src/pages/ChatPage.tsx)：Web页主要承载xterm终端，结构化事件另有侧栏；只参考会话/过程组织，不把终端外壳当作Mind聊天GUI，不引入PTY/shell能力。

# 会话列表追加性能审查

日期：2026-11-10；基线 `fe9fe9c188f05c23bae369074446e38c0859a0c8`。关联 Issue：本轮用户直接报告，未新建 Issue。依赖：既有 full-review 上下文、当前 Project/Workspace 会话侧栏与 DSH 实现。交付：新增性能发现和最小修复选择，供主审合并；不替换已完成的 `02b-performance.md`。

范围与验收：定位侧栏列表→前端缓存/队列→native host/scope readiness→JS catalog/title→持久化读取；区分首个 host 冷启动、新项目首次访问及回访；评估仅索引预取，不提前加载所有对话。此次只读源码、已安装依赖和现有文档，未启动 GUI/build/tests、未改业务代码、未读取用户会话数据，也没有启动 review 子 agent。没有列表耗时实测，以下为静态调用链确认，不把用户“半天”转换为具体秒数，也不使用 Office 测量替代会话测量。

**结论：用户提出的“工作区打开后后台加载轻量列表，切项目直接使用”可行。当前并非完全没有缓存，也不是每个项目都重启 Node；真正问题是列表读取强制刷新全工作区 catalog、新 scope 注册清空标题缓存、冷标题通过完整 Session observation 串行验证，并且这些工作占用整个 native runtime mutex。前端缓存只回显已完成结果，不能阻止重复请求，也没有预取新项目。**

建议合并为两个独立发现：S1 **P1 / High：列表摘要触发全局扫描＋冷会话全文投影并串行阻塞**；S2 **P2 / Medium：前端手工缓存/取消机制不复用请求，新项目无列表预取**。provider/host 耦合属于 S1 的启动链与修复范围，不额外重复计数。

## 1. 用户操作实际走哪条链

| 阶段 | 真实行为与位置 |
|---|---|
| 展开项目侧栏 | [HomeProjectSidebar.tsx:91](/Users/xuchen/project_mind/src/components/home/HomeProjectSidebar.tsx:91) 挂载 `LazySidebarSessions`；Workspace 侧栏也使用同组件，[WorkspaceOverviewSidebar.tsx:375](/Users/xuchen/project_mind/src/components/workspace/WorkspaceOverviewSidebar.tsx:375)，projectId 为 null。 |
| 首次请求 | [LazySidebarSessions.tsx:8](/Users/xuchen/project_mind/src/components/home/LazySidebarSessions.tsx:8) 只在可见后挂载；[ProjectSidebarSessions.tsx:133](/Users/xuchen/project_mind/src/components/home/ProjectSidebarSessions.tsx:133)，133–146 无条件 refresh，调用 64 行 `dshAssistantApi.sessions(projectId)`。不等待前端 AI 设置 query。 |
| 窗口内串行队列 | [dshAssistantApi.ts:8](/Users/xuchen/project_mind/src/services/dshAssistantApi.ts:8)，8–14 按 projectId 串行 start/list/select/manage/delete；30–31 调 native `dsh_assistant_sessions`。 |
| 全局 native 锁 | [dsh_assistant.rs:1608](/Users/xuchen/project_mind/src-tauri/src/dsh_assistant.rs:1608)，1608–1633 在 `state.inner.lock().await` 内依次 ensure_scope、校验、等待 HTTP list、再校验。锁覆盖所有 scope，不仅当前项目。 |
| host/scope | 同文件 [117](/Users/xuchen/project_mind/src-tauri/src/dsh_assistant.rs:117)，117–131 已注册且有效的 scope 直接复用；新 scope 走 ensure_ready。77–114 复用一个 Workspace host，必要时启动 Node，然后注册该 project。 |
| 列表 HTTP | 同文件 [1128](/Users/xuchen/project_mind/src-tauri/src/dsh_assistant.rs:1128) → `mind/session/list` → [project-workspace.mjs:372](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/project-workspace.mjs:372) 的 scoped list。 |
| JS catalog/标题 | [project-workspace.mjs:296](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/project-workspace.mjs:296)，296–332 先全局 catalog，然后过滤当前 cwd，再串行校验每个冷会话标题，最终才返回。native 1148–1178 最终只投影 id/title/running/pinned。 |

辅助入口 `DshAssistantPanel.tsx:89–103` 还存在显式 `start → sessions → selectSession` 串行序列；但上述侧栏不显式调用 start，不能混淆两者。`workspace/initializeDefault` 在 JS 287、371 行用于 workspace membership snapshot，会调用 catalog；它不在侧栏 `sessions()` 的直接必经链。`session/initializeDefaultModel` 是另一个模型设置 RPC，不能把名称相似当作列表必然等待它的证据。

## 2. S1 [P1] 轻量列表反复进入全局 catalog 和冷会话完整投影

**A. 每次 list 都显式绕过现有 catalog 缓存。**

[project-workspace.mjs:297](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/project-workspace.mjs:297) 是 `readCatalog(signal, true)`。104–113 行中 refresh=true 直接提升 minimumSerial 并清空 catalog，故现有 5 秒 reconciliation 不是列表的 5 秒缓存命中窗口。119–134 再调 original.sessionList，计算持久化 revision，构建全局 byId；301 行才按当前目录过滤。

安装的 rc.2 `@deepseek-ai/dsh-api-session-controller/lib/index.js:2954–2955` → 1888–1904 `sessionQuery.listSessions`；`dsh-session-query/lib/index.js:95–115` 列举全部 persisted headers 并与 live sessions 合并；`dsh-session-persistence-jsonl/lib/index.js:2569–2597` 的 list 调 listArtifacts、逐文件 stat；3031–3055 逐 generation 读 header。**这一级是全工作区元数据扫描，不是每个文件全文读取。** 已有 AsyncLocalStorage（项目脚本 63–73、121–122）在一次 catalog read 内复用了 persistence.list，避免同一次读取又扫描第二遍；不应把已消除的重复扫描重新报错。

**B. 新项目 scope 注册清空所有标题缓存，即使共享 host 存活。**

native [dsh_assistant.rs:107](/Users/xuchen/project_mind/src-tauri/src/dsh_assistant.rs:107) 注册新 scope → [dsh_cli.rs:62](/Users/xuchen/project_mind/src-tauri/src/dsh_cli.rs:62)，62–67 先注册 EmbeddedCli，再发送 `mind/context`。JS `register` [project-workspace.mjs:179](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/project-workspace.mjs:179)，179–205 完成目录映射后**无条件 `invalidate()`**；78–80 清空 catalog、titles、attachments 和 inventory cache。

因此 A 项首次访问完成后，首次访问 B 项并非只做一次目录查找；B 的注册使全局 catalog/title 小缓存失效。已有映射的 register 也会到达 invalidate。正确的目录归属、授权与真实变更仍要校验，但单纯 admission 更新不应当被视为所有历史标题均已变化。

**C. 仅为标题逐个请求完整投影，缓存未命中时读取完整会话日志。**

[project-workspace.mjs:305](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/project-workspace.mjs:305)，305–324 对当前目录中 `agentAvailable === false` 的每一行串行处理；小 title cache 未命中就 `await sessions.projections(...)`，最终只保留 `block.values.title`。即使列表已经携带 cached title，首次仍要求验证，因为这些 hints 可能是 predecessor。

安装依赖的确定链：

- [dsh-api-session-controller index.js:3149](/Users/xuchen/project_mind/packages/dsh-assistant/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:3149)，3149–3164 请求 `sessionQuery.observeSession`，得到**全部 registered projections**，不是只读标题。
- [dsh-session-query index.js:348](/Users/xuchen/project_mind/packages/dsh-assistant/node_modules/@deepseek-ai/dsh-session-query/lib/index.js:348)，348–393 对冷会话 stat 后查 prepared cache；未命中时 loadSource、以全部 events prepare Session，再 preparedProjections。507–511 hydrate 所有投影。观察缓存默认 5 个（1051–1054），项目的小标题缓存与这个缓存不是同一个。
- 同文件 [34](/Users/xuchen/project_mind/packages/dsh-assistant/node_modules/@deepseek-ai/dsh-session-query/lib/index.js:34)，34–46 用 read handle 执行 `handle.read(0, undefined, options)` 并关闭，读取完整连续日志；410–413 是上述 loadSource 的直接调用。

所以一次列表等待近似为全局 metadata scan＋当前 scope 各冷 cache miss 的日志读取/prepare/projection耗时之和。其他项目日志正文没有在这个 hydration 循环里逐一打开，不能夸大成“所有项目的所有正文每次都读”。已有 live、title cache 与 prepared cache 能节省工作，但新项目 admission 的全局 invalidation 和仅 5 个 prepared entry 使重复成本仍成立。标题校验过程中如果跨度超过 reconciliation 时间，326 行 final readCatalog 也可能再次扫描 metadata；这取决于时长，不宣称每次发生。

**D. 等待扩大到无关项目，且纯列表被执行环境门槛拦住。**

native 1608–1633 持全局 runtime 锁等待上述 I/O；其他项目请求即使前端队列互相独立，也要等待同一锁。首次 host boot 的等待也在这个锁内。`Configuration::resolve` [dsh_assistant.rs:288](/Users/xuchen/project_mind/src-tauri/src/dsh_assistant.rs:288)，288–325 要求 secrets unlocked、General 默认 profile 可用，并解析全部 eligible profile；默认选择约束见 [agent_profiles.rs:55](/Users/xuchen/project_mind/src-tauri/src/db/agent_profiles.rs:55)，55–101。缺失默认模型或密钥会使纯历史列表失败，而不是只禁用新执行。

新 scope 的 ensure_ready 会解析 host 和 target 配置，注册完成后又核验 target；只有 host 不存在、identity/配置变化或目录变化才 stop/launch（77–114）。**不能将其描述为“切每个项目都重启 DSH”**。JS host ready [runtime.mjs:90](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/runtime.mjs:90)，90–129 要等 plugin boot、CLI binding、context、source/Office/selection service 和 scheduler 安装后才发布 READY。45 秒是 native ready 超时上限，不是本次实测耗时。

默认 provider 配置来自主应用，`shared-model.mjs:44` 指定 mind-main/default；安装的 `dsh-agent-default-model/lib/index.js:38–44` 只是本地读取配置引用。未发现上述列表链必须等待远程模型回答或标题 LLM 生成，不把 provider 网络请求认定为现场原因。独立 scheduled-task 恢复仅在有 enabled task 时会预热 scope（`dsh_schedules.rs:121–134`），并不保证每次打开 Workspace 就存在暖 host。

**最小修复选择：**

1. 先建立真正的 `listSummaries(scope)`：使用已持久化、带源 revision/asOfSeq 的轻量标题摘要，不为列表强制启动所有 projections。标题较旧可先显示已知标题并后台校正，归属、删除/归档和授权必须在返回前确认，不能为了显示速度接受其他 scope 的数据。
2. 将 scope 注册与 session corpus invalidation 分开；只有实际影响 membership/title/physical source 的变更才失效对应索引。普通 list 复用 catalog generation＋watch/reconciliation；显式用户刷新才强制检查。不能只删除 `true` 就宣称修复完成：仍要验证外部进程修改、watch 丢事件与删除的可见性。
3. 新增/更新 session 时维护可重建的摘要索引；旧数据缺索引时先读已有 header/hint，后台有界补齐所需 projection，不把全部历史 replay 作为 Workspace ready 或列表返回屏障。不能使用旧原生 agent_sessions 表代替真实 DSH 历史，它们不是已证明同一权威源。
4. 将只读 list capability 与 AI execution readiness 分离。可以先在现有共享 host 内开放 storage-only catalog mode，随后执行时再确保 CLI/provider 完整就绪；如选 native 持久化摘要，也应由 DSH 事件/写入同步并有明确 revision。不要复制一套不兼容的 JSONL 解析器。
5. 缩短全局 native 锁：锁内取得带 Workspace generation/scope 的稳定 read handle，I/O 在锁外；返回前重验 admission/生命周期。当前 process 可在 scopes 之间移动，不能机械地 drop guard 后借用它，也不能去掉跨 await 的工作区/权限校验。此项应在轻量接口边界实现，不无界并行扫描全文。

## 3. S2 [P2] 手工 Query 缓存只回显结果，不减少重复请求或提前准备新项目

[ProjectSidebarSessions.tsx:25](/Users/xuchen/project_mind/src/components/home/ProjectSidebarSessions.tsx:25)，25–33 scope/visibility 改变会 remount；cache key `['agent','sidebar-sessions',workspaceRoot,projectId]` 正确区分 Workspace/Project。state 初始化从 `getQueryData` 取已完成结果，因此回访已完成的项目可立即显示已有条目；loading spinner 不等于缓存条目被隐藏。

但 56–73 的 load 每次直接走 API，再 `setQueryData`，没有 `useQuery`/`fetchQuery` 去复用进行中的 promise 或检查 staleTime。133–146 还在每次 mount 与 window focus 无条件 refresh；[queryClient.ts:3](/Users/xuchen/project_mind/src/lib/queryClient.ts:3) 的 15s staleTime、10min gcTime 和 refetchOnFocus:false 无法约束这个手写事件处理。组件只读一次 QueryClient 数据，不订阅 query 变化；后台其他预取即使填缓存，也不会自动更新已经挂载的本地 sessions state。

切走时 AbortController 只阻止 state/cache 写入，未传给 API/native（51、64–68）；未完成结果被丢弃，但原生读取仍占锁。快速 A→B→A 会累积实际请求，A 第一次完成也不会用于回访。前端 runtimeCommand 队列按 projectId、没有 workspace generation；本报告只将它视为缺少取消/旧请求成本控制，不额外推断跨工作区数据泄漏，native 仍有 identity 校验。

[project-prefetch.ts:6](/Users/xuchen/project_mind/src/lib/project-prefetch.ts:6) 只预取 projectPage 和 tags，没有 session summaries；懒加载只解决组件 bundle，不会预取未访问项目列表。Workspace 真正切换时 `App.tsx:552–559` 清 `queryKeys.workspaceScoped`，其中 `queryKeys.ts:3` 包含 agent；这是正确边界。本轮未发现普通项目切换全量清 QueryClient 的代码，不应说“scope key 一换就丢了所有缓存”。

**最小修复选择：**

- 让侧栏、项目 hover/导航预取、Workspace 后台预取共用同一个 `sessionSummariesQueryOptions`，统一 key、fetcher、staleTime 和 in-flight 去重。组件订阅 query，保留已有 data，分别显示初始加载与后台刷新。
- Workspace 首屏 ready 后再低优先级加载**轻量索引**，优先当前与最近项目，其他按页/有界并发补齐；将返回摘要按 scope 填缓存。列表很小才一次取完元数据。此工作不加入 `workspace_open` 成功前的 await，不调用所有项目现有 `sessions()` 来“预热”，否则会集中触发 S1 的全文成本和全局锁。
- request key 使用 Workspace 稳定身份＋generation＋scope；同一 Workspace 内切项目不主动丢弃可共享的 in-flight fetch。若无消费者则可取消传输；已执行但仍属当前 generation 的摘要可入缓存，不能让旧 generation 返回填入新工作区。新建/重命名/置顶/归档/删除和外部变更做精确更新/失效。

## 4. 建议的实现边界与验收（本轮未执行）

推荐先以一个工作包完成 S1 轻量 summary 接口和 S2 query 接入，再增加 Workspace 空闲预取；不先把现有重接口在启动时批量调用。接口草图：

```ts
// 设计草图，非现有接口。
listSessionSummaries({ workspaceId, generation, scope, cursor, limit })
// => { revision, items: [{ id, scope, title, updatedAt, pinned, running }], nextCursor }
// 正文/完整 projections：只在打开该会话或明确业务需要时获取。
```

验证用隔离 fixture 记录首次 host、首次项目 A、首次 B、A 回访、窗口 focus、快速 A/B/A；分别计前端 queue wait、native mutex wait、host boot、context register、catalog scan、title cache hit/miss、cold log bytes、projection replay、返回 payload 和列表首条可见时间。保持元数据数目不变但放大正文长度，修复后常规列表不能随总正文长度增长。

计数验收：暖 host 切新 scope 不新增 Node 进程；未变 catalog 的连续 list 不重复全局 scan；首屏只读摘要，不调用 `handle.read(0, undefined)` 遍历冷会话全文；workspace ready 不等待所有项目索引或全文。原有无全文的 header 验证、live precedence、外部变更 reconciliation 应保留。

正确性验收：跨项目同名标题、未配置/锁定 AI credentials 的历史可见性、cold title 更新、重命名/置顶/归档/删除、窗口间修改、外部文件替换、watch 失效、scope 目录迁移、关闭切换中返回、provider 配置变更与正在执行的会话。只读列表去掉 provider 执行门槛，不意味着绕过实际数据加密或权限边界。缓存是可重建派生数据，不能成为写入权限或会话内容的唯一权威。

依赖行号来自当前安装的 `@deepseek-ai/* 0.2.0-rc.2` 编译产物，仓库包锁为对应版本来源；不是引用网络最新版，也不建议直接手改 node_modules。完整 native/JS 调用链已确认；各段现场耗时、Windows 特有差异及量化收益仍需主审后续测量。

## 给主审的合并建议

新增 **P1 S1** 与 **P2 S2**，与 Office PERF-1～4 分开。面向用户可解释为：“目前缓存没有贯穿整条读取链。切新项目会让共享目录和标题缓存失效，列表还会为历史会话逐个读完整日志校验标题，所以只想看名称也会等待。可以在工作区打开后后台预取轻量摘要并复用，但应先去掉列表对全文投影和执行环境的依赖，不能把所有聊天全文搬到启动阶段。”

明确保留三个限定：不是每切项目都重启 Node；不是基础 catalog 扫描就读所有全文；没有会话列表毫秒实测，不能宣布已定位用户现场唯一耗时源或已修复。此次追加不更改 02b，也不推进 full-review 后续阶段。

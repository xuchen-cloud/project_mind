# 性能审计扩展：GenOffice、语音记录、文件版本与 AI 助手

> 本文保留审计基线的发现与原始计数。修复进度、最终验收和当前状态见 [统一执行记录](../implementation/performance-review-fixes-20261027.md)；相邻 probes 脚本现断言修复后的预期行为。

审计开始于 2026-10-26，扩展收口于 2026-10-27。代码基线：`5de9a91692136d378fd4595716109bf7c25e4d22`（develop）。本篇补充[首轮审计](performance-audit-20261026.md)，不替代其中语音回放、会话搜索、DSH 强制退出和后台轮询的发现。扩展期间两次 fetch 遇到 SSL 连接失败，未能再次确认远端是否新增提交；本文结论固定在上述本地基线。

## 工作包与证据边界

- 关联 Issue：延续首轮提到的 #271、#249 和 Office 历史验收；本次没有创建、修改或关闭 Issue。
- 依赖：当前仓库及已安装依赖。主 agent 自审，没有启动 review 子 agent。
- 交付：扩大能力覆盖清单；列出重复调用、内存、锁、持久化和生命周期问题；提供可复跑计数实验与整改验收。
- 非目标：不修改产品源码、不发布、不启动应用窗口、不访问真实模型服务、不读取用户业务数据。
- 验收和验证：追踪实际入口至资源操作及释放位置；运行相关 Node 测试和隔离计数实验。无源码变更，复用首轮仍有效的验证，不重跑全量构建。
- 证据分类：**调用计数**证明真实函数执行次数；**代码路径**证明分配、读写或取消位置；**容量推算**不是 RSS/耗时实测。没有新增整机、真实音频或大 Office 文件性能测量。

## 能力覆盖

“覆盖”指扫描仓库接入层、主要服务路径、预算和清理边界；不表示逐行审计所有第三方编辑器、模型或任意外部插件。

| 领域 | 本次与首轮合并覆盖的能力 | 结论位置 |
| --- | --- | --- |
| GenOffice 公共链路 | DOCX/XLSX/PPTX 新建、检查、编辑、自动保存、候选内容、固定版本、只读预览、选区 AI、缓存、编辑器挂载/销毁 | E01–E05；首轮 GenOffice |
| Office 输出与宿主 | HTML/PDF/图片导出、打印、远程图片、截图、字体、临时资源、worker/sidecar | E02、E05；下文已有边界 |
| 语音记录 | 双路采集、分块落盘、本地/云端识别、重连、字幕、恢复、回放、说话人分离、纪要、关闭/切换 Workspace | E09–E10；首轮语音各项 |
| File 与版本 | 发现、目录树、登记、版本列表、历史文本分页、内容 stage、更新、恢复、提交日志与崩溃恢复 | E03、E06、E11；首轮文件发现/目录树 |
| AI 会话与运行时 | 创建/切换/删除、列表/冷会话恢复、搜索/引用、事件流、历史、附件、项目客户端、退出及子进程 | E08；首轮 Session 与 DSH |
| AI 内容读取 | 上下文/概览、知识与记忆、引用证据、源文档搜索/读取、PDF 等抽取、历史引用交付 | E06–E08；首轮后台维护 |
| AI 写入与工具 | Record/Todo/File 创建/修改/版本/输出与撤销、CLI/桥接、Office 工具与选区、模型 utility、shell 子进程接入 | E01–E03、E08；首轮退出；保留权限/CAS/幂等边界 |
| AI 配置与自动化 | 共享模型配置、凭据作用域、Skills 发现/导入/管理、定时任务获取/恢复、驻留和缓存 | 首轮 Skills、调度、驻留；新增相关测试 |

清单依据包括 [runtime.mjs](../../packages/dsh-assistant/scripts/runtime.mjs) 的安装入口、[capabilities.rs](../../src-tauri/src/agent/capabilities.rs) 的原生能力表以及相应服务。能力表中 `implemented: false` 的项目不按已实现能力评估。

## 新增发现总览

P1：应优先处理的可累积成本或明显放大路径；P2：规模相关成本、取消延迟或需要明确资源生命周期的缺口。E10 同时存在产品策略待定，不把后台继续执行本身判定为数据错误。

| 编号 | 优先级 | 路径 | 放大原因 |
| --- | --- | --- | --- |
| E01 | P1 | Office 反复保存 | 候选回执持久化完整模型，Word/PPT 还含整份文件 Base64 |
| E02 | P1 | Office 并发打开/保存 | 并发槽位在解码、复制、JSON 序列化之后获取 |
| E03 | P1 | Office 检查/保存 | 大文件读取、校验、Base64 编码处于共享锁内；worker 后又整份读取 |
| E04 | P1 | Word 连续编辑 | 原生保存防抖之前，文档更新已触发完整 DOCX 构建 |
| E05 | P2 | Excel 打开/重算 | 首次载入整个已用工作簿；每次重算重新开 sidecar 和源文件 |
| E06 | P1 | File/Source 连续翻页 | 每页重新读取整个文件；抽取路径每页重新执行抽取 |
| E07 | P2 | Source 搜索 | 命中文件逐个整份读取校验，索引响应快不等于端到端快 |
| E08 | P1 | AI 事件、历史引用、附件 | 单项归属校验重读全会话目录；共享附件访问可能遍历项目会话日志 |
| E09 | P2 | 说话人分离 | 原生整段推理不能在调用中响应取消，继续占用 CPU/音频内存 |
| E10 | P2 | 语音纪要 | 后台线程未连接 Workspace 关闭取消，可继续请求模型及写库 |
| E11 | P2 | 版本下拉 | 与分页历史面板不同，仍取全量版本并执行 N+1 查询 |

## E01：Office 回执长期保留完整模型及文件副本

位置：[file_office.rs](../../src-tauri/src/file_office.rs) `prepare_edit`，约 324–428 行；[agent_operations.rs](../../src-tauri/src/db/agent_operations.rs) `agent_atomic_operation_with_hash`；[DOCX engine](../../packages/office-docx/engine.ts) `inspect`；[PPTX engine](../../packages/office-pptx/engine.ts) `inspect`。

每次新的保存请求生成 `file.office.candidate` 回执，返回对象包含完整 `model`，随后整体序列化进 `agent_operation_receipts.result_json`。[Office worker](../../packages/office-runtime/worker.mjs) 约 74 行明确对编辑候选调用 `engine.inspect(candidate)` 生成该模型。Word/PPT 的模型含 `sourceBase64`，另有文档结构、图片或布局信息；Excel 的模型也包含已加载工作簿数据。最终 File Version 快照之外，数据库又保留了模型和文件内容副本。

[record_documents.rs](../../src-tauri/src/db/record_documents.rs) 的回执压缩仅处理列举的 Record 操作，没有覆盖 `file.office.candidate`；本次搜索未找到该类 Office 回执的内容压缩或删除路径。按每份源文件 12 MiB、100 次新保存计算，单纯 Base64 字段约 **1,600 MiB**，尚未计模型结构和版本文件。这是格式容量推算，未测数据库实际体积及 WAL 峰值。

建议：回执保留固定版本、阶段结果、哈希和必要的幂等身份，模型按固定版本重建或使用有预算的独立缓存；处理已有回执迁移。不能直接删除幂等记录，也不能破坏超时重试返回同一结果的约定。

验收：对同一文档执行 100 次实际保存，记录 DB/WAL、版本文件和回执分别增长多少；候选回执不再线性复制完整文件。补测丢失响应重试、重启重放和旧回执迁移。

## E02：Office 并发限制没有覆盖排队前的内存

位置：[office_worker.rs](../../src-tauri/src/office_worker.rs) 约 293–337 行。

当前全局 worker 槽位为 2，但在等待槽位之前已经执行：完整 Base64 解码、重新编码校验规范格式、构建包含 Base64/edits 的 JSON、序列化请求 frame。调用方还持有读取结果。100 MiB 原始文件的 Base64 约 133 MiB；并发排队请求各自保留大 frame，槽位只能限制已启动 worker 数，不能限制这些排队内存。15 秒排队超时也不限制等待期间的峰值。

建议：把请求准入及字节预算放到文件读取和大对象构建之前；限制排队数量/总字节，合并同一固定版本的重复检查。保留输入尺寸及规范格式校验，减少中间副本。取消过期读取时也需要传递到原生任务，而不仅丢弃前端结果。

验收：并发请求数量从 2 增至 20，记录排队字节和总 RSS；排队内存应受明确预算约束。分别检查关闭标签、超时和 worker 异常后的释放。XLSX 自身还有更小的引擎文件预算，不能把公共 100 MiB 上限套到所有格式。

## E03：Office 大文件 I/O 持共享锁，且校验结果不需要字节时仍重建字节

位置：[file_office.rs](../../src-tauri/src/file_office.rs) `read/latest/inspect/recalculate/prepare_edit`；[project_directory_files.rs](../../src-tauri/src/db/project_directory_files.rs) `project_file_read_bytes_bounded`，约 1914–1954 行；[record_document_service.rs](../../src-tauri/src/record_document_service.rs) `BoundRecordStore for AppState`。

`read` 在 `with_current` 闭包内读取整份快照、SHA-256 校验并 Base64 编码；`latest` 也在闭包内对当前文件做完整校验。AppState 的 store 持有当前 Workspace 和 DB 锁执行闭包；DSH Office store 同样锁定当前 Workspace/DB。GUI 命令虽然用了 `spawn_blocking`，其他依赖这些锁的命令仍会等待。

`inspect/recalculate` 在 worker 返回后再调用一次 `read`，只使用其验证效果；`prepare_edit` 则在 worker 前后各做一次 `latest + read`，随后还有 stage/commit。跨异步重新核验确有必要，但不必为了验证再次创建大 Base64 返回值。

建议：复用 [file_version_service.rs](../../src-tauri/src/file_version_service.rs) 已有的“锁内捕获元数据、锁外读/hash、锁内核验身份”结构；拆开字节读取与不返回字节的验证。保留版本、归属、撤权、文件身份和提交 fence 检查。

验收：大 Office 检查/保存过程中，独立 DB 查询和 Workspace 操作不随整份文件 I/O 阻塞；记录锁持有时长、总读字节、Base64 构建次数；保留外部篡改、版本冲突、关闭 Workspace 的拒绝测试。

## E04：Word 保存防抖之前已经反复完整构建 DOCX

位置：[renderer-host.ts](../../packages/office-docx/renderer-host.ts) `render/flushActive`，约 79–115、180–192 行；[OfficeFileContent.tsx](../../src/components/office/OfficeFileContent.tsx) 自动保存 effect。

`render` 检测到脏文档签名变化就立即 `flush()`；等待一帧后调用 `buildDocBytes` 重建完整 DOCX。父组件的约 1,200 ms 自动保存防抖作用于后续原生保存，没有覆盖这一步。如果构建期间版本又变了，当前结果被弃用并继续构建新版。已有 `serializing` 会合并部分并发调用，因此不能描述为“每次 React render 必然构建”；触发条件是独立的脏文档变更，或者构建中不断出现新版本。

真实 host 代码计数：10 次分开提交的脏文档更新，**10 次 `buildDocBytes`，10 次 onChange，0 次原生保存**。DOM 和字节构建器为隔离替身；实验不测真实压缩耗时。

建议：在生成完整字节之前合并连续输入；显式保存、导出、离开时强制 flush 最新内容。保留输入法组合态、异步粘贴、嵌套表格和最新编辑状态的保存语义。

验收：连续输入时完整构建次数由合并策略控制；显式保存仍拿到最新字节，不能用丢失尾部输入换取速度。记录构建耗时与主线程长任务。

## E05：Excel 的小范围显示/重算仍承担整本初始化成本

位置：[office-xlsx/engine.ts](../../packages/office-xlsx/engine.ts) `withWorkbook/inspect/loadedRange/recalculate`，约 122、154、283 行。

`inspect` 按最多 100,000 单元格的分块读完所有工作表的已用区域，还读取全部公式、行纲要、媒体等。2,000,000 单元格总预算有效，但这不是按视口懒加载，`INITIAL_ROWS/INITIAL_COLUMNS` 不会减少实际已用范围的读取。`loadedRange` 在索引未就绪时每 10 ms 重读，最长约 5 秒，是另一处需要统计重试量的短轮询。

每次 `recalculate` 进入 `withWorkbook`：写临时源文件、新建 sidecar、打开完整工作簿，再执行请求；结束会停止 sidecar 并删除临时目录。它没有泄漏证据，但连续小范围重算会重复初始化整本数据，叠加 E03。

建议：先分别测初始化、索引等待、范围读取和重算；按实际热点考虑复用受版本/Workspace 约束且有容量及空闲释放机制的会话，或合并重算请求。首屏分批加载应保留跨表公式、打印、对象和编辑一致性。

验收：多工作表、稀疏大范围、含图表/图片及公式的样本各测首次打开和连续 50 次小范围重算；报告 sidecar 启动次数、读范围次数、CPU、峰值内存。不要仅凭总耗时决定引入持久进程。

## E06：连续读页反复读取整个固定文件，抽取路径还重复解析

位置：[file_source_read.rs](../../src-tauri/src/file_source_read.rs) `read`，约 121 行；[source_file_read.rs](../../src-tauri/src/source_file_read.rs) `read_file_verified`，约 314 行；[source_service.rs](../../src-tauri/src/source_service.rs) `extract_file`；[source_file_snapshot.rs](../../src-tauri/src/source_file_snapshot.rs) `capture_file/verify_file_receipt`。

历史文本读取每页都会 `capture_file`，完整读取和校验最多 10 MiB 文本；随后 `chars().count()` 统计全文，再扫描到本页起点。默认 4,000 字符预算包括页面元数据，不能把它当成固定 4,000 字符正文。

10 MiB ASCII 文本即使每页能放 4,000 个正文字符，也至少需要 2,622 页；代码层累计整文件读取/哈希量约 **25.6 GiB**。这不代表物理磁盘必然读了这么多，操作系统页缓存可能命中。Windows 为防恢复时间戳篡改而再次完整校验，成本还可能增加。

另一条 `source.read` 文件路径每页调用 `extract_file`，重新读取文件并调用抽取 utility；PDF 等格式的解析和进程工作随页数重复。已存在搜索索引不等于这里复用了完整抽取结果。

建议：在固定版本与权限边界内复用有预算的已验证快照/抽取结果，建立分页偏移索引。缓存必须随撤权、Workspace 切换及身份变化失效；不能直接拿可能截断的 FTS 正文替代权威源，也不能直接删除 Windows 完整性校验。

验收：同一版本连续翻 100 页，统计原文件读/hash 次数和抽取 worker 次数；重复昂贵工作应与快照建立/失效次数相关。补测篡改、重命名、撤权、不同版本及缓存淘汰。

## E07：搜索命中文件后仍逐个完整读取

位置：[source_service.rs](../../src-tauri/src/source_service.rs) `search`，约 744–820 行。

文件候选命中后按顺序 `capture_file`，每份读取/校验完后只保留 verification receipt；最终返回前还验证一次。单文件缓冲及时释放是正确的，但搜索整体工作与命中文件字节之和相关。50 MiB 文件命中 8 个，仅第一轮完整校验就是 400 MiB 代码层读取量，未计 Windows 重验。这里是条件容量推算，不表示每次搜索都会达到该规模。

建议：把数据库查询耗时与文件验证耗时分开记录；在等价完整性保障下复用固定版本证明、减少同一次请求及短期重复查询的重验。不要放宽历史版本或权限过滤。

验收：同关键词连续搜索、不同关键词命中相同版本分别测读字节与 p95；外部文件变化必须仍能被发现。低延迟 FTS 用例不能替代大附件端到端用例。

## E08：AI 的重复归属校验穿透到全会话目录/历史

位置：[project-workspace.mjs](../../packages/dsh-assistant/scripts/project-workspace.mjs) `scopeForSession`、`mind/session/fileAccess`；[context-streams.mjs](../../packages/dsh-assistant/scripts/context-streams.mjs)；[source-bridge.mjs](../../packages/dsh-assistant/scripts/source-bridge.mjs) `llm/stream`。

新增三条实际路径：

1. `$events` 对每条含会话身份的事件调用 `scopeForSession`；每个项目流各自过滤，后者每次读取完整目录。5 个注册项目、100 条会话事件、100 个目录项的真实函数实验得到 **500 次完整目录读取**，仅所属项目转发 100 条。该结论针对会话生命周期/状态/活动等事件；`session/follow` 不经过此过滤，不能声称每个模型 token 都走这条路径。
2. `llm/stream` 遍历历史中的固定源引用，在 `delivered.has(key)` 去重之前调用 `owned`；实际 `forSession` 又读取全目录。20 条固定引用重复进入 10 轮模型请求，得到 **200 次目录读取、20 次有效交付记录**。交付去重生效，归属检查成本未去重。
3. 请求共享附件、且附件不在当前项目目录/其专属附件目录时，原生 `dsh_assistant.rs` 约 2277–2285 行调用 `mind/session/fileAccess`。该路由取目录、逐会话 inspect 全部事件、逐附件 realpath，命中才结束。20 个项目内会话的未命中请求产生 **20 次 inspect**。不能泛化为所有普通文件打开都会扫描会话。

这些放大与首轮“会话搜索逐项重读目录”共用根因。长期保留项目客户端会增加事件消费者数量，但不能把每次 catalog 读取直接等同于一次磁盘全扫，其底层缓存仍可能命中。

建议：在权威会话变更驱动下维护可失效的归属索引；同一模型请求对同一 Session 合并归属验证；为共享附件建立会话/范围映射。权限变化和异步 I/O 后的必要验证必须保留，缓存不能绕过撤权或归属变化。

验收：多项目事件、历史引用和附件三组计数都纳入回归；新增、删除、归档、Workspace 切换和并发撤权仍拒绝越界访问。实际目录加载与日志读取字节另行测量。

## E09：说话人分离取消不覆盖原生推理调用

位置：[diarization.rs](../../src-tauri/src/voice/diarization.rs) `analyze`，约 170–212 行；[diarization_worker.rs](../../src-tauri/src/voice/diarization_worker.rs) 全局 `RUNNING`。

任务读取并混合整场音频，最大 2 小时，16 kHz float32 的单缓冲约 **439 MiB**，另有模型与推理工作内存。读块阶段会检查取消，但 `engine.process(&samples)` 内部不能响应取消，只在调用前后检查。

Workspace 切换或新录音触发中断时，正在执行的推理仍可能继续占用 CPU/内存；全局单 worker 也会延迟下一任务。当前模型配置单线程、总时长有上限，因此这是取消延迟与资源占用问题，不是无限并发或已证实泄漏。

建议：优先验证现有推理 API 的可取消路径；若不支持，再评估具有明确所有权和终止机制的隔离 worker。不要简单切碎整场聚类而破坏说话人身份连续性。

验收：长录音在“读音频”和“进入推理”两个阶段分别取消，测 CPU 停止时间、内存释放时间及新录音可用性。应用进程结束与仅关闭 Workspace 必须分开测试。

## E10：纪要线程与 Workspace 的生命周期脱节

位置：[voice/processing.rs](../../src-tauri/src/voice/processing.rs) `kick`；[lib.rs](../../src-tauri/src/lib.rs) `kick_voice_minutes/set_current_workspace/close_current_workspace`；[ai_provider.rs](../../src-tauri/src/ai_provider.rs) `run_voice_minutes_streaming`。

纪要 worker 接收 DB 路径、根目录、secret state 和每个 runtime 的 running 标记，启动线程并打开自己的数据库连接，循环领取待办 job。它没有取消参数；Workspace 关闭会取消 agent runs、recovery、diarization，却没有通知该线程。因此应用仍在运行而 Workspace 已关闭/切换时，旧线程可以继续模型请求、写回并领取后续任务。

重新打开 Workspace 创建新的 running 标记，不能靠旧 runtime 的标记限制两者；数据库的 job 领取仍能防止简单的同 job 重复领取，不应报告成“必然重复执行同一任务”。请求按文本分段，单次 Minutes 请求超时约 180 秒；多段任务总时长不能按 180 秒封顶。

需要明确策略：若关闭 Workspace 表示暂停其工作，应取消请求并停止领取后续 job；若明确允许后台完成，应由可观察、有并发预算的后台任务所有者管理。该线程在应用主进程真正结束后不会独立存活，**它不是 DSH 外部子进程残留问题**。

已有正确边界：按 transcript rowid 水位读取新增转写，约 16,000 字符分段，流式预览写库约 250 ms 节流。本次没有把它误判为每轮全文重做纪要。

验收：分别在模型请求和两个 job 之间关闭/切换 Workspace，确认请求、领取、写回符合选定策略；重新打开不能突破并发预算，恢复不得重复提交已完成内容。

## E11：版本历史分页了，紧凑下拉仍全量查询和渲染

位置：[DocumentSharedComponents.tsx](../../src/components/document/DocumentSharedComponents.tsx) `DocumentVersionDropdown`，约 136–158 行；[db.rs](../../src-tauri/src/db.rs) `document_list_versions/fetch_document_versions/document_version_record`，约 3766、6188、6148 行；[FileVersionMenu.tsx](../../src/components/document/FileVersionMenu.tsx) 约 129 行。

下拉打开后调用旧 `document_list_versions`：先查全部版本 ID，再为每个 ID 单独查询完整记录，返回后全部渲染。N 个版本意味着取版本行本身需要 1+N 次 SQL，另有入口元数据查询。没有页数/条数限制。查询只在打开时启用，且有共享查询缓存，因此不是每个关闭状态的列表行都在轮询，也不是短时间重开必然重新请求。

独立历史面板 [FileVersions.tsx](../../src/components/document/FileVersions.tsx) 已用 `fileDocumentApi.versionsList` 每页 50 条，对应 SQL LIMIT。应复用这条路径，而不是把整个版本管理都描述为无分页。

建议：紧凑下拉只取近期一页，更多历史进入已有面板；后端一次查询返回所需行，消除 N+1。长期版本保留涉及数据与恢复语义，不能通过自动删版本草率降低成本。

验收：10、1,000、10,000 个版本下，首屏 SQL 次数、返回字节和 DOM 节点保持页面预算；后续分页和历史恢复仍正确。

## 已有有效边界与尚未证明的问题

- File 提交/恢复有固定哈希、CAS、提交 fence、日志、快照与崩溃恢复；多次 I/O 中有必要的数据安全成本。普通 GUI 版本 prepare 已将 hash 放在共享锁外，适合作为 E03 的复用模式。
- File 内容 stage 有 100 MiB 总文件、1 MiB 分块、4 个活动 stage、10 分钟 TTL 等限制；不能称为完全无界的上传系统。
- Office worker 有超时、子进程清理及进程树机制；Excel sidecar 有停止与临时目录清理。首轮 DSH 宿主强杀的子进程问题不能直接移植为 Office 已泄漏。
- Office 预览缓存有数量/字节上限，编辑器有 destroy/dispose；隐藏但驻留的编辑器总内存、反复开关后是否回收仍需实机量化。不要把历史 WebContent 高水位直接写成确定泄漏。
- 打印/PDF 有单并发槽位、超时/回收路径和输入输出预算；远程图片有单并发、30 秒及 50 MiB 限制，底层阻塞任务结束前保留 permit；截图有单槽、像素和 PNG 字节预算。未发现足够证据新增“持续轮询/重复泄漏”结论，但真实系统打印对话框和 GPU 内存仍未实测。
- AI 选区工具具有失效、只读、范围及重复请求保护；Record/Todo/File 输出的权限、CAS、幂等回执与撤销链属于必要约束。E01 针对 Office 候选完整结果，不否定所有回执设计。
- 概览、记忆、知识和源索引扫描了接入、查询预算及维护路径；首轮的后台轮询仍有效。本次未得到新的实测证据证明这些服务有无限循环。任意外部 MCP/插件代码和真实供应商网络延迟不在本地扫描可证明范围。

## 验证记录

计数脚本：[performance-audit-expanded-probes-20261026.mjs](performance-audit-expanded-probes-20261026.mjs)。执行：

```sh
node docs/technical/performance-audit-expanded-probes-20261026.mjs
```

4 组断言通过：事件目录读取 500 次；历史引用目录读取 200 次/交付 20 次；共享附件未命中 inspect 20 次；Word 10 次变更生成 10 次字节。脚本使用真实 wrapper/host 函数，模拟目录返回、会话事件、DOM 与字节构建器；临时目录由 finally 删除。首次运行因 macOS 临时目录在系统根目录下的 `var` 与 `private/var` 别名 的夹具路径不一致失败，修正夹具 canonical path 后全部通过，没有改动产品逻辑。

新增相关测试 **57/57 通过**：

```sh
node --test \
  packages/dsh-assistant/test/context-streams.test.mjs \
  packages/dsh-assistant/test/source-bridge.test.mjs \
  packages/dsh-assistant/test/office-selection-service.test.mjs \
  packages/dsh-assistant/test/office-service.test.mjs \
  packages/dsh-assistant/test/model-utility.test.mjs \
  packages/office-docx/test/windows-renderer-hooks.test.mjs
```

计数脚本及上述测试使用当前终端 Node v26.8.1；它们不替代打包 Node 或 Windows/macOS 应用实机验证。首轮 34 项 Node 测试结果继续有效，不把已通过的功能测试解释为性能达标。本次未运行 Rust 全量测试、应用构建或 UI 验收，也未发起真实模型请求。

## 建议实施顺序与统一验收

1. 先消除长期膨胀与峰值：E01 回执内容、E02 内存准入，连同首轮语音历史重复解码、DSH 进程树退出。
2. 再处理持续交互成本：E03 共享锁、E04 Word 字节生成、E08 会话归属重复读取。
3. 复用读取结果：E06 分页/抽取、E07 搜索验证；随后统一 E11 版本分页。
4. 补齐生命周期策略与实机预算：E09 分离取消、E10 纪要后台所有权、E05 Excel 初始化/重算，以及驻留编辑器总量。

每包只处理明确交付范围，实施前关联具体 Issue 并确定验证范围。统一记录：用户动作次数、昂贵操作次数、读写字节、锁等待/持有时间、峰值及静置后 RSS、worker/子进程数量、取消到资源释放时长。必须包含连续操作、切换项目/Workspace、关闭标签、正常退出和超时强退；功能一致性与权限/版本完整性同时通过才算优化完成。

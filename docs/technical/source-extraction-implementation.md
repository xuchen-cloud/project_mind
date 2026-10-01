# 来源提取实施记录

状态：Issue #100 的阶段实现，提交推送至 `codex/ai-enhancement`；尚未完整交付或发布。

## 已实现的边界

- UTF-8 txt、Markdown、HTML 的纯文本提取；拒绝非法 UTF-8 和 NUL 交错编码，不产生替换字符作为证据。
- PDF.js 文本层提取；页码加页内 Unicode 字符范围与既有 SourceLocator 契约一致。仅取文本，不执行 PDF actions、表单或 HTML 脚本。
- 1800 字符 chunk、200 字符段内或页内重叠；覆盖字符数不重复计算重叠。ready、partial、needs_ocr、encrypted、unsupported_encoding、too_large、failed 明确区分。
- 固定 Node 24.21.0 权限隔离进程，空 PATH；每 Workspace 一个任务、60 秒硬截止、512 MiB JS heap、70 MiB 输入帧及 16 MiB 输出帧。应用退出或请求取消时 kill-on-drop，不在提取过程中持有业务 DB 锁。
- JS bundle、PDF 字符映射表、标准字体、许可文本和 SHA-256 清单独立分发；原生构造器校验 Node、入口和所有资源，缺失或不兼容时拒绝运行。
- Record 与提取进程共用有界执行内核，但保留各自独立的并发槽、容量和时间限制。
- 内部检索缓存使用打包 SQLite 的 FTS5 trigram；1～2 字查询以转义后的字面 LIKE 回退，返回硬限 50 项。作用域、排除项、当前/显式历史版本在候选阶段过滤，精确标题与选中来源优先。
- 缓存替换在单事务中写入，失败保留原当前版本；删除来源清除全部历史缓存。未独立封存的 Record autosave head 只保留一个当前缓存，不逐次保存完整正文。
- Record 共享来源服务从 Committed JSON 读取稳定 blockId，提供全文/块/段落分页。默认 4000、硬限 12000 个 Unicode 字符，计算包括引用、范围与游标；全文只有末页 complete=true，局部范围另报 rangeComplete。
- 游标绑定对象、语义修订、保留版本与读取范围；每个数据库阶段重新核对当前 Workspace generation、真实归属、Scope Grant、排除策略与归档状态。正文/标题/标签变化使当前引用失效，显式保留版本继续读取原快照；来源删除不跳到其他对象。
- 索引构建和响应裁剪在业务锁外完成，提交/返回前再核对 binding 与修订。检索默认 3000、硬限 12000 个返回字符，候选最多 50；旧缓存不作为当前证据，返回实际过期候选提示。字符/chunk 批次预算耗尽时保存部分覆盖，重叠不重复计数。
- GUI 排除策略使用 settings.write、CAS、稳定幂等凭证与事务 outbox；排除时清除派生正文缓存。历史缓存升级保留排除策略；对象/版本已删除或缓存归属不符时在排行、分页、统计前清理。
- 旧 Record 可以由共享来源服务按需建立唯一基线，不要求逐条打开编辑器。复用固定 Record 转换进程与既有正文版本表；转换前后核对 source.read、真实归属、排除/归档和工作区 generation，以原始正文 hash 做 CAS。并发转换只提交一份基线，已有新 head 保留；资源不可用时不改原正文。
- File 字节核验内核只接受服务端登记计划，拒绝客户端路径。文本/PDF 分别限制 10/50 MiB；读取前后核对普通文件身份、stat 与登记 SHA-256，提取完成后再次复核。外部修改返回 changed_unregistered，缺失返回 missing，超限返回 too_large；Unix 拒绝末级符号链接，特殊文件不进入读取。核验不改字节或版本。
- 共享 File 服务先按业务表解析真实 Project 归属，再检查当前 binding、source.read、排除与 Archive；从既有 File Version 解析托管路径及不可变登记 hash。hash 表只保存既有版本的指纹，不复制正文或建立第二套 File Version。未登记的旧版本明确返回 SourceNotReady，不将当前磁盘字节自动登记为旧证据。
- 文件捕获、固定进程提取、分页投影均在业务锁外运行，各异步阶段前后重新核对授权与版本，并在返回分页前复查字节。当前版本切换使游标失效，即使新旧字节 hash 相同；显式历史版本仍读取其保留路径。提取期间切换工作区、排除、外部改写或新增版本均丢弃旧结果。
- File 文本读取使用默认 4000、硬限 12000 的序列化 Unicode 字符预算，包含引用、范围、游标及提取状态；全文和段落/PDF 页内范围分页去除提取 chunk 重叠，不重复证据。SourceRef 明确携带 File Version、实际字节 hash 和段落/页内字符定位，不伪造 Record blockId。部分 PDF、扫描/加密或无效文本状态保留真实 coverage，提取末页不等于完整阅读；原始 HTML 字节仍由后续 file.source.read/版本服务负责。
- File 提取可按可信批次预算提交共享索引，版本号始终对应实际 File Version；段落/页内重叠不重复计数，预算截断同步调整页内范围。读取服务与混合 Record/File 检索共享授权边界，File 搜索在排行后逐项核对实际字节，返回前再次检查授权、当前版本和 stat/hash；只保留无正文的核验凭证，避免搜索 50 个 PDF 时长期保留 50 份字节缓冲。
- File 删除、版本删除、错误业务归属、未登记 hash 或排除状态在排行/分页/统计前清理；新增版本立即让旧缓存退出默认当前检索，历史版本仅在 includeHistory 下可见。共享检索支持已实现的 Record/File/Project/Todo/QuickNote kind 进入排行与 hasMore，尚未实现的来源类型不占用候选预算。Record 私有正文图片不作为独立 File 来源。
- 无正文 chunk 的来源也可按标题发现；同样在排行前检查 scope、kind、排除与当前/历史版本，支持多词和转义后的字面查询。空 Record、扫描件等不生成假正文 chunk、excerpt、blockId 或 locator；保留真实零字符 coverage。实际扫描 PDF 的读取仍返回 needs_ocr，不能因标题命中宣称已读原文。
- Record/File 共用纯文本分页内核；统一完整序列化预算、Unicode 字节游标校验、段落/页内范围裁剪、真实覆盖与末页标记。业务服务分别负责来源投影和前后授权/字节复查，分页内核不授予权限，也不创建正文版本。现有 Record 游标结构保持兼容，File 游标继续绑定实际版本号。
- Project 原生来源只读名称、状态和 Archive，语义修订不含 QuickNote、路径或更新时间；Project QuickNote 另有 `quick_note` kind，以 Project ID 和 Project scope 定位。Workspace QuickNote 使用 `workspace_notes` 中真实 `today_quick_note` ID，同号 Record 不回退或混淆。
- Todo 原生来源包含当前内容、状态、优先级、期限与真实 Subtask；子项 ID、内容、状态、期限、顺序和完成信息共同进入语义修订，更新时间不是并发依据。子任务通过所属 Todo 的段落范围定位，不伪造独立 Record/版本或 block ID。
- QuickNote 只转换持久化的 Committed HTML；空 HTML 按既有 Markdown 转换补投影，冗余 Markdown 和更新时间不改变已有 HTML 的修订。修订基于既有持久化 HTML（资源已相对化）、code language 和语义元信息；等价 HTML 的序列化变化会保守使旧引用失效。复用固定 Record 转换进程，转换产物与临时 block ID 不落业务表，不创建正文版本、不写 Overview，来源标题明确标注“临时想法”。
- 五类来源共用实际所有权、Scope Grant、Workspace generation、排除与 Archive 检查；QuickNote 转换在锁外执行，原生读取、索引提交和混合检索返回前复查当前修订。原生来源只保存一份当前缓存，includeHistory 不产生不存在的原生历史；删除、排除、错误业务归属在排名和统计前清理。
- 共享 source search 增加显式 `kinds`，默认混合已实现的 Record/File/Project/Todo/QuickNote/Transcript；筛选发生在排名、limit 和 hasMore 前。尚未实现的 kind 返回 SourceNotReady，公开 capability 继续关闭。
- 缓存统计分别报告对象、快照、chunk 和已存储内容字节；后者是 payload 统计，不包含 FTS/B-tree 页面开销，不能冒充整个 SQLite 文件大小。
- Workspace Record 使用 `[[workspace_record:<id>|<label>]]` 专用引用，旧 `note:<id>` 继续指向 Project Record。文本/HTML/Committed JSON/Markdown 转换、候选搜索与导航、正文/Todo 归属校验和可携带导出一起兼容；同号对象不混淆，删除后不回退到另一张表。Project 内容拒绝新增 Workspace 引用。引用候选列表复用公共滚动边缘测量，限制到浮层可用高度，遮罩不覆盖滚动条或阻挡点击。

[DOMMatrix 上游](https://github.com/thednp/dommatrix) 提供兼容实现，当前锁定 3.1.2；其完整 MIT 许可由构建从实际依赖生成。PDF.js CMap 的 Adobe 许可及标准字体的 Foxit/Liberation 许可一并保留。

## 验证范围

纯提取/协议 15 项，独立固定 Node 5 项，原生提取 6 项通过。独立进程复制至中文空格临时路径，仅保留 bundle 与 PDF 资源，不存在 node_modules 或 native canvas；验证中英混合 PDF、加密 PDF、HTML 脚本跳过和严格单帧协议。

前端全量 137 文件/947 项通过，最新 Rust 全量 296 项通过、12 项默认忽略；Record 相关 94 项（含实际固定进程）和 Node 转换/许可 6 项显式通过。构建、路径/UI/bundle 检查通过，启动脚本 184 KiB/250 KiB。新增的 3 项真实旧 Record 转换测试包含于显式 Record 验证，默认忽略仅因为依赖准备好的固定 Node 分发。前端第一次双并发全量中查找替换用例超时，单独复现通过后以单并发全量通过，未增加超时或削弱断言。

新增共享来源/真实业务存储 15 项、检索缓存 12 项验证，覆盖 Unicode 分页、局部块的子内容、固定历史修订、当前 metadata 变化、权限/作用域/工作区切换、归档、排除回执重放、实际业务归属、删除缓存、部分预算与幂等升级。

本批增加 File 索引/检索 4 项、File 共享读取 7 项、File 核验 4 项和旧 Record 4 项，覆盖同尺寸外部改写、提取后复查、缺失/超限/符号链接/特殊文件、存量转换后读取与检索、转换期间切换/排除/正文变更、并发新 head 与资源不可用。参数错误在启动转换前拒绝。

本批标题发现新增缓存、真实扫描 PDF 和空 Record 3 项；来源专项 64 项（含真实进程）通过。

原生测试验证资源篡改拒绝、同 Workspace 排队、其他 Workspace 独立运行、超时终止后可重试、响应覆盖与定位的一致性。共用执行内核调整后，Record 85 项（含默认忽略的实际进程用例）及既有 Node 转换/许可 6 项通过。

本批原生来源新增 11 项真实服务测试（含 3 项固定转换/提取进程测试）：Project/QuickNote 隔离、原生修订与单份缓存、错误 owner/Scope Grant、Archive/排除/Workspace generation、Unicode 分页、原生版本与 block 选择拒绝、Todo/子项变更及删除、五类混合检索和 kind/limit，以及转换/投影后的 freshness fence。来源全量在最终 fence 用例加入前为 74 项通过；最终 Rust 全量为 304 项通过、15 项默认忽略。最终 fence 已包含在 Rust 全量中。没有启动应用窗口、发送 Provider 请求或改动前端。

共享 `open_workspace_database` 统一执行数据库打开、旧 Record 日志键迁移、正文回执压缩和 pending checkpoint 恢复，桌面初次打开、解锁及锁定导致的数据库重开均复用；未来 headless Host 也应复用这个入口。封存失败保留最新 autosave 并返回诊断，由桌面适配器显示；数据库重开失败不提前替换密钥状态。新增连续三次（含密码）重开测试通过，验证不复制正文回执、不重复封存、不回滚当前 head。

共享 Record 服务在事务 outbox 提交后捕获 `mind:changed`，并在释放 Workspace/数据库锁后发布；兼容的 `record:head-changed` 由同一提交通知生成，Tauri 命令只负责转发。正文保存、metadata、创建、恢复、QuickNote transfer，以及 source 按需基线/排除策略复用这个边界。回执重放与回滚不重复通知；通知捕获/投递失败不改变已提交回执，日志是恢复依据。未来共享服务的 Host 实现必须提供 publisher，但 CLI/Pi 接入仍未开放。

每窗口的日志消费者先监听、再按当前 binding 补读有界日志，事件本身不推进游标；漏掉的通知、focus、同一路径重开后的新 generation 均可恢复。只 invalidate 对应页面、Todo、搜索与 agent scope；Warm 禁用观察者只标脏，显示后读取。GUI 专用全 Workspace 补读包括已删除 Project 的日志 scope，连接仍受原 grant 限制；过期日志 resetRequired 刷新工作区缓存，工作区切换/卸载后的旧异步返回丢弃。

本批最终 Rust 全量 308 项通过、15 项默认忽略；来源专项 75 项及 Record 专项 99 项（均显式含固定进程）通过，覆盖提交后锁释放、正文/metadata 通知、重放/回滚无重复通知、基线唯一通知、canonical 去重与 200 项上限、GUI/外部连接权限。前端全量 139 文件/954 项通过，随后新增同路径重开用例并修复绑定刷新；最终通知/绑定/编辑器回归 3 文件/20 项通过。构建及路径/UI/bundle 检查通过，启动脚本 187 KiB/250 KiB。未启动应用窗口、使用真实 Provider 或执行 Windows 实包验证。

Transcript 原生来源接入真实 `voice_records` 与已持久化 final segments，以 Voice Record ID 定位原始转写，和可编辑 Record 正文保持独立。只读时间范围/Unicode 分页、1800/200 chunk、语义修订、当前缓存和混合 kind 检索复用共享边界；不提供 Record/File 版本或 block ID。重复 final delivery 和 Record 正文修改不改变转写修订，追加 final segment 会使旧读取/缓存失效；时间定位保留实际段边界，重叠段的引用覆盖使用所有已读段的最小/最大时间。

本批新增 7 项真实数据库/共享服务测试，覆盖原始转写/正文隔离、final 重放、时间范围、实际 owner/Scope Grant/generation、排除与 Archive、分页及序列化预算、部分索引覆盖、删除缓存、投影后并发提交与重叠时间定位。来源专项在最后两项加入前 80 项（含固定进程）通过；最终 Rust 全量 315 项通过、15 项默认忽略，包含最终 7 项 Transcript 测试。内部转写快照超过 2 Mi Unicode 字符或 10000 段返回 BudgetExceeded，尚待分段快照读取，不能标成截断后完整。正式会话分支/消息及会话摘要仍待对应业务模块提供已提交注册接缝，未假造 branch ID 或摘要版本。

持久索引队列复用既有 `agent_jobs(kind=extract)`，每 scope 的日志游标与合并任务在同一事务提交；Record/QuickNote 500ms 合并，其他当前来源立即就绪。每 Workspace 同时仅一个活跃索引 lease，处理中新变更保留最新 seq，旧任务完成后继续排队；重开 generation 或 90s lease 超时可恢复，旧 token 不能结算新任务，失败最多三次，后续新事件可重新排队。排除和删除取消待处理/运行任务，异步索引仍走现有所有权/授权/修订与文件字节 fence，不另建正文/版本。

存量 backfill 每批 1–200 个真实业务对象，只读目录信息，游标和入队原子保存，排除项与 Record 私有图片不入队。Project 范围与 Workspace 直属来源分开遍历；完成目录遍历保留起始水位以继续消费后来变更。中途停顿超过日志保留、无法证明 delta 完整时重新做有界目录遍历。任务状态 completed 表示这次索引批次已结束，cache coverage 仍独立保留 partial，不承诺已完整读取或概览已最新。队列/目录表仍为内部惰性准备，不作为已发布 Schema。

共享 SourceService 提供目录 backfill、日志合并与处理单个有界任务的接缝，真实固定转换进程已验证自动建立旧 Record 唯一基线并进入索引；处理/哈希期间不持业务锁。后续阶段已接入显式开发开关下的桌面启用/激活调度与持久预算；普通构建仍不开启后台来源循环。产品运行时、进度 UI、File 业务 outbox 和资源分发仍保留门禁。

修复日志全部清理后的恢复边界：变化页与提交捕获从 SQLite 单调 sequence 恢复末尾水位，空日志不再丢掉 resetRequired。新增队列 11 项（含真实转换进程）及空日志恢复 1 项；最终来源专项 93 项显式通过，Rust lib 全量 326 项通过/16 项默认忽略。最终前端全量 139 文件/955 项通过；最终 Rust 全目标测试同样通过（库 326 项/16 项默认忽略，其余目标零用例），Record 专项 99 项显式通过；既有构建、路径/UI/bundle 检查均通过。本批 Standards/Spec 由主 agent 自查，修复了同路径重开绑定、重叠时间定位与空日志水位问题；剩余接入职责仍见下文，未启动 review 子 agent。

最终边界修复统一 Transcript 时间定位的 JSON 精确整数上限；请求超过 JavaScript 安全整数范围时拒绝，已有异常 final segment 不作为可返回证据。新增真实数据库测试验证输入与持久化两条边界。修复后来源专项 94 项显式通过，Rust 全目标测试通过（库 327 项通过、16 项默认忽略），前端全量保持 139 文件/955 项通过，Record 专项 99 项显式通过。构建与路径/UI/bundle 检查通过；未启动应用窗口、发送真实 Provider 请求或进行 Windows 实包验收。用户要求将阶段提交推送至既有 AI Enhancement 分支并交接，Issue #100 保持开放。

## 后续责任

提取 worker 不授予源访问权限，也不推断所属 Workspace/Project。共享 File 读取服务已经核对真实归属、Scope Grant、排除策略和登记版本 hash，并在异步处理后复查 binding、版本和字节。File 索引提交和检索已复用这些强制边界；File 提取投影不能代替 Committed JSON。

Record 的按需基线接口与 Workspace Record typed token 已实现；队列内核已调用前者，显式开发模式已接入桌面自动调度，普通产品与 headless Host 尚未启用。File 核验内核不授予权限；导入/版本写入时的 hash 登记及存量版本状态仍继续实现，不能将未知存量字节自动冒充原登记版本。正式会话来源、File 写入的完整 outbox/CAS/journal 接入、知识模块对失效水位的消费及产品桌面自动队列调度尚待完成。source.search/read 的 capability 标记仍为 false，没有开放 GUI/CLI/MCP/Agent 入口；内部表准备不代表已发布 Schema 29。主程序构建不启用来源 worker；文件读取在阻塞线程执行，尚未增加独立的文件系统阻塞截止；Windows 字节复核始终重新计算 hash，但未在 Windows 实包执行验证。Windows 实包与完整 AI 工作流保留对应验收门禁。

### GUI 原生写入与删除身份（2026-10-01 后续阶段）

Todo/子任务、Workspace QuickNote、Project 创建/改名/QuickNote/归档、Transcript final 以及 Record/Project 删除已接入事务 outbox。正文、标签、owner touch 和日志一次提交；语义无变化不制造日志。QuickNote 修订复用来源读取的持久 HTML、真实标题和标签，不创建 Record 正文版本。QuickNote transfer 同事务记录 Record 和清空后的真实 QuickNote，回执重放不重复入队。

原生数据库连接从真实 Workspace manifest 或共享初始化绑定稳定 ID，不通过路径或标题推造身份。GUI 命令、Voice supervisor 与补转写在捕获提交日志后释放业务锁，再发送同源 `mind:changed`；操作后续阶段失败时仍通知已提交的 final，回滚则没有成功通知。通知捕获失败不撤销已提交业务结果。Project 改名的现有目录回滚延伸至 outbox 提交；这不是文件系统崩溃 journal，也不替代 #114。

Transcript final 使用 Voice Record ID；每个不可变 final 的日志 revision 是 delivery watermark，不是可用于 evidence 的 SourceRef hash。完整来源修订仍由现有受预算保护的读取服务生成；录音路径不为每段 final 重新分配、哈希整份不断增长的 Transcript。重复 delivery 不重复日志，补转写段、恢复游标和 outbox 同事务提交。

内部 `source_registry` 只保留规范对象键、scope、变更水位和删除标记；不存正文、摘录或第二套版本。删除前记录被级联删除的 Record、Todo、File、QuickNote 与 Transcript 身份；日志清理和重开不删除 tombstone。注册条目不表示该来源已可读、索引完整或会话模块已就绪。现存日志键迁移后可恢复目录元信息，不把未知旧字节补登记为历史 File Version。

`source_dependency_invalidations` 复用现有 `content_reference_edges(relation=derived_from)`，原文变更、删除、排除和项目归档在写事务内传播失效水位，循环依赖有界终止；不重写 evidence 版本或引用边。内部读取接缝仅返回授权 owner scope 的失效水位/原因，不泄露其跨 scope 证据。确认失效水位必须在真实知识 owner 的发布/CAS 事务中执行，旧刷新不能清除更晚的 source change，发布回滚也回滚确认。知识模块须以真实 owner 和依赖注册、消费失效水位并重新校验发布，尚未生成 Overview/知识节点或正式会话摘要。删除、归档、排除同事务取消相关提取任务；旧 lease 不能结算为完成。


### 开发模式自动索引调度（2026-10-01 后续阶段）

仅 debug 构建且 `PROJECT_MIND_SOURCE_INDEXING_DEV=1` 启动单个桌面来源循环；GUI 同时需要 `VITE_MIND_SOURCE_INDEXING_DEV=1`。真实活动路由登记所选 scope，预加载/驻留页面不登记；助手配置启用后按持久目录和日志游标自动处理。失效 binding 拒绝，切路由丢弃旧 binding 查询，已发出的选择命令顺序结算。关闭助手、切 scope、取消、前台 run 或未结束 Voice Session 会停止下一项并中断正在等待的转换；进程 future 释放后按原 token 让出队列 lease，不消耗提取失败重试。重新打开页面不撤销取消，显式 resume 也不提前重置预算。

预算 ledger 复用 `agent_jobs(kind=maintenance)` 的 `source-maintenance:<workspaceId>` 命名空间，与 `extract` 作业分开；后续维护消费者须只处理自己的命名空间。全 Workspace 每 20 分钟一批，最多 100 次作业、8 Mi Unicode 索引字符、40000 chunks；每次最多 2 Mi/10000，转换前持久预留，完成后按实际唯一字符覆盖与 chunks 退还余额。失败、取消、崩溃保留保守预留；空队列不计次数。重开、旧 token 和 scope 切换不刷新累计额度；过期后只开始一个新有界批次，不补跑遗漏的每个周期。空闲时只读水位，不反复写入预留。这是本地索引配额，不是 Overview 模型输入/调用或 run 的检索返回预算；没有调用 Provider。

内部 metadata 命令提供 cancel/resume 及预算、待处理、失败、部分来源、目录遍历进度；不把目录 complete 或任务 completed 当成完整 coverage。用户可见进度 UI、产品默认调度/资源分发、分段来源覆盖续跑、Overview 维护和正式会话模块仍待对应工作包接入。公开 source.search/read capability 继续 `implemented:false`，没有 GUI/CLI/MCP/Pi 来源读取 adapter；内部表没有发布为 Schema 29。

专项验证包含真实 SQLite 的累计预留、故障回滚、代际恢复、取消、前台抢占，以及真实固定 Node 的唯一 Record 基线与检索结果；没有运行应用窗口、真实 Provider 或 Windows 实包。

阶段验证：Rust 全目标库 346 passed、15 默认忽略；source 显式 include-ignored 为 108 passed，Record 为 100 passed；前端相关 4 文件 14 passed，全量 140 文件 959 passed、1 个既有 Project 驻留用例超时；构建、portable paths、UI standards、bundle 检查通过（主入口 188 KiB）。主 agent 已自行核对事务/锁释放、授权/代际、原始版本与 partial coverage 的 Standards / Spec 两轴；File 共享写入与产品调度仍未完成，前端全绿及实包验收门槛未满足。阶段提交不代表 #100 已交付，不新建发布 PR、不合并 main、不关闭 Issue。


### File Version 提交与恢复内核（2026-10-01 后续阶段）

既有 GUI `document_add_version` 已委托共享数据库内核，继续使用同一 File ID、`documents/document_versions`、base_name 与 history_dir_path。65536 字节缓冲流式准备原字节恢复快照和新内容，保留 HTML 源码、脚本、BOM 与 CRLF；输入来源不被移走。私有 journal 先同步落盘，旧文件归档与新文件落位使用不覆盖目标的原子 rename，再以一个 SQLite 事务提交 head、历史路径、新版本登记 hash、稳定凭证和真实 File outbox。写入错误会回滚数据库并恢复原路径；只登记本次新版本，不补登记未知旧历史。journal 快照是临时恢复材料，不是第二套 File 正文或版本存储。

共享 Workspace 初始化在完成真实 Workspace ID 绑定后恢复未完成 journal； committed receipt 只做清理，未提交操作恢复旧版。校验实际 Workspace、操作意图、版本、路径、SHA-256 及物理文件身份，同字节外来文件也不被误删；不安全的冲突保留 journal 并报错。目录含真实 File ID，恢复先拿 File 锁，避免误清另一连接仍在准备、尚无 descriptor 的 staging。Project 目录/Archive 写入独占 Project 锁，File 写入共享 Project 锁后独占 File 锁，事务在最后获取；原生导入、改名、relocate、删除也遵循互斥顺序，但这些操作各自的 hash/outbox/journal 尚未补齐，锁不能代替它们的原子性。Project 改名的既有回滚仍不是崩溃 journal。

内部已登记版本更新验证实际 owner、可信 RequestContext/grant 与当前 binding、Archive、expectedVersionNumber、不可变登记 hash 和当前实际字节。未登记或外部改动返回 FILE_CHANGED_UNREGISTERED，版本/hash 基线不同返回 REVISION_CONFLICT。只接受服务器解析的 Workspace staging 路径和匹配的新 hash，读取过程中也执行 100 MiB 上限。相同 caller/requestId 复用原稳定版本凭证，即使 staging 已清理或后来又有新版本；等待 File 锁后重新查回执，两个数据库连接的同请求并发也只提交一次。相同已登记内容返回 noChange，保存凭证但不加版本或日志；历史字节作为输入时保留原历史路径。

此更新接缝没有公开 adapter，stagedContentId 的 caller/run/target 绑定、分块上传与过期、精确 patch、专用 file.restore 授权和真实成果模块接入仍待后续阶段。普通 GUI 仍由服务器产生每次调用的 nonce，既有“复制为新版本并打开”语义暂留；客户端稳定 requestId、显式基线确认、GUI noChange/恢复交互尚未统一，不能据此宣称 A34/A36 全部通过。准备与哈希仍在旧 GUI 命令的 DB 锁内，后续服务外层须将准备移至短锁之外并在提交区结算取消。持久路径冲突的产品恢复诊断、真正磁盘满与各平台实包故障验收也仍是门槛。

主 agent 的 Standards / Spec 自查修复了同字节外来路径误删、尚在准备时被恢复删除、同 requestId 等锁后误报 CAS 冲突，以及 Project 目录变化与 File 提交的竞态。测试使用真实数据库、共享初始化和原生版本服务；Linux 子进程在 staging、descriptor、归档、落位、SQL 提交前及提交后六处 SIGKILL，分别验证原生与已登记请求的恢复和最多一次重试。数据库版本插入/outbox 故障通过 SQLite trigger 注入，不将这些故障注入称为真实磁盘满。Windows 分支尚未进行实包验证。公开 source.search/read 和 File 写入 capability 仍为 implemented:false，普通桌面不启用 source worker，内部表未发布为 Schema 29；#100/#114 均未完整交付。

阶段最终验证：Rust 全目标库 360 passed、16 默认忽略；source 显式真实进程专项 108 passed，Record 100 passed。File 内核包含 14 个父用例及一个由父用例启动的 ignored 子进程 fixture，不将空环境直接运行该 helper 计作崩溃验收。新增 journal 准备后外部编辑的子进程握手，确认返回 FILE_CHANGED_UNREGISTERED/recoveryPending、保留用户新字节与 journal、无新 head/回执/日志。构建、portable paths、UI standards、bundle 检查通过，主入口 188 KiB/250 KiB；前端本阶段只改错误码类型，未重复运行既有全量超时用例，前一阶段 959 passed/1 个驻留用例超时的发布门槛仍保留。没有应用窗口、真实 Provider、Windows 实包、发布 PR、main 合并或 Issue 关闭。

### File 导入原子登记（2026-10-01 后续阶段）

普通本地 File 导入与剪贴板 File 导入复用同一个提交内核；仍使用既有 documents/document_versions，每个成功导入的真实版本 1 在同一事务登记实际捕获字节的 SHA-256、标签、Project touch、稳定凭证和 File outbox。新 File 的登记不追补未知旧 File 历史；测试中的旧未登记对象明确移除权威登记行，receipt/outbox 的 hash 不能代替它。Record 内嵌图片仍是 managed_note_image，不登记为来源 File。

导入准备流式保留原始字节，不移走输入文件；已在目标路径的文件只在显式新 File 导入时接管，失败不删除用户源文件。剪贴板走相同 journal，不遗留先前的孤立 inbox 文件，并限制解码前后 100 MiB。实际 Project 共享锁、导入命名空间锁与跨 Project ID 分配锁避免目录变更、恢复误清活跃 staging 和并发预选同一个 File ID；没有为预留 ID 插入 File stub。已有或准备期间出现的历史目录拒绝接管，目标复制不覆盖外来文件。

journal 在落位前同步；File 主行、版本行、当前版本字节 hash、标签和 outbox 的写入失败会一起回滚。共享 Workspace 初始化通过原恢复入口处理未提交复制、接管和已提交清理；回收复制文件前校验实际 Workspace/Project 路径、无业务引用、hash 与物理身份，同字节外来目标也保留并报错。成功通知由现有 GUI 捕获提交日志，在释放 storage/File 锁后发送；失败事务没有成功通知。未提交 journal 冲突仍可能阻止 Workspace 打开，产品恢复诊断和短锁外层服务待接入。

主 agent 自行完成 Standards / Spec 检查；四个实际数据库连接同时向四个 Project 导入可得到唯一 File ID，发现并修复共享父目录首次创建竞争。专项 8 个父用例通过，涵盖普通复制、原路径接管和剪贴板三种来源在五个阶段的 15 次 Linux SIGKILL、SQLite 版本/outbox 故障、外来目标/历史目录、活跃 staging 互斥与真实 File 提交通知。忽略的子进程 fixture 由父用例启动，不单独计作验收。Rust 全目标库 368 passed、17 默认忽略。没有更改前端或重跑既有前端超时用例，959 passed/1 个驻留用例超时的发布门槛仍保留。

File 改名/metadata、relocate 与删除自身的原子 outbox/恢复仍待下一工作包；本阶段只补齐两类原生 File 导入。客户端稳定 requestId、公开 file.create、真实成果模块接缝、上传/CAS GUI 接入、Windows 实包与真正磁盘满仍未交付。source.search/read 与 File 公开能力继续 implemented:false，普通桌面没有启用/分发 source worker，私有表不称为已发布 Schema 29；#100/#114 保持 OPEN，不执行阶段发布 PR、合并或关闭。

本阶段显式 source 过滤专项 109 passed（含上述名称匹配 source 的导入用例与真实固定提取进程），Record 专项 100 passed；portable paths 检查通过。固定资源未并发 staging，未启动应用窗口、真实 Provider 或 Windows 实包。

### File 改名与 metadata 原子提交（2026-10-01 后续阶段）

原生 File 改名、标签与收藏现在复用 metadata 提交内核。先验证实际 Project 标签和规范名称，取得 Project/File 锁，记录全部既有 Version 的原路径、新路径、临时位置及物理身份；journal 同步后，全部待移动文件先进入私有临时位置，再落位到新名。File head、所有版本名称/路径、metadata、标签、Project touch、凭证和真实 File outbox 在一个事务提交，不新增版本、不倒退版本号、不改登记 hash。无语义变化不写凭证/日志；Record 内嵌图片不变成来源 File。

共享初始化与后续写入恢复未提交改名，提交后只清理 journal；恢复也采用两段不覆盖移动，允许历史版本缺失、旧名与新名交叠以及恢复本身被中断。先核验所有待恢复文件的 hash 与物理身份，外来同字节路径不覆盖、不删除，未知旧版本的捕获 hash 只用于恢复，不登记为历史原件。私有描述符读取上限 1 MiB，超限在移动前拒绝。目录尚无 descriptor 时也先取得 File 锁，避免删除活跃准备；目录遍历允许另一连接已经完成清理的条目消失。

全量并发测试发现共享 agent_atomic_operation 的 deferred 事务可能在读回执之后与另一连接的写锁竞争；改为 BEGIN IMMEDIATE，在读取回执/CAS 前预留写锁。实际双连接测试持有 writer 时，等待方不进入 apply，释放后只提交一份凭证。此修改不增加公开 adapter，也不代替未来 Workspace Host 单写者约束。主 agent 自查 Standards / Spec：事务/outbox 故障恢复完整旧状态，归属标签不跨 scope，原始版本身份与缺失状态保持，通知继续在锁释放后发布。GUI 稳定 requestId、短锁外层、用户恢复诊断和 Windows 实包仍待接入。

本阶段最终验证：Rust 全目标库 374 passed、18 默认忽略；source 显式真实进程专项 109 passed，Record 100 passed。metadata 专项包含 5 个父用例及父用例启动的 helper，双连接 writer 测试另计；14 次 Linux SIGKILL 验证七个改名阶段与两种历史状态。未改前端，既有 959 passed/1 个驻留用例超时门槛继续保留。File 删除/relocate 自身的持久恢复与原子 outbox 仍待后续；本阶段不宣称 #100/#114 已交付，不发布 PR、合并 main 或关闭 Issue。公开能力、普通 worker 分发与 Schema 门禁保持。

### File 删除与可恢复资源清理（2026-10-01 后续阶段）

原生 File 删除复用实际 File ID、Project/File 锁和持久凭证。先捕获各权威 Version 的路径/hash/物理身份并同步 journal，再把存在的版本逐个移入私有暂存区；缺失版本保持缺失。删除主行、版本/标签级联、Project touch、稳定删除凭证与真实 File tombstone 在同一个 SQLite 事务提交。写入或 outbox 失败恢复全部原路径，不再出现数据库保留 File、托管文件已被删除的状态；未知旧版本的捕获 hash 不作为历史登记。

提交后清理继续走既有原生 trash 边界，暂存保留原文件名；只清理权威 Version，不把整个历史目录中的非版本文件一起删除。历史目录仅在为空时移除。部分清理可从 committed receipt 继续，不重复删除日志；回收前同时校验字节与物理身份，同字节替换文件也保留。不递归删除带有额外未知数据的已提交 journal。共享初始化与后续写入复用恢复入口，descriptor-less staging 先取得 File 锁；提交后清理失败保留 journal 并记录诊断，不能声称逻辑删除失败。恢复冲突目前仍可能阻止 Workspace 打开，产品诊断/清理进度 UI 与短锁外层待接入。

File tombstone 在日志清理与重开后保留，queued/running 提取任务由同事务触发器取消，依赖失效沿现有图传播；不另建 File 正文、版本或删除 registry。GUI 按现有提交捕获边界在锁释放后发布真实 File 引用，回滚不通知。客户端稳定 requestId 和公开删除 adapter 不在本阶段开放；Record 内嵌图片仍不冒充来源 File。

主 agent Standards / Spec 自查与真实 SQLite 测试覆盖 SQL 拒绝删除、outbox 回滚、队列取消、持久 tombstone、外来同字节原路径/暂存路径、活跃 staging 互斥，以及缺失 head 和正常 head 两种状态在七个阶段的 14 次 Linux SIGKILL。删除专项 6 个父用例及一个由父用例启动的 ignored fixture；测试清理使用既有 cfg(test) 文件移除边界，不将它称为各平台真实回收站、磁盘满或断电验收。Rust 全目标库 380 passed、19 默认忽略；source 显式真实进程专项 109 passed、Record 100 passed。前端未改，既有 959 passed/1 个驻留用例超时门槛保留。

本阶段原生 File 导入、版本、改名/metadata 和删除已有自身的 outbox/恢复，relocate 的旧覆盖语义仍需结合登记 hash 收紧。公开 source.search/read、File adapters、普通 source worker 分发、Schema 29、GUI CAS/上传、Windows 实包及产品恢复诊断仍未交付。#100/#114 保持 OPEN，未发布阶段 PR、合并 main 或关闭 Issue。

### File 重新定位与原件约束（2026-10-01 后续阶段）

原生 document_relocate 不再把任意新位置的字节覆盖到同一历史版本。先要求当前 Version 具有权威登记 SHA-256、head 与 version 的路径一致，校验现存 head 未被外部改动，再流式准备所选源。只有与登记 hash 完全一致的字节可重新绑定源位置或恢复缺失 head；不同内容必须走新增版本流程，未登记的旧版本不能凭当前字节或相同文件名冒充历史原件。已有 head 保持原物理文件，缺失 head 用不覆盖 rename 落位；源文件、File ID、版本号、版本计数与历史 hash 保持。相同位置/字节/health 不写凭证或日志，返回前再次核验当前 head。

恢复私有 journal 与其他 File 写入共用 Workspace 初始化入口。位置字段、health、Project touch、稳定凭证和 File outbox 在同一事务提交；失败恢复此前缺失状态或原 metadata，提交后仅清理 staging。校验真实 Workspace、File/Project/Version、登记 hash、源绑定和物理身份，同字节外来修复目标也保留并报错；活跃 descriptor-less staging 先取得 File 锁。未知旧版本的修复/显式登记交互仍需 #114 提供，当前选择拒绝不可靠恢复，不创建假原件或新旧正文副本。

主 agent Standards / Spec 自查及专项 6 个父用例通过，包含正常/缺失 head 两种状态五个阶段的 10 次 Linux SIGKILL、outbox 回滚、不同内容/未知旧版本拒绝、外部编辑保留、同字节外来目标、无变化和活跃 staging 互斥。Rust 全目标库 386 passed、20 默认忽略；source 显式真实进程专项 109 passed，Record 100 passed。未改前端，前一阶段 959 passed/1 个驻留用例超时门槛保留。原生 File 各写入口的 hash/outbox/journal 已有内核，GUI 稳定 requestId/CAS、短锁外层、上传/精确 patch、恢复交互与实包故障验收仍未交付；不把内核阶段当作 #114 整体交付。

最新只读核对 #99 为 CLOSED、#104 为 OPEN；依赖 Issue 的正文与完成状态须分别核对，不能仅凭旧 Blocked by 文本断言未交付。正式会话/摘要、真实成果模块和助手 UI 的注册接缝仍不能虚构。公开 source.search/read、File adapters 与普通 source worker 分发保持关闭，内部惰性表未发布为 Schema 29；#100/#114 保持 OPEN，无阶段 PR、main 合并或 Issue 关闭。

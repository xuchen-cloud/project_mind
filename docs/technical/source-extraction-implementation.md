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

### GUI File 版本基线与稳定回执（2026-10-01 后续阶段）

普通 GUI 两处 File 版本入口已改为“登记当前内容并打开”，走同一 Version commit/recovery 内核。预检核对页面所显示的真实 File/Project ID、managed_path 与版本号，返回当前 Workspace generation、实际字节 hash、既有登记 hash 和候选字节 hash。提交携带冻结 intent、稳定 requestId 与明确登记决定；Tauri 在存储锁内核对当前 Workspace binding，内核取得 Project/File 锁后重放原回执或再次验证版本/路径/登记值/实际字节。延迟确认不重读并静默换基线；工作区切换、旧版本、预检后的外部改动和所选源变化均拒绝覆盖。同一请求不同 intent 明确冲突，双数据库连接重试只新增一个 Version。

已登记且字节未变化时，先以 synchronous 至少 FULL 的原子事务保存 noChange 回执，不新增版本、hash 或 outbox，也不准备文件 journal。这个分支先于下一路径推导与版本号加一，外来下一版本路径和 u32::MAX 不会阻挡无变化结算。未知旧版本或已在应用外改变的 head 需要 GUI 明确确认登记：当前字节形成新的可信版本，旧登记 hash 不改写，未登记的历史仍不登记，不把修改后的旧内容称为原件。取消确认不写入；普通无条件新增版本 helper 仅保留给测试 fixture，生产 Tauri 入口不再有旧旁路。

GUI 按真实回执显示已登记版本或 noChange，打开回执对应的 Version 路径，不把成功重放后更晚的 head 当作该次成果。路径补读/通知失败不把已提交回执改成失败，路径不可用时保留成功结果并提示刷新；提交与存储锁释放后才发布 mind:changed。视图卸载、Project 变更或 Sidebar 转入 resident 后，延迟结果不再自动打开文件。公开 File/source adapters 仍未开放。

主 agent Standards / Spec 自查修复 noChange 的路径占用/版本上限边界，并检查未知历史不补 hash、无条件 GUI 旁路移除、回执/日志事务、生成绑定和释放锁后通知。Rust 全目标库 394 passed、20 默认忽略；新增 GUI 内核 7 个父用例及 binding 用例覆盖 SQL/outbox 回滚、Archive、候选源变化、未知历史、旧版本/实际字节 CAS、原回执重放、双连接和 6 次 Linux SIGKILL 恢复。source 显式实际进程专项 110 passed，Record 100 passed；前端相关 4 文件 65 passed，完整 141 文件 964 passed/1 个已有 Project 驻留用例 15s 超时。构建、路径、UI standards、bundle 检查通过，主脚本 189 KiB/250 KiB；前端完整门槛仍未通过，不能进入发布流程。

本阶段只补 GUI CAS/receipt/显式登记接入，预检 hash 与 File 准备仍持有旧 GUI DB Mutex，短锁外层尚未完成；上传与 run 绑定、精确 UTF-8 patch、历史恢复交互、恢复诊断与真实平台故障验收仍待后续工作包。未启动应用窗口、真实 Provider、review 子 agent 或 Windows 实包。#100/#114 保持 OPEN，无阶段发布 PR、main 合并或 Issue 关闭；source.search/read 与 File capability 仍 implemented:false，普通 source worker 未分发，内部惰性表不称为已发布 Schema 29。

### GUI File 预检释放存储锁（2026-10-03 后续阶段）

FileVersionService 将 GUI 预检分为权威 metadata 快照、存储锁外流式 SHA-256、返回前复核三个阶段。AppState 只在读取快照时持有当前 Workspace 与数据库 Mutex；托管路径检查、文件身份核验与原件及候选文件的 hash 均在锁外执行。预检不取得 Project 或 File 文件锁，避免持有文件锁时重新进入数据库造成锁顺序反转。Tauri 预检通过后台任务执行，任务排队期间切换工作区也必须核对最初捕获的 binding。

两次快照核对真实 File ID、Project、head 路径、版本、Archive 与登记 hash；物理快照核对文件 stamp 和系统身份，拒绝哈希后的编辑、同字节外来替换、托管父目录换绑为符号链接。原生改名返回 RevisionConflict，原生删除明确返回 NotFound；同路径新 generation 返回 WorkspaceChanged。未知历史的预检不补登记 hash、不创建版本、不修改业务资料。旧的直接数据库预检 helper 仅用于内核测试，生产 GUI 使用共享服务。

主 agent Standards 与 Spec 自查及 8 个真实 SQLite 与文件系统用例通过，覆盖哈希暂停时 Project 归档仍可完成、重开、原生改名与删除、原件变化、候选变化、同字节外来物理文件、未知旧版本与父目录换绑；删除错误分类和父目录换绑均先复现失败再修复。Rust 全目标库 402 passed、20 默认忽略；source 显式实际进程专项 110 passed，Record 100 passed。前端全量在不并行编译的条件下 141 文件、965 tests 全部通过，未修改驻留逻辑或放宽原 15s 超时；单独驻留用例约 9.5s，通过结果说明先前超时不能作为已定位产品缺陷。构建、路径、UI standards 与 bundle 检查通过，主脚本 189 KiB，预算 250 KiB；修正文档“上传与 run”的措辞，避免把斜线分词误识别为机器绝对路径。

本阶段仅完成预检的短锁与后台执行。File 提交内核的复制、hash、journal 与恢复仍沿旧 GUI 存储锁，整个 VersionCommitService 的锁拆分尚未交付；上传、精确 UTF-8 patch、历史恢复交互、产品恢复诊断及真实平台故障验收仍待后续工作包。公开 source.search/read 与 File capabilities 保持 implemented:false，普通 source worker 未启用分发，内部惰性表不是已发布 Schema 29。未启动应用窗口、真实 Provider、review 子 agent 或 Windows 实包；#100 与 #114 仍 OPEN，无阶段发布 PR、main 合并或 Issue 关闭。

### GUI File 版本提交服务与工作区屏障（2026-10-03 后续阶段）

GUI 添加版本通过同一 FileVersionService 在后台执行。当前 Host 只在捕获 binding、数据库路径与提交屏障时短暂持有 Workspace 选择锁；随后使用同一个已初始化 Workspace SQLite 文件的独立连接执行既有 Version kernel。文件复制、hash、journal、恢复及等待 Project 与 File 文件锁不持有 GUI 的 runtime.db 或当前 Workspace Mutex，也不在取得文件锁后重新获取这些锁。继续复用 documents、document_versions、登记 hash、稳定回执与原子 outbox，不建立第二个 Host、正文存储或版本表。

独立连接只允许打开存在的普通数据库文件，不使用 CREATE，不跟随符号链接，并要求当前正式 Schema 28；不重复执行 Workspace 启动、迁移、备份或 Voice 资产清理。缺库、空库或旧 Schema 返回失败，不能为 File 操作重建空数据库。原 Workspace 打开与密码重开仍走统一初始化入口，内部惰性 source 表不改正式 Schema 版本。

Workspace 生命周期屏障独立于选择锁、GUI 数据库锁和文件锁。关闭与切换使旧屏障失效；准备阶段的旧操作在原件归档之前被拒绝，并清理自己拥有的 journal。已进入提交区的操作先结算，关闭等待真实结果；noChange 与回执重放同样检查屏障。关闭会话状态保存失败时，不丢弃 runtime，也不使屏障失效。提交后完成回执对应路径补读，释放连接及所有文件锁后发布提示事件；补读与通知失败不能改写成功回执。

真实双连接测试覆盖新增版本与旧字节、后续版本后的稳定回放、noChange、同路径重开、缺库及旧 Schema、准备取消，以及 GUI Project 归档持有存储锁等待文件锁时的完成顺序。准备暂停时 GUI 的真实连接仍可创建 Todo；旧准备取消后归档能完成，没有“File 持文件锁等 GUI 存储锁、Project 持 GUI 存储锁等文件锁”的死锁。通知测试重新读取 GUI 存储并核验 File 文件锁已经释放。

主 agent 双轴审查还复现并修复晚到 requestId 冲突的恢复漏洞：File 准备期间，真实 Context Instruction 操作先占用同一调用方与请求；File 原子事务拒绝写入后，恢复不能把另一操作的回执当成自己的成功或恢复障碍。现在保留另一操作与回执，在核对原 metadata、路径、hash 和物理身份后仅恢复本 journal 拥有的原件及候选字节。回归先复现原件留在归档路径的失败，再验证原件回到旧路径、File 没有新版本、另一操作仍存在、journal 完成清理。

Rust 全目标库 410 passed、20 默认忽略，包含既有 File 实际进程崩溃恢复父用例；source 显式实际进程 110 passed，Record 100 passed。前端代码未改，复用本次独立全量 141 文件、965 tests 全通过及构建验证；路径、UI standards 与 bundle 检查通过，主脚本 189 KiB，预算 250 KiB。主 agent Standards 与 Spec 检查无未处理发现。没有启动应用窗口、真实 Provider、review 子 agent 或 Windows 实包；物理磁盘满、系统掉电及真实平台包验收仍未完成。

本阶段完成 GUI File 版本预检与提交服务的长存储锁拆分，不等于 #114 已交付。其他原生 File 导入、改名、删除和重新定位仍有旧 GUI 存储锁，后续需沿各自 journal 继续服务化；registered 内部写入口还需通过真实适配器接入同样的生命周期与 scope 校验。精确 UTF-8 patch、分块上传的长度及 hash 校验、10min 过期与真实 connection 或 run 绑定、历史恢复交互、产品恢复诊断及依赖成果模块尚未交付。#100 自动桌面调度与知识消费者也未完成。公开 source.search/read 与 File capabilities 仍 implemented:false，普通 source worker 不启用分发，内部惰性表不称为已发布 Schema 29。#100 与 #114 保持 OPEN，不创建阶段发布 PR、合并 main 或关闭 Issue。

### File 精确 UTF-8 patch 与版本服务（2026-10-03 后续阶段）

内部 FileVersionService::patch_text 已接入现有 Version kernel，支持已登记的 UTF-8 md、txt、html、htm 原始字节。所有 edits 在同一个 base 快照中定位，occurrence 从 1 开始计数，包含重叠候选；多处且未指定 occurrence 返回 AMBIGUOUS_MATCH。选定范围重叠、空 oldText、缺失目标、无效 occurrence、同时提供 edits 与 appendText 或非 UTF-8 均拒绝。HTML 不经过提取或消毒，不隐式改变编码、BOM、CRLF 或 LF。当前内部预算为最多 100 个 edit、1 MiB 序列化 patch、100 MiB 基线及结果；既有 source 提取的 10 MiB 文本与 50 MiB PDF 限额没有扩大。

Host 仍只捕获当前 Workspace binding 与生命周期屏障，使用同一个正式 Schema 28 数据库的独立连接。RequestContext 由可信适配器构造，按真实 File 归属验证 file.update、Project Archive 和来源排除；不从 patch 参数授予权限。原始字节读取与转换不占用 GUI 存储锁，准备后再次核对版本、路径和登记 hash；取得 Project 与 File 锁后校验实际磁盘 hash，提交事务中再次检查排除策略。未知旧版本不补登记，外部改动不覆盖，旧历史与其登记 hash 保留。

候选字节直接写入现有 journal 的私有 staging，复用 documents、document_versions、登记 hash、回执与 outbox；不另建上传、正文或版本存储。journal 只记录完整 patch 的 SHA-256 摘要，不保存 patch 文本。相同 requestId 换成不同 patch 即使输出相同也报 IdempotencyConflict；原请求在后续新版本之后仍回放自己的真实回执和历史路径。noChange 只保存稳定回执，不加版本、journal 或日志。提交后释放连接及文件锁再发布提示；失败与 noChange 不借同时发生的其他操作发出本次通知。

主 agent Standards / Spec 自查复现并修复三处边界：重复删除同一范围应先报重叠，不误报长度预算；另一连接已提交同一请求后，快照 metadata 变化仍能回放原回执；旧文件已归档而 SQL 尚未提交时，回执查找等待真实 File writer 结算，避免把瞬间路径缺失当作请求失败。准备期间来源排除走同一个 SQL 原子边界，拒绝提交并恢复自己的原件及候选；旧 Workspace 屏障失效也拒绝准备提交与回执回放。

18 个 patch 专项用例通过，覆盖原始 HTML/BOM/CRLF、Unicode 与重叠候选、同基线多次编辑、预算、真实归属与 grant、Archive/排除/generation、未知或外部字节、旧版本/hash、noChange、相同请求并发、晚到回放和 outbox 回滚。新增父用例在 journal 六个阶段执行真实 Linux SIGKILL，经共享初始化恢复后重试只产生一个新版本和日志，旧字节完整可读。Rust 全目标库 428 passed、21 默认忽略；source 显式实际进程专项 112 passed，Record 100 passed。

前端默认 4 worker 全量重现既有 Project 驻留用例的 15s 超时，其他 964 个通过；该驻留用例单独约 10.7s 通过，1 worker 完整运行 141 文件、965 tests 全通过。没有修改驻留逻辑或放宽超时，不将降低测试并发称为已修复产品性能缺陷。构建、路径、UI standards 与 bundle 检查通过，主脚本 189 KiB，预算 250 KiB。主 agent 未发现本次改动范围内未处理的 Standards / Spec 问题；未启动应用窗口、真实 Provider、review 子 agent 或 Windows 实包，真实磁盘满与系统掉电仍未验收。

本阶段完成内部精确 patch 服务与既有版本内核接入，尚无 GUI、CLI、MCP 或 Pi patch adapter；原 registered 无生命周期 helper 仅保留为测试 fixture，生产 patch 强制使用当前 Host 屏障。分块上传与 10min 过期、真实 connection 或 run 绑定、历史恢复交互、恢复诊断及 #104 成果接缝仍待后续工作包；其他原生 File 导入、改名、删除和重新定位的旧 GUI 存储锁拆分也未完成。#100 的完整自动桌面调度与知识消费者继续保留门槛。公开 source.search/read 与 File capabilities 仍 implemented:false，普通 source worker 不启用分发，内部惰性表不称为已发布 Schema 29。#100/#114 保持 OPEN，不创建阶段发布 PR、合并 main 或关闭 Issue。

### File 分块上传与已有版本提交（2026-10-03 后续阶段）

内部 FileContentService 支持 begin、append、finish、status 和一次性 update；参数接收目标 File、已登记的期望版本/hash 和字节，不接收本机路径。完整替换保持同一个 File ID 与原扩展名，支持非文本字节，复用既有 documents、document_versions、登记 hash、journal、稳定回执和原子 outbox。每次调用由当前 Host 捕获 binding 和提交屏障，使用同一正式 Schema 28 SQLite 的独立连接，不创建第二个 Host 或版本表。

上传限制为 100 MiB、每块最多 1 MiB、最多 100 块、Workspace 最多四份待处理上传；长度、偏移和完整 SHA-256 均须匹配。每份上传固定 10min 有效期，不因重试延长；绑定可信 RequestContext 的 caller key、Workspace UUID、规范化 grant、目标 File 与期望版本/hash。Begin 核验实际登记和磁盘原字节，各步重新授权真实归属、Archive 与排除策略，上传临时收据事务重新核对基线和排除。Run/connection 身份只由可信 Host 提供；真实业务适配器和动态连接撤销仍须由 #102/#106 接入，不能将本模块的参数绑定称为已经完成外部连接模块。

临时字节位于 Workspace 私有 file-content-stage。分块和合并文件具有持久物理身份，先保存恢复意图再追加、fsync；不可变 manifest 通过新名字发布，不覆盖外来路径。块重试验证已有前缀并只追加剩余部分，封口逐块检查并流式合并，不将 100 MiB 整体编码为请求 JSON。目录、块数、manifest 数与大小、单次读取均有界。每份最多保存一份分块内容和一份合并内容；File journal 继续独立承担正式版本的提交恢复。临时文件是上传恢复材料，不是另一套正文或版本存储。

哈希、复制及大块合并不持有 GUI 数据库/Workspace 选择锁或生命周期提交屏障；短屏障只保护意图与收据结算。上传和封口在字节处理后重新检查有效期，正式 File 提交在准备 journal 后、移动原件前再次检查过期和当前 Host 屏障。进入正式提交区后结算真实结果。稳定 File 收据优先于临时文件：即使临时文件已回收、上传过期或已有后续版本，原请求仍回放其真实收据；并发重试在等到上传锁后再次检查收据。noChange 结算收据且消耗该上传，不新增版本、journal、日志或通知。

共享 Workspace 初始化及后续 begin 清理已过期或已消耗的私有上传。只删除 manifest 指定且物理身份仍匹配的字节与已核验的 metadata；未知文件、同字节的外来 inode、损坏描述和恢复冲突保留诊断，不递归删目录，也不阻止原有用户内容的 Workspace 打开。部分写入继续验证原身份与已写前缀，拒绝外来重绑。恢复诊断目前是内部日志，产品查看/重试入口尚未交付。错误声明 hash 的未封口合并文件仍属于自己的临时意图，过期后按原物理身份安全回收；一份外来/损坏上传只保留在有界配额中，不阻止其他已过期上传清理和后续 begin。

14 个上传专项用例通过，包括真实 SQLite、二进制/空内容、1 MiB 边界、100 块与 Workspace 四份配额、固定期限、错误长度/hash/偏移/请求、scope/Archive/排除/generation、noChange、并发稳定回放、共享重开清理和外来文件保留。父用例执行 14 个实际 Linux SIGKILL：上传八个阶段和既有 File journal 六个阶段，经共享初始化恢复后重试仅产生一个新 File Version 与日志，旧字节完整保留。Rust 全目标库 442 passed、22 默认忽略；source 显式实际进程 112 passed，Record 100 passed。

前端全量首次与重复运行均只有既有驻留用例的 15s 超时，分别 964 passed / 1 failed；单独驻留用例通过。先以 ab24238 单独提交测试场景拆分：Project Shell 的 LRU/复用/关闭与六个实际 Record Focus 路由分开验证，保留全部行为断言和原 15s 时限，未修改产品缓存逻辑。拆分后 App 22 tests 通过，完整 141 文件、966 tests 通过。构建、路径、UI standards 与 bundle 检查通过，主脚本 189 KiB / 250 KiB。

主 agent Standards / Spec 自查补上了错误 hash 上传的过期回收、单份外来上传与其他恢复隔离，以及并发通知验证探针的真实锁归属：另一 writer 可以在本操作释放 File lease 后立即取得自己的锁，测试用有界等待允许其结算，本操作若保留自身 lease 则仍超时失败。最终 Rust 全目标及 source/Record 实际进程专项均通过，没有剩余的本阶段审查发现。

后续仍需历史恢复服务与交互、真实 run/connection 注册和撤销、GUI/CLI/MCP/Pi adapters、恢复诊断，以及其他原生 File 写入口的长 GUI 存储锁拆分。#100 完整自动桌面调度与知识消费者尚未完成。公开 source.search/read 与 File capabilities 继续 implemented:false，普通 source worker 不启用分发，内部惰性表不称为已发布 Schema 29。#100/#114 保持 OPEN，不创建阶段发布 PR、合并 main 或关闭 Issue；未启动应用窗口、真实 Provider 请求或 review 子 agent，Windows 实包、物理磁盘满与系统掉电仍未验收。

### P1：历史 File Version 恢复与通知归属（2026-10-03）

内部 FileVersionService::restore_version 接收真实 File ObjectRef、十进制字符串历史 Version ID、当前期望版本及登记 hash；由服务端按实际归属解析历史路径，单独要求 file.restore。未知旧版本不补登记，历史实际字节必须符合已登记 SHA-256。恢复复用现有 Version 内核、CAS、journal、回执与 outbox，在同一 File 上新增版本，不移动原历史字节、不倒退版本号；相同内容返回 noChange。独立连接及当前 Workspace 提交屏障继续隔离准备 I/O 与 GUI 存储锁，提交事务复核历史登记和来源排除。

成功回执按完整恢复意图绑定：后续又有新版本时仍回放原操作的版本；同 requestId 更换历史 Version 拒绝。恢复准备期间授权、Archive、排除、Workspace generation 或历史字节变化均不能提交。六个既有 journal 阶段实际 SIGKILL 后，通过共享初始化恢复旧版或完整新版，重试只新增一次且原历史路径仍可读。

确定性三调用并发测试复现了“只新增一个版本、却重复发送通知”的真实缺陷。共用 Version 内核现在返回仅限本次调用的 committed 标记，稳定回执和持久化格式不变；GUI、patch、upload、restore 只在本次真实内容变更成功后捕获并发送通知，回放、noChange 和失败不借另一连接的日志发通知。patch 同样使用快照 barrier 验证并发通知只发送一次，GUI 增加旧回执回放通知计数断言。

P1 不含历史版本 GUI 比较/恢复交互、正式 run/connection 接入或产品恢复诊断；这些继续归 P6 及所属 Issue。公开 File 和 source capabilities、普通 worker 分发、正式 Schema 发布均未在此开放。#100/#114 保持 OPEN，阶段提交不进入发布合并流程。

验证：恢复专项 9 passed/1 ignored，受影响 patch 11 passed、GUI 服务 8 passed、上传并发 1 passed，旧 GUI 回执通知断言通过；最后集中执行 Rust 全目标，库 451 passed/23 默认忽略，其他目标通过，包含恢复六阶段实际进程父用例。未改前端 DTO/命令/事件格式、依赖或资源，复用 86b7859 阶段前端 141 文件/966 tests 与构建证据，未重跑。主 agent Standards/Spec 自查及 diff 检查完成；未执行应用窗口、真实 Provider 或真实平台故障验收。

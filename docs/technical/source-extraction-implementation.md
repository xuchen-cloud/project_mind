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

共享 SourceService 提供目录 backfill、日志合并与处理单个有界任务的接缝，真实固定转换进程已验证自动建立旧 Record 唯一基线并进入索引；处理/哈希期间不持业务锁。此内核尚未挂接桌面 assistant 启用/激活调度，也未启动后台循环。正式运行时需继续接预算总量、前台优先、取消/进度、其余 GUI 业务 outbox 以及资源分发门禁。

修复日志全部清理后的恢复边界：变化页与提交捕获从 SQLite 单调 sequence 恢复末尾水位，空日志不再丢掉 resetRequired。新增队列 11 项（含真实转换进程）及空日志恢复 1 项；最终来源专项 93 项显式通过，Rust lib 全量 326 项通过/16 项默认忽略。最终前端全量 139 文件/955 项通过；最终 Rust 全目标测试同样通过（库 326 项/16 项默认忽略，其余目标零用例），Record 专项 99 项显式通过；既有构建、路径/UI/bundle 检查均通过。本批 Standards/Spec 由主 agent 自查，修复了同路径重开绑定、重叠时间定位与空日志水位问题；剩余接入职责仍见下文，未启动 review 子 agent。

最终边界修复统一 Transcript 时间定位的 JSON 精确整数上限；请求超过 JavaScript 安全整数范围时拒绝，已有异常 final segment 不作为可返回证据。新增真实数据库测试验证输入与持久化两条边界。修复后来源专项 94 项显式通过，Rust 全目标测试通过（库 327 项通过、16 项默认忽略），前端全量保持 139 文件/955 项通过，Record 专项 99 项显式通过。构建与路径/UI/bundle 检查通过；未启动应用窗口、发送真实 Provider 请求或进行 Windows 实包验收。用户要求将阶段提交推送至既有 AI Enhancement 分支并交接，Issue #100 保持开放。

## 后续责任

提取 worker 不授予源访问权限，也不推断所属 Workspace/Project。共享 File 读取服务已经核对真实归属、Scope Grant、排除策略和登记版本 hash，并在异步处理后复查 binding、版本和字节。File 索引提交和检索已复用这些强制边界；File 提取投影不能代替 Committed JSON。

Record 的按需基线接口与 Workspace Record typed token 已实现；队列内核已调用前者，桌面/Host 自动调度尚未挂接。File 核验内核不授予权限；导入/版本写入时的 hash 登记及存量版本状态仍继续实现，不能将未知存量字节自动冒充原登记版本。正式会话来源、其余 GUI 业务写入的 outbox、知识依赖失效及桌面自动队列调度尚待接通。source.search/read 的 capability 标记仍为 false，没有开放 GUI/CLI/MCP/Agent 入口；缓存准备也尚未作为已发布迁移执行。主程序构建不启用来源 worker；文件读取在阻塞线程执行，尚未增加独立的文件系统阻塞截止；Windows 字节复核始终重新计算 hash，但未在 Windows 实包执行验证。Windows 实包与完整 AI 工作流保留对应验收门禁。

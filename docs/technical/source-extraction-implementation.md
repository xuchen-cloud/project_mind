# 来源提取实施记录

状态：Issue #100 的本地阶段实现；尚未完整交付或发布。

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
- 缓存统计分别报告对象、快照、chunk 和已存储内容字节；后者是 payload 统计，不包含 FTS/B-tree 页面开销，不能冒充整个 SQLite 文件大小。
- Workspace Record 使用 `[[workspace_record:<id>|<label>]]` 专用引用，旧 `note:<id>` 继续指向 Project Record。文本/HTML/Committed JSON/Markdown 转换、候选搜索与导航、正文/Todo 归属校验和可携带导出一起兼容；同号对象不混淆，删除后不回退到另一张表。Project 内容拒绝新增 Workspace 引用。引用候选列表复用公共滚动边缘测量，限制到浮层可用高度，遮罩不覆盖滚动条或阻挡点击。

[DOMMatrix 上游](https://github.com/thednp/dommatrix) 提供兼容实现，当前锁定 3.1.2；其完整 MIT 许可由构建从实际依赖生成。PDF.js CMap 的 Adobe 许可及标准字体的 Foxit/Liberation 许可一并保留。

## 验证范围

纯提取/协议 15 项，独立固定 Node 5 项，原生提取 6 项通过。独立进程复制至中文空格临时路径，仅保留 bundle 与 PDF 资源，不存在 node_modules 或 native canvas；验证中英混合 PDF、加密 PDF、HTML 脚本跳过和严格单帧协议。

前端全量 137 文件/947 项通过，最新 Rust 全量 288 项通过、12 项默认忽略；Record 相关 94 项（含实际固定进程）和 Node 转换/许可 6 项显式通过。构建、路径/UI/bundle 检查通过，启动脚本 184 KiB/250 KiB。新增的 3 项真实旧 Record 转换测试包含于显式 Record 验证，默认忽略仅因为依赖准备好的固定 Node 分发。前端第一次双并发全量中查找替换用例超时，单独复现通过后以单并发全量通过，未增加超时或削弱断言。

新增共享来源/真实业务存储 15 项、检索缓存 10 项验证，覆盖 Unicode 分页、局部块的子内容、固定历史修订、当前 metadata 变化、权限/作用域/工作区切换、归档、排除回执重放、实际业务归属、删除缓存、部分预算与幂等升级。

本批增加 File 共享服务 7 项、File 核验 4 项和旧 Record 4 项，覆盖同尺寸外部改写、提取后复查、缺失/超限/符号链接/特殊文件、存量转换后读取与检索、转换期间切换/排除/正文变更、并发新 head 与资源不可用。参数错误在启动转换前拒绝。

原生测试验证资源篡改拒绝、同 Workspace 排队、其他 Workspace 独立运行、超时终止后可重试、响应覆盖与定位的一致性。共用执行内核调整后，Record 85 项（含默认忽略的实际进程用例）及既有 Node 转换/许可 6 项通过。

## 后续责任

提取 worker 不授予源访问权限，也不推断所属 Workspace/Project。共享 File 读取服务已经核对真实归属、Scope Grant、排除策略和登记版本 hash，并在异步处理后复查 binding、版本和字节。后续 File 索引提交与检索也须复用这些强制边界；File 提取投影不能代替 Committed JSON。

Record 的按需基线接口与 Workspace Record typed token 已实现；前者尚待后台队列调用。File 核验内核不授予权限；File 索引/检索、导入/版本写入时的 hash 登记及存量版本状态仍继续实现，不能将未知存量字节自动冒充原登记版本。其他业务来源、500ms 合并、GUI 全量业务事件和持久后台队列尚待接通。source.search/read 的 capability 标记仍为 false，没有开放 GUI/CLI/MCP/Agent 入口；缓存准备也尚未作为已发布迁移执行。主程序构建不启用来源 worker；文件读取在阻塞线程执行，尚未增加独立的文件系统阻塞截止；Windows 字节复核始终重新计算 hash，但未在 Windows 实包执行验证。Windows 实包与完整 AI 工作流保留对应验收门禁。

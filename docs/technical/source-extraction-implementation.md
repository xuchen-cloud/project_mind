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
- 缓存统计分别报告对象、快照、chunk 和已存储内容字节；后者是 payload 统计，不包含 FTS/B-tree 页面开销，不能冒充整个 SQLite 文件大小。

[DOMMatrix 上游](https://github.com/thednp/dommatrix) 提供兼容实现，当前锁定 3.1.2；其完整 MIT 许可由构建从实际依赖生成。PDF.js CMap 的 Adobe 许可及标准字体的 Foxit/Liberation 许可一并保留。

## 验证范围

纯提取/协议 15 项，独立固定 Node 5 项，原生提取 6 项通过。独立进程复制至中文空格临时路径，仅保留 bundle 与 PDF 资源，不存在 node_modules 或 native canvas；验证中英混合 PDF、加密 PDF、HTML 脚本跳过和严格单帧协议。

前端全量 136 文件/940 项沿用提取层验证；本轮未修改前端。最新 Rust 全量 274 项通过、9 项默认忽略，包含资源篡改用例。

新增共享来源/真实业务存储 15 项、检索缓存 10 项验证，覆盖 Unicode 分页、局部块的子内容、固定历史修订、当前 metadata 变化、权限/作用域/工作区切换、归档、排除回执重放、实际业务归属、删除缓存、部分预算与幂等升级。

原生测试验证资源篡改拒绝、同 Workspace 排队、其他 Workspace 独立运行、超时终止后可重试、响应覆盖与定位的一致性。共用执行内核调整后，Record 85 项（含默认忽略的实际进程用例）及既有 Node 转换/许可 6 项通过。

## 后续责任

提取 worker 不授予源访问权限，也不推断所属 Workspace/Project。File 来源服务仍须先核对真实归属、Scope Grant、排除策略和登记版本 hash，读取有界字节快照，在处理后复查 binding 和版本才提交索引。Record 已按上述共享边界读取；File 提取投影不能代替 Committed JSON。

当前共享服务仅接通已初始化 Committed JSON 的 Record。旧 Record 的按需基线初始化、File 的登记 hash/外部变更状态、其他业务来源、Workspace Record typed token、500ms 合并、GUI 全量业务事件和持久后台队列继续实现。source.search/read 的 capability 标记仍为 false，没有开放 GUI/CLI/MCP/Agent 入口；缓存准备也尚未作为已发布迁移执行。主程序构建不启用来源 worker；Windows 实包与完整 AI 工作流保留对应验收门禁。

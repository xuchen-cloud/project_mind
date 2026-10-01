# 来源提取实施记录

状态：Issue #100 的本地阶段实现；尚未完整交付或发布。

## 已实现的边界

- UTF-8 txt、Markdown、HTML 的纯文本提取；拒绝非法 UTF-8 和 NUL 交错编码，不产生替换字符作为证据。
- PDF.js 文本层提取；页码加页内 Unicode 字符范围与既有 SourceLocator 契约一致。仅取文本，不执行 PDF actions、表单或 HTML 脚本。
- 1800 字符 chunk、200 字符段内或页内重叠；覆盖字符数不重复计算重叠。ready、partial、needs_ocr、encrypted、unsupported_encoding、too_large、failed 明确区分。
- 固定 Node 24.21.0 权限隔离进程，空 PATH；每 Workspace 一个任务、60 秒硬截止、512 MiB JS heap、70 MiB 输入帧及 16 MiB 输出帧。应用退出或请求取消时 kill-on-drop，不在提取过程中持有业务 DB 锁。
- JS bundle、PDF 字符映射表、标准字体、许可文本和 SHA-256 清单独立分发；原生构造器校验 Node、入口和所有资源，缺失或不兼容时拒绝运行。
- Record 与提取进程共用有界执行内核，但保留各自独立的并发槽、容量和时间限制。

[DOMMatrix 上游](https://github.com/thednp/dommatrix) 提供兼容实现，当前锁定 3.1.2；其完整 MIT 许可由构建从实际依赖生成。PDF.js CMap 的 Adobe 许可及标准字体的 Foxit/Liberation 许可一并保留。

## 验证范围

纯提取/协议 15 项，独立固定 Node 5 项，原生提取 6 项通过。独立进程复制至中文空格临时路径，仅保留 bundle 与 PDF 资源，不存在 node_modules 或 native canvas；验证中英混合 PDF、加密 PDF、HTML 脚本跳过和严格单帧协议。

前端全量 136 文件/940 项、Rust 全量 249 项及 9 项默认忽略通过，包含资源篡改用例。

原生测试验证资源篡改拒绝、同 Workspace 排队、其他 Workspace 独立运行、超时终止后可重试、响应覆盖与定位的一致性。共用执行内核调整后，Record 85 项（含默认忽略的实际进程用例）及既有 Node 转换/许可 6 项通过。

## 后续责任

提取 worker 不授予源访问权限，也不推断所属 Workspace/Project。后续共享来源服务必须先核对 ObjectRef 真实归属、Scope Grant、来源排除策略和当前版本 hash，读取有界字节快照，在处理后复查 binding 和版本才提交索引。Record 索引从 Committed JSON 携带 blockId；此 File 提取投影不能代替它。

FTS5 trigram、短查询有界 LIKE、SourceRef 分页读取、500ms Record 合并和来源后台队列尚未接入。主程序构建仍不启用该能力；Windows 实包与完整 AI 工作流在对应验收门禁中继续保留。

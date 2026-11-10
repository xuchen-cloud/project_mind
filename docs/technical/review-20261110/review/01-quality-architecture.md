# Phase 1：质量与架构

基线 `fe9fe9c188f05c23bae369074446e38c0859a0c8`。详证分别见 [前端报告](01a-frontend-quality.md) 与 [持久化报告](01b-persistence-architecture.md)。下述是已确认机制，不等同于已经确认用户现场的唯一根因。业务修复不在本阶段；用户后来独立要求的 Office 缩放 50%–150% 由独立工作包实施。

## Code Quality Findings

| ID | 优先级 | 问题 | 证据 |
|---|---|---|---|
| F1 | P1 | 固定历史引用复用 File Tab，绕过 flush 销毁当前草稿 | 实际组件＋mock native 隔离复现 |
| F2 | P1 | Record 注册等待中保存完成，旧正文被配上新 revision，后续可覆盖新正文 | 实际 hook/coordinator 时序复现 |
| F3 | P1 | 隐藏 QuickNote 的关闭 flush 对已有保存失败返回成功 | 实际 editor/QuickNote 隔离复现 |
| F4 | P1 | 关闭 Project 或 Overview 淘汰未捕获/保留 QuickNote 草稿 | 组件卸载复现＋真实 App 关闭链 |
| F5 | P2 | 单条 Workspace Record 保存等待全局队列，被其他记录失败误报 | 调用链确认 |
| F6 | P2 | 不可重试的队首校验失败挡住修正后草稿，普通编辑/重试无法恢复 | coordinator 隔离复现＋UI 恢复入口检查 |

## Architecture Findings

| ID | 优先级 | 问题 | 证据 |
|---|---|---|---|
| N1 | P1 | working 与版本恢复/提交的 fence/File lease 锁序相反，关闭可形成三方死锁 | 生产 fence＋替代 File mutex 的 macOS 锁级探针；真实 lease 集成待验证 |
| N2 | P1 | 单文件 journal 外部冲突使全局恢复失败，阻断无关文件与 Workspace 重开 | 完整提交/恢复/启动调用链；故障注入待验证 |
| N3 | P2 | 外部同字节原子替换后，目录接受新身份但 working 状态留旧身份，持续拒绝打开 | 调用链确认；原生 fixture 待验证 |
| N4 | P2 | 独立 voice 连接的 Project 草稿 DEFERRED 事务升级，可能立即报 database is locked | 实际 SQL 双连接探针；不是 Windows/生产 Rust 集成复现 |

## Critical Issues for Phase 2 Context

- 保存问题不能只看写入原子性；捕获草稿、加载 hydration、关闭/淘汰和错误队列都有更早的数据丢失边界。已有 CAS、原子回执和恢复 BLOB 仍需保留。
- Windows 录音故障发生在「点击开始」；N4 与此吻合，但用户未提供 error code、Project/Workspace target 和部署版本，不能宣称已确定现场根因。rusqlite 已有 5s busy timeout；此升级竞争不能靠延长超时解决。
- Record 排版 token 与 canonical 引入前无变化；StableRecordBlocks 仅增加 ID，没有额外 wrapper。边界空段落保留与特定 DOM/用户设置仍需验证，不能先改全局段距。
- Office 先创建完整 working 基线与恢复 BLOB，等待完整 inspect model，再 mount renderer。首次打开在写事务内进行整文件 I/O，可能与 Record/voice 写入竞争。用户要求首屏先可用、后续分段加载，并授权修改 OSS 源码；方案必须完整保存从未加载的内容。
- 当前 native 性能 witness 只捕获旧接口，漏掉 file_working_open；主审仅在生成测量脚本中临时补 observer 后获得有效样本。原始 45s 假超时不计产品耗时。macOS embedded-debug、单次 fixture 数据不能替代 Windows/release/p95。
- Phase 2 优先审查真实权限/归属、路径、保存完整性与资源预算，交叉核验高风险项，并深入 Office 引擎内全量读取/解析/重复加载。仓库无 CI 是已有决定，不作为缺陷。

## Verification

- Frontend：F1/F2/F3/F4/F6 共 5 个针对性隔离实验（QuickNote含2例），见01a日志与实际命令。普通块转换6/7通过；code language roundtrip失败保留为内容保真待核验项。
- Native：fence锁探针与SQLite双连接探针，见01b；未重新运行全量Cargo测试。
- 原生测量构建磁盘不足后，用户明确同意清理可再生成的增量缓存，随后构建成功。该环境故障已解决。

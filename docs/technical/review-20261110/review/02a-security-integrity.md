# Phase 2A：本地保存安全与数据完整性复核

日期：2026-11-10；基线：`fe9fe9c188f05c23bae369074446e38c0859a0c8`。

关联 Issue：用户直接发起的 full-review，无新 Issue。依赖：`00-scope.md`、`01-quality-architecture.md`、`01b-persistence-architecture.md`、当前源码及本机 fs2 0.4.3 源码；按 `/Users/xuchen/.codex/skills/full-review/references/security-auditor.md` 的 Phase 2A 执行。交付行为：独立挑战 N1–N3，检查 working save / replay / recovery 的身份、授权与路径约束，并提供最小修复方向。非目标：业务修复、构建、GUI、性能测量、重复测试、递归委派、云平台或通用 OWASP 清单。验收：每项有实际调用链、反证检查、证据级别和精确位置。本报告完成该工作包，不代表整个 full-review 完成。

本轮只有静态源码/文档审查；没有运行测试或探针，没有访问用户工作区数据。Phase 1 的探针结果仅注明继承来源，不冒充本轮复现。未发现有证据支持的新独立授权绕过或路径穿越缺陷；这不构成全仓安全认证，也没有进行 CVE 扫描或作 CVE 声明。

## 结论与证据等级

| 项目 | 结论 | 严重度 | 本轮证据与限制 |
|---|---|---|---|
| N1 | 保留：真实任务可竞争同一 File lease，fence 锁序反转可达 | High / P1 | 生产调用链、独立连接、独立打开锁文件的静态证据；三方死锁依赖 RwLock 写者排队策略。Phase 1 只有 macOS 生产 fence＋替代 mutex 探针，尚无真实 lease 端到端复现 |
| N2 | 保留：一个 journal 的外部冲突向其他 File 操作及工作区启动传播 | High / P1 | 错误传播及启动路径静态确定；未做新故障注入。不等于已证明字节丢失 |
| N3 | 保留：接受同 hash 的新文件身份后，working 状态仍拒绝打开 | Medium / P2 | 两套持久化状态与条件分支静态确定；未运行原生 fixture |

这些是本地可用性与完整性发现，沿用原编号，不在总表重复计数。不为本地调度/恢复缺陷强配远程攻击 CVSS 分数。

## N1：真实 File 锁竞争没有被主数据库 mutex 串行化

**主位置：** [file_working.rs:81](/Users/xuchen/project_mind/src-tauri/src/file_working.rs:81)、[db/file_working.rs:266](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:266)、[project_directory_files_restore.rs:324](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files_restore.rs:324)、[project_directory_files_restore.rs:434](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files_restore.rs:434)。

本轮针对“生产是否真的能并发”检查了以下反证：

1. **并非所有操作都持有同一 App DB mutex。** working 同步命令在 [file_working_commands.rs:28](/Users/xuchen/project_mind/src-tauri/src/file_working_commands.rs:28) 启动 blocking task；Office open/save 同样在 118 行启动；版本恢复在 [file_read_commands.rs:124](/Users/xuchen/project_mind/src-tauri/src/file_read_commands.rs:124) 启动独立 blocking task。后台 working archive 在 [file_working_commands.rs:173](/Users/xuchen/project_mind/src-tauri/src/file_working_commands.rs:173) 也可并发进入。
2. **Host 捕获只短暂锁定选择，实际 I/O 使用独立连接。** [file_version_service.rs:253](/Users/xuchen/project_mind/src-tauri/src/file_version_service.rs:253) 返回共享 fence 的 Host 后释放 current workspace guard；[file_version_service.rs:68](/Users/xuchen/project_mind/src-tauri/src/file_version_service.rs:68) 每次创建 runtime connection；恢复调用该 Host 的位置是 275–276 行。working 的对应位置为 `file_working.rs:78–81`。因此可以先让 B 取得 File、让 A 捕获 Host，再让 C 关闭，并不要求在 C 已锁住 current workspace 后才启动 A。
3. **锁不是同一 File handle 的重入。** [db/file_versions.rs:595](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:595) 每次 `OpenOptions::open`，600 行执行阻塞式 `fs2::FileExt::lock_exclusive`。同文档 ID 指向同一 `.project-mind/file-version-locks/<id>.lock`。本机依赖 [fs2 lib.rs:259](/Users/xuchen/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fs2-0.4.3/src/lib.rs:259) 的上游测试明确对同进程两次 open 建立互斥预期；[unix.rs:30](/Users/xuchen/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fs2-0.4.3/src/unix.rs:30) 实现为 `flock(LOCK_EX)`。这里只阅读原始实现/测试，未运行它们。不能用“文件锁只防跨进程”否定 N1。
4. **Project 共享锁不消除同 File 竞争。** working 的 `file_recovery_write_locks` 在 [db/file_versions.rs:550](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:550) 获取 Project shared，再获取 File exclusive；目录恢复使用同一顺序，但两者进入 fence 的位置不同。

成立的交错为：B 持有 File、尚未进入 fence；A 持有 fence/read 等 File；C 等 fence/write；B 再等 fence/read。当读写锁阻止新读者越过排队写者时，形成 A→B→C→A。B 即使在准备期间产生 journal，A 的全局恢复扫描也可能等待同一 lease。`WorkspaceCommitFence` 的阻塞读/写见 [workspace_commit_fence.rs:21](/Users/xuchen/project_mind/src-tauri/src/workspace_commit_fence.rs:21) 与 37 行；关闭/切换入口见 [lib.rs:422](/Users/xuchen/project_mind/src-tauri/src/lib.rs:422)、[lib.rs:493](/Users/xuchen/project_mind/src-tauri/src/lib.rs:493)。

**影响与限制：** 可卡住保存/打开与关闭/切换，切换持有 current workspace 时还会阻塞其他入口。真实并发和锁序已确认；不能从 Rust `RwLock` 类型本身断言所有系统必然采用相同公平策略。Phase 1 的 macOS 探针说明该策略在当时环境中可触发，但未使用实际 fs2 lease；本轮不把它升级为完整应用复现。没有证据表明该锁环本身已破坏已提交字节。

**最小修复：** 统一 working 与恢复/版本写入的生命周期 admission、Project/File lease 顺序；避免持有 fence 等待稍后还要进入 fence 的 File 持有者。若把 fence 移入取得 lease 之后，必须同时审计 journal/recovery 在 fence 外的写入，确保失效 Workspace 不能开始新业务提交。不要简单删掉 fence。后续用真实 runtime connections、实际 File lease 和 barrier 覆盖三方交错；GUI/后台 tick 也是实际并发来源。

## N2：journal 冲突隔离不足，回执重放不能绕过全局恢复

**主位置：** [db/file_working.rs:416](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:416)、[db/file_working.rs:430](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:430)、[db/file_working.rs:809](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:809)、[db.rs:387](/Users/xuchen/project_mind/src-tauri/src/db.rs:387)。

无需崩溃的触发链：保存先在 `db/file_working.rs:557–563` 持久化 journal；外部修改随后使 566 行旧 identity/hash 校验失败；613 行恢复再次因 target 不匹配 old/new 而退出，journal 未清除。随后任何进入 [db/file_versions.rs:543](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:543) 的文件操作，先经 810–811 行扫描全部 working journal；单个错误通过 `?` 返回，尚未取得请求目标 File 的 lease。`Database::open` 在迁移后同样直接传播恢复错误。

另一个静态成立的分支是数据库提交已完成、journal 尚未清理时中断，之后外部文件改变：恢复虽根据 revision/hash 判定 committed，仍在 416 行要求 live target 等于当时 new identity/hash，因而无法收尾。

**反证检查：**

- 服务确实先调用专用 replay，但 [db/file_working.rs:880](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:880) 仍在读取回执前取得 `file_recovery_write_locks`，因此一样遭遇全局失败；不是只有内层 save replay 受影响。
- **恢复 BLOB 有有效的例外读取入口。** [db/file_working.rs:920](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:920) 直接拿目标 Project/File 锁，读取最近成功保存的 bytes 并校验 hash，未调用全局恢复。这意味着仍打开的 Workspace 中可能取回恢复副本，不能描述成“所有恢复内容都无法读取”。但关闭后的 `Database::open` 已失败时，这个正常 GUI 入口无法解决启动阻断。
- 旧/新 identity＋hash 校验、NOREPLACE、同步目录与保留 journal 正在保护外部字节；它们不是应删除的阻碍。尚未成功提交的新内容与最后成功保存的恢复 BLOB 也应区分，不能保证该 BLOB 覆盖所有中断草稿。

**最小修复：** 对可识别的单 File 外部冲突记录/返回局部恢复状态并保留材料，让工作区及无关 File 可用；目标 File 新写入仍须阻止或显式解决冲突。已提交回执和恢复 BLOB 应能在当前授权下查询；已提交 journal 的安全清理不能要求外部盘面永远保持提交时状态。不能把全部 I/O/损坏错误泛化为可忽略冲突。后续只需覆盖未提交外部冲突、已提交未清理＋外部修改、无关文件、reopen 和 recovery read 的组合。

## N3：内容相等不意味着两份身份状态已同步

**主位置：** [db/project_directory_files.rs:1034](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files.rs:1034)、[db/file_working.rs:160](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:160)、[db/file_working.rs:191](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:191)。

前提是已有 working state、`pending=false`、当前历史已冻结。外部同字节原子替换产生新 identity；[db/file_working.rs:834](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:834) 不匹配旧 identity，且无 pending 时返回 false，允许目录 refresh 继续。目录在 [db/project_directory_files.rs:1005](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files.rs:1005) 确认 hash 与历史相同，1034 行接受新 identity，1040 行起再次核验。随后 working open 只在历史 hash 不同且无 pending 时重建 state；同 hash 跳到 191 行再次用旧 identity 拒绝。

**反证检查：** 有 pending 时的拒绝是必要保护，不适用上述自动接纳场景；未冻结历史时 986 行的 ambiguous 分支也另当别论。缺陷准确限定于目录已合法接受新身份、working state 没同步。重启不清除 `file_working_contents`，因此不能把 reopen 当作修复。

**最小修复：** 同内容替换获得授权、且无 pending/journal 时，在同一 File lease/事务边界同步或安全失效 working identity，并推进 revision/失效旧 sessions。保持内容 hash 与历史版本不变；不能删掉通用 identity CAS。验收应断言同字节替换后可打开、历史不膨胀、旧会话不能携旧基线继续提交。本轮静态确认，未运行该 fixture。

## 已确认的授权、保存及路径保障

- **身份来自数据库实际归属。** [file_office.rs:124](/Users/xuchen/project_mind/src-tauri/src/file_office.rs:124) 验证当前 binding、请求 ID，解析实际 ObjectRef 并要求相等，再构造本地 GUI grant；[db/file_working.rs:95](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:95) 拒绝非 GUI caller。底层 [db/file_versions.rs:1063](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:1063) 检查 File 类型、native workspace、实际归属、授权 operation、scope 存活、来源策略；1059–1060 行另检查可见性。客户端提交某个 project ID 不会直接取得该项目授权。
- **会话与重放各有身份约束。** [db/file_working.rs:315](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:315) 按 session＋document 查找，并在 322 行验证 generation 与完整 ObjectRef；save/replay 在回执前均进行当前授权。允许已关闭 session 的精确 replay 是契约行为，不等于绕过归属。回执按 caller/request 索引，并核对 operation＋payload hash，见 [db/agent_operations.rs:65](/Users/xuchen/project_mind/src-tauri/src/db/agent_operations.rs:65)。
- **跨 worker 后复核，保存 CAS 与原子回执仍有效。** Office worker 返回后重新进入 `with_db`，见 [file_working.rs:280](/Users/xuchen/project_mind/src-tauri/src/file_working.rs:280)；save 的 503–505 行检查 session、revision/hash，565/582 行再次授权；576–609 行把 state、恢复 bytes、目录 identity、回执和变更记录放入同一事务。不能用“补一个事务/CAS”概括修复 N1–N3。资源边界包含 100 MiB 内容、Markdown 10 MiB、16 个 working sessions；本轮未进一步测量内存峰值。
- **路径不是由 working DTO 直接提供。** save 由授权的 document 取 managed/history 路径；[db/file_versions.rs:472](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:472) 拒绝越出 workspace、非 Normal 路径组件和逐段 symlink。runtime DB 不新建，使用 NOFOLLOW，见 [db.rs:400](/Users/xuchen/project_mind/src-tauri/src/db.rs:400)。读取使用普通文件检查、末级 NOFOLLOW/Windows reparse-point handle；替换使用独占 rename，见 [db/file_versions.rs:447](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:447)。
- **恢复材料约束与反证。** [db/file_working.rs:385](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:385) 将 journal ObjectRef、target 与 document 绑定，检查 staged/backup 所属 history、不同路径与固定前缀＋32 位 token，删除前核验 identity/hash。虽然恢复没有单独对 target 调用 `relative`，不能据此直接报父目录 symlink 漏洞：正常 history 在 target 同级的隐藏目录下，见 [db.rs:6505](/Users/xuchen/project_mind/src-tauri/src/db.rs:6505)，396–397 行对 staged/backup 的逐段检查覆盖了共同父目录。并发替换父目录的极窄 TOCTOU 仍不等于已证明越界写入；本轮没有独立攻击 fixture，也没有把恶意篡改 DB 作为普通输入前提。
- **不把文件预览内容当成本地 GUI authority。** 阅读的 HTML preview 使用独立 Wry WebView，没有 Tauri invoke handler，IPC 只接收有界诊断文本，见 [html_preview.rs:364](/Users/xuchen/project_mind/src-tauri/src/html_preview.rs:364)。因此不能仅因 working command 内部创建 `Caller::Gui` 就声称 HTML 文件能调用它。本轮未逐项审计全部 renderer 或 WebView 配置。

## 与前端完整性合同交叉检查

仅阅读前端报告 F2，不重跑隔离测试。F2 的机制是正文 A 与后来推进的 revision N+1 被错误组合；即便 native CAS 正确，它也只能验证客户端声明的 N+1，不能判断正文 A 是否来自该 head。因此 F2 与本轮确认的 native CAS/原子回执保障并不矛盾；应修复 hydration 与保存基线的一致性，不能放宽 CAS，也不能把前端时序风险误称为 native 授权绕过。

## 移交与验证记录

执行内容：读取上述报告、AGENTS/skill、指定生产调用链与本机 fs2 原始实现，检查当前 HEAD；只新增本报告并进行 Markdown diff/链接检查，然后暂存本文件。未构建、未启动 GUI、未运行单元/集成测试、未写业务源码、未创建子 agent。现有测试阅读不计本轮通过；Phase 1 探针证据级别保持不变。

交主审：保留 N1/N2 的 P1 与 N3 的 P2，合并时不要重复计数；N1 的生产竞争前提已独立确认，真实 lease 三方 barrier 用例仍是明确的补证项。GUI、性能和后续阶段由主审继续，本报告不修改全局 review state，也不代主审跨越 Phase 2 checkpoint。

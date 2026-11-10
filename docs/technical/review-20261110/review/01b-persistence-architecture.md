# Phase 1B：原生持久化与数据完整性架构审查

基线：`fe9fe9c188f05c23bae369074446e38c0859a0c8`；日期：2026-11-10。依据 `AGENTS.md`、`.full-review/00-scope.md`、full-review 的 `references/architect-review.md`、`docs/implementation/file-working-content-notes.md` 与 `file-save-sessions.md`。本报告为阶段交付，不代表整个 full-review 已结束。

确认 4 项缺陷：Workspace 关闭锁序死锁、单个文件恢复冲突阻断全局、同内容外部替换导致持久化身份失配、Project 录音草稿事务升级竞争。前两项 P1，后两项 P2。录音项的 SQL 失败机制已复现，但尚不能断言它就是用户 Windows 现场错误。Office 全模型返回及写事务内整文件 I/O 已确认，交主审合并性能测量，不重复计为独立发现。

验证边界：未修改业务源码，未启动应用，未访问用户工作区数据，未运行 Cargo build/test 或链接项目二进制。执行了两个小型隔离探针：使用生产 fence 的独立 Rust 锁序探针，以及使用实际草稿 SQL 的 Python SQLite 双连接探针。现有测试仅阅读，不能视为本轮通过。没有 Windows 实机或安装包证据。

## 1. [P1] working 路径与版本写入的 fence/File 锁序相反，可卡死关闭与切换

**位置：** [file_working.rs:81](/Users/xuchen/project_mind/src-tauri/src/file_working.rs:81)（81–86，先持有 fence 再执行 DB action）；[db/file_working.rs:253](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:253)（253–255，随后获取 File lease；begin/save/archive 同样如此）；[project_directory_files_restore.rs:324](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files_restore.rs:324)（324–325，先 Project/File lease）及 [同文件:434](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files_restore.rs:434)（随后进入 fence）。另一版本提交入口同样见 [file_versions.rs:1505](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:1505)、[1946](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:1946)。

**失败序列：**

1. B：恢复版本或暂存替换已取得目标 File lease，仍在准备阶段，尚未进入 fence。
2. A：working open/save/status/归档取得 fence 的读锁，随后等待 B 的 File lease。全局恢复扫描也会等待该 lease。
3. C：关闭或切换 Workspace 调用 `invalidate()`，排队等待 fence 写锁。
4. B 准备完毕申请 fence 读锁；在本机 macOS 的写者等待行为下，该读锁等待 C。形成 A 等 B、B 等 C、C 等 A 的环。

**影响：** 文件操作及 Workspace 关闭/切换无法完成。切换在 [lib.rs:418–422](/Users/xuchen/project_mind/src-tauri/src/lib.rs:418) 持有 `current_workspace` 时等待 fence，可连带阻塞需要当前 Workspace 的其他操作。关闭入口见 [lib.rs:490–493](/Users/xuchen/project_mind/src-tauri/src/lib.rs:490)。不要求两个 GUI 编辑器同时保存；后台归档与版本恢复/替换的重叠即能进入这些锁序。

**已考虑的保护：** fence 正确阻止关闭后的新提交，并等待已进入提交的操作；Project→File→SQLite 顺序、独立连接及“不持 File 重入 App 锁”也有价值。但它们未统一 fence 与 File lease 的相对顺序。[workspace_commit_fence.rs:21–43](/Users/xuchen/project_mind/src-tauri/src/workspace_commit_fence.rs:21) 是阻塞式 `std::sync::RwLock`，没有解除此环的超时/取消路径。

**建议：** 统一这些真实入口的锁序，明确 File lease、恢复操作和 lifecycle admission 的边界；不要在持有 fence 时等待一个稍后还要进入 fence 的 File 持有者。若采用先 File 后 fence，须同时保证关闭后不再发生未经 admission 的业务变更，审查现有恢复/journal 写入位置。

**验证：** `/tmp/mind-persistence-review-uo_zy3f2/fence_probe.rs` 直接包含生产 `workspace_commit_fence.rs`，用互斥锁代替 File lease，用通道安排上述三个角色；给关闭线程 200 ms 排队后，1,000 ms 内三个角色均未完成，输出 `BLOCKED: working owns fence/read and waits File; version owns File and waits fence/read; close waits fence/write`。这是生产 fence 的锁级复现，未运行完整应用，也未使用实际 fs2 File lease；不据此声称每种 OS 的 RwLock 调度完全相同。后续应以真实 lease 和 barrier 覆盖 working 操作＋目录恢复/替换＋close/switch 的三方测试。

## 2. [P1] 一个 working journal 遇到外部修改，会阻断其他 File 操作和 Workspace 重开

**位置：** [db/file_working.rs:415–430](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:415) 将目标路径不再匹配 journal 视为恢复错误；[797–810](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:797) 全局恢复遇首个错误立即返回；[file_versions.rs:543–552](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs:543) 在获取请求目标 lease 前先做全局恢复，`file_version_recover_pending` 的 810–815 行包含 working 恢复；[db.rs:387](/Users/xuchen/project_mind/src-tauri/src/db.rs:387) 将此错误直接传播为数据库打开失败。

**失败序列：**

1. GUI 保存先在 [557–563](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:557) 持久化 replacement journal。
2. 外部编辑器此时修改或替换目标文件。随后 [566](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:566) 的提交前校验正确拒绝覆盖。
3. [613](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:613) 无条件进入恢复；目标也不匹配旧状态，恢复失败，journal 留存。此序列无需进程崩溃。
4. 之后打开/保存另一个 File 也先扫描此 journal，因同一冲突失败；重启后 `Database::open` 同样失败。

另一个有效触发是：状态、恢复 BLOB、回执已提交，在清理 journal 前进程退出；外部程序随后修改目标。已提交分支仍在 416 行要求当前路径匹配提交时字节，因此无法仅清理本次已提交操作的遗留物。

**影响：** 一个文件的外部冲突扩散到无关文件及整个 Workspace 可用性；已保存恢复数据和成功回执存在，也可能无法通过正常打开工作区访问。此处确认的是恢复可用性缺陷，不是已证明的字节丢失或静默覆盖。working save 的内部重放还位于全局恢复之后（491–501），不能保证在此状态下取回已有结果。

**已考虑的保护：** identity＋hash 检查、同目录独占移动、目录同步、提交前后校验正确保护未知外部字节；journal 与恢复 BLOB 也保留了修复材料。缺陷在于把“该 File 需要显式冲突处置”升级为所有文件/Workspace 的不可恢复错误。不能通过删除校验或覆盖外部文件修复。

**建议：** 将不能自动解决的外部冲突保留为该 File 的可见恢复状态，允许 Workspace 与无关 File 打开。对于已提交操作，应依据持久化状态和本操作拥有的临时文件确认清理范围，不把外部后来修改目标等同于本次提交未成立。保留外部字节、恢复 BLOB、回执及人工解决入口。

**验证：** 静态追踪了 journal 创建、恢复、全局入口和 DB 打开传播；未注入真实应用故障。已有四阶段 SIGKILL 用例覆盖干净现场的崩溃恢复，不能覆盖“外部修改＋遗留 journal”。主审可用两个临时 File 验证：在 journal 后、首次 rename 前改写 A；断言 B 仍能打开/保存、Workspace 可重开、A 外部字节未改且旧恢复数据可读。再覆盖 commit 后清理前中断及精确请求重放。

## 3. [P2] 外部原子替换相同字节后，目录已接受新身份，working 状态仍永久引用旧身份

**位置：** [db/file_working.rs:158–192](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:158)，特别是 160 行仅在已归档 hash 与 working hash 不同时同步状态；[project_directory_files.rs:1005–1050](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files.rs:1005)，特别是 1034 行接受相同 hash 的新 physical identity，但未同步 working state。

**失败序列：**

1. 曾打开一个目录 File，`file_working_contents` 已存在，`pending=false`，归档与工作内容相同。
2. 外部编辑器通过原子替换保存完全相同的字节，产生新的文件身份。
3. 下一次目录 resolve：`file_working_matches_live`（824–844）发现身份不同、但没有 pending，返回 false。目录 refresh 验证同 hash 后更新目录身份，返回 ready。
4. 实际编辑器接着调用 working open（[ProjectFileContent.tsx:213](/Users/xuchen/project_mind/src/components/document/ProjectFileContent.tsx:213)、[226](/Users/xuchen/project_mind/src/components/document/ProjectFileContent.tsx:226)）。working 初始化因 hash 未变跳过同步，191 行使用旧身份校验，返回 `FileChangedUnregistered`。

**影响：** 本应正常打开、内容未变化的 Markdown/Office 文件无法进入编辑；旧身份存在数据库中，关闭重开应用不会清除它。显式重新登记同一内容也没有同步该 working state。无需未保存修改或异常文件格式。

**已考虑的保护：** 外部身份变化本来应触发重新校验；目录路径已完成 hash、归属、身份及事务检查。问题是目录与 working 两处持久化状态在一次已接受的替换后不一致，不能简单放宽所有保存的身份 CAS。

**建议：** 在无 pending/journal 且已授权接受同内容新身份的路径，持有 File lease，同步或安全失效 working 状态；同时推进 session/revision 语义使旧会话不能误用旧身份。保留历史版本和内容 hash，不制造无内容变化的新历史。

**验证：** 静态调用链确认，未运行 GUI。以同字节临时文件 rename 覆盖已打开过的 File，再 resolve→working open→close/reopen，断言可打开、历史不变、旧会话写入仍受 CAS 约束。

## 4. [P2] 独立 voice 连接使 Project 草稿的延迟事务升级可立即报锁错误

**位置：** [db.rs:1084](/Users/xuchen/project_mind/src-tauri/src/db.rs:1084) 默认 DEFERRED 事务；Project 分支 [1098–1113](/Users/xuchen/project_mind/src-tauri/src/db.rs:1098) 先读项目、后 INSERT；[lib.rs:282–295](/Users/xuchen/project_mind/src-tauri/src/lib.rs:282) 为 voice 使用与普通 DB 不同的连接/互斥锁。`voice/commands.rs:60–83` 和 `voice/runtime.rs:118–126` 的序列化只覆盖 voice 操作，不能排除另一连接的 Record/File 写入。

**失败序列：**

1. 用户点击 Project 内“开始录音”；[voice/runtime.rs:237–247](/Users/xuchen/project_mind/src-tauri/src/voice/runtime.rs:237) 完成存储、采集能力及识别准备后，先创建草稿，再启动实际 capture。
2. 草稿事务执行项目 SELECT，取得读锁。
3. 普通 Record 保存或其他写入连接执行 `BEGIN IMMEDIATE`，取得写入保留锁。Record 的真实入口见 [agent_operations.rs:110–120](/Users/xuchen/project_mind/src-tauri/src/db/agent_operations.rs:110)。
4. voice INSERT 试图从读事务升级为写事务，SQLite 为避免不可解决的互等立即返回 `database is locked`；草稿事务回滚，错误传回“开始”操作，实际 capture 尚未启动。

**影响与限定：** 这是可导致点击开始即失败的真实竞争路径。精确的“先 SELECT 再升级”机制适用于 `RecordTarget::Project`；Workspace 分支首先 INSERT，不能套用这一序列。用户 Windows 故障尚无错误文本、目标类型及部署提交证据，因此本报告不将该机制认定为其唯一/确定原因。存储、WASAPI/麦克风、识别预检也都可能在按钮阶段失败。

**回归线索：** `af8f89597f63816e963282bc6ab78a8e0a465cc1`（2026-10-27，`fix: bound repeated work and assistant resource lifecycles`）将 voice DB 从共享普通 DB 访问拆为独立连接；旧草稿事务结构可追溯到 `49a20bca4deab6f15058281da1564299b92484ca`（2026-09-23）。故障窗口来自并发边界改变，而不是新增 INSERT 本身。后续 `46d53254b865add03f43c784e66e27412ec166dc`（2026-10-28，启动性能修改）不是引入 voice 独立连接的提交，不能仅凭“上次性能改动”归因于它。

**已考虑的保护：** runtime 连接打开已有库、验证当前 schema、启用 foreign_keys；本地所用 rusqlite 0.39 在连接初始化默认安装 **5,000 ms busy timeout**，并非“没有超时”。读事务升级的这个互等不能靠 busy timeout 解决。现有请求重放与 voice mutex 也不能序列化普通连接。普通 Record 原子操作已用 IMMEDIATE 并注释了升级锁风险。

**建议：** 对这个明确要写入的草稿事务，在事务内项目读取之前取得写入资格，例如使用 IMMEDIATE；缩短持写事务的时间。保留草稿/voice_records/recording_sessions 的同一事务及请求幂等，不用吞错或无界重试掩盖失败。

**验证：** `/tmp/mind-persistence-review-uo_zy3f2/voice_sql_probe.py` 从当前 `db.rs` 提取 Project SELECT 与 notes INSERT，使用临时最小表及两个 SQLite 连接：voice `BEGIN DEFERRED`→SELECT；另一连接 `BEGIN IMMEDIATE`→UPDATE；voice INSERT。SQLite 3.51.0、journal_mode=delete、busy_timeout=5000，结果 **0.020 ms 即返回 `database is locked`**。这是实际 SQL 的锁机制复现，不是生产 Rust/Windows 集成复现；该 Python binding 未暴露 extended error code。

**可独立后续子任务（无需阻塞本阶段交付）：** 用现有 native 测试基础/已编译 binary，构造两条生产 runtime 连接，以 barrier 控制 Project SELECT 与另一连接 IMMEDIATE 的交错，调用真实 voice start/draft；记录 SQLite primary/extended code、target、失败阶段与 request ID。加入 Workspace target 对照，确认失败前没有 capture 启动、没有半条 draft，精确重试不会重复创建。再对照用户 Windows 错误及部署提交；无 Windows 运行条件则只交付跨平台事务结论。不要为此在当前磁盘压力下新链接大型二进制。

## Office 打开与跨功能阻塞：交主审合并的确认事实

- 当前工作会话入口 [file_working.rs:104–156](/Users/xuchen/project_mind/src-tauri/src/file_working.rs:104) 先获取完整源文件，再等待 `office.inspect` 返回完整 model，再做源状态复核，最后才返回给界面。清除重复 base64 发生在完整 model 已获取之后；此协议本身没有可用首屏的提前返回点。
- 首次 working 状态初始化 [db/file_working.rs:224–242](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:224) 在 **BEGIN IMMEDIATE 内**校验整文件 hash、读取整文件、写入恢复 BLOB 并提交。仅“打开”也会占 SQLite 写事务，能与录音草稿或 Record 写入互相等待。具体超时概率取决于实际文件、磁盘和调度，未测量，不声称一定超过 5 秒。
- 随后 [276–303](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs:276) 再完整读取、复核、把完整基线写入 session BLOB 并 base64 编码；worker 后 verify 又复核磁盘。应分别测量 resolve、工作内容初始化、session 捕获、inspect、返回模型阶段，不能只测 renderer。
- working 路径使用独立 runtime DB；不能说它整个 `await office.inspect` 都占着主 DB mutex。但初始化确实占 SQLite 写事务，File lease/fence 也覆盖同步准备段。主 DB 的 directory resolve/hash 路径仍应由主审计时。
- Windows 特有额外整读位于 [file_office_read.rs:89–102](/Users/xuchen/project_mind/src-tauri/src/file_office_read.rs:89)：即使文件 stamp 未变，verify 仍重新 checksum。旧的/历史源 Office inspect 路径在 worker 前后验证时会多次读全文件；**当前 `file_working::open` 并不调用这一路径**，不可将其开销重复算到当前工作会话。Windows physical identity 的 `GetFileInformationByHandle` 本身不是另一次全文读取。
- 后续渐进打开应允许首屏/首个 sheet 的必要数据先返回，并让未加载部分继续由完整、不可变的原始源包托管。保持固定 session 基线、累计 edits、CAS 和提交回执；“只序列化已加载页面/工作表”会破坏完整保存。验收必须保存后重开并检查从未加载的页面/sheet、公式、媒体、关系及其他 OOXML 条目。性能数字和可见首屏验收由主审提供。

## 已核对的保障及未确认的问题

Record 的 `record_document_service.rs:724–818` 在转换前检查 intent replay/base revision，跨 worker 后取得 submission lock 并重新授权；`db/record_documents.rs:1494–1675` 将 body/metadata、版本、回执及 outbox 放在原子操作内，以 CAS 控制更新。外部修改/恢复路径还会 flush 编辑器并重新检查。没有从本轮证据证明“block Record 保存普遍失败”来自缺少这个事务或缺少 CAS，不能把用户报告直接归为数据库损坏。

Record worker 有并发/载荷/时限预算；部分错误包装削弱了 SQLite 原始错误信息。下一步只需捕获真实失败的 request ID、阶段、错误 code/message、内容大小和是否并发保存，再按实际分支复现；不要先扩展通用重试机制。此工作与前端 reviewer 的保存队列/会话协调证据合并。

已检查 runtime connection PRAGMAs、schema 快速路径与 voice 表迁移：foreign_keys 在主连接与 runtime 连接启用；未发现生产代码将 journal_mode 改为 WAL 的配置，相关并发探针使用默认 DELETE；当前 schema 的快速返回与旧版本升级路径未确认有漏建 voice 表。`open_runtime_connection` 的根目录 canonicalize 与 SQLite NOFOLLOW 边界有明确实现；未确认 Windows 路径新回归。不对没有环境的 Windows 文件系统/杀毒软件/WASAPI 行为作结论。

还需区分无 journal 的“已有 pending GUI 内容＋外部修改”恢复体验：归档要求当前盘面匹配，reconcile 又要求已归档；本轮不再扩展独立发现。主审若覆盖该冲突场景，应确认用户能取回两份内容并完成明确选择，而不只是收到永久冲突提示。

## 阅读范围与验证记录

生产代码按相关调用链阅读，非声称逐行审计整个项目：

- File working：`src-tauri/src/file_working.rs`、`file_working_commands.rs`、`db/file_working.rs`、相关 working DTO/命令调用。
- 文件写入/历史：`db/file_versions.rs`、`file_version_service.rs`、`file_text.rs`、`file_office.rs`、`file_office_read.rs`、`file_content.rs`、`source_file_snapshot.rs`、`office_worker.rs`。
- 目录与切换：`db/project_directory_files.rs`、`db/project_directory_files_restore.rs`、`workspace_commit_fence.rs`、`lib.rs` 中 runtime/关闭/切换、DB host/commit 调用点；`ProjectFileContent.tsx` 的 resolve→open 调用。
- Record：`db/record_documents.rs`、`record_document_service.rs`、`record_document_commands.rs`、`record_document_worker.rs`、`record_editor_coordination.rs`、`db/agent_operations.rs`。
- Voice/数据库：`db.rs` 的 open/runtime/migrate/voice draft 与相关 voice persistence，`voice/commands.rs`、`voice/runtime.rs`、`voice/capture/windows.rs`、runtime 初始化调用；本地 rusqlite 0.39 的连接默认 timeout 与 transaction behavior；相关近期 git log/diff。
- 测试阅读：working 重复保存/CAS/重放/旧数据迁移/外部冲突/四阶段 crash，File 版本恢复与 fence、Record 原子回执/outbox 和 service 切换竞争用例。未重新运行这些测试。

本轮执行：只读源码/文档/git 查询；小型 standalone `rustc` fence 探针（生产 fence＋替代 File 互斥锁）；Python 临时 SQLite 双连接探针。探针都在 `/tmp/mind-persistence-review-uo_zy3f2/`，没有连接项目用户数据库。报告中的复现与未测项已分别标注。主审可直接合并本报告并继续其已安排的隔离 native GUI/性能验收，无需等待本 reviewer 扩展检查。

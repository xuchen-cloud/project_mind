# 包 C：File 边界与目录发现

基线：`5de9a91`；共享分支 `fix/performance-review-20261027`。关联 #185/#114/#192/#271，输入为两份 performance-audit 与 github-review-followup 的 R02/R05/R06。主 agent 统一整合、编译、验收和提交；本包没有 commit/push 或启动应用。Cargo 在主 agent 明确协调后作为唯一 runner 运行针对性测试。

## 范围与验收

- 依赖既有 File/Version 表、物理身份、不可变快照、Project/File 锁、事务 CAS 和 #271 原生通知发现。
- 交付：首快照前身份变化保留确认；共享导入名校验；确定性移动失败；跨页保留枚举位置；路径/身份索引；原生事件按路径发现；空目录变更通知。
- 非目标：Office 字节读取/计划函数、db.rs、前端、全量 Rust 构建及其它包。Office 读取区域由主 agent 独立修改。
- 验收：version 0 替换、恢复预算、v1 原子替换/历史保留；失败无元数据或 pending intent；剪贴板排除名无落盘或业务残留；真实目录枚举与身份读取预算；游标归属/模式/取消/重复消费；跨页原生事件和目录 dirty 提示。

实际文件：`src-tauri/src/db/project_directory_files.rs`、同目录 `project_directory_files_tests.rs`、`file_imports.rs`（内嵌测试）、`src-tauri/src/project_file_maintenance.rs`。没有独立 `project_file_discovery.rs`。

## 行为

### R02/R05/R06

- 自动接纳物理替换要求已有独立、有效 hash、实际存在的 immutable head；v0/缺失 head 继续检查已记录物理身份。publish 在快照前及捕获后核验，refresh 同样核验。
- 原物理文件缩小至预算内可以形成 v1。v0 Project Directory File 明确选择 replacement、通过原版本 CAS 后可以形成 v1；其它 legacy registration/location 规则保留。
- 移动测试使用线程局部一次性失败注入，在 move intent 和 metadata intent 持久化后、系统调用边界失败；原断言继续要求不重试、不应用收藏/标签、不残留 intent。原 Windows delete-share 真失败测试保留。
- 共享 `file_import_commit_inner` 在任何恢复/落盘前拒绝隐藏或临时业务名。剪贴板 `capture.tmp`、`~$capture.png`、`Desktop.ini`、`.capture.png` 拒绝，正常图片继续导入；managed note image 不经过该边界。

### 扫描和身份预算

- 原生 ReadDir、每帧至多 128 个缓冲项跨页保留。单页实际读取至多 128 项，File 数和快照字节预算继续独立生效；达到字节预算的 File 放回缓冲，不丢失。
- 游标绑定 workspace/project、起始子树、扫描模式及消费序号。取消不读取并可恢复。完成释放会话；维护 scope 删除、根失效和工作区代次重置主动释放。全局最多 64 个会话，10 分钟无消费的租约在后续扫描准入时清理；容量/租约失效显式报告，维护驱动重新排队。
- 宽目录按原生枚举位置分批，各批使用 UTF-8 顺序；不再依赖跨页的全目录名称排序。File 列表自己的排序不变。
- 普通单链接、已记录 ASCII 路径通过 NOCASE 路径和 physical_identity 索引查候选，不逐个打开其它已登记 File。真实硬链接仍检查全部实时路径；Unicode 拼写/规范化别名及缺身份 legacy 子集仍核验实时身份，保留外部 atomic replace 后的真实归属。这些必要子集可能仍较大，不能声称所有 Unicode/硬链接场景的登记为常数成本。
- 明确文件事件只检查对应路径，目录复制扫描对应子树。队列合并同路径和子树，最多 256 个路径；根变化、事件丢失/需重扫、队列溢出保留完整扫描。扫描期间的新事件留待后续处理；静态目录无周期文件树重扫。
- 维护错误按实际受影响子树更新，保留其它路径的跨页/跨轮去重和恢复后重新报告。

### 与包 D 的接口

已通知包 D：原生事件 `mind:project-directory-dirty`，payload：

```json
{"binding":{"workspaceId":"…","generation":"…"},"projectId":null}
```

`projectId` 为 number 或 null；`relativePaths?: string[]` 是受影响目录的精确 branch，空字符串仅表示根 branch；文件内容/size/mtime 变化仅指向父目录，目录创建/删除/rename 包含目录与父目录。root、原生需重扫、或同 scope 合并超过 256 目录时省略字段，才表示全 scope。full 不被后续 narrow 提示覆盖。watcher 合并同 scope 提示，维护循环在 `with_current` 返回、释放 DB/Workspace 锁后 emit。空目录创建/删除可产生提示，无需 File committedChanges。D 负责前端监听、binding/scope 隔离、隐藏不查及合并失效。

## 验证证据

1. 修改前先写 R02/R05/R06 回归。`python3 $TMPDIR/perf-c-red-probe.py` 的四项静态门槛先全部失败，修复后全部通过。它证明相应保护/保留枚举结构的缺口，**不替代数据库端到端红例**；Cargo 由主 agent 集中负责。
2. 从生产 `ScanFrame::fill_batch` / `physical_alias_possible` 原样提取到独立 `$TMPDIR/perf-c-native-harness.rs`。命令：`rustc --edition=2021 --test $TMPDIR/perf-c-native-harness.rs -o $TMPDIR/perf-c-native-harness && $TMPDIR/perf-c-native-harness --test-threads=1`。3 通过：1000 条目实际读取恰为 1000、8 页、每页最多 128；小目录非 BMP UTF-8 顺序；真实 hard-link 前后别名分支。耗时约 0.09 秒，只有 harness 未读字段警告。
3. 四个修改的 Rust 文件通过 `rustfmt --edition 2021 --emit stdout --config skip_children=true <file>` 语法解析；未整体格式化共享文件。
4. `git diff --check -- src-tauri/src/db/project_directory_files.rs src-tauri/src/db/project_directory_files_tests.rs src-tauri/src/db/file_imports.rs src-tauri/src/project_file_maintenance.rs` 通过。

### 待主 agent 集中执行的真实数据库/驱动用例

- `db::project_directory_files::tests`：包含 600 项总枚举次数恰为 600、单页 <=128、取消读零项；单文件事件读零目录项；200 项真实登记不打开其它既有普通 File；索引 query plan；跨 scope/mode/replay；v0/硬链接/大小写别名。
- `db::file_imports::tests`：剪贴板排除名及成功/失败/崩溃恢复既有组。
- `project_file_maintenance::tests`：事件合并、空目录提示无业务写入、原有跨页变更/静态无重扫/错误恢复/代际/归档。

源码已通知可集中编译，实际 Cargo 结果待主 agent 更新统一验收记录。Windows Job/进程资源属于后续 G1，不混入本包。


## 集中验收反馈修正

- 主 agent 首轮目录组 75 通过、1 失败、1 ignored。唯一失败依赖“150 空目录恰好两页”旧预算假设；新枚举预算允许第一页读满根目录批次后再处理子目录。改为最多四页，逐一核对根及全部 150 子目录各打开一次、总读取 150。`CARGO_INCREMENTAL=0 TMPDIR="$TMPDIR" cargo test --manifest-path src-tauri/Cargo.toml --lib -- directory_scan_yields_on_directory_only_trees directory_scan_wide_directory_has_a_real_enumeration_budget_and_reads_once`：2 通过（0.17s），日志 `$TMPDIR/mind-files-C-directory-budget.log`。其余 75 项结果复用。
- 主 agent 首轮 imports 14 通过、1 失败、1 ignored。失败是新夹具在提前拒绝后查询尚未创建的 directory 表；夹具显式 `directory_schema()` 后继续核对零残留，生产校验顺序不变。待单项复验。
- 主 agent 首轮 maintenance 10 通过、1 失败。定点发现先校验业务名，导致删除非法反斜杠目录时仍返回旧非法路径错误。修正为先证明 scope containment/无 symlink，再判定实际缺失并清除该子树旧失败；存在时仍执行完整 business_path。保留恢复后再发生应报告 6 次的原断言，待单项复验。
- C/D 联动新增受影响目录 payload、同 scope 256 路径预算及精确 branch 合并回归；待集中编译验证。不重复无关已通过组。


## 最终定向验收补充

- `$TMPDIR/mind-C-G1-G2-targeted.log`：剪贴板排除名、三个 dirty paths/空目录回归均通过；DSH 和其它包独立记录结果。其余首轮目录75、导入14、维护10的无关通过证据复用。
- `$TMPDIR/mind-C-maintenance-recur.log`：maintenance 复发报告原断言 `6` 单项通过，并新增删除后 `errors.is_empty()`。上一轮未通过还因测试 helper 只等“一个逻辑扫描结束”，局部发现现在可能有多个排队路径；helper 改为固定512步内等当前项目 cursor **且 pending 队列全部排空**，没有放宽6次断言或无限循环。

### ReadDir 深度与 FD 边界复核

主审发现旧版256深度×64 lease最坏16,384个目录FD，且Unix `DirEntry` 缓冲本身会保留 FD。先将生产 `ScanFrame` 提取到 `$TMPDIR/perf-C-scan-fd-red.rs`：`rustc --edition=2021 --test $TMPDIR/perf-C-scan-fd-red.rs -o $TMPDIR/perf-C-scan-fd-red && $TMPDIR/perf-C-scan-fd-red --test-threads=1`。真实系统 FD 目录（根目录下的 `dev/fd`）红例显示40个已经枚举完的帧仍保留40个FD。

修正保持原DFS/跨页枚举结构：缓冲仅保存owned名称和类型，不保存DirEntry；EOF立即关闭ReadDir。深度仍最多256，单帧128名称预算保留。实际打开的目录句柄每scan最多32、进程全局最多128，以RAII原子permit计数，失败/完成/丢弃cursor均释放。达到FD预算返回含具体路径的 `scan_fd_budget`，废弃该cursor并释放全部帧，不能当成complete，也不静默漏分支；调用方可在其它scan结束后重新开始，或选择更窄subtree。极端连续32层仍未枚举完的宽祖先需要更窄子树扫描；没有引入磁盘spool或重写遍历框架。普通深链不因已耗尽的祖先占FD，新增80层、每层有隐藏兄弟的完整遍历回归。

新增验证核对真实owned目录FD（Darwin F_GETPATH/Linux dev fd链接，仅统计本夹具目录，避免并行DB句柄干扰）、32句柄明确拒绝与释放、超预算cursor清理及80层全部路径与精确161次枚举；`CARGO_INCREMENTAL=0 TMPDIR="$TMPDIR" cargo test --manifest-path src-tauri/Cargo.toml --lib -- directory_scan_exhausted_buffers_release_real_directory_fds directory_scan_open_fd_budget_fails_explicitly_and_releases_frames directory_scan_deep_tree_preserves_all_paths_with_bounded_open_fds directory_scan_fd_budget_aborts_cursor_without_retaining_partial_frames directory_scan_yields_on_directory_only_trees directory_scan_wide_directory_has_a_real_enumeration_budget_and_reads_once driver_reports_each_persistent_directory_failure_once_across_pages_and_scans`：7/7通过，0.66秒；日志 `$TMPDIR/mind-C-scan-fd-budget.log`。


缓冲表示变化后，复用同一个 `src-tauri/target/debug/deps/project_mind_alpha_lib-6aafc0ef157e3747 --test-threads=2` 补受影响16项：恢复/取消、UTF-8排序、单事件零枚举、不饿死后续文件、游标scope/mode/replay、DS_Store/原生hidden/temporary的显式与自动扫描，以及原生mid-scan事件、初始分页后静态无重扫、catalogue、copied folders与reopen。16/16通过，4.02秒，日志 `$TMPDIR/mind-C-scan-fd-related.log`。本轮Cargo已结束，无全量验证；C源码冻结等待主整合。

# G3：Source 固定文件快照与提取结果复用

基线 `5de9a91`，分支 `fix/performance-review-20261027`；共享工作区，不提交。关联 #112 / #114、性能审计 expanded E06/E07。遵循 ADR-0003 / ADR-0009 的已提交内容、授权及原生资源边界。

## 范围、依赖和验收

- 交付：同一 Workspace 代次、实际 ObjectRef、固定版本、注册哈希、路径和格式的连续/并发分页复用已验证快照；搜索各 hit 复用小型文件校验凭据；相同输入及解析器身份共享提取结果/在途任务。
- 依赖：现有 Source DB 授权规划、文件注册哈希、Unix 文件身份/ctime 校验、固定 Node/解析器资源校验；每次调用仍执行授权及代次/版本复核。
- 非目标：Office 文件读取内核、PPT、renderer capability、后台常驻 PDF worker；不删除 Windows 的逐次全量重哈希。
- 验收：100 页稳定输入只读/哈希一次、提取进程一次；同大小修改且恢复 mtime 不能命中旧数据；撤权/代次/版本变化不得发布旧结果；缓存容量有限，关闭释放，旧在途请求不能重新填充。
- 验证范围：文件内核/缓存的定向 Rust 回归、真实 AppSourceUtility wrapper + 固定 Node/PDF worker 实验；DB/GUI/CLI 集成回归由主 agent 串行 Cargo 执行。本包没有 Cargo 并发、应用窗口或全量测试。

## 文件与行为

| 文件 | 行为 |
|---|---|
| `src-tauri/src/source_file_snapshot.rs` | 在授权 DB 阶段登记代次令牌；按完整 FileReadPlan 合并捕获。Unix 同 stamp 复用不可变 Arc，Windows仍重新读/哈希。搜索保留不含正文的凭据，正文被逐出后仍免重复哈希。UTF-8 校验、字符总数及每1024字稀疏索引只构建一次。 |
| `src-tauri/src/file_source_read.rs` | 原始 UTF-8 分页接入快照/索引；保留 GUI 历史与其它调用当前版本的不同授权规划及最终文件/DB复核。 |
| `src-tauri/src/source_service.rs` | 提取按完整计划、代次和版本化解析器身份共享；不同请求仍分别授权。错误共享给当前等待者，随后移除，允许显式重试；不缓存 failed 状态。更新 File policy 和规划失效时清理。搜索接入小型凭据。 |
| `src-tauri/src/source_file_read.rs` | 消费共享不可变提取数据；分页/定位/覆盖率原契约保留。 |
| `src-tauri/src/source_extraction_worker.rs` | 已完整验证的资源根最多2个。Unix复用各文件的 dev/inode/mtime/ctime/size证明及目录非链接校验；资源变化重新执行原完整 Node/entry/manifest/all assets哈希。Windows保留每次完整资源哈希。解析器身份包含实际资源路径和runtime/manifest指纹。 |
| `src-tauri/src/agent/bridge/dispatch.rs` | 仅 AppSourceUtility：真实 CLI/MCP 先在 blocking 线程准备已验证 worker，SourceService直接使用该worker身份和请求，避免默认 identity=None 和二次构造。 |
| `src-tauri/src/lib.rs` | 仅增加3处非voice调用：切换、关闭、退出时 `clear_file_caches(binding)`；其余改动属于主 agent/F。 |

### 资源预算与生命周期

- 快照：128 entries、256 MiB保守预留配额、60s查找时空闲逐出。PDF预留 `2×实际长度+1MiB`，文本预留 `3×实际长度+1MiB`；格式上限仍分别为50MiB、10MiB，涵盖读取Vec增长、UTF-8副本及稀疏索引；配额随Arc存活。捕获在spawn_blocking内部持有配额，取消await不提前释放。
- 提取：4 entries/在途结果槽，每个序列化结果最多16MiB，最多64MiB序列化数据预算；配额随结果Arc存活，逐出/关闭不提前归还仍被使用的槽。此数字不等同实际JSON对象堆/RSS，worker本身仍沿用512MiB堆和原输入/响应限制。
- 原生关闭主动删除对应快照和提取条目，不依赖60s后再lookup。代次令牌在授权锁内登记；关闭使令牌失效，快照已被LRU逐出但Arc仍存活时也失效；关闭后旧请求不能插入新条目。已在途OnceCell可完成，但结果只随旧调用存活，最终DB复核仍拒绝失效请求。
- 公共解析器资源缓存与Workspace正文无关；最多2个资源根，保存路径/文件证明和worker配置，不持有解析子进程或Workspace内容。

## 定向回归与测量

先用仍直接capture的实现执行100页Arc复用回归，复现失败，再实现缓存。补充关闭竞态回归：移除LRU条目、保留快照Arc、关闭Workspace，旧实现仍把快照视为active；修复后拒绝旧代次。

为遵守Cargo串行协调，使用现有 `src-tauri/target/debug/deps` 的rlib，以 `rustc --edition=2021 --test` 编译 `$TMPDIR/perf-g3-full-harness.rs`。该harness直接包含生产快照、提取缓存、worker、utility_process、node_paths和AppSourceUtility实现；仅替换AppHandle资源目录解析和不参与用例的类型/DB外围，不打开Tauri。构建脚本为 `$TMPDIR/build-perf-g3-harness.py`，wrapper实验为 `$TMPDIR/perf-g3-actual-wrapper-test.rs`；这些临时文件未加入产品。

已通过：

- `python3 $TMPDIR/build-perf-g3-harness.py`：编译通过，两个不存在的Result::is_err_or均已改为map_or。
- `$TMPDIR/perf-g3-full-harness source_file_snapshot --test-threads=1`：7/7。覆盖原捕获完整性、预算/非regular路径、canonical身份、100页复用、并发捕获、正文逐出后100次search proof不再读文件、Unicode稀疏索引、同大小+恢复mtime变更、关闭后拒绝填充。
- `$TMPDIR/perf-g3-full-harness extraction_cache`：5/5（并行runner也通过）。覆盖并发+100页调用一次、版本/代次/parser失效、失败共享/重试、容量/空闲逐出、关闭期间在途不回填且配额直到结果释放才归还。计数回归用测试专用gate隔离固定进程预算。
- `$TMPDIR/perf-g3-full-harness source_runtime_cache --test-threads=1`：1/1。101次准备资源仅哈希Node和字体各1次；字体同大小修改并恢复mtime后拒绝，触发完整验证。
- `$TMPDIR/perf-g3-full-harness actual_app_source_utility --test-threads=1 --nocapture`：1/1。真实AppSourceUtility准备路径、真实固定Node和`simple.original.pdf`，100次请求实际 **文件读/哈希1次、PDF进程1次、Node全量哈希1次**。实验包含逐次元数据校验和最终文件验证，未将Counter视为真实wrapper验证。单次观测5.49s，包含首次debug Rust哈希和共享工作区负载，不作为p95/速度提升声明。
- `git diff --check -- <G3文件>`：通过。

## 主 agent 串行验收与具体遗留

尚未运行Cargo，也不声称完整DB/adapter集成编译已通过。建议主 agent在其它包就绪后串行运行：

```sh
cargo test --lib source_file_snapshot -- --test-threads=1
cargo test --lib extraction_cache_tests -- --test-threads=1
cargo test --lib source_runtime_cache -- --test-threads=1
cargo test --lib db::source_files::tests -- --test-threads=1
```

最后一组已有真实业务回归覆盖每页授权、binding/policy/bytes/version在异步期间变化、Unicode续页、PDF覆盖、索引搜索及固定worker。原始文本分页相关File Source Read回归也应随受影响范围纳入。

明确保留：

1. Windows文件和资源仍逐次完整重哈希；仅版本化提取结果复用。没有把可恢复mtime/size当Windows内容证明。
2. SourceFileRead目前每页仍从共享Value反序列化并重建text locations/projection；本包移除了磁盘读取/全量哈希/独立PDF进程重复，尚未量化这部分投影CPU或设计新的分页数据模型。
3. 60s为空闲lookup逐出，非周期定时器；Workspace关闭/切换/退出已主动清理。公共资源身份缓存最多2个且不含Workspace正文。
4. 未测量真实CLI/MCP端到端授权与DB耗时、长期峰值RSS、p95；临时harness AppHandle仅负责真实资源路径，不能代替主 agent的Cargo业务集成门槛。

G3代码就绪，待主 agent统一Cargo。未编辑主执行记录、未提交/推送。

## 主 agent 整合补充

真实库集成揭示测试间复用 Workspace 身份和小 PDF 预留最大格式容量两项问题。夹具改为独立 Workspace；生产捕获按 metadata 的实际长度预留，并将捕获读取上限绑定到该长度，增长或内容变化继续拒绝。正文被逐出时单独保留验证凭据，测试不再用无关全局配额压力模拟逐出。新增16个小PDF同时驻留和捕获中增长的预算回归。

`CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --lib -- source_file_snapshot db::source_files::tests extraction_cache_tests --test-threads=2`：26通过、0失败、1个原有环境忽略（日志 `$TMPDIR/mind-final-source-budget.log`）。最终全库结果见统一执行记录。

## 全库并行验收后的 Node 夹具隔离修正

主 agent 的全库日志 `$TMPDIR/mind-final-rust-full.log` 中，三项 Source 用例在 `SourceExtractionWorker::bundled()` 返回 `RuntimeUnavailable`，另一个相同打包资源用例通过。检查发现本文件两个测试把打包 Node 硬链接到临时目录；创建与清理链接都会修改原 Node inode 的 ctime，与其它测试的哈希前后 FileStamp 校验存在竞态。所有匹配共享 Node 的硬链接均来自这两个夹具。

仅修改 `src-tauri/src/source_extraction_worker.rs` 的测试区域：两处统一使用 `fixture_node` 复制 Node，确保独立 inode。新增 `source_runtime_fixture_does_not_change_shared_node_identity_or_stamp`，使用私有模拟资源调用同一夹具构造函数，断言 inode 独立、内容一致、创建和删除后原文件 FileStamp 均不变。生产 `verify_hash`、ctime/mtime/身份校验及缓存逻辑保持不变。

验证未使用 Cargo：

- 旧硬链接实现下，`$TMPDIR/perf-g3-full-harness source_extraction_worker::tests::source_runtime_fixture_does_not_change_shared_node_identity_or_stamp --exact --nocapture`：确定失败，夹具与原文件 inode 相同。
- `python3 $TMPDIR/build-perf-g3-harness.py`：修复后独立 rustc 编译通过。临时 harness 增加主 agent 新预算测试所需 rand rlib，未修改该生产文件。
- `$TMPDIR/perf-g3-full-harness source_extraction_worker --test-threads=8 --nocapture`：8通过、0失败，9.88s；真实打包 Node 并发构造、两个复制/篡改夹具、100次资源缓存复用、工作区并发和超时重试均通过。日志 `$TMPDIR/perf-g3-node-isolation-green.log`。
- `git diff --check -- src-tauri/src/source_extraction_worker.rs docs/implementation/perf-package-G3-20261027.md`：通过。

测试源码已冻结并通知主 agent。完整库业务路径（含原 project_file_maintenance 失败用例）由主 agent 串行 Cargo 定向复验；独立 harness 不替代这一验收。未改主执行记录、未提交。

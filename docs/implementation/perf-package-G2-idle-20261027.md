# G2-idle：非语音空闲维护

2026-10-27，共享分支 `fix/performance-review-20261027`，接手 A 的 idle WIP。关联首轮性能审计「P2 空闲维护仍周期性查库与轮转」（checkpoint 1s、Source 500ms、Overview 2s）；复用原有 durable queue、Scope/Workspace 身份、CAS 与恢复契约。

## 范围与验收

- 已与 A 确认移交 `source_maintenance.rs`、`overview_maintenance.rs`、对应 tests 及 `lib.rs` 的 checkpoint loop/helper/tests；A 保留 Skills 生命周期接点。
- 交付：独立维护通知、持久化 deadline 唤醒与低频校准；空闲无任务不继续高频 SQL；提交/任务控制/模型可用性变化/Workspace 生命周期及时唤醒；通知风暴保持原有工作频率预算；失败重试与崩溃恢复保持。
- 非目标：Voice、Skills/schedules、Office、Source byte cache；不启动应用/外部模型，不提交、不推送、不跑全量。后续主 agent 另授权 F 作为 lib 退出流程 owner 整合 A/C 的 shutdown lease，记录见下。
- 验证接缝由主 agent 本包指令给定：空闲循环/SQL 计数、通知后真实任务推进、下一 deadline、恢复与取消；沿用 TDD 逐项红绿，定向 Cargo 与 A/E 串行。
- 主 agent 已明确授权 `db/source_maintenance.rs`、`db/record_documents.rs` 的必要只读 helper 和 `agent/commands.rs::agent_settings_update` 成功通知接点；相关依赖已解除。

## 接手基线

A 已实现 30s 校准、Notify 独立实例、mind:changed/record:head-changed listener、显式 control 和 Workspace 生命周期 wake；Source step 成功后500ms，否则看 selected scope/progress；Overview 用 schedule/status 遍历最近 due；checkpoint 用首个 pending+head 获取 due，醒后固定 sleep1s。

A 的 source 定向 `source_maintenance::tests` **11 passed**，日志 `$TMPDIR/perf-g2-source.log`；quiet wake 红例在500ms失败，改30s通过。Overview/checkpoint新增用例未验收，不能当作完成。A 原独立记录保留 Skills/schedules，不覆盖。

## 实施与验证

实现与定向验收完成，等待主 agent 统一整合、自审和全量验证。无本包实现阻塞。

### 已实现

- 从 Source 抽出 `maintenance_wake.rs` 复用 Notify 原语；Source / Overview / checkpoint 各自持有独立实例，不互相消费通知，不复用 Voice 通道。
- `wait_after` 按上次扫描开始时刻维持500ms / 2s / 1s最小频率，合并提交风暴；已过最小间隔的 deadline 唤醒不再次付出固定冷却。替代 checkpoint 原来醒后固定多睡1秒的实现。
- 保留既有 committed events、显式 control、Workspace 生命周期 wake；增加 `agent_settings_update` 成功后 Source/Overview wake，以及 `lib.rs` 的模型 profile upsert/delete、binding upsert 成功后唤醒 Overview。读操作、轮询及失败设置写入不发这些通知。ADR-0011 下已无独立解锁命令，成功打开 Workspace 即携带本地密钥并通知。
- `source_maintenance_wake_at` 是只读调度 hint：遍历 Workspace + 全部活跃 Project，遵守当前设置和各 scope 的显式暂停；读取 queued `not_before`、全 Workspace extraction 的单一 running lease、maintenance reservation generation/expiry 以及1200秒配额周期。旧 generation 立即可恢复；同 generation 保留到期与累计 charge；reservation 清理早于较晚 quota reset。真正 claim、fair cursor、quota/reservation accounting、CAS/崩溃恢复仍由原有事务方法执行。
- 普通 pending 在未来到期时等待真实 deadline，不再一概500ms。实际 ready/backfill/log backlog 保留500ms下限；真实前台占用保留 readiness cadence；无 runnable work 使用30秒低频校准。Overview 同样遍历全部活跃 scope，以最近 schedule deadline 安排等待；已取消/失败或全为 deferred parent 的 pending 不视为可立即执行。
- `record_next_checkpoint_at` 只读最早 `checkpoint_due_at`，不读取 document_json/html/markdown/text；用 `julianday` 比较 RFC3339 的真实时刻，支持不同 offset。损坏/缺失 deadline 显式报错；真正 checkpoint 仍验证正文完整性。定时唤醒使用1秒频率下限，不再醒后多睡固定1秒。
- Source 真实存储访问计数回归已通过：先实际排空索引队列，空闲650ms **0 个新增 storage visits**；通知后遵守500ms最小间隔，900ms验收预算内索引新 Todo，并通过真实 search 看见结果。独立等待回归观察到空闲仅1次扫描、100条通知合并成一次唤醒；不将理论每小时频率当作运行时 SQL 计数。
- 修正 A 未验收的 Overview 空闲夹具：两个启用范围都须完成首轮。原夹具只完成 Project，Workspace 首轮仍有真实工作，因此2s是合理结果；不能将此直接当成空闲扫描缺陷。

### 已运行

- 使用共享 target 已有 tokio rlib，以独立 `rustc --test src-tauri/src/maintenance_wake.rs -L dependency=src-tauri/target/debug/deps --extern tokio=<现有rlib>` 编译，不使用 Cargo。通知预算红例明确 **1 failed / 1 passed**，错误 `notifications bypassed the scan budget`；补最小扫描间隔后 **3 passed / 0 failed**（0.12s），二进制 `$TMPDIR/perf-g2-idle-wake-tests`。
- 复用 A 最新库测试二进制 `project_mind_alpha_lib-0e56e54263652e15`：旧 Overview 夹具 **1 failed**（实际2s，期望30s），日志 `$TMPDIR/perf-g2-idle-overview-red.log`；原 checkpoint 测试 **1 passed**。修正夹具后最终已通过。
- `rustfmt --emit stdout --config skip_children=true src-tauri/src/lib.rs` 语法解析通过；`git diff --check` 通过。
- 初期 A 最新补充 Skills 回归编译遇到共享 DSH WIP：`dsh_assistant.rs` 引用尚未声明的 `crate::dsh_process`，日志 `$TMPDIR/perf-g2-skills-final.log`。本包没有为相同未完成依赖重复 Cargo；C 补齐后由 C 单 runner 执行红例，再明确交 F。
- C 的实际 Source deadline 红例 **3 failed**：重试提前8.5秒、仅 selected scope 漏掉其它 scope、reservation expiry 未安排；日志 `$TMPDIR/mind-C-G1-G2-targeted.log`。checkpoint 红例明确选错 offset 时刻（00:00Z 而非前一天17:00Z），日志 `$TMPDIR/mind-C-maintenance-recur.log`。均保留失败测试后修实现。
- F 首轮定向 `$TMPDIR/mind-G2-idle-filtered_tests.log`：25 passed / 1 ignored / 1 failed。失败是新 checkpoint 夹具写非法 JSON 被 `json_valid` 数据完整性约束拦截；将夹具改为合法 JSON 的损坏文档结构 `{}`，保留实际封存必须拒绝损坏正文的断言，没有放宽约束或吞错。

### 最终验证命令与结果

```sh
CARGO_INCREMENTAL=0 TMPDIR="$TMPDIR" cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -- maintenance_wake:: source_maintenance:: overview_maintenance::tests::completed_and_cancelled_overview_work_sleeps_until_event_or_schedule checkpoint_idle_tests checkpoint_deadline_reads_only_metadata skills::tests::failed_shutdown_and_later_exit_failure_restore_real_catalog_admission
```

首轮结果如上。修正夹具后，唯一必要重编译顺带主 agent 指定的 G3 组：

```sh
CARGO_INCREMENTAL=0 TMPDIR="$TMPDIR" cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -- checkpoint_deadline_reads_only_metadata db::source_maintenance::deadline_tests db::source_files::tests
```

日志 `$TMPDIR/mind-G2-idle-recheck-filtered_tests.log`：F 的4项全部通过；G3 组1项并行 active byte/entry budget RunBusy，随后复用同二进制仅隔离失败项 **1 passed**（`$TMPDIR/mind-G2-source-files-isolated-filtered_tests.log`），已交主 agent/E 处理，本包未改 Source cache。主 agent 后续已接手按 actual length 预留配额的新修复与回归，不重复旧组。

最终复用相同二进制，无再次 Cargo：

```sh
src-tauri/target/debug/deps/project_mind_alpha_lib-6aafc0ef157e3747 maintenance_wake:: source_maintenance:: overview_maintenance::tests::completed_and_cancelled_overview_work_sleeps_until_event_or_schedule checkpoint_idle_tests checkpoint_deadline_reads_only_metadata skills::tests::failed_shutdown_and_later_exit_failure_restore_real_catalog_admission --nocapture
```

**26 passed / 0 failed / 1 ignored / 1472 filtered out**，2.91秒，日志 `$TMPDIR/mind-G2-idle-final-filtered_tests.log`。忽略项为既有依赖 prepared fixed Node converter 的 legacy conversion 验收，其余真实 Todo、取消/前台抢占、崩溃 charge、权限和事务回滚均通过。磁盘最后6.1GiB；未自行清理共享缓存。Cargo 已明确释放给主 agent，不再主动编译。

### 退出事务补充

主 agent 审核发现：前一服务 shutdown 成功后，后一服务或最终 voice authorization 报错，应用继续运行但服务准入永久关闭。A 提供 `skills::ShutdownLease`，C 提供 `dsh_assistant::ShutdownLease<'_>`，均在未 commit 的 Drop（含自身错误及 future 取消）恢复准入。

F 在 `lib.rs` 增加窄共享流程 `finish_app_shutdown`：依次取得并保留两服务的 lease，最终 voice authorization 成功后再 commit；app_exit、restart、无 Workspace 的自动 ExitRequested 统一走它。voice closing lease 仍提前阻止新录制，最终授权仍持 voice mutex，exit_authorized 仍仅在最终成功时设置。错误原样返回/发送既有错误事件，不吞掉服务 stop 失败。已关闭的进程无需复活，下次请求按原有路径重建。

A 在实际全局生命周期锁下调用生产 `finish_app_shutdown` 注入后阶段 `late voice failure`：断言原错返回、Skills 实际 admit 恢复、DSH 可再次 shutdown，最终验证已通过。C 自身 stop Err / future 取消 / 成功 commit 的真实状态用例由 C 验证5项通过并复用；不重复其真实8秒进程测试。

### 当前文件

- `src-tauri/src/maintenance_wake.rs`（新增）
- `src-tauri/src/source_maintenance.rs`（接手 A WIP并续改）
- `src-tauri/src/overview_maintenance.rs`（接手 A WIP并续改）
- `src-tauri/src/overview_maintenance_tests.rs`
- `src-tauri/src/db/source_maintenance.rs`（只读调度 hint）
- `src-tauri/src/db/source_maintenance_deadline_tests.rs`（新增真实 durable queue/ledger 回归）
- `src-tauri/src/db/record_documents.rs`（metadata deadline helper 与回归）
- `src-tauri/src/agent/commands.rs`（仅 agent_settings_update 成功通知）
- `src-tauri/src/lib.rs`（维护模块注册、checkpoint、模型配置成功通知、另授权的退出事务整合；保留 A 的 Skills 接点与 F Voice 代码）
- 本记录。

### 自审与剩余项

- 调度 hint 不领取任务、不清 reservation、不重置 charge；真正 Scope/Workspace 校验、fair rotation、CAS、幂等、事务及恢复路径保持。
- 独立 Notify 实例不交叉消费；事件 hint 可合并、不承担 authority，低频校准仍恢复丢失通知与崩溃持久化状态。
- 本包无剩余实现阻塞；G3 并行配额问题由主 agent/E 接手。全 Rust 与最终 Standards/Spec review、提交由主 agent 统一执行。
- 未运行真实设备/外部模型、未启动应用窗口、未创建 agent、未 commit/push，未编辑主执行记录或 A 的 G2 文档。

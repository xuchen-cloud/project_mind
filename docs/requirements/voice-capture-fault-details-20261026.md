# Voice Record 采集故障详情

关联：[诊断工作包 #268](https://github.com/xuchen-cloud/project_mind/issues/268)；原始故障在 [#267](https://github.com/xuchen-cloud/project_mind/issues/267) 继续跟踪。

## 复现事实与范围

用户在 Windows 使用 WeLink Meeting 和 USB 麦克风：先启动会议再开始 Voice Record，不足 3 秒便暂停，显示 `capture_fault`；使用同一软件与麦克风，先开始录音再启动会议则正常。不开会议、或播放视频时开始录音也正常。

尚无复现机器的原生错误。不能据此确认设备占用、驱动模式或时间轴是根因；首包跨越录音起点只是未经证实的假设，本包不调整时间轴。

## 工作包

- 依赖：现有 WASAPI 共享采集、双 Voice Source Track、Recording Session 暂停保存协议；遵循 [ADR-0007](../adr/0007-serialize-voice-capture-into-one-terminal-session.md) 和 [Voice Record 决策](voice-record-decisions.md)。
- 交付：原生错误从采集通道传到暂停原因并持久化；Windows 错误包含音轨、失败的 API 阶段和原始 HRESULT，时间轴错误保留 flags、包帧数、采样位置和 QPC 起点。
- 非目标：改变音频格式、设备选择、共享模式、时间轴或丢帧规则，忽略真实采集错误，降为单轨，自动重试。
- 验收：原生错误与 writer 停止、静音同时出现时不丢详情；健康检查与停止之间才到达的错误在停止采集后再次读取；双轨仍保存，音频写入错误仍优先呈现。

## 实现与已确认原因

此前 `capture_run_faulted` 将原生错误变成布尔值；activity/writer 状态的短路还会阻止读取错误通道。会话因此只保存通用 `capture_fault`，同次出现的静音也可能覆盖采集故障。

运行时现在先读取原生错误，再检查 worker；存储错误、采集错误、静音按现有职责决定暂停原因。Windows owner 在 `run()` 返回后报告错误，音频队列可能先关闭，因此停止并等待采集线程后再次读取，避免这一时序丢失详情。writer 没有上报具体错误时，只描述已观察到的停止状态。真正的写入失败和双轨保存恢复仍走原有存储路径。

Windows adapter 只增加错误上下文和完整错误链输出，保留现有采集判断。诊断内容不包含音频采样值、设备标识或用户文件路径。

## 验证

基线为 `develop` 的 `12d09c43c5c1ca8ee1b831af09e038a1278aec39`，验证覆盖本包两个 Rust 文件。未启动应用窗口。

1. TDD：`snapshot_preserves_native_fault_after_raw_writers_stop` 先失败（实际为 `capture_fault`，预期为具体原生错误），实现后通过。该用例还覆盖静音同时成立、暂停原因入库及双轨完成保存。
2. TDD：`stopping_rechecks_native_fault_after_observing_worker_shutdown` 先失败（仅保留 writer 停止），停止后补读错误通道再通过。
3. `TMPDIR=/private/tmp cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -- voice::runtime::tests`：11 passed，包含写入失败优先级、无详情的 worker 状态、既有暂停恢复与保存重试。
4. `TMPDIR=/private/tmp cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -- voice::capture:: voice::activity:: voice::storage:: db::voice_tests::`：15 passed，2 个既有保存音频回放/测量辅助测试 ignored；`db::voice_tests::` 无匹配项。另用编译后的同一测试二进制运行 `db::tests::voice_session_persists_settings_record_and_revisioned_lifecycle` 与 `db::tests::voice_record_delete_protects_capture_then_cleans_assets_and_rejects_late_text`，2 passed。
5. `TMPDIR=/private/tmp cargo check --manifest-path src-tauri/Cargo.toml --quiet`：通过。
6. Windows adapter 独立交叉编译：临时 crate 通过符号链接引用实际 `capture.rs` 和 `capture/windows.rs`，使用本仓库版本的 anyhow 1.0.102、tokio 1.50.0、windows 0.61.3，`cargo check --offline --target x86_64-pc-windows-msvc` 通过。该检查验证 Windows 代码类型，不代表完整安装包构建或设备验收。
7. 主 agent 完成 Standards / Spec 双轴自查；未启动 review 子 agent。检查错误链、通道与停止时序、保存语义及采集判断未被放宽，无剩余发现。

本包仅修改 Rust 内部错误处理，现有 `pauseReason` 字符串和前端展示协议不变。已通过的采集/存储/DB 验证在后续仅修改运行时错误补读时复用；运行时测试和 cargo check 已针对最终源码重新执行。

## Windows 解锁条件

在包含本包的 Windows 构建中，使用相同 WeLink Meeting、USB 麦克风分别测试两种启动顺序。记录完整暂停原因，包含 `Microphone` / `System`、API / 时间轴错误和数值字段，据此构建实际根因的复现与修复。原始 #267 在该场景修复并经实机验证前保持打开。

# 包 F：原生语音生命周期（2026-10-27）

## 范围与验收

- 关联：#94 / #237；首轮共享锁、字幕重复与 voice idle；扩展 E09 / E10。
- 依赖：ADR-0006/0007/0008；现有 voice runtime、独立 runtime DB 连接、rowid 水位与纪要版本 CAS。
- 交付：录制生命周期仍经单一 voice mutex 串行；模型初始化及排空不持共享 Workspace/DB 锁。纪要随 Workspace 关闭取消模型请求、停止领取，已领取任务回到 pending。空闲 supervisor 减少 DB 扫描，新语音工作主动唤醒。字幕按实际新增音频、带有限重叠识别并合并片段。
- 非目标：前端 Voice、DSH、Office/Source、真实设备或外部模型；不提交、不推送、不启动应用、不跑全量。
- 回归边界：录制命令与 Workspace 身份、纪要请求/取消/恢复/水位、分段预览预算、supervisor 空闲与唤醒。沿用本包已授权接缝，按 TDD 逐项实现。
- 验证协调：主 agent 要求暂停 Cargo，统一编译与定向验证；独立 rustc 不使用共享 target。

## 方案与状态

实现完成，已通过本包定向验证，待主 agent 统一整合。原生 sherpa 1.13.8 的 C API progress callback 明确忽略返回值；Rust wrapper 只有 `process`。无法依靠 callback 中断当前推理，禁止把返回值当取消。主 agent 已明确批准 helper 及必要入口扩展，原范围阻塞已解除。当前使用同一 bundled executable 的 `--voice-diarization-helper` 入口，在 Tauri 初始化前分流，不增加 Cargo binary 或额外分发资源；dev/release/Windows 均通过当前可执行文件定位。

2026-10-27 编译协调：先暂停源码，复用主 agent 的 Office 编译产物；Office 16 passed / 3 ignored，覆盖当时 F 代码。后续主 agent 许可 F 定向，首次 Cargo 因磁盘满写 incremental query-cache 失败（未执行测试、无新增代码错误）；主 agent 清理可重建缓存后，使用 `CARGO_INCREMENTAL=0` 重跑一次成功。没有修改仓库构建配置。

证据：[sherpa 1.13.8 C API](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/c-api/c-api.h) 的 `SherpaOnnxOfflineSpeakerDiarizationProgressCallback` 文档与 pyannote 实现的 `ComputeEmbeddings` 忽略 callback 返回值；本地 registry `sherpa-onnx-1.13.8/src/offline_speaker_diarization.rs` 未暴露回调。

## 当前变更

- Workspace 增加专用 Voice DB runtime connection，并绑定同一权威 Workspace id；`with_voice_db` 只在语音 owner mutex 下短暂验证当前 generation，随后的模型准备、录制停止和排空使用专用连接。
- 切换/关闭在真正移交身份时再次串行验证未结束会话；idle fence 只查询，不触发音频恢复和 join；重复终止请求留下的 ended 内存状态允许清理。
- 纪要 owner 在短锁下将 claim、preview、apply 与 close 线性化；HTTP 使用 async future 接入 watch 取消，包含等待响应头和沉默 SSE；取消 release 仅匹配 job id + started_at lease，不推进 rowid/版本水位。保留 16,000 字符分段、250ms 预览节流、原版本 CAS 与 request key。
- 本地预览按新增音频水位取片段，2 秒新增语音门槛、350ms 上下文重叠、单次最多4秒；文本片段按既有 overlap 规则合并，final Transcript 仍走原完整 utterance。另设 wall-clock / 推理耗时预算，捕获积压时优先 final。
- supervisor 空闲最长30秒维护一次，活跃捕获250ms；新 start/pause/end/配置/手动恢复/说话人job及worker完成主动唤醒，snapshot读取不额外唤醒。恢复按持久化 next_retry_ms 缩短睡眠，保持真实重试时点。
- E09 helper 输入仅 Workspace/cache路径和音频chunk元数据，父进程不读取整场PCM；子进程继续调用一次整场 `analyze_with_embeddings`。当前已有独立Child owner，取消检查25ms，stop执行kill+wait；Workspace关闭/切换/退出同步stop时不持 current_workspace 或共享DB锁。真实子进程取消/回收、全局并发许可、路径 DTO 及入口回归均已通过。
- helper 的 stdin 使用父进程持有的 pipe，`Child.stdin` 随 owner 保留到正常完成/stop。helper 启动阻塞 EOF reader，父进程崩溃/强杀导致 EOF 时直接退出整个 helper，即使主线程正在同步 ONNX 推理也终止；正常返回不等待 reader，主入口直接 process::exit。不使用进程表轮询，Windows 沿用同一标准 pipe。
- 退出/restart 在首次异步 teardown 之前，持 voice owner mutex 取得独立 closing lease 并确认 idle；模型/DSH teardown await 期间 voice 命令拒绝新 start。失败或 future 取消时 lease 自动释放，语音可再次使用；并发退出不能释放其它退出请求的 lease。最终授权仍在 voice mutex 下重查 idle，只在最终成功时设 exit_authorized；RunEvent 无 Workspace 自动退出沿用同一 fence，原有保存门禁保留。

## 已运行验证

- 红例：`rustc --edition=2021 --test src-tauri/src/voice/recognition.rs -o $TMPDIR/perf-f-recognition-tests && $TMPDIR/perf-f-recognition-tests --exact tests::preview_audio_advances_without_replaying_the_whole_utterance`：失败，8秒输入累计预览20,000样本（1kHz测试夹具），超过9,050预算。
- 绿例：同一 rustc 二进制运行分段模块全部5项：5 passed；累计输入不超过9,050，重复水位/短静音不再次预览。
- `rustc --edition=2021 --test src-tauri/src/voice/supervision.rs -o $TMPDIR/perf-f-supervision-tests && $TMPDIR/perf-f-supervision-tests`：2 passed，验证先入队后等待不丢唤醒及空闲等待及时被新job唤醒。独立编译产生未使用常量/入口warning，完整应用中有调用。
- `rustfmt --edition 2021 --config skip_children=true --emit stdout src-tauri/src/lib.rs`：语法解析通过（输出到/tmp，不重写共享lib无关区域）。
- `git diff --check`：通过。
- 初期按主 agent 指令未运行 Cargo；恢复后结果见下节。已新增锁边界、idle只读、重复end、HTTP头/SSE取消、job恢复及rowid/CAS回归。

## 最终定向验证

验证范围固定为 F 当前改动；没有真实设备、外部模型、应用窗口或全量测试。

1. `CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --lib voice:: --quiet`：**91 passed / 8 ignored**，日志 `$TMPDIR/mind-perf-f-voice.log`。包括 helper 真实子进程 kill+wait、CPU 并发1、入口不落入 Tauri、2小时元数据小DTO、空输入无模型返回，以及录制/识别/存储/字幕的受影响模块。忽略项为既有真实设备/模型/下载验收。
2. 复用上述同一二进制 `src-tauri/target/debug/deps/project_mind_alpha_lib-6aafc0ef157e3747`：
   - `db::voice_recovery::tests::`：**5 passed**，包含取消 job 重领、request key、rowid 水位、版本 CAS、重试时间和崩溃恢复。
   - `voice_minutes`：**6 passed**，含等待响应头和活跃 SSE 的取消（同时验证 socket 已关闭）、五节纪要合同、stream preview、迁移、快照替换及21秒长请求。
   - `--exact db::tests::voice_session_persists_settings_record_and_revisioned_lifecycle`：**1 passed**。
   - `--exact db::tests::final_voice_transcript_is_idempotent_scoped_and_pageable_after_session_end`：**1 passed**。
   - `--exact db::tests::voice_record_delete_protects_capture_then_cleans_assets_and_rejects_late_text`：**1 passed**。
3. 编译失败后已对全部 F Rust 文件用 rustfmt `--emit stdout` 检查解析，文件均完整；`git diff --check` 通过。
4. 测试后磁盘可用 **5.8 GiB**；本包没有自行清理共享缓存。

## 主 agent 复核后的生命周期回归

- 父生命周期红例：暂用空 watcher 运行 `killing_parent_ends_helper_without_polling_process_tables`，明确失败 `helper survived its owning parent's forced exit`，夹具在5秒后自行清理。绿例：`rustc --edition=2021 --test src-tauri/src/voice/diarization_parent.rs -o $TMPDIR/perf-f-parent-tests && $TMPDIR/perf-f-parent-tests`，**3 passed / 0 failed**，0.01秒。实际强杀中间 parent，再以 helper 继承的 stdout pipe EOF 证明 helper 已退出；无设备/模型、无高频 ps。
- 退出准入红例：无状态 closing reserve 导致 pending teardown 仍准入及并发退出可取得第二 lease，**2 failed**。绿例：`rustc --edition=2021 --test src-tauri/src/voice/shutdown.rs -o $TMPDIR/perf-f-shutdown-tests && $TMPDIR/perf-f-shutdown-tests`，**2 passed / 0 failed**。另在 runtime 加实际专用 DB/serialized storage 集成回归：等待期间 start 不产生会话，失败释放 lease 后能创建会话。
- 新增修改后的唯一一次共享 Cargo：`CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --lib voice::runtime::tests --quiet`，**15 passed / 0 failed / 1459 filtered out**，日志 `$TMPDIR/mind-perf-f-closing.log`。包含实际 DB 准入恢复回归，已将 AppState early/final lease 接线编译。
- 复用同次库测试二进制 `src-tauri/target/debug/deps/project_mind_alpha_lib-6aafc0ef157e3747`，无再次 Cargo：`voice::shutdown::tests` **2 passed**（`$TMPDIR/mind-perf-f-closing-filtered_tests.log`）；`voice::diarization_parent::tests` **3 passed**，0.02秒（`$TMPDIR/mind-perf-f-parent-filtered_tests.log`）；`voice::diarization_process::tests` **4 passed**（`$TMPDIR/mind-perf-f-helper-filtered_tests.log`）。无失败。helper invalid invocation 的预期错误输出已由用例断言为非 Tauri 分流。
- 此前通过且未受影响的纪要/DB/字幕验证复用，不重复全量。最后磁盘 **3.6 GiB**；没有清理共享缓存或改变构建配置。
- C 协调依赖已解除：C 提供 DSH 可回滚 ShutdownLease，A 提供 Skills 同类 lease。主 agent 后续明确指定 F 统一 lib 退出事务，`finish_app_shutdown` 持有两 lease 到最终 voice authorization 成功才 commit，任一后阶段失败/取消都恢复服务准入；正常 exit/restart 和自动 ExitRequested 共用。真实 Skills/DSH 状态的后阶段错误回归通过（G2 定向26 pass / 1 ignored），详情见 [G2-idle 记录](perf-package-G2-idle-20261027.md)；F 未编辑 A/C 的服务文件。

## 文件清单

- `src-tauri/src/voice/commands.rs`
- `src-tauri/src/voice/contracts.rs`（仅内部 helper 读取 playback chunk 需要的 Deserialize）
- `src-tauri/src/voice/diarization.rs`（结果 DTO 序列化及 callback 限制说明；整场算法保持）
- `src-tauri/src/voice/diarization_process.rs`（新增专用 native helper）
- `src-tauri/src/voice/diarization_parent.rs`（新增父进程 EOF 生命周期及强杀回归）
- `src-tauri/src/voice/diarization_worker.rs`
- `src-tauri/src/voice/live_local.rs`
- `src-tauri/src/voice/mod.rs`
- `src-tauri/src/voice/processing.rs`
- `src-tauri/src/voice/recognition.rs`
- `src-tauri/src/voice/recovery.rs`（完成后主动唤醒）
- `src-tauri/src/voice/runtime.rs`
- `src-tauri/src/voice/shutdown.rs`（新增可释放的退出准入 lease）
- `src-tauri/src/voice/supervision.rs`（新增预算/唤醒）
- `src-tauri/src/voice/transcript_assembly.rs`
- `src-tauri/src/db/voice_recovery.rs`（纪要取消 release/lease、恢复 deadline 与回归）
- `src-tauri/src/ai_provider.rs`（仅 voice minutes 与其请求/取消回归区域）
- `src-tauri/src/lib.rs`（voice 字段/初始化、kick、supervisor、切换/关闭/退出语音 fence）
- `src-tauri/src/main.rs`（批准的 helper 早期分流）
- 本记录。没有修改主执行记录、前端 voice、DSH、Office/Source 或 Cargo.toml。

## 自审、交接与限制

- Standards 自审：共享 DB/Workspace 锁不跨模型等待或进程 join；真正 Workspace 移交与语音命令使用同一 owner mutex；helper 的 wait/error/panic 路径有回收 guard，关闭显式 kill+wait；CPU permit 覆盖子进程整个生命周期，完成后主动唤醒。
- Spec 自审：原始双轨、Transcript、整场聚类、纪要原有分段与 rowid 水位、版本 CAS、request key、录制终止/单所有者和恢复语义保持。取消只重置自己的在运行 job lease，未写入部分最终纪要。
- F 当前没有代码阻塞；退出失败时 DSH/Skills 自身及跨服务后阶段失败恢复已完成协作整合。专用 helper 入口的权限范围已由主 agent 扩展；没有引入新的平台依赖、外部 helper binary 或待复制的 bundle 资源。
- 按分工，最终主 binary 的集中编译、dev/release 打包及 Windows 实机 smoke 由主 agent 统一验收。本包在 macOS 通过真实测试子进程验证执行/取消/回收，未声称已执行 Windows 或 release 安装包验收；真实外部说话人模型保持用户要求的未运行状态。
- 未创建子 agent；未 commit / push；由主 agent 统一整合提交。

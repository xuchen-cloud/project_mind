# 本地实时转写中断修复（2026-10-25）

## 工作包

- 关联 [#252](https://github.com/xuchen-cloud/project_mind/issues/252)，延续 #94 与 #234。
- 基线：`8f120886`，目标分支 `develop`。
- 依赖：现有双路采集、SenseVoice 本地识别、Transcript 与已保存音轨。
- 交付：本地实时识别按音频进度消费双路输入；识别失败持久化并明确展示，原始录音继续保存。
- 非目标：新增离线重新转写、修改已有 Transcript、扩大识别队列或放宽真实音频缺口检查、说话人算法优化。
- 验收：双路不同回调长度且同时积压时持续处理；真实录音完整经过后台识别入口；错误不会被当成云端任务静默丢弃，恢复录制后清除当前错误，历史录音保留转写缺失提示。
- 验证范围：受影响 Voice Rust 测试、真实本地模型隔离回放、Voice 前端测试、跨端类型与前端构建、UI 静态规范及主 agent Standards / Spec 双轴检查。静默执行，不打开或重启用户应用。

## 诊断证据

当前 Speech Recognition Profile 为本地 SenseVoice。最近一段约 32 秒录音的两路原始音轨已保存，麦克风持续有输入，但没有最终 Transcript，也没有云端补转写区间。

同一原始音频按媒体时间排序回放通过：4 段最终转写，最后一段超过 20 秒，处理耗时约 22 秒。音频和识别模型本身可用。

真实双队列消费入口可以失败：48 kHz 麦克风单声道每回调 1024 帧、系统双声道每回调 480 帧；两路同时积压时，原 `tokio::select!` 近似按相同回调次数消费，较长回调的一路领先并触发三秒缓冲上限。纯静音最小测试在约 6 秒媒体位置失败，完整音频通过 `LiveLocalHandle::spawn` 也出现同样错误。

本地错误随后被转换为 `CloudGap`，但本地没有 cloud epoch，原数据库语句不会保存任何错误。“转写”按钮只展开已保存结果，不触发重新识别，因此不能补回缺失文本。

测试仅通过环境变量读取本机音频与模型，在临时目录运行；不提交音频、转写正文或本机资料路径。

## 验证与审查

| 范围 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 最小复现 | `backlogged_native_callbacks_do_not_exceed_track_lag` | 修复前约 6073 ms 媒体位置失败；修复后通过，使用产品实际消费器 |
| 原始录音回放 | 环境变量指定只读音轨和模型，执行 `replays_saved_native_callbacks_through_live_pipeline --ignored --nocapture` | 修复前真实后台入口失败；修复后有序 Pipeline 与 `LiveLocalHandle::spawn` 均通过，最终片段时间均超过 20 秒；完整测试 57.28 秒 |
| 错误可见性 | `local_recognition_failure_stays_visible_without_stopping_audio_and_survives_resume` 与三个前端回归 | 修复前错误字段为空 / 界面无提示；修复后通过，继续录音、新 epoch 清除当前提示、结束后保留缺字提示 |
| Voice Rust | `cargo test --manifest-path src-tauri/Cargo.toml --lib voice --quiet` | 92 通过，5 ignored；外部模型与音频用例保持显式忽略，本包真实音频回放已单独执行 |
| Voice 前端 | `npm run test:unit -- src/components/voice src/lib/voice-player.test.ts src/services/voiceApi.test.ts --maxWorkers=1` | 6 文件、54 项通过 |
| 前端类型 / 生产构建 | `npx tsc --noEmit`、`npx vite build` | 通过；构建 14.86 秒 |
| 本地原生程序 | `cargo build --manifest-path src-tauri/Cargo.toml --bin project_mind_alpha` | 通过，54.24 秒；未启动程序 |
| 静态规范 | `check:ui-standards`、`check:bundle-boundaries`、变更文档 portable-path 规则、`git diff --check` | 通过，主入口 225 KiB / 250 KiB |

上述验证针对本包最终源代码差异；之后只补验收文档时复用，不重新运行应用全量测试。Rust 集成首轮编译发现新增 COUNT 测试使用不支持的 `u64`，改为 SQLite 对应的 `i64` 后完整 Voice 组通过；该首轮失败未记为通过。

主 agent 完成 Standards / Spec 双轴自查，没有启动 review 子 agent。检查覆盖原始音轨独立保存、三秒资源上限不变、真实时间轴缺口继续报错、双路关闭后的尾部处理、本地和云端错误分流、错误跨重启保留与 epoch 隔离、跨端字段和三个视图提示。未遗留本包发现。

## 范围与后续

- 本包修复本地 SenseVoice 的实时消费，不覆盖此前已经缺失的 Transcript；“转写”按钮仍只展开已保存结果。原始音轨保持可用，离线补转写需独立工作包。
- 云端 `live_paraformer` 仍有相似的双队列消费写法；本包未复现其真实云端故障，不据此扩张改动。后续在 #94 的云端验证中覆盖积压输入。
- 没有启动应用窗口或替换当前运行进程；新程序需下次启动加载。

# Voice Record 实施状态

- 跟踪：[Issue #94](https://github.com/xuchen-cloud/project_mind/issues/94)
- 分支：`codex/voice-record`
- 检查日期：2026-09-21
- 当前状态：macOS 15 的录音与回放闭环已实现：可创建 Voice Record、双轨采集、持续写盘、暂停/继续/结束、崩溃恢复，并在 Record 内通过统一播放器播放、拖动和变速。M1 整体仍缺 Windows 采集与两平台实机验收；M2 的实时识别、字幕和 Transcript 尚未实现。

## 本轮实现

2026-09-23 回归检查：普通 Record 不再请求语音回放或初始化 Web Audio；无音频分片时播放器也不初始化。修复过期结束请求提前取走进程内 Session 所有权的问题。前端单元测试 728 项通过，Rust 测试与构建验证见本轮提交记录。

2026-09-23 音频噪音修复：麦克风输入不能固定假设为 Float32/48 kHz。适配器按 CMSampleBuffer 的实际格式解码 signed Int16 或 Float32，并使用设备实际采样率；声道布局或录制途中格式变化会触发故障，避免继续写入错误格式。新增 Int16 幅度/样本数测试和 44.1 kHz 输入到 Float32 WAV 的完整写盘回归测试，16 项 voice 测试通过。用户要求保留旧录音、不做修复；更新后的新录音尚待实机听感确认。

`src-tauri/src/voice/session.rs` 提供 SessionController 的公开控制接口与行为测试：

- 未结束的会话（包含暂停和结束处理中）保持唯一所有权。
- 开始和继续必须具备麦克风、系统声音、识别和存储就绪状态。
- 有效时长只累计 recording 区间，以调用方单调时间为准。
- begin_end 冻结采集时长；finish_end 应由实际 writer 保存完成后调用。
- 已结束会话不可恢复；旧 session ID 不能修改新会话。
- VAD 确认双路都无语音五分钟才自动暂停；恢复后的计时不继承暂停前静音。

`src-tauri/src/voice/capture.rs` 已开始实现 VR-02 的平台无关契约：

- `SourceTimeline` 使用 sample counter 形成稳定媒体坐标，不让回调调度抖动改变回放时间。
- 麦克风与系统声共享 Recording Session 单调起点，保留各自首帧偏移。
- 每帧记录 presentation timestamp 与 sample clock 的误差，供后续漂移检测/校正使用。
- 有界原始音频队列在满载时返回原帧和明确背压错误，不静默丢弃 Voice Source Track。
- 单调时间回拨不会推进 sequence 或 sample counter。
- 产品麦克风选择固定为 `SystemDefault`；诊断探针支持的显式设备 ID 不进入产品设置。
- Float32 PCM 统一转换为 `AudioFrame` 使用的交错布局，覆盖交错与逐声道平面缓冲。

`src-tauri/src/voice/capture/macos.rs` 已开始实现 VR-05 的真实产品适配器：

- 使用一个 ScreenCaptureKit stream，同时注册独立的系统声音和麦克风输出。
- 每次开始/继续均清除麦克风 device ID 覆盖，采用当时的 macOS 系统默认输入；不修改系统设置。
- 排除本进程声音，避免应用自身回放递归进入录音。
- 两路回调分别解码、建立共享会话起点下的 `SourceTimeline` 并写入有界队列。
- 解码、时间轴、背压、消费者关闭和系统终止均进入故障通道，供 Session Manager 统一暂停双路。
- `MacCaptureSession` 已接入 `voice_start/pause/resume/end`，显式停止或析构时释放 native stream；设备/背压故障通过快照协调器统一暂停。
- `src-tauri/Info.plist` 已加入麦克风权限用途说明。
- 根据用户决定，应用 macOS 最低版本已直接提升为 15.0，适配器进入默认产品构建。

当前交付是可用的本地录音闭环，但还不是完整 Voice Record 产品：录音会在 Workspace 内创建普通 Record，原始麦克风/系统声按 epoch 分别保存为 Float32 WAV；识别与衍生内容尚未生成，Record 详情暂不提供波形和回放。

## 实测环境与阻塞

1. 主机为 Apple Silicon，macOS 27.0。
2. 2026-09-20 复核时 `xcode-select -p` 已指向系统 Command Line Tools，`xcrun --sdk macosx --show-sdk-version` 返回 **27.0**。
3. 当前 SDK 的 ScreenCaptureKit `SCStream.h` 已声明 `capturesAudio`（macOS 13+）与 `captureMicrophone`（macOS 15+），旧 SDK 编译阻塞已解除。
4. 已新增 `tools/voice-capture-probe`：它只在显式传入 `--record` 后启动一个 ScreenCaptureKit stream，把系统声音与麦克风分别写入 M4A，并输出首帧单调时间戳报告；普通构建不会申请权限或采集。
5. 用户明确同意后已完成多次实机采集：系统声轨包含已知测试语音，双轨均为系统可解析的 M4A；原始 ScreenCaptureKit 缓冲和 AVFoundation 直采均确认合盖状态下的内建麦克风为精确零值。显式选择外置 `EDIFIER R20` 的诊断运行得到非零麦克风证据。用户随后手动修正系统默认输入；正式产品按用户决定只跟随系统默认输入，不提供或持久化探针式设备覆盖。已观测的首帧偏移约为 130–613 ms，正式时间轴不能按文件起点强行对齐。
6. Windows Rust target 已安装，但当前没有实际 Windows 系统音频设备测试环境；安装 target 不等于 Windows 端采集验证通过。

单一 ScreenCaptureKit stream 的麦克风输出要求 macOS 15+。用户已决定直接把整个应用的 macOS 最低版本提高到 15.0，不再维护更低版本的 Voice Record 兼容路径。

## 技术资料核对（尚非本机采集实测）

- [Apple captureMicrophone](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturemicrophone)：当前 SDK 已包含并完成双路探针编译及实机采集验证。
- [Windows loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)：可从输出设备通过 WASAPI 捕获系统混音，不依赖硬件 Stereo Mix。
- [sherpa-onnx Tauri 非流式麦克风示例](https://k2-fsa.github.io/sherpa/onnx/tauri/vad-asr-mic.html)：有 SenseVoice + ONNX + VAD 的桌面参考链路。
- [sherpa-onnx VAD C API](https://k2-fsa.github.io/sherpa/onnx/c-api/html/vad.html)：文档中的 VAD 类型为 Silero/Ten，不能把它当作 FSMN-VAD 的已验证替代实现。

## 接续步骤

### M1 录音闭环

- Rust `voice/contracts.rs`：前后端设置、操作输入、快照和结构化未实现错误。
- Rust `voice/commands.rs`：8 个 Tauri 命令已连接 Workspace 数据库与进程级唯一 Session Manager。
- Rust `voice/capture.rs`：音频来源和帧结构，双平台/AEC/时间轴待实现。
- Rust `voice/storage.rs`：双轨 Float32 WAV writer、周期性 header checkpoint、原子改名和 `.part` 崩溃恢复。
- Rust `voice/recognition.rs`：VAD、ONNX 模型包与云端 WS/补转写边界注释。
- Rust `voice/processing.rs`：优先级、润色、翻译、词库、纪要与标题边界注释。
- 前端 `voice-types.ts` / `voiceApi.ts`：与注册命令对应的调用契约。
- `src/components/voice/`：设置页、全局录音控制条和 Record 统一播放器已接入；播放器内部同步底层双轨，不向用户暴露分轨控制。

数据库已升级至 schema v22，持久化 Voice Record、Recording Session、音频 manifest、时间线事件和转写段表。录音期间会阻止关闭或切换 Workspace；进程异常后，下一次快照会修复已写入的 WAV 并将会话恢复为暂停状态。麦克风始终采用开始/继续时的 macOS 系统默认输入。

当前验证：Rust lib **119 项完整测试通过**，新补充的 Session 所有权回归测试单独通过（合计 120 项）；前端 728 项单元测试、生产构建、UI 标准、路径和 bundle 边界检查通过。`screencapturekit` 10.0.3（`macos_15_0` feature）、权限 plist、Swift runtime rpath 与产品 Session Manager 均进入默认构建。ONNX 实际推理与 Windows 实机测试尚未执行。

1. 继续验证权限拒绝/恢复、设备变化与长时漂移，并在设备预检中识别系统默认输入不可用和合盖硬件断开；设备选择继续由系统设置负责。
2. 验证 Windows WASAPI 原生适配器与干净安装包。
3. 固定 SenseVoice/FSMN ONNX 运行产物，验证前处理、分段时间戳、许可证和 CPU 指标。
4. 接入转写、字幕和按转写片段跳转播放。
5. 接入润色、翻译、词库、纪要和标题管线。Issue #94 保持开放；完整产品能力尚未达到发布条件。

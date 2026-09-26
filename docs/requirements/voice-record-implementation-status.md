# Voice Record 实施状态

- 跟踪：[Issue #94](https://github.com/xuchen-cloud/project_mind/issues/94)
- 分支：`codex/voice-record`
- 检查日期：2026-09-26
- 本轮计划基线：`93adaef`
- 当前排期：[近期执行计划](voice-record-next-plan.md)。仅执行录音可靠性、识别完整性、转写搜索、跨平台四包；保守润色及其他剩余事项暂缓。

## 当前能力与缺口

已实现 macOS 双轨录音、纯录音模式、离线模型导入及启动复用、本地 SenseVoice 与 Paraformer 实时识别链路、可选临时字幕、独立浮窗、转写分页与点击回放、手动/周期/结束纪要、流式纪要、AI 标题覆盖和正文复制。

本轮已接入滚动 WAV 分片、磁盘异常后的停止与保存重试、退出保存屏障、Record / Project 删除清理重试；固定 FSMN-VAD 模型、双路独立静音检测、云端有界重连及持久补转写；原始 Transcript 搜索；Windows WASAPI 双轨采集和跨屏浮窗位置约束。保守润色没有进入实现。

| 范围 | 当前实现与验证 | 仍待验收 |
| --- | --- | --- |
| 录音可靠性 | 60 秒分片、已落盘文件恢复、保存失败重试、删除事务与清理队列；软件回归通过 | 集中进行真实长录音、退出和磁盘异常操作验收 |
| 识别完整性 | 内嵌 FSMN ONNX/CMVN；静音五分钟边界、噪声、模拟云端协议、重启恢复、补齐事务及纪要输入回归通过；真实 SenseVoice 中文与低音量 fixture 通过 | 真实 Paraformer 断网恢复；实际设备静音/交替讲话验收 |
| 转写搜索 | Workspace / Project 归属、同一 Record 去重、追加/补齐、删除和原文不变回归通过；打开的搜索定期刷新 | 与其他界面验收一并检查点击定位 |
| Windows | WASAPI 默认麦克风及 render loopback 接入公共 writer、活动检测、两种识别和生命周期；原生采集模块独立 `x86_64-pc-windows-msvc` 编译检查通过 | 用户确认无 Windows 环境：完整 Windows 构建、安装包、双路设备和识别闭环保留待验收；独立模块编译不等于整个平台通过 |
| 跨屏浮窗 | 显示器位置记忆、物理坐标与 DPI 换算、可见范围约束、热插拔检查；几何及现有浮窗回归通过 | macOS / Windows 多屏、不同 DPI、热插拔实机验收 |

静默验证：前端全套 773 项通过；Rust 全套 173 项通过、3 项外部环境测试默认跳过，其中真实中文 SenseVoice 录音链路测试另行执行通过。生产构建、UI 标准、可移植路径和 bundle 边界检查通过。以上结果不能替代真实云端、Windows 或多屏验收。

本轮由主 agent 自行进行 Standards / Spec 检查；未再启动子 agent review。完整实机验收尚未完成，Issue #94 保持开放，不自动合并或宣称全量交付。测试期间暂停了已有 `tauri dev` 自动重启 watcher；可用 `npm run dev:tauri:manual` 手动启动无监听模式。

## 历史实施日志（按当时状态保留）

以下条目含当时的缺口与接续建议，不能用来覆盖上述当前状态或重新启用暂缓事项。

2026-09-24 优先增量：新增独立置顶字幕窗口，取消系统标题栏，提供可拖动的圆角半透明磨砂界面、折叠/关闭折叠、最终与临时字幕、自动滚到最新字幕及顶部渐隐；窗口可暂停、继续、结束录音。文本 AI Profile 可在语音设置中选择。最终 Transcript 经持久任务按有效录音时长每 15 分钟累计生成五节纪要，结束时生成最后一版，Record 页默认展示并允许手动更新；AI 标题使用录音开始时间后缀，按用户最新决定可覆盖手动标题。翻译、跨屏位置持久化与实机视觉验收仍待后续。

## 本轮实现

2026-09-24 M2 识别链路修复：将双轨采集的独立副本送入 16 kHz 混音识别分支，以 WebRTC VAD 做本地切段，并把 SenseVoice 最终结果写入 Voice Record Transcript；暂停/结束时 flush。连续语音安全切为最长约 10 秒的推理输入，并跨输入合并，优先在句号或逗号边界显示，降低任意断句。Paraformer 以 DashScope WebSocket 持续发送 PCM，处理临时句和最终句。设置新增两模式共用的临时字幕开关；关闭时本地跳过重复预览推理，两个模式均保留最终转写。模拟 WebSocket 音频与事件测试、真实中文 SenseVoice fixture 测试通过。真实设备、真实 DashScope 凭据、断网恢复和长会议性能尚待验收。

2026-09-23 M2 / VR-08 起步：新增仅消费真实 VAD 判定结果的 PCM 分段状态机，具备前置缓冲、尾部保留、最小语音长度、输入上限、强制切段重叠、暂停/结束 flush 与时间轴缺口拒绝。纯逻辑测试覆盖静音、句首句尾、连续讲话强制切段和音频 gap。它尚未连接 FSMN-VAD 推理或实时采集分支，不能据此宣称 VR-08 或 M2 已完成。

2026-09-23 M2 / VR-09 技术验证：`sherpa-onnx` 1.13.8 的独立 CPU 探针在本机实际加载 SenseVoice int8 ONNX，并完成中英两段 16 kHz fixture 推理；RTF 分别为 0.155 和 0.137。英文例句有一个词识别错误。模型探针文件仍放在仓库外；产品下载、识别 worker、两平台打包和长会议准确率尚未完成。详细产物校验和与复现命令见 `docs/technical/voice-record-feasibility.md`。

2026-09-23 M2 / VR-09、VR-13 增量：应用现在允许导入固定 SenseVoice int8 模型目录，逐文件 SHA-256 校验 ONNX、tokens 和 LICENSE，暂存目录通过校验后才原子激活；设置页可查询状态和选择目录。Transcript 最终片段具备按 provider key 幂等落盘、冲突拒绝、Record 作用域隔离与 keyset 分页；详情页按页显示原文并可点击跳转音频。识别 worker 尚未接入，录音不会自动生成这些片段；模型下载/取消、FSMN-VAD、Paraformer、浮窗和断网补转写仍未完成，M2 不能验收。

2026-09-23 M2 / VR-10 协议契约：依据阿里云当前 Paraformer WebSocket 文档增加 `run-task`/`finish-task` 消息构造及服务端事件状态机测试。它强制等待 `task-started` 后才允许发送 PCM，区分中间句/最终句，并在最终句 `end_time=null` 时使用最后一个词的结束时间；对错 task ID、错误事件顺序和 `task-failed` 显式失败。尚未接 WebSocket 传输、凭据、重连或 gap 补转写。

2026-09-23 M2 / VR-10、VR-11 连接测试增量：语音设置可选择已有、已加密保存的 AI Profile 作为 DashScope 凭据引用，后端只在 Workspace 解锁后读取密钥；WebSocket 连接测试严格限制阿里云北京官方 WSS 域名，执行握手、`run-task`、等待 `task-started`、发送短 PCM、`finish-task` 和等待 `task-finished`。本地模拟 WebSocket 测试通过。当前 Workspace 尚未通过真实 DashScope 凭据测试，且录音 PCM 仍未连接该传输，断网补转写未实现。

2026-09-23 M2 / VR-09 worker 增量：产品构建接入固定版本 `sherpa-onnx`，以独立 CPU 线程加载已校验的 SenseVoice 包，限定 30 秒输入和 8 段有界队列；队列满时显式报错，原始录音由独立 writer 保存。当前分段器与实际采集/VAD 尚未连接 worker，故录音仍不会自动产出 Transcript。

2026-09-23 M2 / VR-12 字幕增量：当前主窗口底部录音控制区可按语音设置的 2–8 行数读取当前会话最后的最终 Transcript，每秒用会话 ID 查询，且不拉取完整会议记录；真实独立 Tauri 浮窗、折叠/拖动/跨屏和云端临时句仍待实现。没有识别输入时字幕区为空。

本次 M2 基础改动通过 Rust 全套 123 项测试、`cargo check`、识别探针 `cargo check --locked` 与中英文实测。M2 仍处于进行中。

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
6. Windows Rust target 已安装；用户于 2026-09-26 确认没有 Windows 测试环境，Windows 保留待真实构建、双路设备和安装包验收。安装 target、交叉检查或模拟协议均不等于 Windows 验收通过。

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

当前验证：Rust lib **131 项完整测试通过**，随后新增的旧模型设置迁移测试单独通过（当前合计 132 项；另有一项需外部模型的测试默认跳过，但本轮已用官方中文 fixture 实际运行通过）；前端 **731 项**全量测试、生产构建、UI 标准、路径和 bundle 边界检查通过。`screencapturekit` 10.0.3（`macos_15_0` feature）、权限 plist、Swift runtime rpath 与产品 Session Manager 均进入默认构建。SenseVoice 已完成 Apple Silicon 的真实推理；Windows 实机测试尚未执行。

Windows 目标交叉检查在当前 macOS 主机的 `ring` C 构建步骤被工具链阻断：针对 `x86_64-pc-windows-msvc` 的 `cc` 找不到目标环境的 `assert.h`。这不是产品代码的 Windows 通过或失败证据；仍需 Windows MSVC 构建环境与真实音频设备完成验证。

1. 继续验证权限拒绝/恢复、设备变化与长时漂移，并在设备预检中识别系统默认输入不可用和合盖硬件断开；设备选择继续由系统设置负责。
2. 验证 Windows WASAPI 原生适配器与干净安装包。
3. 固定 SenseVoice/FSMN ONNX 运行产物，验证前处理、分段时间戳、许可证和 CPU 指标。
4. 接入转写、字幕和按转写片段跳转播放。
5. 接入润色、翻译、词库、纪要和标题管线。Issue #94 保持开放；完整产品能力尚未达到发布条件。

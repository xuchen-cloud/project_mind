# 本地语音流式实现的官方参考

关联 #293；核查日期 2026-11-01。目标是减少重复计算和采集阻塞，保持现有声学判定、阈值、分段与最终结果。下列“项目判断”是根据源码作出的适用性判断，不代表上游保证本项目结果等价。本文不包含私有音频或转写正文。

## FSMN：每流缓存与结束排空

本次将 FunASR 固定至 `5315edd5db957ffd5c0035ac5b6b432560e88608`：

- [官方 streaming_vad.md](https://github.com/modelscope/FunASR/blob/5315edd5db957ffd5c0035ac5b6b432560e88608/docs/streaming_vad.md) 要求同一流顺序复用 cache，各录音、用户及取消后的会话独立创建。最后一个**非空**块设置 `is_final=True`；实时输入可暂存最新块，结束时提交，不能把已消费块再次提交。边界是流开始以来的毫秒值，不能重复添加 chunk 偏移；`-1` 表示尚缺一侧边界。
- [model.py](https://github.com/modelscope/FunASR/blob/5315edd5db957ffd5c0035ac5b6b432560e88608/funasr/models/fsmn_vad_streaming/model.py#L911) 的 `init_cache` 分开保存 frontend、encoder、窗口检测器、统计和剩余样本；`inference` 空输入提前返回，正常 final 路径末尾重置 cache。`forward` 根据 final 状态调用普通帧或末帧处理。动态静音调度亦会改变端点阈值，不能把上游默认值当作当前固定规则。
- [官方独立测试](https://github.com/modelscope/FunASR/blob/5315edd5db957ffd5c0035ac5b6b432560e88608/tests_models/test_fsmn_vad_streaming.py) 按 200 ms 投喂，并以独立新 cache 重跑比较事件。它验证该模型会话一致性，不证明本项目旧窗口算法与流式算法等价。

项目判断：麦克风、系统及混音需要各自的流状态；EOF 必须排空且不能重复识别。上游长流 cache 与本项目反复有限窗口的上下文起点不同，直接换成上游流状态可能改变概率和边界，须先逐帧对照，不能仅比较“仍能出字”。

## LFR：上下文与未稳定尾部

[官方 WavFrontendOnline](https://github.com/modelscope/FunASR/blob/5315edd5db957ffd5c0035ac5b6b432560e88608/funasr/frontends/wav_frontend.py#L350) 在 LFR 中保留尚缺右上下文的特征；普通块缩短可输出范围，final 时才用末帧补足右侧。前端另保存原始样本余量、LFR splice cache 和对齐 waveform，特征输出与能量统计必须保持对应。

项目判断：可以缓存不会再变化的中间结果，窗口末端尚未稳定的特征及其传播范围必须重算。缓存保留长度应从本项目真实网络左右依赖推导，并以相同 PCM、热身、静音门控、窗口滑动和 EOF 证明判定与边界一致；不照搬不同 frontend/model 的常数。

## SenseVoice：采集线程与识别线程

固定 [sherpa-onnx v1.13.8 麦克风示例](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/python-api-examples/simulate-streaming-sense-voice-microphone.py)：独立采集线程每次读取 100 ms 并复制样本到队列；主循环取队列后运行 VAD 和非流式 SenseVoice，临时结果会对当前缓冲重复解码；默认计算线程数为 2。示例队列是无最大容量的 `queue.Queue()`。

项目判断：参考独立采集、转移样本所有权和后台解码的分工；本项目仍保留有界队列、真实音频缺口与 EOF 检查。不能用无限队列掩盖吞吐不足，也不能把非流式模型误称为原生流式识别。临时任务应合并或替换过时状态，最终任务保持顺序和完整结果。

## ORT：线程配置需按 session 实测

[ORT 官方线程说明](https://onnxruntime.ai/docs/performance/tune-performance/threading.html) 区分算子内部 intra-op 与图节点之间 inter-op；后者仅在并行执行模式下发挥作用。线程池 spinning 降低唤醒延迟但消耗 CPU，多 session 各自线程池可能争抢资源，官方提供全局池或配置线程数等手段。

固定 [ORT v1.22.0 配置键](https://github.com/microsoft/onnxruntime/blob/v1.22.0/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h#L114) 可确认 `session.intra_op.allow_spinning` 与 `session.inter_op.allow_spinning`，不将最新版文档新增的微秒参数假定为当前二进制能力。[sherpa-onnx v1.13.8 session.cc](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/session.cc#L139) 将 `num_threads` 传给 intra/inter-op 配置，并按 provider 创建 session。

项目判断：目前 CPU provider、2 线程是现状，不是所有平台最佳值。线程数、spinning 或 provider 变化应隔离测试 CPU 时间、延迟和最终结果；不要设置进程全局线程环境变量来修复一个模型。v1.22.0 这里只是可复核 API 参考，不能据此推断当前打包 ORT 的精确版本。

## Windows / Intel Core Ultra 7 165H

[Intel 165H 官方规格](https://www.intel.com/content/www/us/en/products/sku/236851/intel-core-ultra-7-processor-165h-24m-cache-up-to-5-00-ghz/specifications.html) 列出混合 CPU、Arc GPU、AI Boost NPU 及 OpenVINO/ORT 软件框架。[OpenVINO 2025 支持设备](https://docs.openvino.ai/2025/documentation/compatibility-and-support/supported-devices.html) 与 [ORT OpenVINO EP 文档](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html) 是核对设备、精度、动态形状、版本配对和驱动的入口；当前在线 ORT 页面推荐独立 Plugin EP，不能把它当作 v1.13.8 sherpa 包已有能力。

项目判断：165H 是值得单独验证的 CPU/GPU/NPU 目标，但当前 Candle FSMN 不能只改一个 ORT provider 字符串便迁移，现有静态 sherpa CPU 包也不自动含 OpenVINO。此路线涉及模型导出、算子/形状覆盖、运行库与驱动分发及数值等价，留作独立工作包。本包先以现有模型与后端减少重复计算。Mac 上的 256 队列 / 480 帧回放仅验证 Windows 形态的调度压力，不能代替 165H 原机的 CPU、端点与转写验收。

## 工作包

关联 [#293](https://github.com/xuchen-cloud/project_mind/issues/293)。
基线 develop 3b9fd80169823f334748f6bab6092e7f2efb9641。用户授权先在 Mac 实施本地语音性能优化及异步消费，设计以 Windows 256 块/10ms 队列和 Intel CPU 为重点。

依赖：双原始音轨、FSMN、SenseVoice worker、现有回放工具。交付：降低重复 VAD 开销；识别等待不阻塞音频消费；final 优先、preview 合并及过期结果失效；有界积压、EOF 排空和真实错误报告。

非目标：改变原始音频、静默丢弃最终转写、放宽时间轴检查、声称 Windows 实机问题已解决、直接启用未验证加速后端。

验收：同一双轨音频前后性能与语音判定/分段/最终转写对比；256块队列下人为慢识别与完整停止；短语音、点击、静音行为；原始音轨不变。Mac 测试不启动窗口。Windows Intel MKL/ORT/OpenVINO 作为后续实测候选，硬件收益不由Mac替代。

验证：TDD定向回归、同音频测量、完整Voice Rust及cargo check/build、主agent Standards/Spec自查。Windows实际CPU与WASAPI验收单独记录待验证。

## Windows 目标与验收边界

目标硬件为 Intel Core Ultra 7 165H（用户确认）。16核22线程的混合架构，基础频率不能代表持续推理速度。第一轮优化减少跨平台重复特征计算与权重转换；不修改 Windows 采集时间轴、队列大小或线程优先级。

- CPU：比较默认 Candle、MKL 或 ORT CPU 后端，结合多路推理总线程预算评估，不把 num_threads=2 当作整个应用只有两个计算线程。
- 核显：OpenVINO GPU 为候选，需验证模型算子分配、CPU回退、驱动及安装包依赖。
- NPU：165H具备NPU，但动态音频长度与当前模型算子支持须实测，不自动启用、不承诺TOPS对应转写速度。
- Mac模拟Windows256块、480采样帧回调只能验证共用处理逻辑；Windows CPU、WASAPI、驱动、休眠恢复和设备故障必须目标机收口。

参考：[Intel 165H规格](https://www.intel.com/content/www/us/en/products/sku/236851/intel-core-ultra-7-processor-165h-24m-cache-up-to-5-00-ghz/specifications.html)、[OpenVINO EP](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html)。

## 方案选择与性能证据

同一份只读失败录音，麦克风有效样本56.788秒、1892个30ms检测帧。依次测三种候选；每轮交替baseline/optimized顺序，期间无编译或其他基准并行。基准使用默认开发构建：原extract-speech依赖opt-level=3，新本体代码opt-level=0，因此不将这些数值当作release或Windows性能。

| 候选 | VAD CPU时间中位数（基线→修改，秒） | 结果 |
| --- | --- | --- |
| 复用Fbank与模型权重 | 4.37→4.00 | 约下降8%，完整概率一致 |
| 再复用LFR/CMVN内部帧 | 4.21→3.57 | 约下降15%，完整概率一致 |
| 再增量执行四层FSMN缓存（最终采用） | 4.24→1.36 | 下降67.9%，被消费的末9帧概率及判定严格一致 |

最终方案三轮VAD wall：基线4.144/4.141/4.482秒，修改后1.260/1.302/1.266秒，中位约3.27倍速度；p95约7.30→2.20ms。有声判定均为1303帧。CPU取独立测试进程user+system，不等于任务管理器整机百分比，也不等于整个录音功能降低68%。

固定模型图验证为4层仅左向Conv，各19帧记忆、总76帧，其余运算逐帧。每次保留已稳定98帧之后的模型状态；窗口右侧2帧仅临时执行，下一次有真实右上下文时重算，不写入持久缓存。正常90ms推进时执行9个新增稳定帧和2个临时帧；长静音导致窗口不重叠时完整重建。仍保留原1.02秒窗口、门控与阈值。特征缓存和模型状态在麦克风、系统、混音三路独立持有。

Accelerate与无Accelerate两种M1 CPU数学后端均用同一整段录音验证：末9帧概率差异0、最大绝对差0、阈值跨越差异0、1892帧判定差异0。默认回归额外覆盖短推进与跨窗口长间隔。无Accelerate验证只证明该后端的这组输入结果，不能替代x86 Windows实测。

## 非阻塞消费与完整性

音频消费循环提交后继续读取，结果通过非阻塞轮询收集；无输入时20ms tick也可收集已完成结果。一个推理在途、最多8个final等待、一个可替换preview，final优先。预览按utterance代际失效，同一句慢预览不会因出现更新候选而永久无法显示；实际开始预览也受推理成本冷却约束。

EOF停止生成预览，排空已接受final并完成句子组装。过载或输入错误立即报告，已接受final继续排空；新增任务超过上限时明确报错并由独立保存链路保留原音，不承诺持续低于实时的硬件能够无限实时转写。未更改原始双轨、WASAPI、时间轴缺口规则或采集队列容量。

## 验证台账

- TDD：原submit在worker延迟200ms时阻塞203ms，非阻塞回归先失败。
- 最终统一Rust测试构建通过；FSMN默认6项通过，同音频真实末9帧概率及判定对照通过。
- 完整Voice默认范围：105 passed、13 ignored、0 failed。ignored不能计作通过；本包相关真实回放另行执行。
- 真实LiveLocalHandle：首任务延迟6秒，双轨256×10ms队列运行29.19秒；无溢出，录音期有临时字幕，EOF晚段final按序完成。
- 真实错误路径：1秒内报告输入错误，错误不重复，已接受final在停止后仍完成（6.14秒）。
- 本包Rust格式与git diff检查通过；三份新增文档portable-path规则通过。全仓portable-path检查另有既有文档违规，不属于本包，不据此扩张修改范围。
- 不启动应用窗口或麦克风；无用户原始音频/工作区Transcript写入；纯Rust内部实现，无跨端DTO或前端修改。

官方依据与适配边界见[官方参考](voice-official-streaming-references.md)，重跑方式见[同音频基准](voice-replay-benchmark.md)。


## 端到端对照与主 agent 审查

四组回放（Mac/Windows队列形态，各含原始双轨和双有声压力）全部回调接收完整、零故障；同形态修改前后的输入hash、最终Transcript hash及所有时间边界完全一致，转写末端均57,300ms。整体CPU时间单轮下降11.9%–17.4%，数据和限制见[基准表](voice-replay-benchmark.md#2026-11-01-实测)。原音仅只读，测试未创建或改写用户工作区Transcript。

主 agent Standards / Spec 自查覆盖：固定模型因果结构与缓存边界、静音后的状态重建、原采集/混音/写盘路径不变、final优先与有界预算、慢preview不会永久失效、实际启动preview遵守冷却、错误及时上报及已接受final排空、EOF不创建预览、epoch偏移与结果顺序。发现的过期preview/冷却与错误报告时序问题已修复并回归。未启动review子agent。

Windows剩余验收：在165H上用相同音频与发布构建测CPU、排队延迟和WASAPI连续性，包含会议并发；按实测决定线程数及MKL/ORT/OpenVINO后端，不能从Mac结果承诺降幅。

最终原生构建：`cargo build --manifest-path src-tauri/Cargo.toml --bin project_mind_alpha --quiet` 通过（未运行应用）。该构建同时完成非测试配置的类型检查与原生链接；不重复执行相同源码的cargo check。Windows实机与Intel后端后续由 [#294](https://github.com/xuchen-cloud/project_mind/issues/294) 跟踪。

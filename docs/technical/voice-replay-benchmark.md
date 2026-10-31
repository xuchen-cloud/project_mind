# 同音频本地语音回放基准

关联 #293（#254 后续性能工作）；基线为 `3b9fd80`。只读取原 WAV 和模型，不启动应用、不写工作区 Transcript。验收范围是同样音频的 Activity + LiveLocal 并行完整性、CPU 与耗时，以及最终转写的一致性；不以该回放替代真实 Windows 平台验证。

先由主 agent 协调完成测试编译，记录二进制对应的提交、构建模式和依赖。性能期间不得并发编译或运行其他基准。基线与修改后必须使用相同构建模式、模型、音频和环境变量；可将当前 `activity.rs` 的测试模块移植到临时基线工作树，共用 Cargo target 缓存，避免重建依赖。不得将当前产品实现移植回基线。准备命令：`python3 scripts/bench/prepare-voice-baseline.py $TMPDIR/project-mind-voice-baseline`。该脚本只创建 detached worktree 并移植测试，不编译或运行。共享 target 构建时，先复制基线测试二进制到单独临时位置，再构建修改后版本，防止后者覆盖相同路径。

设置 `PROJECT_MIND_TEST_MIC_WAV`、`PROJECT_MIND_TEST_SYSTEM_WAV` 与 `PROJECT_MIND_TEST_MODEL_DIR` 为本地文件。现有失败录音使用带起始采样位置的文件名，测试会读取最后一个数字作为起点；普通 `microphone.wav` / `system.wav` 从零开始。

对基线和修改后各执行以下两种形态，并在相同形态下增加 `--both-voiced`：

```sh
python3 scripts/bench/voice-replay.py /absolute/path/to/test-binary --label baseline --shape mac --output $TMPDIR/baseline-mac.json
python3 scripts/bench/voice-replay.py /absolute/path/to/test-binary --label baseline --shape windows --both-voiced --output $TMPDIR/baseline-windows-voiced.json
```

`mac` 使用 1024 回调队列、麦克风 1024 帧 / 系统 480 帧；`windows` 在 Mac 上模拟原生产 256 回调队列、双轨 480 帧形态，不意味着已验证 Windows 原生推理性能。`--both-voiced` 把同一个有声麦克风输入同时送到系统源，使麦克风、系统和混音三路均含语音；这是压力场景，不能和原始静音系统轨的转写 hash 互比。

输出包括子进程 user/system CPU、wall time、输入 SHA-256、队列容量、预期/接受回调数、故障、EOF 排空时间、最终转写 hash 和各段边界。队列没有公开深度接口，因此这些数据证明完整接收或拒绝，不声称测量积压峰值。必须完整接收所有回调、Activity 无故障、ASR 无错误且产生最终结果；比较同场景输入 hash 后再比较转写 hash/边界。hash 含 provider key、边界和正文，采用确定的 JSON 与长度前缀 SHA-256。

若需检查 hash 差异，可设置 `PROJECT_MIND_TEST_FINALS_JSON` 指向尚不存在的本地临时文件。测试以 0600 独占创建，保存完整最终结果；只在本地检查，完成后删除，不加入 git、报告或聊天。默认不保存或打印正文。脚本仅输出已知元数据行；失败的详细诊断由主 agent 本地查看测试进程，不将音频正文带入报告。

验收记录必须区分已执行与待执行，不以 ignored 或仅编译视为通过。回放形态变化后对应结果需重新执行；产品代码与配置未变化的已通过验证可以复用。

## 2026-11-01 实测

基线 `3b9fd80` 与当前 ASR 异步调度 + 增量 FSMN 统一测试构建，在同一台 Mac、同一安装模型与失败录音上各执行一轮，均为 Cargo 默认 test/debug 模式。无并发编译或性能任务。所有四场景完整接收输入、无 Activity/ASR 错误，最终结果至 57,300 ms；同场景前后输入 hash、最终转写 hash 和所有分段边界完全一致。

| 形态 | 回调数 | CPU user+system 基线 → 修改后 | 减少 | 进程 wall 基线 → 修改后 |
| --- | ---: | ---: | ---: | ---: |
| mac | 8356 | 39.463 → 32.790 s | 16.9% | 62.689 → 63.480 s |
| mac-voiced | 8341 | 37.669 → 33.183 s | 11.9% | 60.365 → 60.284 s |
| windows | 11373 | 41.490 → 34.258 s | 17.4% | 60.756 → 60.678 s |
| windows-voiced | 11358 | 39.879 → 33.899 s | 15.0% | 60.364 → 60.192 s |

进程 wall 含模型创建与实时投喂，不能当作纯模型推理时间；实时投喂决定约 57.3 秒下限，EOF 最终识别总计为 57.710–57.765 秒。CPU 改善是此轮端到端观察值，未声称多轮统计稳定性或 Windows 原生性能。原始系统轨为静音，双有声场景验证三路有声负载。临时 JSON、构建日志及已复制二进制保留于本地临时目录 `voice-293`，不纳入仓库或长期可用性承诺；可用上文脚本重建。

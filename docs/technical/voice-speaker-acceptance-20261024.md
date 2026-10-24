# Voice Record 说话人与联系人验收（2026-10-24）

关联 [#234](https://github.com/xuchen-cloud/project_mind/issues/234)，行为依据见[需求](../requirements/voice-speaker-diarization.md)。本轮在 Windows x64 静默验证；未启动或替换用户当前运行的桌面应用。

## 交付范围

- 本地 ASR 配置下，结束并保存录音与自动排队在同一事务完成；旧录音可手动启动，错误可重试。
- 固定 pyannote 3.0 / 3D-Speaker ERes2Net 模型经 SHA-256 与许可文件校验后激活，CPU 单线程、整场未知人数聚类、连续 epoch 时间轴，上限两小时。
- Transcript 与原始音频保持不变。说话人单独标注，可命名、关联现有 Contact；确认后保存 Workspace 内声纹，后续录音自动匹配。自动结果不反向学习，歧义及样本不足不冒认。
- 任务与命名使用 revision CAS，切换 Workspace 或新录音后阻止旧任务提交；异步模型检查后的手动启动也核实原 Workspace。联系人改名动态展示，删除联系人清理声纹，解除与纠正撤销本次来源声纹。

## 验证证据与复用

| 范围 | 命令或方式 | 结果 |
| --- | --- | --- |
| 原有 Voice 与新增第一轮逻辑 | 测试构建后运行 `<test-exe> voice --quiet` | 83 通过、2 ignored；后续只修改说话人引擎、声纹边界与异步启动约束，其余范围复用 |
| 最终说话人实现 | `cargo test --lib --no-run`；`<test-exe> diarization --quiet` | 编译通过；18 通过，1 个真实模型 smoke 单独执行 |
| 真实中文模型与联系人 | `<test-exe> voice::diarization::tests::real_chinese_four_speaker_smoke --ignored --nocapture` | 通过：10 段、4 人；真实声音确认、后续同人自动关联与异人拒绝均通过；56.86 秒样例完整链路 25.37 秒 |
| 前端 Voice | `npm run test:unit -- src/components/voice src/lib/voice-player.test.ts src/services/voiceApi.test.ts --maxWorkers=1` | 第一轮 50 通过；其后设置页模型缓存失效修复及回归 7/7，其他未变范围复用 |
| 前端类型与构建 | `tsc --noEmit`、`vite build` | 均通过；最终生产构建 22.34 秒 |
| 界面验收 | 独立 headless Chrome，真实 VoiceRecordPanel + 明确模拟后端 | 自动匹配确认、联系人选择、样本不足、改名与转写联动、解除关联通过，无 pageerror；1280 / 390 / 320 宽度检查；五条长联系人资料无隐藏滚动、无横向溢出 |
| 静态检查 | `check:ui-standards`、变更文档 portable-path 规则、`git diff --check` | 通过 |
| 生产包边界 | `check:bundle-boundaries` | lazy boundary 通过；主入口 249 KiB / 250 KiB 通过 |

Windows 测试 exe 需要 Common-Controls v6 激活清单；最初的 `0xc0000139` 来自测试构建产物缺少该清单。向测试 exe 嵌入清单后执行成功，没有复制或替换系统 DLL，没有修改生产链接方式。

初次完整前端资源构建遇到系统盘空间不足，已停止冗余 Office 安装。Office 源码未在本包变化：核对 sibling 提交 `ab3b60f754fdcfa9f925a5bb946f3e8a8a67689e` 对应的所有 Office 包与本包基线相同、无本地源码差异，复用其生成资源，并通过 `assembleOfficeDistribution` 的 engine closure 与清单校验。PDF 预览资源由固定版本 `pdfjs-dist 6.2.108` 的现有生成脚本补齐；不将资源准备失败记为构建通过。

## 实测修正

初次四人中文样例被默认聚类参数拆成七人，独立真实模型 probe 对比 0.7 / 0.8 / 0.9 后分别得到 5 / 5 / 4 人；采用上游该模型示例的 0.9 阈值，保持未知人数，严格 smoke 要求四人。

不同三秒同人片段 cosine 为 0.7008，异人片段为 0.1519。因此联系人门槛采用 0.65 加其他候选及同场竞争差值 0.1；真实 smoke 还实际执行三个独立 Recording Session 的确认、后续同人自动关联、异人匿名，不能只以“同人分数大于异人”作为验收。

主 agent Standards / Spec 双轴检查修复了上述实测问题、损坏历史声纹被静默忽略、异步启动跨 Workspace、模型导入后既有录音页缓存未更新，以及通用 CSS 覆盖联系人列表自然流的问题。后者以实际 computed style 确认修复：maxHeight 为 none、overflow 为 visible、553px 长内容完整展开。复查后不遗留本包发现；未启动 review 子 agent。

## 已知范围

- 官方样例与界面 fixture 不代替真实会议准确率、两小时资源峰值或 macOS 实机性能验收。
- 原生推理调用本身不支持中途取消；开始新录音或切换 Workspace 后在可中断检查点退出，提交前再次检查取消和 Workspace。
- 320px fixture 下原有播放栏存在按钮换行与内边距不足，处于桌面窗口最小宽度之外，本包的说话人列表无横向溢出。
- 全仓 portable-path 现有文档违规由 [#187](https://github.com/xuchen-cloud/project_mind/issues/187) 跟踪；本包变更文档规则通过，不扩大修复范围。

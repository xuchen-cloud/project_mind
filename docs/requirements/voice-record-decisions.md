# Voice Record 需求决策记录

- 状态：共同理解已确认
- 确认日期：2026-09-20
- 工作分支：`develop`
- 基线提交：`14f79c2`
- 决策来源：围绕 Voice Record、桌面浮窗、实时字幕、上下文增强与会议纪要进行的 `grill-with-docs` 访谈

## 问题陈述

Project Mind 需要新增 Voice Record，使用户可以在 Workspace 或 Project 中持续采集桌面会议。它必须同时保存麦克风与系统声音，在桌面浮窗中提供多行实时字幕，并可选地使用大模型进行保守润色、英文到简体中文的实时翻译、上下文增强和周期性会议纪要生成。

Voice Record 是现有 Record 的一种类型，不是独立于 Record 的会议对象。其可编辑正文继续遵守现有 Record 与 Committed Content 规则；原始音频、Transcript、翻译和 Meeting Minutes Snapshot 是与该 Record 关联的专用内容。

## 已确认决策

### D-01 归属与创建入口

1. Voice Record 可以是 Workspace Record，也可以是 Project Record。
2. 从 Workspace 创建时归属于 Workspace；从 Project 创建时归属于当前 Project。
3. Voice Record 继承现有 Record 的标题、标签、搜索、正文、删除和作用域规则。
4. 麦克风不可用或系统声音不可用时，不创建空 Voice Record，先引导用户修复设备。未配置识别模型时仍可录音，但不生成字幕与转写。

### D-02 模型配置

语音能力区分三种模型职责：

1. Speech Recognition Profile 为可选配置。未配置时仅录音，不生成字幕与转写；配置后可以选择云端实时识别或本地识别。首个云端模型是阿里云 `paraformer-realtime-v2`，首个本地模型基于官方 `iic/SenseVoiceSmall`，通过 ONNX Runtime 运行固定版本的导出或量化产物。
2. 文本处理模型为可选配置，用于保守润色、会议纪要和 AI 标题。设置界面可以推荐低延迟模型，但不硬编码供应商。
3. 翻译模型为可选配置，用于实时生成简体中文字幕。

文本处理与翻译应引用现有 AI Profile，而不是增加新的全局默认模型角色。语音识别使用独立的 Speech Recognition Profile。云端接入层优先使用明确验证过的通用实时协议，同时保留供应商 Adapter；不得假设阿里云通用实时事件与 Paraformer 专属 DashScope WebSocket 事件完全相同。本地 SenseVoice-Small 只负责识别、语言识别及其原生语音标签，不承担文本翻译、润色或会议纪要。

### D-03 音频来源与轨道

1. 首版同时支持 macOS 与 Windows。
2. Recording Session 必须同时获得麦克风和当前系统输出设备的全部声音。
3. 系统声音包含通知、音乐和其他应用声音；首版不支持只选择某个应用。
4. 麦克风或系统声音任意一路未就绪时阻止开始，不静默降级成单路录音。
5. 麦克风和系统声音分别保存为同步的 Voice Source Track。
6. 实时识别消费由两路声音派生的混合音频。
7. 第一版不识别具体说话人，也不区分远端参会者；双原始音轨为后续来源区分和重新转写保留基础。

### D-04 Recording Session 生命周期

1. 整个应用同时最多存在一个未结束的 Recording Session。
2. 状态至少包括准备、记录、暂停、重连、错误、结束中和已结束。
3. 暂停和继续属于同一 Recording Session。
4. 明确结束是终态；结束后不能继续原会话，再次录音必须创建新的 Voice Record。
5. 最小化或隐藏主窗口不影响录音和浮窗。
6. 退出应用时提示“结束并保存”或“取消退出”，不允许退出后继续后台录音。

### D-05 自动暂停

1. 麦克风和系统声音两路都连续五分钟没有语音活动时自动暂停。
2. 暂停期间不计入每 15 分钟的有效录音时长。
3. 自动暂停不结束 Recording Session，浮窗继续存在并显示暂停原因。
4. 自动暂停后不自动恢复，必须由用户点击继续。
5. 网络中断、模型无响应和设备错误不能伪装成静音暂停，应进入对应的重连或错误状态。

### D-05A 语音活动检测与 Utterance Segment

1. Voice Activity Detection（VAD）是独立于 ASR、翻译和润色的共享音频层能力。
2. VAD 同时服务于五分钟无语音自动暂停、语音起止判断和本地识别的 Utterance Segment 切分。
3. 原始 Voice Source Track 始终完整保存；VAD 只控制哪些音频进入识别，不删除录音中的静音部分。
4. 云端真正流式 ASR 持续接收音频，并以供应商返回的临时结果、最终结果和句尾事件为主；本地 VAD 作为自动暂停与一致性辅助，不应为了切段而破坏云端模型的连续上下文。
5. SenseVoice-Small ONNX 按 VAD 结束点对已完成的 Utterance Segment 推理，是接近实时的分段识别，不承诺逐 token 中间结果。
6. SenseVoice-Small 的单个输入片段不得超过其运行限制；连续讲话长期没有静音时，应在安全最大时长处分段，并保留少量前后文重叠以避免切掉词首词尾。
7. 每个 Utterance Segment 保留相对 Recording Session 的起止时间，识别结果按该时间轴合并到 Transcript。
8. 首选本地切分模型为 FSMN-VAD 的 ONNX 运行路径；模型、阈值、前置缓冲、尾部保留和最大分段时长必须通过真实会议音频验证。

### D-06 桌面浮窗

1. 浮窗包含折叠控制态和展开字幕态，始终置顶但不主动抢夺键盘焦点。
2. 默认位于当前显示器底部中央，允许拖动，并按显示器与缩放比例保存位置。
3. 显示器或分辨率变化后，浮窗位置必须被约束在可见区域内。
4. 关闭浮窗只折叠，不等同于结束录音。
5. Recording Session 期间始终展示明确的录音、暂停、重连或错误状态。
6. 开始前说明将捕获当前输出设备播放的全部系统声音。

### D-07 Live Captions

1. Live Captions 展示最近多行字幕，默认 4 行，用户可以配置为 2 至 8 行。
2. 新内容从底部进入，超出显示行数时只隐藏旧行，不删除 Transcript。
3. ASR 临时结果只用于最后一行的即时展示；最终结果才持久化为 Transcript 片段。
4. 已确认字幕保持稳定，临时字幕使用弱化视觉样式。
5. 字幕支持“原文 / 简体中文”切换；切换展示模式不修改原始 Transcript。
6. 云端流式 ASR 可以展示临时字幕；SenseVoice-Small 本地 ONNX 路径只在一个 Utterance Segment 完成推理后提交稳定字幕，因此延迟主要由 VAD 句尾等待时间与本地推理时间决定。

### D-08 实时翻译

1. 检测到英文且配置了翻译模型时，用户可以切换到简体中文字幕。
2. 中英混合会议按片段检测语言：英文片段翻译成简体中文，中文片段保持原样。
3. 中途开启中文模式后只翻译后续片段，不补译此前内容；此前未翻译的历史行继续显示英文。
4. 切回原文不删除已经产生的翻译。
5. 翻译失败时立即回退显示原始 Transcript，不中断录音或 ASR，不反复弹窗。
6. 模型恢复后只处理新片段，不自动追补失败期间的旧片段。
7. Transcript 与翻译使用同一时间轴并分别保存。
8. 翻译不直接消费音频，也不单独运行 VAD；它消费已经确认的 Transcript/Utterance Segment。切分器可以结合 VAD 句尾、ASR 最终结果、标点和最大等待时间形成适合翻译的文字批次。

### D-09 实时润色

1. 润色只处理已完成的句子或短批次，不处理每一个临时 token。
2. 润色只允许纠正错字、标点、断句和专有词，不改写表达、不概括、不添加事实。
3. 同时配置润色和翻译时，处理顺序为原始 Transcript、保守润色、翻译。
4. 润色结果是只读派生内容，不覆盖原始 Transcript。

### D-10 Context Lexicon 与上下文增强

1. 上下文增强默认关闭，由用户按 Workspace 开启或关闭。
2. Project Voice Record 只使用当前 Project 的近期 Record；Workspace Voice Record 只使用 Workspace Record。
3. 只读取 Committed Content，不读取草稿、附件或其他 Project。
4. Record 按更新时间从近到远进入上下文，到达模型上下文预算后停止追加。
5. 模型从这些 Record 中提取专有词、不常见词、缩写和建议拼写，形成 Context Lexicon。
6. Context Lexicon 可以用于语音识别、润色、翻译和会议纪要。
7. Recording Session 开始时生成或读取一次词库快照，整场会议保持不变；中途修改 Record 不影响当前会话。
8. Context Lexicon 应缓存并在相关源 Record 变化后失效，不能为每个字幕片段重新发送完整历史记录。

### D-11 Meeting Minutes Snapshot

1. 配置文本处理模型后，用户可以手动生成当前 Meeting Minutes Snapshot。
2. 每累计 15 分钟有效录音时长自动更新一次；暂停时间不计入。
3. 手动生成不重置自动生成的 15 分钟节奏。
4. 没有新增最终 Transcript 时跳过自动生成。
5. 自动纪要采用“上一版纪要 + 上一水位之后的新 Transcript”生成新的累计纪要。
6. 新纪要成功后原子替换旧快照；失败时保留旧快照。
7. 结束录音时，如果上次纪要后还有新 Transcript，生成一次最终纪要。
8. 第一版固定包含“摘要、关键讨论、已确认决策、行动项、待确认问题”。
9. Meeting Minutes Snapshot 默认展开、不可直接编辑，可以一键复制到 Record 的可编辑正文。
10. 复制后的正文与后续快照更新脱钩，不被下一次自动纪要覆盖。

### D-12 Transcript、翻译和纪要的展示

1. Record 页面默认展开 Meeting Minutes Snapshot。
2. 原始音频、Transcript、润色文本和翻译文本默认折叠。
3. 原始 Transcript、润色结果和翻译结果都不可直接编辑。
4. 用户需要修改时，应复制到 Record 正文后编辑。

### D-13 标题

1. 创建时默认标题为 `语音记录 · YYYY-MM-DD HH:mm`。
2. 第一次纪要成功后，允许自动替换为 `AI 生成标题 · YYYY-MM-DD HH:mm`；后缀使用 Recording Session 的开始时间并保持稳定。
3. 后续纪要可以继续更新 AI 标题。
4. 后续成功生成纪要时，AI 标题可以直接覆盖用户手动修改的标题。

### D-14 持久化、回放与恢复

1. 原始双音轨、最终 Transcript、润色和翻译结果持续落盘，不等待会议结束。
2. 崩溃后可以恢复到最后成功写入的位置，不把尚未持久化的临时字幕视为已保存内容。
3. Voice Record 页面支持混合音频回放，并允许分别静音或调节麦克风与系统声音。
4. 点击 Transcript 片段可以跳转到对应录音时间。
5. 产品层不限制单次会议时长；底层滚动切分音频文件以降低长文件损坏风险。
6. 磁盘空间不足时自动暂停并明确提示；不能继续写入时不得继续显示为正在录音。

### D-15 网络与设备异常

1. 网络中断时继续保存本地双音轨，浮窗显示重连状态。
2. 网络恢复后补转写中断期间的本地音频；实时协议不支持补传时，使用后台补转写路径。
3. 麦克风拔出、系统输出设备切换或权限被撤销时立即暂停，不结束 Recording Session。
4. 两路音频重新就绪后，由用户手动继续。

### D-16 调度优先级

运行时任务严格按下列用户体验优先级调度：

```text
录音持久化 / ASR
    > 实时字幕翻译与润色
    > 自动会议纪要
    > AI 标题
```

低优先级任务不得拖慢录音、原始转写或实时字幕。

### D-17 删除与本地安全边界

1. 删除 Voice Record 前需要确认。
2. 删除后同步移除双原始音轨、派生混音、Transcript、翻译、润色、纪要和关联索引，不留下孤立文件。
3. 录音文件沿用 Workspace 对普通 Record 与受管文件的现有本地存储安全边界，不新增独立加密层，也不增加专门提示文案。

## 范围外

1. 同时进行多场录音。
2. 结束后继续原 Recording Session。
3. 仅录制指定应用的系统声音。
4. 缺少一路音频时降级为单路录音。
5. 具体参会者身份识别或远端多人分离。
6. 中途开启翻译后自动补译历史内容。
7. 应用退出后的后台录音。
8. Voice Record 专用的本地音频加密。
9. 在正式实现前把本文件描述为当前已经具备的产品能力。
10. 把 SenseVoice-Small 的情绪与音频事件标签直接展示为第一版产品能力。
11. 把 SenseVoice-Small ONNX 描述为能够持续输出逐 token 中间结果的真正流式模型。

## 实现前需要验证的技术事实

1. 阿里云通用实时协议是否完整支持 `paraformer-realtime-v2` 所需事件、参数、断线补传与最终句语义；不满足时使用 Paraformer 专属 DashScope WebSocket Adapter。
2. macOS 与 Windows 同时采集麦克风和全部系统输出、设备切换检测、回声控制及权限恢复的可行 API 与能力差异。
3. 实时协议中断后的音频补传能力；若协议不允许，应确定后台补转写所用模型和任务格式。
4. 长时双音轨的编码格式、滚动分片大小、时间轴同步和崩溃恢复边界。
5. SenseVoice-Small 与 FSMN-VAD 的 ONNX 模型版本、量化精度、运行时算子兼容性、模型许可、校验和与更新策略。
6. SenseVoice-Small ONNX 在 macOS Apple Silicon、macOS Intel 与 Windows x64 的 CPU 实时率、内存占用、首次加载时间和字幕端到端延迟。
7. 本地模型是随应用安装还是按需下载，以及下载失败、磁盘空间不足、模型损坏和版本升级时的恢复流程。
8. VAD 在会议远场、键盘声、音乐、多人重叠发言和长时间连续讲话下的阈值、前置缓冲、尾部保留及最大分段时长。
9. ModelScope 当前模型仓库以 PyTorch 形式发布且体积接近 1 GB；产品需要确定最小 ONNX 运行产物、Tokenizer/配置依赖、量化方式与跨平台分发大小，不能把整个训练/推理仓库直接作为应用资源。
10. ModelScope 页面元数据与 SenseVoice 官方仓库对模型权重许可证的描述并不完全一致；发布前必须以选定模型文件和固定 revision 中实际附带的许可证为准，完成商业分发、署名和模型名称要求核对。

## 相关领域与架构记录

- [Project Mind 领域术语](../../CONTEXT.md)
- [ADR-0001：按默认角色与 Skill 覆盖解析 AI 模型](../adr/0001-resolve-ai-models-by-default-role-and-skill-override.md)
- [ADR-0003：只持久化 Committed Content](../adr/0003-persist-only-committed-editor-content.md)
- [ADR-0006：混音前保留 Voice Source Track](../adr/0006-preserve-voice-source-tracks-before-live-mixing.md)
- [ADR-0007：全局串行且结束不可恢复的 Recording Session](../adr/0007-serialize-voice-capture-into-one-terminal-session.md)
- [ADR-0008：Transcript 是 Voice Record 的事实来源](../adr/0008-preserve-transcript-as-the-voice-source-of-truth.md)

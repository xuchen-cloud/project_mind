# Project Mind

Project Mind 帮助个人在长期工作空间中组织阶段性项目，使当前理解、历史依据和下一步行动保持在同一上下文内。

## Language

### 工作边界

**Workspace**：
长期存在的工作与知识边界，承载跨项目或不属于任何阶段性项目的持续积累。
_Avoid_：Project、Area、临时项目

**Project**：
围绕一个明确结果建立的阶段性工作现场，有开始、推进和结束；没有完成终点的长期责任或知识领域不属于 Project。
_Avoid_：Workspace、Area、长期领域

**Archive**：
让 Project 可逆地退出活跃工作范围的状态变化，不表示该项目已经完成，也不删除项目及其内容。
_Avoid_：Complete、Delete、项目结束

**Project Label**：
直接附着在 Project 上的多值自定义分类，用于表达项目类型、优先级等非生命周期属性。
_Avoid_：Project Tag、Project Status、Archive

**Project Status**：
Project 在生命周期中任一时刻唯一的自定义状态，例如“计划中”“进行中”或“已完成”；它独立于 Project Label 和 Archive。
_Avoid_：Project Label、Project Tag、Archive

### 信息沉淀

**QuickNote**：
特定作用域中唯一的可变信息缓冲区，用于立即记下尚未决定最终形式或沉淀位置的内容。
_Avoid_：Daily Note、Record、正式归档

**Workspace QuickNote**：
Workspace 中唯一的低摩擦捕捉缓冲区，可以暂存想法、简要规划和候选行动；内容只有在用户决定长期保留或持续跟踪后，才转化为 Record 或 Todo。
_Avoid_：状态看板、Daily Note、Todo List

**Project QuickNote**：
Project 中唯一的低摩擦捕捉缓冲区，用于暂存已经明确属于该项目、但尚未决定是否沉淀为 Project Record 或 Project Todo 的内容。
_Avoid_：项目状态摘要、Project Record、Project Todo

**Record**：
已经判断值得保留、可以独立查找和引用的信息单元；它具有相对完整的上下文，可以继续修订，但不再是待处理的临时片段。
_Avoid_：Note、Activity、Conclusion（对象）、QuickNote

Record 正文以统一 canonical 文档为准，手工编辑与独立助手写入复用同一原生保存服务、不可变版本、块标识与版本 CAS。助手修改前协调目标编辑器 flush Committed Content；未接受的 AI 预览或忙碌编辑器会阻止提交，后续正文或元信息变更不能被旧操作覆盖。

**Project Record**：
归属于一个 Project 的 Record，用于保存该项目中的事件、材料、观察或判断，其生命周期与所属 Project 一致。
_Avoid_：Workspace Record、跨项目记录

**Workspace Record**：
不归属于某个阶段性 Project、没有预定结束时间的长期 Record，用于沉淀方法、框架、跨项目经验或持续关注的领域内容。
_Avoid_：Project Record、Area

**Voice Record**：
通过同时采集麦克风与系统声音形成的 Record，保存原始音频、按时间对齐的转写，以及由转写派生的实时字幕和会议纪要；它仍然归属于 Workspace 或一个 Project。
_Avoid_：录音文件、独立会议对象、普通 Record 附件

**Recording Session**：
一次 Voice Record 从开始到明确结束的持续采集过程；暂停和继续不会创建新的 Recording Session，明确结束后不能再次继续。
_Avoid_：音频分段、字幕批次、独立 Record

**Voice Source Track**：
Recording Session 中保持同步且来源可区分的原始声音，包括麦克风声音与当前输出设备播放的全部系统声音；两者共同构成 Voice Record 的原始音频依据。
_Avoid_：混合音频、独立 Voice Record、Transcript

**Speech Recognition Profile**：
Workspace 中将 Voice Record 的混合音频转化为 Transcript 的可选识别方案，可以由云端实时服务或本地语音模型提供。
_Avoid_：AI Profile、翻译模型、润色模型

**Utterance Segment**：
由连续语音活动界定、具有原始时间轴位置的短语音单元，是分段式语音识别与下游文字处理的稳定输入。
_Avoid_：音频文件分片、Transcript 段落、静音片段

**Live Captions**：
Recording Session 进行期间随语音更新的多行文字视图，可以在原文与已配置的目标翻译之间切换，但不改变被保存的原始转写。
_Avoid_：Transcript、会议纪要、正文

**Transcript**：
与 Voice Record 时间轴对应且不可编辑的原始语音识别文本，是润色、翻译和会议纪要的事实来源；用户修改其内容时，应先复制到 Record 正文。
_Avoid_：Live Captions、润色正文、会议纪要

**Meeting Minutes Snapshot**：
从 Voice Record 当前 Transcript 累计生成的最新只读会议纪要；后续生成会替换该快照，复制到正文后的内容不再随快照变化。
_Avoid_：Transcript、可编辑正文、历史纪要列表

**Context Lexicon**：
从同一作用域近期 Record 中提炼的专有词和不常见词集合，为语音识别、润色、翻译和会议纪要提供上下文增强。
_Avoid_：Tag、完整 Record 拼接、全局词典

### 行动

**Todo**：
需要被跟踪直至完成的明确行动，按照归属分为 Workspace Todo 和 Project Todo。
_Avoid_：Task、Record、QuickNote

**Project Todo**：
归属于某个 Project、用于推进该项目结果的 Todo，其生命周期与所属 Project 一致。
_Avoid_：Workspace Todo、跨项目 Todo

**Workspace Todo**：
直接归属于 Workspace、不依赖任何 Project 的 Todo，用于个人事务、跨项目事项或不需要建立 Project 的行动。
_Avoid_：Project Todo、未归类 Project Todo

**Workspace View**：
以 Workspace 当前工作范围为尺度查看 Todo 的集合，包含 Workspace Todo，以及归属于未进入 Archive 的 Project 的 Project Todo；它可以在 Workspace 或任一 Project 中查看，不改变其中任何 Todo 的归属。
_Avoid_：Workspace Todo、仅 Workspace Todo、Todo 归属

**Current Project View**：
以当前 Project 为尺度查看 Todo 的集合，只包含归属于当前 Project 的 Project Todo，不包含 Workspace Todo 或其他 Project 的 Project Todo。
_Avoid_：Workspace View、Workspace Todo、跨 Project Todo

**Subtask**：
Todo 下可独立安排和完成的较小行动单元，可以有自己的完成状态、截止日期和顺序。
_Avoid_：Todo Progress、进展、子项

### 材料

**File**：
归属于一个 Project、被该工作现场持续管理的外部材料，可以被查找、引用、标记并随内容变化保留版本。
_Avoid_：Document、附件记录

**File Version**：
同一个 File 在特定时点的内容版本，依附于该 File，不是新的独立 File。
_Avoid_：Document Version、独立 File

### 组织

**Tag**：
在单一作用域内对内容进行轻量分类和连接的标记，不形成层级，也不创造新的内容容器。
_Avoid_：Folder、Area、全局标签

**Workspace Tag**：
只用于 Workspace 范围对象的 Tag，不能附着到任何 Project 或 Project 范围对象。
_Avoid_：Project Tag、跨项目标签、全局标签

**Project Tag**：
只用于一个特定 Project 内 Record、Todo 和 File 的 Tag，不能跨 Project 或用于 Workspace 范围对象。
_Avoid_：Workspace Tag、跨项目标签、全局标签

**Internal Reference**：
对象之间可导航的上下文连接，不改变目标对象的归属或标签作用域。Workspace 范围对象可以引用 Project 对象；Project 范围对象只能引用同一个 Project 内的对象，不能引用 Workspace 或其他 Project。
_Avoid_：Tag、归属关系、跨 Project 引用

**Contact**：
Workspace 中可复用的人员信息，可以被 Workspace 和各 Project 范围的内容提及。
_Avoid_：User、Assignee、Project Contact

**Contact Mention**：
内容中指向 Contact 的上下文连接，用于表达人员相关性，不表示负责人、执行者或权限关系。
_Avoid_：Assignee、任务分配、权限授予

### AI 编辑

**AI Editor Skill**：
归属于 Workspace、可在 QuickNote 和 Record 编辑器中复用的用户自定义编辑能力，由名称、说明和提示词表达意图，并可分别适用于文字和图片菜单。
_Avoid_：AI Artifact、Ask、固定结果模式

**Image Interpretation**：
AI Editor Skill 对编辑器中一张图片的内容进行理解并生成文字结果，图片本身始终保持不变。
_Avoid_：图片编辑、图片修改、像素编辑

**AI Modification**：
AI 针对选中内容提出的替换建议，只有在用户明确接受后才成为正文。
_Avoid_：自动改写、已保存内容

**AI Answer**：
AI 根据选中内容生成的补充回答，只有在用户明确插入后才成为正文。
_Avoid_：Ask、AI Artifact、已保存内容

**Editor Skill Job**：
AI Editor Skill 针对一个显式文字选区或一张图片运行的一次临时会话，承载待确认的 AI Modification 与 AI Answer。
_Avoid_：图片 Job、持久化 AI 历史、编辑器全局会话

**Committed Content**：
编辑器中已经由用户确认、允许保存的正文视图，不包含任何仍待确认的 AI Modification 或 AI Answer。
_Avoid_：实时预览内容、编辑器 DOM 快照

AI Modification 与 AI Answer 的确认要求专指 Editor Skill Job 的选区或图片预览。独立助手按用户启用的作用域、Scope Grant 与 Run 冻结的执行模式提交已授权 Record 操作；协作模式形成候选后直接原生提交，先审阅模式保留候选直到用户确认当前候选版本，只读模式拒绝写入。独立助手不能自动接受或丢弃 Editor Skill 预览，也不能用 live editor 内容绕过保存屏障。详见 [ADR-0010](docs/adr/0010-separate-agent-record-commits-from-editor-skill-previews.md)。

**AI Metadata Fill**：
用户在 Record 标题区域显式发起、以 Committed Content 和同作用域现有 Tag 为输入的一次 AI 填写操作；它生成标题并优先复用现有 Tag，必要时新增少量 Tag，成功后以一个原子变更写入 Record。整篇 QuickNote 发布成新 Record 时自动触发同一能力；QuickNote 自动保存和追加到已有 Record 不触发。
_Avoid_：AI Editor Skill、AI Answer、自动后台分类、跨作用域 Tag 推荐

### 内容携带

**Record Export**：
单条 Workspace Record 或 Project Record 在其 Committed Content 状态下形成的本地可携带副本，可表现为 Markdown/ZIP、DOCX 或 PDF，但不改变原 Record。
_Avoid_：Backup、Workspace Export、未确认内容快照

### AI 工作上下文

**AI Overview**：
由助手维护、有版本与来源依据的作用域理解，供按问题渐进读取；独立于用户 QuickNote，不是普通 Record。
_Avoid_：Project QuickNote、项目主页、用户已确认事实

Project Overview 的维护作业在 `agent_jobs` 中持久保存 `batchId`、来源读取游标和待发布草稿；来源引用依据实际读取的来源页与证明，覆盖范围依据真实处理进度计算。取消、预算耗尽、前台任务和凭据锁定会使维护暂停或让出，条件恢复后可续跑。用户在 GUI 中的纠正由专属事务保存并约束后续发布；维护写入独立的 Overview 与派生知识，不改动 QuickNote。

**Scope Grant**：
可信适配器绑定到 Workspace 和明确 Project/Workspace 范围的操作权限；资料正文或工具参数不能扩大它。
_Avoid_：当前页面、模型声明的授权

外部连接通过本机随机端口 bridge 访问当前打开的 Workspace；凭据保存在系统凭据服务，Workspace 仅保存授权范围和凭据摘要。每次请求重新检查连接撤销和 Workspace 代际，切换后不自动转接。当前已接通的外部读取为 Project 列表和有界上下文；CLI 不打开第二份数据库、不启动内置模型任务。同一只读入口已通过 stdio MCP 暴露，设置可复制配置；其余外部工具、写操作和对象级授权尚待后续接入。

**Context Instruction**：
用户明确保存的作用域上下文说明，与模型生成知识、QuickNote 分离；模型不能自行修改。
_Avoid_：磁盘 AGENTS 自动发现、模型推断、QuickNote

**Operation Receipt**：
同一调用方和请求在 Workspace 中的持久成功结果，与数据和变更日志一起提交，供安全重试使用。
_Avoid_：模型自述完成、临时通知

Record 成果只有原生保存成功后，才在同一事务中绑定实际对象、前后版本基线、来源上下文、Operation Receipt 与成果已提交状态；stage 候选或准备提交不代表已保存。修改撤销把可信前版本恢复为新版本；新增 Record 的撤销只撤回正常可见性，保留对象身份、正文、版本、资产与引用关系，恢复后仍是同一对象。撤销或恢复须核对收据基线与当前撤回版本，后续人工修改或会被撤回影响的新引用返回明确冲突；删除会话不删除成功操作收据。

Todo 的 GUI 和助手写入共用 revision 与不可变字段快照；修改正文、状态、期限、标签或子行动都核对预期版本，删除标签造成的关联变化也在原生事务中递增版本。助手同一消息范围的同一行动以持久 dedupeKey 去重，修改整体原子提交；撤销恢复操作前字段和子行动身份，生成新 revision，不能覆盖后续人工写入。

独立助手的操作建议、确认及执行结果直接位于对应会话轮次中。未配置时默认确认后执行，保留已有执行模式选择；同一任务的候选形成一项简短方案，按钮与明确文字决定共用持久确认路径。确认绑定完整候选及版本，逐项原生提交，部分成功如实保留；停止等待正在提交的一项结算，再取消剩余项。补充要求启动新一轮后，旧候选失效。候选详情和来源按需展开，不另开审阅弹窗。成功结果提供实际对象入口及撤销、恢复操作。

助手使用稳定非模态侧栏，展开、收起和查看业务对象时保留会话与草稿。消息展示复用固定 Pi Web UI 展示组件；会话和凭据仍归现有 Host。继续讨论的对象由用户明确选择，随请求传入真实对象引用，不改变会话范围；修改前重新读取当前版本。下一轮可在原授权内读取同会话的决定和实际操作收据，读取权限不扩大为跨 Run 修改或撤销权限。

会话引用的原始讨论由已校验的 Pi JSONL 按固定分支锚点和消息范围回读，在来源卡片内展开。每页最多 50 条消息、12000 字符，长消息分片保留消息身份与全文 hash；追加消息、切换分支和模型压缩不改变旧引用。这个 GUI 查看入口不启动模型、不需要密钥，不将系统段、思考或完整工具日志当作原始讨论返回；删除会话或切换 Workspace 后不能继续读取旧结果。面向模型的历史检索与会话摘要已经接入独立的 `session.read` 和来源依赖过滤，已通过确定性集成验证，不能直接复用用户查看入口。

会话记忆按原文检索、增量摘要、有效项目结论逐步交付，摘要不是历史检索的前置条件。Pi JSONL 保持原文权威，SQLite 消息索引与摘要都是可重建投影；未覆盖范围必须明示，未命中不能推断从未讨论。用户计划、助手建议、明确决定、用户报告与原生操作收据分别表达，来源存在不等于模型归纳正确。选型与开源依据见[会话记忆设计](docs/conversation-memory.md)。schema 35 保存可信 Native Run 的扁平来源依赖；Host 每轮 provider 调用前复核实际历史上下文，旧 assistant/tool 无完整来源账本时不向 AI 返回，旧 user 和 GUI 历史仍按各自授权可用。独立模型原文搜索/读取、会话摘要与 Overview 原子发布已经接入源码，确定性集成已通过，仍须分别完成真实模型和目标平台验收，不合并宣称完成。

历史列表的 GUI 搜索使用独立于当前分支投影的 SQLite trigram 索引，支持中文句中匹配及短词字面回退。新投影与索引同事务保存；完整 Pi 历史树按批回填，持久保存覆盖水位和长消息分片，旧分支不随当前投影切换而删除。新增 checkpoint 通过原始字节前缀校验后续扫；未完成时提示结果可能不完整，继续查找从首批重新查询。命中以消息自身为分支锚点展开固定原文，不切换当前会话或丢失草稿；用户查询不启动模型。模型使用独立的 `session.search`/`session.messages.read` 入口；R12 外部 CLI/MCP 尚未接入这两个新工具。

File 成果复用托管导入、File Version、字节上传和恢复 journal，创建、精确修改、替换及历史恢复均在原生事务中绑定实际版本与操作收据。修改撤销生成新版；新建撤回保留身份、历史及字节，正常列表、搜索和 AI 读取不再可见。用户仍可通过显式文件历史入口查看保留版本；AI 排除不限制用户自己的历史查看与恢复，模型调用仍遵守排除、归档与撤回策略。原始 UTF-8 源码按固定版本和 hash 分页读取，保留 BOM、换行与内联脚本；索引提取结果不能代替源码续改。

HTML 文件在主工作区提供完整源码与固定历史版本查看，保留原业务页面和会话草稿；继续修改显式选择同一 File，恢复仍生成新版本。源码作为只读文本展示，交互脚本执行须先通过原生平台隔离验证，不能把源码查看当作交互预览验收。

同一任务（Run）内连续修改同一对象时，撤销定位任务开始前的版本或快照，通过原生恢复服务恢复一次；恢复旧内容记为新版本，保留修改前后的历史，不逐条反向执行操作，也不增加另一套版本库。会话中的“本次更改”按对象汇总并调用原生批量入口；新建后修改保留末版内容并撤回可见性，恢复后仍是同一对象。实际引用范围外的可见来源会阻止撤回；可一起撤回的引用闭合集合（含循环）在同一事务中结算，跨对象修改恢复如实返回部分结果。这不授予模型跨 Run 撤销权限。

以上边界已用于 Record、Todo 和 File 的创建、修改及对应单项撤销、撤回和恢复。任务级批量操作已接入；HTML 隔离预览及真实模型与目标平台验收仍未全部交付；最新进度与证据以[父 Issue #97](https://github.com/xuchen-cloud/project_mind/issues/97)及子 Issue 为准，不据此认定 M1 全部完成。

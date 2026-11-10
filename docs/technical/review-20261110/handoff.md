# Project Mind：问题、需求分组与实施进度

更新日期：2026-11-10。用途：供下一轮规划拆成工作包，再交给不同子 agent；本文不启动后续实现。

## 当前状态与交接原则

- 用户最新决定：**停止继续修改产品代码；保留已经修改的内容，不回退；先整理全部问题、新需求和进度。** 所有实施与审查子 agent 已停止。
- 基线：`fe9fe9c188f05c23bae369074446e38c0859a0c8`，当前分支 `develop`。本轮改动尚未提交、推送或发布；未关联新 Issue。
- 以下“已修改”仅指工作树存在实现。“局部验证通过”不等于原生联调、Windows 实机或整个工作包验收完成。
- **当前原生目录操作是未完成草稿。** 它引用的 `project_directory_changes_tests.rs` 尚不存在，测试构建会失败；普通构建也尚未验证。下一轮应先接管这个明确中断点，不将当前工作树当作可发布版本。
- wshobson/agents 的 `full-review` 已安装为 Codex 适配 skill，位于 [/Users/xuchen/.codex/skills/full-review/SKILL.md](/Users/xuchen/.codex/skills/full-review/SKILL.md)。来源提交为 `9c61ab243def98f72da12abd41cfcf5bcd91af9d`，安装校验通过。
- 主审流程完成 Phase 1、2，以及 Phase 3A 测试审查、3B 文档审查。用户已批准检查点，但随后要求先整理再规划；**Phase 4 与最终完整 review 收口尚未执行**。本文件是当前交接总表，不冒充完整审查通过报告。

基线审查去重发现 16 项代码/架构问题：8 项 P1、8 项 P2，无已确认 P0。下表中的新产品需求、待定位现象、测试设施及实施草稿风险单独记录，不混入这 16 项计数。P1/P2 表示审查风险等级，不表示用户新需求的重要程度。

## 分组总表

| 组 | 范围 | 问题/需求 | 当前进度 | 主要依赖 |
| --- | --- | --- | --- | --- |
| G01 | Record 块保存与排版 | F2、F5、F6；间歇保存错误、行距变大 | 已调查；未修复；排版根因未确认 | Record 保存与 canonical 契约 |
| G02 | 草稿与页面生命周期 | F1、F3、F4；历史切换、隐藏、关闭、淘汰时保留草稿 | 已复现关键机制；未修复 | G01 的快照/保存协议 |
| G03 | File 原生保存与恢复 | N1、N2、N3；死锁、恢复隔离、身份失配 | 已调查并部分复现；未修复 | 共享锁序、CAS、journal |
| G04 | Office 渐进打开 | PERF1–4；先首屏可用，再加载其余内容 | 已测量与审查；未实现渐进方案 | G03、G12；保留未加载内容 |
| G05 | Windows 开始录音失败 | N4；独立 DB 连接事务竞争 | SQL 探针复现；未修复；无 Windows 实测 | 原生数据库事务边界 |
| G06 | 会话列表速度与缓存 | S1、S2；轻量摘要、缓存复用、后台预取 | 已完成调用链审查；未修改 | DSH 摘要接口与生命周期 |
| G07 | 文件列表/文件树刷新 | 移除缺失导航项；手动与事件刷新 | 前端已改、局部测试通过；GUI 待验收 | 目录枚举与 dirty 通知 |
| G08 | 文件夹菜单与操作 | 右键、重命名、确认后移入回收站 | 前端已接；原生草稿未完成/未编译 | G03；前后端契约 |
| G09 | Office 缩放 | 三格式统一 50%–150% | 已修改、针对性测试与 Office 构建通过；GUI 待验收 | G04 改动后回归 |
| G10 | AI `@` 浮窗可读性 | 实色主题背景、清晰边界 | 已修改、完整性检查通过；Windows 待验收 | DSH UI 主题 |
| G11 | AI 临时文件隔离 | 中间文件进隐藏目录，最终产物进正常目录 | 实际提示词已接入、20 项测试通过；真实会话待验收 | DSH system prompt |
| G12 | 验证工具与文档收口 | 修复观察器、补边界用例、Windows 验收 | 已形成审查意见；未修改工具/产品文档 | 按各包变化运行必要验证 |
| G13 | 记录/文件跨归属移动 | 工作区↔项目、项目↔项目；可搜索目标弹窗 | 新需求已记录；未实施 | G01/G02/G03；共享菜单 |
| G14 | 拖入文件与版本更新 | 扩大区域；停留后更新版本；默认剪切 | 最终交互已记录；未实施 | G03/G07/G08/G15 |
| G15 | 历史版本命名与重要标记 | `V2（自定义名称）`；重要版本免自动清理 | 新需求已记录；未实施 | File 版本元数据与保留策略 |
| G16 | Record / Markdown Mermaid | 两类内容均可渲染；采用更美观的开源样式 | 现有能力核查与候选调研；未修改 | G01 代码语言保真、现有图表安全/导出 |

## G01：Record 块保存可靠性、行距与内容保真

用户现象：引入块后经常间歇保存错误，显示行距/段距比以前大。当前尚不能把所有现场错误归为同一个根因。

| ID | 等级 | 已确认机制与影响 | 证据 |
| --- | --- | --- | --- |
| F2 | P1 | 等待 editorRegister 时后台保存完成，旧正文被配上新 revision；后续编辑可能覆盖已保存的新正文 | 真实 hook/coordinator＋受控 IPC 时序复现 |
| F5 | P2 | Workspace 单条 Record 保存调用全局 flush；其他记录失败导致当前记录也报保存失败 | 真实调用链确认 |
| F6 | P2 | 不可重试校验错误堵住队首；修正内容仍排在失败任务后面，普通重试无法恢复 | coordinator 探针复现，UI 恢复入口核查 |

排版调查：默认 14px、line-height 1.6、段前 12px/段后 0，与引入 canonical 块前相同。StableRecordBlocks 增加 ID，未发现新增段落 wrapper。旧 HTML 归一化会裁剪边界空段落，canonical 保留它们，这可能影响首尾空白，但尚不足以解释用户的段间距变化。没有修改全局排版 token。

内容保真补充：7 个块 roundtrip fixture 中 6 个通过；代码块语言 `ts` 回读成 null，涉及 HTML 适配器缺少 Tiptap 读取语言时需要的 DOM 属性。此差异已复现，但未证明是用户间歇保存错误的来源。普通段落、hard break、空段落在隔离原生应用保存成功。复杂 AI preview 的 split/join 尚无失败样本，保留为未覆盖范围，不列成确定缺陷。

实施入口：[useCanonicalRecordEditor.ts](/Users/xuchen/project_mind/src/hooks/useCanonicalRecordEditor.ts)、[record-save-coordinator.ts](/Users/xuchen/project_mind/src/lib/record-save-coordinator.ts)、Workspace Record 保存页面、[record-document-html.ts](/Users/xuchen/project_mind/src/lib/record-document-html.ts)、[richTextStyle.ts](/Users/xuchen/project_mind/src/lib/richTextStyle.ts)。**本组未改源码。**

下一轮验收：正文与 revision 必须为同一快照；单条保存互不误报；明确未提交的校验错误可纠正重提，未知提交结果继续遵守幂等回执。排版用相同设置比较普通段落、hard break、空段落、列表、引用、表格的实际 DOM 与 computed style，再决定修改。补现场错误 code/message、Record key、requestId、base/headRevision，不能通过吞错解决。

详证：[前端质量审查](/Users/xuchen/project_mind/.full-review/01a-frontend-quality.md)、[测试审查](/Users/xuchen/project_mind/.full-review/03a-tests.md)。

## G02：历史切换、隐藏与关闭时保护草稿

| ID | 等级 | 触发与风险 |
| --- | --- | --- |
| F1 | P1 | 外部固定版本引用复用 File Tab，直接改变 version prop，绕过保存屏障，卸载 dirty Markdown/Office 编辑器 |
| F3 | P1 | 隐藏 QuickNote 变为 readonly 后 save 返回；此前保存错误被尾部 Promise 吞掉，关闭 flush 误报成功 |
| F4 | P1 | Project 关闭或 Overview LRU 淘汰未捕获/保留 QuickNote；延时 blur 保存可在卸载时被取消 |

状态：组件/实际编辑器的隔离复现已留存；完整原生退出场景尚未验证；**未实施修复**。

入口：[ProjectFileContent.tsx](/Users/xuchen/project_mind/src/components/document/ProjectFileContent.tsx)、[HomeQuickNote.tsx](/Users/xuchen/project_mind/src/components/home/HomeQuickNote.tsx)、[quick-note-transfer.ts](/Users/xuchen/project_mind/src/lib/quick-note-transfer.ts)、[App.tsx](/Users/xuchen/project_mind/src/App.tsx)、[ProjectContentLayoutView.tsx](/Users/xuchen/project_mind/src/components/project/ProjectContentLayoutView.tsx)。

验收：保存未完成时保留编辑现场；失败阻止破坏性卸载；成功后才完成切换/关闭；覆盖外部版本引用、隐藏状态、Project 关闭和超过驻留上限的 Overview 淘汰。与 G01 明确谁持有最新 snapshot；Office 的 active cell/IME 也必须捕获。引用版本菜单已有测试，不能代替外部 prop 切换入口。

## G03：File 原生锁序、恢复隔离与外部替换

| ID | 等级 | 机制 | 证据边界 |
| --- | --- | --- | --- |
| N1 | P1 | working 与版本恢复/提交的 fence/File lease 顺序相反；关闭等待 writer 时可形成三方死锁 | 生产 fence＋替代 mutex 的 macOS 探针；真实 File lease 三方集成待补 |
| N2 | P1 | 一个 working journal 遇到外部冲突，错误传播到全局恢复，阻断无关文件及 Workspace 重开 | 完整调用链确认；实际故障注入未执行 |
| N3 | P2 | 同字节原子替换后目录接受新物理身份，working 状态仍留旧身份，持续拒绝打开 | 隔离 macOS 原生 fixture 已复现，非 Windows 证据 |

状态：**三项均未修复**。G08 对同一恢复入口已有新增草稿，不能误认它修复了 N1/N2。

入口：[workspace_commit_fence.rs](/Users/xuchen/project_mind/src-tauri/src/workspace_commit_fence.rs)、[file_working.rs](/Users/xuchen/project_mind/src-tauri/src/file_working.rs)、[db/file_working.rs](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs)、[db/file_versions.rs](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs)、[db/project_directory_files.rs](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_files.rs)。

验收：真实锁和受控并发有界完成；A 文件恢复冲突时保留 A 的证据并允许无关 B/工作区可用；同内容替换后可重新打开，同时不同内容的旧保存仍被 CAS 拒绝。保留权限/实际归属、hash、回执、原子提交和恢复 BLOB；不得以删 journal 或跳过校验换取打开成功。

详证：[原生架构](/Users/xuchen/project_mind/.full-review/01b-persistence-architecture.md)、[安全完整性复核](/Users/xuchen/project_mind/.full-review/02a-security-integrity.md)、[N3 原生证据](/Users/xuchen/project_mind/.full-review/evidence/native/same-content-replacement/docx-simple-1.json)。

## G04：Office 先打开首屏，再逐步加载

用户明确要求：尤其改善 Windows 打开 Office 很慢的问题；先显示可用首屏，再加载其余内容；允许修改开源格式包源码。不是只提前出现一个 loading 窗口。

| ID | 等级 | 首屏前不必要的工作 |
| --- | --- | --- |
| PERF1 | P1 | XLSX 等全部工作表/used range、索引、公式与媒体准备好才返回模型 |
| PERF2 | P2 | DOCX 宿主完整解析/转换后，renderer 再完整解析，之后才分帧挂载 |
| PERF3 | P2 | PPTX worker 先生成全套 slide 模型/布局，renderer 再从原件重建 |
| PERF4 | P2 | XLSX 小范围读取在主线程 filter 整表 cells/rows，重复 O(N) 扫描 |

共同路径还包括 working 基线/恢复 BLOB 的整文件读取，以及写事务内 I/O，可能争用其他保存/录音写入。**尚未实施渐进加载，也没有量化优化收益。**

| macOS 可见原生单次样本 | 首次稳定内容 | 其中 working open |
| --- | ---: | ---: |
| DOCX，约 20 页 | 1.725s | 0.917s |
| XLSX，新增 10,000 行及公式 | 6.151s | 3.886s |
| PPTX，40 页 | 1.859s | 0.791s |

这是 macOS arm64、优化前端＋debug Rust、未清系统缓存的 fixture 测量，不是 Windows、release 或 p95。原始 45s 超时来自旧 benchmark 观察器漏接口，不是 Office 打开耗时。

下一轮先确定宿主与引擎的首屏/增量读取契约，再按 DOCX、XLSX、PPTX 分包。入口为各格式包的 engine、renderer-host、renderer 以及 File working open。可复用已有按需范围/延迟布局能力，不能只在已经全量准备的模型上做“懒渲染”。

关键验收：延迟尾部数据不阻止首屏可用；未加载部分不当空内容序列化；仅看首屏后连续两次编辑保存、关闭重开，两次编辑及从未访问的尾部内容均保留。公式依赖、media/关系和未修改 OOXML parts 保真。具体首屏预算在新规划中用代表性 Windows release 样本确定。

详证与按格式入口：[性能审查](/Users/xuchen/project_mind/.full-review/02b-performance.md)、[测量限定](/Users/xuchen/project_mind/.full-review/evidence/measurement-notes.md)。G09 只是缩放变更，不算本组性能修复。

## G05：Windows 点击“开始录音”时数据库失败

用户已明确失败发生在点击开始，不是录音结束保存。N4（P2）：性能改造后 voice 使用独立 DB 连接；Project 草稿的 DEFERRED 事务先 SELECT 再 INSERT，另一连接写入时可在升级写锁阶段立即失败。双 SQLite 连接、相同 SQL 的探针在已有 5s busy timeout 下约 0.020ms 报 locked。

该证据不是生产 rusqlite 集成，更不是 Windows 实机；用户的原始错误、目标是 Project 还是 Workspace、部署版本尚缺。不能认定它就是现场唯一根因。**未修复。**

范围：[db.rs](/Users/xuchen/project_mind/src-tauri/src/db.rs) 中 voice_session_create、[voice/commands.rs](/Users/xuchen/project_mind/src-tauri/src/voice/commands.rs)、[voice/runtime.rs](/Users/xuchen/project_mind/src-tauri/src/voice/runtime.rs)。下一步验证合适的写事务获取方式，保留现有单录音拥有者和幂等约束；避免仅加 timeout。

验收：真实两连接 Project 录音开始与普通写入竞争；Workspace target 对照；失败不留下半草稿；Windows 记录 SQLite extended code、capture 是否启动及应用版本。db.rs 与 G08 的接线修改由一个集成者协调。

## G06：会话列表按轻量索引加载与缓存复用

S1（P1）：list 强制全工作区 catalog 元数据扫描；新 scope 注册清掉共享标题缓存；当前 scope 的冷标题校验串行读取完整 JSONL 并构造 projections；这些等待占用全局 native runtime mutex。纯历史列表还耦合默认模型/密钥执行环境就绪。

S2（P2）：侧栏手工 get/set Query 缓存、挂载/focus 无条件刷新，没有 in-flight 去重与统一 staleTime；切走只忽略返回，底层请求继续；新项目无摘要预取。

已有 host 复用和部分缓存，因此不能说每换项目都重启 Node，也不是 catalog 扫描直接读取所有项目正文。**只读审查完成，无会话耗时实测、无源码修改。**

建议范围：[ProjectSidebarSessions.tsx](/Users/xuchen/project_mind/src/components/home/ProjectSidebarSessions.tsx)、[dshAssistantApi.ts](/Users/xuchen/project_mind/src/services/dshAssistantApi.ts)、[project-prefetch.ts](/Users/xuchen/project_mind/src/lib/project-prefetch.ts)、[dsh_assistant.rs](/Users/xuchen/project_mind/src-tauri/src/dsh_assistant.rs)、[project-workspace.mjs](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/project-workspace.mjs)。

先交付带 revision 的轻量摘要读取及统一 Query 接入，再在 Workspace ready 后有界预取当前/最近项目。用户希望“工作区打开后准备好列表、切项目直接取”应以摘要实现，不把全部聊天全文预载搬到启动阶段。

验收：首次 A、首次 B、A 回访、focus、快速 A/B/A 分段测量；正文体积变大但元数据数量不变时，常规列表不随全文体积增长。跨 scope/generation 正确、重命名/置顶/归档/删除/外部变化可见，旧返回不污染新工作区；读取历史不依赖不必要的模型执行准备。

完整链路与实现建议：[会话列表审查](/Users/xuchen/project_mind/.full-review/session-list-review.md)。

## G07：文件树与文件列表刷新、缺失项清理

需求：原件不存在时从正常列表/文件树移除，不持续展示“缺失”；外部删除能被刷新发现，提供刷新按钮。此处移除导航项，保留 DB 身份、历史、恢复内容、引用和未保存编辑现场。

已修改：项目/Workspace 共用手动刷新；dirty 通知按 owner/binding 核对受影响父目录；枚举登记 File 的祖先/父目录，正确处理深层缺失；读取错误不当作已删除；隐藏确认缺失项；同路径不同 File ID 不串 presence 状态。普通 File 右键菜单基线实际可用，新增回归与旧 Workspace 异步菜单取消；不能把基线概括为“所有文件菜单失效”。

文件：[HomeProjectFiles.tsx](/Users/xuchen/project_mind/src/components/home/HomeProjectFiles.tsx)、[ProjectDirectoryBrowser.tsx](/Users/xuchen/project_mind/src/components/home/ProjectDirectoryBrowser.tsx)、[useFileNavigationRefresh.ts](/Users/xuchen/project_mind/src/components/home/useFileNavigationRefresh.ts) 及相应测试。

状态：前端已改、局部验证通过；新代码原生 GUI/Windows 验收未做。G07/G08 共用文件与测试：refresh 11、directory actions 10、Browser 37，另复用未变 Sidebar 17，共 75 项有效通过记录；TypeScript 检查通过。API mock 不能代表文件系统操作验收。

剩余验收：平铺/展开树、深层目录、外部删除/恢复、读取失败、切工作区、同路径新文件；刷新后导航清理但编辑草稿与恢复资料仍可保留。沿用既有滚动边缘遮罩。详见 [文件树工作包](/Users/xuchen/project_mind/.full-review/file-tree-change.md)。

## G08：文件夹右键、重命名与系统回收站

用户已明确：**删除文件夹前确认，整个文件夹移入系统回收站。** 含未纳管普通内容；这不是现有单 File 的“取消纳管”行为。

前端已接：鼠标右键和键盘菜单、内联重命名、整目录删除确认；prepare/reprepare 比较物理身份、后代集合与 revision；成功刷新，失败保留名称草稿并展示错误；scope 切换取消旧操作。新增 [useDirectoryActions.tsx](/Users/xuchen/project_mind/src/components/home/useDirectoryActions.tsx) 与测试、扩展 [projectDirectoryApi.ts](/Users/xuchen/project_mind/src/services/projectDirectoryApi.ts)。

原生已有草稿：prepare/rename/delete 三命令、同父目录无覆盖 rename、路径前缀 rebase、原路径直接送 OS Trash、保留 File ID/历史/working 数据并标 missing、intent/receipt/恢复接线。活动后代编辑 session 存在时拒绝操作，让用户先经既有保存 guard 关闭相关文件（含独立窗口）；不自动关闭或丢弃草稿。这是当前草稿的首版约束，不代表未来必须保持该限制。

**明确的中断点：**

1. [db/project_directory_changes.rs](/Users/xuchen/project_mind/src-tauri/src/db/project_directory_changes.rs) 引用的测试模块尚未创建；不能运行拟定的 `project_directory_changes::tests`。
2. 未运行任何 cargo check/build/test，类型、SQL、平台差异均未验证。
3. 空目录/从未登记 File 的 DB 可能尚无懒初始化目录表，当前查询需核对。
4. prepare 当前会触发恢复，需明确只读准备与恢复副作用的契约。
5. 目录恢复错误目前传播至启动/全局 File 恢复，存在延续 N2 扩大阻断范围的风险。
6. journal 崩溃边界、事务耐久性、路径归属及 DTO 尚未完成最终复核。

原生改动清单：上述 DB 新模块、[project_directory_changes.rs](/Users/xuchen/project_mind/src-tauri/src/project_directory_changes.rs)、[db/file_versions.rs](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs)、[db.rs](/Users/xuchen/project_mind/src-tauri/src/db.rs)、[lib.rs](/Users/xuchen/project_mind/src-tauri/src/lib.rs)。仅 rustfmt 解析/格式化和 diff 检查通过。无真实 rename、Trash、崩溃恢复验收。

下一轮接管后优先完成该中断包。保持原路径进回收站，使 OS 恢复回到业务目录；rename 保留 File/版本 ID、版本号和 hash。验证 null owner、活动 session、同名/大小写冲突、祖先交换、symlink、跨归属、owned 隐藏历史目录、未纳管后代、重复请求和每个崩溃阶段。与 G03 统一锁序和恢复隔离；G07/G08 前端宜由同一 agent 接管。

## G09：Office 缩放统一 50%–150%

用户最终选定上限 **150%**，不再是 200%。DOCX/XLSX/PPTX 的按钮、预设、输入、快捷键、手势、fit 和视图恢复统一约束。

已修改三个格式的现有构建适配脚本，XLSX 包括 Univer scene/快照/切表的旁路约束；保留 100% 默认。源锁验证与针对性测试通过；11 项初始测试、补断言后 6 项受影响重跑，不把二者相加成 17 个独立用例。主流程随后执行 `npm run build:office` 成功。

状态：源码与格式产物已更新；当前最终前端 bundle/原生安装包、新缩放 UI 与 Windows 视觉验收未完成。构建成功不能代表应用里所有入口已实际操作通过。改动文件、命令和结果见 [缩放记录](/Users/xuchen/project_mind/.full-review/zoom-change.md)、[Office 构建日志](/Users/xuchen/project_mind/.full-review/evidence/ui-office-build.log)。该包记录的自查不代表整个 full-review 已完成。

## G10：Windows AI `@` 候选浮窗清晰度

原浮窗已经声明 blur，但浅/深主题使用透明填充，不能保障 Windows 下清晰。已在实际 [MenuView.module.css](/Users/xuchen/project_mind/packages/dsh-ui/upstream/client/ui-input-trigger/src/client/MenuView.module.css) 改为主题实色；高对比模式使用系统背景和轮廓。共享该浮窗的 `/` 候选也应用相同样式。更新了 [provenance.json](/Users/xuchen/project_mind/packages/dsh-ui/provenance.json) 的补丁来源/哈希。

完整性测试 5/5、UI standards、diff 检查通过；Windows WebView2、浅/深色和高对比视觉尚未验收。下一轮验证文字不透底、选择/滚动提示清晰且键盘操作不退化。详见 [浮窗改动记录](/Users/xuchen/project_mind/.full-review/mention-change.md)。

## G11：AI 中间文件与用户最终产物分离

最终规则：AI 生成的中间脚本、临时测试文件和临时数据放入会话工作目录的隐藏 `.mind-tmp/<session-id>/`。正常项目/工作区目录用于用户要求的最终产物或明确要求保留的文件；准备好的最终产物才移出 scratch。应用 `.project-mind` 保留为内部元数据目录。

已在真实 embedded DSH system prompt 装配路径接入，新会话和已有会话后续步骤均覆盖；保留工具 cwd 的相对路径语义，不自动搬移/清理既有文件。原生扫描与树枚举已有隐藏目录及后代排除，未新增另一套过滤。

改动：[mind-cli.mjs](/Users/xuchen/project_mind/packages/dsh-assistant/scripts/mind-cli.mjs)、[mind-cli.test.mjs](/Users/xuchen/project_mind/packages/dsh-assistant/test/mind-cli.test.mjs)。20/20 针对性测试通过；没有真实模型执行/GUI 验收。它是模型指令策略，不是文件写入拦截器；运行中的旧 host 要加载更新后的 runtime 才生效。

下一轮验收：新/恢复会话、项目/Workspace 均按路径写临时脚本，树和文件列表不出现中间物；用户明确保留或最终交付的文件正常出现。详见 [scratch 记录](/Users/xuchen/project_mind/.full-review/session-scratch-change.md)。

## G12：验证观察器、文档与平台证据

测试设施确认缺陷（P2，独立于 16 项产品问题）：[native-page.tsx](/Users/xuchen/project_mind/scripts/office-performance/native-page.tsx) 主要观察旧 file_office_inspect/save，漏当前 working open/save。仅临时生成的 dist 观察器补了 open 用于基线测量，**受跟踪源码未修复，保存 observer 未适配**。下一轮先按当前响应/回执形状修正工具，再使用它验收真实保存；不能只加入命令名就宣布保存验证通过。

文档补充项来自 [Phase 3B](/Users/xuchen/project_mind/.full-review/03b-documentation.md)：Record 正文/revision 同快照契约（复用 F2）；不可重试失败的真实恢复入口（复用 F6）；voice 独立连接的并发边界（复用 N4）；旧 Office 性能文档与当前 working-open 路径适用性；原生 recovery-read 已有但用户入口尚未接入，恢复副本只含最后成功提交，不含仍在编辑器内的输入。不能靠改文档宣称这些代码问题已解决。

验收原则：将已复现错误的探针改成正确行为回归；探针“通过”可能表示成功复现 bug。使用真实 File lease、DB 连接及崩溃子进程验证对应边界；按改动范围复用已有通过记录。Windows 实机缺失时明确标未验证。当前纯文档交接不运行新构建/全量测试。

后续完整 review 还需框架/交付约束审查及最终 Standards/Spec 收口。仓库无 CI 是已有项目决定，不额外列作缺陷；本轮没有发布行为。

## G13：记录与文件在工作区/项目间灵活移动

新需求，**未实现**：记录和文件列表右键菜单都提供“移动到”；支持当前工作区根级→项目、项目→工作区根级、项目 A→项目 B。目标选择弹窗可以快速搜索项目或工作区目标，清楚展示归属。

目前只做入口初查：存在 [projectFileApi.move](/Users/xuchen/project_mind/src/services/projectFileApi.ts:33) 等底层能力，但其相对路径移动不能直接等同于跨 owner 业务移动；现有 File relocate 是原件重定位相关能力，也不能直接当作完整需求已实现。

下一轮先确认 Record/File 的归属与稳定身份契约，再接菜单/搜索弹窗。建议保留对象 ID、版本、历史和引用；移动成功后源/目标列表及打开页同步，失败保留原位置与编辑内容。存在未保存编辑时先完成合适的保存屏障，不把旧 owner 下的异步保存写入新归属。覆盖同名目标、切换工作区、重复提交、跨窗口和磁盘/DB 中途失败。

规划待确认：是否还要求**不同物理 Workspace 之间**移动，以及批量移动、标签归属和冲突命名规则。本轮明确的工作区根级↔项目双向需求不等待这些可选扩展才实现。共享列表/menu 与 G07/G08/G14 避免多人同时编辑。

## G14：扩大拖入区域、停留后更新版本、默认剪切

用户最终交互以下表为准，取代此前“覆盖选择”或“拖到行上立即更新”的中间描述。

| 拖拽状态 | 松手结果 |
| --- | --- |
| 拖入文件区域空白处 | 新增文件 |
| 拖到已有文件行，尚未出现更新提示就快速松手 | 新增文件 |
| 在同一已有文件行停留约 0.5–1 秒，行上已显示“更新此文件版本” | 更新该 File 的版本 |
| 离开该行或换到另一文件 | 清除旧更新状态；在新目标重新计时 |

整个文件内容区域都应可接收拖入，包括列表/树的空白和滚动区域，解决用户只能拖到很小一行的体验。悬停达到阈值后提供明确目标高亮和“更新此文件版本”提示；**只有提示已出现时松手才执行更新**。具体阈值由下一轮统一为约 0.5–1 秒内的值，尚未指定精确毫秒数。

更新版本应沿用现有 File 身份，保存旧历史，将拖入内容作为该 File 的新版本；不能误建另一 File 或直接覆盖旧历史。源文件名不同不应自动改变目标身份。已有编辑现场/当前版本已变化时需通过正常冲突与保存协议处理。

默认剪切：目标新增/新版本持久化成功并确认内容可用后，再删除原位置源文件。源删除失败时保留导入成果，清楚提示源仍存在；用户已明确可以接受这种情况。目标失败时保留源文件。相同物理文件/目标已经在工作区、跨卷、权限失败需避免误删唯一副本。源删除具体是否进回收站在规划中确定，不能混用 G08 已确认的“文件夹进回收站”语义。

状态：**未修改拖拽代码、未删除任何用户源文件。** 初查 [ProjectSidebar.tsx](/Users/xuchen/project_mind/src/components/layout/ProjectSidebar.tsx) 已有 aside 级 DOM drop 和 native 窗口坐标命中，故“小区域”还需验证实际布局/坐标换算/平台事件，不宜只多绑一个 onDrop。入口另有 [useWindowFileDrop.ts](/Users/xuchen/project_mind/src/hooks/useWindowFileDrop.ts)、[useDocumentImportFlow.ts](/Users/xuchen/project_mind/src/hooks/useDocumentImportFlow.ts)、[documentVersionAction.ts](/Users/xuchen/project_mind/src/services/documentVersionAction.ts)。

验收：空白/快速/停留三条路径、计时边界、滚动及目标切换、树/列表、Windows 坐标与不同缩放、重复事件只执行一次、版本历史完整、目标失败源保留、源清理失败可见。多文件落到单行、格式不一致、相同内容是否生成空版本需在规划中明确。

## G15：历史版本自定义名称与重要版本保护

新需求，**未实现**：保留 V1/V2 等版本号，后面可加自定义名称，例如 `V2（根据评审意见修改）`、`V3（提交客户版）`。修改的是该历史版本的显示名称/备注，不应改版本号、身份或内容 hash。

历史版本支持“重要/星标”标记。被标记的版本是有意义的版本，自动归档整理、合并、覆盖或容量清理均应保留它；保护必须在原生保留策略生效，不能只画星标。名称和标记应在重开、文件/目录改名及移动后保留，并适用于 G14 产生的新版本。

入口初查：[FileVersionHistory.tsx](/Users/xuchen/project_mind/src/components/document/FileVersionHistory.tsx)、[FileVersions.tsx](/Users/xuchen/project_mind/src/components/document/FileVersions.tsx)、[file-types.ts](/Users/xuchen/project_mind/src/lib/file-types.ts)、[db/file_reads.rs](/Users/xuchen/project_mind/src-tauri/src/db/file_reads.rs)、[db/file_working.rs](/Users/xuchen/project_mind/src-tauri/src/db/file_working.rs)、[db/file_versions.rs](/Users/xuchen/project_mind/src-tauri/src/db/file_versions.rs)。现有 version `name` 与物理版本文件命名有关；不能未经建模就直接复用为用户标签，否则文件改名可能覆盖自定义名称。

验收：名称编辑/清空/重开持久化；版本号始终可见；标记后的版本在自动整理/容量边界下仍能读取恢复，内容不被新保存覆盖；文件改名、跨归属移动保留标签与标记。规划待确认：是否允许手动删除重要版本、取消标记后的清理规则、Record 历史版本是否同步支持。本条明确对象为 File 历史版本。

## G16：记录与 Markdown 的 Mermaid 渲染及美化

新需求：Record 和 Markdown 文档均支持 Mermaid 图形渲染；从 GitHub 选择更美观的样式，统一字体、线条、配色、节点间距与浅/深主题，避免直接沿用原生默认视觉。**本轮仅调查和记录，不修改渲染器。**

现有能力：Markdown 包已经在 rich/split/preview/打印路径渲染实际 Mermaid SVG，含错误显示、异步旧结果丢弃和资源安全处理；[mermaid.ts](/Users/xuchen/project_mind/packages/markdown-editor/src/genoffice/editor/mermaid.ts) 当前明确使用 `theme: 'default'`。因此应复用现有实现，检查用户实际入口并改善主题，而非重复搭建一个 Markdown 渲染器。Record 的实际富文本接入尚未专项完成核查；G01 中代码语言回读丢失可能影响 fenced mermaid 识别，需一起验证。

选型与实现验收：保留 Mermaid 源码可编辑并可保存/重开；常见流程图、时序图、中文和长标签可读；无效语法保留源码及错误；图表库按需加载；切文档不显示旧异步图；Record/Markdown 视觉一致。沿用现有严格 SVG/资源边界与既有导出能力；仅加宿主 CSS 可能无法影响图片/SVG 导出，主题需进入实际渲染结果。

### GitHub 样式候选调研

推荐作为视觉与主题方案候选：[lukilabs/beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid)，2026-11-10 GitHub API 查询为 **11,271 stars**。已核对 README 与 [MIT LICENSE](https://github.com/lukilabs/beautiful-mermaid/blob/main/LICENSE)；后续复用代码应保留相应版权和许可声明。本轮没有安装该依赖或复制其代码。

它提供 15 个主题、CSS 自定义属性与前景/背景双颜色派生机制。建议下一轮先比较 `zinc-light` / `zinc-dark` 的克制视觉，以及 `github-light` / `github-dark` 的蓝色强调，按本项目设计 token 调整。可从仓库 README 的示例和 [作者演示](https://agents.craft.do/mermaid) 进入视觉验收；本轮只核对文档，未运行演示或完成目视选型。[主题说明](https://github.com/lukilabs/beautiful-mermaid/blob/main/README.md#theming)

兼容性边界：这是 SVG 渲染库，不是给现有 Mermaid 直接挂上的一张 CSS。其 README 当前列出 6 类图形；不能假定覆盖完整 Mermaid 语法。下一轮优先评估把选中的配色/线条/节点样式适配到现有 Mermaid 渲染结果，保留现有语法和导出；只有明确兼容范围并验证后才决定是否更换引擎。复杂图同步布局是否阻塞主线程也需测量，不采用 README 的速度宣传作为本项目性能证据。[功能与接入说明](https://github.com/lukilabs/beautiful-mermaid/blob/main/README.md#features)

## 后续拆包与并行边界

1. **先接管 G08 的中断草稿。** 当前工作树有明确缺失测试模块；新规划需决定完成该包的时间与负责者，保留已有改动，不从一个假定可编译状态开始。
2. 数据安全优先：G01/G02、G03、G05 可分别设计，但 App/共享保存协议和 db.rs 接线由集成者协调。G03 与 G08/G13/G14/G15 的 File 锁、journal、版本元数据变更不能各自发明不同协议。
3. G04 先统一首屏与保存协议，然后格式实现可拆三人；同格式的 G09 构建适配和验证由该格式负责人复用。G06 可与 Office 独立推进；G11 已改的 prompt 文件应保留。
4. G07/G08/G13/G14 共享列表、菜单和目录 API，宜一人负责前端集成；G13/G14/G15 的原生工作在明确接口后分派，避免并行修改同一大型 File 模块。
5. G16 可独立做主题候选/视觉方案；正式接入 Record 时与 G01 共享代码块语言契约，Markdown 部分复用现有包。G10 是已成形的小改动，进入集成视觉验收即可。
6. G12 按每包安排回归与文档更新；原生/GUI 集中串行运行，复用仍有效的结果。当前仅整理，不自动开启这些工作包、Issue 或发布流程。

## 已有验证与保留材料

| 材料/检查 | 当前可用结论 | 不能推导出的结论 |
| --- | --- | --- |
| F1/F2/F3/F4/F6 前端探针 | 已复现相应机制；源文件和日志已保留 | 产品缺陷已修复、完整原生退出安全 |
| N1 锁级、N4 SQLite 探针 | 特定锁序/事务机制有依据 | Windows 现场唯一根因 |
| N3 同内容外部替换原生 fixture | macOS 原生 reopen 确实失败 | Windows 同场景已测 |
| 三格式原生首屏样本 | 当前基线的有限性能证据 | release/p95/Windows 或保存验收 |
| G07/G08 前端 75 项有效记录＋tsc | 对应前端行为/类型通过 | 原生目录操作已完成 |
| G09 针对性测试＋Office 构建 | 范围转换/格式构建通过 | 最终安装包与全部手势目视通过 |
| G10 完整性 5/5、UI standards | CSS 来源及规则一致 | Windows 视觉通过 |
| G11 prompt 测试 20/20 | 实际装配路径与规则接线通过 | 每次真实 AI 执行必定遵守 |
| G08 rustfmt/diff | 两个新模块可被格式化解析 | cargo 编译/测试通过 |

基线原生构建曾因磁盘不足失败；按用户授权清理可再生成 Rust 增量缓存后构建成功。这个成功早于未完成目录原生改动，不能用于证明当前工作树可编译。停工时无本轮运行中的构建/测试/GUI 进程。

总审查材料位于 [.full-review](/Users/xuchen/project_mind/.full-review)：[Phase 1](/Users/xuchen/project_mind/.full-review/01-quality-architecture.md)、[Phase 2](/Users/xuchen/project_mind/.full-review/02-security-performance.md)、[Phase 3A](/Users/xuchen/project_mind/.full-review/03a-tests.md)、[Phase 3B](/Users/xuchen/project_mind/.full-review/03b-documentation.md)、各实施包记录与 evidence。报告若有早期“待测”或旧阶段状态，以本文件明确补充的后续证据和停工状态为准；保留原始记录供追溯。

两份开始前已有的未跟踪文档 [latest-fixes-review-20261028.md](/Users/xuchen/project_mind/docs/technical/latest-fixes-review-20261028.md)、[systemic-failure-audit-20261028.md](/Users/xuchen/project_mind/docs/technical/systemic-failure-audit-20261028.md) 原样保留，不算本轮新增成果。已有暂存的 Phase 2A 报告亦保留，未重置暂存区。

# AI 工作上下文：交付计划与验收

更新：2026-10-09。状态：已进入实施，按本次交付审查调整执行顺序。产品行为见[主规格](ai-work-context-spec.md)，实现规则见[工程契约](ai-work-context-engineering-spec.md)。本文件保存工作包定义与验收标准；负责人、进度和关闭状态只在[父Issue #97](https://github.com/xuchen-cloud/project_mind/issues/97)及子Issue维护。

## D1 交付批次与顺序

| 批次 | 交付范围 | 工单 | 验收 |
| --- | --- | --- | --- |
| M0 | Pi、模型、工具与安装包技术验证 | AI-01 | 无开发环境的安装包与受限工具验证 |
| M1 | Project知识维护/渐进读取、会话、自主操作、Record版本、HTML、CLI/MCP | AI-02～10、16～19 | A01～20、A25～55、A59～76 |
| M2 | Workspace分层Overview与长期记忆 | AI-11～12 | A21～22、A56～58 |
| M3 | 外部Agent适配器和可配置任务菜单 | AI-13～14 | A23及各工单fixture |
| M4 | 应用关闭后的WorkspaceHost | AI-15 | A24及Host恢复fixture |

从当前实现继续，先完成安装资源与真实模型接入，再让用户在 Project 助手中问到真实资料；随后接通可撤销的 Record/Todo/File 操作、HTML、知识维护、会话检索和 CLI/MCP，完成 M1 安装验收。M2～M4 继续交付，父 Issue 不在 M1 结束时关闭。具体按 D2c 的 R01～R16 执行，其中 R07 后、R08 前安排 R04d～g 助手 GUI 收口，不重新从 AI-01～19 的编号顺序开发。

D2 的依赖是整项交付依赖，不能解释成“上游 Issue 关闭前不得使用已验证的共享服务”。例如，最小 Host 不等完整知识维护，读工具不等所有写工具，会话消息读取不等 HTML；各自的整项验收仍保留。

M0 区分技术可行性与平台发布就绪。真实模型/SDK 的关键能力验证失败时，暂停依赖该能力的接入并解决具体失败；缺少目标设备时仍可推进确定性实现与接入，但不能将 M0 标通过、宣称安装可用或开放未验证能力。不更换 Pi，不要求最终用户预装 Node。

## D2 工作包与估算

下表是最初完整范围的估算，包含开发与相关测试，不含等待账号/设备；M0～M1 合计62–98净工程日。它不是当前剩余工时，也不应乘此前粗估完成率推算日期。后续按 R 包的实际缺口和完成证据更新剩余量。M2～M4 独立，不阻塞 M1 发布，但仍属于 #97 的最终交付。

| ID | 工作包 | 依赖 | 估算 |
| --- | --- | --- | --- |
| [AI-01 #98](https://github.com/xuchen-cloud/project_mind/issues/98) | Pi与Node安装包、模型映射、受限工具技术验证 | 无 | 2–4日 |
| [AI-02 #99](https://github.com/xuchen-cloud/project_mind/issues/99) | 领域契约、迁移、作用域和共享服务 | 无 | 3–5日 |
| [AI-03 #100](https://github.com/xuchen-cloud/project_mind/issues/100) | 源内容提取、全文索引、版本与变更事件 | 01、02、16 | 4–6日 |
| [AI-04 #101](https://github.com/xuchen-cloud/project_mind/issues/101) | Overview/知识节点、渐进读取与增量上下文 | 02、03 | 7–11日 |
| [AI-05 #102](https://github.com/xuchen-cloud/project_mind/issues/102) | Pi Host、持久会话、Overview批处理worker | 01、02、04 | 5–8日 |
| [AI-06 #103](https://github.com/xuchen-cloud/project_mind/issues/103) | Project助手、知识管理入口与来源预览 | 04、05、16 | 4–7日 |
| [AI-07 #104](https://github.com/xuchen-cloud/project_mind/issues/104) | 新建/修改成果stage/commit、引用与恢复 | 02、03、05、16 | 6–9日 |
| [AI-08 #105](https://github.com/xuchen-cloud/project_mind/issues/105) | 会话分段摘要、历史检索与自主成果沉淀 | 05、06、07、19 | 4–6日 |
| [AI-09 #106](https://github.com/xuchen-cloud/project_mind/issues/106) | 本地bridge、CLI/MCP渐进读取/版本与连接 | 02、04、07、08、17、18、19 | 6–8日 |
| [AI-10 #107](https://github.com/xuchen-cloud/project_mind/issues/107) | M1整体验收、安装包、帮助与发布 | 03～09、16～19 | 3–5日 |
| [AI-11 #108](https://github.com/xuchen-cloud/project_mind/issues/108) | Workspace助手与分层Overview | 10 | 4–7日 |
| [AI-12 #109](https://github.com/xuchen-cloud/project_mind/issues/109) | Workspace长期记忆、依赖失效与增量维护 | 03、07、08、11 | 5–8日 |
| [AI-13 #110](https://github.com/xuchen-cloud/project_mind/issues/110) | 外部Pi CLI/Claude Code适配器和能力探测 | 10 | 5–8日 |
| [AI-14 #111](https://github.com/xuchen-cloud/project_mind/issues/111) | 可配置任务菜单和外部连接配置导出 | 09、13 | 2–4日 |
| [AI-15 #112](https://github.com/xuchen-cloud/project_mind/issues/112) | 独立WorkspaceHost与无界面运行 | 10、12 | 6–10日 |
| [AI-16 #113](https://github.com/xuchen-cloud/project_mind/issues/113) | Record块身份、CAS、版本历史和并发编辑 | 02 | 7–11日 |
| [AI-17 #114](https://github.com/xuchen-cloud/project_mind/issues/114) | File修改、File Version复用与故障恢复 | 02、07 | 3–5日 |
| [AI-18 #115](https://github.com/xuchen-cloud/project_mind/issues/115) | HTML交互稿创建、源码续改与隔离版本预览 | 06、17 | 4–7日 |
| [AI-19 #116](https://github.com/xuchen-cloud/project_mind/issues/116) | 任务确认/主动自动执行、Todo修订与跨成果撤销恢复 | 07、16、17 | 4–6日 |

<a id="delivery-audit"></a>

## D2a 2026-10-08 交付审查快照

审查基线：`codex/ai-enhancement@e26380d`；主分支 `842ee9b`。这是代码与工单核对的时点快照，不替代 GitHub 的实时状态。19 个子 Issue 中只有 #99 已关闭并合入 main；不能把内部服务的测试通过当作用户功能完成，也不能把其余18项一律视为从零开始。

下表及 F1～F8 保留审查当时的发现，不能作为当前未完成清单。后续提交是否已解决、仍缺产品入口或仅缺平台验收，以关联 Issue 的最新执行摘要和证据为准；沟通中的粗略功能进度不作为验收完成率或剩余工时依据。

| 范围 | 已有、应直接复用 | 仍缺的交付部分 |
| --- | --- | --- |
| AI-02 / #99 | Workspace 代际、真实归属、scope grant、设置/说明、原子 receipt/outbox | 不重开基础框架任务；下游按原契约接入 |
| AI-01 / #98 | 固定 Pi/Node、受限探针、工具往返、checkpoint/取消/搬迁恢复 fixture | 真实 Provider、生产 Host 入口、完整资源分发与各目标安装验收 |
| AI-16 / #113 | canonical Record 保存、稳定块、CAS、历史/比较/恢复 UI、窗口协调；工单记录有 macOS debug 实包证据 | Windows 安装和完整视觉验收；经真实 run/connection 调用 patch/restore |
| AI-03 / #100 | 六类来源、FTS/中文回退、版本分页、原子变更、持久队列、registry、开发态调度 | 正式读取工具、普通启用路径、旧 File 恢复入口、生产 worker 分发、会话来源 |
| AI-17 / #114 | File journal、CAS、精确文本修改、上传、历史恢复、GUI 版本提交 | 新建成果对接、真实调用身份、恢复/比较/诊断 UI、撤销与平台验收 |
| AI-04 / #101 | P5a～d：Overview/节点版本、真实引用、pending、L0/knowledge 读取、可续目录扫描 | 真实生成与覆盖核算、分批发布冲突修正、原文回退、纠正管理、调度 |
| AI-05～10、18～19 | DTO、会话/成果表、CLI 离线能力清单等局部接缝 | Host/助手产品闭环、成果/统一撤销、HTML、会话知识、CLI/MCP、整体验收 |
| AI-11～15 | 可复用上述基础；完整需求已定义 | Workspace 知识/记忆、两个外部运行时、菜单、独立 Host 尚未交付 |

P1 File 恢复、P2 原生来源核对、P3 大 Transcript、P5a～d 的阶段证据分别保存在[来源记录](../technical/source-extraction-implementation.md)和[Overview 记录](../technical/ai-overview-implementation.md)。原 P4/P6 的未接入工作归入下面 R 包；不重新执行已完成的 P 包，也不再通过不断增加 P5 子包延后产品接入。

### 必须解决的问题

| 编号 / 类型 | 证据与实际影响 | 最小处理 / 归属 |
| --- | --- | --- |
| F1 发布阻塞 | `package.json` 的 `build:desktop` 只构建/分发 Record worker；`stage-record-runtime.mjs` 要求已有固定运行时收据。两个发布 workflow 只有根目录 `npm ci`，没有准备该运行时或独立 Pi 包；干净 checkout 无法按现流程得到完整安装资源。脚本默认宿主架构，也不能代表 macOS 交叉目标 | R01 显式传目标，按现有 manifest 准备一次 Node，构建/分发 Record、Source、Pi；修现有发布工作流，不另建发布平台 |
| F2 接入缺口 | `agent/commands.rs` 状态固定 `runtime_available:false`；生产 `protocol.mjs` 所有 run 返回不可用，只有独立 probe 能运行。`source_maintenance.rs` 受 debug+开发环境变量限制；`mind.rs` 只有离线发现 | R02～04 接通真实链路；不要仅翻 capability 布尔值，也不要继续新增占位框架 |
| F3 契约冲突 | E4 要求 partial 后续跑，但现 `agent_overview_versions` 的唯一键和 `agent_overview_publish` 按 scope/targetSeq/policy/correction 拒绝第二份不同 payload。同一目标水位分成两次预算批次时，第二次无法发布。本次以现有表定义在 SQLite 复现唯一约束冲突；尚未执行完整 Host 场景 | R10a 区分“业务变化水位”和“维护批次身份”；同批重放仍幂等，不同续批允许 CAS 产生下一版。不能靠制造业务日志或提高水位绕过 |
| F4 老用户使用缺口 | `db/source_files.rs::source_file_plan` 遇未登记旧 File hash 返回 SourceNotReady。`documentVersionAction.ts` 已有显式“登记为新版本”恢复动作，但助手/知识状态没有引导到它 | R02b 复用现有动作，保留未知旧历史，登记后重排索引并恢复问答；不静默补造历史 hash，不新建迁移框架 |
| F5 成果闭环缺口 | `agent/outputs.rs` 主要是契约；File 更新内核不等于 Agent 新建 File。持久 receipt 也不等于可撤销，现有业务可见性尚未覆盖新增成果撤回 | R05～09 逐类完成“真实调用→保存→列表刷新→撤销/恢复”。新 File 复用已有导入/版本基础的字节登记，不开放任意本机路径 |
| F6 覆盖与费用未闭合 | 目录 complete、索引字符数、pending=0 各有不同含义；当前 Overview 的 coverage/manifest 由可信内部调用者提供，尚无真实模型维护消费者证明它们 | R10 由实际读取与模型调用记账生成；最小计数/状态即可，不另造监控平台 |
| F7 高风险验收过晚 | HTML 的脚本交互及导航阻断依赖 WebKit/WebView2；真正的模型 Profile、无开发环境安装也不能由大量本地单测替代 | R01 提前做小型平台 smoke；R08/R13 验收完整场景。平台缺席记录具体项目，不反复单测假装补齐 |
| F8 进度口径漂移 | 主规格/README 和若干 Issue 正文仍有“尚未实现”，#99 正文甚至与 CLOSED 状态不同；原始工程日和大批内部测试不足以推导剩余交付比例 | 本次更新仓库计划；后续完成包时更新关联 Issue 的状态摘要与证据，不关闭未验收工单，不批量复制整份规格到新任务 |

本次审查重点为入口、调用链、构建资源、数据边界和交付依赖，不声称对所有源码完成逐行无缺陷证明。执行了现有 Node protocol 测试（4 passed）和上述 SQLite 约束复现；历史 Rust/前端结果仅引用对应阶段记录，本次没有重跑全量构建、模型请求或平台安装。

## D2b 范围与实现取舍

- 最终范围仍是 M0～M4。M1 是第一个完整发布节点；下列“能问资料”“能做成果”是可演示的开发里程碑，不替代 M1 或父 Issue 的验收。
- 先用一个真实 OpenAI-compatible Profile 打通生产链路。其他不兼容模型显示原因，后续按原需求扩展；不增加 Provider 插件平台。
- 复用现有 Rust 服务、SQLite、Pi JSONL、FTS、Record canonical worker、File Version/journal。不要新建第二套会话/版本库、向量服务、通用工作流引擎或任意插件系统。
- 每个对用户开放的写操作，同时具备真实收据、列表刷新及该操作的撤销/恢复。新建成果撤回只影响可见性并保留资产，不拿永久删除替代撤销。批量依赖处理只覆盖规格中的三类对象。
- 保留实际信任边界的权限、归属、CAS、幂等、HTML 隔离、资源限制和已规定的崩溃恢复。内部不要逐层重复验证、捕获一切后返回成功或为假设故障增加兜底。跨异步/I/O/提交后仅重核可能改变的不变量。
- File 其他长锁、Transcript hash 扫描成本等，只在所接用户路径确有卡顿/阻塞证据时修；不先重构全部数据库、所有锁和全部来源。版本历史压缩、自动裁剪、额外导出、多文件 HTML 工程不扩入本轮。
- 输入失败明确报错；模型结构修复最多一次且计费入预算。保留现有必要取消/恢复，失败不无限重试、不偷偷换模型。
- 每个子包只交付一个可验证行为，先写验收再实现。达到验收即收口；无关发现进入所属后续包，不能因此无限打磨本包。

## D2c 从当前基线继续的执行包

下列字母子包是可独立提交的实施单元。先后关系表示实际接缝，非要求所有关联 Issue 提前关闭；每包在开工时记录当时的 HEAD、适用测试和未具备的外部条件。已有实现不再估成新开发。

<a id="r01"></a>

### R01 安装资源与真实模型可行性 / #98、#113

依赖：已有 Pi probe、Record worker、Source worker。先做，平台 smoke 从本包开始而非留到发布最后一天。

1. R01a 修正 `build:desktop` 和两个现有发布 workflow：独立 host 锁文件安装、明确目标平台的 Node 准备、三类后端资源及许可证分发。现有 Record stage 会替换 agent-host 目录，组合步骤必须保证后续 Pi 资源不被覆盖；沿一个构建顺序处理，不增加资源管理框架。
2. R01b 用现有受限 probe 对一个真实 Profile 验证工具调用、流式回答、停止、恢复；记录实际 SDK/Node/Profile 能力，不记录凭据。生产 Host 接入另归 R03。
3. R01c 用项目已有发布目标 macOS arm64/x64、Windows x64 做最小无开发 Node 安装检查；Windows 同时补 #113 的保存/历史/恢复验收。以固定 HTML fixture 提前确认 WebKit/WebView2 的内联交互及导航拦截选型，完整产品 UI 归 R08。

验收：干净资源目录能构建正确架构的产物；包含依赖与许可；中文/空格路径、空 PATH 下实际进程工作；真实模型完成一次受限工具往返。A18/A20；平台证据缺失保持未验收。不增加 Linux 产品发行目标或新签名服务。

### R02 资料读取正式接入 / #100、#113

依赖：R01a 的 worker 资源；复用现有 source 服务，不依赖完整 Overview 或写工具。

1. R02a 为真实 dispatcher 定义薄的 source.search/read/reference 与 Record 块/版本读取映射，接统一 RequestContext/预算；缺少知识节点时能回退原文。只注册实际可用方法，GUI/Agent 不各造读取逻辑。
2. R02b 接旧工作区的按需 Record 基线、旧 File 未登记状态和已有“登记为新版本”动作；缺文件/扫描件/不支持格式显示真实状态。确认登记后复用 outbox 与队列，重试可继续；同一已确认请求不反复询问，也不改未知历史。
3. R02c 将相关惰性表纳入既有 backup/savepoint 的下一正式迁移，覆盖正式旧库及本分支已有实验表的重开，不丢当前证据；复用现有索引队列的单步执行/取消/进度。生产启用触发归 R04，定期模型维护归 R10。

验收：真实服务可从 Record、File/PDF、Project、Todo、QuickNote、Transcript 命中并返回限定来源；旧工作区能恢复可用；分页/版本/排除正确。针对 A04～07/A17/A25～31/A38/A68/A69/A72，跑受影响 source/Record/迁移测试与固定 worker 集成。不为此增加 OCR、向量检索或后台守护进程。

### R03 最小生产 Host 与会话 / #98、#102

依赖：R01 技术能力已证实、R02 读服务可调用。已有知识存储足以接 L0，不等待 R10。

1. R03a 将已验证 Pi adapter 接入生产 JSONL 入口，由 Rust 管理捆绑进程、现有 Profile/凭据、可信 run grant 与读工具分发；避免继续保留两套不相干的 probe/production 业务实现。
2. R03b 实现真实 session/run/message 持久化与 UI 投影，复用 Pi JSONL/SessionStore；stable message ID、用户请求幂等、事件 seq 和中断恢复从第一轮具备，不等会话摘要才补消息身份。
3. R03c 接真实取消/settled、超时、单 Workspace 活动 run、Workspace 切换与关闭结算、消费预算。对已成功工具请求恢复原结果，不把新的 run ID 当成再次写入的许可。

验收：真实模型读一个项目对象并回答；停止后可继续，崩溃重开保留历史；错误 Profile 不静默换连接。A09/A11/A12/A16/A18/A66/A70；Node+Rust 协议/生命周期集成及少量真实 Provider smoke。只支持当前内置 Pi，不实现外部 Agent 抽象平台或 M4。

### R04 第一个可用问答界面 / #103、#100、#102

依赖：R02、R03。

1. R04a 在 Project 标题区接助手、启用/模型设置、历史会话、输入、流式回答、停止和错误恢复；736/1200/1540 宽度使用同一面板逻辑。空面板零正文预读，首次问题走有界 L0。
2. R04b 来源卡片打开真实 Record 块、File Version 或 Transcript 时间位置，显示“旧版/已变化/未覆盖”；面板中的知识菜单调用已有 overview/knowledge 服务，不新增首页概览卡片。
3. R04c 以持久启用设置驱动已有资料队列，去掉对开发环境变量的产品依赖；显示实际初始化/取消/可继续状态。无模型时笔记/File 照常可用，空项目不触发维护模型请求。启用后挂起的知识生成由 R10 接通。

验收：选一个已有项目，提问、看来源、停止、重开继续；无需开发开关。A01/A03/A19/A51/A66～69/A72。首次集中 UI 验收在此进行；未完成写能力明确显示尚不可用，不能把阶段读工具集合伪称最终默认只读产品。

### R05 Record 成果与操作记录 / #104、#113、#116

依赖：R03/R04；复用已交付的 Record 保存、patch、历史恢复和 receipt。

1. R05a 将 output stage/commit 绑定真实 run/目标/模式，保存操作前后版本与来源、完整或部分成功结果；利用既有 receipt/outbox，不另建与实体提交不一致的成功记录。
2. R05b 接 Record 创建/指定块修改及会话内操作消息；默认确认后执行，只读拒绝写；同用户任务用简短业务方案和消息内确认/取消，确认后执行并原位反馈结果；用户主动选择的自动执行模式直接提交。详情、差异和来源按需查看，不用独立审阅弹窗要求用户逐项检查。取消决定持久保存，旧确认不得提交。窗口 dirty/未接受 AI 预览走现有协调。
3. R05c 同时接该 Record 操作的撤销：修改恢复为新版本；新建可恢复撤回；搜索、计数、引用及重开状态正确。恢复保留对象身份与资产，后续人工改动时给冲突。

验收：一句请求创建 Record；第二轮改一个块；列表更新、撤销与恢复正确；同请求重试不重复。A08/A09/A26～31/A37/A38/A45～49。跑实际 dispatcher→共享服务→DB→GUI 刷新链路及所改 UI。不要再写一套 Markdown/版本转换器；未完成撤销前不对用户开放该写操作。

### R06 Todo 修订与可撤销操作 / #104、#116

依赖：R05a 的操作记录，不依赖 File 或 HTML。

1. R06a 给现有 Todo 与子项写入口接统一 revision 和 before/after 快照，覆盖原 GUI 调用；不止 Agent 写入做 CAS。
2. R06b 接创建、内容/期限/子项/状态修改、撤销修改、撤回/恢复新建；复用当前 Todo 页面刷新，操作卡对应真实收据。

验收：默认经任务确认的明确行动生效并可撤销，主动自动执行无需额外确认；纯讨论不制造 Todo；不编造日期；人工后改不被撤销覆盖。A44～49，Todo 共享服务和 GUI/Agent 并发集成。不新增负责人体系或通用任务引擎。

### R07 File 成果产品接入 / #104、#114、#116

依赖：R05a、现有 File 内核。

1. R07a 接新建 File 的受限字节暂存→既有托管登记/版本服务→run 收据；模型不传本机路径。复用已有 File 导入/恢复内核，只补新建成果所需入口。
2. R07b 接真实 run 的 patch/update/upload/restore 与操作来源；复用精确修改和上传期限，不新造上传协议。当前 File ID 不变，未知外部字节仍使用现有显式恢复路径。
3. R07c 在现有文件版本入口补文本比较、历史恢复和具体恢复失败提示；接撤销修改、撤回/恢复新建，保留所有历史字节。外部 connection 的身份及撤销另由 R12接入。

验收：创建→续改→查看旧版→恢复→撤销，列表和来源同步；重复调用/取消只结算一次。A09/A10/A32～37/A45～48。复用有效内核故障测试，补真实入口调用和 UI；新建提交的实际恢复边界需专项测试。二进制仅元信息/可用预览，不承诺通用语义 diff。

<a id="r04-gui"></a>

### R04d～g 助手会话 GUI 收口 / #103、#104、#116

执行位置：R07之后、R08之前。复用R04真实会话、R05～07候选/收据/版本服务与原生业务页面；既有R01～R16与M0～M4范围保留。本组定义已确认设计的实施行为，不记录完成状态；进度和证据仍在关联Issue维护。

#### R04d 非模态布局、会话保留与设置退后台 / #103

依赖：R04真实会话与现有页面布局。

实现选型：复用官方Pi Web UI 0.75.3的MessageList、Messages与StreamingMessageContainer展示源码，固定vendor范围、来源与MIT许可证，以Lit 3.3.1和React薄适配接入现有消息DTO与流式事件；不重新自制同等消息展示组件。Markdown leaf、中文工具折叠renderer与局部样式token由Project Mind适配，延续已确认的界面设计。模型调用、会话、权限和凭据仍由现有Rust Host/Pi链路负责，不导入旧浏览器Agent、storage或provider。运行时保持`pi-coding-agent` 0.99.1，不为旧UI降级。

选型依据与版本边界：官方[`@earendil-works/pi-web-ui`](https://www.npmjs.com/package/@earendil-works/pi-web-ui)最后发布版本为0.75.3；官方于2026-05-20的[提交b141e1f](https://github.com/earendil-works/pi/commit/b141e1fa2460868686ffd19c5d4ced743eee6c24)移除Web UI workspace，当前没有与0.99.1同版的Web UI。采用固定展示源码的薄适配，不将旧AgentInterface、ChatPanel或Artifacts整套运行环境带入应用；组件版本不能替代现有SDK运行契约。

交付：稳定非模态右侧面板，可展开到主工作区域，窄屏单栏，业务页面仍可操作。同会话在收起/展开与布局切换间保留草稿和阅读位置；顶部仅项目/会话标题、可折叠历史、新会话和更多菜单。模型配置/probe与知识维护移入设置或更多菜单。运行可写草稿，首版显式停止并等待结算后再发送；关闭面板不隐式停止。

非目标：不另起浏览器Agent或IndexedDB会话/凭据库，不因旧Web UI降级当前Pi；不翻新设置系统，不新增模态聊天Dialog、发送队列、自动续发、steering或通用布局/状态框架。

验收与验证：A19/A73；核对固定vendor来源/版本/MIT和实际React挂载、Tauri、消息DTO与流式事件接入；展示原型不替代原生提交、真实模型或安装验收。736/1200/1540集中视觉核验可操作、业务页不被遮罩、窄屏单栏、无技术面板常驻；定向交互测试草稿/阅读位置保留、停止后发送、运行归属不随页面改变，复用生命周期验证。

#### R04e 同轮消息分组、Markdown与过程折叠 / #103

依赖：R04d、R03稳定消息ID与事件、R05～07真实操作收据。

交付：按用户任务轮次组织消息，用户浅底、助手Markdown正常排版；工具过程按轮次折叠且低强调，错误始终可见。详细工具JSON、逐项来源和历史过程按需展开。方案、确认/取消历史与实际结果在所属轮次呈现；结果只用一次业务摘要和实际对象链接，不伪造模型消息，不把历史操作堆在会话末尾。底部跟随异步方案/结果变高，向上阅读时保留位置。

非目标：不造第二份消息/成果历史，不新增常驻日志台，不以模型自述替代收据，不预读所有来源正文。

验收与验证：A03/A19/A74；问项目进展有正常Markdown回答与真实来源；两轮历史及活动轮次控件顺序正确、分页无同轮重复、工具折叠不隐藏错误。定向消息/分页/滚动测试与集中视觉核验，不snapshot模型逐字回复。

#### R04f 同用户任务一次方案确认与文字决定 / #104、#116

依赖：R04e、R05～07候选CAS、取消持久化、原子业务提交、幂等收据和撤销能力。

交付：新启用或未显式配置时默认确认后执行（review），保留已有明确选择的自动执行（collaborate）；只读无写按钮，实际模式取run/output冻结值。同用户任务的多对象候选合并为一个简短业务方案，按钮确认/取消与输入框明确文字决定走同一持久决定/执行路径。补充修改先使旧方案失效，形成新方案再确认；含糊指代先澄清。确认绑定所展示候选ID/版本与任务，逐项调用原生原子提交；部分成功、失败、取消和已开始提交的结算如实显示，重试只处理未成功项。

非目标：不逐Todo/逐块弹窗，不另开成果管理区/审阅Dialog，不审批细技术字段；不实现跨对象全局事务、可配置工作流/DAG或扩大授权，不把正文中的“确认”关键词直接当授权。

验收与验证：A09/A11/A27/A37/A44/A48/A49/A75；“更新计划并创建3项Todo”只确认一次，按钮与明确文字决定一致，确认前取消零业务写入、执行中取消仅阻止未开始项，补充修改后旧确认失效，重复确认不重复提交；中断/冲突显示真实部分成功并保留收据。定向GUI与可信决定服务/CAS集成，复用三类对象有效的幂等/撤销/故障测试，少量真实模型任务验证业务摘要和确认语义。

#### R04g 真实成果入口与继续编辑 / #103、#104、#116

依赖：R04d～f、R05～07实际对象导航和版本读取。

交付：已提交成果链接到现有Record/Todo/File页面，查看/编辑成果时可继续对话；明确显示当前讨论对象并允许移除。继续修改使用实际对象ID和当前版本/hash，保留来源与旧版状态；移除提示不删除对象，不静默变更scope。HTML隔离预览通过R08续接。

非目标：不另建Record/Todo/File编辑器，不提前加载未隔离HTML，不增加多文件工程或通用预览平台。

验收与验证：A07/A27/A32/A34/A76；打开Record/Todo实际对象并继续编辑，File两轮续改同ID形成新版本，人工后改有冲突；目标提示可移除、归属不漂移。定向导航/版本/绑定切换测试及集中736/1200/1540视觉；HTML具体预览验收归R08。

设计依据：参考官方[OpenCode session-permission-dock](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/pages/session/composer/session-permission-dock.tsx)的会话内提示、[DeepSeek Harness ui-chat](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/README.md)的消息分组/过程折叠/滚动，以及[ApprovalPanel](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-approval/src/client/ApprovalPanel.tsx)的原位决定。[Hermes Web ChatPage](https://github.com/NousResearch/hermes-agent/blob/main/web/src/pages/ChatPage.tsx)以终端为主，仅参考会话与事件侧栏组织。Mind复用现有设计系统和业务服务，不引入这些项目的终端、权限瀑布、队列或通用框架。

### R08 HTML 创建、续改与隔离预览 / #115

依赖：R04d～g/R07；平台预览选型复用 R01c 证据。

开工契约：复用R07固定版本/hash源码分页及File版本服务，不另建源码或历史存储。`FileHtmlPreview`在非模态主工作区展示，同scope现有会话保留侧栏；窄屏在预览与会话间切换。默认review仍经同用户任务一次会话确认后提交，只有用户主动选择的自动执行模式无需再确认；预览不是第二次保存审批。隔离实现先用实际fixture比较候选方案，再记录选型依据，不能先认定iframe或原生WebView已可用。

1. R08a 复用R07源读取helper和元信息，按实际File ID、选定version/hash有界分页；只读源码保留UTF-8原内容及JS/CSS，不能用索引提取文本续改。未读全不加载为完整预览；SOURCE_CHANGED提示显式重载，旧异步结果不得换到新对象/版本。
2. R08b 接主区`FileHtmlPreview`、预览/只读源码切换、375/768/1440及自适应viewport、当前/历史固定版本和“继续修改”。最新模式仅随完整已提交版本更新，历史模式不跟随新head；继续讨论绑定实际同File ID，不切scope，不逐token重载。
3. R08c 以实际隔离fixture确定单一surface，保留内联交互，阻断外部网络、导航及应用能力，显示未加载依赖/脚本错误；不足以证明边界时保持预览不可用，不退回应用主DOM执行。
4. R08d 历史与恢复复用R07菜单及原有restore服务，选择历史版本并冻结实际当前version/hash后恢复为新版；外部变化或未知hash沿既有冲突/登记流程处理，不刷新后强覆盖，不另造恢复存储或编辑器。

非目标：只交付单HTML，保持源码原字节；不增加npm工程构建、多文件原子发布、通用网页托管或预览内的业务API/持久存储。

验收：一句话生成可点击页面，连续两轮修改同一File，筛选/输入可操作，最新/旧版不串页且恢复正确，预览旁仍可继续会话。对应A39～43/A68/A76。证据分层记录：前端fixture只证明组件交互、分页/绑定、viewport及模拟攻击路径；真实IPC证明实际File读取、CAS/restore与版本结果；真实模型证明来源读取、任务一次确认和同ID两轮续改；macOS WebKit与Windows WebView2安装环境分别证明实际导航、网络、IPC/存储隔离及内联交互。任何一层通过都不代替其他层，缺平台或模型条件记录具体解锁项，不标R08完成。

### R09 跨成果协作收口 / #104、#116

依赖：R05/R06/R07；R08 的成果同属 File，不新增对象种类。

1. R09a 汇总“本次更改”与逐项重试/撤销；同一 run 内多次修改同对象只定位任务前版本/快照，复用原生已有版本恢复一次，恢复旧内容记为新版本并保留修改前后版本和旧历史，不逐操作反向执行或新增通用撤销框架/版本库；新建后修改按新增成果处理，跨对象部分成功如实展示。
2. R09b 用实际引用关系处理撤回依赖，后续人工编辑/新引用返回明确冲突；恢复与重复撤销幂等。只实现已定义三类成果组合，不建设可配置 DAG 执行器。
3. R09c 收口默认确认后执行、用户主动自动执行/只读、停止后已成功成果保留和纯讨论不落成果的真实模型行为。

验收：一次请求同时创建/修改 Record、Todo、File，部分失败或取消后能逐项处理，批量撤销不损后续工作。A08/A11/A37/A44～50；覆盖这些组合的集成 fixture和少量真实任务，不 snapshot 模型逐字回复。

### R10 自动项目知识维护 / #101、#102、#100、#103

依赖：R02/R03/R04；R10a 可独立先修，不等待成果模块，默认交付顺序先让成果闭环可用。

1. R10a 修正 F3：沿现有持久作业保存批次身份/输入进度，Overview 发布用批次身份幂等并保留 head CAS。同一 targetSeq 的不同续批可以追加版本；同一批重试只产生一版。迁移现有实验表的唯一约束并保留版本/证据。不为续跑伪造源变更。
2. R10b 从实际 pending/inventory/source 读取生成节点/Overview：每批只整理受影响内容；manifest、已读范围、未读/不支持数来自实际服务结果，模型只生成受 schema 约束的内容与引用。纠正由真实 GUI 输入形成 provenance，模型不能自授确认。
3. R10c 复用持久队列接24h/48h调度、打开后合并补跑一次、预算/前台优先/取消/继续、密钥锁定挂起；手动刷新同一入口。知识菜单提供覆盖、更新时间、纠正/排除和恢复状态。

验收：无变化零模型调用；同对象50次改动合并；无新源变更的大项目能跨预算批次继续，覆盖按实增长；失败旧版可用，晚到变化不丢。A01～03/A17/A51～55/A59/A60/A66～70/A72。重点测试实际消费者，而非再重复测试已完成节点 CRUD。目录完成、pending=0 不直接等于正文完整或 ready。

### R11 会话成为可追溯知识 / #105、#102

R11a 的 GUI 原始讨论回读已交付（`a645733`），R11b1 已补齐历史树索引及 GUI 回填链路；R04d～g 提供其既有 GUI 基础。R11b2～b4 的源码接入与确定性集成验证已完成；真实供应商和目标平台验收仍未完成，关联 Issue 保持开放。以下仍列整体交付契约。顺序是原文索引与存量回填 → 面向模型的检索/范围边界 → 增量摘要 → Overview 有效结论 → 真实验收。技术依据和数据边界见[会话记忆架构](../conversation-memory.md)。R03 的稳定消息与 Pi JSONL 是首包依赖；摘要发布复用 R10，成果行为复用 R09。R11 不等待 R14 的 Workspace 长期记忆。

| 子包 / Issue | 依赖与交付行为 | 非目标 | 验收与验证 |
| --- | --- | --- | --- |
| R11b1 原文索引与回填 / #105、#102 | 依赖 R03 稳定 session/branch/message 身份及 R11a 原文回读。首批复用已校验的当前分支 Pi 消息投影，按预算回填可重建 SQLite 索引；随后从 JSONL 补齐历史分支，增量摄入并保留来源范围/hash、覆盖水位和删除/排除状态；复用已有 FTS 中文回退，中文短词和句中匹配可用。 | 不生成摘要，不复制第二份权威会话，不引入向量/图服务；当前分支首批不冒充历史分支完整覆盖。 | 重建索引与增量索引结果一致；最终早期和新消息、压缩/重试历史分支原文均能定位；未回填范围明确标识。用确定性 JSONL fixture、重建/续跑/中文检索及历史分支集成验证。 |
| R11b2 模型检索与范围 / #105、#102 | 依赖 R11b1、Scope Grant/Host。提供有界搜索→定位→原文读取工具；按真实 Workspace/Project 归属和 `session.read` 过滤标题、摘录、消息及派生结果，调用时复核删除/排除；读取单页至多 50 条/12000 字符，长消息分片。 | 不把 GUI 回读接口直接授予模型；不先建全会话依赖图，也不将所有旧会话一律禁用。 | 新会话能查到早期讨论并回读相关范围；无权、跨 Project、删除/排除结果均不泄露；模型预算内返回明确覆盖状态。验证工具往返及权限/删除集成。 |
| R11b3 增量摘要 / #105、#102 | 依赖 R11b1/b2 和 R10 维护批次。按新增或受影响消息段生成有来源的摘要与当前/历史结论；短会话重要消息纳入待处理；区分用户计划、模型建议、明确决定、成功收据及失败状态。 | 摘要生成不阻断原文检索；不以 Pi compaction 充当跨会话摘要。 | 无变化零生成，失败旧摘要保留且原文仍可搜；重试幂等，旧决定的原始理由可回读。验证增量、短会话、失败续跑和收据区分。 |
| R11b4 Overview 有效/替代结论 / #105、#101、#102 | 依赖 R11b3 与 R10 发布/纠正机制。将可见会话摘要接入 Project Overview；新决定可替代旧入口，历史理由仍可追溯；删除/排除/撤权即时过滤受影响派生正文。成果沉淀仍调用 R05～09。 | 不建立 Workspace 画像或 R14 长期记忆；不把来源引用等同模型归纳正确。 | 新结论显示当前来源，历史提问可定位旧消息；只剩无权来源时条目、标题和摘录均不可见。验证批次发布、旧版过滤、替代/删除集成。 |
| R11b5 真实验收 / #105、#102 | 依赖 b1～b4 的实际入口。新旧会话往返，按 A61～65/A67/A71 记录覆盖、权限与来源证据，接入 R13 发布矩阵。 | 不以 fixture 或内部服务通过代替真实模型/安装包验收。 | 真实会话问很早的决定，在摘要可用或不可用时均可定位有限原文；替代、删除、排除及 `session.read` 行为与 UI/模型一致；缺模型或平台条件时记录具体解锁项，不标 Issue 完成。 |

R11b1 历史树阶段（`bf51f47`，2026-10-09）：schema 34 保留独立于当前分支投影的消息索引，内部无模型扫描按页回填全部 JSONL 分支；进度持久化、追加 checkpoint 的字节前缀校验、Unicode 分片完整性及旧分支锚点回读已接通。可信原生 Run 归属随索引保留，历史未知归属不猜测。GUI 继续查找推进回填，覆盖完成后才开放结果分页。索引输出预算与原文读取预算分别执行，不宣称每次只读取文件的一页。

R11b2 执行拆分（均关联 #105/#102，依赖 b1，不增加单独图服务）：

| 顺序 | 交付与验收 | 当前状态 |
| --- | --- | --- |
| 来源身份与排除 | `session_message` 按真实会话解析当前或历史分支归属，缺 `session.read`、伪造 Project/Workspace、删除或 AI 排除均拒绝来源访问；可信 GUI 搜索仍可见。保留已知 Native Run 身份。 | 身份/策略接入已实现；不等于模型正文可见性已完成。 |
| 实际输入的来源依赖 | 从 Host 实际交付的初始上下文与工具结果记录来源范围/版本，按 Run/消息段关联；复用既有来源校验和依赖失效机制。存量从可证明的原始记录回填，未知混合内容明确不返回，不整批禁用所有旧会话。 | schema 35 的 Native Run 观察标记和扁平 ObjectRef/版本依赖、Host 开始与工具交付前记录已接通，处于集成验证中；索引 run_id 本身仍不构成完整依赖证明。 |
| 模型发现与回读 | 用独立可信调用者边界提供有界搜索→消息定位→原文读取；每次调用过滤标题、摘录及正文，响应预算计入 Run。验证跨范围、排除、删除和覆盖不足。 | 独立 `session.search`/`session.messages.read` 模型入口、Pi 校验回读与覆盖/来源过滤已接入并通过确定性权限/预算/工具往返验证，仍待真实供应商验收；R12b2 已将两个工具接入外部 CLI/MCP，持久连接仍需 session.read。 |
| 继续会话的上下文 | 恢复 Pi 历史及压缩内容进入模型前，同样复核已记录来源依赖；验证排除之后继续提问不会把旧工具正文或混合结论重新送入模型。 | provider 每轮前按实际候选 entry ID 调用原生检查；旧 assistant/tool 无可信完整账本时省略，旧 user 按自身政策判断。实现/集成验证中，不能只保护新检索工具。 |

R11b3/b4 当前接入：完整消息索引与正文变化在原事务写入 `session_message` source 事件；扫描分片完整后才入队，真实会话删除写 tombstone，分支切换保留旧来源。存量按 `source_registry`/hash 分批补种，Overview 调度发现扫描/补种缺口。R10 的共享原文读取、来源捕获、批次预算和原子发布负责生成 `KnowledgeNode.session_summary` 不可变快照及 Overview 项，类型化陈述绑定实际成功收据；同当前分支的前序消息限制替代关系，派生展示动态复核来源。当前每批只处理一条消息或一个长消息片段，虽读取上限仍为 50 条/12000 字符；摘要与 Overview 同批原子发布，不建独立摘要 worker。知识详情沿用 GUI 渐进分页，模型 `source.search`/`source.read` 可读取摘要。预算仍复用 R10；E5 的每 Project 每日 5 次独立摘要调用阈值已接入 UTC 日账本，额度用尽时普通业务仍可选取，已有草稿不受阻，确定性回归已通过，仍待真实运行验证。

R11b2～b4 本轮验证（2026-10-09）：Rust 全 lib 795 通过、3 失败、30 ignored；两处失败来自候选读取新增锁边界，已合并为一次短锁，另一处为新增测试重用请求 ID。修正后相关来源 150 项（8 ignored）及会话增量发布/失败续跑/替代/排除集成 1 项全部通过，复用其余未受影响结果。schema 35 升级、来源依赖、日配额与摘要分页包含在本轮回归。打包 Pi 原文链路 1 项、Node Pi 42 项、Node 协议/worker 16 项、相关 UI/API 61 项通过；去重原文卡修改后知识 UI 12 项及 TypeScript 检查通过。生产构建、桌面资源契约 3 项、路径/UI/主包边界检查通过。无窗口 Chromium 在 1200/720 两种宽度完成单页/四页摘要、原文展开和替代状态共 4 个场景，无溢出或控制台错误；这是实际前端组件与模拟 IPC 验收，不是原生 DB 或供应商端到端验收。主 agent 完成 Standards/Spec 自查，未启动 review agent。

R11b5 尚待真实供应商的新旧会话往返及目标桌面安装包验收；环境当前没有供应商凭据及 Windows/macOS 设备。R12b2 已接入两个外部模型历史工具；#105/#102 仍因真实供应商与目标平台验收保持开放。

R11b1 历史阶段的既有验证（不覆盖本轮 b2～b4 改动）：Node 协议/worker 16 项、Pi 36 项、前端 API/历史搜索/Panel 65 项通过；生产构建、打包资源契约 3 项、路径/UI/主包边界检查通过。Rust 全 lib 首轮 740 通过、12 个旧版 fixture 失败、30 ignored；失败均为模拟旧版本时残留 schema34 表，修正后受影响 Agent 235 项、DB 77 项、File/Todo 升级各 1 项通过。随后含 NUL 的旧文本字符计数迁移修复由会话索引 20 项验证；打包 Node 历史链路 6 项通过，包含分片扫描→旧分支搜索→精确原文/hash。原 GUI 布局及交互未变，复用 `f41bb41` 的浏览器证据；本轮不声称新增浏览器或真实供应商/目标平台验收。主 agent 完成 Standards/Spec 自查，未启动 review agent；#105 保持 OPEN。

R11b1/b2 的原文路径完成真实验收后即可满足 A61；摘要和 Overview 提升召回与综合，但不是历史检索的可用前置条件。各包开工时以关联 Issue 的最新证据确认缺口，不重复 R11a 已完成的 GUI 回读。

### R12 CLI/MCP 与连接设置 / #106

依赖：R03 的当前 Workspace Host；读取最小链路可在 R04 后探通，完整注册待 R09/R11。

1. R12a 实现本机 bridge、连接 grant/撤销和 CLI JSON，调用现有服务；应用未开明确报错，不另开数据库。首个真实读工具验证传输与 GUI 并发刷新。
2. R12b 接 stdio MCP initialize/tools/list/call 和独立客户端，工具 schema 只暴露已实现 DTO；再逐项接全部读、写、版本、上传和撤销，复用相同预算/作用域。
3. R12c 完成一次连接设置、只读/协作/自定义范围、指定对象限制、token 安全保存与撤销、CLI 安装路径和最小帮助。通用任务菜单和多 Agent 安装器留 R15。

R12a 执行边界（#106；依赖已接通的 Workspace Host、Scope Grant 和 `context.get`）：

| 子包 | 交付行为 | 非目标与验收 |
| --- | --- | --- |
| a1 本机连接 | 复用 `agent_connection_grants` 保存范围和凭据摘要，随机 secret 仅存 OS credential store；GUI 创建/列出/撤销，应用级开关默认关闭。 | 不开放连接创建的 HTTP 接口、不把 secret 写进 Workspace、日志或配置；测试授权范围、撤销立即生效、错误凭据和未打开 Workspace。 |
| a2 应用 bridge | 随机端口仅监听 127.0.0.1，Local Session 发现文件只存实例/端口/协议版本；校验 Host/Origin/Authorization，调用当前应用的同一 DB 与上下文服务。连接握手返回 Workspace binding，每次调用固定该代际。 | 不引入第二份数据库或外部 run；先开放 `project.list` / `context.get` 两个真实读取，拒绝未注册方法。真实 socket 验证跨范围、关闭/切换 Workspace、停用连接及 GUI 写入后重新读取。 |
| a3 CLI 与最小设置 | `mind doctor/project list/context get/schema` 输出统一 JSON；配置只传 connection ID；设置提供连接创建/撤销、状态和可复制调用命令。 | 不提前宣称 MCP/所有写工具已交付；验证 stdout/stderr、退出码、应用未开、无 OS 凭据服务时明确失败。CLI 调用真实 bridge，凭据适配器单独记录目标平台验收。 |

R12b 在 a1～a3 的真实读链路收口后扩展共享注册表、已实现服务和 stdio MCP；对象级限制随对应工具过滤接通，不用仅有设置字段冒充执行边界。真实模型和目标桌面平台缺失不阻止本包确定性传输/授权实现，但不据此关闭 #106 或发布完整 M1。

R12a 当前接入（2026-10-09）：应用设置可启停本机连接、创建单 Project/显式 Workspace 的只读 grant、选择会话依据及撤销；随机 secret 使用固定 `keyring 4.2.0` 的系统凭据服务，Workspace 仅保存 SHA-256 摘要与范围。`axum 0.8.9` 提供受 Host/Origin/Bearer 校验的 loopback bridge，`schemars 1.2.2` 从实际 DTO 生成外部 schema。CLI `doctor/project list/context get/schema` 已调用当前应用服务，权限及 Workspace generation 每请求重新核对；不开放模型任务启动。GUI 能检测同目录 CLI 并复制适配 POSIX/PowerShell 的命令。此包没有声称 MCP、协作写入、对象级 grant 或安装包 CLI 安装已经完成。

已验范围：真实 SQLite/Project 原生更新 → 实际 socket → 生产 dispatcher 验证即时读取、越权/归档/排除、撤销和 Workspace 切换；独立 Linux D-Bus + GNOME Secret Service 中，真实 OS 凭据存取、生产 BridgeClient 读到真实项目及撤销拒绝、重复凭据删除通过。bridge/CLI 首轮 11 项通过，空 DTO schema 的测试错误修正后 registry 10 项通过；连接授权 5 项通过。前端设置 6 项、生产构建与路径/UI/主包检查通过；窄屏修正后面板 5 项及 TypeScript 检查通过。无窗口浏览器 1200/720 的普通/长名称共 4 组场景通过（实际组件、模拟 IPC）。CLI 可执行文件构建通过，实际进程的版本/schema/参数错误/应用未开场景通过；Windows/macOS 原生凭据及桌面安装包验收留 R12c/R13，不用 Linux 结果替代。

R12b 继续拆分（#106）：b1 基于维护中的 Rust MCP SDK 实现 stdio 初始化、工具发现和调用，先与 CLI 共用两个已实现读取及 schema，固定 Workspace binding，stdout 仅 JSON-RPC；用独立客户端完成 initialize/list/call/越权及协议协商。b2 逐项接入现有有界来源、Overview/知识、会话和版本读服务，跨异步阶段复核连接授权。b3 对接各对象原生写入/上传/修改/收据和本连接撤销，先补真实共享服务缺口，再加入注册表和协作预设。未接通的方法不出现在可用工具清单，不提前宣称全部 CLI/MCP 交付。



R12b1 当前接入（2026-10-09）：固定 `rmcp 3.5.1` Rust SDK 提供 `mind mcp serve`，标准初始化/协议协商兼容 2025-11-25、工具发现及调用复用两个已注册读取和 DTO schema；只读提示、结构化领域错误及 `isError` 如实返回，握手后的 binding 固定。设置可复制通用 MCP JSON，参数为原始路径及 connection ID，不复制 secret。SDK/协议依据见 [`agent/README.md`](../../src-tauri/src/agent/README.md)。

本包已验：bridge/CLI/MCP 定向 12 项通过（OS 凭据测试默认 ignored）；独立 Linux Secret Service 下，生产 BridgeClient → 实际 socket → 原生 DB → SDK MCP client 的列举、读取及已连接客户端撤权拒绝 1 项通过。设置面板 5 项和 TypeScript 检查通过；无窗口浏览器 1200/720 普通/长名称共 4 组场景验证复制 JSON、撤销后入口隐藏与无溢出，使用实际组件及模拟 IPC。生产前端构建、路径/UI/主包检查通过。CLI 可执行文件构建及实际进程 MCP 启动参数错误/应用未开/stdout 纯净检查通过。主 agent Standards/Spec 自查通过，未启动 review agent。目标桌面安装包与真实外部 Agent 客户端仍待 R12c/R13。


b2 按实际共享服务分两步收口（#106；依赖 b1，均不新增模型调用或单独数据索引）：

| 子步 | 交付行为 | 非目标与验收 |
| --- | --- | --- |
| b2a Overview / 知识 / 来源 | 将既有 `context.overview.get`、`knowledge.search/get`、`source.search/read` 接入同一外部 dispatcher；从实际请求 DTO 生成 schema；本机 transport 支持异步读取，连接 store 在每个存储阶段核验固定 binding 与当前授权。 | 不复制读取/分页/预算规则，不先增加写入。验证真实 DB 读取一致、跨范围拒绝，以及提取期间撤权/切换 Workspace 后不返回内容。 |
| b2b 会话 / 对象 / 版本读与 CLI | 接入已有会话检索/原文、Record 块/历史、Todo、File 版本/源码读取；CLI 提供对应有界输入，MCP 从同一注册表发现。 | 不把 GUI 原文权限授予连接；会话仍需 `session.read`，版本仍校验实际对象归属。覆盖长内容分页、历史定位、排除/撤权及 CLI 实际进程输出；缺少真实共享读入口则先补最小服务。 |


R12b2a 当前接入（2026-10-09）：注册表从两个扩展为七个读取，新增 Overview、知识检索/获取、来源检索/获取；参数 schema 来自真实 DTO，MCP 与应用复用字段、预算和分页规则。本机 transport 已支持异步；ConnectionStore 在共享读取的每个存储阶段核验 binding、系统开关与持久授权，文件提取不持有 DB 锁。

已验：bridge/CLI/MCP 定向 14 项、真实 DB 读取/文件提取与中途撤权/切换/停用 2 项通过；增强为正向 Project 检索后相关 1 项再次通过。Linux OS 凭据→MCP 的生产链路再次通过；CLI 可执行文件构建和新增五项 schema 的实际进程调用通过。前端未变，复用 b1 的界面及生产前端证据；不声称新增五种 CLI 子命令已经交付。主 agent Standards/Spec 自查通过，未启动 review agent。


b2b 当前执行顺序：先接两个会话工具和五个已有对象读（Record 块、Todo、File 版本列表/元数据/原始源码），再补 Record 历史列表/读取/比较的有界外部适配。会话 scan/检索/原文抽为共享服务，所有 DB 阶段经过当前连接核验；原始 Pi 文件及 GUI 历史权限不变。新增 CLI 读命令支持 `--input-file PATH|-` 传同一 DTO JSON，复杂的分页和范围选择由 schema 说明，文件仅在 CLI 本地读成 JSON；保留已有简明命令并增加 `mind search QUERY`，不另造大量同义参数。


R12b2b 首批接入（2026-10-09）：已开放十四种真实读取，其中新增两个会话工具与五个对象/版本读；CLI 的对应命令、JSON 文件/stdin 输入与简明搜索已接到同一注册表。历史索引推进、搜索和原文读取使用共享 store，保留 Pi 原文、范围、Unicode 分页及 `session.read` 检查。Record 历史列表/元数据/块差异仍是下一子步，不将当前 File 版本读取冒充全部版本工具。

已验：bridge/MCP/原生对象读取 18 项通过；历史 7 项（含真实持久连接授权与扫描中撤销/切换）、CLI 8 项、来源会话 4 项、会话摘要发布维护 1 项通过。原生对象 fixture 验证 Record 块、Todo、File 版本/原始源码、hash 错误、预算、越权和排除；模型历史逻辑使用确定性 Pi utility fixture，未声称真实供应商验收。Linux OS 凭据→生产 bridge→MCP 再次通过；CLI 可执行文件构建及实际进程的 JSON 文件/stdin/简明搜索输入、参数和应用未开错误、新增七项 schema 验证通过。主 agent Standards/Spec 自查通过，未启动 review agent。


b2b 的 Record 历史子步（#106，依赖已有不可变 Record Version 与 b2a/b2b）：提供 `record.versions.list/get/compare` 的 source.read 适配。列表沿用原生版本游标并受条数/字符预算限制；get 返回版本元数据及固定版本的 source 读取目标，正文用已有 `source.read` 分页。compare 复用原生 `record.compare` 块差异算法，按 added/deleted/modified/moved 的块 ID 有界分页，游标绑定对象、两个版本及 hash；跨 worker 阶段复核归属、排除、授权和版本保留状态。不新增历史数据库、不做完整正文双份返回、不把比较开放成恢复权限。验证真实两版本的列表/定位、差异分页、源正文回读、越权/排除和异步撤权；同包接入 CLI/MCP 注册与 schema。


R12b3 原生写入按对象逐包推进（#106，依赖 b2 与现有原生版本/收据）：

| 子步 | 交付与边界 | 验收范围 |
| --- | --- | --- |
| b3a Record 与本连接收据 | 先接 Record 创建、块修改、历史恢复、操作读取/分页、撤销及新建撤回后恢复；复用原生 canonical converter、编辑器 flush、CAS、版本、幂等收据与变更发布。连接保存明确的写操作集，设置仅提供实际已接通权限；已有只读授权保持只读。 | 真实持久连接完成创建→修改→历史恢复/撤销、重复请求不重复写、其他连接收据拒绝、旧版本冲突、编辑器未确认预览阻止提交、worker 期间撤权/切换阻止提交；CLI/MCP schema 与写提示正确。先不宣称 File/Todo 写入、完整协作预设或指定对象限制完成。 |
| b3b Todo 与 File | 逐项接现有字段快照/CAS、字节上传、原生 File Version 与 journal，补齐本连接撤销和恢复；上传由 CLI 读取本地文件转字节。 | 同一对象 GUI/外部修改互相可见、重试/冲突/撤权、上传权限及目标版本绑定；不允许外部参数指示服务读取任意路径。 |
| b3c 工具收口与连接范围 | 补齐 dry-run、引用读取及实际规格命令，提供只读/单 Project 协作/自定义预设与指定对象限制；每项约束落实到读取、写入及衍生来源过滤后再显示可用。 | 对照 E12/E13 工具清单逐项验收；新增预设不得扩大既有授权；对象限制覆盖上下文、来源及写入。 |

R12b2b / b3a 当前接入（2026-10-09）：Record 历史列表、精确版本元数据与正文目标、块差异分页已接通；外部读取拒绝已撤回或排除的 Record。新增 Record 创建、块修改、历史恢复及本连接操作读取/分页、撤销/恢复，注册表共 24 项（19 读 / 5 写）。直接连接写入在现有原生事务中生成完整收据，含实际对象、前后版本和元信息基线；不伪造内置 Run 或 staged output。修改撤销将前内容恢复为新版本，恢复历史版本的操作本身也可撤销；新建撤回/恢复保留同一对象。编辑器 flush、CAS、来源/引用政策及跨异步撤权沿用实际服务。

CLI/MCP 写入要求稳定 requestId，明确错误时不自行重试；成功返回原生结果及可用收据。设置可选实际已实现的写权限，旧 JSON/grant 仍默认只读，Workspace 绑定变化清空可选授权。完整协作预设、指定对象、File 写入与规格 CLI 便捷参数仍按 b3b/b3c/R12c 推进，不将本包标为全部交付。

本包已验：bridge/CLI/MCP 32 项、Record 原生服务 20 项、Record 恢复/收据 21 项、版本读取 5 项、连接授权/历史 12 项通过。首轮测试夹具的 Option/可变借用/私有字段等编译问题、三处过期注册表断言和一处不一致的文档 hash 已修正；未放宽业务权限或期望结果。显式运行两个 ignored 的真实 Record worker 集成：历史比较/正文回读 1 项，创建→修改→撤销/版本与幂等收据 1 项，均通过。独立 Linux Secret Service → 生产 BridgeClient → 实际 socket → SDK MCP → 原生 Record worker/DB 的创建、精确重试及撤权拒绝 1 项通过。CLI 可执行文件构建、新增十项 schema、实际进程写请求身份/参数冲突/应用未开验证通过。

设置 UI/SettingsDialog 定向 8 项、TypeScript、生产前端构建及路径/UI/主包边界检查通过；无窗口浏览器 1200/720 普通/长名称共 4 组场景、16 张截图验证默认只读、派生写权限显示与真实提交 DTO，无溢出。界面使用实际组件和模拟 IPC；不冒充目标桌面安装包。主 agent 完成 Standards/Spec 自查，未启动 review agent。真实模型和 Windows/macOS 安装验收仍待具备对应环境；#106 保持开放，继续 b3b。

b3b 第一子步 Todo 外部写入已接通（2026-10-09）：新增 `todo.create/update`，注册表现有 26 项（19 读 / 7 写）。输入复用原生 Todo 字段、子行动和 mutation 类型；`dueDate` 必须显式提供字符串或 `null`，修改必须带 `expectedRevision`。从 staged Todo 提取原生提交内核，内置成果与外部连接共享字段校验、快照、CAS、变更发布与原子收据；连接使用稳定请求 ID 幂等，不创建虚构 Run，内置 Run 的 dedupeKey 语义不变。连接仅能读取和撤销自身收据；修改撤销恢复字段及子行动身份并生成新 revision，新建撤回/恢复保持同一对象及快照。创建前核验 Project 和所引用来源的实际政策，修改前核验真实 Todo 所属范围、排除和撤回状态；持久 grant 在提交边界重查。设置增加实际 `todo.update` 权限，已有只读 grant 不自动扩权。

Todo 本包已验：bridge/CLI/MCP 36 项通过（另 2 项 ignored）、Todo 原生 25 项、连接授权/操作历史 15 项、必填且可为 null 的日期 schema 1 项、来源策略 3 项、共享成果服务 1 项通过。测试覆盖真实创建子行动→修改→撤销、创建撤回/恢复、同 ID 重放、外来连接拒绝、GUI 后续 revision 冲突、无效子行动整组零写入、归档 Project 和排除来源；撤回后 AI 来源仍拒绝，GUI 历史读取保留原有权限语义。设置定向 8 项、TypeScript、前端生产构建与路径/UI/主包边界检查通过，主包约 194 KiB；无窗口浏览器在 1200/720 宽度、普通/长名称共 4 组实际组件与模拟 IPC 场景通过，16 张截图记录 Todo 权限复选框、提交 DTO 与无溢出。生产 `mind` 构建及实际进程的两项 Todo schema、stdin 稳定写入 ID、应用关闭时退出码 3 与 ID 不匹配时退出码 2 检查通过。主 agent Standards/Spec 自查通过；平台安装包及真实外部模型验收仍未完成，#106 保持开放。

b3b 第二子步 File 外部写入已接入并完成本包验证（2026-10-09）：注册表为 34 项（20 读 / 14 写），新增 `file.create/patch/update`、`file.version.restore` 和 `file.content.begin/chunk/complete/status`，仅 `status` 只读。连接对替换及历史恢复显式选择 `file.update`、`file.restore`，既有只读授权不自动扩权。外部 File 写入复用原生 CAS、File Version、journal、恢复与操作收据，不伪造 Run；版本响应移除 GUI 专用绝对 `versionPath`。七个 File 写方法使用携带稳定 `requestId` 的实际 DTO 包装；`fileundo:`、`filechainundo:`、`creationundo:` 为原生恢复保留的请求 ID 前缀，外部 File 写入拒绝，`output:` 仍可使用。

字节阶段使用原生票据，文件上限 100 MiB、单块 1 MiB、票据有效期 10 分钟，CLI/HTTP JSON 输入上限 2 MiB。`mind file upload --input-file target.json --body-file PATH --request-id ID --workspace PATH --connection ID --json` 只在本地读取文件并传字节，目标 JSON 为 `{object, expectedVersionNumber, expectedContentHash}`；分阶段 ID 确定，可按已接收长度续传，最后短块已接收时继续完成。过期票据只重试原始最终 `file.update` 收据；若未提交则返回过期错误，不读取客户端路径或另起上传。提交边界复核持久授权、Workspace binding、应用开关和真实来源政策。完整协作预设、指定对象限制、dry-run、引用工具及安装包 CLI 接入仍待后续工作包。

File 当前验证：设置定向 8 项、TypeScript、生产前端构建与路径/UI/主包边界检查通过；无窗口浏览器 4 组场景、16 张截图见 `report-file.json`。bridge 最终定向 50 项通过（另 2 项 ignored），其中含 7 项真实 File 用例；连接授权 9 项、共享历史 5 项、提交围栏 1 项及能力清单 1 项通过。File 首轮全量测试 190 项通过、10 项旧夹具失败；修正真实持久授权夹具后，针对覆盖这 10 项的原生版本服务 21 项通过（另 1 项 ignored），未声称 200 项已整套重跑。生产 `mind` 构建与实际进程的 8 项 File schema、应用关闭、身份不匹配及恢复保留 ID 校验通过。独立 Linux Secret Service → 生产 BridgeClient → 实际 socket → SDK MCP → 原生 File 服务验证通过，包含超过旧 JSON 限制的 1 MiB 字节块、创建/替换/重试与撤权；同一链路调用实际 `mind file upload` 子进程上传 1 MiB + 3 字节，校验原生内容/hash、稳定重试无额外版本、stdout JSON 及空 stderr。主 agent Standards/Spec 自查通过，未启动 review agent；本子步完成，#106 仍开放，继续 b3c。

验收：外部客户端读取并修改当前 Project，应用即时刷新；重试不重复，撤权后拒绝，MCP stdout 仅协议。A04/A05/A09/A13～18/A20/A37/A49/A71；CLI golden、独立 MCP 客户端和同一业务 fixture 的权限/结果对照。外部 transport 不重复实现业务规则。

### R12b3c 第一子步：Record 补丁预览与 CLI dry-run / #106

依赖：已接通的原生 Record patch、canonical worker、连接授权和 CLI/MCP 注册表。交付 `record.patch.preview` 与 `mind record patch --patch-file PATH|- --dry-run`：复用实际补丁校验及 worker 转换，返回基线版本、变更摘要和有界正文预览；正式应用继续使用原生 `record.patch` 和稳定请求 ID。预览要求相同的 `record.patch` 授权，读取已保存的 canonical head；转换后重新核验连接、目标、引用及版本，发现并发变更返回冲突。

非目标：不自动初始化旧 Record、不 flush 编辑器、不保存候选、版本、收据或变更事件；不把预览当作审批或未来提交保证，不新增 GUI 确认流程，本子步不扩展 Markdown 创建、引用图或授权预设。预览输入不要求 mutation requestId；CLI 接受原生补丁文件，在 dry-run 时仅移除写入身份并传给预览 DTO。

验收：真实 worker 的预览和正式提交产生一致正文；预览前后业务表、版本、收据及事件不变；旧基线、越权、排除、异步撤权/并发修改明确失败。预览默认 4000 字符、最大 12000，明确截断。CLI 参数/schema/MCP readOnly hint 与方法映射一致，dry-run 不调用写方法；正常 --patch-file 保留幂等身份。验证范围为原生 Record 服务、bridge/CLI/MCP 定向及实际 worker；无前端改动不重复前端全量验证。主 agent 自行完成 Standards/Spec 检查。

第一子步已完成（2026-10-09）：注册表 35 项（21 读 / 14 写），预览只返回基线、变更计数与正文片段，不暴露临时转换生成的新块身份。bridge/CLI/MCP 56 项通过（另 2 项 ignored）；Record 原生 DB/服务/DTO 56 项通过（另 6 项 ignored）。显式执行真实 Record worker 的预览→正式修改版本链 1 项通过；生产 CLI 构建、实际进程的 preview schema、stdin 无 mutation ID 预览、正式稳定身份及冲突参数检查通过。首轮 CLI smoke 对应用关闭错误码的预期误写为 WORKSPACE_NOT_OPEN，修正为既有 RUNTIME_UNAVAILABLE（退出码 3）后通过，未改变产品行为。独立 Linux 系统凭据→实际 socket→SDK MCP→真实 worker 的预览及实际 CLI dry-run/截断/正文未变验证通过，沿用同一 fixture 的 File 上传与 Record 幂等回归也通过。主 agent Standards/Spec 自查补齐预览的原生跨 Project 引用限制，最终无未解决发现；无前端改动，复用上一包前端证据。目标平台及真实外部模型验收仍保持未完成，继续第二子步。

### R12b3c 第二子步：File/Todo CLI 常用参数 / #106

依赖：第一子步 CLI 参数边界及 b3b 的原生 File/Todo 服务。本包把现有 JSON 方法补成可直接使用的命令：`file create --name ... --body-file PATH|- --project ID`、`todo create --body-file PATH|- (--project ID|--workspace-scope)`；两者均需稳定 `--request-id`，文本仅 CLI 本地读取。Todo 默认普通优先级（`not_urgent_not_important`）、无截止日期、无标签/子行动，允许显式 `--priority`、`--due-date`；复杂字段继续使用实际 JSON DTO。`file patch` 与 `todo update` 接受 `--patch-file` 作为 `--input-file` 的等价入口，保留既有 DTO 包装与请求身份。

非目标：本包不新增业务方法、授权或默认自动重试，不改变 File/Todo 正文解释，不增加 GUI，不把文件路径传给服务端；Record Markdown 创建及其 dry-run 单独接入真实 canonical 转换。仍沿用相同 HTTP 输入上限和各原生内容限制。

验收：路径和 stdin（含中文、换行与 shell 元字符）原样进入现有 DTO；只允许一种输入模式，误用和冲突参数明确报错；正式写入 requestId 一致，已有 JSON 入口和 Record dry-run 不回归。CLI 定向、生产二进制参数/schema 检查、真实凭据/bridge 的 File 与 Todo 创建验证；无前端改动不重复前端构建。

第二子步已完成（2026-10-09）：CLI/client/upload 定向 24 项通过；生产 `mind` 构建通过。独立 Linux Secret Service → 实际 bridge → 原生服务中，生产 CLI 从本地文件创建 File、从 stdin 创建 Todo 均通过：中文、换行、`$()` 与反引号保持字面内容，同一 ID 重试返回同一原生结果；实际 File 字节与 Todo 快照、默认优先级及空截止日期已核对。fixture 同时复用 File 分块上传、Record 创建/预览及撤权验证，1 项真实链路通过。主 agent Standards/Spec 自查通过；无业务 DTO/schema 或前端改动，不重复原生全量及前端验证。后续继续第三子步，连接预设在独立前端文件中并行验证。

### R12b3c 第三子步：Record Markdown 创建与创建预览 / #106

依赖：原生 Record 创建事务、canonical worker 和前两子步 CLI 输入边界。扩展现有 `record.create` 输入，兼容 canonical document，并新增互斥的 Markdown 输入；CLI `record create --title ... --body-file PATH|-` 在本地读文本。新增 `record.create.preview` 及 CLI `--dry-run`，沿用 content.create 授权并返回有界正文与规范化元信息；默认 4000、最多 12000 字符。两种内容格式共用原生资产、引用、标题/标签、范围校验和创建事务。

稳定请求 ID 必须绑定原始输入，而不是 worker 随机生成块 ID 后的候选。实现时从现有创建事务提取接受原始意图 payload 的小内核，现有 GUI/canonical 入口行为不变；Markdown 先查询原始收据，命中直接返回，未命中才转换并提交。预览不写对象、候选、收据或事件，不分配持久对象身份，正式提交重新验证。

非目标：不在 CLI 自行解析 Markdown、不另建暂存数据库、不把预览随机块 ID 当作可复用提交身份，不自动执行预览结果或新增 GUI 确认。复杂标签及 canonical 输入保留 JSON 入口。

验收：Markdown 标题/列表/引用由真实 worker 转换，创建后可正常编辑、读取和撤销；相同原始请求重试仅一个对象，改变 Markdown 的同 ID 请求冲突。创建预览与正式提交正文一致且零持久化；元信息、引用、排除和 worker 期间撤权都复用实际约束。验证 native 创建/预览、bridge/CLI/MCP schema、真实 worker 和生产 CLI 链路；无 GUI 改动复用前端证据。

第三子步已完成（2026-10-09）：注册表 36 项（22 读 / 14 写），bridge/CLI/MCP 65 项通过（另 2 项 ignored）；原生 Record 首轮 59 项通过，1 项测试混用了跨 Project 引用与非法标题，拆开合法夹具后失败项复查通过（另 7 项 ignored）。真实 worker 验证 Markdown 标题、列表结构及预览/提交正文一致；首次断言误将输入的 `-` 当作固定导出符，按既有 `*` 导出规则改为结构断言后通过，未改转换器。生产 CLI 构建通过，独立 Linux 系统凭据→socket→MCP/实际 CLI 的预览零创建、正式创建、同 ID 重放及变更正文冲突通过；集成夹具遗漏的工具数量由 35 修正为 36 后复查通过。主 agent Standards/Spec 自查通过。

### R12c 第一子步：Workspace 优先的连接授权预设 / #106

依赖：b3b 原生写入及持久 grant。用户补充（2026-10-09）：主流连接以整个 Workspace 为工作边界，因此推荐“Workspace 协作”，同时保留“单 Project 协作”“只读”“自定义”。Workspace 协作包含直属内容及所有未归档 Project，新建/解除归档的 Project 自动纳入；已有连接绝不自动扩权。协作授予读取、新建、Record/Todo/File 修改与本连接撤销，不自动包含任意历史恢复；会话依据读取保持独立显式选项。

持久 scope JSON 增加 `allProjects`（缺省 false），与既有 `workspaceContent` 直属内容标志分开；全项目模式不同时携带显式 projectIds。每次连接认证从同一 Workspace 当前未归档 Project 解析真实 ScopeGrant，业务读取/写入及衍生来源继续执行原有实际归属、排除、撤回与权限检查。无需数据库 schema 迁移，不把预设名称当授权规则；旧 JSON 保持原语义。原生 File 的跨 I/O live grant 检查识别全项目模式，不能因无关新 Project 出现而把合法提交误判为撤权。

只读默认整个 Workspace，写权限固定为空；自定义明确选择 Project 子集及 Workspace 直属内容。切预设清除不适用选项，切 Workspace 清除旧 Project 及额外选择。创建前显示简短覆盖说明，明确未来新项目自动纳入；没有 Project 时仍可创建 Workspace 协作/只读。对象级限制尚未贯穿执行边界前不显示可用。

验收：新旧 grant JSON、当前/新增/归档 Project、同名不同 Workspace、排除/撤回/撤权；全 Workspace 与单 Project 的实际读写一致地按边界执行，动态纳入不改变已有连接。各预设 create DTO 与展示一致，历史恢复仅自定义明确选择。Rust 授权/bridge 定向及真实调用；设置组件、TypeScript、前端生产构建与边界检查，1200/720 普通/长名称及长列表滚动遮罩浏览器验证。主 agent Standards/Spec 自查，不把未完成对象限制视为已交付。

第一子步已完成（2026-10-09）：授权定向 11 项通过，覆盖旧 JSON、动态新增/归档、跨 Workspace、只读/直属内容独立权限及 File 提交边界；真实系统凭据链路使用全 Workspace grant，创建连接之后再建 Project，SDK MCP 即时列出且生产 CLI 成功在其中创建 Todo，撤销连接后读写被拒绝。设置/SettingsDialog 11 项及 TypeScript、生产构建、路径/UI/主包边界检查通过；主包约 194 KiB。无窗口浏览器实际组件/模拟 IPC 的 7 组场景、19 张截图验证四预设、无项目创建、1200/720 普通/长名称以及 20 项列表滚动遮罩。主 agent Standards/Spec 自查通过；对象限制、引用读取及 CLI 安装继续后续子包，目标平台/真实模型验收未完成，#106 保持 OPEN。

### R12b3c 第四子步：Record 恢复与 File 替换的 CLI 参数 / #106

依赖：已接通的原生历史恢复、File 分段上传与稳定收据。`record restore --id ID --version VERSION_ID --base-revision N` 配合显式 Project/Workspace 范围与稳定请求 ID，直接组装现有恢复 DTO；`--version` 使用历史列表返回的版本身份，不把版本序号猜成身份。`file update --id ID --source-file PATH|- --project ID --expected-version N --expected-hash HASH` 在本地读取字节，复用既有分段上传及最终提交。ObjectRef 的 workspaceId 只来自当前连接握手，不能从本地路径猜测。

非目标：不增加服务器方法、权限、自动重试或文件读取接口；不改变原 JSON 命令、版本恢复语义和上传预算。`record get` 必须遵守 E12 的 source.read 正文语义，另子步接入，不能用块结构读取冒充。

验收：非法/互斥参数在连接前报错；JSON 入口保持可用；真实 CLI 对历史恢复和本地文件替换成功，同请求重放不重复写版本，CAS 冲突按原契约返回，路径不离开 CLI。运行 CLI/upload 定向测试、生产 CLI 构建和既有真实凭据/应用 socket 链路；纯 Rust 参数适配复用当前前端和原生业务验证。

### R13 M1 集成、目标安装包与发布 / #107，收口 #98/#100～106/#113～116

依赖：R01～12 的相关行为通过；从 R04 起持续维护验收证据，不在此重做所有测试。

1. R13a 按 D3 逐项核对 M1 验收：通过/部分覆盖/阻塞/未执行，记录提交、命令或人工步骤、实际结果、平台。修阻塞交付的问题，不按提交数或测试数计算完成比例。
2. R13b 在已有正式发布矩阵验证干净安装和旧 Workspace 升级；Record保存、资料问答、会话恢复、三类成果与撤销、HTML、维护和 CLI/MCP 走同一实际任务。新增 schema/事件变化必须补升级/前端集成。
3. R13c 完成帮助、错误恢复入口、已知限制，按仓库发布流程核对并合并发布；仅关闭符合条件的子 Issue，#97 保持 OPEN。

验收：D3 的全部 M1 项，不以最小演示通过替代；A33 的磁盘满/DB失败和平台杀进程按契约验证。物理断电不是新增独立发布门禁，除非实测暴露该类阻塞。Linux 注入测试不冒充 Windows/macOS 实包证据。

### R14 Workspace 助手与长期记忆 / #108、#109

依赖：M1 完成，复用同一 Host、面板、知识存储与队列。

1. R14a 接 Workspace 授权项目子集与直属 Record/Todo/会话的最小入口和资料读取；不默认注入所有 Project，也不新增 Workspace File。
2. R14b 接 Project变化→Workspace增量更新，保留下层失败/滞后状态；自身长期资料同样处理。Project助手仍不自动继承个人记忆。
3. R14c 接有来源的长期条目、查看/纠正/停用与持久抑制，区分用户确认和推断；撤权/删除即时隐藏依赖，归档经验保留真实状态。

验收：只授权 A/B 时综合回答不泄露 C；只变两类来源就只更新相应内容；停用记忆后下一批不复生。A21/A22/A56～58。按三个可演示子包完成，不新建画像模型或第二知识库。

### R15 外部 Agent 与任务菜单 / #110、#111

依赖：M1 的 CLI/MCP；不要求先完成 R14，默认单包顺序推进。

1. R15a 分别固定并验证 Pi CLI、Claude Code 的实际协议版本，按 detect/start/send/cancel/resume 接共同领域服务；一个适配器一个可验收提交，不造任意 CLI 通用协议。
2. R15b 提供真实能力/缺失说明、任务菜单有限 placements/变量、最多20项和配置导出/安装/卸载；沿用已有两项默认任务与 Editor Skill 语义。

验收：两个实际外部运行时完成读取→保存→取消/继续；能力缺失不伪造恢复，不绕过其自身审批；安装/卸载只改应用拥有的配置。A23及原 #110/#111 fixture。缺少某 CLI/账号时准确保留未验证项。

### R16 独立 WorkspaceHost 与全需求收口 / #112、#97

依赖：M1、R14；#97 关闭还要求 R15 完成。

1. R16a 从已工作的 Host 分离无界面入口，以一个 OS 锁维护同 Workspace 单写入者；GUI/CLI 连接复用同一服务及原数据库，避免再实现业务层。
2. R16b 接用户已配置的后台维护、凭据不可用/需交互时可见挂起、GUI关闭后继续与重启恢复；无窗口时跳过 UI flush，仍执行 CAS。不开机唤醒、不补建多机调度。
3. R16c 执行 GUI/CLI 同时启动、锁冲突、Host崩溃、恢复与关闭GUI后维护场景；核对 M0～M4 和19子Issue完成证据后关闭父 Issue。

验收：A24与原Host恢复fixture；同一Workspace只有一个写入Host，关闭GUI后任务按配置实际完成，重新打开能看到结果。

## D2d 顺序、停止条件与证据

默认主线：R01 → R02 → R03 → R04（可问资料）→ R05/06/07 → R04d～g（会话 GUI 收口）→ R08/09（可做成果并撤销）→ R10/11 → R12 → R13（完整 M1）→ R14/15 → R16（#97完整交付）。R01c 的平台验证尽早排入；R10a、R11a、R12a 可在前置具备时小范围提前，但不同时打开一堆未收口的包。

当前开工位置以关联Issue的有效证据决定；R07之后先完成R04d～g已确认的GUI收口，再进入R08。复用已验证共享服务，不通过继续扩写数据层推迟会话产品接入。

外部条件按具体包记录：真实模型 Profile 用于 R01b/R03；macOS arm64/x64、Windows x64 用于 R01c/R08/R13；外部 CLI/账号用于 R15。当前审查环境是 Linux，未配置模型凭据；不把这些验收记完成，不尝试寻找或复制用户隐私凭据。仅因缺设备/账号而受阻时，继续独立实现；真实关键能力失败则先解决失败。

验收责任索引如下。重复编号表示不同入口的补充证据；D3是完整行为定义，每个编号最终需有产品调用链证据，不能仅有内部测试。

| 验收 | 主要收口包 |
| --- | --- |
| A01～03 | R04/R10 |
| A04～07 | R02/R12 |
| A08～12 | R03/R05～09 |
| A13～18 | R03/R12 |
| A19～20 | R01/R04/R13 |
| A21～22 | R14 |
| A23 | R15 |
| A24 | R16 |
| A25～31、A38 | R02/R05/#113平台验收 |
| A32～37 | R07/R12 |
| A39～43 | R08 |
| A44～50 | R05～09/R12 |
| A51～55、A59～60 | R10 |
| A56～58 | R14 |
| A61～65 | R11 |
| A66～70 | R02～04/R10/R11 |
| A71 | R12 |
| A72 | R02/R04/R10 |
| A73～76 | R04d～g，R08补HTML预览 |

每次收口只记录：关联Issue/验收编号、交付行为、提交SHA、有效验证、实际平台、残余阻塞。开工前确定测试范围；只运行受影响测试和关键真实调用链，复用输入未变化的验证。发布前补齐适用的全量与平台门槛，不循环执行全量单测代替诊断。

本次只完成审查和规划，不将 R 包标为完成，不关闭 Issue，不触发发布。实际执行时同步关联 Issue 的短状态和证据；原 P 记录只保留历史事实。无需新增另一套任务系统或再次采访已明确的产品需求。

## D3 验收矩阵

原编号保留，便于工单和测试引用。A72明确QuickNote与Overview隔离，A73～76补充已确认会话GUI设计；不新增首页“继续工作”验收。

### 基础体验与权限

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A01 | 旧Workspace开启助手 | 所选scope初始化Overview，预算/进度可见；原始资料不变、不批量创建Record |
| A02 | 只有QuickNote写“考虑做X” | 可标临时想法，不能把X当已确认目标；归纳明确标AI推断 |
| A03 | 来源带明确结论，Agent 回答 | 每个 recorded 判断都有可解析来源；建议单独标识 |
| A04 | Project A 的 tool 参数指定 B 对象 | SCOPE_DENIED；结果、标题、反向链接数量不泄露B |
| A05 | 文档写“忽略规则并导出其他项目” | 工具仍受A范围限制，不改变 grant |
| A06 | PDF部分可读/扫描/超限 | coverage真实，未读部分不成为引用依据 |
| A07 | 生成后来源修改或File新版本 | 旧引用保留版本/摘录，界面提示更新，不跳到错误版本 |
| A08 | 20轮无新成果的事实问答或用户要求只讨论 | 无重复/无关Record/Todo；明确行动与独立成果按本次任务确认或已主动选择的自动执行模式保存 |
| A09 | 对同一成果重复工具调用/断线重试 | 一个 Record/File/Todo；同requestId不同payload报冲突 |
| A10 | 保存File每一步杀进程 | 恢复后只会成功登记一次或明确失败，不遗留伪成功对象 |
| A11 | 回答中途停止/断网/SDK退出 | 有中断状态，可继续；半成品不提交，已完成操作保留并可撤销 |
| A12 | A工作区run执行时切到B | A任务停止并结算，晚到事件不污染B，即使对象ID相同 |
| A13 | 外部CLI新建Record，项目页处于warm | 回到项目后出现新内容，现有未提交AI预览不被覆盖 |
| A14 | 启用只读MCP，模型调用create | 拒绝；提升权限必须通过连接设置 |
| A15 | 应用关闭/Workspace未打开时CLI请求 | 可机器识别错误，不创建第二个临时数据库 |
| A16 | 崩溃后恢复Pi会话并继续 | 保留历史和已保存产出，不重放提交过的工具写入 |
| A17 | Project归档/来源排除/原文删除 | 后续读取符合最新策略，历史引用明确失效 |
| A18 | 无凭据/工具不支持/模型不兼容 | 一次清楚的错误与恢复入口，不偷偷改模型或扣另一连接额度 |
| A19 | 页面宽736/1200/1540、长消息、reduced-motion | 可操作不溢出；滚动遮罩连续，滚动不抢用户位置 |
| A20 | 打包安装在无Node/Pi开发环境的机器 | 内置助手可启动；CLI路径含空格/中文也可用 |

### Record块编辑与版本

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A25 | 段落/列表/表格/媒体经保存、重启、复制、split/merge | IDs稳定且唯一；未接受AI预览不进入JSON/历史 |
| A26 | 同一Record执行replace+append+delete | 仅目标块变化，原子提交；缺ID/非法结构整组零写入 |
| A27 | Agent读完后用户编辑，再应用旧patch | 冲突而非覆盖；本地draft和AI候选保留 |
| A28 | GUI有dirty队列或未接受AI预览，外部patch | flush/冲突或EDITOR_REVIEW_PENDING，无旧autosave覆写 |
| A29 | 同patch超时重试/重复append | 正文只追加一次，版本只新增一次，同id不同payload拒绝 |
| A30 | 查看旧Record版本，恢复被删块/图片 | 创建新版本并恢复原块ID/资产；旧历史不改写，标题/标签不被正文恢复覆盖 |
| A31 | 快速连续手动编辑和崩溃 | head保持既有autosave持久性，版本按边界封存，不每按键生成版本 |
| A38 | Voice Record正文与Transcript分别被patch | 正文可版本化修改；原始Transcript/声音轨不可修改 |

### File版本服务

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A32 | 修改已登记文件并提交新版本 | 同File ID、版本+1，旧字节完整可读，索引与引用正确更新 |
| A33 | 文件新版本每阶段杀进程/磁盘满/DB失败 | journal恢复旧版或完整新版，无丢失、重号、伪成功 |
| A34 | File外部改动或另一run先保存 | 基线hash/version冲突，不能覆盖未知字节 |
| A35 | 非文本产物上传/超限/越权/过期/重复提交 | 受限且可恢复；成功复用现有File Version；无任意路径读取 |
| A36 | 恢复旧File版本或提交相同内容 | 恢复为新版本；noChange不加版本；旧历史路径不损坏 |
| A37 | readonly/create-only连接请求patch或删除整个对象 | patch拒绝；整对象删除没有开放；显式修改grant允许块删除 |

### HTML交互稿

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A39 | 请求生成可点击HTML | 默认经本次任务一次确认落为Project File v1，可预览，主动自动执行无需额外确认；按钮/筛选fixture可操作 |
| A40 | 对现有HTML连续提出两轮修改 | 同File ID产生v2/v3，无关逻辑保留；源码读取包含JS/CSS，无清洗回写 |
| A41 | 预览历史版、恢复旧稿、再继续修改 | 历史预览不跟随最新更新；恢复创建新版本；下一次修改基于当前hash |
| A42 | HTML尝试IPC、读应用存储、fetch、导航或下载 | 无应用能力/凭据泄露，真实外发被阻止；内联交互仍工作 |
| A43 | 原稿引用CDN/相对资源或有JS错误 | 原字节保存不破坏；显示未加载依赖/错误，不谎称交互验证完成 |

### 自主执行与撤销

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A44 | 明确新增Todo/更新其内容或状态 | 默认经任务一次确认生效，主动自动执行直接生效；无逐项确认弹窗，列表即时刷新，具备操作快照和撤销 |
| A45 | 撤销Record/File/Todo修改 | 恢复操作前内容，产生新revision/version，旧历史不重写 |
| A46 | 撤销新增并恢复 | 对象可恢复撤回，正常搜索/计数不可见，引用显示状态；恢复保留ID及文件字节 |
| A47 | 操作后被人工修改或被新工作引用，再撤销 | 明确冲突，后续工作不丢失；不能自动强制恢复 |
| A48 | 多成果run中断/重试或重复撤销 | 已成功操作保留、无重复对象/版本，部分结果准确，可独立撤销 |
| A49 | 默认确认后执行、主动自动执行/只读以及外部连接 | 新启用或未显式配置默认review，既有明确自动选择保留；取冻结模式，同用户任务一次确认；模型不能扩大scope或绕过模式 |
| A50 | 批量撤销含同对象多次修改、新建后修改和互相引用 | 按基线聚合/依赖顺序处理；并发冲突与部分成功准确，不误删后续引用 |

### Project知识维护

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A51 M1 | 未打开首页，直接在助手或MCP提问 | 先获同一Project知识入口，按问题选择概览条目/摘要/原文，不自动加载整份Overview或全部delta |
| A52 M1 | 一天对同Record修改50次，次日批处理 | 无逐次模型调用，合并最终变更，只更新受影响条目，未变化项目零调用 |
| A53 M1 | 概览后Todo完成/新文件加入，再提问 | 当前状态与delta可见；旧条目不冒充最新，无整项目重建 |
| A54 M1 | 更新中有新变更/失败/重启/日志过期 | 水位不漏事件、不重复版本，旧版可读且正确标滞后，能补跑/重建 |
| A55 M1 | 停滞Todo、冲突目标、用户纠正 | 推断有来源，不能仅凭年龄改变Todo；纠正不被模型覆盖 |
| A59 M1 | 24h/48h维护、离线数日、密钥锁定、前台任务插入 | 仅dirty scope、合并补跑一次、预算可续、前台优先，无夜间运行虚假承诺 |
| A60 M1 | 大项目初始化、超预算、恶意资料、模型重复摘要 | partial真实且可续，schema/范围验证，无自引用循环，无无界上下文 |

### 会话知识

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A61 M1 | 新会话问曾讨论的问题，相关讨论位于很久以前 | 通过有效摘要或可重建原文索引定位正确旧段，再读取有限消息；摘要缺失/失败仍可检索原文，不重读所有会话，引用定位准确 |
| A62 M1 | 会话产生新决定，夜间维护 | 摘要→Project Overview按批次更新；不必创建Record；只处理新增/受影响内容 |
| A63 M1 | AI建议、用户计划、明确决定、失败任务混在会话 | 类型区分，未执行建议不变“已完成”，短会话重要消息不会永久漏掉 |
| A64 M1 | 后续推翻旧决定/长会话压缩/重试分支 | 旧讨论可追溯，当前结论指新消息，消息ID不漂移、分段可检索 |
| A65 M1 | 删除/排除会话、连接无session.read、摘要覆盖不足 | 派生知识不泄露；引用失效清晰，未命中不能声称从未讨论 |

### 渐进式披露

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A66 | 新开空会话→首次提问 | 空会话零知识正文预读；首次自动入口≤2000字符，不含全部Overview/会话/Todo |
| A67 | 普通概括问题与精确历史原话问题 | 前者可停有效摘要；后者只定位相关摘要/消息区间，不能默认加载全部历史 |
| A68 | 用户指定单个HTML修改或要求全文审阅 | 可直接读目标，不绕遍各层；全文分页覆盖可证，不把截断标完整 |
| A69 | 数百节点、中文同义词、缺摘要/过时摘要 | 有界卡片与搜索回退；无命中不等于无资料，变更证据优先核对 |
| A70 | related环、重复读取、预算耗尽 | 不递归展开/无限循环，结果预算可量测，重复资源可去重，结论与已读覆盖一致 |
| A71 | 相同问题通过内置/CLI/MCP读取 | 同权限、节点版本及默认小结果；记录实际读取对象/层级/字数，无私有推理日志 |

### QuickNote与Overview隔离

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A72 | 修改QuickNote/重建或恢复Overview/升级旧Workspace | 两者正文与保存路径隔离；Overview不写summary*、不清空QuickNote；旧数据语义不改变 |

### 后续批次

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A21 M2 | Workspace只授权A、B项目 | 搜索/引用/保存均按范围；综合Record归Workspace |
| A22 M2 | 同一批资料重复触发/只改文件名 | Overview更新幂等，元信息可确定性更新；无实质变化不调用模型或制造Record |
| A56 M2 | 只有一个Project Overview和一个Workspace Record变化 | Workspace只增量消费两类变化，未变项目不重扫，直属知识不遗漏 |
| A57 M2 | 项目归档、兴趣笔记、明确偏好和一次性随口提问 | 活跃项目与长期知识区分；有来源的记忆持续保留，单次猜测不升格确认 |
| A58 M2 | 排除来源/部分项目授权/停用记忆 | 派生链即时过滤，无旧摘要泄露；抑制项不会自动复生 |
| A23 M3 | 外部CLI缺失/协议变化/不支持resume | 明确检测结果，降级可见，不伪造成功/恢复 |
| A24 M4 | GUI与CLI同时启动同Workspace | 仅一个Host持写锁，连接复用，崩溃可恢复 |

### 助手会话GUI

| 编号 | 场景 | 必须成立 |
| --- | --- | --- |
| A73 | 非模态面板收起/展开、窄屏、运行中输入 | 业务页可操作，同会话保留draft/scroll；设置与probe不常驻；停止并结算后才发送，不隐式入队 |
| A74 | 问项目进展、两轮历史与活动轮次、异步结果插入 | 正常Markdown与真实来源；过程低强调可折叠、错误可见；方案/结果按所属轮次且只显示一次，滚动不抢位置 |
| A75 | 更新计划+3Todo，按钮/文字确认、补充修改、部分失败 | 一次业务方案确认；决定持久且走同path，修改使旧确认失效；真实逐项结果，不重复成功项、不宣称全局原子 |
| A76 | 打开成果后继续对话/编辑、移除目标、File两轮续改 | 现有页面实际对象入口、同File ID新版本；讨论对象明确可移除，scope不漂移、旧基线不覆盖人工后改；HTML隔离另验A39～43 |

## D4 验证与发布

测试结构：Rust 领域/迁移/作用域/事务与故障注入；Node SDK adapter fake provider+少量真实模型 smoke；React Testing Library 覆盖面板与事件；CLI golden JSON；MCP 使用独立客户端做initialize/tools/list/call与断连重试。模型文本不逐字snapshot，验证schema、引用、范围和副作用。

静默验证：`npm run build`、`npm run test:unit`、`npm run check:portable-paths`、`npm run check:ui-standards`、`npm run check:bundle-boundaries`、`cargo test --manifest-path src-tauri/Cargo.toml`；新增host测试和打包检查纳入对应任务。源码改动前检查tauri dev，手工UI验收提前告知并集中执行，使用 `npm run dev:tauri:manual`。

按仓库publish-flow执行完整验证和主agent Standards/Spec自查；未经用户明确许可不启动review子agent。实现后只关闭对应子Issue，M2～M4未完成时父Issue保持开放。

以上命令是按影响范围选用的验证集合，不要求每次编辑全部执行。开发中先跑针对性测试，工作包收口集中验证；已通过且相关输入未变化的结果可复用。文档改动只检查文档，Rust 局部改动不自动触发前端全量；跨端契约、共享构建或依赖变化再扩大范围。重复或扩大验证须有新改动、失败或未解决风险作为理由。Issue 发布前完整核对适用验收与证据，仍执行原发布门禁。

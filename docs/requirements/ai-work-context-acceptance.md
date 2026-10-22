# AI 工作上下文：验收台账与实机执行入口

> 2026-10-23 记忆规则更新：当前以[记忆生命周期细则](workspace-memory-lifecycle.md)及[实现契约](../technical/memory-contract.md)为准。来源删除保留结论、默认静默语义整理与 24h 回退、DSH 真实读写接入及评测后切换 L1/L2 取代旧来源删除即失效、默认待审、Pi 记忆接入和永久全量快照规则；旧实现仅供历史追溯。其他业务权限、原子事务和非记忆功能规则保持适用。实施与验证状态逐项记录，未完成真实验收不关闭父 Issue。

更新：2026-10-23。本页保留 **A01～A76** 的逐项证据与剩余条件；历史记忆场景 **ML01～ML22** 在[原场景归档](archive/workspace-memory-lifecycle-history-20261010.md#10-验收场景)，现行记忆验收采用[生命周期 US-01～US-09](workspace-memory-lifecycle.md)。当前目标以[主规格](ai-work-context-spec.md)为准，覆盖按[交付总览 V1～V5](ai-work-context-delivery.md#current-delivery)归并。本页不是第二份排期，也不替代 GitHub Issue 状态。

2026-10-14 接入更新：旧 Pi 聊天/成果界面测试链接固定到移除前提交，只用于历史证据。当前 Project 聊天是 DSH，旧 GUI 通过项不能替代 DSH 的来源、成果、记忆与真实 Provider 验收。当前界面测试见 [DSH 面板](../../src/components/agent/DshAssistantPanel.test.tsx)、[内容会话](../../src/components/agent/ProjectSessionContent.test.tsx)与[应用路由](../../src/App.test.tsx)。

## 当前判定方式

- 「部分」表示已有相关代码、确定性测试或执行记录，不能视为整个场景已通过；「待执行」表示没有足够执行证据；「后续」表示当前范围外。
- 表内 M/R/WP/S/LM 是**历史追溯编号**，不是可继续照搬的当前批次。A23/A24 外部 Harness/闭应用 Host 保留编号但不计本轮通过分母。
- 文件预览与格式编辑已归独立 [#118/#115](project-file-integration.md)。A42 迁出、不计 AI 通过分母；A43 只保留 AI 原字节与如实告知部分。迁出不表示已完成。
- A57/A58 的 S7 本地证据只证明旧双 scope 记忆、GUI 管理及抑制，不能证明 Workspace 唯一归属、项目沿用/单次写入、快照、Skill、即时增量、联合整理或并发恢复。A75 普通成果仍要求方案后的真实用户确认；明确记忆请求和当前 Project 增量按现行生命周期及原生契约另验（旧 ML17/ML20 仅供追溯），不能混用。
- 用户已确认复用原生服务、当前 DSH 记忆调用链及界面用户流程（Pi 结果仅作历史证据），分别核持久保存、下一次调用生效和并发恢复；真实 Provider 与目标桌面设备另做产品验收。

<a id="memory-stage-20261023"></a>

## 2026-10-23 #219 阶段证据（暂停检查点）

以下记录已取得的局部证据与当前缺口，不是 gate 完成、整包交付或 Issue 关闭声明。用户要求今天暂停，当前代码作为阶段提交保存；继续工作的入口见[进度与交接](../technical/memory-progress-20261023.md)，命令及验证范围见[实现契约](../technical/memory-contract.md#local-verification-2026-10-23)。

| 范围 | 已有阶段性证据 | 仍须区分的边界 |
| --- | --- | --- |
| 原生事实/版本服务 | [store 定向测试](../../src-tauri/src/db/memory_facts_tests.rs) 19 项通过 | 原子批次、CAS/幂等、抑制、可选审批与操作单元回退；不等于真实模型语义通过 |
| 原生来源与采用 | [delivery 定向测试](../../src-tauri/src/db/memory_delivery_tests.rs) 的 4 个来源用例与 3 个采用用例通过 | 同会话真实来源、实际归属、源删除保留结论及不可变 revision 采用；不授予原文额外权限 |
| Project 理解历史 | [history 定向测试](../../src-tauri/src/db/project_history_tests.rs) 8 项通过 | 复用不可变 Overview + Project fact 版本，真实差异/来源、有界游标；Agent 工具接线与真实使用另验 |
| 行为文件与管理 UI | [behavior 原生测试](../../src-tauri/src/memory_behavior.rs) 3 项通过；[管理 UI](../../src/components/memory/MemoryDialog.test.tsx)与[行为编辑 UI](../../src/components/memory/MemoryBehaviorEditor.test.tsx)相关定向验证已有记录 | 管理及行为编辑证据与逐条回答采用证据分别记录 |
| 逐条回答采用透明度 | [Node 服务](../../packages/dsh-assistant/test/memory-service.test.mjs) 7 项与[真实 Node 链路](../../packages/dsh-assistant/test/memory.runtime.integration.mjs) 7 项、[per-answer UI](../../src/components/memory/MemoryAdoption.test.tsx) 2 项、[Project 聊天](../../src/components/agent/ProjectSessionContent.test.tsx)与[助手父面板](../../src/components/agent/DshAssistantPanel.test.tsx)合计 30 项、[native adoption](../../src-tauri/src/db/memory_delivery_tests.rs) 3 项通过；adapter 闭包 39 entries / 1046 modules 通过 | 已通过 SDK `conversation.chat.turnTail` 接入，按真实 session / turn / step 记录本次采用的不可变版本，可逐条回答查看；不再是每 Session 最新请求面板。各测试组有重叠，不合计为唯一用例数 |
| 原始会话依据回读 | [原文读取边界](../../packages/dsh-assistant/test/memory-evidence.test.mjs) 4 项通过，实际 SDK 会话回读包含在上述 Node 链路内 | 只接受本次原生记忆返回的来源 ID，读取真实用户消息并分页；保存时的摘录不冒充仍可读取的原文 |
| 后台已有事实整理 | [existing-facts 后台测试](../../src-tauri/src/memory_maintenance_tests.rs) 11 项通过 | 只整理已有 fact；不从新 sources 提取，不是 Overview + Workspace 联合发布 |
| 后台真实模型 | attempt 3 通过 merge → inferred → 条件保留 → 回退成员恢复锁定，独立条目前后不变；usage input 1025 / cacheRead 512 / output 524 / total 2061 | 前两次输出协议失败均零 mutation，失败及 usage 记录保留；通过的是这次真实整理/回退案例，详见[后台记录](../technical/memory-maintenance.md) |
| 真实模型 P0 与检索评测 | 60 场景、120 原生用户轮次及新版三臂 180 次请求已完成；gate 为 `not-passed` | layered 边际记忆输入只降 3.64%，TTFT 增 9.77%，180 条 rubric 未评分。存在纯日期写入拒绝、词法漏召回及历史工具评测接入待核。此前 P0 smoke 只代表局部证据；源删除仍是 host 附加来源后实际删除临时文件，不证明模型读源。默认 snapshot。见[评测记录](../technical/memory-evaluation.md) |
| 保存失败收尾 | 最新宿主原生 `turn-error` 收尾已通过上述 Node 14 项：保留真实失败归档、不发第二次 Provider 请求、新用户恢复、CAS 可重读重试 | 五条真实 failed_write 结果来自此前实现，仍有未执行 DSML 与虚构重复尝试的模型叙述，不能拿来证明最新修复通过。最新实现尚未重跑真实模型；原生评测运行器的结束原因断言需从完成改为错误通知 |

当前场景以[生命周期 US-01～US-09](workspace-memory-lifecycle.md)为准。已用 `git show HEAD:docs/requirements/workspace-memory-lifecycle.md` 核对历史 ML01～ML22，与[既有归档](archive/workspace-memory-lifecycle-history-20261010.md#10-验收场景)的 22 行逐行一致；历史编号保留原意，不编造到新 US 的一一映射。归档中的默认待审、删除来源失效及 Pi 接入描述不是现行记忆规则。

## 可复用的历史基线

当前实现基线 `cc3ecf9`；各证据对应的具体提交、命令及当时限制完整保存在[整理前台账](archive/ai-work-context-acceptance-history-20261010.md)、[历史交付档案](archive/ai-work-context-delivery-history-20261010.md)及[领域证据档案](../technical/ai-domain-evidence-history-20261010.md)。未改相关实现时可复用，不以文档整理重复运行应用全量检查。

| 接缝 | 有效证据及实际限制 |
| --- | --- |
| 原生服务、来源、权限与版本 | 已有定向组、Linux 实际 socket/CLI/MCP 和本地性能证据；组间重叠，不合计为唯一通过数；不代替 macOS/Windows 原生设备验收 |
| 打包 Node/Pi | 真正打包进程与 SDK 会话/工具往返已有记录；Provider 为 mock，不证明真实语义判断或真实模型稳定性 |
| S7/S8 Rust | 1019 项完整运行：980 passed、2 failed、37 ignored；两处仅修测试后分别定向通过。因此 982 个普通用例各有有效通过证据，不能称一次全量 982 passed |
| S7 前端与浏览器 | 最终集中前端 27/27；736/1200 宽度真实 React 加模拟 IPC，10 张截图；不是目标桌面原生流程证据 |
| 产品验收 | 真实 Provider、3 个真实项目用户任务、macOS arm64/x64 与 Windows x64 正式安装包/设备仍待执行 |

历史本地日志路径仅是当时证据位置，不保证当前执行环境仍存在。测试源码链接是复核入口，也不能证明该场景已经执行。

## 逐项台账

| 编号 | 历史批次 / 覆盖状态 | 已有证据入口 | 尚缺执行或条件 |
| --- | --- | --- | --- |
| A01 | M1·部分 | [Overview 维护测试][overview-tests]、[R10 记录][delivery] | 旧 Workspace 实际打开所选 scope，核预算/进度及原始对象未变。 |
| A02 | M1·部分 | [知识维护测试][knowledge-tests] | 真实模型只见临时 QuickNote 时判断标注与来源复核。 |
| A03 | M1·部分 | [来源导航测试][source-nav-tests] | 真实回答逐条核 recorded 判断与建议标签及可解析来源。 |
| A04 | M1·部分 | [连接范围测试][grant-tests]、[bridge 读取测试][bridge-read-tests] | 实际 A grant 对 B 同号对象、标题和反向链接作负向调用。 |
| A05 | M1·部分 | [受限生产策略测试][host-policy-tests] | 将注入文本放进真实文档，由模型尝试越界工具调用。 |
| A06 | M1·部分 | [来源抽取 worker 测试][extract-tests] | 实际部分可读/扫描/超限 PDF 的 coverage 与回答引用。 |
| A07 | M1·部分 | [来源读取测试][source-read-tests]、[File 版本测试][file-version-tests] | 生成后变更源，在 GUI 验旧版本、摘录、失效提示。 |
| A08 | M1·部分 | [成果审阅测试][review-tests]、[会话 GUI 测试][agent-panel-tests] | 真实模型连续 20 轮事实问答和仅讨论请求，核无无关成果。 |
| A09 | M1·部分 | [Record 重放测试][record-output-tests]、[File bridge 写测试][bridge-file-tests]、[Todo 写测试][bridge-todo-tests] | 在真实模型及 CLI 断线重试中核三类对象仅一次及改 payload 冲突。 |
| A10 | M1·部分 | [File journal/恢复测试][file-version-tests] | 逐阶段杀进程并重启产品，核真实磁盘状态和收据。 |
| A11 | M1·部分 | [Host 生命周期测试][host-tests]、[批量操作测试][batch-tests] | 实际停止、断网、SDK 退出后继续，核已完成操作/半成品。 |
| A12 | M1·部分 | [Host 生命周期测试][host-tests]、[Agent UI 测试][agent-panel-tests] | A run 中切到 B 且对象 ID 相同，核晚到事件和结算 UI。 |
| A13 | M1·部分 | [连接 Record 服务测试][record-connection-tests]、[业务刷新测试][business-change-tests] | 目标平台 warm Project 页用外部 CLI 创建并检查未提交预览。 |
| A14 | M1·部分 | [连接授权测试][grant-tests]、[MCP 测试][mcp-tests] | 实际只读 MCP 客户端调用 create 应拒绝；撤销旧连接后在设置中新建有写权限的连接再试，不支持编辑既有 grant。 |
| A15 | M1·部分 | [bridge 传输测试][transport-tests]、[R12a Linux 实际 CLI 记录][delivery] | Linux 已验应用关闭时实际 CLI 错误；仍需 macOS/Windows 实包核机器错误、Workspace 未打开及无临时 DB。 |
| A16 | M1·部分 | [Pi 会话恢复测试][host-session-tests]、[Host 测试][host-tests] | 真实会话强退后恢复续聊，核历史及已提交工具不重放。 |
| A17 | M1·部分 | [来源策略测试][source-read-tests]、[引用测试][reference-tests] | 归档后按实际可用性和授权核读；排除/实际删除后核原文及旧引用状态。独立保存的记忆结论按现行生命周期保留。 |
| A18 | M1·部分 | [Profile 映射测试][profile-tests]、[Host 策略测试][host-policy-tests] | 真实无凭据、工具缺失、模型不兼容的错误与恢复入口；同时补主规格的会话模型覆盖要求（[历史 G7 依据](archive/ai-work-context-delivery-history-20261010.md#intent-audit-20261009)），验证通用默认/显式覆盖/重开/失效模型及 probe 与实际执行一致。 |
| A19 | M1·部分 | [会话面板测试][agent-panel-tests]、[R04 GUI 执行记录][delivery] | macOS/Windows 736/1200/1540、长消息及 reduced-motion 人工交互。 |
| A20 | M1·待执行 | [CLI 打包提交][cli-bundle-commit]、[安装定向测试][cli-install-tests] | 无 Node/Pi 开发环境的 macOS/Windows 干净安装，含中文/空格路径实测。 |
| A21 | M2·部分 | [S5 定向证据][delivery]：Workspace 授权子集、项目列表/来源过滤、综合 Record/Todo 归属及操作边界已有本地回归 | 真实模型执行只授权 A/B 的跨项目检索与保存任务，核 C 不泄露及最终来源/归属；目标平台验收。 |
| A22 | M2·部分 | [S6 定向证据][delivery]和 S8 服务回归 4/4：File 仅改名 0 模型调用且概览版本不变，草稿重放无额外调用 | 真实模型下的长期重复批次与目标平台结果仍待验收。 |
| A23 | M3·后续 | 尚无本项执行证据；[R15 计划][delivery] | 实际 Pi CLI/Claude Code 可用设备、版本、账号及 resume 降级。 |
| A24 | M4·后续 | 尚无本项执行证据；[R16 计划][delivery] | GUI 关闭后独立 Host 写锁、CLI 并发和崩溃恢复。 |
| A25 | M1·部分 | [Record worker 测试][record-worker-tests]、[Record 编辑测试][record-editor-tests] | 原生安装包中保存/重启/复制/split/merge 全组合及预览隔离。 |
| A26 | M1·部分 | [Record 成果测试][record-output-tests] | 真实模型一次 replace+append+delete，非法结构零写入及 GUI 结果。 |
| A27 | M1·部分 | [Record 连接测试][record-connection-tests]、[冲突 UI 测试][record-conflict-tests] | 模型读取后人工编辑，再提交旧 patch，确认 draft/候选仍在。 |
| A28 | M1·部分 | [Record 连接测试][record-connection-tests] | dirty 队列/未接受预览时实际外部 patch 与 autosave 顺序。 |
| A29 | M1·部分 | [Record 成果测试][record-output-tests]、[bridge 写测试][bridge-write-tests] | 生产 CLI/MCP 超时重试 append，核正文、版本和改 payload 冲突。 |
| A30 | M1·部分 | [Record 历史测试][record-version-tests]、[恢复 UI 测试][record-history-ui-tests] | 目标平台恢复含删除块/图片旧版，核资产、标题标签及旧历史。 |
| A31 | M1·部分 | [Record worker 测试][record-worker-tests]、[Record 历史测试][record-version-tests] | 连续人工编辑中杀进程，核 autosave head 与封存版本边界。 |
| A32 | M1·部分 | [File 版本测试][file-version-tests]、[bridge File 写测试][bridge-file-tests] | 真实 GUI/CLI 修改已登记 File 后验旧字节、索引和引用。 |
| A33 | M1·部分 | [File 版本故障测试][file-version-tests]、[R13 要求][delivery] | 每阶段平台杀进程、磁盘满与 DB 故障注入；核无伪成功。物理断电不是独立门槛。 |
| A34 | M1·部分 | [File 版本测试][file-version-tests] | 外部文件改动/另一 run 先保存，真实入口核 hash/version 冲突。 |
| A35 | M1·部分 | [File bridge 写测试][bridge-file-tests]、[CLI 上传测试][cli-tests] | 非文本、超限、越权、过期及重放的生产 CLI/目标平台操作。 |
| A36 | M1·部分 | [File 版本测试][file-version-tests] | 目标平台恢复旧版及同内容提交，检查历史路径和 noChange。 |
| A37 | M1·部分 | [连接授权测试][grant-tests]、[bridge File 写测试][bridge-file-tests] | readonly/create-only 与显式修改 grant 的实际 File patch/整对象删除负例。 |
| A38 | M1·部分 | [Record 成果测试][record-output-tests]、[Transcript 来源测试][transcript-tests] | Voice Record 正文 patch 后核原始 Transcript 和音轨未变。 |
| A39 | M1·部分 | [File 成果测试][agent-file-tests]、[R07/R04g 接缝][delivery] | 真实模型生成 HTML，按任务一次确认保存为 Project File v1；核成果链接、实际对象 ID、版本与真实收据。点击/筛选预览归 #118/#115。 |
| A40 | M1·部分 | [HTML/File 既有执行记录][delivery]、[File 成果测试][agent-file-tests] | 真实模型连续两轮读取完整源码并修改同一 HTML File，核同 ID 的 v2/v3、JS/CSS 原字节及无关逻辑保留。 |
| A41 | M1·部分 | [File 版本基础][delivery]、[File 版本测试][file-version-tests] | 读取指定历史版本源码，核不串到当前 head；目标平台恢复旧版为新版本后继续修改，核当前基线 hash 与冲突保护。历史执行预览归 #118/#115。 |
| A42 | 已迁出 #118/#115；不计 AI 发布通过分母 | 既有[File 源码/版本基础与原 R08 隔离方案][delivery]，无已交付隔离 surface 证据 | 独立需求验证 macOS WebKit、Windows WebView2 的 IPC/存储/fetch/导航/下载阻断及内联交互；此项未完成，不作为 #106/#107/#97 的 AI 验收条件。 |
| A43 | M1·部分（AI 原字节/告知）；预览诊断迁 #118/#115 | [File 原字节读取/版本基础][delivery]；原 R08 诊断计划仅为历史证据，无脚本诊断 surface 证据 | AI 续改核原始 JS/CSS/CDN/相对引用等字节不破坏，并如实告知交互未验证；依赖加载与 JS 错误诊断由独立需求和两目标平台验收。 |
| A44 | M1·部分 | [Todo 操作测试][todo-undo-tests]、[审阅测试][review-tests] | 真实模型新增/更新 Todo 的一次确认与自动模式、列表刷新、撤销。 |
| A45 | M1·部分 | [Record 撤销测试][record-undo-tests]、[File 撤销测试][file-undo-tests]、[Todo 撤销测试][todo-undo-tests] | 产品入口依次撤销三类修改，核新版本及 GUI 历史。 |
| A46 | M1·部分 | [Record 撤回测试][withdraw-tests]、[File 撤销测试][file-undo-tests] | 真实创建→撤回→恢复，核搜索/计数/引用和 File 原字节。 |
| A47 | M1·部分 | [批量撤销测试][batch-tests]、[Record 撤销测试][record-undo-tests] | 人工后改/新增引用后实际撤销，核冲突与后续工作保留。 |
| A48 | M1·部分 | [批量操作测试][batch-tests]、[成果审阅测试][review-tests] | 真实多成果任务中断、重试及重复撤销，核部分结果与独立操作。 |
| A49 | M1·部分 | [审阅测试][review-tests]、[连接授权测试][grant-tests] | 新旧执行模式、冻结任务确认、外部连接和只读负例的实机核验；review 模式验证同会话模型决定工具只作用于 Host 绑定的当前候选及方案后真实用户回复，不以引用/工具文字授权，按钮与工具共用持久结果。 |
| A50 | M1·部分 | [批量撤销测试][batch-tests] | 真实同对象连改、新建后改、互引及并发冲突的成组撤销。 |
| A51 | M1·部分 | [知识服务测试][knowledge-tests]、[R10 记录][delivery] | 未进入首页直接经助手与 MCP 提问，核同 Project 渐进读取轨迹。 |
| A52 | M1·部分 | [Overview 维护测试][overview-tests] | 50 次改动后次日维护，核真实模型调用数和最终受影响条目。 |
| A53 | M1·部分 | [Overview 维护测试][overview-tests]、[来源测试][source-read-tests] | Todo 完成/File 加入后真实提问，核新旧条目和 delta。 |
| A54 | M1·部分 | [Overview 维护测试][overview-tests]、[变更队列测试][source-queue-tests] | 维护中新增事件/重启/失败/日志过期的产品进度和水位。 |
| A55 | M1·部分 | [知识服务测试][knowledge-tests]、[纠正测试][overview-correction-tests] | 停滞 Todo/冲突目标/用户纠正的真实模型处理，不擅改 Todo。 |
| A56 | M2·部分 | [S6 定向证据][delivery]和 S8 服务回归 4/4：父删除旧版隐藏、A 项目变化加 Workspace 直属 Record 额外 2 次模型调用且 prompt 无 B/C 原文、长父分页逐页纠正 | 未测 B/C 物理读取次数；真实 Provider 与目标平台验收仍缺。 |
| A57 | M2 历史部分；#219 实施与真实验收中 | 历史 S7 证据保留；当前原生 store、delivery、history 及 behavior/UI、逐条回答采用定向证据见[本轮阶段表](#memory-stage-20261023) | 现行 US-01～05/08/09 的真实调用与产品验收继续执行；Project 理解与 Workspace 记忆保持归属。新增 sources 提取及 Overview + Workspace 联合发布尚未交付；旧 [ML 场景](archive/workspace-memory-lifecycle-history-20261010.md#10-验收场景)不作为现行通过结论。 |
| A58 | M2 历史部分；#219 实施与真实验收中 | 历史 S7 抑制证据保留；当前 fact 级抑制、原子操作回退及 existing-facts 后台证据见[本轮阶段表](#memory-stage-20261023) | 按现行 US-04～08 验遗忘/停用、同源独立事实、默认静默语义变化、版本确认归属及可选审批；单条 patch 独立、merge 整组 CAS 回退。后台真实模型单次整理/回退案例已通过；真实跨来源遗忘、恢复旧会话及更广语义评测仍须验收，不能沿用旧 ML 的默认待审/来源删除失效规则。 |
| A59 | M1·部分 | [调度测试][schedule-tests]、[Overview 维护测试][overview-tests]：本地时区初始化、已有值保留、频率/时刻/时区设置及重算已接入 | 真实设备时钟下验证 24h/48h、离线、密钥锁定与前台抢占；单元测试时间不代替夜间运行。 |
| A60 | M1·部分 | [Overview 维护测试][overview-tests]、[知识维护测试][knowledge-tests] | 大项目、恶意资料、重复摘要真实模型运行，核 partial 和预算续跑。 |
| A61 | M1·部分 | [会话检索测试][session-search-tests]、[会话摘要测试][session-summary-tests] | [WP4～5](ai-work-context-delivery.md#confirmed-work-packages-20261009)先验证 Pi 原生压缩续聊与权限复核，再按证据补必要知识；真实旧讨论仍可由跨会话索引定位，摘要缺失时有限原文回读。 |
| A62 | M1·部分 | [会话摘要测试][session-summary-tests]、[维护测试][session-maintenance-tests]：每 Project UTC 日 5 次及其他任意共享额度已从调度代码移除；失败保留进度、有限续跑有定向证据 | 真实模型下核失败恢复、无重复和必要知识进入 Project Overview 而不生成 Record。 |
| A63 | M1·部分 | [会话摘要测试][session-summary-tests] | [WP4～5](ai-work-context-delivery.md#confirmed-work-packages-20261009)须核 Pi 压缩摘要可复用性、原文长消息续页；确需额外知识时验证建议/计划/决定/失败任务的来源分类和短会话覆盖。50 条/12000 字符仅为当前读取分页参数。 |
| A64 | M1·部分 | [完整历史索引测试][session-search-tests]、[Pi 分支测试][host-session-tests] | 推翻决定、恢复的 Pi 原生压缩与重试分支的实际消息身份；压缩后的续聊与来源失效不得泄露旧内容。 |
| A65 | M1·部分 | [会话来源测试][session-source-tests]、[连接范围测试][grant-tests] | 删除/排除、外部连接无 session.read、内部助手自动配置 session.read 及摘要缺口后的检索/派生知识负例。 |
| A66 | M1·部分 | [Host 策略测试][host-policy-tests]、[知识服务测试][knowledge-tests] | 真实空会话首问测注入正文/字符数，不只看工具 schema。 |
| A67 | M1·部分 | [会话模型搜索测试][model-search-tests] | 真实概括与原话两问，记录有限摘要/消息读取轨迹。 |
| A68 | M1·部分 | [来源分页测试][source-read-tests]、[Record 正文读取提交][record-read-commit] | 单个 HTML 源码修改/全文审阅真实调用，续页覆盖可证，截断不冒完整；不要求执行预览。 |
| A69 | M1·部分 | [来源索引测试][source-index-tests]、[知识服务测试][knowledge-tests] | 数百节点中文同义词及过时/缺摘要的真实模型查询。 |
| A70 | M1·部分 | [知识服务测试][knowledge-tests]、[引用测试][reference-tests] | 环状 related、重复读取和预算耗尽真实会话，核已读覆盖。 |
| A71 | M1·部分 | [CLI/MCP 读取提交][read-bridge-commit]、[bridge 读取测试][bridge-read-tests] | 同问题内置/CLI/MCP 同权限对照版本、字数和读取层级。 |
| A72 | M1·部分 | [Overview 隔离测试][overview-isolation-tests]、[R10 记录][delivery] | 旧 Workspace 升级与重建/恢复 Overview 后检查 QuickNote/summary*。 |
| A73 | M1·部分 | [会话面板测试][agent-panel-tests]、[R04 GUI 记录][delivery] | 736/1200/1540 实机下收起/展开、保留 draft/scroll、停止后发送及业务页交互。 |
| A74 | M1·部分 | [Pi 消息组件测试][pi-message-tests]、[会话面板测试][agent-panel-tests] | 真实两轮回答和异步结果插入，核来源、错误、折叠和滚动归属。 |
| A75 | M1·部分 | [成果审阅测试][review-tests]、[批量操作测试][batch-tests] | [G1/P2 会话模型决定](ai-work-context-delivery.md#intent-audit-20261009)：真实 Provider 连续会话覆盖「这个方案可以，照这个做」、改日期、只批准部分、含糊回复、问句、取消、引用内确认指令及多个目标；核方案后的新用户回复才可确认，普通回复/澄清保留待定方案，修改先废旧版再重提。应用侧核候选/版本/回复身份严格匹配、重复工具调用一次保存、旧版拒绝、按钮与模型工具同结果；模型自然说明业务方案，卡片附真实目标/范围/状态。mock 工具仅验调用链，不证明语言判断；再用真实“更新计划并建 3 Todo”任务验部分失败和逐项收据。 |
| A76 | M1·部分 | [成果卡片测试][output-card-tests]、[File 成果测试][agent-file-tests] | 实机从成果链接打开实际对象后继续对话/编辑、移除目标；同 File ID 两轮源码续改与人工后改冲突；文件预览另归 #118。 |

## 工程契约补充验收（R13 / #107 / E16）

A01～A76 的场景台账不能替代 [E16 性能与观测验收](ai-work-context-engineering-spec.md#e16)。R13 使用固定 fixture、固定测试机器及轻量脚本记录版本、语料规模和冷/热状态；不新建 benchmark 平台。下列“待测/待核对”表示尚无对应执行记录，不据此判断功能是否已实现。

| 验收项 | 目标与记录方式 | 当前证据状态 |
| --- | --- | --- |
| 本地检索延迟 | 3000 条 Record + 200 份文本资料；记录机器、版本、冷热状态；`context.get` 热态 p95≤300ms、search p95≤500ms，不计模型响应。 | 本机真实索引的最终 100 次热态样本：非空概览 `context.get` p95 9.735ms、Record 搜索 135.203ms、File 搜索 73.931ms。一次中间 File 测量长尾超标，后续分段未复现、最终完整复测通过，原因未确定。非空概览经真实 Record 读取证明和原生发布建立；不代表已整理全部 3200 份资料。环境与完整边界见[本地报告](../technical/ai-local-performance-20261009.md)。 |
| 知识状态与流式界面 | 知识状态读取≤200ms；Overview 维护和首模型 token 立即显示进行状态，超过 60s 有明确超时，不设固定完成秒数；流文本 UI 更新≤20 次/秒，非可见项目不更新聊天 DOM。 | 已发布非空 Overview 的小夹具 p95 4.894ms；`bf4a244` 的 50ms 合并、隐藏暂停和终态冲刷、736/1200/1540 三宽度浏览器夹具通过，重开保留草稿/滚动，关闭不打断已确认保存。已修复内部上下文检查延长首进度期限的问题，并以 `TIMED_OUT` 区分超时；Rust 期限、Node SDK 取消/checkpoint 和前端提示的定向测试通过。真实 Provider 等待体验仍待验。 |
| 主包边界 | 主入口 chunk≤250KiB、Agent SDK 不进入主包，Agent 面板动态加载；以生产构建和现有边界检查复核。 | S4 界面子步 `bf4a244` 对应生产构建、UI 标准、portable paths 和 bundle boundaries 均通过，主入口 194KiB / 250KiB。后续包的改动另按受影响范围验证。 |
| 本机观测 | 记录检索耗时、来源读取成功率、引用解析失败率、成果保存/冲突、取消耗时与恢复结果；默认不远程上传。 | 已接入 Host、GUI 原生命令与 AppBridge 边界，只写固定操作名、时间、耗时、数量和稳定结果码；不写正文/凭据、不远程上传。真实日志写入及连续两次轮转测试通过，字段与调用点已检查；真实 GUI/AppBridge 全链路运行仍待验，不以写入器测试代替。 |
| 真实项目用户任务 | 3 个真实项目，由用户完成历史问题定位、查依据、生成并找回文件；记录每项用时和纠正次数。 | 待执行；不以聊天条数或自动生成 Record 数代替。 |

## 目标平台执行顺序

准备：分别使用 macOS arm64、macOS x64、Windows x64 的正式 release 构建及干净用户环境，记录 OS/架构、构建 SHA、安装包 hash、应用与 CLI 版本、Workspace fixture hash、实际模型 Profile 和测试时刻。先确认签名、安装落位及包内 Node/Pi/mind 可执行资源；不要把 Linux 容器结果当成此处结果。真实 Provider/账号凭据仅在设备上按常规设置建立，不复制到报告。

1. **安装与升级。** 在没有开发 Node/Pi 的干净设备安装；使用中文、空格和单引号路径的 Workspace/用户目录。打开已有业务资料的 Workspace，再安装新版本覆盖升级，核新 AI 结构初始化和数据库升级/备份不改原始 Record/QuickNote/File/Todo；不要求迁移历史 AI 派生数据。于设置查看 CLI 来源、目标命令和将改动的 profile/HKCU PATH，显式安装、执行 `mind --version`、重复安装、更新、卸载并检查其他 PATH/同名外部文件未改。重开终端验证命令发现，卸载后不再指向该安装；手改受管块应报冲突且保留修改。对应 A01/A20/A72；记录平台截图、命令输出和目录/配置差异。
2. **真实模型会话与来源。** 在 Project A 配置真实 Profile，从空会话询问已有 Record/File/PDF/Todo/QuickNote 的具体问题，核模型只在 A 范围调用工具、回答的 recorded 判断有可点来源且建议另标；打开来源分页并核版本、摘录、coverage。停止、重启、继续同会话；再切 Workspace B，确认 A 的晚到事件不进入 B。尝试无凭据、模型不兼容及恶意文档指令；同时检查非模态面板、两轮消息、来源卡片、异步结果和目标移除。对应 A03～07/A11～12/A16～19/A66～70/A73～74/A76；记录实际工具/来源身份和字符预算，不记录私有推理日志。
3. **成果、冲突与撤销。** 在同一真实会话依次创建 Record、修改一个块、创建/更新 Todo、创建和两轮修改 File；默认模式只对同一任务确认一次，显式自动模式按用户选择执行。“更新计划并创建 3 项 Todo”另核按钮/文字确认一致、补充要求使旧决定失效及部分失败逐项结算。核页面即时刷新、稳定对象 ID、版本、旧字节、来源与操作收据。用同一请求 ID 重试并改 payload，人工后改后提交旧 patch，撤销修改、撤回新增再恢复；针对 File 执行阶段杀进程、磁盘满/DB 故障注入并复查 journal。对应 A08～10/A13/A25～41/A43～50/A75～76 的 AI 部分。另用真实模型生成 HTML File v1，核一次确认、成果链接与收据；读取完整源码，同 ID 连续续改为 v2/v3，读取固定历史源码、恢复为新版后再续改，并核 JS/CSS/CDN 引用字节保留及未验证交互的如实告知。A42 的隔离及 A43 的依赖/JS 诊断由 #118/#115 在目标 WebKit/WebView2 验收，不阻塞 AI 发布。
4. **知识与记忆。** 触发 Project Overview 初始化、源变更维护及停用/重开后补跑，核水位、partial、预算、纠正与来源；新会话询问较久以前的讨论，分别试有效摘要、摘要缺失、推翻决定和长历史分支，核有限原文回读、未执行建议未升格。覆盖 A02/A51～55/A59～65/A72。继续覆盖现行 US-01～US-09（历史 [ML01～ML22](archive/workspace-memory-lifecycle-history-20261010.md#10-验收场景)只供追溯）：在项目中使用通用记忆、明确请求保存和遗忘、采用方案的即时增量、同一 Run 下一次请求使用新 Skill/记忆、结构化每周设置与部分失败、尚未交付的联合沉淀目标与基线变化后恢复、Project 多次更新只标记并合并下游核对。24h/48h 是当前旧调度证据；新周设置及已有调度均按真实设备时钟和离线恢复记录，不用单元测试时间代替。新增按需 Project 历史查询核真实前后差异、时间、来源与分页，不臆造原因、不进入常驻输入。
5. **CLI/MCP 和授权。** 在应用打开且已绑定 Workspace 时，创建 Workspace/Project 范围的只读和协作连接，通过生产 CLI `mind doctor`、`mind project list`、`mind context get`、`mind mcp serve` 的 SDK 客户端查询，并用 `mind schema METHOD --json` 检查参数。只读连接尝试 create 应拒绝；新连接不能再选择对象白名单；旧对象连接在重选范围与模式前不能静默获得全范围读取或写入。内置助手在已启用 scope 自动获得会话读取能力，外部连接仍按持久 grant 核验。用可写连接保存、重试、撤销，再撤权并重复请求；关闭应用或切换 Workspace 后须为机器可识别错误且不另开 DB。核 CLI/MCP 与内置相同节点版本和有界结果。对应 A04/A09/A13～15/A37/A71 及 R12c；记录实际 SDK/CLI 响应与目标平台，不将 Linux keyring smoke 代替。

解锁条件：可取得三种目标架构的正式安装包和设备、可用真实 Provider Profile、固定旧 Workspace 与含各类来源的非私密 fixture，以及可安全进行杀进程/磁盘满/DB 故障的隔离副本。任一条件缺失时仅将对应行保持「部分」或「待执行」，不以其他平台、mock 模型、截图或单测推断通过。A21/A56～58 与现行 US 场景按当前 V1～V5 逐项验收；历史 ML01～ML22 只在归档追溯，不因旧批次本地实现而默认完成。A23/A24 保留为当前范围外的历史验收编号，不计本轮发布分母。

[delivery]: ai-work-context-delivery.md
[overview-tests]: ../../src-tauri/src/db/overview_maintenance_tests.rs
[knowledge-tests]: ../../src-tauri/src/knowledge_service.rs
[source-nav-tests]: ../../src-tauri/src/agent/source_navigation.rs
[grant-tests]: ../../src-tauri/src/db/agent_connections_tests.rs
[bridge-read-tests]: ../../src-tauri/src/agent/bridge/read_tests.rs
[host-policy-tests]: https://github.com/xuchen-cloud/project_mind/blob/09c2ab65d616fb7757b972ba7b339d73cf4c9782/packages/agent-host/test/pi/production-policy.test.mjs
[extract-tests]: ../../src/workers/source-extraction-worker.node.test.ts
[source-read-tests]: ../../src-tauri/src/source_service.rs
[file-version-tests]: ../../src-tauri/src/file_version_service.rs
[review-tests]: ../../src-tauri/src/agent/operation_batch_service_tests.rs
[agent-panel-tests]: https://github.com/xuchen-cloud/project_mind/blob/09c2ab65d616fb7757b972ba7b339d73cf4c9782/src/components/agent/AgentPanel.test.tsx
[record-output-tests]: ../../src-tauri/src/agent/record_outputs_tests.rs
[bridge-file-tests]: ../../src-tauri/src/agent/bridge/file_write_tests.rs
[bridge-todo-tests]: ../../src-tauri/src/agent/bridge/todo_write_tests.rs
[host-tests]: https://github.com/xuchen-cloud/project_mind/blob/09c2ab65d616fb7757b972ba7b339d73cf4c9782/src-tauri/src/agent/host_tests.rs
[batch-tests]: ../../src-tauri/src/agent/operation_batch_service_tests.rs
[business-change-tests]: ../../src/hooks/useWorkspaceBusinessChanges.test.tsx
[record-connection-tests]: ../../src-tauri/src/record_connection_service_tests.rs
[transport-tests]: ../../src-tauri/src/agent/bridge/transport_tests.rs
[host-session-tests]: https://github.com/xuchen-cloud/project_mind/blob/09c2ab65d616fb7757b972ba7b339d73cf4c9782/packages/agent-host/test/pi/session-history.test.mjs
[reference-tests]: ../../src-tauri/src/db/agent_references.rs
[profile-tests]: https://github.com/xuchen-cloud/project_mind/blob/09c2ab65d616fb7757b972ba7b339d73cf4c9782/packages/agent-host/test/pi/profile-map.test.mjs
[mcp-tests]: ../../src-tauri/src/agent/bridge/mcp_tests.rs
[cli-bundle-commit]: https://github.com/xuchen-cloud/project_mind/commit/2bb3a73
[cli-install-tests]: ../../src-tauri/src/agent/bridge/cli_install_tests.rs
[record-worker-tests]: ../../packages/agent-host/test/record-worker.test.mjs
[record-editor-tests]: ../../src/hooks/useCanonicalRecordEditor.test.tsx
[record-conflict-tests]: ../../src/components/record/RecordConflictActions.test.tsx
[bridge-write-tests]: ../../src-tauri/src/agent/bridge/write_tests.rs
[record-version-tests]: ../../src-tauri/src/record_version_reads_tests.rs
[record-history-ui-tests]: ../../src/components/record/RecordHistoryDialog.test.tsx
[cli-tests]: ../../src-tauri/src/agent/bridge/cli.rs
[transcript-tests]: ../../src-tauri/src/db/source_transcript.rs
[agent-file-tests]: ../../src-tauri/src/agent/file_dispatch_tests.rs
[todo-undo-tests]: ../../src-tauri/src/db/agent_todo_undo_tests.rs
[record-undo-tests]: ../../src-tauri/src/record_undo_service_tests.rs
[file-undo-tests]: ../../src-tauri/src/db/agent_file_undo_tests.rs
[withdraw-tests]: ../../src-tauri/src/db/agent_record_withdrawals_group_tests.rs
[source-queue-tests]: ../../src-tauri/src/db/source_index_queue.rs
[overview-correction-tests]: ../../src-tauri/src/overview_maintenance_tests.rs
[schedule-tests]: ../../src-tauri/src/db/overview_schedule_tests.rs
[session-search-tests]: ../../src-tauri/src/db/agent_session_search_tests.rs
[session-summary-tests]: ../../src-tauri/src/db/source_session_summary_tests.rs
[session-maintenance-tests]: ../../src-tauri/src/db/agent_session_maintenance_tests.rs
[session-source-tests]: ../../src-tauri/src/source_session_read_tests.rs
[model-search-tests]: ../../src-tauri/src/db/agent_session_model_search_tests.rs
[record-read-commit]: https://github.com/xuchen-cloud/project_mind/commit/e37dfca
[source-index-tests]: ../../src-tauri/src/source_search_index.rs
[read-bridge-commit]: https://github.com/xuchen-cloud/project_mind/commit/40bb1bb
[overview-isolation-tests]: ../../src-tauri/src/overview_session_tests.rs
[pi-message-tests]: https://github.com/xuchen-cloud/project_mind/blob/09c2ab65d616fb7757b972ba7b339d73cf4c9782/src/components/agent/AgentPiMessages.test.tsx
[output-card-tests]: https://github.com/xuchen-cloud/project_mind/blob/e136933bce4f938397aa374b69851cd480808272/src/components/agent/AgentOutputCard.test.tsx

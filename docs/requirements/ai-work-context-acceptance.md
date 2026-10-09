# AI 工作上下文：验收台账与实机执行入口

更新：2026-10-09。依据：[D3 验收矩阵](ai-work-context-delivery.md#d3-验收矩阵)与 [R13a 第一子步](ai-work-context-delivery.md#r13a-第一子步可追溯的验收台账与执行入口)。这里记录可复核证据及下一步，不替代 Issue 状态或目标平台签收。本表按 D3 的实际编号完整列 A01～A76。状态描述交付覆盖情况，不是该场景的测试执行结果：「部分」仅表示有相关确定性实现/测试源码或既有执行记录，并不表示整项通过；「待实现/平台验证」表示产品行为尚缺实现及目标设备验收；「待执行」表示尚无足以判定该场景的执行结果；「后续」表示 M2～M4 的交付边界。测试源码链接只是复核入口，不证明该场景已运行。本阶段的定向记录包括 CLI 安装 7 项、授权核心 24 项、前端 24 项及 TypeScript/生产构建/静态检查，以及来源索引 14 项、引用 6 项、bridge 84 项（另 2 项 ignored）、知识 23 项、Overview 10 项、来源注册 5 项通过；生产 CLI 构建成功，修正首轮测试夹具后，独立 Linux Secret Service→真实 socket→BridgeClient/SDK MCP/实际 CLI 集成通过，覆盖指定对象的读写、撤销、重放和越权拒绝。无窗口浏览器新增 17 场景/25 截图、原预设 7 场景/19 截图通过（实际组件、模拟 IPC）。本包代码与执行证据基线为 [`ae469ba`](https://github.com/xuchen-cloud/project_mind/commit/ae469ba)，主 agent 已完成 Standards/Spec 核对；这不替代各行所列的剩余交付条件。

| 编号 | 批次与状态 | 已有证据入口 | 尚缺执行或条件 |
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
| A17 | M1·部分 | [来源策略测试][source-read-tests]、[引用测试][reference-tests] | 产品中归档/排除/删除原文后，核后续读取及旧引用失效。 |
| A18 | M1·部分 | [Profile 映射测试][profile-tests]、[Host 策略测试][host-policy-tests] | 真实无凭据、工具缺失、模型不兼容的错误与恢复入口。 |
| A19 | M1·部分 | [会话面板测试][agent-panel-tests]、[R04 GUI 执行记录][delivery] | macOS/Windows 736/1200/1540、长消息及 reduced-motion 人工交互。 |
| A20 | M1·待执行 | [CLI 打包提交][cli-bundle-commit]、[安装定向测试][cli-install-tests] | 无 Node/Pi 开发环境的 macOS/Windows 干净安装，含中文/空格路径实测。 |
| A21 | M2·后续 | 尚无本项执行证据；[R14 计划][delivery] | Workspace A/B 授权、综合 Record 归属和真实检索/保存。 |
| A22 | M2·后续 | 尚无本项执行证据；[R14 计划][delivery] | 重复批次及仅文件名变化的模型调用和增量结果。 |
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
| A39 | M1·部分 | [R08 计划及当前 File 基础][delivery]、[File 成果测试][agent-file-tests] | 先开放脚本交互隔离预览；再用真实模型创建并确认 HTML File v1，于 macOS WebKit/Windows WebView2 点击与筛选。 |
| A40 | M1·部分 | [HTML/File 执行记录][delivery]、[File 成果测试][agent-file-tests] | 真实模型连续两轮改同一 HTML，核 v2/v3、JS/CSS 原字节和无关逻辑。 |
| A41 | M1·部分 | [R08 计划及 File 版本基础][delivery]、[File 版本测试][file-version-tests] | 脚本交互预览尚未开放；先接历史固定版本预览，再于目标平台恢复→续改，核页不串、基线 hash。 |
| A42 | M1·待实现/平台验证 | 仅有[File 源码/版本基础与 R08 隔离方案计划][delivery]，无已交付隔离 surface 证据 | 先实现并验证单一隔离 surface，再分别在 macOS WebKit、Windows WebView2 实包试 IPC/存储/fetch/导航/下载阻断与内联交互。 |
| A43 | M1·待实现/平台验证 | 仅有[File 原字节读取/版本基础与 R08 诊断计划][delivery]，无脚本诊断 surface 证据 | 先交付依赖未加载/JS 错误诊断，再于两目标平台加载 CDN/相对资源与错误 fixture，核原字节和提示。 |
| A44 | M1·部分 | [Todo 操作测试][todo-undo-tests]、[审阅测试][review-tests] | 真实模型新增/更新 Todo 的一次确认与自动模式、列表刷新、撤销。 |
| A45 | M1·部分 | [Record 撤销测试][record-undo-tests]、[File 撤销测试][file-undo-tests]、[Todo 撤销测试][todo-undo-tests] | 产品入口依次撤销三类修改，核新版本及 GUI 历史。 |
| A46 | M1·部分 | [Record 撤回测试][withdraw-tests]、[File 撤销测试][file-undo-tests] | 真实创建→撤回→恢复，核搜索/计数/引用和 File 原字节。 |
| A47 | M1·部分 | [批量撤销测试][batch-tests]、[Record 撤销测试][record-undo-tests] | 人工后改/新增引用后实际撤销，核冲突与后续工作保留。 |
| A48 | M1·部分 | [批量操作测试][batch-tests]、[成果审阅测试][review-tests] | 真实多成果任务中断、重试及重复撤销，核部分结果与独立操作。 |
| A49 | M1·部分 | [审阅测试][review-tests]、[连接授权测试][grant-tests] | 新旧执行模式、冻结任务确认、外部连接和只读负例的实机核验。 |
| A50 | M1·部分 | [批量撤销测试][batch-tests] | 真实同对象连改、新建后改、互引及并发冲突的成组撤销。 |
| A51 | M1·部分 | [知识服务测试][knowledge-tests]、[R10 记录][delivery] | 未进入首页直接经助手与 MCP 提问，核同 Project 渐进读取轨迹。 |
| A52 | M1·部分 | [Overview 维护测试][overview-tests] | 50 次改动后次日维护，核真实模型调用数和最终受影响条目。 |
| A53 | M1·部分 | [Overview 维护测试][overview-tests]、[来源测试][source-read-tests] | Todo 完成/File 加入后真实提问，核新旧条目和 delta。 |
| A54 | M1·部分 | [Overview 维护测试][overview-tests]、[变更队列测试][source-queue-tests] | 维护中新增事件/重启/失败/日志过期的产品进度和水位。 |
| A55 | M1·部分 | [知识服务测试][knowledge-tests]、[纠正测试][overview-correction-tests] | 停滞 Todo/冲突目标/用户纠正的真实模型处理，不擅改 Todo。 |
| A56 | M2·后续 | 尚无本项执行证据；[R14 计划][delivery] | Workspace 增量只消费变更的 Project Overview 和直属 Record。 |
| A57 | M2·后续 | 尚无本项执行证据；[R14 计划][delivery] | 项目归档、明确偏好、兴趣笔记与随口提问的长期记忆边界。 |
| A58 | M2·后续 | 尚无本项执行证据；[R14 计划][delivery] | 排除、部分授权与停用记忆后派生链过滤及不复生。 |
| A59 | M1·部分 | [调度测试][schedule-tests]、[Overview 维护测试][overview-tests] | 真实 24h/48h、离线、密钥锁定和前台抢占；不以测试时钟充当夜间运行。 |
| A60 | M1·部分 | [Overview 维护测试][overview-tests]、[知识维护测试][knowledge-tests] | 大项目、恶意资料、重复摘要真实模型运行，核 partial 和预算续跑。 |
| A61 | M1·部分 | [会话检索测试][session-search-tests]、[会话摘要测试][session-summary-tests] | 真实旧讨论提问，摘要缺失时有限原文回读与引用定位。 |
| A62 | M1·部分 | [会话摘要测试][session-summary-tests]、[维护测试][session-maintenance-tests] | 夜间新增决定→Project Overview 批次更新，不生成 Record。 |
| A63 | M1·部分 | [会话摘要测试][session-summary-tests] | 真实混合建议/计划/决定/失败任务，核分类及短会话覆盖。 |
| A64 | M1·部分 | [完整历史索引测试][session-search-tests]、[Pi 分支测试][host-session-tests] | 推翻决定、长会话压缩与重试分支的实际消息身份。 |
| A65 | M1·部分 | [会话来源测试][session-source-tests]、[连接范围测试][grant-tests] | 删除/排除、无 session.read 与摘要缺口后检索/派生知识负例。 |
| A66 | M1·部分 | [Host 策略测试][host-policy-tests]、[知识服务测试][knowledge-tests] | 真实空会话首问测注入正文/字符数，不只看工具 schema。 |
| A67 | M1·部分 | [会话模型搜索测试][model-search-tests] | 真实概括与原话两问，记录有限摘要/消息读取轨迹。 |
| A68 | M1·部分 | [来源分页测试][source-read-tests]、[Record 正文读取提交][record-read-commit] | 单个 HTML/全文审阅真实调用，续页覆盖可证，截断不冒完整。 |
| A69 | M1·部分 | [来源索引测试][source-index-tests]、[知识服务测试][knowledge-tests] | 数百节点中文同义词及过时/缺摘要的真实模型查询。 |
| A70 | M1·部分 | [知识服务测试][knowledge-tests]、[引用测试][reference-tests] | 环状 related、重复读取和预算耗尽真实会话，核已读覆盖。 |
| A71 | M1·部分 | [CLI/MCP 读取提交][read-bridge-commit]、[bridge 读取测试][bridge-read-tests] | 同问题内置/CLI/MCP 同权限对照版本、字数和读取层级。 |
| A72 | M1·部分 | [Overview 隔离测试][overview-isolation-tests]、[R10 记录][delivery] | 旧 Workspace 升级与重建/恢复 Overview 后检查 QuickNote/summary*。 |
| A73 | M1·部分 | [会话面板测试][agent-panel-tests]、[R04 GUI 记录][delivery] | 736/1200/1540 实机下收起/展开、保留 draft/scroll、停止后发送及业务页交互。 |
| A74 | M1·部分 | [Pi 消息组件测试][pi-message-tests]、[会话面板测试][agent-panel-tests] | 真实两轮回答和异步结果插入，核来源、错误、折叠和滚动归属。 |
| A75 | M1·部分 | [成果审阅测试][review-tests]、[批量操作测试][batch-tests] | 真实“更新计划并建 3 Todo”任务，按钮/文字确认、补充失效、部分失败及逐项收据。 |
| A76 | M1·部分 | [成果卡片测试][output-card-tests]、[File 成果测试][agent-file-tests] | 实机打开实际对象后继续对话/编辑、移除目标；同 File ID 两轮续改与人工后改冲突。 |

## 目标平台执行顺序

准备：分别使用 macOS arm64、macOS x64、Windows x64 的正式 release 构建及干净用户环境，记录 OS/架构、构建 SHA、安装包 hash、应用与 CLI 版本、Workspace fixture hash、实际模型 Profile 和测试时刻。先确认签名、安装落位及包内 Node/Pi/mind 可执行资源；不要把 Linux 容器结果当成此处结果。真实 Provider/账号凭据仅在设备上按常规设置建立，不复制到报告。

1. **安装与升级。** 在没有开发 Node/Pi 的干净设备安装；使用中文、空格和单引号路径的 Workspace/用户目录。打开旧 Workspace，再安装新版本覆盖升级，核迁移不改原始 Record/QuickNote。于设置查看 CLI 来源、目标命令和将改动的 profile/HKCU PATH，显式安装、执行 `mind --version`、重复安装、更新、卸载并检查其他 PATH/同名外部文件未改。重开终端验证命令发现，卸载后不再指向该安装；手改受管块应报冲突且保留修改。对应 A01/A20/A72；记录平台截图、命令输出和目录/配置差异。
2. **真实模型会话与来源。** 在 Project A 配置真实 Profile，从空会话询问已有 Record/File/PDF/Todo/QuickNote 的具体问题，核模型只在 A 范围调用工具、回答的 recorded 判断有可点来源且建议另标；打开来源分页并核版本、摘录、coverage。停止、重启、继续同会话；再切 Workspace B，确认 A 的晚到事件不进入 B。尝试无凭据、模型不兼容及恶意文档指令；同时检查非模态面板、两轮消息、来源卡片、异步结果和目标移除。对应 A03～07/A11～12/A16～19/A66～70/A73～74/A76；记录实际工具/来源身份和字符预算，不记录私有推理日志。
3. **成果、冲突与撤销。** 在同一真实会话依次创建 Record、修改一个块、创建/更新 Todo、创建和两轮修改 File；默认模式只对同一任务确认一次，显式自动模式按用户选择执行。“更新计划并创建 3 项 Todo”另核按钮/文字确认一致、补充要求使旧决定失效及部分失败逐项结算。核页面即时刷新、稳定对象 ID、版本、旧字节、来源与操作收据。用同一请求 ID 重试并改 payload，人工后改后提交旧 patch，撤销修改、撤回新增再恢复；针对 File 执行阶段杀进程、磁盘满/DB 故障注入并复查 journal。对应 A08～10/A13/A25～38/A44～50/A75～76。HTML File 待 R08 的脚本交互预览、历史固定版本及隔离/错误诊断 surface 交付后，再在两平台真实 WebView 中试内联按钮/筛选、历史预览以及 IPC、存储、fetch、导航、下载隔离；对应 A39～43。
4. **知识与记忆。** 触发 Project Overview 初始化、源变更维护及停用/重开后补跑，核水位、partial、预算、纠正与来源；新会话询问较久以前的讨论，分别试有效摘要、摘要缺失、推翻决定和长历史分支，核有限原文回读、未执行建议未升格。覆盖 A02/A51～55/A59～65/A72。24h/48h 的调度结果需按真实设备时钟和离线恢复记录，不用单元测试时间代替。
5. **CLI/MCP 和授权。** 在应用打开且已绑定 Workspace 时，创建只读、可写和对象限定连接，通过生产 CLI `mind doctor`、`mind project list`、`mind context get`、`mind mcp serve` 的 SDK 客户端查询，并用 `mind schema METHOD --json` 检查参数。只读连接尝试 create 应拒绝；对象连接只选 1–50 个 Record/File，未选对象的搜索/正文/引用/历史/写入不可见或拒绝，范围概览、创建、Todo 和会话读取被拒绝。用可写连接保存、重试、撤销，再撤权并重复请求；关闭应用或切换 Workspace 后须为机器可识别错误且不另开 DB。核 CLI/MCP 与内置相同节点版本和有界结果。对应 A04/A09/A13～15/A37/A71 及 R12c；记录实际 SDK/CLI 响应与目标平台，不将 Linux keyring smoke 代替。

解锁条件：可取得三种目标架构的正式安装包和设备、可用真实 Provider Profile、固定旧 Workspace 与含各类来源的非私密 fixture，以及可安全进行杀进程/磁盘满/DB 故障的隔离副本。任一条件缺失时仅将对应行保持「部分」或「待执行」，不以其他平台、mock 模型、截图或单测推断通过。M2～M4 的 A21～24/A56～58 按其独立包解锁，不作为 M1 设备操作的暗含完成项。

[delivery]: ai-work-context-delivery.md
[overview-tests]: ../../src-tauri/src/db/overview_maintenance_tests.rs
[knowledge-tests]: ../../src-tauri/src/knowledge_service.rs
[source-nav-tests]: ../../src-tauri/src/agent/source_navigation.rs
[grant-tests]: ../../src-tauri/src/db/agent_connections_tests.rs
[bridge-read-tests]: ../../src-tauri/src/agent/bridge/read_tests.rs
[host-policy-tests]: ../../packages/agent-host/test/pi/production-policy.test.mjs
[extract-tests]: ../../src/workers/source-extraction-worker.node.test.ts
[source-read-tests]: ../../src-tauri/src/source_service.rs
[file-version-tests]: ../../src-tauri/src/file_version_service.rs
[review-tests]: ../../src-tauri/src/agent/operation_batch_service_tests.rs
[agent-panel-tests]: ../../src/components/agent/AgentPanel.test.tsx
[record-output-tests]: ../../src-tauri/src/agent/record_outputs_tests.rs
[bridge-file-tests]: ../../src-tauri/src/agent/bridge/file_write_tests.rs
[bridge-todo-tests]: ../../src-tauri/src/agent/bridge/todo_write_tests.rs
[host-tests]: ../../src-tauri/src/agent/host_tests.rs
[batch-tests]: ../../src-tauri/src/agent/operation_batch_service_tests.rs
[business-change-tests]: ../../src/hooks/useWorkspaceBusinessChanges.test.tsx
[record-connection-tests]: ../../src-tauri/src/record_connection_service_tests.rs
[transport-tests]: ../../src-tauri/src/agent/bridge/transport_tests.rs
[host-session-tests]: ../../packages/agent-host/test/pi/session-history.test.mjs
[reference-tests]: ../../src-tauri/src/db/agent_references.rs
[profile-tests]: ../../packages/agent-host/test/pi/profile-map.test.mjs
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
[pi-message-tests]: ../../src/components/agent/AgentPiMessages.test.tsx
[output-card-tests]: ../../src/components/agent/AgentOutputCard.test.tsx

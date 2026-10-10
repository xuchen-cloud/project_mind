# AI 工作上下文：验收台账与实机执行入口

更新：2026-10-10。范围变更：项目内文件编辑/预览归[独立需求](project-file-integration.md)及[父 Issue #118](https://github.com/xuchen-cloud/project_mind/issues/118)，HTML [#115](https://github.com/xuchen-cloud/project_mind/issues/115)迁入该父项。AI 保留文件生成、源码读取、同 ID 续改、保存/版本/撤销及成果链接。A42 保留编号但迁出，不计 AI 发布通过分母；A43 仅 AI 原字节与如实告知部分留在本表。既有证据不等于迁出项完成。依据：[D3 验收矩阵](ai-work-context-delivery.md#d3-验收矩阵)与 [R13a 第一子步](ai-work-context-delivery.md#r13a-第一子步可追溯的验收台账与执行入口)。2026-10-09 调整见[WP1～WP6](ai-work-context-delivery.md#confirmed-work-packages-20261009)，最新记忆改造以[LM1～LM5](ai-work-context-delivery.md#workspace-memory-revision-20261010)及[详细需求](workspace-memory-lifecycle.md)为准；本页旧对象清单和旧日限额的执行证据仅证明当时代码现状。这里记录可复核证据及下一步，不替代 Issue 状态或目标平台签收。本表按 D3 的实际编号完整列 A01～A76。状态描述交付覆盖情况，不是该场景的测试执行结果：「部分」仅表示有相关确定性实现/测试源码或既有执行记录，并不表示整项通过；「待实现/平台验证」表示产品行为尚缺实现及目标设备验收；「待执行」表示尚无足以判定该场景的执行结果；「后续」表示 M2～M4 的交付边界。测试源码链接只是复核入口，不证明该场景已运行。本阶段的定向记录包括 CLI 安装 7 项、授权核心 24 项、前端 24 项及 TypeScript/生产构建/静态检查，以及来源索引 14 项、引用 6 项、bridge 84 项（另 2 项 ignored）、知识 23 项、Overview 10 项、来源注册 5 项通过；生产 CLI 构建成功，修正首轮测试夹具后，独立 Linux Secret Service→真实 socket→BridgeClient/SDK MCP/实际 CLI 集成通过，覆盖指定对象的读写、撤销、重放和越权拒绝。无窗口浏览器新增 17 场景/25 截图、原预设 7 场景/19 截图通过（实际组件、模拟 IPC）。本包代码与执行证据基线为 [`ae469ba`](https://github.com/xuchen-cloud/project_mind/commit/ae469ba)，主 agent 已完成 Standards/Spec 核对；这不替代各行所列的剩余交付条件。

2026-10-09 WP 本地实现进展（非产品签收）：WP2 提交 `26fa27a`，Rust 13、前端 71、TypeScript 与 Host check 通过，真实 Provider 待验。WP3 提交 `561ee0d`，新旧权限 Rust 组、前端 12 项及 TypeScript 通过。WP4 提交 `26cf8d5`，Pi 45/45、普通 Node 16/16、syntax、真实 SDK 加 mock 压缩保存恢复通过；mock 不等于真实外部 Provider。WP5 提交 `55356a9`，当前分支完整短消息合批，历史分支/长消息单来源；已保存多来源 draft 续跑额外生成 0 次，维护 17、生成 7、调度 11、legacy 1 项通过。单次完整 prompt 48k 是工程请求边界，未按模型实际 contextWindow 自适应。WP6 全量 Rust 972 项中 938 passed、0 failed、34 ignored，193.26 秒，日志 `/workspace/project-mind-env/wp6-rust-final.log`（当前执行环境本地日志）；生产前端 build、UI 标准、portable paths、bundle boundaries（主包 194 KiB / 250 KiB 上限）、最终 TypeScript 与 Node 16/16 通过，Pi linux-x64 资源已重新 staging。打包真实 Node 进程 9/9（含 5 个显式运行的 ignored 真实子进程测试）、历史 checkpoint 1/1、打包 SDK profile probe 1/1 均通过；SDK nonce 工具往返及历史读取通过，日志 `/workspace/project-mind-env/wp6-packaged-final.log`（当前执行环境本地日志）。这仍使用 mock Provider，WP6 本地集成完成；主 agent Standards/Spec 自查已完成，核对后续真实用户 turn/原生保存、旧连接授权、Pi 与知识职责及批次原子发布；真实 Provider 和目标桌面平台仍未验收。A 行保留产品验收缺口。

S4 已提交推送 `b402509`。S5 后端 `37c987e`、`b3344f7` 已集成，本轮提交包含前端与四个测试文件的修正；本地实现和定向验证完成，行为与 Rust 分组证据见[交付记录的 S5 段][delivery]。前端六文件 95 项首跑 94 通过、1 超时（WorkspacePage 旧 empty archived 用例），失败项独立重跑通过（另 21 skipped）；受影响 95 项最终均有通过证据，不能称单次 95 项全通过。TypeScript、生产构建、UI 标准、可移植路径及 bundle 边界通过（主入口 195 KiB / 250 KiB），主 agent Standards/Spec 自查通过。当前 S5 代码未运行 987 项 Rust 全量；S4 的浏览器夹具不是 Workspace 真实体验证据，真实 Provider 与目标平台未验收。S6 的后续本地进度见下段；S7 长期记忆尚未交付。

S6 本地实现已合入 `3aae8fd`（准备提交 `66df517`、`f37e6e7`、`5ff8c5c`），定向验证完成，产品验收未完成。Project 已发布条目以有类型的派生来源保留项目、概览版本、条目及摘要，Workspace 可展开原始依据；直属 Record/Todo/会话沿原来源路径处理。最新 Workspace fixture 1 项覆盖 A/B/C 可见性、GUI search/get、父纠正后旧版 `NotFound`、模型不可用时已保存 draft 重放且额外模型调用为 0；schema 35→36 升级/备份 1、deferred sibling 1、changed item/digest 2 分别通过。Rust 定向组分别为维护 19、Overview 服务 10、knowledge 服务 5、inventory 7、schedule 15、agent overviews 19、source trace 3、knowledge registry 3、agent knowledge 7；组间重叠，不合计为唯一测试数。UI 两文件最终集中复核 19/19 通过，日志 `/workspace/project-mind-env/s6-ui-final.log`；TypeScript 通过。主 agent 已完成 S6 Standards/Spec 自查，S8 完整收口及实机验收仍待完成。S8 新增服务回归 4/4 通过：父删除后旧版隐藏；仅 A 项目变化加 Workspace 直属 Record 的任务实际额外 2 次模型调用，prompt 不含 B/C 原文；File 仅改名为 0 次模型调用且概览版本不变；长父分页每页带用户纠正。未测量 B/C 的物理读取次数。A22/A56 仍为本地部分覆盖，真实 Provider 与目标平台验收仍缺；S7 的 1019 项 Rust 全量另行收口，不把本次 4 项称全量。S7 长期记忆及其抑制行为未交付，R15/R16 暂缓。

S7 长期记忆与 S8 本地实现和有效验证已完成，产品验收未完成。六类记忆、模型候选固定为推断、GUI 用户确认/纠正/停用与重新启用、纠正后知识新版本、按同 scope/类别/原始来源的抑制、多条停用决定各自撤回，以及旧模型读取和 Run 来源证明对最新策略的复核已接入；原始资料仍可按授权搜索。数据库定向组 518 通过、8 ignored，S8 服务回归另为 4/4；这些组可能重叠，不相加为唯一计数。前端三文件最终集中运行 27/27 一次通过；生产构建、UI 标准、可移植路径与 bundle 边界通过，主入口 195 KiB / 250 KiB。736/1200 宽度真实 React 组件加模拟 IPC 的浏览器流程、列表滚动及焦点检查通过，10 张截图报告在 `/workspace/project-mind-env/ui-check/s7-memory`。Rust 1019 项完整运行先得 980 passed、2 failed、37 ignored，用时 201.85 秒，日志 `/workspace/project-mind-env/s8-rust-full.log`。两处仅修测试后分别定向通过：旧 S5 Workspace 能力断言见 `/workspace/project-mind-env/s8-failures-retest.log`；长 Todo 最终用例见 `/workspace/project-mind-env/s8-long-source-final.log`，完整 3800 字节 prompt、约 21k 中文字符的 183 个模型分页全部结算，游标逐页严格前进，用时 38.30 秒。全量后生产代码未改，因此 982 项普通 Rust 用例各有有效通过证据、37 ignored；不能称单次全量 982 通过。主 agent 已完成 S7/S8 Standards/Spec 自查，核对原文及派生来源证明、epoch/CAS/抑制、schema 迁移、GUI 列表与空正文编辑，未发现当前阻塞。A57/A58 为本地部分覆盖，真实 Provider 与目标平台仍缺。

2026-10-10 新批准的 [Workspace 长期记忆生命周期需求](workspace-memory-lifecycle.md)已入包、待实现；LM1～LM5 和 ML01～ML15 为新目标，保留本表 A01～A76 编号。`ab4d461` 的 S7/S8 历史验证仍有效，但不证明 Workspace 唯一记忆归属、Project Overview 专门栏目、统一记忆操作、联合原子沉淀、精简快照及旧数据迁移已完成。新场景的真实 Provider 语义与目标平台验收仍缺；R15/R16 暂缓，#118 文件预览继续独立。

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
| A18 | M1·部分 | [Profile 映射测试][profile-tests]、[Host 策略测试][host-policy-tests] | 真实无凭据、工具缺失、模型不兼容的错误与恢复入口；同时补主规格 §6 的 [G7 会话模型覆盖](ai-work-context-delivery.md#intent-audit-20261009)，验证通用默认/显式覆盖/重开/失效模型及 probe 与实际执行一致。 |
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
| A57 | M2·部分；2026-10-10 修订待实现 | S7 本地代码、数据库定向组及前端最终 27/27 有历史证据；六类记忆、推断/确认、GUI 操作和知识版本已接入；[R14 计划][delivery] | 新要求按[ML01～ML05、ML09～ML10、ML13～ML15](workspace-memory-lifecycle.md#10-验收场景)核 Workspace 唯一归属、Project 栏目、统一操作、联合沉淀、完整精简快照、容量及迁移；再核项目归档、明确偏好、兴趣笔记与随口提问的真实提取边界、真实模型和目标平台。旧 S7 证据不覆盖新要求。 |
| A58 | M2·部分；2026-10-10 修订待实现 | S7 本地代码、数据库定向组与前端最终 27/27 有历史证据；按来源抑制、多 owner 独立撤回、旧模型读及 Run proof 复核已接入；[R14 计划][delivery] | 新要求按[ML05～ML08、ML11～ML14](workspace-memory-lifecycle.md#10-验收场景)核待审、遗忘/复生约束、授权、联合原子保存、迁移后的停用约束和旧会话失效；再执行排除、部分授权、旧版本/续聊不泄露的真实模型及目标平台验收。 |
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

1. **安装与升级。** 在没有开发 Node/Pi 的干净设备安装；使用中文、空格和单引号路径的 Workspace/用户目录。打开旧 Workspace，再安装新版本覆盖升级，核迁移不改原始 Record/QuickNote。于设置查看 CLI 来源、目标命令和将改动的 profile/HKCU PATH，显式安装、执行 `mind --version`、重复安装、更新、卸载并检查其他 PATH/同名外部文件未改。重开终端验证命令发现，卸载后不再指向该安装；手改受管块应报冲突且保留修改。对应 A01/A20/A72；记录平台截图、命令输出和目录/配置差异。
2. **真实模型会话与来源。** 在 Project A 配置真实 Profile，从空会话询问已有 Record/File/PDF/Todo/QuickNote 的具体问题，核模型只在 A 范围调用工具、回答的 recorded 判断有可点来源且建议另标；打开来源分页并核版本、摘录、coverage。停止、重启、继续同会话；再切 Workspace B，确认 A 的晚到事件不进入 B。尝试无凭据、模型不兼容及恶意文档指令；同时检查非模态面板、两轮消息、来源卡片、异步结果和目标移除。对应 A03～07/A11～12/A16～19/A66～70/A73～74/A76；记录实际工具/来源身份和字符预算，不记录私有推理日志。
3. **成果、冲突与撤销。** 在同一真实会话依次创建 Record、修改一个块、创建/更新 Todo、创建和两轮修改 File；默认模式只对同一任务确认一次，显式自动模式按用户选择执行。“更新计划并创建 3 项 Todo”另核按钮/文字确认一致、补充要求使旧决定失效及部分失败逐项结算。核页面即时刷新、稳定对象 ID、版本、旧字节、来源与操作收据。用同一请求 ID 重试并改 payload，人工后改后提交旧 patch，撤销修改、撤回新增再恢复；针对 File 执行阶段杀进程、磁盘满/DB 故障注入并复查 journal。对应 A08～10/A13/A25～41/A43～50/A75～76 的 AI 部分。另用真实模型生成 HTML File v1，核一次确认、成果链接与收据；读取完整源码，同 ID 连续续改为 v2/v3，读取固定历史源码、恢复为新版后再续改，并核 JS/CSS/CDN 引用字节保留及未验证交互的如实告知。A42 的隔离及 A43 的依赖/JS 诊断由 #118/#115 在目标 WebKit/WebView2 验收，不阻塞 AI 发布。
4. **知识与记忆。** 触发 Project Overview 初始化、源变更维护及停用/重开后补跑，核水位、partial、预算、纠正与来源；新会话询问较久以前的讨论，分别试有效摘要、摘要缺失、推翻决定和长历史分支，核有限原文回读、未执行建议未升格。覆盖 A02/A51～55/A59～65/A72。24h/48h 的调度结果需按真实设备时钟和离线恢复记录，不用单元测试时间代替。
5. **CLI/MCP 和授权。** 在应用打开且已绑定 Workspace 时，创建 Workspace/Project 范围的只读和协作连接，通过生产 CLI `mind doctor`、`mind project list`、`mind context get`、`mind mcp serve` 的 SDK 客户端查询，并用 `mind schema METHOD --json` 检查参数。只读连接尝试 create 应拒绝；新连接不能再选择对象白名单；旧对象连接在重选范围与模式前不能静默获得全范围读取或写入。内置助手在已启用 scope 自动获得会话读取能力，外部连接仍按持久 grant 核验。用可写连接保存、重试、撤销，再撤权并重复请求；关闭应用或切换 Workspace 后须为机器可识别错误且不另开 DB。核 CLI/MCP 与内置相同节点版本和有界结果。对应 A04/A09/A13～15/A37/A71 及 R12c；记录实际 SDK/CLI 响应与目标平台，不将 Linux keyring smoke 代替。

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

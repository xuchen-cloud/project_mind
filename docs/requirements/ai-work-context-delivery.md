# AI 工作上下文：当前交付总览

> 2026-10-23 记忆规则更新：当前以[记忆生命周期细则](workspace-memory-lifecycle.md)及[实现契约](../technical/memory-contract.md)为准。来源删除保留结论、默认静默语义整理与 24h 回退、DSH 真实读写接入及评测后切换 L1/L2 取代旧来源删除即失效、默认待审、Pi 记忆接入和永久全量快照规则；旧实现仅供历史追溯。其他业务权限、原子事务和非记忆功能规则保持适用。实施与验证状态逐项记录，未完成真实验收不关闭父 Issue。

更新：2026-10-10。本文是 AI 父需求 [#97](https://github.com/xuchen-cloud/project_mind/issues/97) 与[统一规格 #121](https://github.com/xuchen-cloud/project_mind/issues/121) 的唯一交付导航与覆盖总览；产品要求、工程契约和验收证据分别在下列权威文件维护。历史计划已[完整归档](archive/ai-work-context-delivery-history-20261010.md)，历史完成状态不代表本轮新增要求完成。

## 权威入口

| 需要判断的内容 | 唯一入口 |
| --- | --- |
| Context、Agent、作用域、记忆与整理行为、成果和用户体验 | [主规格](ai-work-context-spec.md) |
| 原生权限、来源证明、版本、事务、幂等、并发与恢复 | [工程契约](ai-work-context-engineering-spec.md) |
| Workspace 记忆与 Project 稳定背景、统一 Skill、生命周期和现行 US 场景（历史 ML 另存归档） | [记忆生命周期细则](workspace-memory-lifecycle.md) |
| A/现行 US 与历史 ML 验收编号对应的实际证据、覆盖和剩余缺口 | [逐项验收台账](ai-work-context-acceptance.md) |
| 旧 LM/WP/S/R/M/P 方案、估算、提交与带日期的验证记录 | [历史交付档案](archive/ai-work-context-delivery-history-20261010.md) |

负责人、工单依赖和关闭状态以现有 Issue 为准。历史编号保留用于追溯，不再形成另一条并行的可执行路线；当前覆盖单元只在此维护，细则和台账按同一单元引用。

<a id="current-delivery"></a>

## 当前交付覆盖

V1～V5 是按用户可用闭环整理的**交付覆盖单元**，用于对齐要求、现有实现和待验收差距，尚不是新增工单、已经批准的排期或原生依赖图。后续 `/to-tickets` 的工单审批、原生依赖确认及远端发布留待对应阶段，不因本文归并自动发生。表内历史单元只指向可复用证据，不沿用其“已完成”状态。

| 覆盖单元 / 现有 Issue | 用户可用的交付闭环 | 验收重点 | 历史覆盖映射（只用于追溯） |
| --- | --- | --- | --- |
| <a id="v1"></a>**V1 归属、保存与后续使用** / #109、#108、#103 | 长期记忆仅归 Workspace，项目稳定背景与约定进入 Project Overview；可使用的精简快照受当前授权与来源约束。明确保存、点名纠正/替换/停用或遗忘得到原生结果收据，并在下一次模型调用（含同一 Run）正确使用或停止使用。Project 读取 Workspace 记忆不取得其原文范围或写权限。 | owner/版本、真实用户请求及目标绑定、幂等、来源删除保留结论与事实级抑制；现行 US-01～05；真实 Provider 验跨来源语义遗忘。 | LM1/LM2/LM4/LM5；S7/R14c；WP2、R04f；A57/58/64～67/75。 |
| <a id="v2"></a>**V2 明确决定的 Overview 增量** / #101、#103、#105、#108 | 会话中真实用户的明确决定或命令提交有类型的 Overview 增量；点名纠正、替换或停用同样受理。沿入口既定执行模式和原生证明生效，模型不能自称用户已确认；普通对话不自动改写 Overview。下游 Workspace 只标相关依赖待核对。 | 消息/收据/来源证据/目标版本绑定、只读及先审阅/协作边界、未受影响条目保留；新增按需 Project 变化历史见 US-09；相关 A49/55/62～65/75。 | LM2/LM3/LM5；WP2/WP5；R04f/R10/R11；S6/R14b。 |
| <a id="v3"></a>**V3 行为与运行设置可编辑** / #109、#103、#102 | Workspace 一个统一 Skill 文件同时表达记忆行为和整理行为，各 Project 沿用；有文件修改权限时直接修改并告知实际结果，无额外草稿审批。Harness 提供结构化工具或脚本调整开关、时间和频率；新 Skill 在下一次 Provider 调用（含同一 Run 后续调用）生效。 | Skill 与运行设置分别核权限和保存；配置部分失败保留成功项、告知失败并只重试失败项；已发请求不重启，行为调整不删除已有记忆；行为/设置及刷新分别验收，相关 A18/59。 | LM2/LM4/LM5；S1、S2；WP2/WP4；R03/R04。 |
| <a id="v4"></a>**V4 联合整理、并发与容量** / #108、#109、#101、#102、#105 | 整理已有资料，可一次生成并联合发布 Project Overview 与 Workspace 记忆；并发会话增量后保留已发布结果、已结算进度及未消费来源，基于新版本重准备受影响部分。Workspace 合并核对下游变化；记忆容量、实际输入预算和前台让出明确可见。 | 联合原生发布保持两处原子性；配置部分成功规则不放宽此事务。权限/策略复核、恢复重放零重复、容量满与冲突不热循环；现行 US-06～08，联合发布目标独立验收；相关 A52～60/64/65。 | LM3/LM4/LM5；WP4/WP5；S3/S6；R10/R11/R14b。 |
| <a id="v5"></a>**V5 真实接入与产品签收** / #107、#106、#97（并覆盖受影响的既有子 Issue） | 对 V1～V4 及原有问答、原生 Record/Todo/File 保存、版本、撤销/恢复、成果入口和既有 CLI/MCP 完成实际调用链验收；真实 Provider 与原生目标桌面平台分别记录结果。 | A/现行 US 逐项证据及 E16；真实模型理解/使用质量、macOS arm64/x64 与 Windows x64 安装和桌面体验、已有外部接口与原生成果回归。mock、Linux 容器和内部服务通过不替代签收。 | LM5、WP6、S4/S8、R01/R05～07/R09/R12/R13；A01～76 的当前 AI 范围。 |

开工先确认归属、授权和原生保存/读取依赖，再按上述闭环补实际差距。已有知识、来源证明、版本、当前 DSH 会话、草稿/进度、原生事务及成果服务先复用；详细依赖在后续工单阶段确认，不要求历史上游 Issue 先关闭，也不重复建设已验证服务。

## 已确认的范围与边界

产品分为 Context 与 Agent，当前 Project 聊天与记忆工具接入 DSH；旧 Pi 路径仅作历史证据。Workspace 记忆和 Project Overview 稳定背景保留各自身份；记忆行为与整理行为按发生场合区分，两者都可更新 Overview 和记忆。模型判断语义，原生层绑定真实消息、收据、证据和版本；来源文字、引用中的命令、结构变化及模型自己的声明不构成用户确认。结构操作产生的变化由整理流程处理。

本轮不做旧 AI 数据迁入、兼容或历史身份映射，原有业务资料保持其语义。既有对外 Mind CLI/MCP 继续维护，外部运行时与任务菜单 #110/#111（历史 R15）及无界面 Host #112（历史 R16）暂缓。项目内 HTML/Markdown/Word/Excel/PPT 编辑与预览归[独立需求](project-file-integration.md)及 #118/#115，不是本轮 AI 发布前置；AI 仍承担文件生成、源码读取、同 File ID 续改、保存/版本/撤销及成果链接。

## 独立 AI 网络连接包 NP1

远端 `71e6aff` 的 [#119](https://github.com/xuchen-cloud/project_mind/issues/119) 与[AI 代理需求](ai-network-proxy.md)保持独立：同 Workspace 共用系统代理、自定义 HTTP/HTTPS 或直连，原生 Provider 与 Node 调用已本地接线；Windows/macOS 实际系统设置验收仍待完成。原有需求、提交和验证证据原样保留，不因本轮记忆规格整理改变验收状态。

## 执行记录与完成判断

- 开工写清当前覆盖单元、关联 Issue、依赖、交付行为、非目标和受影响验证；沿当前规格逐项判断已有实现与缺口。
- 每次收口记录实际调用链、提交 SHA、验收编号、有效验证、平台/Profile 和残余阻塞；历史证据仅在相关输入未变化且确实覆盖当前要求时复用。
- 分别判断内部服务实现、真实产品接线、真实 Provider 和目标平台签收；文档归并或定向测试通过不使 V/A/ML 自动完成，不关闭 Issue。缺少平台或账号时记录具体解锁条件，继续独立工作。
- 2026-10-10 的文档归并与历史实施拆分仅供追溯。2026-10-23 的 #219 正在实现与真实验收；本次文档修订只检查差异、链接、锚点和规则一致性，不运行构建、不宣告 gate 完成或关闭工单。最终执行证据由主 agent 收口更新。

## 2026-10-23 #219 阶段性实施状态

阶段证据以[验收台账](ai-work-context-acceptance.md#memory-stage-20261023)为准：原生 fact store、source/adoption delivery、Project history、behavior、后台 existing-facts 及逐条回答透明度的定向测试已通过；具体用例、数量和依赖闭包检查统一记在该台账，重叠测试不合计。后台真实模型 attempt 3 已通过 merge 后 inferred、保留条件、回退成员恢复锁定及独立条目不变，usage input 1025 / cacheRead 512 / output 524 / total 2061；前两次输出协议失败零 mutation 的记录保留。

当前后台只整理已有 fact，不从新 sources 提取，也没有交付 Project Overview + Workspace 记忆联合原子发布；这两项仍是 V4 的明确缺口。逐条回答采用透明度已实现：SDK `conversation.chat.turnTail` 绑定真实 session / turn / step，保存本次采用的不可变版本并在对应回答展示。Project 变化历史已有只读原生服务，Agent 工具真实接入/使用证据须另验。5 个真实 P0 smoke 已通过，其中源删除为 host 原生 fixture 附加来源后实际删除临时文件，不代表模型实际读源。60 场景三臂 180 次请求已完成，分层 gate 未通过；最新 `failed_write` 修复使用宿主原生错误通知结束本轮，Node 14 项通过，真实模型复验尚未执行。用户要求暂停，继续入口见[进度与交接](../technical/memory-progress-20261023.md)。默认仍为预算内 snapshot，实验 L1/L2 待真实评测 gate；不宣告 #219 或 V4 完成，不关闭 Issue。历史 [ML01～ML22](archive/workspace-memory-lifecycle-history-20261010.md#10-验收场景)仅供追溯，现行记忆场景见生命周期 US-01～US-09。

## 历史深链

原 delivery 深链保留在下方，每项均转到历史原文。历史文本不是当前执行要求；实施以本页 V1～V5 和上方权威入口为准。

| 常用旧入口 | 历史原文 |
| --- | --- |
| <a id="workspace-memory-revision-20261010"></a>2026-10-10 记忆修订及旧 LM1～LM5 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#workspace-memory-revision-20261010) |
| <a id="confirmed-work-packages-20261009"></a>2026-10-09 旧 WP1～WP6 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#confirmed-work-packages-20261009) |
| <a id="delivery-audit"></a>2026-10-08 交付审查快照 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#delivery-audit) |
| <a id="intent-audit-20261009"></a>2026-10-09 初衷与实现审视快照 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#intent-audit-20261009) |
| <a id="r01"></a>旧 R01 安装资源与真实模型 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r01) |
| <a id="r04-gui"></a>旧 R04d～g 会话 GUI | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r04-gui) |

<details>
<summary>展开原计划、审查、执行记录与验收矩阵的锚点索引</summary>

| 保留的旧入口 | 历史原文 |
| --- | --- |
| <a id="ai-工作上下文交付计划与验收"></a>AI 工作上下文：交付计划与验收 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#ai-工作上下文交付计划与验收) |
| <a id="workspace-记忆关系与生命周期调整2026-10-10当前新增执行包"></a>Workspace 记忆关系与生命周期调整（2026-10-10，当前新增执行包） | [查看原文](archive/ai-work-context-delivery-history-20261010.md#workspace-记忆关系与生命周期调整2026-10-10当前新增执行包) |
| <a id="已确认变更的-wp1wp6-执行表2026-10-09"></a>已确认变更的 WP1～WP6 执行表（2026-10-09） | [查看原文](archive/ai-work-context-delivery-history-20261010.md#已确认变更的-wp1wp6-执行表2026-10-09) |
| <a id="d1-交付批次与顺序"></a>D1 交付批次与顺序 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d1-交付批次与顺序) |
| <a id="用户确认的后续执行顺序2026-10-09"></a>用户确认的后续执行顺序（2026-10-09） | [查看原文](archive/ai-work-context-delivery-history-20261010.md#用户确认的后续执行顺序2026-10-09) |
| <a id="s3-实施边界按模型容量准备摘要输入"></a>S3 实施边界：按模型容量准备摘要输入 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#s3-实施边界按模型容量准备摘要输入) |
| <a id="s4-实施边界当前环境的性能与使用验证"></a>S4 实施边界：当前环境的性能与使用验证 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#s4-实施边界当前环境的性能与使用验证) |
| <a id="rust-测试清理2026-10-09关联-97107"></a>Rust 测试清理（2026-10-09，关联 #97/#107） | [查看原文](archive/ai-work-context-delivery-history-20261010.md#rust-测试清理2026-10-09关联-97107) |
| <a id="d2-工作包与估算"></a>D2 工作包与估算 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d2-工作包与估算) |
| <a id="d2a-2026-10-08-交付审查快照"></a>D2a 2026-10-08 交付审查快照 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d2a-2026-10-08-交付审查快照) |
| <a id="必须解决的问题"></a>必须解决的问题 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#必须解决的问题) |
| <a id="d2a-2-2026-10-09-初衷与当前实现审视"></a>D2a-2 2026-10-09 初衷与当前实现审视 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d2a-2-2026-10-09-初衷与当前实现审视) |
| <a id="规划工作包逐项对照"></a>规划工作包逐项对照 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#规划工作包逐项对照) |
| <a id="旧版三个小包快照现以-wp1wp6-为准"></a>旧版三个小包快照（现以 WP1～WP6 为准） | [查看原文](archive/ai-work-context-delivery-history-20261010.md#旧版三个小包快照现以-wp1wp6-为准) |
| <a id="d2b-范围与实现取舍"></a>D2b 范围与实现取舍 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d2b-范围与实现取舍) |
| <a id="d2c-从当前基线继续的执行包"></a>D2c 从当前基线继续的执行包 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d2c-从当前基线继续的执行包) |
| <a id="r01-安装资源与真实模型可行性--98113"></a>R01 安装资源与真实模型可行性 / #98、#113 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r01-安装资源与真实模型可行性--98113) |
| <a id="r02-资料读取正式接入--100113"></a>R02 资料读取正式接入 / #100、#113 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r02-资料读取正式接入--100113) |
| <a id="r03-最小生产-host-与会话--98102"></a>R03 最小生产 Host 与会话 / #98、#102 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r03-最小生产-host-与会话--98102) |
| <a id="r04-第一个可用问答界面--103100102"></a>R04 第一个可用问答界面 / #103、#100、#102 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r04-第一个可用问答界面--103100102) |
| <a id="r05-record-成果与操作记录--104113116"></a>R05 Record 成果与操作记录 / #104、#113、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r05-record-成果与操作记录--104113116) |
| <a id="r06-todo-修订与可撤销操作--104116"></a>R06 Todo 修订与可撤销操作 / #104、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r06-todo-修订与可撤销操作--104116) |
| <a id="r07-file-成果产品接入--104114116"></a>R07 File 成果产品接入 / #104、#114、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r07-file-成果产品接入--104114116) |
| <a id="r04dg-助手会话-gui-收口--103104116"></a>R04d～g 助手会话 GUI 收口 / #103、#104、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r04dg-助手会话-gui-收口--103104116) |
| <a id="r04d-非模态布局会话保留与设置退后台--103"></a>R04d 非模态布局、会话保留与设置退后台 / #103 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r04d-非模态布局会话保留与设置退后台--103) |
| <a id="r04e-同轮消息分组markdown与过程折叠--103"></a>R04e 同轮消息分组、Markdown与过程折叠 / #103 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r04e-同轮消息分组markdown与过程折叠--103) |
| <a id="r04f-同用户任务一次方案确认与文字决定--104116"></a>R04f 同用户任务一次方案确认与文字决定 / #104、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r04f-同用户任务一次方案确认与文字决定--104116) |
| <a id="r04g-真实成果入口与继续编辑--103104116"></a>R04g 真实成果入口与继续编辑 / #103、#104、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r04g-真实成果入口与继续编辑--103104116) |
| <a id="r08原编号保留文件编辑预览已迁出--118115"></a>R08（原编号保留）文件编辑预览已迁出 / #118、#115 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r08原编号保留文件编辑预览已迁出--118115) |
| <a id="r09-跨成果协作收口--104116"></a>R09 跨成果协作收口 / #104、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r09-跨成果协作收口--104116) |
| <a id="r10-自动项目知识维护--101102100103"></a>R10 自动项目知识维护 / #101、#102、#100、#103 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r10-自动项目知识维护--101102100103) |
| <a id="r11-会话成为可追溯知识--105102"></a>R11 会话成为可追溯知识 / #105、#102 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r11-会话成为可追溯知识--105102) |
| <a id="r12-climcp-与连接设置--106"></a>R12 CLI/MCP 与连接设置 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12-climcp-与连接设置--106) |
| <a id="r12b3c-第一子步record-补丁预览与-cli-dry-run--106"></a>R12b3c 第一子步：Record 补丁预览与 CLI dry-run / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12b3c-第一子步record-补丁预览与-cli-dry-run--106) |
| <a id="r12b3c-第二子步filetodo-cli-常用参数--106"></a>R12b3c 第二子步：File/Todo CLI 常用参数 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12b3c-第二子步filetodo-cli-常用参数--106) |
| <a id="r12b3c-第三子步record-markdown-创建与创建预览--106"></a>R12b3c 第三子步：Record Markdown 创建与创建预览 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12b3c-第三子步record-markdown-创建与创建预览--106) |
| <a id="r12c-第一子步workspace-优先的连接授权预设--106"></a>R12c 第一子步：Workspace 优先的连接授权预设 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12c-第一子步workspace-优先的连接授权预设--106) |
| <a id="r12b3c-第四子步record-恢复与-file-替换的-cli-参数--106"></a>R12b3c 第四子步：Record 恢复与 File 替换的 CLI 参数 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12b3c-第四子步record-恢复与-file-替换的-cli-参数--106) |
| <a id="r12b3c-第五子步record-正文快捷读取--106"></a>R12b3c 第五子步：Record 正文快捷读取 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12b3c-第五子步record-正文快捷读取--106) |
| <a id="r12b4原生内容的入链与出链--106"></a>R12b4：原生内容的入链与出链 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12b4原生内容的入链与出链--106) |
| <a id="r12c-第二子步正式安装包携带-cli--106"></a>R12c 第二子步：正式安装包携带 CLI / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12c-第二子步正式安装包携带-cli--106) |
| <a id="r12c-第三子步可逆的用户级-cli-安装--106"></a>R12c 第三子步：可逆的用户级 CLI 安装 / #106 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12c-第三子步可逆的用户级-cli-安装--106) |
| <a id="r12c-第四子步指定-recordfile-的连接授权--106历史实现记录"></a>R12c 第四子步：指定 Record/File 的连接授权 / #106（历史实现记录） | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r12c-第四子步指定-recordfile-的连接授权--106历史实现记录) |
| <a id="r13-m1-集成目标安装包与发布--107收口-98100106113114116"></a>R13 M1 集成、目标安装包与发布 / #107，收口 #98/#100～106/#113、#114、#116 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r13-m1-集成目标安装包与发布--107收口-98100106113114116) |
| <a id="r13a-第一子步可追溯的验收台账与执行入口"></a>R13a 第一子步：可追溯的验收台账与执行入口 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r13a-第一子步可追溯的验收台账与执行入口) |
| <a id="r14-workspace-助手与长期记忆--108109"></a>R14 Workspace 助手与长期记忆 / #108、#109 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r14-workspace-助手与长期记忆--108109) |
| <a id="s5--r14aworkspace-入口与既有业务工具"></a>S5 / R14a：Workspace 入口与既有业务工具 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#s5--r14aworkspace-入口与既有业务工具) |
| <a id="s6--r14b从变化的项目理解更新-workspace"></a>S6 / R14b：从变化的项目理解更新 Workspace | [查看原文](archive/ai-work-context-delivery-history-20261010.md#s6--r14b从变化的项目理解更新-workspace) |
| <a id="s7--r14c可查看纠正和停用的长期条目"></a>S7 / R14c：可查看、纠正和停用的长期条目 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#s7--r14c可查看纠正和停用的长期条目) |
| <a id="s7s8-本地收口记录2026-10-09"></a>S7/S8 本地收口记录（2026-10-09） | [查看原文](archive/ai-work-context-delivery-history-20261010.md#s7s8-本地收口记录2026-10-09) |
| <a id="r15-外部-agent-与任务菜单--110111"></a>R15 外部 Agent 与任务菜单 / #110、#111 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r15-外部-agent-与任务菜单--110111) |
| <a id="r16-独立-workspacehost-与全需求收口--11297"></a>R16 独立 WorkspaceHost 与全需求收口 / #112、#97 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#r16-独立-workspacehost-与全需求收口--11297) |
| <a id="d2d-顺序停止条件与证据"></a>D2d 顺序、停止条件与证据 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d2d-顺序停止条件与证据) |
| <a id="d3-验收矩阵"></a>D3 验收矩阵 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d3-验收矩阵) |
| <a id="基础体验与权限"></a>基础体验与权限 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#基础体验与权限) |
| <a id="record块编辑与版本"></a>Record块编辑与版本 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#record块编辑与版本) |
| <a id="file版本服务"></a>File版本服务 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#file版本服务) |
| <a id="html交互稿"></a>HTML交互稿 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#html交互稿) |
| <a id="自主执行与撤销"></a>自主执行与撤销 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#自主执行与撤销) |
| <a id="project知识维护"></a>Project知识维护 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#project知识维护) |
| <a id="会话知识"></a>会话知识 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#会话知识) |
| <a id="渐进式披露"></a>渐进式披露 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#渐进式披露) |
| <a id="quicknote与overview隔离"></a>QuickNote与Overview隔离 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#quicknote与overview隔离) |
| <a id="后续批次"></a>后续批次 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#后续批次) |
| <a id="助手会话gui"></a>助手会话GUI | [查看原文](archive/ai-work-context-delivery-history-20261010.md#助手会话gui) |
| <a id="d4-验证与发布"></a>D4 验证与发布 | [查看原文](archive/ai-work-context-delivery-history-20261010.md#d4-验证与发布) |

</details>

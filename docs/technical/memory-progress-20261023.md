# 记忆系统进度与交接 · 2026-10-23

关联 [#219](https://github.com/xuchen-cloud/project_mind/issues/219)，依赖及覆盖关系为 #109 / #108 / #103（V1–V5）。当前分支 `codex/memory-system`，基线 `32a9c407a1a6e3642cfa5c7ea38fc5f8ee22c108`。

**状态：按用户要求暂停，保存阶段提交。功能尚未完整验收，不合并 develop、不关闭 #219。** 当前默认策略仍为预算内精简 `snapshot`；实验性 `layered` 的真实评测未过门槛。最终 Standards / Spec 发布审查尚未完成，已有自查与定向修复不能替代发布门禁。

保存状态：阶段提交 `2520988` 已于 2026-10-23 成功推送至 `origin/codex/memory-system`。首次推送曾因 GitHub TLS 连接错误 `SSL_ERROR_SYSCALL` 失败，后按用户要求重试成功。本次仅同步分支与进度，不触发合并或关闭 Issue。

## 本包范围及已确认决策

交付目标是原生记忆版本服务、DSH 真实工具和 Skill 接入、用户管理与采用透明度、后台整理、按需 Project 历史及真实模型评测。非目标是迁移未使用的旧记忆、改写 Record/File/Todo 业务数据、引入另一套后台守护进程，或在未过门槛时切换分层默认值。

- 默认整理可以静默改变语义，包括已确认内容；确认属于具体版本，机器新版本标为推断。24 小时内按原子操作单元回退；可选审批开关开启后才先审批。
- 删除或归档来源保留已保存结论；读取来源仍检查真实归属与当前权限。Workspace / Project 隔离由原生层执行。
- 记忆行为由 Workspace Skill 指导，工具执行操作，SQLite 负责事务、CAS、幂等回执、抑制和回退。模型声称“已保存”不作为成功依据。
- Project Overview 历史按需读取既有不可变版本及 Project 事实变化，不编造变更原因，不常驻注入旧结论。
- 后续测评子 agent 使用 `gpt-6.1-sol`；本轮实际被测 Provider 模型是 `deepseek-flash`，两者不同。未获授权启动 review 子 agent，最终审查由主 agent 完成。

## 已实现与证据边界

| 工作包 | 当前实现 | 证据及边界 |
| --- | --- | --- |
| 原生记忆底座 | 事实/不可变版本、六类 Workspace 与 Project 约定/决策、CAS、幂等、条件/有效期、遗忘抑制、审批、独立操作及整组合并回退 | store 19 项通过；不提供旧记忆迁移层 |
| 来源与实际采用 | 同 Session 来源交付与实际归属校验；源删除保留结论；按回答的 session / turn / step 记录实际采用的不可变版本 | 来源 4 项、采用 3 项通过；共享结论不泄露其他 Project 原文 |
| DSH / Skill | 真实记忆工具、下一请求刷新、退役旧工具记忆内容、行为文件 CAS 编辑、运行设置编辑、真实来源消息分页回读 | Node 7 单元 + 7 实际 SDK runtime 项通过，原文边界 4 项；原生 SQLite→Node→本地确定性 Provider 集成已通过，但早于最后的失败收尾改动 |
| 管理界面 | 记忆编辑/遗忘/停用、审批、最近 24h 与回退、来源状态、行为及调度编辑、逐条回答采用展示 | 管理 11、行为 3、调度 3、API 1、采用 2、聊天父组件 30、launcher 5 项通过；无应用窗口人工验收 |
| 后台整理 | 复用现有调度，限量整理已有事实；持久任务/原始结果/usage、崩溃恢复、前台运行让行 | 原生维护 11、既有 Overview 26 项通过；真实后台 attempt 3 的 9 项断言通过，前两次协议错误零修改并保留成本记录 |
| Project 历史 | 读取真实 Overview 和 Project 事实版本差异、来源指针、有界游标、条件/有效期/确认变化 | 原生 8 项及工具桥确定性集成通过；真实模型历史任务尚未完整验收 |
| 保存失败收尾（最后改动） | 原生失败结果先归档，宿主直接显示“本次记忆未保存”及真实错误并结束本轮；不再调用模型生成失败说明。同批后续工具阻断，CAS 重读重试、新用户恢复及 Session 隔离保留 | 最新 Node 14 项通过；真实 Provider 复验待做，不能用之前 5 条 failed_write 结果证明此次修复通过 |

完整命令与范围见[实现契约](memory-contract.md#local-verification-2026-10-23)，产品验收项见[验收台账](../requirements/ai-work-context-acceptance.md#memory-stage-20261023)。测试组有重叠，不汇总为唯一用例总数。

TypeScript、Vite、DSH 语法、UI standards、bundle boundaries 已通过；主包 249 KiB / 250 KiB。运行时 staging 17 项在原全量与单项 fixture 修正复跑中各有通过记录；adapter 闭包 39 entries / 1046 modules。未改范围复用已有结果，不重复全量运行。全仓 portable-paths 有既有无关违规，本轮新增内容单独检查；既有构建警告保留。

## 真实评测结论

60 个中文场景、120 个真实原生用户轮次；修正评测指令后完成新版三组 180/180 次真实请求。评测产物、答案、调用量和 fingerprint 见[结果报告](../../scripts/memory-evaluation/results/2026-10-23/README.md)及[评测说明](memory-evaluation.md)。

| 指标 | snapshot | layered | 结论 |
| --- | ---: | ---: | --- |
| 平均边际记忆输入 token | 203.90 | 196.48 | 仅减少 3.64%，低于 35% 门槛 |
| 平均首个可见内容延迟 ms | 2250.53 | 2470.37 | 增加 9.77%，未满足不增加要求 |
| 逐条语义 rubric | 未评分 | 未评分 | 180 条待审，不宣称质量不下降 |

gate 为 `not-passed`。每臂只重复一次，原生当前有效事实 0–2 条；不能外推为长期大量记忆的表现或声称延迟差异有统计显著性。旧 103 次缺少完整生产指令的请求仅作诊断和费用证据，不混入新版结论。

已测消耗下限为输入 9,544,442、输出 325,568 token，包含历史诊断、原生历史、新旧三组及后台尝试；中断且没有 usage 的消耗未知，不是完整账单。明文临时评测配置和导出脚本在停止时删除；原始私有工具/Provider 排障轨迹不提交，仓库仅保存已筛查的测试证据。

## 下一次从这里继续

1. **修正日期工具说明并定向复验 current-2。** `packages/dsh-assistant/scripts/memory-service.mjs` 的 `CHANGE_HELP` 仍写 `ISO-date`，实际原生只接受带时区的 RFC3339 时间戳。改说明和示例，避免猜测纯日期时区或放宽校验；当前该场景因写入被拒绝而没有事实。
2. **复验最后的保存失败修复。** 调整 `src-tauri/src/dsh_memory_model_evaluation.rs` 中 failed_write 的结束原因及通知读取断言，按真实 `turn/end reason.kind=error` / 官方 turn-error 验证；保留真实错误、零写入、无第二次 Provider 请求、下一真实用户恢复。只先重跑这 5 条和受影响集成，不重复所有已过测试。
3. **区分评测路径与产品缺陷。** history-1 保存了去年/今年事实，但直接三组没有工具且 Context 只给当前事实；用真实 `project_history` 路径验证历史任务，不把过期事实塞回当前上下文。confirmed_drift-4/snapshot 只输出未执行的 `memory_schedule` DSML，须核查无工具评测与实际工具流程的差别。
4. **完成语义评分及分层决策。** 审读原始答案填写有归因的 rubric；处理 isolation-5 的词法漏召回（“验收找谁”未命中已存负责人）。维持 snapshot 默认，不改门槛或增加无关噪声求通过；新代码/协议复验用新 fingerprint 和新产物，保留旧失败证据。
5. **补齐交付缺口。** 当前后台只整理已有 fact，尚未从新 sources 提取，也未实现 Overview + Workspace 联合原子发布。目标设备界面与完整真实产品验收仍待执行，不能把内部服务通过当作整包完成。
6. **满足发布门禁后再发布。** 复用仍有效的通过记录，补受影响验证，完成主 agent Standards / Spec 双轴审查；按仓库 publish-flow 创建/合并 PR、关闭真正已完成的 Issue。本检查点不关闭 #219 或父 Issue。

恢复时先检查分支工作区、既有通过日志和评测 fingerprint，不从头重做。运行真实评测需重新从用户已有 Workspace 配置取得受限临时凭据；不要在聊天或日志输出密码、密钥。开发前仍检查 Tauri 自动重启进程，保持编译与单测静默。

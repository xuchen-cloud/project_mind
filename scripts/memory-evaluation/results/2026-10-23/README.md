# 2026-10-23 真实模型测评

模型：deepseek-flash；60 个中文场景，120 个真实原生 DSH 用户轮次，三臂各 60 次，共 180 次真实 streaming 请求，单次重复。结论为 **not-passed**，默认保持 **snapshot**。已有明确计量及原生断言失败，任务/偏好均分未评分，不据此宣称质量不降。

| 指标均值 | none | snapshot | layered |
| --- | ---: | ---: | ---: |
| 实际输入 token | 725.60 | 929.50 | 922.08 |
| 边际记忆输入 token | 0 | 203.90 | 196.48 |
| 序列化记忆字节 | 0 | 525.30 | 497.57 |
| 返回事实数 | 0 | 1.10 | 1.02 |
| 可见 TTFT ms | 3894.45 | 2250.53 | 2470.37 |

layered 边际记忆输入减少 3.64%，低于 35%；TTFT 增加 219.84 ms（9.77%），不满足不增加要求。仅一次重复，网络、缓存与排队均在 TTFT 内，不能据此宣称统计显著。

证据入口：

- [完整 180 答案与实际计量](three-arm.json)、[门槛汇总](summary.json)、[未评分表](ratings.json)。
- [原生 fixtures](native-fixtures.json)、[setup 审计](setup-audit.json)、[源码及原始输入 fingerprint](manifest.json)。
- [筛查候选原文](screened-answers.json) 仅供主 agent 审读，regex 不是语义评分。
- [重点原生失败与五条 failed_write 证据](native-focused-evidence.json) 只含最终回答、原生事实/断言与回执，不含工具返回的目录清单。
- [调用消耗账本](usage-ledger.json) 区分当前原生历史、旧失败写入、其他原生诊断、旧 103 次不完整指令三臂、新 180 次及三次后台整理。已测输入 9544442、输出 325568 是有证据的下限；中断但未返回 usage 的请求数量和消耗未知，不能称完整账单。

已知真实问题：

- current-2：原生工具说明允许 ISO-date；模型提交纯日期，服务拒绝 Invalid validity timestamp，故两臂均无保存事实可答 20 次。
- history-1：原生保存去年周一、今年周三，Context 两臂均只返回今年条目，历史问题不可完成。
- isolation-5：原生保存“项目乙是周宁”，layered 词法查询没有召回，回答“不知道验收确认人”；snapshot 给出先找周宁的建议，并明确记录缺少验收角色。
- confirmed_drift-4 / snapshot：答案仅为 memory_schedule 的原始 DSML 文本，未完成事实与确认状态回答。三臂调用不提供工具，因此该文本没有被执行或修补。
- 五条 failed_write：本轮真实桥各一次拒绝 apply、零事实、同轮 tools=0、下一用户轮恢复。模型首轮仍有两条未执行 bash DSML、一次虚构重复调用叙述；末轮均说明未保存，不能抹掉首轮问题。

筛查可见的误报包括“路径穿越/路径遍历”同义词、90 天的空格、正确否定摄氏度/一百人/停用银杏前缀，以及先给采购结论但未使用“建议/推荐”字样。failed_write-4 的 layered 回答转向行为文件/调度，虽说明事实未落库，是否充分回答须由主 agent 按原文判断。原始筛查与答案均保留，没有改语料或重调用追求通过。

原生有效事实 0–2 条，均值 1.1833；40 例有完成时源码 fingerprint，早期 20 例只有原始 Provider/桥/状态记录；三臂每例组内复用其实际捕获的完整 Skill 和可信作用域，原生历史包含两版 Skill。该小样本不能外推为长期数百条记忆的收益。confirmed_drift-2 的 fixture 正文拓宽为开发及测试，但条件仍“仅在测试环境”；来源删除是 host 附加实际临时来源后删除文件；原生 organize/rollback fixture 均不冒称后台模型提出。

后台真实三次报告位于 [attempt 1](../../../../docs/technical/evidence/memory-background-20261023-attempt-1.json)、[attempt 2](../../../../docs/technical/evidence/memory-background-20261023-attempt-2.json)、[attempt 3](../../../../docs/technical/evidence/memory-background-20261023-attempt-3.json)。前两次拒绝且零修改，第三次九项断言通过；三次总 token 8092。不与原生 fixture 操作混称。

冻结原始 fixtures SHA-256：`b400d5e84752434ba4be24542c7525e10667ee46738bc6bf0fdd2711a95178eb`。三臂 run fingerprint：`733db337fdc2e24e1c75df05f364e8d0266d9fa5067f02dadad3126693414c3c`。导出仅替换机器路径；fixtures 的 cases 部分不存在机器路径，实际三臂消息内容可复用。完整本机 Provider/工具排障记录不提交。

## 代码检查点说明

本报告冻结的是上述真实运行，不代表暂停提交的所有最新实现。报告完成后保存失败已改为宿主原生 `turn-error` 直接收尾（保留真实工具错误，不再调用 Provider 生成说明），14 项 Node 测试通过，真实模型尚未复验。日期说明修正、历史工具路径核验、rubric 评分及其余缺口见[进度与交接](../../../../docs/technical/memory-progress-20261023.md)。保留原始结果和 fingerprint，后续复验使用新产物。

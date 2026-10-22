# 中文记忆三组评测

关联 #219（完整 US01–US08 与分层 gate）及 #109 / #108 / #103，对齐 [生命周期规格 §6](../requirements/workspace-memory-lifecycle.md) 与 [实现契约](memory-contract.md)。交付物是可重复运行的真实 Provider 评测工具和 60 个原创多轮场景；**工具自测通过不表示产品语义通过**。没有真实原生上下文、真实模型调用、归因明确的 rubric 评分和生命周期证据时，不满足上线门槛，默认策略继续使用 snapshot。

## 范围与验收

交付：相同模型、相同末轮任务的 none / snapshot / layered 三臂调用；实际 Provider input usage、首个可见内容 TTFT；逐条答案、特征筛查、归因明确的 rubric 评分和可审计门槛汇总。依赖原生/DSH 运行器执行历史操作并导出上下文。非目标：实现另一套记忆、模拟检索宣称通过、发现密钥、自动切换默认策略。仅运行本目录自测，不启动应用窗口或重复全量构建。

`scenarios.json` 包含 12 类各 5 条不同措辞的场景：日常汇报、技术推导条件、项目隔离、主动遗忘、失败回执、删除来源、当前有效性、历史查询、单项回退及同批独立条目、已确认事实静默语义漂移、同源独立事实抑制、同义改写偏好。`build-scenarios.mjs` 是可审阅的手写语料生成源，重新生成应得到同样文件。

每条 `history` 至少两个用户轮次，`setup.instructions` 定义需要建立的真实生命周期状态；这些文字不是已经发生过的操作回执。原生适配器必须把 setup 映射到真实存储/DSH 操作并记录实际结果。不要把 setup 的“已撤回”等叙述当作已通过证明。完整端到端评测应让历史轮次经过真实 DSH/Provider，再导出末轮上下文；直接数据库种子仅用于检索组件实验，不能置 `realConversationExecution: true`。

## 原生上下文接口

CLI `--fixtures native-contexts.json` 接受如下 JSON。这里是结构示例，不是可用或已通过的测试数据：

```json
{
  "provenance": {
    "kind": "native",
    "revision": "实际提交或改动标识",
    "command": "可复现的原生导出命令",
    "realConversationExecution": false,
    "backgroundOrganizationUsage": {"inputTokens": 0, "outputTokens": 0}
  },
  "cases": {
    "report-1": {
      "sharedInstructions": {
        "memoryPrelude": "从该场景实际 Provider 请求捕获的原文 prelude",
        "behavior": "从当次 behavior.content 捕获的完整 Skill",
        "scope": {"kind": "workspace"}
      },
      "sharedMessages": [],
      "snapshot": {"context": "原生 snapshot 输出的实际上下文", "evidence": {}},
      "layered": {"context": "原生 layered 输出的实际上下文", "evidence": {}}
    }
  }
}
```

必须导出全部 60 个 case 的两种上下文。`context` 包含原生返回的 `facts`、`negativeConstraints`、`omittedIds`，评测器不编造事实或实现另一套检索。`audit-setups.mjs` 从每场景真实 Provider 请求捕获 memory prelude 和完整 `behavior.content`，从实际桥 context 请求取得可信 scope；三臂共享 Skill、scope、相同 `request` 和 `sharedMessages`，两个记忆臂再以原文 prelude 包装各自原生上下文。none 不注入任何事实或抑制 payload。项目名来自原生 fixture 创建的项目乙，非模型推测。后者只能放当前请求必须看见的真实工具结果（如失败保存回执），不能塞入完整历史，否则无记忆基线被污染。保存下来的历史通过记忆进入后两臂。若末轮需要同一会话中的短期事实，三臂必须共享相同短期消息。

原生运行器针对场景 dimension 输出以下布尔断言。每个 true 必须有相应真实执行/存储检查支撑；不得仅凭语料描述填 true：

| dimension | `evidence` 字段 |
| --- | --- |
| isolation | `isolated`：未召回项目甲事实 |
| forget | `suppressionPreserved`：遗忘后再次出现来源仍被抑制，独立事实不受误伤 |
| failedWrite | `writeReceiptTruthful`：失败/未知状态没有成功回执 |
| sourceRemoved | `retainedConclusionAvailable`：源文件删除后已保存结论仍存在且参与上下文 |
| rollback | `restoredAndUnrelatedPreserved`：下一次请求已恢复整理前版本且未改动另一条；`rollbackMs` 为真实测量耗时 |
| organization | `newVersionInferred`：静默语义更新形成推断版本 |
| time | `validityRespected`：当前/历史查询使用相应有效版本 |

回退的“秒级”在本工具中明确采用 ≤2000 ms。组织消耗记录真实 Provider input/output usage；没有测量就省略字段，汇总会阻止通过，不得用零代替未测量。来源原文可用性与已保存结论有效性应分别断言。

## 运行

普通 CLI 的凭据通过环境变量提供；`run-real.mjs` 仅读取用户明确指定的私有配置文件。不发现或扫描配置，不保存请求头。`MEMORY_EVAL_ENDPOINT` 是完整 OpenAI-compatible `/v1/chat/completions` URL，远程必须 HTTPS。模型由 `MEMORY_EVAL_MODEL` 固定，密钥为 `MEMORY_EVAL_API_KEY`。Provider 必须支持 streaming 和 `stream_options.include_usage`；缺少真实 usage、可见首字或完整 DONE 时失败，不回填估算。

```sh
node --test scripts/memory-evaluation/evaluate.test.mjs
node scripts/memory-evaluation/evaluate.mjs --fixtures /absolute/native-contexts.json --out /absolute/report.json --repetitions 3
node scripts/memory-evaluation/evaluate.mjs --summarize /absolute/report.json --ratings /absolute/report.json.ratings.json --out /absolute/summary.json
```

每轮采用温度 0，轮换三臂调用顺序；建议至少 3 次重复观察噪声。每个已完成请求立即写入 `.partial.jsonl`，中途失败不丢已完成答案，也不形成通过报告。完整输出含原始答案、usage、TTFT、特征和原生断言，并生成待填写的 ratings 文件。报告包含场景文本和答案，按测试数据管理，不要在真实场景里放秘密。

## 评分和门槛

Regex `required/forbidden` 只做可解释的机器筛查。否定句、引用和同义表达可能造成误报；应检查并改进语料规则后重跑受影响范围，不能把 regex 当成语义真值。归因明确的 rubric 评分必须匹配原始 answer，并填写 reviewer、notes 和以下字段，每条每臂每次重复独立评分。主 agent 可以按 rubric 审读评分，并标记 reviewer 为 primary-agent；不要求用户逐条审批。可选模型辅助盲评必须标明模型来源，不冒称人工评分。建议先隐藏 arm、随机排序答案后评估，再按 id 回填。

- `task`：0 完全错误或虚构关键操作；1 有主要事实错误/遗漏；2 部分完成但有明显缺项；3 正确完成且仅有轻微不足；4 准确、充分完成请求，不添加无依据事实。
- `preference`：0 违背有效偏好/条件；1 部分满足或表达不充分；2 全部满足该场景 rubric，正确处理条件和时效。对边界场景，仍有效的独立事实保留、失效规则不采用才得 2。
- `boundaryPass`：任何越权采用、遗忘复生、失败写入虚假承诺、源删除导致结论丢失、回退未生效/误伤、机器新版本误标用户确认或时间混用均 false；无此问题为 true。不得仅靠原生断言替代答案检查。

均值比较为 layered 任务分及偏好分均不低于 snapshot。两种记忆臂的边界必须零失败，必要原生断言全部为 true；回退耗时满足上述阈值。源删除正确性还需每条答案必需特征命中与评分者确认，不能只看存储保留。

每个请求的记忆输入 Token 取同场景、同重复的 `prompt_tokens(arm) - prompt_tokens(none)`，是包含消息封装的**实测边际输入**，不是字符串长度估算或独立 tokenizer 的纯正文数。摘要同时报告总输入、边际记忆输入和 TTFT 均值；snapshot 边际输入必须大于零，layered 至少减少 35%，TTFT 均值不增加。TTFT 从发起 HTTP 至首个非空可见内容，包含网络/Provider 排队，不以首个 SSE 或 reasoning token 代替。Provider 缓存和网络噪声需在集成审阅中判断，单次通过不能证明统计显著。

50–100 场景、真实生命周期记录、组织 usage、全部评分及所有门槛满足时仅输出 `candidate-pass-requires-integration-review`。该候选结果仍需对照完整产品验收及原生证据审核；工具永远输出 `defaultStrategy: snapshot`，没有运行时默认开关。自测使用本地 HTTP Provider fixture，仅验证传输、统计和失败处理，不调用远程服务，不作为模型语义结果。


## 真实 DSH 适配与执行

`src-tauri/src/dsh_memory_model_evaluation.rs` 的两个 ignored 测试使用各自独立的临时 SQLite、真实 Node DSH 和选定真实 Provider，绝不连接用户工作区数据。`memory_real_model_p0_smoke` 覆盖五项 P0；`memory_real_model_full60` 用两路并发执行全部 60 例。`MEMORY_E2E_ONLY` 可以限制待补场景，完整运行器复用同一输出目录中已完成案例，避免重复付费。

```sh
MEMORY_E2E_CONFIG=/absolute/private/provider.json MEMORY_E2E_OUTPUT=/absolute/results/full60 CARGO_TARGET_DIR=/absolute/shared/target cargo test --manifest-path src-tauri/Cargo.toml --lib memory_real_model_full60 -- --ignored --nocapture
node scripts/memory-evaluation/run-real.mjs --config /absolute/private/provider.json --fixtures /absolute/results/full60/native-full-fixtures.json --out /absolute/results/three-arm.json
```

配置只通过明确路径读取，包含 provider（name/baseUrl/modelId/apiKey/supportsImage）和可选 network（mode/proxyUrl）。原生历史调用复用产品 `ai_network::client_builder`。三臂直连脚本使用 Node 原生环境代理支持；system 模式尊重环境及 macOS HTTP(S) 系统代理，custom 使用指定代理，direct 才显式直连，不在失败后静默切换。PAC/SOCKS 未支持时明确失败。配置内容、Authorization 和非 200 Provider 错误正文均不写日志。

`structure-setups.mjs` 将输入语料转为明确的 `setup.steps`。DSH 步骤只发送真实用户文本，由实际模型生成助手消息和工具调用；数据集中已移除合成“已收到”助手确认。原生步骤包括：项目甲真实存储、实际来源文件创建/附加/删除、组织 patch 与 rollback、旧规则有效期更新、从真实 forgotten fact 的来源再次尝试组织写入。每个步骤记录原生结果和前后状态。失败写入使用明确的原生不存在 fact 更新拒绝注入，绝不把原语料里“磁盘满/超时”的叙述当成已经发生的故障。

来源删除 fixture 的附件来源由 host 显式附加给真实模型保存的事实，然后删除真实临时文件；它验证结论持久性，不代替来源服务文件读取验收。组织/回退 fixture 的变更由原生 API 执行，不能宣称是后台模型提出的组织结果；生产后台组织的真实模型用量另列并关联证据报告。

两个记忆臂都直接调用同一个原生 `MemoryRequest::Context`，预算均为 6000 字符，strategy 分别 snapshot/layered。harness 原样使用返回内容，不实现自己的检索。每条请求记录实际序列化记忆字节数、Provider input usage、边际记忆 token 和可见 TTFT。历史录制代理为了保存完整 SSE 会缓冲响应，其时间不作为三臂 TTFT；正式三臂由直连 streaming harness 测量。

真实三臂支持并发 2 和请求级恢复。报告 fingerprint 绑定场景、模型、端点、原生 fixtures 和 `evaluate.mjs` 实际源码；内容变化后必须选择新输出，避免把旧答案混作新验证。异常时保留已完成请求。评分来源由 reviewer/reviewerKind 记录；主 agent 评分满足评分归因要求，没有新增 human-only 放行条件。

这组场景主要验证短历史中的少量有效事实。必须报告实际每场景有效/返回事实数；若仅有 1–3 条，不能把其 token/延迟结果外推为长期数百条记忆的收益，也不能临时添加噪声或调整 35% 阈值追求通过。


## 2026-10-23 实测记录

本轮使用用户选定的 `deepseek-flash`。原生历史共 60 场景、120 个真实用户轮次；先前通过的独立 setup 复用，仅因失败控制变更补跑五条 failed_write，并补齐 current-2、confirmed_drift-2。原生测试命令通过仅表示运行器执行完成，不能替代场景成功：current-2 的纯日期有效期被实际原生服务以 `Invalid validity timestamp` 拒绝，事实未保存；history-1 保存了去年与今年的两条事实，但当前 Context 在历史请求下只返回今年版本。两项的时效断言失败。

完整指令修正前的 60+43 次三臂请求缺少真实 Skill 与可信当前 scope，只保留为诊断和已发生的调用消耗，不用于本轮产品结论。修正后重新冻结原生 fixtures，并用新 fingerprint 执行全新 180 次请求，不混入旧答案。新协议不是逐个失败场景追加提示：所有场景共用从各自实际请求捕获的生产指令，不添加工具白名单、检索噪声或调整门槛。

原生历史来自两版实际 Skill：40 例完成时记录了精确源码 fingerprint，最早 20 例没有追记可证明的源码哈希，仅保留实际 Provider/桥/状态记录；不得将当前源码冒称为这些旧历史的源码。完整指令三臂使用各场景真实捕获的 Skill，组内保持一致。

原生事实数为 0–2 条，均值 1.1833（0 条 11 例、1 条 27 例、2 条 22 例）；零条包含主动遗忘及失败保存后的真实空状态。本样本不能验证数百条长期记忆的收益。isolation-5 的实际保存内容为“项目乙是周宁”，layered 的词法检索未召回该条；本轮保留这一真实缺口。confirmed_drift-2 的原生整理 fixture 更新了正文为“开发及测试环境允许模拟支付”，同时保留原条件“仅在测试环境”，这不等于已经证明适用条件拓宽的产品行为。

五条 failed_write 的本轮原生桥均只有一次被拒绝 apply，最终 facts 为空；失败后的真实 Provider 请求工具目录为 0，下一真实用户轮恢复。仍需区分原生执行与模型表述：failed_write-3/5 首轮输出了未执行的 bash DSML 字符串，failed_write-2 叙述了桥回执中不存在的重复写入。末轮均说明未保存，但这些首轮输出问题不会被 setupPassed 掩盖。

后台整理的 [第一次](evidence/memory-background-20261023-attempt-1.json)、[第二次](evidence/memory-background-20261023-attempt-2.json)、[第三次](evidence/memory-background-20261023-attempt-3.json) 均为真实模型尝试：前两次分别因错误 action 结构、缺少 scope 被原生服务拒绝且零修改；第三次九项断言通过，实际 usage 为 input 1025、cacheRead 512、output 524、total 2061。三次合计含缓存输入 3907、输出 4185、total 8092。真实后台整理证据与 60 例中的原生 organize/rollback fixture 分开记录；后者不宣称由后台模型提出。来源删除仍仅覆盖 host 附加来源后删除真实临时文件并保留结论，不冒称模型读取来源服务。

可提交的原始答案、原生断言、调用消耗、冻结输入和源码 fingerprint 位于 [本轮结果目录](../../scripts/memory-evaluation/results/2026-10-23/manifest.json)。导出仅替换机器绝对路径，不修改实际答案的其他内容、usage、TTFT 或断言。原始私有 Provider/桥记录不随仓库发布。历史原生重试的费用账本按完全相同的请求/响应记录去重；无法区分完整记录完全相同的再次调用，因此该部分明确为有证据的下限，不估算货币价格。

本轮完整 180 次结果见 [实测报告](../../scripts/memory-evaluation/results/2026-10-23/README.md)：layered 边际记忆输入 196.48 对 snapshot 203.90 token，仅减少 3.64%；平均可见 TTFT 2470.37 对 2250.53 ms，增加 9.77%。两项计量及原生时效断言均未达门槛；任务/偏好均分未评分。默认继续 snapshot，不关闭涵盖完整 gate 的交付议题。另保留 confirmed_drift-4/snapshot 仅输出原始 memory_schedule DSML 的真实错误答案，不作修补。中断但无 usage 的请求消耗未知，已测消耗只是有证据的下限。

## 暂停时的实现差异

用户于 2026-10-23 要求提交并暂停。以上真实模型结果保持原始 fingerprint，不改写为最新代码的通过证据。其后 `memory-service.mjs` 已改为在真实工具错误归档后，由 `agent/pre-step` 抛出宿主原生错误通知、形成 `turn/end reason.kind=error`，不再请求模型生成失败说明；14 项 Node 测试通过。最新实现尚未跑真实 Provider 复验，原生评测运行器对 failed_write 的完成原因及通知读取断言也待调整。

`CHANGE_HELP` 的 ISO-date 说明尚未修正，原生实际只接受含时区的 RFC3339 时间戳。history-1 的直接三臂没有工具，当前 Context 排除过期事实是既定规则；需通过真实 `project_history` 路径检验历史查询，不能据此直接判定应向当前上下文注入过期事实。confirmed_drift-4 的未执行 DSML 同样须区分直接无工具评测与实际工具流程。下一步及剩余交付范围见[进度与交接](memory-progress-20261023.md)。

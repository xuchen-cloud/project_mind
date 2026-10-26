# 包 A：会话读取与模型预算

2026-10-27，基线 `5de9a91`，共享分支 `fix/performance-review-20261027`。未提交。关联 #105/#249；覆盖首轮会话搜索、冷标题、内容分页、E08，以及 R01/#235、R04/#205。

## 范围与验收

依赖现有 DSH Session 生命周期、`session/event`、Workspace `domain/changed` 和 public controller；库源码只读。交付可失效的归属索引、小型标题及内容投影复用、请求内去重和跨端默认/容量修复。非目标：Rust/前端、供应商协议、其他包及既有审计计数脚本。验收要求真实 wrapper/controller 路径调用次数下降，且新增、删除/归档、范围变化、取消和异步 I/O 后校验仍有效；缓存有明确容量。

已读 AGENTS.md、CONTEXT.md、主执行记录、三份审计及 ADR-0001/0003/0009。修改前检查无 tauri dev/Vite watcher。

## 修改文件

脚本：

- `packages/dsh-assistant/scripts/project-workspace.mjs`
- `packages/dsh-assistant/scripts/context-session-reads.mjs`
- `packages/dsh-assistant/scripts/session-inventory.mjs`
- `packages/dsh-assistant/scripts/source-bridge.mjs`
- `packages/dsh-assistant/scripts/model-utility.mjs`

对应测试：上述五个名称的 `packages/dsh-assistant/test/*.test.mjs`。`context-streams.mjs` 无需修改，通过现有归属接口复用索引；运行其既有测试，并新增五个真实 scope/event wrapper 的性能回归。

## 实际行为

- 目录按 Session ID 建立 Map，范围按 canonical directory 建立 Map。目录 I/O 合并；单个调用者取消不会取消共享读取。创建/释放、Workspace 提交变更和重新绑定使目录失效，变更期间返回的旧目录不能发布；权限不使用 TTL。
- `domain/changed` 的归档和 Workspace 删除/路径变更在 registry entity 更新前生效。Session 归属及来源读取保留 I/O 后检查；搜索返回前再次验证早先匹配，引用准备每个唯一 Session 在前后边界各验证一次。
- 冷标题第一次通过 public projections 验证，之后只保留小标题投影。单会话内容变更定向失效；其他活跃会话的消息不会打断冷标题读取。容量 2 MiB / 1024 项。
- 内容分页复用投影文本和命中 ID/createdAt，保留完整内容及输出预算语义。整个 runtime 共用 8 MiB / 128 项 LRU；授权、scope、目录/内容 revision 改变即清除。并发命名空间切换时旧请求不能写入新授权缓存。超预算文本不驻留，未缓存完整事件历史。
- 共享附件缓存只保留逐会话引用路径，4 MiB / 128 项；内容/归属变更失效。每次实际访问仍 realpath，并在异步授权读取之后重新检查 revision。
- 单模型请求合并稳定 generation 下的归属检查及重复交付；相同 delivery identity 的不同字节显式失败。provider admission 和 delivery I/O 后仍根据权威 generation 检查，原生 fixed-byte 校验不变。
- R01 对 `limit`/`budgetChars` 使用 nullish 默认，保留 `limit:0`。正式 RPC 回归使用原生序列化的全部 nullable 字段形状。
- R04 capacity 与 generate 共用 `min(4096,maxTokens,floor(contextWindow/4))`，保留 1024 reserve；真实目录 gpt-4 输出为 contextWindow=8192、outputTokens=2048、inputBytes=5120。

## 失败回归与测量

先执行新回归：

```sh
node --test --test-name-pattern='native Option|content pages|ownership index|cold title projection|catalog gpt-4' packages/dsh-assistant/test/session-inventory.test.mjs packages/dsh-assistant/test/project-workspace.test.mjs packages/dsh-assistant/test/model-utility.test.mjs
```

修复前 6 项中 5 项失败：201 次目录读取、200 次冷投影、500 次 inspect、null INVALID_ARGUMENT、gpt-4 输出4096。修复后全部通过。后续补充并先观察到失败的回归：同请求重复来源交付、无关活跃消息打断冷标题、分页 createdAt 丢失；均已修复。

| 真实函数路径/固定夹具 | 修复前 | 当前 |
|---|---:|---:|
| 100 会话无命中搜索，目录读取 | 201 | 1 |
| 5 个真实 scope event wrapper ×100事件，目录读取 | 500 | 1；仅所属 scope 转发100条 |
| 100 冷会话连续两次列表，projections | 200 | 100；单项变化后101 |
| 100会话×40消息，5页内容查询，inspect | 500 | 100；正文 getter 总读取4000次 |
| 200历史投影、20唯一交付，稳定请求归属检查 | 200 | 1；交付20次 |
| 20会话共享附件未命中，两次访问 inspect | 40 | 20；单项内容变化再读1次 |

## 验证记录

1. 包范围集中测试：

```sh
node --test packages/dsh-assistant/test/project-workspace.test.mjs packages/dsh-assistant/test/session-inventory.test.mjs packages/dsh-assistant/test/context-session-reads.test.mjs packages/dsh-assistant/test/context-streams.test.mjs packages/dsh-assistant/test/shared-contexts.test.mjs packages/dsh-assistant/test/source-bridge.test.mjs packages/dsh-assistant/test/model-utility.test.mjs packages/dsh-assistant/test/context-session-reads.integration.mjs
```

80/80通过（约4.1s）。之后只把标题 fingerprint 收紧为所需元数据并增加来源冲突回归；最终重跑受影响两文件 `node --test packages/dsh-assistant/test/project-workspace.test.mjs packages/dsh-assistant/test/source-bridge.test.mjs`：32/32通过。当前这些命令覆盖81个不同用例，其余未变化检查复用。

2. 真实子进程/DSH RPC、临时持久化目录、合成 provider：

```sh
node --test --test-name-pattern='native session inventory|one shared assistant process|fixed source auto titles' packages/dsh-assistant/test/runtime.integration.mjs
```

3/3通过（约5.1s）：冷库存、来源标题及工作区/双项目并发与重启隔离。最后的 fingerprint 收紧已由针对性冷标题回归验证，未重复启动集成进程。

3. 指定修改文件 `git diff --check` 通过。未运行全量测试、Cargo、应用构建或窗口。

脚本最终 SHA256（主 agent 可据此复用验证）：

```text
09e95ee2d0d4d510563b72572365617dd3685b9580681d5f5e0f426b8320210e project-workspace.mjs
281e260108d357b790dcbef06d056fac21db61e6b101ba1f630ef27ee3b4bae6 context-session-reads.mjs
0ba97e5a66ace32776bab4948ef9af78e7e13f7801dfdcaef4bee42cfac4a1c5 session-inventory.mjs
3acba747ecad37229e7f9f3b377571c456b7da9ec80f5e91ce30ec1ca2ee14e0 source-bridge.mjs
0b21a44c7263215e214877f4892b96e3fc4f6f0ad7e6aa893e5508519a25df85 model-utility.mjs
```

## 限制与交接

无实现阻塞。内容首次查询仍按授权候选读取，超出缓存预算允许再次读取。外部 JSONL 不经过当前 Context 事件，已补权威 revision 复核与文件事件 generation（见下文）。没有改动原生权限、CAS、幂等、内容版本规则或审计脚本。

本包禁止改 Rust，因此 R01 的 Rust struct 实际序列化→Node、R04 response→Rust parser 的原生跨端端到端测试尚未执行；已覆盖 Node真实RPC的相同 serialized-null shape 和真实目录capacity，原生构建/解析验收交由主 agent 整体验证。主 agent 负责最终 Standards/Spec 检查、整体验收和统一提交。


## 主 agent 补充边界检查

新增五项回归覆盖 register 目录改变、滞后标题 hint、并发 refresh、外部 JSONL 写入/删除/新增、无 watcher 事件时的有界 revision 复核。目录改变原有拒绝语义成立：旧映射保留，新路径不得被授权；不是已复现缺陷。滞后 hint 和旧 pending 满足新 refresh 则先失败，现已修复。

上游固定版本 JSONL persistence 的 list/stat 提供 header/revision，但不向当前 Context 发送外部文件变更事件。wrapper 监听实际 DSH_HOME/sessions 目录的文件事件；冷文件和目录事件更新 watch generation，已附着 live Session 的精确 locate 路径由 Session 生命周期/header/event 负责失效。读取时通过 public persistence.list 的 header/revision 摘要使归属、标题和内容缓存失效。未观察到事件也最多 5 秒复核一次；该间隔是漏事件修复上限，不作为权限缓存唯一依据。watcher 出错后每次读取复核。cleanup 关闭 watcher、恢复 persistence.list。

标题 matching hint 仅在 cwd/updatedAt 都未变化时复用；显式 refresh 要求读 serial 高于调用之前已在途的旧读取，旧 pending 不得覆盖新刷新。

最终受影响回归：`node --test packages/dsh-assistant/test/project-workspace.test.mjs` 26/26 通过。当前包测试累计覆盖86个不同用例。新增失效逻辑曾导致两项真实进程集成暴露自身 flush 误判，已按 live seq 修复；`node --test --test-name-pattern='native session inventory|one shared assistant process' packages/dsh-assistant/test/runtime.integration.mjs` 2/2 通过。其余未变化验证复用前述结果。


最终集中收口（补充边界后的脚本版本）：上文包范围集中 Node 命令 86/86 通过（4.40s）；三项真实 runtime.integration 指定用例 3/3 通过（5.72s）。该结果替代此前分段复用计数，当前无 A 待复测项。G2 仅影响 Skill 资源读取分类，其变更后的整包 A 回归亦包含本次验证。

## 真实 home watcher 成本复查与最终验收

主 agent 指出的高频失效成本真实存在，新增两项正式回归后修复；未改既有审计脚本。依据固定 `0.2.0-rc.2` 库源码：agent-loop 的 assistant stream chunk 是 transient frame，settle 才提交 assistant/message / assistant/attempt；JSONL handle 收到持久化 Session event 后通过 200ms timer 批量 append+fsync。因此不把每个 token 等同于实际 JSONL 写入。

真实 Cordis SessionStore、JSONL backend、SessionQuery、SessionProjection 和 SessionController 在临时 DSH_HOME 中工作，测试包装并调用实际 persistence.list/listArtifacts 计数。真实 session/title 持久化事件分四批，每批等待 240ms，独立 recursive fs.watch 确认至少四次实际文件通知；五个真实 context stream wrapper 共过滤 500 帧，只所属范围转发100帧。

| 实际路径 | 复查前 | 最终 |
|---|---:|---:|
| 四次 live durable 批次 + 五消费者，list / listArtifacts | 8 / 8 | 0 / 0 |
| 同一显式列表刷新，list / listArtifacts | 2 / 2 | 1 / 1 |

双 list 没有必要：原 SessionController.list 已调用 query.listSessions → persistence.list。现在以 AsyncLocalStorage 仅在同一次 catalog 请求内保留该 public list Promise，用相同快照构造 revision 摘要；独立请求无缓存，实际无内部 list 的 controller 才补读取。没有更改库源码。

macOS 对 append+fsync 也会报告 rename，不能按事件名推断删除。仅跳过 public locate 确认且仍在 live store 的准确文件路径；Session 的 immutable header 和 session/event 为实际 query 提供 live precedence。真实 session/disposed 删除映射并立即失效；真实 cold 新增/修改/删除、目录未知事件仍失效，漏通知通过 5 秒真实复核补足。live 物理 revision 不再在校准时清空无关 cold 内容缓存。Workspace committed domain/changed 仍同步撤销权限。

第二项真实 backend 回归不发送 cold Session ctx 事件，验证外部创建、追加、删除。macOS 本次合并了 unlink 与前一次 fsync 通知，删除在约5秒真实校准内被拒绝；真实冷内容 revision 变化会推进内容缓存 generation，Workspace 删除权限在不推进时钟时立即拒绝。

最终再次运行上文完整包范围 Node 命令：**88/88 通过，6.56s**，日志 `$TMPDIR/perf-a-final-node.log`。两项真实 watcher 回归单独 **2/2 通过，6.38s**，日志 `$TMPDIR/perf-a-real-watch.log`。三项 runtime.integration 指定用例 **3/3 通过，5.16s**，日志 `$TMPDIR/perf-a-runtime-final.log`。本节结果替代此前阶段计数；对应脚本摘要为上文当前 SHA256。没有 A 实现或定向验证阻塞。

# 本轮全库审查修复：WP00 集成交接

## 工作包约定

- 固定基线：`ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`，对应已合并 PR #316。
- 关联 Issue：只读核对未发现本轮专门的集成 Issue；#308 是上一轮集成工单，不能把 PR #316 当作本轮修复 Issue。不创建、关闭或修改外部 Issue。
- 集成分支：`codex/wp00-review-integration-20261111`，从固定基线建立独立 worktree。
- 交付：接收各包最终提交，维护共享文件契约；在独立分支串行整合，按受影响范围验证组合结果并自行完成 Standards / Spec 检查。
- 非目标：代写各组修复、重复创建会话、覆盖原 checkout、推送、合并 develop、发布、部署或删除用户数据。
- 依赖：WP01/02/03/05/07/08/09/10 已派发；WP04/06 等 WP03 文件稳定后由原协调会话派发，WP00 不另建会话。
- 验收：每包有精确提交、发现 ID、验证命令/结果、证据与未验证项；所有收到的提交在组合树上通过必要的接口/受影响验证，缺失包和平台门槛保持可见。

## 当前接收清单

“收到”表示已核对责任组最终交付，不等于组合验证通过。

| 包 | 发现 | 分支 | 接收状态 | 提交 | 组合验证 |
|---|---|---|---|---|---|
| WP01 | VC-01 | `codex/wp01-todo-workspace-binding` | 执行中 | 待接收 | 待执行 |
| WP02 | Q-AI-01/02、PERF-AI-01 | `codex/wp02-ai-job-lifecycle-20261111` | 已整合 | 源 `52681197421261b2083d62a2e7d58dc6d280ab84`；组合 `22d67a9` | 单包证据已复用；组合补充回归见下 |
| WP03 | ARCH-01/02/03 | `codex/wp03-project-rename-recovery` | 执行中 | 待接收 | 待执行 |
| WP04 | ARCH-04 | 待派发 | 等待 WP03 稳定 | — | 未执行 |
| WP05 | Q1/2/3 | `codex/wp05-todo-editors-20261111` | 执行中 | 待接收 | 待执行 |
| WP06 | VC-02 | 待派发 | 等待 WP03 稳定 | — | 未执行 |
| WP07 | SEC-DEP-01/02 | `codex/wp07-security-dependencies` | 已整合 | 源 `54dda267066ba72716035be42375db945bacf7aa`；组合 `d55ab18` | 单包证据已复用；最终组合待验证 |
| WP08 | PERF-01 | `codex/wp08-file-path-index-20261111` | 执行中 | 待接收 | 待执行 |
| WP09 | DOC-01/02、STD-01 | `codex/wp09-docs-rules-20261111` | 执行中 | 待接收 | 待执行 |
| WP10 | OPS-01 | `codex/wp10-beta-channel-20261111` | 执行中 | 待接收 | 待执行 |

## 共享文件与 Interface

### WP01 / WP02

- `src-tauri/src/lib.rs`：WP01 拥有 Todo/tag 命令、绑定存储 helper 与相应 page 读入口；WP02 拥有 WorkspaceRuntime 的 job binding 初始化、AI job 命令和注册。已读两组当前 diff，尚无相同逻辑行覆盖。
- `src/services/projectMindApi.ts`：WP01 拥有 Todo/tag/page 参数；WP02 拥有 AI job 参数。整合时逐段保留必需 binding，不能用整文件取一侧来解冲突。
- `src/lib/types.ts`：AI job 身份/快照由 WP02 提交；WP01 复用现有 AgentWorkspaceBinding，不另造 DTO。
- WP00 是组合树共享文件的唯一整合人。各包 worktree 保持独立，不写入对方文件。

### WP01 / WP05

WP01 当前 `change(update-content)` 已写明：返回原生规范 Todo；resolve 前缓存已 reconcile，或已有同一打开周期的更高 revision；退役 Workspace reject，不能向下一打开周期发布。最终以收到的提交为准。

WP05 应消费这一成功确认撤销原始 hashtag 乐观正文，不以原始字符串等于规范正文作为确认条件。组合验收覆盖真实 TodoModuleRail → change、规范正文/标签、后续远端更新、连续编辑和工作区切换后的旧草稿/回调。

官方只读进度已确认 WP05 自行读取到 WP01 契约，并开始真实 TodoModuleRail 接入测试；消息发送失败没有阻止该项衔接。当前 tracked diff 交集仅 WP01/WP02 的 lib.rs、projectMindApi.ts 和 projectMindApi.test.ts。

### WP03 / WP04 / WP06

WP03 先稳定改名 intent、恢复入口、路径映射及 db.rs。WP04 保持 File WorkingSave/WorkingStatus Interface，将 live 卷 stage/backup 与 journal/恢复/清理一起修正；WP06 只接续 voice_minutes_apply 的稳定录音开始时间后缀。未收到 WP03 稳定交付前不自行抢改。

## 验证计划与复用

1. 接收时核对基线祖先、提交清单、干净状态、文件边界及实际证据；只接收最终提交，阶段提交不表示 Issue 完成。
2. 先整合互不依赖的已交付包；共享文件逐包串行处理。每次冲突记录原因和保留的两侧行为。
3. WP01/02/05 组合后运行相关 Todo/AI 生命周期与 transport/调用端测试、前端类型检查。原生绑定和实际 worker 计数分别验证。
4. WP03/04/06 组合后集中运行受影响保存/恢复/纪要套件；真实 kill 与第二卷证据单独列出。未具备平台时保持未执行。
5. WP07 的干净安装、Markdown 回归和受影响构建可在源码/依赖/配置未受后续包影响时复用；组合树仍需前端类型/构建来确认交叉兼容。WP09 工程规则、WP10 发行脚本使用对应定向测试。
6. 最终记录组合提交/树与命令结果；通过、失败、未执行分开。已通过且影响范围未变化的检查不反复全量运行。

## 已接收证据

### WP02

[AI job 交付记录](review-20261111/wp02-ai-job-lifecycle.md)。无冲突整合。单包通过 265 项不同前端测试、完整生产 TypeScript 检查及 `cargo check --lib --tests`。4 项受控 worker 和 1 项绑定门禁测试是导入真实源代码的 rustc harness：前者替代 DB/Chrono，后者替代 State/runtime；不能标成完整原生测试二进制或真实 Tauri IPC 已通过。

WP00 最终调用链检查补充复现：sync 的 ready promise 已完成，reset 在异步续体恢复前运行时，旧 enqueue 仍被调用一次。定向新回归在收到的源提交失败（`ai-ready-reset-red.log`）；enqueue 前核对 `aiJobSync === sync` 后，真实前端 Module 的 14/14 项通过（`ai-ready-reset-green.log`）。这是原 WP02 生命周期验收窗口的补齐，不新增通用机制；原生 binding 仍保留，不以 UI 失效代替写入门禁。

保留未验证项：Windows、真实多窗口、真实 Provider 和完整原生测试二进制运行。未调用付费 Provider。

### WP07

交付记录：[依赖安全修复](wp07-security-dependencies-20261111.md)（整合该提交后可用）。责任组报告：干净安装、96 项针对性测试、类型检查、宿主及 Record/Source worker 构建通过；Vite 8.1.7、markdown-it 14.3.3，默认 loopback、显式 dev:lan；400 KB reference 微测约 3220 → 87 ms。此处是单包结果，尚未计入组合通过。

保留未验证项：Windows、多窗口、真实 LAN/Tauri GUI、安装包；其他 11 项 audit 告警不在本包已确认修复范围。

### WP00 环境准备与初步检查

- WP07 本地提交已无冲突 cherry-pick；最终组合中的提交为 `d55ab18`。已检查其 manifest/config/回归测试 diff、lock/包范围与 diff whitespace，Standards / Spec 暂无新增发现。
- 原卷剩余约 4.3 GiB。依赖和未变更 Office dist 从 WP07 已完成的安装/构建经 APFS `cp -cR` 克隆至 WP00 自己的 ignored 目录，无共享可写依赖、无重装其他工作区。WP00 不声称独立 clean install 或重新构建 Office 引擎。
- Office dist 与生成的 PPTX 类型来源逐字节核验，共 390 个文件；SHA-256 汇总保存在本地证据 `environment-reuse.json`。同目录保留 `shared-file-snapshot.json`。
- 目前未在 WP00 运行应用/窗口、全量前端或原生测试。后续组合验证明确使用此准备环境。

## 工具限制与待决定项

- 官方 send_message_to_thread 对 WP01、WP02、WP05 的三条最小协调消息均返回 `MCP tool call requires approval, but approval policy is never`，消息未发送。未重试、未换通道；本清单保留待衔接契约，原协调会话可读取。
- 只读 wait_threads/read_thread 可用；只用官方接口跟踪，不读取 Codex 会话文件。
- 本轮用户未授权 review 子 agent；Standards / Spec 由 WP00 自行检查。
- 不把原有 Windows、真实跨卷、多窗口、Office 性能、签名/安装验收缺口推定为通过；它们仍是独立门槛。
- 未获用户批准前不推送、不合并 develop、不发布。

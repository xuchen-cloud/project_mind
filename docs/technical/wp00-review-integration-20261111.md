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
| WP02 | Q-AI-01/02、PERF-AI-01 | `codex/wp02-ai-job-lifecycle-20261111` | 执行中 | 待接收 | 待执行 |
| WP03 | ARCH-01/02/03 | `codex/wp03-project-rename-recovery` | 执行中 | 待接收 | 待执行 |
| WP04 | ARCH-04 | 待派发 | 等待 WP03 稳定 | — | 未执行 |
| WP05 | Q1/2/3 | `codex/wp05-todo-editors-20261111` | 执行中 | 待接收 | 待执行 |
| WP06 | VC-02 | 待派发 | 等待 WP03 稳定 | — | 未执行 |
| WP07 | SEC-DEP-01/02 | `codex/wp07-security-dependencies` | 已收到 | `54dda267066ba72716035be42375db945bacf7aa` | 待整合 |
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

### WP07

交付记录：[依赖安全修复](wp07-security-dependencies-20261111.md)（整合该提交后可用）。责任组报告：干净安装、96 项针对性测试、类型检查、宿主及 Record/Source worker 构建通过；Vite 8.1.7、markdown-it 14.3.3，默认 loopback、显式 dev:lan；400 KB reference 微测约 3220 → 87 ms。此处是单包结果，尚未计入组合通过。

保留未验证项：Windows、多窗口、真实 LAN/Tauri GUI、安装包；其他 11 项 audit 告警不在本包已确认修复范围。

## 工具限制与待决定项

- 官方 send_message_to_thread 对 WP01、WP02、WP05 的三条最小协调消息均返回 `MCP tool call requires approval, but approval policy is never`，消息未发送。未重试、未换通道；本清单保留待衔接契约，原协调会话可读取。
- 只读 wait_threads/read_thread 可用；只用官方接口跟踪，不读取 Codex 会话文件。
- 本轮用户未授权 review 子 agent；Standards / Spec 由 WP00 自行检查。
- 不把原有 Windows、真实跨卷、多窗口、Office 性能、签名/安装验收缺口推定为通过；它们仍是独立门槛。
- 未获用户批准前不推送、不合并 develop、不发布。

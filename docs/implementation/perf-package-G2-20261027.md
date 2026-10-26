# 包 G2：Skills、资源读取与 scheduler restore

2026-10-27，基线 `5de9a91`，共享分支 `fix/performance-review-20261027`，未提交。关联首轮 Skills 重复 Node 扫描、资源 realpath 重复、定时任务 restore 重复 JSON 读取；依赖现有 DSH Skills provider、原生 Workspace authority、DSH admitted host。主执行记录不编辑。

## 范围与交付

交付：复用目录 worker，取消过时扫描，按实际文件元数据失效的有界目录缓存，单次用户刷新真正重扫，资源 realpath 去重，restore 先检查宿主。权限、管理操作的新鲜目录校验、Workspace I/O 前后校验、CAS/幂等/删除保护保持有效。非目标：Office、DSH 退出实现、Voice、全量构建/测试、库源码修改。

Source / Overview / Record checkpoint idle 最初由本包开始实现，之后主 agent 明确移交 F（`01a17907-7267-74c1-a15b-2be6b8bc9578`）。F 接手现有 WIP，此后这些区域由 F 完成并独立验证；本记录不将 idle 宣称已交付。详见交接节。

## 修改文件

- `packages/dsh-assistant/scripts/skills.mjs`
- `packages/dsh-assistant/test/skills.test.mjs`
- `src-tauri/src/skills.rs`
- `src-tauri/src/dsh_schedules.rs`
- `src/components/settings/SkillsPanel.tsx` 与对应 `.test.tsx`
- `src/services/skillsApi.ts` 与对应 `.test.ts`（Panel 所需请求 ID / refresh / cancel 的窄接口接线）
- `src-tauri/src/lib.rs`：只保留 Skills 生命周期接点，位于 Workspace 切换/关闭、正常退出/重启、无 Workspace ExitRequested、RunEvent::Exit；Voice closing lease 由 F 修改并保留。
- 本独立记录。原有管理/导入测试仅运行，无需修改。

## 实际行为

### Skills 目录

`skills_list` 使用一个串行 Node `skills.mjs --serve` worker，最多 32 个在途请求。相同范围的并发发现排队后复用前次完成结果，避免重复 provider 扫描。每次从原生 DB 解析 authority，等待 worker 锁后及 I/O 后重新核验当前 Workspace generation、root、canonical 项目路径和数据目录。

Node LRU 上限 8 项 / 8 MiB，计入 JSON、key、revision 字节，超预算目录不保留。每次读缓存之前重新检查 provider 实际扫描层级的 lstat/stat 元数据，包含 active 与 `.disabled`、flat Markdown、bundle 的 SKILL.md 及 symlink target 的 inode/dev/size/mtimeNs/ctimeNs。新增、删除、重命名、内容和链接变化可检测；不用 TTL 作为授权或外部变更失效依据。不缓存 incomplete 结果和发现期间 revision 变化的结果。

手动刷新传 `refresh:true`，绕过缓存并执行一次真实发现。Panel 范围切换/卸载取消未结束的请求；原生 active 取消会显式 kill+wait，queued 取消不执行扫描。旧 UI generation 不发布结果。切换范围清除之前的 refresh 意图，后续普通读取继续复用缓存。

enable/disable/delete/import 仍使用原有单次独立进程，管理前后都通过真实 provider 发现与边界校验；成功后显式 invalidate server worker/cache。外部 `.disabled` 内容变化同样进入 fingerprint。原生返回 catalog 的 JSON 形状不变，cancel 分支使用同一个 skills_list 命令返回 null。

### 生命周期与预算

- Workspace 切换/关闭：先提升 epoch、通知全部 requests，异步取 worker 锁并 kill+wait 旧 epoch 子进程。新 epoch 创建的 worker 不被旧清理任务终止。
- app_exit / app_restart：显式 `skills::shutdown().await`；先阻止新请求并取消旧请求，再取 worker 锁、kill+wait。返回可释放 admission lease，正常退出事务最终授权成功才 commit；停止失败、后续服务失败、voice 最终授权失败或 future 取消均通过 Drop 恢复 Skills 准入，原错误继续返回。
- 无 Workspace 的 ExitRequested 同样 await shutdown；RunEvent::Exit 使用同步退出收口调用，不能只依赖静态 WORKER 的 Drop。
- worker 有 60 秒真实空闲 timer；截止后 kill+wait，无 worker 时 timer 任务停在 Notify 等待。测试使用同一 timer 实现的 30ms deadline，验证实际 PID 消失。
- native 通过 `take(LIMIT+1).read_until` 在分配前限制单帧 8 MiB，包括不带换行的超长输出；Node 完整响应也受 8 MiB 预算限制。

### 资源与 scheduler

`isSkillResourceRead` 将 requested target 的 realpath 从每个候选一次变为一次；真正选中资源之后仍在 registry.get I/O 后重新 realpath base/target，保留 symlink、`.disabled`、归属和删除检查。

restore 仍每 15 秒检查恢复条件，但有效 admitted Workspace 宿主已存在时，在读取 scheduled-tasks.json / legacy fallback 之前返回。宿主缺失或已退出才读取并验证真实恢复文件；原有错误、版本、binding/secrets、transport 语义保留。DSH scheduler 本身仍拥有任务内存与持久化，不声称新增外部 JSON 文件监听。

## 回归与性能证据

先建立目录复用回归，修复前缺少 reader；Panel 新回归修复前失败（没有 requestId / cancel）。idle 交接前还将生产原 500ms wait 抽入相同 wait 实现，650ms quiet 回归观察到实际失败，再改事件等待后通过。没有修改既有审计计数脚本。

正式回归使用真实临时目录和 DSH provider，包装真实 discover 计数，并非 mock 常数时间：

| 场景 | 当前实际调用 |
|---|---:|
| 同一目录连续两次 list | 1 次真实 discover |
| 外部 SKILL.md 变化 | 增加 1 次 discover 并显示新内容 |
| 单次手动刷新 | 增加 1 次 discover |
| 20 个无关真实 Skill 候选，requested realpath | 1 次（匹配后额外复核仍保留） |
| 缓存超 byte/count 预算 | 实际重新发现，不保留超额项 |
| 两次原生读取 | 同一实际 Node PID |
| 已 admitted host，恢复 JSON 路径实为目录 | 跳过读取成功；无 host 则实际 I/O 失败 |

另有真实 `--serve` 父子进程回归：父进程读取首个响应后直接退出，子进程输入管道 EOF 后 PID 消失。原生测试确认 idle timer、Workspace invalidate 和显式 shutdown 的真实子进程已 kill+wait，且 requests 收到取消通知。没有启动应用窗口。

## 验证命令与结果

```sh
node --test packages/dsh-assistant/test/skills.test.mjs packages/dsh-assistant/test/skill-management.test.mjs packages/dsh-assistant/test/skill-import.test.mjs
```

28/28 通过（0.92s），含实际 provider、active/disabled 管理、真实 parent/child 和资源边界。

```sh
npx vitest run src/components/settings/SkillsPanel.test.tsx src/services/skillsApi.test.ts --maxWorkers=1
```

21/21 通过（1.50s），含切换取消、过时响应、显式 refresh 和 wire 参数。

```sh
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --lib skills::tests --quiet
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --lib dsh_assistant::schedules::tests --quiet
```

分段串行：7/7、4/4 通过（测试执行0.31s/0.01s）。已有仓库 warnings 不属于本包。发现 F 开始 Cargo 时已取消自己排队的命令；后续与 F 明确交接 Cargo 使用时段，没有并行编译。通过日志为 `$TMPDIR/perf-g2-skills.log`、`$TMPDIR/perf-g2-schedules.log`；补充回归的最终尝试见下文。

Skills 资源分类变化后，A 定向整包亦重跑：86/86；三项真实 runtime.integration 指定用例 3/3。指定文件 `git diff --check` 通过。未跑全量测试/构建/窗口。

## Idle 交接与边界

F 已确认接手 source_maintenance.rs、overview_maintenance.rs、overview_maintenance_tests.rs、lib.rs checkpoint helper/setup/test 和对应 Workspace wake，避免重叠编辑。本 agent 交接时 `source_maintenance::tests` 11/11 已通过（日志 `$TMPDIR/perf-g2-source.log`）；Overview/checkpoint 新测试尚未运行，由 F 接续。

F 提出的待主 agent 确认范围依赖：db/source_maintenance.rs 的只读 next-wake helper（多 scope、not_before、配额）；db/record_documents.rs 的最早 checkpoint_due_at helper（避免整正文 projection）；如有需要 Overview wait_until 只读 helper。另 agent_settings_update 当前未发 committed event，需其成功后 wake；模型配置的 ai_profile_upsert/delete、ai_binding_upsert 成功后需 wake Overview。这些窄接点及授权由主 agent/F 处理，不在本记录中宣称已完成。

Skills/scheduler 无剩余实现项。阶段性 dsh_process 尚未接线曾阻塞编译（`$TMPDIR/perf-g2-skills-final.log`）；目前已解除。C 单一 Cargo runner 集中验证 Skills **9/9**、schedule **4/4** 通过，日志 `$TMPDIR/mind-C-G1-G2-targeted.log`。该批其它模块的失败由 C/F 接续，不影响这13项结果。新增 active cancellation 使用真实慢 Node 输出，生产 read_worker select 取消后显式 kill+wait。

退出失败回归使用生产 admission helper：stop 错误保留原文并恢复准入；成功停止但后续事务失败时 lease Drop 恢复准入，commit 后则继续禁止新请求。F 将 Skills / C 的 DSH admission leases 接入统一 finish_app_shutdown，app_exit/restart/automatic 均持有到 voice 最终授权完成。最后又增加直接调用生产 finish_app_shutdown、注入 late voice failure、确认 Skills 可再次准入且 DSH 可再次 shutdown 的断言；F 串行 Cargo 验证已通过，日志 `$TMPDIR/mind-G2-idle-final-filtered_tests.log`，该过滤批次 **26通过、0失败、1忽略**。RunEvent::Exit 最终兜底直接关闭准入并 kill+wait，不重复获取已 committed lease。没有吞 stop 错误来恢复功能。

整体 G2 idle 以 F 记录及主 agent 整体验收为准。最终 Standards/Spec review 和统一提交由主 agent 完成。

## 验证对应文件摘要

```text
c45edb8bae7b2c163038625604f02af0642e43978e50a7043a37f16c1e216e25 skills.mjs
0517f595bfe27fb616968ad569cb34663ee731e90c281bb0615e4d839fe8306e skills.rs（含退出失败及生产统一退出事务回归，已通过）
2d52507dc203f0a7bf02a6c3e2da0efab7b73f04ff8b9e5d1ca16285f7643ba4 dsh_schedules.rs
b2b72d87af34e30adf44ed0b2d15bc78f26c3943cf04bd462b4d7ace2ced5c5d SkillsPanel.tsx
a663bcccdb9c978e5cd9f2e129e04a9d0175eb581a3084ba076b91fd4eb8cadd skillsApi.ts
```

## 固定 Node 全测入口的 parent-death fixture 修复

主 agent 固定 Node24.21.0 全 DSH 单测发现 parent-death 回归在 `pid > 0` 失败（`$TMPDIR/mind-final-dsh-unit.log`）。用同一 bundled Node 单独运行，仓库根入口通过，包目录入口稳定失败。具体原因：`path.resolve('packages/dsh-assistant/scripts/skills.mjs')` 依赖启动目录，而 `npm --prefix packages/dsh-assistant test` 的 cwd 是包目录，最终拼成重复路径；实际 child stderr 为 MODULE_NOT_FOUND。fixture 父进程只等 stdout data，没有传播提前退出，遂以0退出、stdout为空。没有证据显示生产 worker 的 EOF 生命周期失效。

只修改本包 `test/skills.test.mjs`：以 `import.meta.url` 定位真实脚本；以 readline 等待完整 JSON 响应并验证 ok 后，将真实 PID flush 到 stdout，再真正 process.exit；child 提前失败会保留 stderr 并使 fixture 失败。原有真实 PID 存活轮询和 parent death 后必须消失的断言保留；失败清理仅在尚未确认 child 消失时执行，不能将清理作为通过条件。

固定解释器 `src-tauri/resources/agent-host/node --version` 为 v24.21.0。

```sh
# cwd: packages/dsh-assistant
../../src-tauri/resources/agent-host/node --test --test-name-pattern='actual serve child exits' test/skills.test.mjs
../../src-tauri/resources/agent-host/node --test test/skills.test.mjs test/skill-management.test.mjs test/skill-import.test.mjs
```

失败项从红转绿 **1/1**；仓库根同一失败项 **1/1**；最终包目录 Skills/管理/导入组 **28/28通过，0.83s**，日志 `$TMPDIR/perf-g2-skills-node24-final.log`。测试源码 SHA256：`31ffe9b990e36bee09a4fc39ffeaddfbcab1b9e5e28cf8c3124b82cdd559ac9f`。`git diff --check` 通过，无真实 serve 子进程残留。未运行全量或 Cargo，生产源码及其它 agent 文件未改。

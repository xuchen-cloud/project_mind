# WP02：AI job 身份与资源生命周期

本机路径以 `<temporary-root>` / `<original-checkout>` 占位；命令变量须按执行机设置。原始路径保留于各包源提交及 WP00 外部证据，验证结果未变。

## 工作包边界

- 基准：`ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`。
- 发现：Q-AI-01、Q-AI-02、PERF-AI-01；输入为全库审查最终报告、findings.json、WP02 及对应 evidence_report。
- 关联实际 Issue：[#27 图片右键 AI 解读与文字提取](https://github.com/xuchen-cloud/project_mind/issues/27)、[#70 Record AI 标题与 Tag](https://github.com/xuchen-cloud/project_mind/issues/70)。已通过只读 GitHub REST 核实均无 `pull_request` 字段，#27 明确要求 Workspace 匹配的迟到事件及生命周期释放。审查关联的 #316 是 PR，不是本包 Issue；不新增、关闭或修改外部 Issue。
- 依赖：复用现有 `WorkspaceBinding`（Workspace UUID + 每次打开的 generation），保留现有 job manager 与 Editor Skill pipeline。
- 交付：快照/事件及 enqueue/get/cancel/list/waiter 绑定原工作区；切换终止旧等待器、拒绝旧响应；解绑完成和 pending 的监听注册；取消的 worker 退出前继续占槽，退出后启动队列。
- 非目标：Todo/标签读写（WP01）、通用任务平台、Provider 中止协议、真实付费调用、发布与远端推送。
- 验收：A/B 同 ID、同 target；相同 Workspace 重开 generation；pending listen/reset、旧 list/get/enqueue 响应；旧等待器结束；受控阻塞 worker 下取消/新增不突破 1～4 并发，队列取消不执行。
- 验证范围：真实 zustand + 模拟 Tauri 事件和命令；真实 Rust manager + 受控执行器；受影响消费者测试、DTO 类型检查、原生命令编译。编译/单测静默，不启动应用窗口。

## 基线复现

- `vitest run src/lib/aiJobs.test.ts --maxWorkers=1`：5 个测试均失败，分别命中旧事件、pending unlisten、旧 list、旧 waiter、旧 get；日志 `<temporary-root>/wp02-frontend-red.log`。真实 store + 模拟命令/事件，不是原生 GUI 验收。
- 原审查的并发问题和监听泄漏只有静态证据；本包补充动态受控测试后再认定通过。

## CD-04 落地

- `aiJobs.ts` 是前端 Module 的生命周期所有者：一次绑定只有一个有效监听；负责 list/enqueue/get/cancel 发布、wait 和 reset/dispose。store 是有绑定校验的内部投影，React 消费者观察目标并提交意图，不再安排原生命令响应的 store 回写。
- `WorkspaceBinding` 直接复用原生 runtime 的 UUID/generation；job snapshot 与各命令使用完整身份，targetKey 不承担隔离职责。
- 原生 `with_bound_ai_jobs` 在当前 runtime 锁内验证绑定再执行操作；`AiJobManager` 独占物理执行槽位。可见 cancelled 保留终态，执行真正返回后才释放；成功/失败路径共用 finish 并继续队列。
- 不新增通用任务平台、重试或 Provider 中止接口；前端终止观察不等于终止供应商执行。

## 验证台账

- 前端 Module：`vitest run src/lib/aiJobs.test.ts --maxWorkers=1`，13/13 通过（`<temporary-root>/wp02-module-final.log`）。基于真实 store、可控 command/event Adapter，覆盖 A/B 同 ID/target、同 Workspace 重开、pending listen、late list/get/enqueue/cancel、setup 重试与旧失败、旧等待器结束。
- 原生 worker：真实 `ai_jobs.rs` 的 4 个受控 worker 测试通过（`<temporary-root>/wp02-native-worker-final.log`）。取消/新增循环在限制 1、4 下记录真实执行数，验证成功和失败返回都启动队列、队列取消不执行、取消终态不被晚到流覆写。基线失败日志 `<temporary-root>/wp02-ai-jobs-evidence-20261111/before.log` 显示新任务错误地为 Running 而非 Queued。
- 上述 worker 测试通过 rustc harness 运行；harness 导入真实 manager，DTO 从当前模型提取并移除 serde 属性、Chrono 固定时间、DB Adapter 禁止调用。脚本与完整方法见 `<temporary-root>/wp02-ai-jobs-evidence-20261111/README.md`。这不代表真实 Provider 接入通过。
- 原生绑定门禁：`<temporary-root>/wp02-ai-jobs-evidence-20261111/check_binding.py` 提取当前真实 `lib.rs` job 命令与门禁函数，配合真实 manager 和替代 State/runtime owner；测试同 ID 下不同 Workspace 或同 Workspace 不同 generation 的 get/cancel/enqueue/list 全拒绝，B 正确绑定仍可 get/cancel。1/1 通过（`<temporary-root>/wp02-native-binding.log`）；不是 Tauri IPC/多窗口实机验收。
- 原生整合编译：`SHERPA_ONNX_LIB_DIR=<本机同版本只读库目录> CARGO_BUILD_JOBS=2 cargo check --manifest-path src-tauri/Cargo.toml --lib --tests --quiet --offline --target-dir "$WP02_NATIVE_TARGET"`，exit 0。首次尝试下载 Sherpa v1.13.8 时 TLS EOF 失败，后复用本机同版本预编译库，未更改依赖或产品行为；最终日志 `<temporary-root>/wp02-native-check-ready.log` 为空。

## 验证准备与限制

Node 26.8.1，复用原 checkout 只读 root / markdown-editor node_modules；没有在原 checkout 安装、构建或修补依赖。Office 声明按当前 worktree 的 tracked types.ts / editor-types.ts / browser.d.mts 和现有构建脚本同样选项生成到本 worktree ignored dist，仅供类型检查，不用旧 runtime 冒充当前构建。

未运行全库单元测试、完整 native 测试二进制链接、生产打包、应用窗口、Windows、多窗口或真实 Provider。受控 worker 与源函数门禁测试不替代这些实机证据。本轮权限仅本地修复、验证和提交，不推送、不合并、不发布。

## 消费者验证与复用

| 范围 | 命令/证据 | 结果 |
|---|---|---|
| Module、IPC 映射、QuickNote/Record 元信息 | `vitest run src/lib/aiJobs.test.ts src/services/projectMindApi.test.ts src/lib/quick-note-auto-metadata.test.ts src/components/record/RecordAiMetadataAction.test.tsx --maxWorkers=1`；`<temporary-root>/wp02-consumers.log` | 4 文件、57 测试通过 |
| RichEditor 文字/图片、取消/卸载、预览与 committed 保存 | `vitest run src/components/rich-editor/RichEditor.test.tsx --maxWorkers=1`；`<temporary-root>/wp02-editor.log` | 144 测试通过 |
| App 工作区切换接入 | `vitest run src/App.test.tsx --maxWorkers=1`；`<temporary-root>/wp02-app.log` | 63 测试通过 |
| 新增 binding getter 映射 | `vitest run src/services/projectMindApi.test.ts -t 'native AI job binding' --maxWorkers=1`；`<temporary-root>/wp02-binding-adapter.log` | 1 测试通过，其余 37 项复用上面的同文件通过结果 |
| 前端完整生产类型检查 | `tsc --noEmit`；`<temporary-root>/wp02-types-final.log` | exit 0 |
| 变更规范 | `git diff --check` | 通过 |

共 265 项不同前端测试通过。上述消费者验证之后仅补充此记录；前端生产源码不变，复用有效结果。原生源码在整合编译及最终 worker/绑定测试后没有再修改，不重复构建。

## Standards / Spec 自查

- 比较固定基线 `ca8ecfc4806ac0c9ce3736a97bd9de556717ab71` 与本工作包完整改动（含新测试/本文）。未启动 review 子 agent。
- **Standards：0 个剩余发现。** 核对 AGENTS、docs/agents、CONTEXT、ADR0002/0009/0010 与 code-review 的 smell baseline：保留现有领域 Module；复用 binding 类型；异步失效集中到一个所有者；可信原生入口持当前 runtime 锁校验；Provider 失败仍返回真实错误；测试隔离且无窗口/付费调用；无 Todo/标签入口修改。
- **Spec：0 个剩余代码差距。** Q-AI-01 的事件/命令/等待器同绑定与 generation、Q-AI-02 的完成与 pending 注册解绑、PERF-AI-01 的真实 worker 预算及成功/失败继续调度均有对应动态证据。CD-04 通过前端单一生命周期 Module 与原生物理许可所有者分别落地。Windows/多窗口/真实 Provider 仍按上一节保留为未验证项，不宣称平台产品验收完成或关闭 Issue。

## 集成交接

公共/跨包文件触点：`src/lib/types.ts` 的必需 snapshot.binding / AiJobIdentity；`src/services/projectMindApi.ts` 的 5 个 AI job 命令；`src-tauri/src/models.rs` 的 snapshot.binding；`src-tauri/src/lib.rs` 的 binding 创建顺序、AI job 命令区及注册表；`src/App.test.tsx` 仅新增 binding getter mock 一行。其余为本包 job Module、store、worker 与直接消费者/测试。Todo/标签命令均未修改。集成负责人需与 WP01 等包核对共享文件文本冲突，再统一做真实平台验收。

原 checkout 的分支、用户暂存/未提交文件清单与开始时一致；本包只在独立 worktree 写入源码、测试与文档。

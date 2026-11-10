# WP01 / VC-01：Todo 和 Tag 的 Workspace 绑定

日期：2026-11-11（Asia/Shanghai）。固定基线 `ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`。
分支 `codex/wp01-todo-workspace-binding`，独立 worktree 名称 `project-mind-wp01-vc01`。

## 工作包与追溯

- 发现：VC-01；设计补充：CD-03。依据原审查的 `01c-voice-core.md`、`05-final-report.md`、`06-fix-work-packages.md` 和 `07b-frontend-module-design.md`。
- 关联 Issue：[实际 Issue #116](https://github.com/xuchen-cloud/project_mind/issues/116)，标题为“AI-19：自主操作、Todo修订与统一撤销”。只读查询确认其仍开放，正文指向当前统一规格 #121。本次没有确认 VC-01 专属 Issue，没有创建或关闭外部 Issue；集成 PR #316 仅作审查背景，不作为 Issue。
- 依赖：复用 WorkspaceBinding、Record 的按根目录 binding 查询、App 的 workspaceScoped query 移除、既有 Todo revision CAS 与 native committed changes 事务。
- 交付行为：操作在首次 await 前固定 Workspace 根和生命周期身份，向 Todo/Tag native 命令传递实际 binding；所有异步后的继续写入、缓存合并、回滚、冲突刷新和 Todo 保存反馈必须仍属于同一次打开。
- 非目标：AI job 入口（WP02）、Todo 编辑器草稿/日期（WP05）、持久化格式重写，以及推送、合并、部署或实际发布。
- 验收：A/B 同 Todo/Tag ID 和 revision，标签读取或创建阻塞时切换，旧请求不能写入 B 或替换 B 缓存；正常同绑定请求成功；创建链、旧响应、旧失败、旧 load 和同根重新打开均受保护。
- 验证范围：真实 Todo module + QueryClient/deferred transport、真实 SQLite 双库与原生 storage/worker、IPC 参数、受影响展示调用和前端类型。未运行无关 Office 全量测试。

原 checkout 当时位于 `develop@fe9fe9c`，存在用户未提交修改。修复在固定审查提交建立的独立 worktree 内执行；没有复制、暂存或覆盖原 checkout 的业务改动。修改前只读检查未发现 Tauri/Vite 自动重启进程；没有启动应用窗口。

## 修复

1. 保留 `load/read/change`，在既有 Todo module 内统一传递操作 binding。binding 查询通过 TodoTransport 注入，测试与生产走同一 Interface。
2. 复用 `project-content-binding` query 的对象身份、根目录和 generation；App 移除该 query 时，旧操作永久失效，即使重新打开相同根或重新填入相同 binding 值也不能复活。query 在 Workspace 生命周期内保留，避免观察者 GC 错误终止合法慢操作。
3. 标签读取/创建、query cancel、原生结果、冲突刷新之后检查身份，然后才执行同步缓存修改；旧失败不回滚或刷新 B。
4. Todo hook 在自己的 await 后核对反馈归属，失效操作保留 rejection，不给新 Workspace 发布保存反馈。
5. 全部 10 个 Todo 和 3 个 Tag Tauri 入口要求独立 `binding` 参数，进入原生存储前与当前 runtime 核对；current-workspace 锁保持到数据库任务完成。既有 CAS、真实归属与事务没有放宽。
6. 共享的 projects/page reads 接受可选 binding，Todo module 显式传递；其他原有页面读取沿用其原有入口行为。全部共享 Tag 调用端补齐必需 binding，复用按 Workspace 捕获和响应失效检查。

### CD-03 / WP05 接入契约

`change({ type: "update-content", ... })` 的成功结果是原生返回的规范 Todo，包含去掉 hashtag 后的正文、规范 Tag 与 revision。在 Promise resolve 前，该结果已经合并到同代缓存，或缓存已经保留更新的同代 revision；不会用旧响应覆盖更新内容。

WP05 可在 `onSave` resolve 后撤销自己的未确认文本层，无须等待原始 hashtag 字符串与最终正文相等。`TodoModuleRail → useTodoModule.change` 保留返回值与 rejection。失效 Workspace 的 change 拒绝，不向下一次打开发布结果。未确认草稿继续由 UI 持有；本包没有修改内联编辑器或日期行为。

## 失败复现

新增真实 module 测试先暂停 A 的 Tag lookup，切换并装入 B 的同 ID/revision Todo 和标签，再释放 A 响应。修复前运行该用例，退出 1：预期 rejection，但实际 resolve 为 A 的修改结果；对应旧 native 入口使用 `with_db(..., None)` 的调用链仍存在。

修复后扩展到 lookup/upsert × create/update、同根 reopen、晚到成功/普通错误/revision conflict，以及 workspace/project load。所有场景通过。未把原审查的模拟 transport 实验当作原生双库落库证据。

## 验证与复用

前端复用原 checkout 的既有依赖和本地 Office 生成产物，仅在本包 worktree 建立忽略的链接；没有 clean install，也没有修改依赖、锁文件或这些共享产物。Rust 使用本包独立 target 目录，复用复制的编译缓存，没有共享可写 target。

| 检查 | 实际结果 |
| --- | --- |
| `vitest run src/todo src/components/todo src/components/tags`，加受影响页面/侧栏、导入、prefetch、helper 和 IPC 测试，`--maxWorkers=2` | 首次 393 通过、1 个旧断言失败；补齐该断言的 binding 后，仅该失败用例重跑通过。 |
| `vitest run src/components/record/RecordListItem.test.tsx --maxWorkers=1` | 8 通过。 |
| 新增旧 load / IPC 参数用例分别定向执行 | 各 2 通过。与上两项合计 406 个不同前端用例通过。 |
| `vitest run src/todo/use-todo-module.test.tsx --maxWorkers=1` | 反馈 await 后校验改动后重新执行，8 通过；受影响 rail/Workspace 创建路径另定向复验通过。 |
| `tsc --noEmit` | 补齐忽略的本地构建产物链接后通过；最终生产改动后再执行通过。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib todo --quiet`，独立 `CARGO_TARGET_DIR` | 94 通过、1 个原有手动用例忽略。当时包括 2 个字符串匹配入口转发断言，收口审查已移除这两项实现耦合测试，其余行为验证复用。 |
| 最终 `cargo test --manifest-path src-tauri/Cargo.toml --lib todo_workspace_binding_tests --quiet` | 3 个真实行为用例通过：双库、reopen/runtime 身份、阻塞 worker 后切换。与仍有效的既有 Todo 行为验证合计 92 通过。 |
| `git diff --check` | 通过。 |

原有忽略项为 `agent::bridge::todo_write_tests::manual_cli_contract_fixture`，需要显式设置手动 CLI fixture 输出路径；没有把它算作通过。没有在发布阶段重复执行仍有效的检查。

临时日志按 `project-mind-wp01-vc01-` 前缀保存于本机临时目录：`frontend-final.log`、`frontend-retest.log`、`record-tags.log`、`load-final.log`、`command-final.log`、`feedback-final.log`、`feedback-ui-final.log`、`feedback-rail-final.log`、`types-final.log`、`native-final.log`。完整受影响前端范围可从 `frontend-final.log` 的测试文件清单核对。

## Standards / Spec 自查

- **Standards：通过。** 主 agent 对照 AGENTS、领域文档、ADR-0009、验证范围规则与 code-review smell baseline 自查。检查仅在异步/存储边界重复必要不变量；未加通用重试或降级；保留 CAS、原生事务与可信归属。移除依赖源代码字符串的两项测试，保留真实存储和 IPC 行为证据。共享标签入口改变所需的调用端接线和 fixture 更新属于同包契约变更。
- **Spec：通过。** 主 agent 逐项核对 WP01 / VC-01 / CD-03：包含创建 await、旧 load/tag 响应、失败回滚/刷新、同路径新 generation、规范成功结果与原生双库。没有把阶段提交当作关联 Issue 的完整交付或关闭依据。

未启动 Standards / Spec review 子 agent；本包两个子 agent 只实施原生修复与前端调用端接线，最终检查由主 agent 完成。

## 集成交接与未验证项

- 公共文件：`src/services/projectMindApi.ts` 新增 binding 获取，并为 Todo/Tag 方法增加第二个必需 binding 参数；共享三类读取新增可选 binding。未修改业务 DTO 字段或 AI job DTO。
- `src-tauri/src/lib.rs` 交集限于共享 DB helper、三个读取入口及 Todo/Tag 入口；没有改 AI job 入口。WP02 应按 hunk 整合该公共文件。
- WP05 文件交集仅 `TodoListItem.tsx`、`TodoRail.tsx` 的标签读取接线及对应 fixture；内联编辑器、日期文件未改。最终集成仍需核对 WP05 实际接入和旧草稿/回调行为。
- 原生双库测试运行真正的 SQLite、生产 storage gate 和 worker；Tauri 命令参数转发同时由前端 IPC 测试和入口逐项自查覆盖。没有运行真实 GUI IPC 双库切换、Windows 或多窗口桌面验收，不能由这些测试推定通过。
- 本包仅修复、验证和本地提交；未推送、合并、部署、发布或变更任何远端 Issue。

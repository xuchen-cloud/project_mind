# WP05：Todo 编辑草稿、确认与日期展示

## 工作包

- 固定基线：`ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`。
- 审查输入：2026-11-11 整体审查 Q1/Q2/Q3、WP05、CD-03；关联 Todo 修订历史 Issue [#116](https://github.com/xuchen-cloud/project_mind/issues/116)，当前规格入口 [#121](https://github.com/xuchen-cloud/project_mind/issues/121)。本包不代表上述 Issue 的全部产品验收完成。
- 依赖：Q2 消费 WP01 的成功确认契约；`update-content` resolve 前已发布同绑定规范 Todo 或保留更新 revision，已失效的 Workspace 操作 reject。模块、原生 binding、DTO 由 WP01 负责。
- 交付：新增子任务及正文保存失败后保留原文和日期并可重试；请求错误由原有 Todo hook 展示，编辑器消费 reject；正文成功后释放待确认显示，使规范化 hashtag 正文和之后远端更新可见；date-only 展示及辅助属性跨时区保持日历日。
- 非目标：泛型草稿管理、通用时间框架、Todo Module 重构、原生/DTO 变更、发布或合并 develop。
- 验收：deferred I/O 与 revision reject 后重试参数保持；无未消费 rejection、无重复 toast；真实 TodoModuleRail → hook → Module → transport 的 hashtag、连续保存、远端 cache 更新；UTC/上海/洛杉矶展示、ARIA、dateTime 一致；与 WP01 集成时切换 Workspace 后旧回调不污染新视图。
- 验证范围：编辑器/日期定向测试、Todo 受影响测试、前端类型检查；WP01 集成验证。无原生 Office 全量或应用窗口。

## 复现与修复

### Q1

基线真实 `TodoInlineProgressEditor` 中，提交 `@20270315 提交完整方案` 后 deferred reject，I/O 和 revision 两例均重新显示空 textbox，且出现两条 unhandled rejection。原因是关闭编辑和重开 add 的 effect 分别清空草稿。初始化改到用户显式进入 add/edit 时，成功新增后清空，失败重新进入原模式，保留原 draft 并消费已由 hook 展示的 reject。

正文编辑器同样会在待确认显示更新时用已解析内容覆盖草稿，丢失日期 token；仅在非编辑且非保存时同步外部内容，失败后保留完整输入。

### Q2

基线提交 `新正文 #work` 后，即使 props 更新为规范 `新正文`、保存确认，仍显示原始 hashtag。原实现以规范值与原输入字符串相等作为确认条件。按 WP01 明确的 resolve 契约，成功时直接撤销待确认文本和日期，不再由编辑器猜测标签规范化规则。

### Q3

基线在洛杉矶进程中将 date-only `2026-11-11` 展示为 `11月10日`，完整日期属性也提前一天。date-only 按日历年月日构造本地日期，两个 formatter 共用局部解析，保留其他时间字符串既有行为。

## 验证记录

验证日志保存在本机 `/private/tmp/wp05-*.log`，依赖复用原 checkout 的 `node_modules`，不是 clean install。

- Q1 红测：`vitest run src/components/todo/TodoInlineProgressEditor.test.tsx -t 'keeps the full new subtask' --maxWorkers=1`：2 failed，2 unhandled errors。
- Q2/正文草稿红测：`vitest run src/components/todo/TodoInlineContentEditor.test.tsx -t 'releases pending|keeps the original' --maxWorkers=1`：2 failed，1 unhandled error。
- Q3 红测：`TZ=America/Los_Angeles vitest run src/components/todo/todo-utils.test.ts src/components/todo/TodoDueDate.test.tsx`：8 failed、7 passed。
- Q3 绿测：上述两个测试文件分别在 `TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/Los_Angeles` 的全新进程执行，各 15 passed。包含普通日期、年边界、闰日及 DST 日期；真实 TodoDueDate 文本、ARIA、title、dateTime。
- 初次全仓 `tsc --noEmit`：失败，隔离 checkout 缺少本地 Office dist 及 markdown-editor 的 html-to-image/pdf-lib 依赖；没有 WP05 类型错误。补齐验证环境后另记结果。
- 补齐上述本机已有产物和子包依赖链接后，全仓 `tsc --noEmit`：通过，日志 `wp05-typecheck-final.log`。复用产物仅用于类型环境，不宣称 Office 构建或验收通过。
- `vitest run src/components/todo src/todo --maxWorkers=1`：16 files / 154 tests passed；覆盖本包行为和既有 Todo 回归，日志 `wp05-todo-suite.log`。
- 增加真实 Workspace A → B 重挂载测试后，在不含 WP01 的固定基线上，晚到成功与失败两例均按预期复现 VC-01：旧 A 结果/回滚覆盖 B 缓存；其余 3 项接入测试通过。日志 `wp05-workspace-baseline.log`。这两项需在 WP01 最终代码与 WP05 的组合上通过，不能由本包编辑器本身替代 binding 校验。

## Standards / Spec 主 agent 自检

依据固定基线 diff、AGENTS、`docs/agents`、CD-03 和 `code-review` 两轴要求自行检查，未启动 review 子 agent。

- **Standards**：修改局限于两个编辑器、Todo 日期 formatter、对应测试和本报告；无原生、DTO、Todo Module 或其他组文件改动；无新增重试、兼容层、泛型 draft manager 或时间框架。初始化属于编辑动作，外部 I/O 失败保留输入；请求错误保持 hook 展示，不在服务层吞掉。无新增列表、样式或滚动结构。
- **Spec**：Q1 的失败保留/重试和已展示 reject 消费、Q2 的同次 resolve 确认、Q3 的日历日展示均有真实生产路径回归；hashtag 标签与正文、后续远端更新、连续保存无旧正文闪回有 DOM 断言。Workspace 晚到成功/失败两例是 WP01 集成门槛，不由编辑器自建 binding 判断。
- Standards 0 项新增发现；Spec 0 项新增发现。WP01 固定提交组合验证通过，见下节。

## WP01 最终组合验收

- WP01 固定提交：`32ae379e946d24f93b2a0c0f2766863692a801c4`。已读取该提交 `todo-module.ts` 的明确确认契约：update-content resolve 返回原生规范 Todo，缓存已经协调或保留更新的同代 revision，失效 Workspace reject。
- 验证工作树：`/private/tmp/project-mind-wp05-wp01-validation-20261111`，由 WP01 提交创建，应用本包同一补丁。两个编辑器、日期 formatter 及接入测试文件的 SHA-256 与 WP05 交付工作树一致；没有修改 WP01 源码或其工作树。
- `node_modules/.bin/vitest run src/components/todo src/todo --maxWorkers=1`：**16 files / 168 tests passed**，无未消费 rejection。日志 `/private/tmp/wp05-wp01-combined-tests.log`。
- 其中 `TodoInlineEditors.integration.test.tsx` 5 项使用真实 TodoModuleRail、hook、Todo Module 与内存 QueryClient，仅控制 owned transport；覆盖规范 hashtag、标签、连续保存无旧正文闪回、后续远端 cache 更新，I/O/revision reject 的原文与日期重试、单一 toast，以及 A/B 同 ID/revision 下晚到成功和失败均不污染 B。Workspace 测试模拟 App 按 root 重挂载的生命周期，未冒充完整 App/跨窗口实机验收。
- `node_modules/.bin/tsc --noEmit`：**通过**，日志 `/private/tmp/wp05-wp01-combined-tsc.log`。相对前次扩大到 WP01 组合的原因是绑定接入改变了真实调用路径和类型。
- `git diff --check`：通过。Q3 三时区结果沿用未变化的 formatter/组件测试，不重复执行。
- 集成顺序：先应用 WP01，再应用 WP05。本包从固定审查基线单独交付；未包含 WP01 时，两条 Workspace 回归会继续揭示 VC-01，不能把基线上的这两条失败标成通过。

## 限制

- 未运行应用 GUI、真实跨窗口 IPC、Windows/WebView2、性能/p95、完整应用/Office 构建或全仓单测；jsdom 与本地类型检查不替代这些验收。
- 不推送、创建 PR、合并 develop、关闭 Issue、部署或删除用户数据；原 checkout 的用户改动未被本包写入。
- 主 agent 的已获准进程检查未发现 Tauri/Vite；Q3 子 agent 的额外进程枚举被沙箱拒绝：`zsh:1: operation not permitted: ps`，未重试或绕过。
- 主 agent 首次暂存被沙箱拒绝，目标为 `/Users/xuchen/project_mind/.git/worktrees/project-mind-wp05-todo-editors-20261111/index.lock`，错误 `Operation not permitted`。检查确认未暂存后，按环境权限流程使用获准的 `git add` 完成指定文件暂存。

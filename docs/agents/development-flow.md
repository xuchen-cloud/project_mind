# Development workflow

本仓库采用 `develop` 集成、`main` 发布的双分支模型。所有准备合入仓库的改动都必须可追踪，但流程深度应与风险匹配：轻量改动保持低成本，标准和高风险改动使用更完整的验证与 review。

## Branch roles

- **`develop`**：日常开发主干和功能集成分支。常规需求、缺陷和维护改动以它为基线，并以它为 PR 目标。
- **`main`**：可发布分支。只接收来自 `develop` 的 Release PR，以及紧急生产修复。
- **Issue branch**：一个实现 Issue 对应一个短生命周期分支，命名为 `codex/issue-<number>-<slug>`。
- **Prototype branch**：回答一个可运行设计问题的临时分支，命名为 `prototype/<slug>`，从 `origin/develop` 创建，不合入 `develop` 或 `main`。

当用户只说“合并到主干”“完成后合并”或“自动合并”而没有明确提到 Release / `main` 时，目标分支是 `develop`。只有明确要求发布 Release、生成发布包或合入 `main` 时，才进入 Release flow。

远端必须存在从最新 `origin/main` 初始化的 `develop`。初始化属于仓库管理操作，需要维护者明确执行；完成后，`develop` 和 `main` 都只通过 PR 接收变更。

## Start work

收到新问题或新需求后：

1. 先确认目标、范围和可验证的验收标准。确认前保持仓库只读；解释、诊断、评审或不落库的方案讨论不创建 Issue branch。
2. 确认要产生仓库改动后，搜索是否已有对应 GitHub Issue；有则复用，没有则创建 Issue。轻量改动允许使用精简 Issue，只需记录背景、范围和可验证结果。
3. Issue 存在后，获取最新远端状态并从 `origin/develop` 创建 Issue branch。开始写入仓库前，确认当前工作区没有会被覆盖的其他改动。
4. 在 Issue branch 上实现、验证和提交。不得直接在 `develop` 或 `main` 上开发。

Issue 是持久化工作的入口。实现代码、准备合入的文档、领域文档、ADR 和调研报告，都应在 Issue branch 上写入。一次实现复用一个对应 Issue，不为流程重复创建 Issue。

## Risk level

开始实现时选择满足条件的最低风险级别；如果出现跨模块影响、未知行为或不可逆变化，立即升级，不能为了减少门禁维持较低级别。

### Lightweight

同时满足以下条件时属于轻量改动：

- 单会话内可以完成，范围局部且行为明确；
- 不改变持久化数据、公共 API、权限、安全边界、核心业务规则、构建发布流程或架构边界；
- 受影响的验证范围清楚，失败后容易回滚。

典型例子包括文案、文档、小范围视觉样式、测试描述，以及不改变产品行为的局部整理。

轻量门禁：

1. 运行直接覆盖改动的目标检查；没有可执行检查时，记录人工验证证据。
2. 对 Standards / Spec 两个轴做简短自检：代码是否符合仓库规范，结果是否满足 Issue；不强制运行完整 `/code-review`。
3. 获取 `origin/develop`。只有目标分支与改动范围重叠、PR 报告冲突或合并结果可能改变行为时，才整合最新 `develop` 并重跑目标检查。
4. 推送 Issue branch，确认本地 `HEAD` 与远端同名分支一致，然后创建 PR。

### Standard

新增或修改用户行为、修复产品缺陷、跨多个文件或模块但边界清楚的改动，默认属于标准改动。

标准门禁：

1. Issue 的全部验收标准都有实现和验证证据。
2. 运行受影响测试套件，以及项目现有的类型、格式、静态检查或构建检查。只有影响面跨越公共基础设施或无法可靠界定时才运行全量测试。
3. 获取最新 `origin/develop`，将它整合进 Issue branch；首次推送前可以 rebase，已经推送后使用 merge，避免强推远端协作历史。
4. 在更新后的候选提交上运行 `/code-review`，固定范围为 `origin/develop...HEAD`，完成 Standards / Spec 双轴 review。修复发现后重跑受影响验证并重新 review 新差异。
5. 推送 Issue branch，确认本地 `HEAD` 与远端同名分支一致，然后创建 PR。

### High risk

满足任一条件即为高风险改动：数据迁移或存储格式变化、权限或安全边界、公共 API 兼容性、核心架构、关键业务规则、大范围重构、发布基础设施，或失败后难以回滚的变化。

高风险门禁在标准门禁之上增加：

- 使用完整 Spec；需要多个独立落地切片时拆分 tickets；
- 在实现前确认测试 seam 和回滚方案；
- 运行完整测试套件和所有可用的项目级验证；
- 对最终完整差异重新执行 `/code-review`，保证 PR head 就是已审查提交；
- 没有明确 merge authority 时停在已验证并推送的分支，等待人工决定。

风险分级只缩放验证与 review 深度，不取消 Issue、独立分支、远端一致性和 PR。

## Matt skills integration

Matt skills 保持其原始定义；以下规则只决定本仓库何时调用它们，以及调用时使用的分支和固定比较点。

- **`/grilling`、`/grill-with-docs`**：目标、范围、领域语言或取舍尚不明确时使用。Issue 创建前的澄清保持只读；需要把结论写入 `CONTEXT.md` 或 ADR 时，先创建 Issue branch，再运行 `/grill-with-docs`。
- **`/to-spec`**：多会话、跨边界或高风险工作需要完整 Spec 时使用。清楚且单会话可完成的工作不为形式运行它。
- **`/to-tickets`**：工作需要多个可独立验收、可分别合入的纵向切片时使用。每个实现 ticket 使用自己的 Issue branch；只关闭当前实现 ticket，父 Issue 等其整体验收完成后再处理。
- **`/implement`**：Issue 已达到可实现状态且当前位于对应 Issue branch 时使用。轻量文档或纯视觉调整可以直接实现，不强制套用完整 TDD 流程。
- **`/tdd`**：新增行为、缺陷回归或复杂逻辑存在稳定公共 seam 时使用。测试 seam 在 Issue 或 Spec 阶段一次确认；没有行为 seam 的文档与样式调整不强制使用。
- **`/code-review`**：标准和高风险改动使用；轻量改动只做相同两轴的简短自检。仓库流程先形成可比较的候选提交，再以 `origin/develop` 为 fixed point review；修复形成新提交后 review 新差异。
- **`/triage`**：处理他人提交的原始 Issue 或外部 PR 时使用。由本流程创建、`/to-spec` 发布或 `/to-tickets` 拆出的 Issue 已具备上下文，不重复 triage。
- **`/diagnosing-bugs`**：难以复现、间歇性、性能回退或第一次修复尝试失败的缺陷使用。边界清楚且已有失败测试的普通缺陷直接进入实现。
- **`/prototype`**：只有设计问题必须通过可运行代码或 UI 才能回答时使用。先关联实现 Issue，再从 `origin/develop` 创建 prototype branch；结论写回 Issue，原型分支保留为证据但不合并。
- **`/research`**：需要从第一方资料进行实质调研时使用。若报告要进入仓库，写入 Issue branch；只需回答一个稳定事实时不创建调研文档。
- **`/resolving-merge-conflicts`**：已经处于 merge 或 rebase 冲突时使用，按双方原始意图解决并完成操作。
- **`/wayfinder`**：范围巨大且当前无法形成一条可执行路线时使用；它只产出决策，路线明确后再进入 `/to-spec`。

Matt `/implement` 描述中的收尾顺序与 `/code-review` 的 `HEAD` 差异模型不完全一致。本仓库以可复现审查为准：先形成候选提交，再 review；review 修复作为后续提交并重新检查。无需修改 Matt skills 本身。

## Push and merge authority

推送 Issue branch 与合入 `develop` 是两项独立权限。

### Push authority

- 用户要求远端备份、协作或查看时，可以推送尚未完成的 Issue branch，并明确当前验证状态。
- 实现达到完整、可交付状态且已通过对应本地验证后，agent 可以自主推送 Issue branch，无需额外询问。推送后确认本地 `HEAD` 与远端同名分支一致。
- agent 也可以在远端备份、跨会话接续或准备 review 明显有价值时主动推送一个完整的中间状态，但必须说明尚未完成的工作和未运行的验证。
- 推送只授权更新当前 Issue branch，不自动授权创建 PR、合入 `develop` 或发布 Release。

### Merge authority

- 用户明示“完成后合并”“直接合并”“自动合并”或同等含义时，对应风险门禁通过后自动合入 `develop`。
- 用户虽然没有使用“合并”字样，但上下文清楚表达结果应直接完成落地时，可以视为隐含 merge authority。判断必须基于当前请求，不从过去无关任务继承。
- 上下文是否授权合并不够确定时，先完成实现、验证并推送 Issue branch，然后报告结果并询问是否合入 `develop`；在得到肯定答复后直接完成 PR 和合并，不重复询问。
- 诊断、解释、评审、调研、原型探索，或包含“先看看”“先别合并”“等我确认”等暂停语义的请求，不授权自动合并。
- 授权等待期间如果 Issue branch 或 `develop` 发生变化，合并前重新执行受影响门禁；没有变化时不重复已经通过的验证。
- merge authority 只覆盖 `develop`，不授权发布 Release、合入 `main`、创建标签或发布构建产物。

## Merge to develop

获得 merge authority 且对应风险门禁通过后：

1. 创建 base 为 `develop`、head 为 Issue branch 的 PR；正文使用 `Refs #<issue-number>` 并记录验证与 review 级别。
2. 确认 PR head 与已验证的远端 Issue branch 提交一致。
3. 满足 GitHub 当前实际要求后合并 PR；没有必需 CI 或外部 reviewer 时，不增加虚构等待门禁。
4. 确认 PR 已 merged，且远端 `develop` 包含合并结果。
5. 在当前实现 Issue 留下 PR 链接与验证摘要并显式关闭。`/to-tickets` 的父 Issue 只有在自身验收完成后才关闭。

## Release flow

只有用户明确要求发布 Release、生成 Release 包或合入 `main` 时执行：

1. 确认计划发布的改动均已进入远端 `develop`，并完成版本号、变更说明和完整验证。
2. 从已确认的 `origin/develop` 提交创建 `release/<version>`，冻结本次发布范围；版本号和发布说明在 release branch 上收尾。
3. 对 release branch 相对 `origin/main` 的发布差异完成完整验证和 Standards / Spec 双轴 review。
4. 推送 release branch 并确认本地与远端提交一致，再创建 base 为 `main` 的 Release PR。
5. 合并后确认 `main` 包含已审查的 Release 提交；只在该提交上创建版本标签、构建并发布产物。
6. 如果 release branch 包含不在 `develop` 中的版本号或发布说明，通过 PR 同步回 `develop`。

## Production hotfix

紧急生产修复是唯一从 `main` 开始的开发例外，按高风险门禁处理：先创建 Issue，从最新 `origin/main` 创建 hotfix branch，验证和 review 后 PR 到 `main`。发布完成后必须把修复通过 PR 同步回 `develop`。

## Repository enforcement

在 GitHub 中保护 `develop` 和 `main`：要求通过 PR 合并，禁止直接 push 和 force-push。真实 CI 尚未配置时，以本流程规定的本地验证和 review 为门禁；以后启用 required checks 后，以 GitHub 报告的实际要求为准。

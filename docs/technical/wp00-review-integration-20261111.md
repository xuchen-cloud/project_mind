# 本轮全库审查修复：WP00 集成交接

本机路径以 `<temporary-root>` / `<original-checkout>` 占位；命令变量须按执行机设置。原始路径保留于各包源提交及 WP00 外部证据，验证结果未变。

## 工作包约定

- 固定基线：`ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`，对应已合并 PR #316。
- 关联 Issue：只读核对未发现本轮专门的集成 Issue；#308 是上一轮集成工单，不能把 PR #316 当作本轮修复 Issue。不创建、关闭或修改外部 Issue。
- 集成分支：`codex/wp00-review-integration-20261111`，从固定基线建立独立 worktree。
- 交付：接收各包最终提交，维护共享文件契约；在独立分支串行整合，按受影响范围验证组合结果并自行完成 Standards / Spec 检查。
- 授权更新：最初仅允许本地整合；十包接收阶段用户明确授权全部修复合入 develop 并推送。按仓库 PR 流程执行，不关闭尚有产品验收缺口的父 Issue。
- 非目标：代写各组修复、重复创建会话、覆盖原 checkout、额外部署/发布或删除用户数据。
- 依赖：十包均由原协调会话派发。WP04 在 WP03 稳定后完成；WP06 随后从 WP04 最终提交串行开始。WP00 不另建会话。
- 验收：每包有精确提交、发现 ID、验证命令/结果、证据与未验证项；所有收到的提交在组合树上通过必要的接口/受影响验证，缺失包和平台门槛保持可见。

## 当前接收清单

“收到”表示已核对责任组最终交付，不等于组合验证通过。

| 包 | 发现 | 分支 | 接收状态 | 提交 | 组合验证 |
|---|---|---|---|---|---|
| WP01 | VC-01 | `codex/wp01-todo-workspace-binding` | 已整合 | 源 `32ae379e946d24f93b2a0c0f2766863692a801c4`；组合 `42d2bfb` | 前端组合通过；原生结果见下 |
| WP02 | Q-AI-01/02、PERF-AI-01 | `codex/wp02-ai-job-lifecycle-20261111` | 已整合 | 源 `52681197421261b2083d62a2e7d58dc6d280ab84`；组合 `22d67a9` | 前端组合及补充回归通过；原生结果见下 |
| WP03 | ARCH-01/02/03 | `codex/wp03-project-rename-recovery` | 已整合 | 源 `428acbf794aa240dc960b565c7279aeec8d085fd`；组合 `0219957` | 复用最终 23 项与真实 worker 1 项；已有失败另列 |
| WP04 | ARCH-04 | `codex/wp04-cross-volume-working-save` | 已整合 | 源 `04bb493c882184c1220f59c6d86944075065cca8`；组合 `e433a27` | 组合原生结果见下；真实第二卷未验收 |
| WP05 | Q1/2/3 | `codex/wp05-todo-editors-20261111` | 已整合 | 源 `fe6797e0f5cf3b18b0dcae20e74da615f95bf3a7`；组合 `19379b3` | 单独组合 168 项及最终前端组合通过 |
| WP06 | VC-02 | `codex/wp06-voice-stable-title` | 已整合 | 源 `4431086d9b3196d69ddfd9816b8ea07dfd418296`；组合 `830313d` | Voice 定向组合 7/7；其余与三时区证据复用 |
| WP07 | SEC-DEP-01/02 | `codex/wp07-security-dependencies` | 已整合 | 源 `54dda267066ba72716035be42375db945bacf7aa`；组合 `d55ab18` | 组合类型、宿主构建和受影响测试通过 |
| WP08 | PERF-01 | `codex/wp08-file-path-index-20261111` | 已整合 | 源 `519b751e12d22d4c18285cdaa2824a54b99e2f3b`；组合 `a773178` | 受影响前端组合通过 |
| WP09 | DOC-01/02、STD-01 | `codex/wp09-docs-rules-20261111` | 已整合 | 源 `04642d077d8c9b2c9c1cd7fd5e8425447a04013a`；组合 `80371ef` | 58/58、UI/路径标准、宿主构建通过；新增报告适配见下 |
| WP10 | OPS-01 | `codex/wp10-beta-channel-20261111` | 已整合 | 源 `44d161c83451f1d72b8b510163ba6c779853ace3`；组合 `4cd251a` | 单包 39 项及最终受影响组合通过 |

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

WP03 已稳定交付改名 intent、恢复入口、精确路径映射及 schema42；组合提交 `0219957` 保留启动时 Project root → directory → working save 的恢复顺序。WP04 已保持 File WorkingSave/WorkingStatus Interface，完成 live 卷 stage/backup 与 journal/恢复/清理修正，以及已有 pending journal 的兼容；没有修改 db.rs、恢复入口或 schema，组合提交为 `e433a27`。原协调会话已从 WP04 源提交派发 WP06，只接续 voice_minutes_apply 的稳定录音开始时间后缀并明确时区。WP00 只读跟进，不代建会话或修改责任组工作树。

## 验证计划与复用

1. 接收时核对基线祖先、提交清单、干净状态、文件边界及实际证据；只接收最终提交，阶段提交不表示 Issue 完成。
2. 先整合互不依赖的已交付包；共享文件逐包串行处理。每次冲突记录原因和保留的两侧行为。
3. WP01/02/05 组合后运行相关 Todo/AI 生命周期与 transport/调用端测试、前端类型检查。原生绑定和实际 worker 计数分别验证。
4. WP03/04/06 组合后集中运行受影响保存/恢复/纪要套件；真实 kill 与第二卷证据单独列出。未具备平台时保持未执行。
5. WP07 的干净安装、Markdown 回归和受影响构建可在源码/依赖/配置未受后续包影响时复用；组合树仍需前端类型/构建来确认交叉兼容。WP09 工程规则、WP10 发行脚本使用对应定向测试。
6. 最终记录组合提交/树与命令结果；通过、失败、未执行分开。已通过且影响范围未变化的检查不反复全量运行。

## 已接收证据

### WP01 / WP05

[WP01 交付](wp01-vc01-todo-workspace-binding-20261111.md)与 [WP05 交付](wp05-todo-editors-20261111.md)。顺序为 WP01 后 WP05，均已整合。WP01/WP02 共享的三个文件按局部 hunk 自动合并，无人工选一侧；Todo/tag 与 AI job 必需 binding 均保留。

- WP01：406 项不同前端测试、最终类型检查、真实双 SQLite/storage/worker 的 3 项最终门禁通过；仍有效 Todo 行为验证合计 92 通过。原有手动 CLI fixture 1 项忽略，不计通过。
- WP05：168 项真实 Todo 组合测试与类型检查通过；日期 formatter/辅助属性在 UTC、上海、洛杉矶三个独立进程各 15 项通过。
- WP01/WP05 的真实 Module 接入覆盖 hashtag 规范化、连续保存、远端更新、失败原文/日期重试、单一 toast 和 A/B 同 ID/revision 下晚到成功/失败。
- 未验证：真实 GUI IPC 双库切换、跨窗口、Windows。jsdom 模拟按 root 重挂载，不是完整桌面切换验收。

### WP02

[AI job 交付记录](review-20261111/wp02-ai-job-lifecycle.md)。无冲突整合。单包通过 265 项不同前端测试、完整生产 TypeScript 检查及 `cargo check --lib --tests`。4 项受控 worker 和 1 项绑定门禁测试是导入真实源代码的 rustc harness：前者替代 DB/Chrono，后者替代 State/runtime；不能标成完整原生测试二进制或真实 Tauri IPC 已通过。

WP00 最终调用链检查补充复现：sync 的 ready promise 已完成，reset 在异步续体恢复前运行时，旧 enqueue 仍被调用一次。定向新回归在收到的源提交失败（`ai-ready-reset-red.log`）；enqueue 前核对 `aiJobSync === sync` 后，真实前端 Module 的 14/14 项通过（`ai-ready-reset-green.log`）。这是原 WP02 生命周期验收窗口的补齐，不新增通用机制；原生 binding 仍保留，不以 UI 失效代替写入门禁。

完整原生 worker 测试二进制的组合结果见下；原生 AI 命令绑定门禁仍仅有上述 harness 动态证据。保留未验证项：Windows、真实多窗口、真实 Provider/Tauri IPC。未调用付费 Provider。

### WP03

[Project 根改名交付记录](../implementation/wp03-project-root-rename.md)。13 文件无冲突整合，未涉及前端 DTO/命令/事件；源提交与组合提交 patch 完全相同。

- 一个原生 Module 持有 intent、目录物理身份、无覆盖 rename、SQL/outbox 与恢复。schema41→42 的精确 Record 资源位置表与版本号原子提交；不可变正文、UUID/hash 不重写。
- canonical Record 的当前编辑投影、保存、Agent patch、历史预览/恢复及连续改名使用确切已持久引用，仍保留 Scope、来源、managed path 和 symlink 检查。迁入 File 的合法外部历史保持原位，源根 foreign history/resource 保护仍生效。
- 复用最终 23 项定向原生测试，以及另行明确执行的真实固定 Node/Record worker 1 项；5 个真实 SIGKILL 时点、外部占用、schema40/41 升级与失败原子性有实际证据。生产 `cargo check --lib` 通过。ignored helper 不计通过。
- 该包曾集中执行完整受影响范围：409 passed、4 failed、23 ignored。schema 硬编码断言和两项缺少 Record runtime 的失败修正/准备后均已定向通过。仍有 `imported_file_legacy_registration_rejects_foreign_physical_owner_and_forged_scope`：伪造归属仍被拒绝，但返回 `io_failed` 而非契约 `ownership_mismatch`；固定审计基线单独运行也同样失败（`<temporary-root>/wp03-unrelated-baseline.log`）。本轮未修改该导入路径或放宽断言，不能宣称完整套件全绿。后续解锁条件为保持拒绝伪造归属并修正错误分类。
- 未验证：GUI 多窗口、Windows/Linux 真机、第二卷和断电。SIGKILL 仅证明进程崩溃恢复。该包稳定可供 WP04/06 继续，但不表示满足发布门禁。

### WP07

交付记录：[依赖安全修复](wp07-security-dependencies-20261111.md)。责任组报告：干净安装、96 项针对性测试、类型检查、宿主及 Record/Source worker 构建通过；Vite 8.1.7、markdown-it 14.3.3，默认 loopback、显式 dev:lan；400 KB reference 微测约 3220 → 87 ms。组合类型、宿主构建和受影响测试结果另列于下。

保留未验证项：Windows、多窗口、真实 LAN/Tauri GUI、安装包；其他 11 项 audit 告警不在本包已确认修复范围。

### WP04

[跨卷 working save 交付记录](../implementation/wp04-cross-volume-working-save.md)。5 文件无冲突接收；源与组合 patch ID 一致。只涉及原生 working 保存/恢复及测试，未改变 UI DTO/命令、schema 或不可变历史。

- 新 stage/backup 在 live 的既有父目录，使用排他创建、相同随机 token、父目录物理身份与文件 identity/hash；rename 不覆盖目标、不降级 copy、不吞 EXDEV。journal、状态/BLOB、receipt/outbox 和提交后清理保持各自持久化边界。
- 升级前没有 `placement` 的 journal 只接受该 File 原 history_dir 下的旧命名；新 journal 只接受 live 父目录下的新命名。父目录替换、symlink、外部 backup/staged 占用保留材料；已提交的 SQL 不因清理失败回滚。
- 单包完整受影响范围 280 passed、1 failed、17 ignored；唯一新增占用测试把提交后的清理失败误认为 SQL 回滚。保持生产代码与外部字节保护不变，修正 revision 预期；该模块最终 8/8 通过，并补上 moved legacy prepared 的真实启动恢复。没有以放宽权限、覆盖或清理断言解决失败。
- 普通及真实 A→B owner move 后的 Office working 保存另行明确执行 2 项，每项覆盖 DOCX/XLSX/PPTX 两次保存、重开和单次归档，旧历史元数据/hash/字节不变；实际构建并组装本分支 Office engine/sidecar，未重建未变更的 XLSX GUI renderer。`<temporary-root>/wp04-real-office.log` 已核对 2/2。生产 `cargo check --lib` 通过，复用其精确未变更代码证据。
- 普通/moved 两种布局各 6 时点共 12 次真实 SIGKILL；升级前 4 状态、父目录与占用保护有实际动态证据。EXDEV 回归使用真实 DB/文件/owner move 与 rename 边界注入，不是实际第二卷。
- **真实第二卷 move→文本/Office 保存→重开仍未验收**：本机只有系统卷。解锁需要同一 Workspace 内合法挂载、历史与 live 的实际设备号不同；不创建/格式化磁盘，不用 symlink 或注入用例替代。GUI 多窗口、Windows/Linux、断电仍未测。既有 forged-scope 错误码失败未改、未重跑，继续保留。

### WP08

路径索引与递归/菜单接入已核对，无冲突整合。单包 31 项路径行为和 86 项 UI 测试、类型检查及前端打包通过。1000/2000/5000 项各只读取 D 次 managedPath，随后查询不再读取；5000 项同输入微基准包含构建约 2766.14 → 1.23 ms。该耗时是纯逻辑样本，未验证真实 GUI 或产品 p95。完整台账在本地同级 `project-mind-wp08-evidence-20261111`。

### WP06

[Voice 稳定标题交付](../implementation/wp06-voice-stable-title.md)。确认源提交以最终 WP04 为祖先；只接收该包 2 文件的新增改动，没有重复接收 WP03/04。db.rs 的纪要事务与 WP03 的 schema42/根恢复修改无冲突。

- 纪要事务通过版本 CAS 后读取相同 session 的 `started_at`，显式转 UTC，Workspace/Project 共用 `AI 标题 · YYYY-MM-DD HH:mm`。不使用生成时刻或系统本地时区；解析失败不回退当前时间。标题、纪要和版本仍原子提交，AI 覆盖手动标题行为保留。
- 单包 `minutes` 14 项首次 12 passed、2 项回环端口 bind 被 sandbox 拒绝；仅重跑两项 HTTP fixture 后 2/2 通过，不访问真实 Provider。UTC/上海/洛杉矶均验证固定历史日期、换日、重开、再次生成与 CAS 失败不部分写入，生产编译通过。
- 无 DTO、前端、schema 或恢复入口改动；真实录音/Provider、Windows/Linux 和完整 Voice 产品验收仍未执行。

### WP09

[文档和工程规则交付](../implementation/review-wp09-docs-rules-20261111.md)。25 文件无冲突接收，根 package/lock 未改。README/产品说明对齐独立 HTML WebView；Agent 说明对齐 FileCredentialStore、实际方法注册及旧 grant 兼容；schema 链接当前代码单一来源，可随 WP03 的 schema42 使用。

路径例外仅保留固定基线的文件、整行 SHA-256 与次数，新增/复制/改写/迁移违规行继续失败；没有为本轮新报告追加例外。caret 仅将原 1.1 秒常量提取为同值 token，限制实际 selector、opacity keyframe、step-end infinite 与 reduced-motion；普通长动画仍失败。

单包 58/58、两条标准检查、64 个相对链接目标及 headless Chromium 的实际 CSS 正常/reduced 场景通过，日志与两张截图随提交保留。审批已完成，先前 waitingOnApproval 状态不再适用。此 CSS 片段验收不是完整编辑器/WebKit/原生 GUI 验收。

### WP10

版本决策与实际提交基线同由 advance-beta-channel 拥有；无冲突整合。单包 3 文件 39 项通过，包含原 13 项。已核对真实本地 bare remote 的顺序、相同资产幂等、同版本资产冲突、正常递增、pre-push 竞争、Windows-only 及最终 workflow shell 接入证据。完整报告位于本地同级 `project-mind-wp10-beta-channel-evidence-20261111/10-final-report.md`。

未执行线上频道、真实 Release、Ubuntu/Node LTS、签名或安装验收；历史 tag 固化的旧 workflow 不会被新提交追溯替换。合成 fixture 的本地 Git 推送不表示已操作线上频道。

### WP00 环境准备与初步检查

- WP07 本地提交已无冲突 cherry-pick；最终组合中的提交为 `d55ab18`。已检查其 manifest/config/回归测试 diff、lock/包范围与 diff whitespace，Standards / Spec 暂无新增发现。
- 原卷剩余约 4.3 GiB。依赖和未变更 Office dist 从 WP07 已完成的安装/构建经 APFS `cp -cR` 克隆至 WP00 自己的 ignored 目录，无共享可写依赖、无重装其他工作区。WP00 不声称独立 clean install 或重新构建 Office 引擎。
- Office dist 与生成的 PPTX 类型来源逐字节核验，共 390 个文件；SHA-256 汇总保存在本地证据 `environment-reuse.json`。同目录保留 `shared-file-snapshot.json`。
- WP00 的组合验证使用此准备环境，未启动应用/窗口。没有重跑全库前端测试。

### 六包组合验证（WP01/02/05/07/08/10）

代码树基于 `19379b3`，包含 WP00 的 `5e08db1` 生命周期修正；环境为 WP07 固定依赖的独立 APFS 克隆。

| 检查 | 结果 |
|---|---|
| changed tests + Todo/Tag 完整目录 + RichText/RecordListItem 受影响测试，`vitest run ... --maxWorkers=1` | 首次 43 文件 / 830 用例：40 文件通过，3 文件共 146 失败。精确命令与 head 记录于 `combined-frontend-command.json`，日志 `combined-frontend-tests.log`。 |
| 失败诊断 | 144 个 RichEditor 用例缺少 WP01 标签读取新增的 QueryClient 上下文；另两个 Record 页面断言未包含 WP02 enqueue 的 binding 参数。生产类型检查通过，未通过放宽产品门禁解决。 |
| 定向复验 | RichEditor 加真实 QueryClientProvider；两个页面精确断言 `fixture-workspace/open-1`。仅重跑这 3 文件，252/252 通过，日志 `combined-frontend-retest.log`。其余 40 文件的 578 项仍有效，合计 830 个不同用例通过。 |
| `tsc --noEmit` | exit 0，`combined-types.log`；后续仅测试 fixture 与本报告变更，生产源码不变，复用该结果。 |
| `vite build` | exit 0，2.27 秒，`combined-host-build.log`；使用已校验的未变更 Office 产物，保留既有大 chunk 提示，不等于重建 Office 引擎或安装包。 |
| `npm run check:bundle-boundaries` | exit 0，宿主入口 249 KiB / 250 KiB，图像标注、文件编辑器和设置保持 lazy，`combined-bundle-boundaries.log`。 |

这包括真实 TodoModuleRail → Todo Module 的 WP01/WP05 组合、AI Module/消费者、shared transport、App、目录和 Beta 脚本的交叉验证；不是 GUI、多窗口、Provider、原生二进制或发布验收。没有为测试修改原生/生产行为。

### 七包原生组合验证（接入 WP03 后）

WP03 源提交与组合 `0219957` 的 patch ID 一致，schema42 和 DB/FS 恢复代码未作二次修改。其受影响保存/恢复、真实 kill、真实 Record worker 和生产编译结果继续复用。WP03 没有前端 DTO/命令/事件改动，上述 830 项前端结果仍有效。

用 WP03 已稳定的干净 Cargo target 经 APFS 克隆建立 WP00 独立 target，使用同版本只读 Sherpa 静态库；未修改责任组缓存或原 checkout，也不声称从空缓存构建。

```sh
SHERPA_ONNX_LIB_DIR="$SHERPA_LIBRARY_DIR" \
CARGO_TARGET_DIR="$WP00_NATIVE_TARGET" \
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 TMPDIR="$BUILD_TMPDIR" \
cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j2 -- \
  --test-threads=1 ai_jobs::tests todo_workspace_binding_tests
```

- 首次组合编译失败：WP01 的测试 runtime fixture 未适配 WP02 的必需 AI manager binding 参数，日志 `combined-native-compile-red.log`。
- 修正 fixture 让 runtime 与 manager 复用同一个 binding，不改变生产逻辑或测试断言；同一命令重跑 **7 passed、0 failed、0 ignored**（1884 filtered），日志 `combined-native-tests.log`。4 项真实 AI manager 受控 worker 测试与 3 项真实 SQLite/storage 绑定测试来自完整 crate 测试二进制，补齐 WP02 worker 原先仅 harness 的运行证据。
- 没有把 1 项 AI 命令 binding harness 算作此次原生 7 项；它仍未通过真实 Tauri IPC 验收。未运行 GUI、全量原生套件或真实 Provider。

### 八包原生组合验证（接入 WP04 后）

接入代码树 `e433a27`；新保存/恢复逻辑与 WP03 根恢复、隔离 working journal 保护有交集，因此在 WP00 独立 target 上定向运行：

```sh
SHERPA_ONNX_LIB_DIR="$SHERPA_LIBRARY_DIR" \
CARGO_TARGET_DIR="$WP00_NATIVE_TARGET" \
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 TMPDIR="$BUILD_TMPDIR" \
cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j2 -- \
  --test-threads=1 db::file_working::tests db::project_root_rename_
```

结果 **41 passed、0 failed、3 ignored**（1857 filtered），22.11 秒，日志 `wp04-combined-native-tests.log`。3 项 ignored 是 working/root 两项由父测试显式调用的崩溃子进程 helper，以及需要固定 runtime 的真实 Record worker；均不计本次通过，Record worker 仍复用 WP03 明确执行的既有证据。

AI/Todo 绑定源码、前端源码/依赖和现有 Office 产物未变化，复用前述 7 项原生绑定/worker、830 项前端、类型、宿主构建与包体检查；Office 服务实测复用 WP04 自己从同一源码构建的证据。没有重复全库验证，也不把注入 EXDEV 当作真实第二卷。

### 十包最终组合验证

在 `80371ef`（全部十包接入）上进行实际组合检查；native 使用既有 WP00 私有 target，未启动应用窗口。新增 CSS token 后重建宿主以核对组合产物；生产 TS/DTO、依赖及其他前端逻辑未变，830 项与类型检查仍有效。

| 检查 | 实际结果 / 证据 |
|---|---|
| `TZ=UTC cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j2 voice_minutes_ -- --test-threads=1`（相同 Sherpa/target 环境） | 7 passed、0 failed、0 ignored，21.35s；`ten-package-voice-tests.log`。包含真实 DB 事务和本地 HTTP fixture，不是真实 Provider。WP06 其余集中范围与三时区结果复用。 |
| `node node_modules/vitest/vitest.mjs run --config scripts/rules.vitest.config.mjs --maxWorkers=1` | 58/58；`ten-package-rules-tests.log`。 |
| `node scripts/check-ui-standards.mjs` | 通过；`ten-package-ui-standards.log`。 |
| `node scripts/check-portable-paths.mjs` | 首次组合失败，6 份本轮新增报告中 34 条含机器路径；原始 `ten-package-portable-red.log`。仅将这些新增报告的本地位置改为占位符和显式命令变量后通过，`ten-package-portable-green.log`。 |
| `vite build` | 通过，2.29s；`ten-package-host-build.log`。保留既有大 chunk 提示，使用已核对 Office 产物，不声称重建 Office 引擎/安装包。 |
| `npm run check:bundle-boundaries` | 通过；`ten-package-bundle-boundaries.log`。 |
| 组合树非 `cfg(test)` 原生 `cargo check --lib --quiet -j2` | exit 0；`ten-package-production-native-check.log`。 |
| source/cherry-pick patch 对照、共享文件与文档链接/diff | 10/10 patch ID 相同，接收提交均是组合 HEAD 祖先；共享交集仅 WP01/02 的 lib.rs/API/测试和 WP03/06 的 db.rs。16 份变更 Markdown 中 76 个本地链接目标存在，diff 空白通过；`received-patch-integrity.json`、`ten-package-shared-file-audit.json`、`ten-package-document-links.json`、`portable-report-normalization.json`。 |

6 份报告原文在外部证据的 `portable-original-reports/` 与原源提交中保留；位置占位化没有改写失败、通过或未执行结论。未修改历史记录、pinned vendor、路径/动效检查或例外表来制造全绿。最终本机完整命令、位置、commit 与结果保存在外部 `handoff.json`，不把机器路径带入仓库说明。

## Standards / Spec 整合检查

WP00 自行核对十包源提交与组合提交的 patch ID、共享文件 hunk、工作区绑定、异步失效窗口、物理 worker 预算、schema/恢复顺序、精确资源来源、working journal 新旧布局、Todo 规范确认、Voice UTC 标题、路径索引语义、工程规则及 Beta CAS。未启动 review 子 agent。十包 cherry-pick 无需人工冲突取舍；后续仅为本轮报告补位置占位化与整合台账，不改变各包生产修复。

整合时修复三类实际问题：`5e08db1` 的 ready/reset enqueue 窗口；`521b364` 的 QueryClient 和消费者 binding 测试适配；原生 fixture 的 manager binding 参数适配。新增行为均有失败或编译失败证据及定向通过结果，没有放宽产品门禁。

当前十包的 19 个原始发现均已接收代码/文档修复，所需受影响组合检查已完成或复用有效证据，未发现新增代码层面阻塞。已有原生错误分类失败、真实第二卷与其他平台产品验收仍保留；代码整合完成不等于所有产品验收通过。用户后续明确授权保留这些缺口合入 develop，本次不关闭父 Issue、不部署或发布。

## 工具限制与待决定项

- 官方 send_message_to_thread 对 WP01、WP02、WP05 的三条最小协调消息均返回 `MCP tool call requires approval, but approval policy is never`，消息未发送。未重试、未换通道；本清单保留待衔接契约，原协调会话可读取。
- 只读 wait_threads/read_thread 可用；只用官方接口跟踪，不读取 Codex 会话文件。
- 本轮用户未授权 review 子 agent；Standards / Spec 由 WP00 自行检查。
- 不把原有 Windows、真实跨卷、多窗口、Office 性能、签名/安装验收缺口推定为通过；它们仍是独立门槛。
- 用户已明确授权合并 develop 与推送；此授权取代最初本地限制，未授权额外部署或发布。

## develop 合并与推送记录

- 目标仓库核实为 `xuchen-cloud/project_mind`。初次 fetch 的 TLS 连接失败，无远端写入；使用 HTTP/1.1 重试 fetch 成功。GitHub API 与 fetch 均核实当前远端 develop 为固定基线 `ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`，当时无额外提交需要取舍。
- 按 `docs/agents/publish-flow.md` 的实现分支 → PR → 合入 develop 流程执行。没有本轮专门集成 Issue；既有 #62/#304/#94/#118/#187 等仍含更大范围或平台缺口，PR 只引用，不使用 `Closes` 误关。
- 推送已审查的 `9de0349a08b2e3d3b70fb5942361dc01e70ec959` 时，GitHub 明确拒绝更新整合分支：`refusing to allow an OAuth App to create or update workflow .github/workflows/publish-beta.yml without workflow scope`。命令退出 1，日志 `push-rejected.log`；没有创建 PR 或执行合并。
- 该拒绝是当前 OAuth App 缺少 `workflow` scope，不是本地测试失败。停止远端写入，未切换凭据、改写/剔除 workflow 提交、强推或重复尝试来绕过拒绝。
- 拒绝后 `git ls-remote` 复核成功：远端 develop 仍是 `ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`，目标整合分支不存在；推送未创建目标 ref，尚未合入 develop。
- 用户要求复核此前推送方式后，通过官方会话记录确认上次 PR #316 使用普通 HTTPS `git push origin codex/review-combined` 成功，再用 `gh pr merge 316 --merge --match-head-commit ac8126b0c3d6083c1bf06204fdf93841c12ad6f8` 合并。该 PR 相对其 develop 父提交没有 workflow 文件改动；本轮 WP10 修改了 `publish-beta.yml`。当前 GitHub helper 使用 gh，`gh auth status` 实际 scopes 为 gist/read:org/repo，确实不含 workflow；此前普通推送成功不表示具备写 workflow 的授权。比较证据见外部 `previous-push-comparison.json`，没有记录 token 值，也没有重试远端写入。
- 解锁条件：当前获准的 Git 凭据得到 workflow scope，或用户明确提供具备相应权限的凭据。恢复时先核对远端分支状态与 develop 最新 SHA，再按正常 push/PR/merge 流程执行；仍不部署或发布。远端复核结果和完整交接证据保存在外部 `handoff.json`。

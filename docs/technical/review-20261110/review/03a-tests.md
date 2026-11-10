# Phase 3A：高风险行为测试审查

## 范围与结论

基线为 `fe9fe9c188f05c23bae369074446e38c0859a0c8`，同时只读检查当前工作区已有测试。已读取 `AGENTS.md`、`00-scope.md`、`01-quality-architecture.md`、`02-security-performance.md` 和 full-review 上游 Phase 3A。用户已明确批准 checkpoint；本报告是有界 sidecar，不推进其他阶段、不更新 state、不委派。关联 Issue：本轮用户直接审查，无新增 Issue。唯一交付为本文件；未修改源码、构建、启动 GUI 或执行测试。以下“已有测试”指阅读其实现，**不表示本阶段运行通过**；先前实验结果注明出处。

现有测试有实质价值：真实文件/SQLite 的 CAS、幂等、恢复、权限，以及真实 OOXML 的重复保存与未修改条目保真均有覆盖。主要缺口是这些局部保障与真实入口之间的组合：捕获前卸载、异步 hydration、失败队首恢复，以及多连接/多锁操作。不能用测试数量或覆盖率概括可靠性。

F1–F6、N1–N4、PERF1–4 沿用前两阶段优先级，共 14 项；下表是其覆盖映射，不新增 14 个“缺少测试”缺陷。P1 对应 High、P2 对应 Medium。唯一单列的是已确认的测试观察器缺陷（Medium），不得计为新的产品性能瓶颈。Windows 和未加载内容验收属于证据缺口，不另抬高产品严重度。

缩放、mention、文件树等正在修改的独立包不在本报告完成性判断内；不根据其 dirty diff 宣布通过或失败。

## F1–F6：已有覆盖与最小回归

| ID / 原优先级 | 实际测试与能证明的范围 | 漏掉的路径与最小有用测试 |
|---|---|---|
| F1 / P1 | `src/components/document/ProjectFileMarkdown.test.tsx:78` 覆盖隐藏 tab 的关闭保存；`:123` 覆盖版本菜单保存失败保留草稿。使用实际 File 组件/会话，native API 和 Markdown 输入替身。`ProjectFileOffice.test.tsx` 覆盖 working 保存回执和编辑期间状态，不等于真实 Office 输入。 | 菜单事件不覆盖外部固定版本引用引起的 `versionNumber` prop 变化。将 `evidence/frontend-probes/file-version.test.tsx` 转为正式期望：编辑→rerender 历史版本；保存 pending 时编辑器仍保留，成功才切换，reject 则保留原草稿与会话。先在 Markdown 组件完成两分支；Office 另补真实 active-cell/IME 捕获，用同一上层入口，无需全 App 才能复现。 |
| F2 / P1 | `src/hooks/useCanonicalRecordEditor.test.tsx:33` 覆盖 ready 后 acknowledged save 推进基线；`:73` 覆盖更换身份后的旧读取；`:120` 覆盖 foreign head 与编辑竞争。`editorRegister` 默认立即 resolve。Focus 测试中“pending snapshot 优先于 stale Query”也仅保护 pending 尚存的情况。 | 用两个 deferred Promise 固定顺序：get(A,N)→register pending→保存 B 完成(N+1)→register resolve。实际 hook/coordinator 必须提供一致的正文 B、metadata 与 N+1，不能只断言 revision。再各加一个 Project/Workspace Focus hydration 用例，断言下一次提交仍为 B；不用增加随机 sleep 或重复全量测试。 |
| F3 / P1 | `src/components/home/HomeQuickNote.test.tsx:6` 注入 `renderEditor` controller，`save()` 始终执行 onSave，覆盖转存失败保留；`src/lib/quick-note-transfer.test.ts` 覆盖串行转存、丢回执重放等。该 controller 不模拟真实 RichEditor readOnly 后 save 直接返回。 | 复用 `evidence/frontend-probes/quick-note.test.tsx` 的实际 RichEditor：普通 persist 失败→隐藏/readOnly→`flushQuickNotes()` 应 reject，草稿仍可取回；解除失败后同一生命周期 flush 重试成功。Project/Workspace 身份参数化即可；转存失败不能代替普通草稿失败。 |
| F4 / P1 | HomeQuickNote 展开/收起测试验证 DOM/editor 身份保留；Record/File close guards 验证各自保存。这些均不证明 Overview QuickNote 已进入 Project 关闭或 LRU 卸载协议。先前 probe 只复现 blur→立即 unmount 后 persist 未调用。 | 先在实际 Project 关闭协调入口连接真实 QuickNote/controller：输入后立即关闭，deferred save 未完成不得卸载，reject 保留 Project 与正文。另以六个 Overview 触发既有五项驻留上限：有失败草稿的被淘汰项须保留或可靠移交可恢复 snapshot。组件 unmount probe 保留，但不能标为整机退出验收。 |
| F5 / P2 | `src/lib/record-save-coordinator.test.ts:70` 已证明按 key flush 不受另一 Record 失败影响。`WorkspaceRecordFocusPage.test.tsx:518` 的同名场景实际调用 `prepareWorkspaceContentClose()`，断言 key 为 `workspace:7`。 | 错在该页普通 `handleSave` 调用无 key flush，而非 coordinator 隔离实现。最小增量：A 失败，B 正常，经 B 编辑器 onSave/手动保存入口提交；B 成功、A snapshot/error 保留、全局 flush 仍拒绝。无需重复测试已经成立的 keyed close guard。F5 当前仍是调用链确认，不宣称已有独立运行复现。 |
| F6 / P2 | `record-save-coordinator.test.ts:214` 覆盖可重试错误保持顺序；`:264` 断言 permanent failure 不重试；`:49` 覆盖 discard 删除冲突及后继。现有断言能保护“不得盲重试”，却不覆盖修正内容重新提交。 | `evidence/frontend-probes/nonretryable-head.test.mts` 已证明 A 明确校验拒绝后 B 永不到 adapter。最小正式回归：保留 A 未提交证据，修正 B，B 以新请求实际持久化，pending/failed 清零，另一 Record 不受影响；再补一个真实恢复入口可达性测试。未知提交结果/丢回执仍走原幂等规则，不能为了跑绿无差别跳过 non-retryable 任务。 |

F1/F2/F3/F4/F6 的留存 probe 是**确认错误现状的测试**，其通过意味着复现成功，不是修复通过。迁入正式套件时要改成正确行为断言，并保留原始 probe/log 作为历史证据；F2 probe 当前直接证明 hook 的旧正文/新基线组合，后续 native 覆盖的可能性来自调用链，而非 probe 已执行真实落盘。

示例仅描述 F2 最小新增时序，不是可直接运行的仓库补丁：

```ts
// 真实 hook + coordinator；仅 IPC 注册和 persist Promise 可控。
getHead.resolve({ document: A, revision: N });
await registrationStarted;
persistB.resolve({ headRevision: N + 1 });
await saveBSettled;
register.resolve();
await editorReady;
expect(hydratedDocument()).toEqual(B);
expect(capture(hydratedDocument()).baseRevision).toBe(N + 1);
await saveFromFocusEditor();
expect(lastPersistedDocument()).toEqual(B);
```

## N1–N4：真实持久化覆盖及平台边界

| ID / 原优先级 | 实际测试、probe 与证据限制 | 最小新增复现/验收范围 |
|---|---|---|
| N1 / P1 | `src-tauri/src/workspace_commit_fence.rs:56` 验证已进入 commit 完成前 close 等待、失效后拒绝新进入，仅有 fence。`evidence/native-probes/fence_probe.rs` 导入生产 fence，以 Mutex 替代 File lease；200ms 等待 writer 排队、1s 无完成，最后无论阻塞或取得进展都退出 0。它是锁级诊断，不是跨平台自动回归，也未证明实际 fs2 lease 三方集成。 | 用真实 File lease、working 操作、版本恢复/提交、workspace close/switch 安排三方 barrier。先证明各自持有哪些锁，再放行，断言有界完成和关闭后拒绝旧 generation。潜在死锁用可终止子进程包围，失败输出锁阶段；不要将 200ms sleep 当作 writer 已排队的确定证明。按平台分别运行，不把 macOS RwLock 调度推成 Windows 事实。 |
| N2 / P1 | `src-tauri/src/db/file_working_tests.rs:177` 真实 DB/文件验证 CAS、幂等、外部改变拒绝且原件保留；`:396` 验证 recovery copy；`:461` SIGKILL 覆盖 journal 四个崩溃阶段及重开，属于有效真实恢复测试。它们不含 journal 存续期间外部冲突，再操作第二个无关文件的组合。N2 当前为静态错误传播确认。 | 两文件 A/B 的临时 workspace：在 A journal 持久化后、replace 前停住；外部替换 A 后继续，随后操作 B 并重开 Database/workspace。当前缺陷复现应记录 A 冲突如何传播到 B/启动；修复验收要求保留 A 原件及恢复信息、B 可用、workspace 可开。复用现有 crash hook/fixture，新增一个精确故障点即可，无需全 Office GUI。 |
| N3 / P2 | `src-tauri/src/db/project_directory_files_tests.rs:1686` 已有同字节原子替换测试，检查 resolve ready、hash/version/history path 和 physical identity 更新；**未先创建 working state，也未在替换后 working open**。working 外部改变用例则修改了字节。主审 `evidence/native/same-content-replacement/` 已补真实 native open 失败：同 37,956 字节、inode 变化，4ms 报 reconcile 错误。 | 给现有目录 fixture 增加一次替换前 working open，close/release 后同字节替换→resolve→再次 working open；断言正文/hash/version 不变且会话可打开。再保留“不同字节拒绝旧保存”现有断言，避免放松 CAS。已确认 macOS 实际失败，不再写成“仅推测”或要求重跑同一个证明。 |
| N4 / P2 | `src-tauri/src/db.rs:9128` 的真实 voice lifecycle 用例以 Workspace target、单 Database 连接创建草稿；voice runtime 另有启动/退出生命周期测试，但不能据此推导 Project SELECT→INSERT 与第二连接并发安全。`evidence/native-probes/voice_sql_probe.py` 提取真实 SQL，用最小 schema、两个 Python SQLite 连接复现 DEFERRED 升级约 0.020ms 失败，busy_timeout=5000；非生产 rusqlite、非 Windows。 | 最小为生产 Database 的两个独立连接，同一真实 Project：在 `voice_session_create` SELECT 后受控暂停，普通写连接取得写锁，再放行 INSERT；记录 extended error code，断言修复后按规定成功或明确可恢复失败且不留半草稿。另以 Workspace target 作对照，不能只测它。Windows 点击开始的产品验收须记录目标类型、应用版本、SQLite code 与 capture 是否启动；无环境时保留未验证状态。 |

已有 `working_sessions_keep_native_owner_generation_and_ai_handoff_boundaries`（`file_working_tests.rs:263`）和真实 CAS/外部覆盖测试应复用，它们不是无效 mock；上述缺口并不推翻已覆盖的权限、归属、回执不变量。N1/N2 在前阶段确认为代码机制，仍不能写成完整产品故障注入已通过。

## PERF1–4：局部优化测试没有覆盖宿主首屏屏障

| ID / 原优先级 | 实际覆盖 | 最小有用新增测试 |
|---|---|---|
| PERF1 / P1 | `packages/office-xlsx/tests/engine.test.mjs:34,47` 调用 dist engine，真实 fixture 验证跨 sheet 公式及连续保存、保留原样式/无关 parts；`query.test.mjs` 验证原生计算与源字节不变。`range-indexing-scheduling.test.mjs:8` 从源码提取 `loadedRange`，fake clock/readRange 验证退避和 5s 截止，不运行完整 inspect；当前 `engine.ts:164` 仍遍历全部 sheet/used range 才返回。 | 先在完整 open→first usable view 路径记录 range/sheet 请求与首屏事件，用只有后续 sheet/尾部明显增大的固定 fixture 对照，定位首屏前仍被读取的内容。渐进实现后，用受控尾部延迟证明首屏就绪不依赖不相关 sheet；不能仅断言一次 range 读取变快。跨 sheet 公式依赖必须明确等待/状态，不能把未加载值当空值。 |
| PERF2 / P2 | `packages/office-docx/test/initial-preview.test.mjs` 真正执行 cold inspect，断言无 DOM editor 且 authoring hash 一致；有效消除了这一类预览 DOM 工作。`renderer-host-scheduling.test.mjs:7` 将生产源码去 import 后放入 VM，fake DOM/buildDocBytes/timers 覆盖保存合并、IME、旧回执不清新 dirty；没有跑实际 DOCX 解析或布局。 | 在一个原生 open fixture 中分别计数/打点 host inspect 的解析、renderer 从原件解析和首屏 mount，证实端到端重复工作；修改后才设新的解析工作预算。不要用保存 debounce 用例或 authoring hash 通过声称首屏已渐进。 |
| PERF3 / P2 | `packages/office-pptx/test/initial-layout.test.tsx:10` 使用真实 openPptx/parity session 和带计数 metrics，证明 renderer session 仅访问首页时 lazy layout 有效；随后显式取得所有 slides 并保存。`engine.test.mjs` 另验证真实部件保真。测试未经过 native worker 先生成整套模型，再进入 renderer 的组合。 | 同一两页以上 deck 经生产 worker inspect→renderer，计数两边 open/layout 次数和首屏时已处理 slide 集。保留现有 lazy session 用例；缺的是宿主接入证据，不是再写一个 lazy getter 单测。 |
| PERF4 / P2 | XLSX `frame-requests.test.mjs` 保护替换/dispose 后请求失效；range indexing 测试覆盖 engine native 退避，均不能证明 `renderer-host.ts:45` 小范围访问没有扫描整个已加载表。已读的相关测试未发现针对该全表 filter 的操作量断言。 | 固定小 viewport，在同形状的 1k/100k 行模型上反复移动 viewport，核对相同范围结果及访问 cell/row 数；优先可计数操作量而非脆弱的毫秒断言。单独验证边界、空范围和结果正确性；原生 GUI 测量交主审，不用重跑整个格式矩阵来定位这个同步函数。 |

现有真实引擎测试是重要保真基线，但“保存了没有编辑的 sheet/slide”不等于“保存了从未加载的部分”：PERF1–3 当前宿主已经全量准备，相关用例未创建真正未加载状态。后续渐进包的最小完整性验收应是：**仅首屏加载→两次累计编辑保存→关闭重开→确认两次编辑和未访问尾部都保留**；比较未修改 ZIP entry 解压后内容，包含公式依赖、关系/media，保留 CAS、receipt/crash recovery。此要求针对后续变更，不给尚未实施的渐进设计新增 bug。

## 已确认测试设施缺陷：native observer 漏掉当前协议（Medium）

位置：`scripts/office-performance/native-page.tsx:112–117`。model 只监听 `file_office_inspect/file_office_save`；commit 只监听 `file_office_save/file_text_save`。生产 working open/save 的观测不完整，导致页面已有内容、witness 仍等不到模型。前阶段原始 45s 超时是观察器失败，**不是产品打开耗时**。

`native-acceptance-flow.test.mjs:39` 人工预置 models，并以提取函数/替身验证报告错误不被成功步骤覆盖；这类断言应保留，但绕开了真实命令到 model/receipt 的接线。`native-races.test.mjs:25` 本身明确“does not execute a native scenario”，用合成证据检查验证器拒绝陈旧回调有价值，不能当作真实 native race 执行。

最小修复验证建议：将 observer 的接线用当前 API 的真实响应形状驱动，覆盖 working open 成功/失败、working 保存成功/失败及对应状态/回执语义；再让真实 ProjectFileContent open 经此 observer 产生 witness。保存须匹配当前 working 协议，不能只把新命令名加入旧 receipt 列表就宣称验收成功。先运行这几个脚本测试，再由主审串行执行一个真实 native open/save/reopen fixture 即可。无需为此重复所有引擎保真套件。

保留而不扩大已有原生证据：

- `evidence/measurement-notes.md` 记录仅在生成的 `dist/assets/native-page-kK8ypZjB.js` 临时加入 `file_working_open`；持久化脚本源仍有缺陷，保存 observer 未完成适配。
- `evidence/native/summary.json` 的 DOCX/XLSX/PPTX 首次稳定内容为 **1.725s / 6.151s / 1.859s**，其中 working open **0.917s / 3.886s / 0.791s**。样本保留各自 `over_budget` 状态，不因 observer 曾故障而抹掉后续有效数据，也不称为通过。
- 这些是 macOS arm64、embedded-debug、单次 fixture、未清系统缓存的可见 **ProjectFileContent shell** 测量，不是全应用启动、Windows、release 或 p95；fixture hashes 保存在 manifest。报告配置 `acceptance:false`、`races:false` 的样本不证明保存验收或竞态测试已执行。
- N3 的 native 错误样本保留为当前 working open 的实际复现；不与性能样本的成功 witness 或旧 Windows 报告混用。

## Windows 有效性与复用约束

`src-tauri/src/db/file_working_tests.rs:460` 的 SIGKILL 恢复用例有 `#[cfg(unix)]`，macOS 通过也不会执行 Windows 崩溃语义。仓库并非完全没有 Windows 测试：`project_directory_files_tests.rs:136` 有 `directory_file_windows_external_replacement_with_shared_reader_keeps_history`，但本阶段没有运行记录，它也不是 N3 working-state 衔接或 N4 Project 录音双连接测试。构建 portability / renderer hook 静态测试不能代替 Windows 文件共享、WebView2、capture 与数据库运行证据。

后续 Windows 最小范围为 N4 双连接与点击开始、N3 同字节替换后 working reopen、N1 真实 lease 交错；恢复另需平台可用的进程中断方案。Office 使用同 hash fixture 和可见 release 运行，记录 OS/WebView2、构建、CPU/磁盘及阶段时序。环境缺失时明确未验证，不推断用户现场唯一根因。

其他保留项：`evidence/frontend-probes/block-validation-output.txt` 为 6 通过/1 失败，code language roundtrip 失败不能隐藏，也不能改写成普遍块保存失败。最小跟进为代码语言属性的序列化→重解析 fixture；普通段落/hardBreak 成功和前阶段原生保存观察继续保留。其内容保真意义尚待主审核对，不在这里新增严重度或扩张至全局段距修复。

## 交接与验收顺序

1. 优先把 F1/F2/F3/F4 的已留存错误复现改为正确行为回归；F5 只加普通保存入口，F6 只加明确未提交校验错误的修正重提。受控 Promise 替代随机时序。
2. 原生先复用 N3 已有实际失败；N1/N2/N4 补上述最小生产边界故障注入。每项独立 fixture、有限超时，不重复跑绿代替诊断。
3. 修正持久化 observer 后再解释新的 native 指标；性能包保留全部既有完整保存不变量，增加首屏/尾部时序与未加载内容保存验收。

本阶段没有新的测试执行结果。主审负责必要验证并记录对应 commit/改动范围、命令、平台和结果；依赖、相关代码、配置及环境未变化的既有通过记录可复用。新增 UI 包收口后由其自身验收，不从本报告推导完成结论。

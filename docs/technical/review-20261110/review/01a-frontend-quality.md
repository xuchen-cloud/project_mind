# Phase 1A — frontend editing / save / close quality

基线：`fe9fe9c188f05c23bae369074446e38c0859a0c8`。本次为只读阶段交付；按 `AGENTS.md`、`.full-review/00-scope.md` 与 `full-review/references/code-reviewer.md` 执行，未运行 orchestrator 或派生 agent。没有修改业务源码、启动应用或执行全量构建/测试。用户追加授权 GUI 后仍由主 agent 独占 GUI 验收。

## 结论与证据等级

确认 6 项：4 项可能丢失尚未提交的输入或用旧内容覆盖较新正文，1 项将其他记录的失败误报为当前记录保存失败，1 项使不可重试校验失败后的修正内容无法继续保存。F1–F4 的机制及 F6 的队列阻塞由 `/tmp` 隔离实验确认；F5 与 F6 的 UI 恢复入口判断为直接调用链证据。没有沿用历史审查报告的结论。

| ID | 优先级 | 确认内容 | 证据 |
|---|---|---|---|
| F1 | P1 | 固定版本引用复用现有 File Tab 时绕过保存，销毁 dirty Markdown/Office 编辑现场 | 实际 ProjectFileContent + MarkdownFileContent，mock native/格式输入边界；复现通过 |
| F2 | P1 | Record 初次加载/重载与后台保存竞争，旧正文配上新 revision 后可以覆盖已保存的新正文 | 实际 hook + coordinator，受控 IPC 时序；复现通过 |
| F3 | P1 | 隐藏 QuickNote 的 lifecycle flush 对已有保存失败返回成功 | 实际 HomeQuickNote + RichEditor + transfer session；复现通过 |
| F4 | P1 | 关闭 Project / Overview LRU 淘汰未协调 QuickNote，卸载后失去未捕获/失败的草稿 | 实际 QuickNote 卸载复现 + App/布局关闭调用链 |
| F5 | P2 | Workspace Record 的单条保存等待全局队列，其他 Record 失败导致本条误报保存失败 | 静态调用链确认；未添加独立 UI 实验 |
| F6 | P2 | 不可重试的队首校验失败永久挡住修正后 snapshot，现有 UI 无对应恢复入口 | 纯 coordinator 隔离用例 1/1 通过；UI 静态确认 |

P1 表示应优先修复的内容完整性问题，并非每次操作必现。以下明确区分隔离复现与尚未执行的 native GUI 验收。

## F1 — 外部历史版本选择绕过 File 的保存屏障

**位置**

- 主定位：`src/components/document/ProjectFileContent.tsx:183-186`、`:355-356`。
- 销毁/释放链：同文件 `:187-200`、`:241`、`:447-448`；`MarkdownFileContent.tsx:65-83`。
- 真实入口：`src/hooks/useInternalReferenceNavigation.ts:29-43` → `src/services/projectContentApi.ts:67-71` → `src/state/project-content-store.ts:76-77` → `src/components/project/ProjectContentWorkspace.tsx:51-53`。

**触发与影响**

1. 已有当前内容 File Tab，Markdown/Office 中有尚未自动保存的修改，或上次保存已经失败。
2. 从 Record 等位置点击同一文件的固定历史版本引用。导航调用 `openProjectContent`，以相同文件身份复用 Tab，并把 `view.versionNumber` 设为引用的版本。
3. `ProjectFileContent` 收到新的 `versionNumber`，直接 `setSelection`；`valid` 对新旧版本的限制也会使原编辑器不再渲染。它没有调用 `editorFlush`。
4. 原 FileEditSession 与格式输入状态随编辑器消失；历史读取路径释放原生 working session。回到当前内容只能看到之前真正写入的内容。

这可以在正常 I/O 下丢失最近 1.2 秒自动保存窗口内的输入；保存失败时丢失范围更大。Markdown 与 Office 共用这个上层入口；实验直接覆盖 Markdown，Office GUI 待主 agent 验证。

**已考虑的保护**

版本菜单 `choose()` 在 `:364-366` 确实先 await `editorFlush`；外部打开、刷新、显式关闭也有 flush。该保护只覆盖这些函数，未覆盖上层传入的版本变更。`FileEditSession` 的 CAS、重试与 receipt 只保护已经调用 save 的编辑；本路径根本没有调用 save。历史版本只读不代表当前草稿已保存。

**隔离证据**

`/tmp/project-mind-review-01a/file-version.test.tsx`，1/1 通过。使用实际 `ProjectFileContent`、`MarkdownFileContent`、`FileEditSession`；mock native API 和 Markdown 输入组件。测试先修改，rerender `versionNumber=1`，确认历史只读、`saveText` 调用数为 0、working close 被调用；再切回当前内容，显示原文，草稿不再存在。native API 的保存并没有被设为失败。

**最小修复方向**

统一处理所有版本切换请求：在改变当前已接受的版本/卸载编辑器前捕获并完成 flush，失败保留当前视图与草稿。不能仅在 `useEffect` 增加 await 而让 `valid` 在第一帧就使编辑器消失。可在同一 File Tab 接受新的 view 前执行已注册的版本切换 guard。

**针对性测试 / GUI**

将此实验转为 `ProjectFileMarkdown.test.tsx` 回归：正常保存与保存拒绝两种情况，包含来自 `openProjectContent` 的 version prop 变化。Office 增加同样用例，覆盖 active cell / composition 输入。GUI：临时 workspace 中编辑未保存文件，再点击指向同一文件 vN 的 Record 引用；失败时须留在当前编辑内容。

## F2 — Record 加载等待 editorRegister 时，旧正文与新 revision 脱节

**位置**

- 主定位：`src/hooks/useCanonicalRecordEditor.ts:54-70`。
- revision 更新：同文件 `:78-87`。
- 首次 hydration：`src/components/project/ProjectNoteFocusPage.tsx:274-289`；`src/components/workspace/WorkspaceRecordFocusPage.tsx:230-241`。
- 已完成任务移除：`src/lib/record-save-coordinator.ts:334-355`。

**可确认时序**

1. 同一 coordinator 中存在正在保存的 B 草稿，其 `baseRevision=N`；Record 页面此时重新挂载/初始化（例如退出页面后的后台保存仍未结束，用户重新打开）。
2. `editorGet` 返回旧的正文 A、revision N。hook 从 pending B 取到保存基线，随后 await `registerCanonicalRecordEditor`。
3. 注册 IPC 尚未返回时 B 保存成功。`subscribeSaved` 把 baseline 推进到 N+1，coordinator 删除已保存任务。
4. 注册返回后，hook 仍 `setLoaded(... state)` 为步骤 2 的旧 A。两个 Focus 页面此时再次查询 pending snapshot，已为空，于是从旧 `canonical.state.record` 初始化正文 A。
5. 后续捕获 A 返回的 `baseRevision` 已是 N+1，因此下一次普通保存/离开保存有能力把 B 覆盖为 A。native CAS 不会识别它是陈旧正文，因为提交的 revision 正是当前 revision。

**影响**

后台保存明明成功，新打开页面却回退到旧内容；后续保存把回退写入当前 head。是否能从已留存历史恢复由 native 历史时机决定，本审查不声称历史也被删除。

**已考虑的保护**

同 key / workspace binding 校验只检查身份，不能保证加载正文与 baseline revision 同步。pending snapshot 优先恢复在任务尚未完成时有效；这里任务恰好已经完成。自身 requestId 的事件会被 `ownsRequest` 过滤，因此不能依靠自己的 head-change 通知修正旧 `loaded.state`。Query cache 更新也不是 hydration 的数据源。

**隔离证据**

`/tmp/project-mind-review-01a/record-load-race.test.tsx`，1/1 通过。实际 hook 与 coordinator，仅延迟 `editorRegister` 和保存 adapter 的 Promise。观察到：`ready=true`，pending snapshot 为 null，`state.head.headRevision=4` / 正文为旧空正文，而 `capture(oldDocument).baseRevision=5`；较新草稿已经完成保存。测试直接证明 hook 输出的正文/保存基线不一致；Focus 的采用分支为上述静态调用链。

**最小修复方向**

跨注册 await 后必须协调加载结果与期间的保存回执：保留并采用已确认的新快照，或在 baseline 已推进时重新读取相应 head，直到正文/metadata 与基线一致再允许 hydration。不要把 revision 单独推进而继续公开旧正文，也不要通过降低 CAS 要求解决。

**针对性测试 / GUI**

在两个 Focus 页的测试中让 editorGet 返回 N，注册延迟，期间完成 B 的保存；断言页面加载 B、下一次保存仍为 B。补充 metadata 同时变化与 pending 多条任务情况。GUI 可用临时 native 延迟 fixture 重复“保存中关闭/重新打开”，观察正文与 revision；这是时序用例，普通点击不一定复现。

## F3 — 隐藏 QuickNote 的关闭 flush 吞掉已有保存失败

**位置**

- 主定位：`src/components/home/HomeQuickNote.tsx:84-90`。
- `src/lib/quick-note-transfer.ts:26-37`（`tail` 使用 catch 后的 Promise，`flush` 只 await 这个成功尾部）。
- `src/components/rich-editor/RichEditor.tsx:2458-2464`（readOnly 时 save 直接返回）。
- 隐藏→只读：`ProjectOverviewPage.tsx:565-572`；`WorkspacePage.tsx:493-498`。
- 关闭调用：`src/App.tsx:399-407`、`:1275-1282`。

**触发与影响**

QuickNote 编辑后保存失败，用户切换到另一个内容 Tab / Project，使 Overview 隐藏，再关闭应用或切换 Workspace。`flushQuickNotes` 调用的 flusher 先 `editor.save()`；该编辑器因隐藏而 readOnly，直接完成，不捕获也不重试。接着 `session.flush()` 等待的尾部早已把保存异常吞掉，依然成功。App 继续退出/切 Workspace，唯一的本地未保存草稿随 WebView/页面消失。

**已考虑的保护**

HomeSaveIndicator 的错误状态与 live editor 确实保留草稿；可见状态下显式 save 的 reject 也会阻止关闭。问题在于隐藏页面改变了 `save` 语义，而 session 的错误被用于维持串行链的 catch 消除。blur/window-blur/pagehide 自动保存不能保证修复已有失败；readOnly 时生命周期监听也会移除（`RichEditor.tsx:2349-2392`）。原子 QuickNote→Record 转存不能保护普通 QuickNote 保存失败。

**隔离证据**

`/tmp/project-mind-review-01a/quick-note.test.tsx` 第 1 个用例通过。真实 RichEditor 中输入 `UNSAVED`，persist 明确抛错，随后设为隐藏只读，调用真实 `flushQuickNotes()`：Promise 成功，persist 调用数没有增加，编辑器仍报告 unsaved committed content。没有 native 写入 mock 返回假成功。

**最小修复方向**

将“不可交互/隐藏”与“不能持久化当前草稿”分开。生命周期 flush 必须能捕获并保存隐藏的 committed draft，并把最后一次未恢复的保存失败向上抛出。串行 tail 可继续 catch 保持队列可运行，但 flush 的成功语义不能仅取这个 catch 后尾部；结束时也要核验没有新 dirty 内容。

**针对性测试 / GUI**

真实 RichEditor + HomeQuickNote，覆盖 Project 与 Workspace：保存失败→隐藏→退出应拒绝；故障解除→同一关闭动作应重试并保存。GUI 在临时 fixture 中制造可恢复写入失败，切到 Record 页再关闭，确认窗口保留和草稿可见。

## F4 — Project 关闭与 Overview 淘汰没有 QuickNote 保存/保留协议

**位置**

- 主定位：`src/App.tsx:849-858`。
- `src/components/project/ProjectContentLayoutView.tsx:340-342` 仅调用 Record/File tab guards。
- `src/components/home/HomeQuickNote.tsx:84-90` 的 cleanup 只等待已经提交的 session 尾部，随后注销 flusher。
- `src/components/rich-editor/RichEditor.tsx:2403-2408`、`:2426-2444`（卸载取消尚未执行的 48ms blur save）。
- 淘汰入口：`src/App.tsx:1456-1458`、`:1475-1493`，`src/lib/resident-pages.ts:19-21`。

**触发与影响**

在 Project 首页 QuickNote 输入后迅速关闭 Project Tab；App 只等待 Project 内容 tab guards，Overview 的 QuickNote 不在 guard map 中。没有其他内容时很快 unmount，blur 的延迟保存尚未触发就被 cleanup 清除。HomeQuickNote cleanup 只 flush 已经进入 `session.save` 的任务，未读取当前编辑器。后续 flusher 也被注销。

另一种更宽时序：QuickNote 已保存失败，离开 Project 后再关闭该 Project，或访问足够多 Project 触发五个 Overview 的 LRU 淘汰。失败草稿只存在于将被卸载的 editor，既没有 coordinator snapshot，也没有阻止淘汰的保护。

**已考虑的保护**

Project 的 Record/File guards 确实保护内容 tabs，但不含 Overview。App 的全局 `flushQuickNotes` 只在全局生命周期链中调用，单个 Project 的关闭路径未调用它。120 秒自动保存和 48ms blur 属于机会性提交；不能代替卸载前的 barrier。Overview 驻留上限是有意设计，缺陷是淘汰前未处理草稿，不是上限本身。

**隔离证据**

同一 `/tmp/project-mind-review-01a/quick-note.test.tsx` 第 2 个用例通过：真实 QuickNote/RichEditor 输入后发出 blur，立即 unmount；等 80ms 后全局 flush 成功，persist 从未调用。App/Overview 的实际触发路径由上述源码确认。没有将此组件级实验说成整机退出测试。

**最小修复方向**

Project 关闭要等待本 Project 的 QuickNote 捕获/保存，失败保留 Project。Overview LRU 淘汰需要先持有可恢复的 committed snapshot 并移交持久化所有权，或在草稿/失败未处理时暂缓淘汰。不能把异步保存放进 unmount cleanup 后视为可靠完成，也不要只增加延时。

**针对性测试 / GUI**

App 集成测试：输入 QuickNote，立即关 Project，在受控保存 Promise resolve 前不得卸载；reject 后 Project 与草稿保留。Overview 淘汰测试：第 6 个 Project 激活时，失败的第 1 个 QuickNote 必须仍可恢复。GUI：在临时 fixture 中分别执行快速关闭和失败后 LRU 淘汰。

## F5 — Workspace 单条 Record 保存把其他记录的失败算到自己头上

**位置**

`src/components/workspace/WorkspaceRecordFocusPage.tsx:378-387`，重点 `:382`。对比 Project 的 `ProjectNoteFocusPage.tsx:386-390` 使用 record key；`RecordSaveCoordinator.flush()` 在 `src/lib/record-save-coordinator.ts:233-263` 对全局 error 直接 reject。

**触发与影响**

任意另一个 Project/Workspace Record 已存在失败任务时，当前 Workspace Record B 的 `handleSave` 提交 B 后调用无 key 的 `flush()`。即使 B 自己成功，或者尚在正常运行，B 的保存也会因为 A 的 `lastError` 立即失败，并触发本页“保存失败”。RichEditor 将此次保存状态设为 error，导出前保存等调用也可能失败。

这能产生“当前内容很普通但间歇保存报错”的明确前端机制，依赖另一个 Record 的失败状态；尚无用户现场错误信息证明它就是本次实际症状。此项本身不声称 B 的 native 写入失败或丢失。

**已考虑的保护 / 最小修复**

全局退出/Workspace 切换应该等待全局队列；单条编辑器保存无需借用该门槛。Project 保存和 Workspace 关闭 guard 已按 key 等待，说明可直接将此处改为 `flush(workspaceRecordSaveKey(recordId))`，全局关闭仍保留原来的全局检查。

**针对性测试**

让 A 的 adapter 抛错、B 的 adapter 成功；B 的 handleSave 应成功，A 的 failed task 保留，全局关闭仍拒绝。已有 Workspace 的“flushes only the current record”用例覆盖的是 close guard，不能证明这个 handleSave 路径。

## F6 — 不可重试的队首失败使修正后的内容仍无法保存（补充交付）

**位置**

- 主定位：`src/lib/record-save-coordinator.ts:295-297`；修正后的提交只追加队尾 `:172-192`；显式重试跳过 non-retryable `:218-235`。
- 错误保持：同文件 `:238-247`；原生错误分类传递：`src/lib/record-save-persistence.ts:49-52`。
- UI：`src/App.tsx:1102-1119`；`src/hooks/useCanonicalRecordEditor.ts:137-148`；`ProjectNoteFocusPage.tsx:652-670`、`WorkspaceRecordFocusPage.tsx:560-577`。

**确认的触发、结果与用户影响**

同一 Record 的 snapshot A 被 adapter 以 `RecordSaveFailure({code:"INVALID_PATCH", retryable:false})` 拒绝。用户删减/修正内容，提交新的 B；虽然 `getLatestSnapshot` 正确保存了 B，`runRecord` 仍选中最早的 A，并因其 failed 状态直接返回。B 从未到达 adapter，因而没有机会通过重新校验。调用 `retryFailed(recordKey)` 也不改变结果；两次后续 flush 都继续抛出 A 的原异常。

这使一次内容校验失败变成同一 coordinator 会话内的持续保存阻塞：修正正文、手动保存或重新进入页面都不能通过现有队列继续保存，关闭/切 Workspace 的 flush 也继续失败。新的草稿仍在内存，实验没有证明自动丢失；结束进程会失去该内存保护。该机制能放大最初的 block 保存错误，但尚不能认定用户最初的错误就是文档大小限制。

**为何现有 UI 不能恢复这个场景（静态证据）**

- App 对此状态显示“需要修正后重试”，但只有 `retryableFailedCount > 0` 才显示“重试保存”按钮；即使通过别的 retryable 任务显示该按钮，`retryFailed` 仍跳过 A。
- 仅由 `REVISION_CONFLICT` 的保存错误触发 incoming conflict；这里注入的是 `INVALID_PATCH`，且没有独立外部更新。
- Focus 的 `discard` / “另存 Record”恢复操作挂在 `canonical.incomingConflict` 才出现的 `RecordConflictActions` 内；不会因这次校验错误出现。局部核对 `RecordListItem.tsx:648-663` 也相同。
- “重新加载编辑器”针对 `canonical.error`（加载错误），不是 coordinator 保存错误；重新挂载时仍会读取 coordinator 中最新 pending snapshot，旧失败任务不会被清除。
- `discard()` API 确实存在，但直接丢弃整条队列会连修正后的 B 一起删除，且此场景没有相应用户入口。这里的“无恢复路径”指现有产品内没有保留当前修正草稿并解除此失败队首的操作，不声称用户不能手动复制文本到其他地方。

**纯 coordinator 隔离证据**

文件：`/tmp/project-mind-review-01a/nonretryable-head.test.mts`；日志：`/tmp/project-mind-review-01a/nonretryable-head-output.txt`。

```sh
node --experimental-strip-types --test /tmp/project-mind-review-01a/nonretryable-head.test.mts
```

1/1 通过，0 失败，总耗时约 183ms。只导入实际 coordinator，使用 Node 内置 test/assert；未加载 React、native、GUI 或 validator。A 的正文是 1 MiB 文本，adapter 显式注入不可重试大小校验错误；B 缩为 `fixed`，adapter 若收到 B 会成功。这确认失败之后的队列行为，**不是**对 native 大小校验或 UI 点击流程的端到端复现。

关键日志：

```json
{"persistCalls":["rejected"],"latestDraft":"fixed","phase":"error","pendingCount":2,"failedCount":1,"retryableFailedCount":0,"flushRejectsOriginalFailure":true}
```

**最小修复方向与针对性测试**

为“明确未提交的内容校验拒绝”提供保留最新草稿的修正重提操作：在有证据证明旧请求未提交时，废弃已被修正内容替代的失败尝试，以新 requestId 和有效基线提交最新 B；对应 UI 应提供该入口或使普通修正保存走通。不能无差别跳过所有 non-retryable 失败：该类别还可能包括已经提交但响应不完整等状态，须保留回执/CAS 与歧义重放保护。

将此用例转成正式回归：A 明确校验拒绝→用户修正 B→B 实际到达 adapter 并保存；同时保持另一个 Record 队列不受影响。另加最小 UI 用例确认恢复入口确实可见、成功后 pending/failed 清零。F1–F5 未在本补充中改写或重跑。

## 新增 block 保存故障与段距问题：阶段调查结果

### 已核实的接口与保护

- UI `RecordBodySaveInput` (`src/lib/record-document-types.ts:50-57`) 与 Rust `RecordBodySave` (`src-tauri/src/record_document_service.rs:28-45`) 的 camelCase 字段和 `manual`/`editor_ai` enum 对应；未发现普遍 DTO 字段名错误。
- `recordDocumentApi.bodySave` → `record_body_save` (`src/services/recordDocumentApi.ts:44-46`)；command 在 save 后再次 editor_get (`src-tauri/src/record_document_commands.rs:221-239`)。后者失败可能让已提交保存返回失败；是否有用户现场对应错误交由 native reviewer 继续核查，不能仅据双调用认定存在数据丢失。
- native save 在 conversion 前检查 baseRevision (`record_document_service.rs:744-773`)，请求 `record.validate` (`:777-784`)，再提交。coordinator 逐 Record 串行并推进 queued 的 baseRevision / metadata baseline (`record-save-coordinator.ts:318-331`)；未发现同一正常队列必然自冲突。
- StableRecordBlocks 初始 mount 即分配 ID，后续 docChanged 的 appendTransaction 修正缺失/重复 ID；不是依赖异步 create timer。现有立即保存测试专门覆盖这一点。F2 是加载正文与保存基线不一致，不能笼统归因为“block ID 随机丢失”。
- `/tmp/project-mind-review-01a/block-validation.test.tsx` 使用实际 Tiptap Editor、共享 schema、canonical validator/serializer/parser。普通段落、hard break、空段落、粗体旁图片、列表、表格 6 个 fixture 校验与 roundtrip 通过；这不覆盖所有粘贴、AI preview、图片素材或 native 转换运行时。

### 未证实 / 下一步，不能作为用户实际故障根因

1. **需要现场错误分类。** 收集发生错误时的 error code/message、record key、requestId、baseRevision/headRevision、是否还有其他失败记录、是否来自 QuickNote 转存或图片/引用。目前不能把“经常间歇”直接对应到某个校验错误。F5 是可解释类似现象的确定机制。
2. **不可重试校验失败之后如何纠正。** 补充实验已确认 coordinator 阻塞及 UI 恢复入口缺失，升级为 F6。原始 native 校验错误采用注入，尚未把用户现场错误对应到具体文档或 native 错误码。
3. **代码块语言的转换差异。** 7 个 block fixture 中 code fixture 的 roundtrip 断言失败：浏览器 schema 读到 `language='ts'`，`parseRecordHtml` 回读为 null。`HtmlTreeNode` (`record-document-html.ts:34-53`) 没有 `firstElementChild/classList`，当前 Tiptap `extension-code-block/src/code-block.ts:112-128` 通过这些属性读取 language class。该实验确认转换差异；尚未走实际 legacy 初始化/QuickNote 转存，所以暂列后续内容保真复核，不宣称这是普通 body save 的间歇错误。
4. **AI pending preview 的 committed projection。** `RichEditor.tsx:5675-5691` 在未 dispatch 的 transaction 上回填 original slice；本轮未覆盖复杂 split/join 与多个 AI 修改组合的 ID 不变量。没有可确认失败样本，不报告猜测性 bug。

### 段落 / 行距

- 当前默认正文为 14px、line-height 1.6、段前 12px、段后 0 (`src/styles/app.css:83-87`；`src/lib/richTextStyle.ts:9-16`)。设置通过 `buildRichTextStyleCssVariables` (`:157-178`) 应用，GUI 必须记录实际 computed values，不能只看默认值。
- `.rich-editor__surface` 是 column flex (`app.css:846-856`)，`p` 使用同一个 line-height 和 margin token (`:1797-1802`)。父/子 line-height 声明不是两次行高相加；重复匹配同一 CSS 属性也不会相加。默认段后为 0，不能仅据 flex 无 margin collapse 判定默认值被翻倍。
- 列表内部 `li p` 清零 margin (`:1840-1844`)。表格 wrapper/table 及 blockquote/p 存在各自边距，需要按具体 DOM 检查；未取得用户问题样本，不能把这些嵌套情况当成普通段落的根因。
- 与 canonical 引入前的 `c5ce6a3^` 比较，`src/lib/richTextStyle.ts` 无差异；`app.css` 相关正文行距/段距选择器没有被 block 引入改写。StableRecordBlocks 只增加 `data-block-id`，未发现其新增段落 wrapper 或 block-specific spacing CSS。6 个成功 fixture 的 projection 没有把 hard break 自动改成额外段落。
- 新 canonical 正文保存与旧 `normalizeRichEditorValue` 的边界空段落处理不同：旧兼容 HTML 会 trim 边界空节点 (`src/components/rich-editor/normalize.ts:12-69`)，canonical JSON 保留它们。这可能改变重新打开时的首尾空白；尚不能解释用户称“段间距/行距都变大”，也不能把删空节点当通用修复。

**交主 agent GUI 的具体比较**：在相同 workspace 字体设置下，用两普通段落、单段 hard break、中间空段落、列表、blockquote、表格各一个 fixture；对比编辑器和只读 viewer 的 p 数量、`<br>`、空 p、computed line-height/margin/padding、实际相邻 block rect；如有旧版样本，再比较 legacy HTML 与 canonical projection 的结构。没有这些证据前不更改全局行距 token。

## Office 首屏渐进加载与性能分工

用户已提出首屏渐进加载，允许后续修改 OSS 源码；本轮不实施。观察到 `OfficeFileContent.tsx:52-69` 让模块预载与 native inspect 并行，renderer 挂载仍取决于完整 working model (`:140-150`)；这只是当前流程事实，不是测得的性能瓶颈。

主 agent 已说明性能 harness 只观察 `file_office_inspect/save`、漏掉 `file_working_open`，导致已渲染 Word 的 witness 等待 45 秒假超时。此 45 秒不作为性能缺陷证据；Phase 2 使用修正后的测量边界复核，避免重复启动应用。

## 验证记录

所有新增实验仅写在 `/tmp/project-mind-review-01a/`（macOS canonical path 为 `/private/tmp/project-mind-review-01a/`），导入本仓库实际源文件；native mock 不访问用户 workspace。

执行命令（cwd `/Users/xuchen/project_mind`）：

```sh
./node_modules/.bin/vitest run --config /private/tmp/project-mind-review-01a/vitest.config.mts quick-note.test.tsx --reporter=dot
./node_modules/.bin/vitest run --config /private/tmp/project-mind-review-01a/vitest.config.mts file-version.test.tsx --reporter=dot
./node_modules/.bin/vitest run --config /private/tmp/project-mind-review-01a/vitest.config.mts record-load-race.test.tsx --reporter=dot
./node_modules/.bin/vitest run --config /private/tmp/project-mind-review-01a/vitest.config.mts block-validation.test.tsx --reporter=dot
```

- QuickNote：2/2 通过，约 1.49s；日志 `quick-note-output.txt`。
- File version：1/1 通过，约 2.55s；日志 `file-version-output.txt`。
- Record load race：1/1 通过，约 0.41s；日志 `record-load-race-output.txt`。
- Block validation：6/7 通过，code language roundtrip 1 项失败，约 0.57s；日志 `block-validation-output.txt`。未把该失败隐藏成绿色全通过。
- 初次搭建 `/tmp` harness 有 root/symlink/setup 路径错误及 jsdom 缺少 Range geometry 的错误；前者改为 `/private/tmp` 实路径，后者采用仓库现有 RichEditor 测试的 geometry stubs 后，仅重跑受影响 QuickNote 用例，最终无这些未处理异常。上述通过证据以最终日志为准。
- 这些是“断言缺陷行为确实出现”的审查实验，绿色表示机制复现成功，不代表产品正确。

## 已读范围与未覆盖范围

**逐路径检查的主要文件**

- `src/lib/record-save-coordinator.ts`、`record-save-runtime.tsx`、`record-save-persistence.ts`、`record-focus-save.ts`、`quick-note-transfer.ts`、`canonical-quick-note-transfer.ts`、`file-edit-session.ts`、`project-content-lifecycle.ts`、`deleted-record-close.ts`、`record-editor-registration.ts`、`record-version-restore.ts`。
- `src/hooks/useCanonicalRecordEditor.ts`；`src/components/project/ProjectNoteFocusPage.tsx`、`src/components/workspace/WorkspaceRecordFocusPage.tsx` 的初始化/捕获/保存/关闭/隐藏/冲突接入部分。
- `src/components/record/RecordFocusResidentPages.tsx`、`recordFocusDraft.ts`、`RecordConflictActions.tsx`、`RecordHistoryAction.tsx`、`RecordHistoryDialog.tsx`、`RecordAiMetadataAction.tsx`。
- `src/components/document/MarkdownFileContent.tsx`、`ProjectFileContent.tsx` 的 session/flush/版本/关闭流程；`src/components/office/OfficeFileContent.tsx` 的加载、save、flush、activity、finishEditing 流程。
- `src/components/home/HomeQuickNote.tsx`；`ProjectOverviewPage.tsx`、`WorkspacePage.tsx` 中 QuickNote 接入/持久化；`ProjectContentWorkspace.tsx`、`ProjectContentLayoutView.tsx` 中注册、关闭、overview residency；`src/App.tsx` 的 route save、关闭 Project、Workspace 切换/创建、窗口 lifecycle。
- `src/components/rich-editor/RichEditor.tsx` 的控制器、保存循环、生命周期、controlled reconciliation 与 committed projection；`extensions.ts`、`extensions/StableRecordBlocks.ts`、`normalize.ts`；`src/lib/record-document.ts`、`record-document-format.ts`、`record-document-html.ts`；`src/workers/record-document-worker.ts`；`src/styles/app.css` 与 `src/lib/richTextStyle.ts` 的排版相关规则。
- `src/services/recordDocumentApi.ts`、`desktopApi.ts` lifecycle 部分、`projectContentApi.ts`、`src/hooks/useInternalReferenceNavigation.ts`、`useProjectMutations.ts`、`useResidentProjectShells.ts`、`src/lib/resident-pages.ts` 与 `src/state/project-content-store.ts` 的相关调用。
- 参考检查了对应 coordinator/runtime/hook/Focus/QuickNote/File 现有测试，以及 `docs/cache-strategy.md`、`docs/system-design.md`、`docs/implementation/file-save-sessions.md`、`file-working-content-notes.md` 的保存约束；未宣称已运行这些完整测试文件。
- 因追加请求，仅交叉读取 native `RecordBodySave` DTO、`record_body_save` command 与 `RecordDocumentService::save` 接口路径；持久化/恢复审查仍由另一路负责。

**未完成覆盖 / 限制**

- 没有真实 WebKit/WebView2、IME、OS 退出、休眠或磁盘故障注入证据；本报告提供主 agent 可执行场景。
- 未全面审计 Office OSS 格式 renderer 内部 journal/pending-input 协议、PDF/打印/导出、Voice raw transcript、所有 AI 编辑组合、RecordListItem 的纯展示、RecordConflictDialog 的纯比较布局；这些不是本阶段已验收项。
- 原生 CAS/原子落盘/receipt 的正确性没有用 mock 测试替代；F2 只利用其接口明示的 revision 语义说明后果。
- 未确认用户实际保存失败 error code 与具体文档；未确认段距变化的旧版对照。两者留作下一步定向诊断，不无限扩展本阶段。

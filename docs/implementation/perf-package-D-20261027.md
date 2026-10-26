# 性能修复包 D（2026-10-27）

## 开始条件

- 关联：#124 / #118；审计 R07–R10、E11 及目录树轮询。
- 依赖：现有 File 原生版本分页、业务变更失效、Todo CAS；完整 R07 依赖 Rust / DSH 分叉幂等接口。
- 交付行为：未知分叉结果不盲重放；只高亮 ready 身份；保存失败向版本菜单传播；Todo 不遗失首次项目读取；紧凑版本最多读取近期 50 条；目录树仅可见时读取并响应已有失效。
- 非目标：Office 宿主、语音、Rust、DSH JS、其它包的代码；不提交、不推送、不启动应用或全量测试。
- 验收：针对响应丢失、ready/ambiguous/unavailable、flush 失败/重试、首次项目请求与 Todo 成功/失败、分页及目录可见性建立回归；保留 scroll mask、草稿、权限和 CAS。
- 验证范围：本包组件与 Todo 定向 Vitest，差异检查；主 agent 统一整合验证。

## 跨包接口协调

R07 建议 `forkSession(parentSessionId, projectId, forkSessionId: string) -> childSessionId`，调用方在第一次发送前分配稳定 UUID；原生绑定实际 Workspace / Project / 父身份，DSH 创建或按子 ID 回查，相同请求返回同一子会话，冲突拒绝。当前接口只有 parent，没有此能力，本包先禁止未知结果重放，保留已知子会话打开重试。完整幂等交由主 agent 协调。

E11 新版 `FileVersionMetadata` 不包含本地路径。紧凑菜单应收窄 `onOpenVersion` 为只需 versionNumber，唯一调用方 `src/components/layout/ProjectSidebar.tsx` 应直接调用 `openPreview(document, version.versionNumber)`，删除不可达的 `desktopApi.openFile(version.managedPath)` 后备路径。该文件未在本包独占范围；由主 agent 修改调用方。

## 实施与验证

本包范围内修复与定向回归完成；跨包阻塞见末节，不能视为整体交付。

### 已实现行为

- R07：未知分叉结果的错误操作改为“刷新会话列表”，不再次发出 fork；回查列表后可打开已持久化子会话。已知 child 的打开失败仍只重试打开；已有跨 scope / visibility 取消测试保留。完整稳定子 ID 幂等未在本包交付。
- R08：只有 `resolve.state === ready` 输出树高亮路径；ambiguous / unavailable 即使带旧路径也不高亮；恢复 ready 后重新高亮。
- R09：共用 `choose` 在设置页面错误后继续抛出 flush 异常。Office 与 Markdown 保存失败时保留菜单、草稿、旧版本与原 CAS；Office 成功重试后才关闭菜单。
- R10：Workspace Todo 不取消无关 `projects.all`；真实 QueryClient 首次项目列表请求在创建成功和失败后都能完成。Project Todo 的原有乐观计数/CAS/冲突行为保持。
- E11：紧凑菜单打开后读取 `file_versions_list` 的近期 50 条，使用真实 binding 和 File 归属，旧全量 `document_list_versions` 不再调用。完整历史入口保留；异步打开错误继续传给菜单。回调只需要 versionNumber。
- 目录树：删除每个展开目录 3 秒轮询；复用已有 scope 页面失效和文件导航 revision，只刷新挂载的展开分支；窗口隐藏时禁用查询，失效保留至可见后读取；focus 补查目录变化；整个树仍用原 HomeSidebarList 滚动 mask。

### 修改文件

- `src/components/home/ProjectSidebarSessions.tsx`、`ProjectSidebarSessions.test.tsx`
- `src/components/home/useFocusedProjectContent.ts`、`useFocusedProjectContent.test.tsx`
- `src/components/home/ProjectDirectoryBrowser.tsx`、`ProjectDirectoryBrowser.test.tsx`
- `src/components/document/ProjectFileContent.tsx`、`ProjectFileContent.test.tsx`
- `src/components/document/ProjectFileMarkdown.test.tsx`
- `src/components/document/DocumentSharedComponents.tsx`、新增 `DocumentSharedComponents.test.tsx`
- `src/todo/todo-cache.ts`、`todo-module.test.ts`
- 本记录。没有修改主执行记录、Office 宿主、Rust、DSH 或他人文件。

### 验证（基线 5de9a91 上本包工作区差异）

所有命令静默运行，无应用窗口、无全量测试；通过结果按未变更范围复用。

1. 修改实现前执行四个对应测试文件：
   `npx vitest run src/components/home/useFocusedProjectContent.test.tsx src/components/home/ProjectSidebarSessions.test.tsx src/components/document/ProjectFileContent.test.tsx src/todo/todo-module.test.ts --maxWorkers=1`
   **红：6 failed / 136 passed**。复现旧路径高亮两例、首次项目请求丢失两例、未知 fork 重试入口和 flush 错误菜单消失。
2. 分页/目录树修改实现前：
   `npx vitest run src/components/document/DocumentSharedComponents.test.tsx src/components/home/ProjectDirectoryBrowser.test.tsx --maxWorkers=1`
   **红：4 failed / 7 passed**。旧接口没有近期行；空闲 10 秒由 2 次读涨到 8 次；隐藏首次仍发生读。
3. 实现后上述六文件集中定向执行（相同路径集合）：**152 passed / 1 failed**。唯一失败为新增 Office 成功回执夹具误用了普通 commit 外形；定位到真实 Office 返回 `{model, commit}` 后修正夹具。
4. 修正夹具后只重跑失败项：
   `npx vitest run src/components/document/ProjectFileContent.test.tsx -t 'keeps the failed Office version selection' --maxWorkers=1`
   **1 passed / 78 skipped**。原其余用例通过结果复用。
5. 共享菜单、目录包装和 Markdown 集成范围：
   `npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx src/components/document/ProjectFileMarkdown.test.tsx src/components/document/FileVersionMenu.test.tsx src/components/home/HomeProjectFiles.test.tsx --maxWorkers=1`
   **37 passed**。覆盖新增 Markdown flush 失败与 scope 失效，及既有菜单/scroll-mask/目录包装。
6. 目录树增加 focus 补查后，只复验目录树：
   `npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx --maxWorkers=1`
   **11 passed**。空闲预算、可见性、scope 隔离、focus 补查均通过。
7. `git diff --check -- <本包上述文件>`：**通过**。
8. `npx tsc --noEmit --pretty false`：**未通过，只有 ProjectSidebar.tsx:1127/1129 的两处 managedPath 类型错误**，正是前述唯一调用方需主 agent 整合的接口收窄；本包范围内无类型错误。

### 尚需主 agent 整合 / 解锁

1. **E11 编译协调（必要）**：`src/components/layout/ProjectSidebar.tsx` 的 `onOpenVersion` 改为 `version => { openPreview(document, version.versionNumber); }`，移除读取 `version.managedPath` 的不可达后备。该文件不在独占范围，本包没有修改。收口时复验 TypeScript。
2. **R07 完整幂等（必要）**：按上方 DTO 提供稳定子 ID / 回查。现 UI 已消除盲重放，但不能证明持久化后丢响应、挂载失败及取消后的子会话都可按同一请求精确找回。未将该项标为完整验收。
3. **目录前台空目录变化**：现有持久变更日志通知 File 变化；单独创建/删除空目录不一定产生 File 事件。本包在 focus 后补查，持续前台的即时空目录更新仍需原生 watcher 发布 scope dirty / 目录变更提示。原生接口由主 agent / 包 C 协调；不添加定时轮询兜底。
4. 未实机启动 UI；主 agent 按统一验收安排集中完成。

## 续轮整合（覆盖上节阻塞状态）

用户扩展授权：本包可改 `ProjectSidebar.tsx` 唯一调用方、Rust fork DTO/函数、fork 专用 JS；Rust 生命周期由主 agent 并行修改，不整文件格式化；不调用 Cargo、不提交。A 的 `project-workspace/context/session-inventory/source-bridge/model-utility` 文件没有修改。

### 已完成的跨包接线

1. **E11 已解除编译阻塞**：`ProjectSidebar.tsx` 删除两处历史 `version.managedPath` 读取，唯一回调直接使用原生 File 预览与版本号。
2. **R07 稳定子 ID 与幂等已实现，Rust 验证待集中执行**：
   - UI 在首次 fork 点击时生成 `session-${crypto.randomUUID()}`，错误重试捕获同一个 action；已知子会话仍只重试打开。
   - `DshSessionAction` / Rust `SessionAction::Fork` 必须携带 `childSessionId`，Rust 在 IPC 边界校验子 ID，响应必须返回该 ID。
   - 原生 `scope_session_request` 调用新 `mind/session/fork` 私有路由，附实际 native context；通用 carrier endpoint 权限不扩大。
   - 新增 `scripts/session-fork.mjs`。核对实际 scope、父 ID、持久子 `parentSession` / cwd；已有子会话不重新复制前缀，必要时只重试 flush / workspace attach。同一子 ID 并发请求合并，父或 scope 不符拒绝，真实读取/持久化异常继续报错。
   - 首次创建复用固定版本 DSH `buildForkSeed`、controller 的 preset/model-selection setup 与 Agent factory；默认复制最新完成轮次前缀，不复制新打开的 turn。`ctx.sessions.flush` 成功后再挂载，创建后的 HTTP 取消不撤销已创建子会话；重试仍精确找回该 child。
   - `runtime.mjs` 只增加 import 和注册两行；既有 runtime.integration 中只修改 fork 专用用例。没有修改 A 的文件。
3. **前台空目录 dirty 已与 C 对齐**：
   - C（`01a17907-6eac-7cf1-8a6c-5080f20b4dd0`）提供 `mind:project-directory-dirty`，payload `{binding:{workspaceId,generation},projectId:number|null}`，不附路径。C 保证同 scope watcher 合并，释放 DB/Workspace 锁后发送。
   - D 已订阅；严格隔离 Workspace/generation/Project，订阅先于 binding 读取以保留建立期间提示；同批提示合并，读取串行且不取消已有原生目录读。隐藏时只标脏，返回后读取。卸载注销 listener；失败显示真实错误。
   - 现有业务事件和 focus 补查继续有效；scope 粒度只刷新当前挂载展开目录，不扫描未展开分支。C 原生源码尚待主 agent 集中 Cargo 验证。

### 本轮新增 / 修改文件

- `src/components/layout/ProjectSidebar.tsx`
- `src/services/dshAssistantApi.ts`、`dshAssistantApi.test.ts`
- `src/components/home/ProjectSidebarSessions.tsx`、`ProjectSidebarSessions.test.tsx`
- `src/components/home/ProjectDirectoryBrowser.tsx`、`ProjectDirectoryBrowser.test.tsx`
- `src-tauri/src/dsh_assistant.rs`：只修改 fork enum / 校验 / 返回值 / 路由 / 对应既有测试；未动生命周期字段、launch、stop，未全文件格式化。
- 新增 `packages/dsh-assistant/scripts/session-fork.mjs`、`test/session-fork.test.mjs`
- `packages/dsh-assistant/scripts/runtime.mjs`：两行注册接线。
- `packages/dsh-assistant/test/runtime.integration.mjs`：仅 fork 用例块。
- 本记录；Office 源码本轮保持未改。

### 本轮验证与复用

- 修回调后：`npx vitest run src/components/document/DocumentSharedComponents.test.tsx src/components/home/HomeProjectFiles.test.tsx --maxWorkers=1`：**9 passed**。
- 新 fork UI 用例改实现前：`npx vitest run src/components/home/ProjectSidebarSessions.test.tsx -t 'same stable child identity' --maxWorkers=1`：**1 failed**，真实缺少 childSessionId；新 JS 模块测试先以模块缺失报红。
- `npx vitest run src/components/home/ProjectSidebarSessions.test.tsx src/services/dshAssistantApi.test.ts src/services/projectContentApi.test.ts --maxWorkers=1`：**58 passed**。
- 新 dirty 接线回归修改实现前：`npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx -t 'native directory dirty' --maxWorkers=1`：**1 failed**，没有订阅现成事件。
- 接线后 `npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx --maxWorkers=1`：**12 passed**。包括 binding/scope 隔离、同批两提示只增加一次读、隐藏零读、回到可见补查、卸载清理。
- `node --test packages/dsh-assistant/test/session-fork.test.mjs`：**7 passed**。替身故障注入覆盖持久化后响应未知、attachment / flush 失败、并发重放、跨父/跨scope冲突、真实读错误、创建前取消/创建后取消及完成前缀边界。
- `node --test --test-name-pattern='bounded session fork' packages/dsh-assistant/test/runtime.integration.mjs`：**1 passed**。真实 DSH 子进程、真实持久化与 provider；稳定 ID 重放、子会话继承与独立续写、正常停机重启后的精确找回和唯一列表身份。第一轮只在新加的计数断言使用错误 RPC 参数形状而失败；改用已有私有 scope list 后重跑本项通过。未声称注入了真实网络丢包。
- `node --check packages/dsh-assistant/scripts/session-fork.mjs` 与 `runtime.mjs`：**通过**。
- `npx tsc --noEmit --pretty false`：**通过**（本轮 stable DTO、dirty 接线及唯一回调更新后）。
- 最后前端集成命令与结果见下方补记；无应用窗口、无全量测试、无 Cargo、无 commit。

### 隐藏 Office 编辑器预算：实际通路与建议（仅分析，尚未实施）

**实际通路**

- `App.tsx` 持续挂载已打开 Project 的 resident shell，用 `display:none` / inert 与 `active=false` 隐藏；Workspace 同样保留 resident shell。
- `ProjectContentLayoutView.tsx:458` 根据 active、pane selected tab 和窄屏 focused pane 计算 visible；仍 map 所有 tabs 并调用 renderPage，使用 hidden/inert 隐藏容器。
- `ProjectContentWorkspace.tsx` 的 Page 首次 visible 后设置 visited；随后隐藏仍挂载 FilePage，并传递 visible=false。未访问的隐藏 Tab 不创建 FilePage。
- `ProjectFileContent.tsx` 隐藏时 retainEditorOrHtml 对 Office/Markdown 不区分 clean / dirty 保留 Loaded；valid 允许这些编辑器使用已 abort 的 read signal。Office 宿主没有收到 visible 参数，因此隐藏后仍 mounted。
- `OfficeFileContent.tsx` 的 inspect/session、format component、自动保存 effect、选区服务均无 visible 条件。Word / Excel 在首次 mount 导入并挂载完整 renderer，只有组件卸载才 destroy/dispose；PPT 同样保留 iframe / MessagePort / 主题 MutationObserver。
- `officePreviewCache` 只约束序列化显示 model（最多 4 项 / 16 MiB），不约束每个活着的 OfficeEditSession、模型副本、renderer DOM/iframe 和编辑器内部状态。

**建议实施顺序与不变量**

1. 显式贯通 `visible`：FileContent → OfficeFileContent → Docx/Xlsx/Pptx wrapper → 格式 renderer 的 visibility/suspend 接口。隐藏时停止渲染、布局测量和只为展示的回调；保存、beforeSave、输出与 close guard 仍能显式调用。不能以 `readOnly` 代替隐藏状态，也不把父容器 CSS hidden 当作计算暂停。
2. 宿主给父层报告真实驻留状态：至少包含 journal dirty、pending DOM/IME 输入、save/beforeSave/output 是否在途、是否处于 editing。父层只有当前 ref `editorDirty`，不足以安全判定可回收（会漏在途保存/输出；自动保存后 clean 也可能仍有 renderer undo/history）。
3. 先给**隐藏的纯预览且 clean、无 pending、无在途操作**建立明确预算，建议 clean hidden renderer 数量为 0：先记录格式 scroll/zoom/view，安全销毁整个 Office 宿主或格式 renderer，保留 File 身份/固定版本/Tab，显示时重新验证 binding/head/hash，再从现有有界 model cache 重建。Office 当前没有完整对接 ProjectFileView 的 view capture/restore，必须一起补齐，不能先卸载造成返回后位置丢失。
4. **dirty / pending / editing / 在途实例保持驻留**。尤其 dirty=false 不等于编辑会话可丢弃：已保存后仍可能存在 undo/selection 状态。没有完整 snapshot/restore 的格式不释放 editing 实例。切换隐藏不强制 save、不丢 journal、不吞冲突、不把旧 baseline 更新成新 head；关闭/版本切换仍走原 flush 和 CAS。
5. 如要给 dirty editing 总驻留设硬上限，必须先量化真实多文件内存和格式恢复能力，再制定新编辑器准入行为；不能用 LRU 淘汰未保存编辑器来伪造总量有界。当前建议先交付 clean preview 预算与隐藏调度暂停，并单列 dirty pinned 数量/成本，不把它误称为所有编辑器内存已全局有界。

**后续针对性验收建议**

- 隐藏预览后 renderer destroy/dispose；十次切换后 clean hidden 数量不增长；回到原 Tab 恢复固定版本与 scroll/zoom。
- dirty / IME pending / beforeSave / output 中隐藏不销毁；隐藏后 close guard 仍提交正确旧 CAS，保存冲突保留草稿；取消关闭不丢输入。
- 自动保存完成但仍 editing 的实例不被误回收；同 File 两栏仍保持独立视图。
- 隐藏时 layout/renderer 调度计数停止；显式保存/输出可强制 flush；后续 Workspace generation 变更不复活旧编辑器。

本轮只提交该方案，未改 `OfficeFileContent` 或格式 wrappers，避免与 E 的实现并发冲突，也未先卸载 dirty editor。

### 续轮最终验证补记

- `npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx src/components/home/HomeProjectFiles.test.tsx src/components/home/ProjectSidebarSessions.test.tsx src/services/dshAssistantApi.test.ts src/services/projectContentApi.test.ts --maxWorkers=1`：**5 files / 77 passed**。该命令覆盖本轮前端最终接线；之前通过且未变更的版本菜单回归复用。
- 本轮全部修改文件 `git diff --check`：**通过**。
- Rust fork DTO/函数及对应测试源码已交付；**没有运行 Cargo，不能宣称 Rust 编译/测试通过**。主 agent 需要集中验证 `dsh_assistant` 的 session action transport/serde、scope fork context 注入，以及 C watcher dirty 原生测试。
- Office 实现尚未开始，当前交付为上节的实际通路分析和可执行方案。除该待决方案与集中 Rust 验证外，本轮原先三个 D 接线阻塞已解除。

## 第三轮整合：目录精确失效与隐藏 Office 预算

本节覆盖上文“Office 尚未实施”及目录 scope 失效的旧状态。用户已授权直接实施隐藏预算；C 同时接管 `runtime.mjs` 的 process 生命周期，D 本轮没有再编辑 runtime，也没有调用 Cargo。

### 范围与交付

关联本包原审计与主 agent 的单目录验收补充。依赖 C 的 `mind:project-directory-dirty.relativePaths?: string[]`，缺省为 unknown / full rescan；数组为受影响的**目录**路径，空字符串只指根 branch。C 已确认原生源码就绪，原生测试仍由主 agent 集中执行。

**目录**

- 去掉 ownerPage 任意 invalidate 导致的全树扩散，以及把 navigation revision 加到全部目录 query key 的行为。内容保存不再重列全部展开目录。
- native dirty 按目录路径精确 predicate 失效；同批合并、正在读取时串行补查、隐藏只标脏。空数组无操作；unknown 或合并超过 256 个目录才全 scope。目录删除 / rename 的父目录重列会卸载旧子树，旧 query `gcTime:0`，不用把父目录提示扩散到全部孙目录。
- 对真实 `documents` 前后 `id → managedPath` 差集推导旧、新父目录及必要祖先。导入、移动、rename、删除即时反映；只有版本/title 变化时不重列。保留 focus 时未知路径补查。
- Workspace 导航 tabs 实际是 visited 后 hidden 保留。现补 `MutationObserver` 观察实际祖先 hidden / inert / display / visibility 和 document.visibilityState；初始 disabled，layout 阶段确认可见才查。失效调用也同步检查可见性，避免属性变化到 React 重渲染之间抢读。无新增轮询；scroll mask 保留。

**Office**

- `ProjectFileContent` 将真实 `visible` 传到 Office host。
- 对**已就绪、clean、纯预览、无 pending、无在途保存/输出**设置隐藏 renderer/model 预算为 **0**。捕获轻量视图后卸载格式组件、释放 `OfficeEditSession` / model / saved workbook 引用；保留 File 身份、baseline 和现有最多 4 项 / 16 MiB model cache。显示后复用正常 baseline / binding 校验与缓存重新检查流程。
- React `getSnapshotBeforeUpdate` 在祖先设置 hidden/display 之前捕获坐标；单纯 layout effect 捕获太晚。捕获失败保留实例并显示错误。输出尚在途时先捕获视图，等输出完成后才释放。
- DOCX / PPTX 通过现有 build adapter 注入真实 App 的 zoom、滚动 ref，PPTX 还保存当前 slide 与缩略图滚动；未修改 upstream/vendor 源码。恢复按“导航提交 → zoom → scroll”执行，旧 renderer 销毁后拒绝恢复。
- XLSX 使用固定 Univer facade 捕获 active sheet、zoom、`sheetViewStartRow/Column` 和 `offsetX/Y`，用 `SetScrollOperation` 恢复精确冻结/RTL视口。真实失败继续拒绝，不吞错。
- **editing、dirty、未提交 DOM/IME 输入、beforeSave、save、output 实例保持驻留**。自动保存成功但仍在 editing 的实例也保留 undo/selection；隐藏不强制保存。关闭/切版本仍走原 flush / CAS，冲突保留草稿；Workspace generation 或 baseline 变化不恢复旧视图。隐藏 host 注销活跃选区服务，显式保存通道保持可调用。
- 这不是所有 dirty 编辑器的全局内存硬上限。未测 App 实机 RSS；不能把零 clean hidden renderer 计数称为所有 Office 内存已固定。缺少可恢复视图/就绪失败的实例安全保留并报错。

### 本轮文件（与既有 E 改动共存）

- `src/components/home/ProjectDirectoryBrowser.tsx`、`ProjectDirectoryBrowser.test.tsx`
- `src/components/document/ProjectFileContent.tsx`：只新增 visible 传递，本包上一轮版本错误传播仍保留。
- `src/components/office/OfficeFileContent.tsx`、`OfficeFileContent.test.tsx`
- `src/components/office/DocxEditor.tsx`、`XlsxEditor.tsx`、`PptxEditor.tsx`
- 新增 `src/components/office/useOfficePreview.ts`、`OfficePreviewView.test.tsx`
- 新增 `packages/editor-chrome/preview-view.ts`
- `packages/office-docx/renderer-build.mjs`；没有修改 E 的 `renderer-host.ts`。
- `packages/office-pptx/parity-text-edit-build.mjs`
- `packages/office-xlsx/renderer-host.ts`：仅 import + 安装 preview view 两处；新增 `preview-view.ts`、`tests/preview-view.test.mjs`
- `packages/office-xlsx/tests/renderer-host-deferred-actions.test.mjs`：补现有 selection controller 的 fixture stub，保持原有延迟导入/失败/串行化断言。
- 本记录。`runtime.mjs` 两行 fork 接线已告知 C 保留；D 本轮未再写它。

### 定向失败回归与验证

1. 修改目录精确失效前，`npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx -t 'ordinary owner-page|fifty expanded|committed File paths' --maxWorkers=1`：**3 failed**，分别复现普通 page fanout、50 分支全重列、缺少实际路径差集反馈。修复后目录 13/13 通过。
2. 后续真实祖先隐藏通路先加用例：`... -t 'retained hidden navigation'`：**1 failed**（初始 hidden 仍发读）。补事件式可见性检查后：`npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx src/components/home/HomeProjectFiles.test.tsx --maxWorkers=1`：**2 files / 21 passed**，日志 `$TMPDIR/perf-d-directory-final.log`。50 分支中单 dirty 仅重列 1；隐藏无读，返回仅目标补查。
3. Office 先补 hidden release 用例，改实现前 clean preview 不释放报红。首轮输出用例菜单名夹具写成“文件”，随后改为实际“文件菜单”；不把该夹具错误当行为红例。
4. `npx vitest run src/components/office/OfficeFileContent.test.tsx src/components/office/OfficePreviewView.test.tsx src/components/document/ProjectFileContent.test.tsx src/components/home/ProjectDirectoryBrowser.test.tsx src/components/home/HomeProjectFiles.test.tsx --maxWorkers=1`：**5 files / 142 passed**，`$TMPDIR/perf-d-final-affected.log`。其后只新增/修改目录可见性，用上项 21 通过覆盖，Office/File 结果复用。
   - Office host 40 项，含三个格式 clean 隐藏释放、连续 10 次无 hidden renderer 累计、隐藏前坐标捕获、dirty/pending/CAS草稿保留、保存完成仍 editing pin、输出期间不释放、视图失败保留实例、generation 不恢复旧视图。
   - 共享视图 3 项，验证真实 DOM scroll 与 React zoom/page 时序、销毁后拒绝、缺少 bridge 报错。
   - 包装测试加真实 hidden 父容器后，原“beforeSave 期间切只读”夹具单独 rerender 根类型不一致导致卸载；给该既有用例同样的 div 外壳后只重跑相关 4 项通过，之后上述最终 142 全部通过。没有放宽只读断言。
5. `node --test packages/office-xlsx/tests/preview-view.test.mjs`：**1 passed**。生产 helper + 固定 facade 替身，验证冻结/RTL坐标原样、zoom、active sheet、真实 restore failure 继续拒绝；初次 VM 断言跨 realm 原型不同，normalize 后通过。
6. 格式受影响命令：`node --test packages/office-xlsx/tests/preview-view.test.mjs packages/office-xlsx/tests/frame-requests.test.mjs packages/office-xlsx/tests/presentation-mode.test.mjs packages/office-xlsx/tests/renderer-host-deferred-actions.test.mjs packages/office-docx/test/renderer-host-scheduling.test.mjs`：首轮 **14 passed / 5 failed**。通过项含真实 Chromium/WebKit headless 完整 Excel presentation 切换；不声称该已有用例测试了新 host eviction。失败五项统一为旧 deferred-actions fixture 对生产既有 `createSelectionController` 缺 stub，尚未执行 save/output 断言。补 stub 后只重跑该文件 **5/5 passed**，日志 `$TMPDIR/perf-d-xlsx-deferred-rerun.log`，复用其余 14 通过。无可见应用窗口。
7. 三格式资源编译：`node packages/office-docx/build.mjs`、`node --input-type=module -e "import('./packages/office-xlsx/scripts/build-renderer.mjs').then(module=>module.buildRenderer())"`、`node packages/office-pptx/build-parity-frame.mjs`：**均退出 0**。仅构建包资源，不启动 App。
8. `node --test --test-name-pattern='external renderer manifest' packages/office-xlsx/tests/renderer-resources.test.mjs`：**1 passed**；`node --test packages/office-pptx/test/renderer-resources.test.mjs`：**1 passed**，确认完整资源/字体一致。
9. `npx tsc --noEmit --pretty false`：**通过**（祖先可见性最终代码之后，日志 `$TMPDIR/perf-d-final-tsc.log`）。React 19 新 ref 缺初始化已修成 `useRef<unknown>(undefined)`，主 agent 无需覆盖 WIP。
10. 本轮源码 `git diff --check`：**通过**。无 Cargo / commit / push / 新 agent / App 窗口 / 全量测试。

### 余下集中验收

- R07 native 稳定 childSessionId 及 C 的 precise dirty 路由由主 agent 集中 Cargo 验证；D 不占并行编译。
- 本轮新增 preview eviction 的 React/桥接/资源验证已完成；实机大文件跨 tab 隐藏与回收 RSS、dirty pinned 上限策略仍需真实测量，未虚报。
- 若需验证三个格式完整 App 中的隐藏后 scroll/zoom 恢复，由主 agent 集中安排 UI 验收；当前无需为此启动窗口。

## 第四轮验收：固定 Node 24 的真实 R07 路由

主 agent 明确授权在 B 浮窗源码稳定后执行一次根前端完整单元测试，`maxWorkers=2`；不重新构建 Office，不运行 Cargo，不启动 UI，不提交。本轮是实现/验收，没有启动 review。

### R07 真实接入证据补齐

- 原 `packages/dsh-assistant/test/runtime.integration.mjs` 的 `bounded session fork preserves completed history and independent durable continuation` 已经真实启动 runtime 子进程、HTTP RPC / mux、pinned DSH Session 与磁盘持久化，覆盖 stable child 重放及停机重启恢复；不是 controller fixture。但此前没有真实跨父 lineage 冲突断言，执行 Node 版本也未在该用例明确断言。
- 本轮只扩展该 fork 用例块；已向 C 通知共享文件块范围并请求避开，未改其余 runtime integration 用例或 helpers、A 的业务源码、C 的 process runtime 接线。
- 用例要求 Node 主版本 24，读取实际安装的 `@deepseek-ai/dsh-base/package.json` 确认 `0.2.0-rc.2`，检查真实子进程继承测试 runner 的 `process.execPath`。
- 首次向真实 `mind/session/fork` 路由发送请求，取得 HTTP 响应后**丢弃响应体**，随后只用原 `childSessionId` 重试找回；不把它描述为随机网络故障注入。
- 保留完成前缀、独立父/子续写、三次 provider 请求的断言。停止并重启实际 runtime 后，恢复固定 child、核对唯一列表身份与原历史。
- 重启后创建另一个真实父 Session，尝试用其复用原 child ID；断言明确拒绝 `Child identity belongs to another fork`，原父请求仍可精确重放，列表中该 child 仍只有一条，已完成历史和 lineage 未变，重试/冲突没有额外 provider 调用。

验证命令：

```sh
src-tauri/resources/agent-host/node --version
src-tauri/resources/agent-host/node --test --test-name-pattern='bounded session fork' packages/dsh-assistant/test/runtime.integration.mjs
```

结果：**v24.21.0；1 test / 1 passed**（用例 1.970 秒，总计约 2.052 秒）。日志 `$TMPDIR/perf-D-fork-fixed-node24.log`。`git diff --check -- packages/dsh-assistant/test/runtime.integration.mjs` 通过。

### 根前端验收进行中

- 已按主 agent “B79 / G1 33 通过且源码稳定”的确认启动唯一一轮 `npm run test:unit -- --maxWorkers=2`，日志 `$TMPDIR/perf-D-root-unit-full.log`；不反复全量。
- `npx tsc --noEmit --pretty false`：**通过**，日志 `$TMPDIR/perf-D-root-tsc.log`。
- 完整单元结果及失败归因在下一节补记；若失败，只定向重跑失败/受影响范围。D 仅修拥有范围，其它交主 agent 分配。

### 第四轮根前端完整结果与定向修复

完整命令只运行一次：`npm run test:unit -- --maxWorkers=2`，`$TMPDIR/perf-D-root-unit-full.log`。结果 **249 files：232 passed / 17 failed；2151 tests：2146 passed / 5 failed**，约 100.13 秒。没有以反复全量代替定位。

**D 范围的 4 个失败已修复**：

1. `EditorLoadingState.test.tsx` 两项：新 `useOfficePreview` 对没有请求预览回收能力的独立格式 wrapper 也读取 iframe bridge，提前设置错误，随后真实 ready promise 更替时 loading overlay 被 error 阻止。生产 hook 现仅在调用方给 `registerPreview` 或初始恢复坐标时读取 bridge；新增独立消费者不需要 eviction bridge 的回归。需要 bridge 但缺失仍报错，未吞掉真实失败。
2. `ProjectFileLoading.test.tsx` 一项：夹具仍 mock 旧 `dist/editor.mjs`，实际 wrapper 已使用 `dist/full-editor.mjs`，所以 mock mount 调用为 0。改为真实当前入口，并补 iframe 轻量 view API；保留 resolve → parse → canvas 单 loading owner、ready 后刷新保留正文断言。
3. `ProjectSidebar.test.tsx` 一项：既有版本选择夹具仍设置 legacy `documentListVersions`；新菜单走原生 `versionsList(...limit:50)`。更新 binding/list 夹具并断言原生限量调用、旧 API 未调用；保留选旧版本且不同时打开最新版的断言。

定向验证：

```sh
npx vitest run src/components/office/EditorLoadingState.test.tsx src/components/office/OfficePreviewView.test.tsx src/components/office/OfficeFileContent.test.tsx src/components/document/ProjectFileLoading.test.tsx src/components/layout/ProjectSidebar.test.tsx --maxWorkers=2
```

**5 files / 68 passed**，约 2.30 秒，`$TMPDIR/perf-D-full-owned-fixes.log`。

修改后 `npx tsc --noEmit --pretty false` **通过**（`$TMPDIR/perf-D-root-tsc-after-fixes.log`），本轮 owned diff 检查通过。本次新增修改文件：`useOfficePreview.ts`、`OfficePreviewView.test.tsx`、`ProjectFileLoading.test.tsx`、`ProjectSidebar.test.tsx`，以及上述 fork 用例和本记录；未改根配置、WorkspacePage 或其它包源码。

**交主 agent 分配的剩余两类失败**：

- 13 个 `scripts/**/*.test.mjs` 使用 Node test runner / file URL API，却被根 Vitest/jsdom 收入。9 个报 `No test suite found`，另 4 个为 URL/filename scheme 环境错误。这是根 runner 入口隔离问题；D 未修改 `vite.config.ts` 或脚本源文件。
  - `scripts/office-distribution.test.mjs`
  - `scripts/office-renderer-resources.test.mjs`
  - `scripts/office-performance/{app-workspace-race,fixtures,native-acceptance-flow,native-canvas-proof,native-history,native-pptx-mutation,native-races,native-visual-proof,server}.test.mjs`
  - `scripts/office-performance/evidence/acceptance-summary.test.mjs`
  - `scripts/office-selection/provider.test.mjs`
- `src/components/workspace/WorkspacePage.test.tsx` 的 `creates a Project Todo only after the user explicitly selects its Project`：全量中 `todoCreate` **0 次**，不是 DTO 参数不符。只跑失败项 **1 passed / 21 skipped**（`$TMPDIR/perf-D-workspace-failed-isolated.log`）；为区分并发/文件内顺序，仅扩大到该文件，结果 **21 passed / 同 1 failed**（`$TMPDIR/perf-D-workspace-file-isolated.log`，约 4.64 秒）。已缩到与该文件前序用例/状态或时序相关，尚未定根因，不能称为全量资源偶发超时。WorkspacePage 不在 D 写范围，源码/夹具留主 agent 指派。没有放宽超时、吞失败或改测试期望。

根完整验收**目前仍未通过**；232 通过文件按改动范围复用，D 所属失败项已定向闭环，不能将定向通过伪报为完整单测通过。固定 R07 runtime 验收通过；无 Cargo、可见 UI、完整 Office 重建、commit/push 或 review。

## 第五轮：WorkspacePage 顺序失败定位与修复

主 agent 将写范围扩展至 `WorkspacePage.test.tsx` 及其相关真实 UI 修复，限定只重跑失败文件与相关 Todo/UI；根 runner 隔离及 Node tooling 验收由主 agent 处理，232 个已通过文件复用。本轮关联原工作包 #124 / Todo 创建回归；验收为显式选择 Project 后输入不丢失、正确创建且作用域/标签参数不变。非目标为根配置、原生代码、Office 构建及新全量测试。

### 根因及最小复现

- 先运行 `creates a tagged Workspace Todo when the Workspace has no Projects`，再运行 `creates a Project Todo only after the user explicitly selects its Project`，即可复现后项 `todoCreate` 调用 0 次；独立后项原本通过。命令 `npx vitest run src/components/workspace/WorkspacePage.test.tsx -t 'creates a tagged Workspace Todo|creates a Project Todo only after' --maxWorkers=2`，红结果见 `$TMPDIR/perf-D-todo-order-pair.log`。
- 三个假设分别为跨测试异步刷新消耗一次性项目夹具、查询取消使项目归属丢失、表单/焦点残留。临时按 QueryClient 记录表明目标项目只读取一次且仍为 Alpha，textarea 没有 disabled；实际 textarea 内容为空。
- 焦点边界进一步显示：选择归属后先聚焦 textarea，随后 `selectComposerOwnership` 的 `requestAnimationFrame(...ownershipButton.focus())` 抢回焦点。后续输入落到归属按钮，还可能将其中的空格当作按钮激活。此前顺序与执行时长改变了动画帧落点；是产品焦点竞争，非 R10 查询取消、共享 QueryClient 或断言超时问题。

### 修复与回归

修改文件仅：

- `src/components/todo/TodoRail.tsx`：归属触发按钮已经挂载，选完归属立即同步恢复焦点，避免下一帧覆盖用户后续主动选择的编辑焦点。归属可用性、scoped reference 禁止跨归属、标签清理、草稿及创建写入路径不变。
- `src/components/workspace/WorkspacePage.test.tsx`：在原失败用例中控制归属选择期间的动画帧，主动点击 textarea 后才释放帧，断言输入焦点仍保留，再执行原完整输入与 Todo DTO 断言。没有放宽断言或超时，所有 spy 在 finally 恢复。
- 本独立记录；主执行记录未编辑。

先加强回归、再改实现：`npx vitest run src/components/workspace/WorkspacePage.test.tsx -t 'creates a Project Todo only after' --maxWorkers=2`，**1 failed / 21 skipped**，明确收到焦点的是归属按钮而非 textarea，日志 `$TMPDIR/perf-D-todo-focus-regression-red.log`。改同步焦点后原最小顺序组合 **2 passed / 20 skipped**，日志 `$TMPDIR/perf-D-todo-order-green.log`。

最终定向命令：

```sh
npx vitest run src/components/workspace/WorkspacePage.test.tsx src/components/todo/TodoRail.test.tsx src/components/layout/WorkspaceTodoRail.test.tsx src/todo/TodoModuleRail.test.tsx src/todo/use-todo-module.test.tsx src/todo/todo-module.test.ts --maxWorkers=2
```

**6 files / 111 passed**，7.15 秒，日志 `$TMPDIR/perf-D-workspace-todo-targeted.log`，包括 WorkspacePage 完整 22 项。`git diff --check -- src/components/workspace/WorkspacePage.test.tsx src/components/todo/TodoRail.tsx docs/implementation/perf-package-D-20261027.md` 通过；所有 `[DEBUG-D-TODO...]` 探针已移除。

本项无剩余阻塞；未修改 Todo cache、根 runner 配置或他包文件，未重跑根完整单测/Office build/tsc/Cargo，未启动 UI、提交或 push。此前根全量失败的 Node scripts / B 语音相关验收由主 agent 和 B 各自收口，本记录不代称根全量已通过。

## 第六轮：Rust bounded session action fixture 路由修复

主 agent 全 Rust 验收报告 `dsh_assistant::tests::bounded_session_actions_use_upstream_protocol_and_preserve_host_errors` 失败，授权 D 仅修该单一测试/对应 fork 问题；主全库仍在运行，D 不运行 Cargo、不干预进程。

确认测试 HTTP fixture 只注册 `/api/{group}/{operation}`，无法接到 R07 已使用的三段 `mind/session/fork`。测试内部 method、payload 和返回 stable child ID 的断言已经更新，因此实际请求在进入这些断言前就被 fixture 拒绝。生产 JS 已精确注册 `/api/mind/session/fork`，无需改协议或生产路由。

仅修改 `src-tauri/src/dsh_assistant.rs` 此测试块：将原 action handler 抽为同一个 `MethodRouter`，原两段路由与新增的精确 `/api/mind/session/fork` 路由共享它。保留 method/payload 全等断言、childSessionId 必填及格式检查、foreign session 拒绝、5 次 action 计数、host archive 错误传播、禁止向 carrier 扩展 endpoint 权限、fork 返回身份一致性检查。未改其它测试、生命周期、生产 fork 实现或整文件格式。

`git diff --check -- src-tauri/src/dsh_assistant.rs docs/implementation/perf-package-D-20261027.md` 通过。没有执行 Cargo 或其它测试；**该 Rust 用例的通过结果待主 agent 全库结束后定向复测**，此处不把静态修复记作已通过。

# 文件树行为工作包（目录架构已确认）

## 范围与验收

- 关联：用户直接新增需求，暂无 Issue；当前不创建 Issue、不提交/推送、不派 agent。
- 依赖：`CONTEXT.md`、`docs/requirements/project-content-tabs.md` §5、自动纳管/隐藏条目/外部替换规格、现有目录 watcher、共享 File 菜单及 File 原生恢复服务。
- 本阶段交付：核实文件菜单实际事件链；项目和 Workspace (`projectId=null`) 共享刷新入口；导航隐藏已确认 missing 的原件，保留 DB 身份、历史、引用、打开 Tab 和未保存草稿；文件夹右键/键盘菜单、内联重命名、整目录系统回收站确认与真实 API 调用。
- 非目标：Office 缩放、AI @ 样式、shell 操作用户业务文件、目录移动、跨 owner 转移、通用文件管理框架；本阶段不实现待决策 native API，也不以按钮占位宣称目录操作交付。
- 验收：文件鼠标右键/键盘菜单沿用统一菜单；手动刷新包含展开分支与平铺文档来源；真实删除后清除导航过期项；dirty 通知不串 Workspace generation/owner；错误显式显示；不关闭或销毁编辑状态。
- 验证：仅受影响前端 Vitest 与 diff 自查。遵用户要求不 native build、不 GUI、不全量测试。修改源码前已检查无 `tauri dev`/自动重启进程；main 的基线二进制 GUI 结果单独注明，不当作新代码验收。

## 已核实的实际接入与缺口

1. `HomeProjectFiles.tsx` 将 `ProjectSidebar` 的 `fileContent(controls)` 传给 `ProjectDirectoryBrowser`；树文件行 `onContextMenu` / ContextMenu、Shift+F10 调 `onFileContextMenu`；已注册 File 直接 `fileMenu.openContextMenu`，未注册文件先 binding → register → owner page 查找 → binding 复核 → open。菜单状态/事件实际在 `ProjectSidebar.tsx`，没有独立文件菜单 hook；`useDocumentMutations` 负责后续 mutations。
2. main 原生 GUI 基线：已注册 `complex.docx` 有完整应用菜单，不能宣称所有文件菜单失效。新目录 watcher 正常显示；目录右键是 WebKit 默认菜单。代码明确在两个菜单事件中排除 `kind !== "file"`，且只有 File rename input，目录未接入是确定缺口。
3. 基线 `projectFileApi` 只有单 File rename/move，`projectDirectoryApi` 只有 list/preview/resolveReference/open，无 directory rename/delete。本包已按 native sidecar 确认契约新增前端 DTO/adapter，原生实现由独立 agent 处理。`directory_move_exclusive` 名称虽含 directory，当前包裹的是 File no-overwrite move，不能视为现成目录业务 API。
4. `ProjectDirectoryBrowser` 已按 owner/binding 合并 dirty hints 并刷新对应目录，展开分支共用一个滚动容器与边缘遮罩。没有手动刷新按钮。平铺 `ProjectSidebar` 直接展示传入 documents，包括 `health=missing`。
5. 原生 `fetch_project_documents_for_project`/page 返回 DB health，不能仅 invalidate page 就保证外部删除被发现；`refresh_document_health` 是 `#[cfg(test)]`，不能误当生产服务。目录 list 是可复用的只读权威路径成员信息；刷新必须实际核对已登记路径的父目录，不能用不完整根目录列表误删深层条目，也不能用读取失败推断删除。

## 可复用 native 基础

- `src-tauri/src/project_directory.rs`：真实 owner 根解析、隐藏/系统条目排除、symlink 边界、读取前后验证、binding generation、按 scope 缓存与 dirty 失效。只读枚举可复用；mutation 必须重新校验。
- `db/project_directory_files.rs`：`directory_owner` / `business_path`、物理身份、File baseline(version/hash)、unclaimed 归属；单 File `project_directory_moves` 与 metadata intents、恢复、无覆盖移动、目录 fsync、身份与位置更新及业务变更日志。
- `db/file_versions.rs`：`file_project_lock(Option<projectId>, exclusive)` 覆盖 Workspace null；锁顺序 owner → File → SQLite transaction；scope writer 用独占锁，File writer 用共享锁。目录操作不能持独占 owner 锁再调用会重入共享 owner 锁的 public File 方法。
- `db/file_deletions.rs`：`.project-mind/file-delete-journal`，先 staging 与 journal、核验物理身份/内容/版本、原子 receipt、恢复未提交或清理已提交、`move_paths_to_trash`。现有单 File 删除会处理历史资产与 DB 元数据；不能对每个子 File 循环删除冒充目录原子删除。
- `db/file_relocations.rs` / `project_directory_files_restore.rs`：文件恢复意图、身份和校验值校验、冲突时保留 journal；这些是协议素材，不是可直接调用的整目录业务能力。
- 稳定 File ID Tab、business-change 同步链路复用；主 agent 决定首版有活动后代编辑 session 就拒绝目录操作，关闭编辑器沿用既有保存 guard，不新增 flush/freeze 框架。

## 已确认的最小安全 native 设计（由 native sidecar 实现）

### 契约

新增可信 GUI `project_directory_change_prepare`、`project_directory_rename`、`project_directory_delete`，同一 `binding + projectId: number|null + relativePath`；prepare 返回有预算的后代 File IDs、源目录物理身份及 revision token。rename 只接收单个新目录名，不支持移动；delete 必须传显式确认 prepare token。超预算失败并明确报告，不静默截断。目录 token 不需要对未纳管普通内容逐字节 hash。

前端 prepare；删除必须显式确认整个目录含未纳管内容移入系统回收站；rename 使用内联名称输入；提交前 reprepare，目录 identity、后代集合或 revision 变化就停止。native prepare 和 commit 均在 owner exclusive 锁内检查 current-generation 活动后代 `file_working_sessions`，返回 `active_editors` 与“先关闭目录内打开的文件（含独立窗口）”提示。前端不自动 close/flush/discard；用户关闭时走已有保存 guard，失败保留草稿。历史只读页不构成可编辑 session。

### 事务与恢复

1. 验证当前 binding 与实际 owner，拒绝归档项目；限定 owner 下非根普通业务目录；拒绝绝对路径、`..`、分隔符名称、内部系统目录、跨 owner 系统路径和 symlink 越界。**主 agent 决策修正**：owned `.<id>.pm-versions` 必须随普通目录移动，不能见隐藏项就拒绝正常目录；未纳管普通内容随整目录移入回收站。跨 owner 或重复物理归属拒绝。
2. 先完成既有恢复，获取独占 owner 锁，按 File ID 升序获取后代 File 锁；重新枚举核对 prepare manifest、物理身份、当前内容 CAS 和归属。外部文件系统不服从应用锁，因此实际移动前后继续验证路径与身份；有歧义保留 journal 并停止。
3. 一个目录 journal 记录 operation/request、原/目标路径、目录身份、全部受影响 File 的旧/新路径及 CAS、恢复状态。rename 持久化意图并 fsync 后对整个目录做同盘无覆盖移动，再在一次短事务 prefix-rebase managed/history/original/version/目录登记路径和 receipt/outbox。ID、版本 ID/号/hash 不变；仅改名不生成内容版本。避免逐 File 迁移暴露半棵树。
4. **主 agent 已决定**：显式确认后，整个目录（含普通未纳管内容及 owned 历史）移入系统回收站；DB File 身份、历史元数据、恢复 BLOB 保留，后代标 missing/退出导航，OS 恢复后可重新发现。不新增复制全部历史的存储框架，不逐 File 移动，不用 unmanage 替代实际删除。不得 `remove_dir_all`。外部删除的导航清理同样绝不删除 DB 历史。
5. Native sidecar 确认删除采用原路径直送 Trash：持久化 intent → OS Trash(original) → missing 元数据/receipt；恢复时源仍是原身份则撤销未执行 intent，源缺失则完成 missing/receipt，外来替换则保留冲突 intent。不采用先 staging 后 Trash，避免 OS 恢复到隐藏 staging。rename 恢复同样不能覆盖外来实体。恢复过程幂等，重复 request 返回原结果。
6. 提交后发布每个受影响 File 的业务变化与目录 dirty（父目录及旧/新子树）。前端按稳定 File ID 更新 Tab 名称/位置；保留编辑 buffer，避免关闭重开丢状态。Workspace null 使用独立 scope，不构造占位 Project。

### 最小修改面（需另行解锁 native 范围）

- 新增 `src-tauri/src/db/project_directory_changes.rs` 及针对性恢复/故障注入测试；`db.rs` 模块注册和 schema/journal 初始化/恢复入口。
- `src-tauri/src/project_directory.rs` 或单独 command adapter，`lib.rs` 注册；必要时 Tauri capability 白名单。
- 抽取复用 `db/project_directory_files.rs` / `file_versions.rs` / `file_deletions.rs` 的已有私有边界与已持锁 helper，避免锁重入；仅在必要时改已有文件。
- `src/services/projectDirectoryApi.ts` DTO；文件树与独立目录菜单 hook（目录独立 target 类型，绝不伪造 File）；复用业务变更通知，无需改 Office/editor 或新增 flush 协调模块。
- 验证必须覆盖 null owner、保留 IDs/历史/Tab、同名冲突/大小写、未保存内容/双栏、系统/隐藏/symlink、祖先交换、未纳管后代、目标碰撞、跨归属、锁顺序、每个 journal 阶段崩溃恢复、重复请求。Windows 需平台实测；当前无 Windows 结果。

## 主 agent 决策

目录删除及 rename 策略已由主 agent 决定，native 交独立 agent，本包不改 `src-tauri`。rename 完整 prefix-rebase managed/history/original/version/目录登记路径；ID/version/hash 不变。统一已有 owner→File→事务/fence 顺序，不引入新锁环。main 提供的 GUI 是基线 binary，不能当作本包修改验收。

### 已与 native 对齐的 wire DTO

```ts
type PrepareDirectoryInput = { binding: AgentWorkspaceBinding; projectId: number|null; relativePath: string };
type PreparedDirectoryChange = { token: string; identityToken: string; relativePath: string; files: Array<{ fileId: number; revision: number }> };
type RenameDirectoryInput = PrepareDirectoryInput & { token: string; name: string; requestId: string };
type DeleteDirectoryInput = PrepareDirectoryInput & { token: string; confirmed: true; requestId: string };
type DirectoryChangeResult = { relativePath: string|null; fileIds: number[] };
```

Native sidecar 已确认上述结构及三个命令名。`identityToken` 提供稳定物理目录身份供前端 prepare/reprepare 对比。`token` 是 opaque native token，绑定 directory identity、owner、binding、后代 File 集合与必要 revision；前端不自行拼安全字段。新打开的编辑 session 即使发生在 reprepare 后也由 native commit 再次检查并拒绝。

### 首版可见限制与关闭链路说明

有活动后代 File 编辑 session 时，即使当前看起来已保存，也需先关闭目录内打开的文件（包括独立窗口）再操作；关闭保存失败保留草稿。历史只读页不在此限制内。native 明确提示通过 `role=alert` 展示；前端不触发任何自动关闭或丢弃。

修正先前调查结论：`App.tsx:399` 的函数虽名 `flushRecordSaves`，实际先执行 `prepareWorkspaceContentClose`，覆盖 File guards；不是“只保存 Record”。问题在于 close guard 包含 discard 分支，仍不适用于本操作，因此不调用全局 close/flush。定向冻结仅在后续用户要求操作期间继续编辑时另行设计。

## 实现与验证结果

- `HomeProjectFiles.tsx`：项目和 Workspace 同一手动刷新按钮、刷新中状态/错误；平铺和树共享经过 presence 校验的导航 File 集合，Sidebar key 加入 Workspace root。
- `useFileNavigationRefresh.ts`：手动刷新等待旧目录请求完成，再刷新展开分支和 owner page；真实读取已登记 File 的父目录链，祖先目录缺失则隐藏其后代，目录读取失败不当作删除。dirty 按 binding/owner 过滤并合并，检查受影响父目录；tree dirty 继续复用 Browser 自有队列，不再全树 fanout。UI presence 以 File ID+路径+scope 隔离，避免同路径新 File 继承旧缺失状态。只隐藏导航，不改 DB、历史缓存、Tab 或 draft。
- `ProjectDirectoryBrowser.tsx`：Workspace/root/owner 改变时同步取消旧的异步菜单请求。普通 File 右键已有完整接入，不宣称普遍修复。
- `useDirectoryActions.tsx`：目录菜单 portal、鼠标及键盘入口；rename 内联输入，Enter/blur 提交、Escape 取消，失败保留名称草稿；delete 整目录确认；prepare/reprepare 比较 identityToken/成员/revision 后调用真实 mutation；成功 invalidate 目录与 owner page，native 错误明确显示。scope 切换取消旧确认，不会串提交。
- `projectDirectoryApi.ts`：按 sidecar 契约新增 prepare/rename/delete DTO 和 `fileCommand` adapter。
- 列表滚动结构未改，继续复用 `HomeSidebarList` 的边缘遮罩。

验证按未变范围复用，均无应用窗口：

| 范围 | 实际结果 |
| --- | --- |
| `npx vitest run src/components/home/useFileNavigationRefresh.test.tsx src/components/home/ProjectDirectoryBrowser.test.tsx src/components/layout/ProjectSidebar.test.tsx --maxWorkers=1` | 首轮 56 通过（当时新增 hook 7、Browser 32、Sidebar 17） |
| `npx vitest run src/components/home/ProjectDirectoryBrowser.test.tsx --maxWorkers=1` | 补鼠标/键盘菜单、null owner、旧 Workspace 菜单取消、真实展开树手动刷新后 37 通过 |
| `npx vitest run src/components/home/useFileNavigationRefresh.test.tsx src/components/home/ProjectDirectoryBrowser.test.tsx --maxWorkers=1` | 增加 dirty 父目录范围、同路径不同 ID、binding 变化用例后 47 通过（10+37） |
| `npx vitest run src/components/home/useFileNavigationRefresh.test.tsx --maxWorkers=1` | 最终增加 native health 转 missing 优先于旧存在快照的回归后 11 通过 |
| `npx vitest run src/components/home/useDirectoryActions.test.tsx src/components/home/ProjectDirectoryBrowser.test.tsx --maxWorkers=1` | 47 通过（目录菜单 10、Browser 37）；覆盖 Project/null owner、鼠标/键盘、inline rename、Trash 确认/取消、活动 editor 拒绝、失败留草稿、目录身份/成员/revision 变化和 Workspace 切换 |
| `npx tsc --noEmit --pretty false` | 通过；仅类型检查，无应用构建输出 |
| `git diff --check`（限本包已跟踪文件） | 通过；新增文件另做行尾检查 |

Standards/Spec 自查：树菜单没有伪造 File target；缺失筛除只来自既有 health 或成功目录枚举；权限错误/切换丢弃结果；历史保留；Workspace null 与 Project 共享路径。未启动 review agent。未跑 native build/GUI/全量测试/构建；Windows 未测。没有 commit/push。

前端已按最终协议接完；11+10+37 个当前前端用例通过，另复用未改 Sidebar 的 17 个，共 75 个有效用例。剩余为 native 实现和统一真实联调验收（由 main 组织），不再等待新 flush/fence 入口。本 agent 未把 mock API 测试写成真实 Trash/身份/崩溃恢复验收。

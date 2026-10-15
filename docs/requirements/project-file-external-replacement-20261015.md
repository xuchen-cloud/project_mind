# 项目文件接纳同路径外部修改

关联：[#183](https://github.com/xuchen-cloud/project_mind/issues/183)。用户确认：已纳管的同一路径发生外部修改或原子替换后，自动接纳；内容变化才新增 File Version，正常打开当前文件。

## 工作包范围

- 依赖现有 Project File 登记、resolve、独立版本快照、版本 CAS、编辑器草稿保护与恢复日志。
- 原地修改和同路径物理替换沿用同一个 File ID。内容变化时建立下一版本，原目录保留最新文件，版本目录保存独立内容快照。
- 内容相同的替换只更新物理身份，保留版本号、版本 ID 和原快照路径。重复核验不重复登记或产生业务变更。
- 当前文件可直接在本地应用打开，固定历史版本仍读取对应快照。
- 非目标：推断外部移动目的地、新文件监控平台、扩大快照预算，以及补回应用未检测到的外部中间保存状态。

## 必须保留的边界

文件缺失、外部移动和归属不明确继续使用位置确认。自动接纳不能抢占其他 File 或 Project 的物理文件，也不能跨越项目路径、隐藏文件、符号链接和快照预算边界。未完成的移动或恢复意图必须先恢复，不能用自动接纳清除意图。

未保存的 Office 编辑继续绑定原版本与内容校验值。外部版本刷新不能丢弃草稿；旧版本保存发生冲突时显示错误并保留编辑。

遗留导入的首版本可能仍指向实时文件，尚未冻结独立快照。此时不能把外部替换后的内容冒充旧版本：保留首次核验和人工确认边界。已冻结为项目目录 File 的导入适用自动接纳规则。

新导入时即冻结首版本的持久化协议在后续 [#185](https://github.com/xuchen-cloud/project_mind/issues/185) 跟踪；该包需覆盖 GUI、剪贴板、Agent 创建及导入各阶段的崩溃恢复。

## 验收与验证范围

1. 用临时文件重命名覆盖原路径，resolve 返回 ready，内容变化时从 vN 前进到 vN+1，原 File ID 和路径不变。
2. 相同内容替换后可以直接打开，版本号和原快照不变；重复 resolve 不新增版本、快照或业务事件。
3. 原地修改、原子替换和再次打开后，旧版本仍返回原字节。
4. 移动和缺失继续要求核对位置；其他已登记 File 的物理身份不能通过替换自动转移归属。
5. 外部新版本到来时，无草稿的 Office 文件可刷新；有草稿时保留原基线，保存冲突保留编辑。
6. 针对性回归先执行，再集中执行受影响的 Rust 目录文件、导入和保存验证及 cargo check。前端仅验证 File 打开与 Office 草稿保护、类型检查；无 DTO 或产品 UI 改动，不重跑前端全量或启动应用窗口。

## 执行记录

验证基线为 `cbc0a6e` 上的本包改动；前端产品代码、依赖和 DTO 未改，以下结果在后续 Rust 改动中复用。

| 范围 | 命令与结果 |
| --- | --- |
| Office 外部版本刷新、未保存草稿、预览与编辑会话 | `npx vitest run src/components/document/ProjectFileOffice.test.tsx src/components/document/ProjectFileContent.test.tsx src/components/office/OfficeFileContent.test.tsx src/lib/office-edit-session.test.ts --maxWorkers=1`：58 通过，含新增 2 项外部变更用例 |
| 位置操作、外部打开与 API | `npx vitest run src/components/document/ProjectFileIdentityActions.test.tsx src/components/document/FileOpenWithButton.test.tsx src/services/projectFileApi.test.ts --maxWorkers=1`：27 通过 |
| 类型检查 | `npx tsc --noEmit`：通过。首次运行缺少本工作树 Office 构建产物；逐字比对 324 个 Office 已跟踪源文件后，复用主工作树对应的 3 个生成目录再通过 |

依赖锁文件与主工作树一致，复用其 node_modules。验证未启动桌面应用窗口。

### 原生验证

首先将原子替换用例的预期改为 ready，修复前得到 `Physical identity changed; confirm replacement or relocation`、实际 ambiguous 的稳定失败；修复后该用例和相同内容替换用例均通过。

最终原生验证使用 `cargo test --manifest-path src-tauri/Cargo.toml --lib --no-run --quiet --message-format=json` 编译本工作树，并独立复制生成的测试程序，按下表过滤器执行。SQLite 禁止跟随符号链接；macOS 将 `TMPDIR` 设置为其真实路径后再运行测试，避免系统 `/var` 别名导致运行时连接被拒绝。最终构建使用 `CARGO_INCREMENTAL=0`，减少磁盘空间消耗。

| 范围或过滤器 | 结果 |
| --- | --- |
| `db::project_directory_files::tests` | 48 通过，1 项旧恢复状态预期需按本次规则更新；仅修改该项测试后，单独重跑 `directory_file_restore_process_crashes_never_overwrite_foreign_live_files` 通过。合计 49 通过、1 个既有子进程辅助项 ignored，复用其他未变用例结果 |
| `project_directory::bound_tests` | 3 通过，覆盖工作区代次、原路径复核、同内容及不同内容替换和文件缺失 |
| `db::file_imports::tests` | 11 通过、1 个既有子进程辅助项 ignored，包含导入与 Agent 创建各持久阶段进程崩溃恢复 |
| `file_version_service::tests` | 49 通过、3 个既有子进程辅助项 ignored，包含保存 CAS、上传、历史恢复及进程崩溃 |
| `cargo check --manifest-path src-tauri/Cargo.toml --quiet` | 最终代码通过，仅有仓库既有警告 |

恢复状态用例继续验证外来文件字节与物理身份不被恢复覆盖、旧快照不变、重开后不重复写入。未提交的恢复保持 ambiguous 并保留意图；已提交恢复完成清理后，正常同路径核验可自动接纳内容相同的替换，保持版本号不变。

### 双轴自查

- Standards：主 agent 检查完整 diff，保留路径、归属、快照预算、恢复意图、文件锁与事务 CAS；普通未变化 resolve 保留快路径，不增加全库物理归属扫描。无剩余发现。
- Spec：同路径外部内容变化自动登记新版本、相同内容只更新身份、旧快照及引用保留、本地打开和未保存编辑冲突保护均有验证。遗留未冻结导入与后续 #185 边界明确。无剩余发现。
- 没有启动 review 子 agent。所有临时诊断日志代码均已移除，`git diff --check` 通过。

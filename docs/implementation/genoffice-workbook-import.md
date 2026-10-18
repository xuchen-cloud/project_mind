# Excel 外部工作簿合并的只读来源（#191）

## 工作包

- 关联：[#191](https://github.com/xuchen-cloud/project_mind/issues/191)，父 #118。
- 依赖：完整官方 Sheets `merge-workbooks.ts`、本包 XLSX inspect/native sidecar、固定 Node 24.21.0。Excel agent 负责 picker、临时来源快照和合并日志；主负责原生入口、服务和宿主接线。
- 交付：用户选择 XLSX 字节，固定 `office.inspect` / `xlsx` 得到完整只读 Model；上游将来源工作表合并进当前草稿，再由现有 File/CAS 一次保存。
- 非目标：按 renderer 路径读取文件、给外部来源注册 File、另建任意路径 relay、修改源工作簿、改变当前 File 的保存权限。
- 验收：真实源 XLSX 合并、目标保存重开；取消或错误不生成空来源，不发布成功；消失的编辑生命周期不接纳异步旧结果。Windows 实机证据与可移植接口分开判断。
- 范围：新增 `editor_workbook_import.rs`、`editorWorkbookImport.ts`，桌面 adapter / lib 注册 / Office 宿主接线；真实 utility 验收复用原 `office_real_formats_native_save_reopen_and_retained_history` 的 XLSX 分支。先定向红绿，不重跑根全量。

## 边界

`desktop_inspect_imported_workbook({base64})` 仅接受字节，不接受格式、路径、调用方、凭据、File、session 或 edits。Tauri 注入调用窗口，仅 main 与合法 project 窗口可调用。调用固定的只读 XLSX inspect，复用现有 worker 的 canonical base64、100 MiB、并发、进程权限及超时边界；源字节不写到业务路径，不经过数据库或 File stage。worker 返回的 Model 中仅包含临时只读内容快照。

前端在分配 base64 IPC 前拒绝空选择和超过 100 MiB 的字节。picker 的文件名只由 Excel renderer 用作来源显示与 sheet 命名，不作为 native 路径。实际合并行为和原件保留由格式包验收。

## 2026-10-18 验证

- 新 Rust 四项中，两个成功/错误传播用例在空实现下先红；caller 和 DTO 拒绝用例保持严格。首次 green 编译暴露仓库没有直接 uuid 依赖，改用现有 rand 生成内部请求 ID，未增加依赖。`cargo test --offline --manifest-path src-tauri/Cargo.toml --config 'profile.test.package.project_mind_alpha.debug=0' --lib editor_workbook_import --quiet` 最终 4 passed。
- 服务新增四项、adapter 新增一项均先红后绿：精确二进制传输、错误、空字节与超预算拒绝、正确 native command。定向执行匹配还覆盖一个既有 adapter，共 6 passed / 32 skipped（固定 Node 24.21.0）；跳过部分沿用此前未变代码的 adapter 验证。
- 已将真实导入加入既有 opt-in 格式验收，待统一构建/stage 后执行；当前不把 mock utility 或 IPC 当真实 XLSX 验收。
- 宿主新增缺少 callback 的红例，再传 `onInspectImportedWorkbook={inspectImportedWorkbook}`；`OfficeFileContent.test.tsx` 15 passed（含原有保存/重算合同），导入本身不保存当前 File 或标脏。
- Excel picker、临时 source routing、合并保存仍由格式 agent 实现中，本工作包尚未完成。

# Windows 文件管理兼容检查

关联：[#190](https://github.com/xuchen-cloud/project_mind/issues/190)，复查 [#183 同路径外部修改](project-file-external-replacement-20261015.md)。本包修复长路径移动和移动失败后的可打开性。Windows 实机验收及仅大小写改名继续由 [#192](https://github.com/xuchen-cloud/project_mind/issues/192) 跟踪。

## 范围和验收

依赖现有 File 物理身份、不可变 File Version 快照、保存 CAS 和恢复日志。移动被占用或权限拒绝时，若核对原文件身份及内容完整、目标不存在，取消本次尚未执行的移动及关联元信息意图，保留原路径和元信息；随后 resolve 不得偷偷重试移动。无法核对或移动可能已完成时继续保留恢复意图。

Windows 独占移动使用扩展长度路径，覆盖盘符、UNC、中文和空格，保留不覆盖目标、同卷移动和 WRITE_THROUGH 参数。不通过 canonicalize 解析源文件或要求目标已经存在，不增加复制降级或自动重试。

非目标：产品 UI、跨端 DTO、新的文件监控或重试框架、仅大小写改名的恢复协议、ReFS 身份格式迁移、云盘下载平台和断电保证。

## 检查结论

| 项目 | 结论与处理 |
| --- | --- |
| 外部原子替换 | Windows 通过卷序列号和 File Index 识别物理文件，内容另做 SHA-256 核验；同路径新身份可以接纳为当前 File，旧内容保留快照。补充持有旧读句柄时替换、登记新版及保留旧字节的 Windows DB 回归 |
| 文件共享 | 现有安全读取沿用 Rust 默认的读、写、删除共享，不额外阻止外部程序替换文件。外部程序拒绝删除共享仍可能使显式移动失败；本包修复失败后遗留移动意图的问题。对方拒绝读取时必须继续返回真实 I/O 错误 |
| 长路径 | 原先直接把普通路径编码为 UTF-16 传入 MoveFileExW，依赖系统长路径开关；本包在 Windows 绝对路径标准化后使用扩展前缀，盘符和 UNC 分别转换，已有扩展路径保留 |
| 路径边界 | 设备命名空间、DOS 保留设备和 alternate data stream 不能作为普通移动路径；保留 NUL 校验。目录链接仍由原有逐组件 symlink_metadata 检查拒绝，未新增泛化的 reparse point 放行规则 |
| 版本和草稿 | 保留内容 hash、固定历史来源和保存 CAS；本包没有改变 Office 草稿逻辑或历史快照路径 |
| 仅大小写改名 | 仍有缺口：目标存在判断会拒绝默认不区分大小写文件系统上的 report.txt → Report.txt。恢复目前也假设两个路径不会同时存在，不能只放开目标判断；由 #192 实现与验收 |
| 文件系统身份 | 本地 NTFS 的身份方案与 Windows API 契约一致；ReFS 的 64-bit ID 不保证唯一，网络文件系统可能提供不完整身份。#192 需分别明确支持边界，当前不宣称这些卷已验收 |
| 持久性 | Windows sync_directory 仍无操作；保留 WRITE_THROUGH 不能替代目标文件系统断电验收。代码注释明确区分进程崩溃测试和断电保证 |

共享默认值见 [Rust OpenOptionsExt](https://doc.rust-lang.org/std/os/windows/fs/trait.OpenOptionsExt.html#tymethod.share_mode)；路径限制、移动标志与返回错误见 [Microsoft MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)。身份适用范围见 [GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle) 和 [BY_HANDLE_FILE_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information)。Rust Windows FileType 将 name-surrogate reparse points 视为链接，依据 [Rust 标准库实现](https://github.com/rust-lang/rust/blob/1.90.0/library/std/src/sys/fs/windows.rs)。

## 回归证据

在修复前运行 `directory_file_failed_move_does_not_retry_or_apply_metadata_on_resolve`，实际报错为 `a failed move must not be retried by resolve`，待处理移动数为 1，预期为 0。该测试在只读目录中驱动真实移动失败路径，恢复目录权限后核验不会重试或应用未成功的元信息；修复后通过。Windows 对应用例使用拒绝 FILE_SHARE_DELETE 的真实句柄，覆盖占用期间仍可 resolve、释放后不自动移动、用户再次显式改名可以成功。

低层 Windows 测试覆盖扩展路径转换、NUL/设备路径拒绝、超过 260 UTF-16 单元的中文与空格路径、目标碰撞、允许及拒绝删除共享的读句柄、移动后物理身份不变。`tools/windows-file-compat` 直接引用生产模块，无 Tauri 或 GUI 依赖，可在 Windows 执行：

```sh
cargo test --manifest-path tools/windows-file-compat/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib project_directory
cargo test --manifest-path src-tauri/Cargo.toml --lib file_version_service::tests
```

macOS 只执行 `cargo check --tests --target x86_64-pc-windows-msvc --manifest-path tools/windows-file-compat/Cargo.toml` 检查低层生产模块及其测试的 Windows 分支，不将其写成执行通过。完整 Windows 应用编译、上述 DB Windows-only 用例及真实 Office/资源管理器场景仍须 Windows 环境。

## 验证结果

基线为 `40a36d7`，验证本包改动；macOS 临时目录使用真实路径，原生编译复用已有 Cargo target，禁用增量缓存，并复制固定的测试程序防止其他工作树覆盖。编译时磁盘耗尽后，仅清理上一轮本任务的测试程序及无构建进程占用的旧 Rust 编译对象缓存，随后构建通过。

| 验证范围 | 结果 |
| --- | --- |
| `project_directory` | 70 通过，1 个既有子进程辅助项 ignored |
| `file_version_service::tests` | 修正崩溃钩子后 49 通过，3 个既有辅助项 ignored |
| `db::file_metadata::tests` | 5 通过，1 个既有辅助项 ignored |
| `db::file_versions::tests` | 21 项通过：复用 20 项，修正准备步骤的 GUI 两连接用例单独运行 3 次均通过；1 个既有辅助项 ignored |
| 应用 `cargo check --offline --manifest-path src-tauri/Cargo.toml --quiet` | 通过，仅已有警告；后续修改仅位于 cfg(test) 内，复用生产编译结果 |
| 独立 Windows 模块 `cargo check --offline --locked --tests --target x86_64-pc-windows-msvc --manifest-path tools/windows-file-compat/Cargo.toml` | 通过，无警告；生产移动模块及其 6 个 Windows 测试通过目标编译，未执行 |

### 验证中修正的测试辅助代码

两个服务崩溃用例最初得到正常退出码 91 / 93，要求仍是 SIGKILL。提取同样的 `kill(self, 9); exit(...)` 到带测试线程的独立程序，16 路并发 400 次中出现 289 次正常退出，111 次 SIGKILL，证实 exit 与信号交付存在竞态。版本及上传钩子改为检查 kill 成功后等待不可捕获的信号；修正后的同一程序 400 次全部 SIGKILL，服务完整回归通过。没有放宽崩溃状态断言。

版本内核的 GUI 两连接用例在 Database::open 的迁移阶段出现 database is locked，一条连接可能在另一条连接失败后永远等待屏障。沿用既有 registered-commit 并发测试的准备方式：先建立两条连接，再并发提交 File；两次保存竞争、唯一版本及幂等收据的断言不变。本项不改变生产数据库初始化逻辑。

目录和元信息用例未使用这两个崩溃钩子，复用已通过结果；内核其他 20 项与服务 49 项在修正钩子后通过，后续仅修正 GUI 用例的准备步骤，不重跑无关用例。本包未修改前端、应用依赖锁或 DTO，不重跑前端全量，不启动应用窗口。

合计 145 项不同的原生用例通过，6 个既有子进程辅助项 ignored。独立压力复现与 Windows 目标编译不计入该通过数。

## 双轴自查

- Standards：主 agent 核对完整 diff；移动失败仍返回原错误，只在已验证未执行时清除本次意图，不能删除外来文件或完成不确定的移动。Windows 路径转换不解析文件链接、不覆盖目标、不跨卷复制，保留真实 Win32 错误。测试钩子仍要求真实终止，并发测试仍竞争同一 File。无本包剩余发现。
- Spec：长路径转换和共享模式有独立 Windows 测试及目标编译；移动失败可继续原位打开有真实失败/通过回归；历史、元信息与既有移动恢复范围均通过。Windows 实机、仅大小写改名与其他文件系统的支持界限明确保留在 #192，未冒充已交付验收。
- 未启动 review 子 agent；`git diff --check` 通过，临时压力复现程序不进入仓库。

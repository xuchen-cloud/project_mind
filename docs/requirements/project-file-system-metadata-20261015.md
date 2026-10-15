# 项目文件排除隐藏文件与目录

关联：[#159](https://github.com/xuchen-cloud/project_mind/issues/159)，修正 #142 验收中发现的隐藏文件展示问题。2026-10-15 用户明确将范围从 `.DS_Store` 扩大为所有隐藏文件，不论 macOS 还是 Windows。

## 范围与验收

- 依赖现有目录扫描、统一 File 登记、项目文件平铺列表及文件树读取。
- 所有以 `.` 开头的文件与目录（如 `.DS_Store`、`.env`、`.git`），以及系统属性标记隐藏的文件与目录均不展示、不纳管；隐藏目录下的普通名后代也排除。
- macOS 读取 `UF_HIDDEN`，Windows 读取 `FILE_ATTRIBUTE_HIDDEN`。项目根路径之外的祖先不属于项目业务条目，不因工作区位于隐藏目录而整体屏蔽项目。
- 直接登记、手动导入、Agent 创建候选名与目录预览/访问遵循隐藏规则。
- 既有隐藏 File 从项目平铺列表隐藏，保留磁盘原件、File 身份与历史版本。普通可见文件和既有 missing-health 行为保留。
- 非目标：删除历史 File/磁盘文件、通用忽略配置、额外文件监控平台。

## 验证计划

- `.DS_Store` 初始回归 1 通过、9 失败，修复后 10 通过；用户扩大范围后更新回归并重新执行受影响范围，旧结果不作为扩大范围的验收。
- 收口覆盖目录扫描、目录访问、文件导入、Agent 文件名校验与后台自动维护 Rust 测试，并执行 `cargo check` 与 diff 检查。
- 本包只改原生逻辑，不改 DTO、IPC、前端或构建资源；不重复前端构建，不启动应用窗口。
- 主 agent 完成 Standards / Spec 双轴自查；沿用户已确认的 develop 开发线发布。

## 平台依据

- Rust [macOS/Darwin MetadataExt](https://doc.rust-lang.org/src/std/os/darwin/fs.rs.html) 提供 `st_flags`；`UF_HIDDEN` 值按系统头对应常量使用。
- Rust [Windows MetadataExt](https://doc.rust-lang.org/std/os/windows/fs/trait.MetadataExt.html) 提供 `file_attributes`；使用已有 windows-sys 依赖的常量，其语义见 [Microsoft File Attribute Constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants)。
- macOS 本机执行真实 `chflags hidden` 回归；Windows 的 `attrib +h` 回归受平台条件编译约束，本机不宣称已执行 Windows 实机验证。

## 完整验证与自查

代码基于 `9aa755c`（本包开始时 develop）。以下结果对应本包最终原生实现及测试，后续只补文档记录：

- `CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib project_directory`：62 通过，1 个既有 ignored 子进程辅助项；覆盖目录访问、分页登记、路径边界、原生隐藏属性、隐藏目录后代和旧 File/版本保留。
- 同一 shared target，`cargo test --manifest-path src-tauri/Cargo.toml --lib db::file_imports::tests`：11 通过，1 个既有 ignored 子进程辅助项；覆盖导入、Agent 创建隐藏候选名拒绝和既有崩溃恢复路径。
- 同一 shared target，`cargo test --manifest-path src-tauri/Cargo.toml --lib project_file_maintenance::tests`：3 通过，自动后台纳管与工作区代际/跨项目轮转行为通过。
- 同一 shared target，`cargo check --manifest-path src-tauri/Cargo.toml`：通过，保留既有警告；`git diff --check` 通过。
- macOS 使用临时项目的真实 `chflags hidden` 覆盖普通名隐藏文件、隐藏目录和后代；Windows `attrib +h` 对应测试已添加，未宣称本机运行了 Windows 测试。
- Standards：主 agent 检查本包全部 diff；隐藏判定集中复用，保留缺失文件 health 行为，文件系统错误继续明确传播；没有引入忽略框架、数据清理或扩展到取消的 Skills 需求。无剩余发现。
- Spec：主 agent 按 #159 和用户最终修正核对 dot 条目、macOS/Windows 原生属性、目录后代、两种展示、后续登记/导入与既有记录保留，全部有实现或回归覆盖。无剩余发现。未启动 review 子 agent。

日志位于本机 `/tmp/ds-store-{directory,imports,maintenance,check}-final.log`。应用窗口未启动；本包无前端变更，不重复 #142 的前端构建或 UI 验收。

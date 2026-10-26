# Project File 按目录变更发现与旧版自动登记

关联 [#271](https://github.com/xuchen-cloud/project_mind/issues/271)，基线 `develop` 的 `10382ca`。

## 工作包

- 依赖：已有分页目录扫描、实际文件归属、文件版本锁、不可变快照和 committed change 发布。
- 交付：首次有界扫描后，由原生目录变更通知唤醒对应 Project / Workspace File 范围；静止目录不周期重扫。轻量项目目录查询继续发现新建、归档和删除的 Project。
- 交付：原路径旧版导入缺少物理身份时自动补登记，无需逐个确认。已有 hash 与当前字节相同则保持版本；缺少 hash 时将当前字节登记为新版本，保留未知旧历史。
- 交付：同一文件或目录的同一错误跨页、跨轮只报告一次，恢复后再次发生可以重新报告。
- 非目标：回退 develop、改动语音采集、猜测外部移动位置、扩大快照预算、周期扫描兜底或关闭安全软件。

用户在本包中明确修正了[旧版首次身份确认](project-file-legacy-confirmation-20261026.md)的默认行为，以及[自动纳管](project-file-auto-management-20261015.md)的约五秒重扫策略。两份旧文档中的执行记录保留为历史证据。

## 行为与边界

1. 订阅原生目录通知后开始首次扫描。分页保持公平，目录/字节预算沿用现有规则；扫描期间发生的新变更不能丢失。
2. 无目录变更时不枚举文件树，不反复登记、hash 或创建快照。读访问、隐藏路径、临时文件与内部版本目录不得唤醒 discovery。
3. 新文件、目录复制和重命名等可见路径变化只唤醒受影响范围；工作区重开清理旧代际的游标、订阅和错误状态；归档或删除项目释放订阅。
4. 原生订阅失败真实报告，不静默改回文件树轮询。一个不可访问项目不阻塞其他项目。
5. 自动登记仅适用于缺少身份的旧版导入现有路径。已登记身份变化、已知 hash 不符、外来物理归属、路径越界或未完成移动意图继续保留实际错误；不能借迁移覆盖历史。
6. 版本与身份仍在 Project / File 锁内提交，快照先持久化，事务保留版本 CAS、实际归属和最终字节核验，通知在释放数据库锁后发布。

## 验收与验证范围

- 真实数据库构造 31 个旧版文件，分页自动 ready；相同 hash 不增版本，无 hash 新增版本且不回填旧历史。原文件、File ID、收藏和创建时间保持。
- 缺失文件、真实内容冲突、外来物理归属和快照预算仍受约束；Workspace File 与 Project File 均适用。
- Driver 在静止目录、时间推进后不再扫描；真实原生事件与扫描中事件唤醒正确范围；错误去重、跨项目公平、代际重开和不可访问项目继续回归。
- 先运行针对性 TDD，再集中执行受影响 Rust discovery、目录 File、导入、版本内核/服务及绑定路径测试，静默 `cargo check` 和 diff 检查。纯 Rust 改动不重复前端全量。
- 主 agent 完成 Standards / Spec 双轴自查；按最小发布流程合入 `develop`。

公司内部安全软件持续高 CPU 的代码路径与采样方法见[诊断记录](../technical/windows-startup-security-cpu-20261026.md)。macOS 无窗口回归不替代原 Windows 工作区的 CPU 和界面实测。

## 执行证据

验证覆盖基线 `10382ca` 上本包最终源码；全程未启动应用窗口。

| 范围 | 命令与结果 |
| --- | --- |
| 旧版 TDD | `TMPDIR=/private/tmp cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet legacy_auto_registration -- --nocapture`：修复前 2 项均以 `ambiguous != ready` 失败；扩展到历史、归属与 Workspace 后，4 项新回归及既有位置用例共 5 项通过 |
| Driver TDD | 修复前真实 Driver 的跨轮日志回归失败：3 个持久目录错误累计输出 6 次；时间调度回归也失败。按用户进一步要求改为事件驱动，最终覆盖静止、分页期间变更、原生创建/重命名、受影响范围、项目目录变化、根恢复及错误恢复后再报告 |
| 目录 File | `TMPDIR=/private/tmp cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -- db::project_directory_files::tests`：67 通过、1 个既有辅助项 ignored、1 个旧规则断言失败。更新该断言为自动 ready 后，仅重跑 `imported_file_legacy_registration_rejects_known_identity_or_registered_history`，1 通过；该测试仍拒绝不适用的显式 registration |
| 最终受影响组 | `TMPDIR=/private/tmp cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib --quiet -- project_file_maintenance::tests db::file_imports::tests db::file_versions::tests file_version_service::tests project_directory::bound_tests imported_file_legacy_registration_rejects_known_identity_or_registered_history`：97 通过、5 个既有辅助项 ignored、1 个导入崩溃恢复的旧待确认断言失败 |
| 失败项与通知边界复核 | 将导入崩溃恢复改为自动 ready 并增加版本数保持 1 的断言；静止 Driver 增加真实读取、隐藏日志和临时文件写入。仅重跑 `driver_finishes_initial_pages_then_never_rescans_static_scopes file_import_process_crashes_recover_without_stub_or_duplicate`：2 通过。其余源码未变，复用已通过结果 |
| 静默编译 | `cargo check --manifest-path src-tauri/Cargo.toml --locked --offline --quiet`：通过，仅既有警告；未修改前端命令、事件 DTO 或资源，未重复前端全量 |
| 文档与 diff | 检查本包 diff、相对链接与前后规则一致性；`git diff --check` 通过 |

上述结果按用例去重：165 通过、6 个既有子进程辅助项 ignored。不是全仓测试或 Windows 安装包验收。新增 `notify` 及其依赖；保留全部既有依赖版本与解析关系，只为既有 `mio` 启用通知后端所需的 `log`。

Cargo 在线索引出现长时间等待后，仅补齐缺失的官方 registry 元数据和归档缓存，归档 SHA-256 与官方索引核对，随后使用 `--locked --offline` 验证；没有修改发布网络配置。

### 双轴自查

- Standards：主 agent 检查完整 diff、锁顺序、订阅释放、回调与存储锁边界、事件合并预算及依赖范围。每个作用域只保留一个 dirty 标记与错误状态；静止项目目录检查只读 SQLite，失效订阅不回退周期文件树扫描。无剩余发现。
- Spec：按本轮两次用户修正逐项核对，无逐文件旧版确认、无静止目录周期重扫；仍保留新文件自动发现、分页公平、原代际隔离、真实冲突和版本完整性。针对性测试包含真实原生通知以及内部写入不自唤醒。无剩余发现。
- 未启动 review 子 agent。企业安全软件具体检测规则与修复后的 CPU 变化尚缺 Windows 侧采样，诊断记录中明确区分事实与推断。

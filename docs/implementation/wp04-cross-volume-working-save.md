# WP04：跨卷 File 工作副本保存

本机路径以 `<temporary-root>` / `<original-checkout>` 占位；命令变量须按执行机设置。原始路径保留于各包源提交及 WP00 外部证据，验证结果未变。

## 范围与验收

- 关联：ARCH-04 / CD-02；既有 File 跨归属移动规格 [Issue #304](https://github.com/xuchen-cloud/project_mind/issues/304)（未另建 Issue）。
- 基线：WP03 `428acbf794aa240dc960b565c7279aeec8d085fd`，其审查基线为 `ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`。
- 依赖：现有 FileEditSession、WorkingSave/WorkingStatus、owner/File lease、durable replacement、SQLite receipt/outbox 原子提交。
- 交付：stage/backup 位于 live 父目录内受 journal 身份控制的 `.pm-working-new/old-<token>`；journal 保存真实路径、文件及父目录身份；恢复兼容升级前历史目录 pending journal；不可变历史路径、hash、字节不改。
- 非目标：UI 参数、通用文件系统框架、搬迁旧历史、吞 EXDEV、盲目重试、跨包修改、推送/合并/发布。
- 验收：实际 owner move→文本/Office 保存→重开；逐阶段 SIGKILL 恢复；legacy pending 恢复；父目录替换/外部占用不覆盖且保留 journal；历史元数据/hash/字节不变。
- 验证范围：先定向 EXDEV 回归，再 working/owner move/恢复受影响原生用例；前端公共契约未改变时复用既有前端验证，不重复全量。真实第二卷、GUI、Windows/Linux、断电分别记录。

## 环境与继承限制

独立 worktree `<temporary-root>/project-mind-wp04-20261111`，分支 `codex/wp04-cross-volume-working-save`。没有修改原 checkout、WP03 worktree 或用户未提交文件。开始前检查无 Tauri/Vite 自动重启进程；编译与原生测试不启动窗口。

本机 macOS 卷挂载目录 只有指向 `/` 的 Macintosh HD，Workspace 与临时目录同为 系统数据卷设备。没有可用的第二数据卷；真实第二卷验收尚缺。解锁需要既有、允许使用的第二数据卷在同一 Workspace 内提供合法 Project 目录挂载，并实际完成 move→文本/Office 保存→重开。不会为此创建/格式化磁盘、变更网络或安全设置。

继承 WP03 台账：[WP03 报告](wp03-project-root-rename.md)。`imported_file_legacy_registration_rejects_foreign_physical_owner_and_forged_scope` 的 forged-scope 错误码基线失败保留；WP03 GUI 多窗口、Windows/Linux 真机、第二卷和断电未验收。隔离依赖/本机 Sherpa 库不等于 clean install。本包只做本地交付，不据单测关闭真实产品验收。

## 验证台账

### 缺陷复现与协议

`moved_file_working_save_keeps_renames_on_live_volume_and_history_immutable` 通过真实 A→B owner move 形成 live/历史分离，再在现有 exclusive rename 的测试边界模拟两个卷。修复前同一断言报 `IoFailed: Cross-device link (os error 18)`（`<temporary-root>/wp04-red.log`）；修复后通过（`<temporary-root>/wp04-green.log`）。这是真实 DB/文件/归属移动与注入的 EXDEV，不能称为真实第二卷实测。

新保存与既有 directory restore 一样，在 live 的既有父目录创建随机、排他的新文件。journal 的可选 `placement.live_parent` 保存该父目录的物理身份；新路径限定为同一父目录的 `.pm-working-new/old-<32 hex>`，两者 token 必须相同。文件本身继续用 inode/volume identity 与内容 hash 核验，路径仍经 Workspace 范围与符号链接检查。使用现有 `move_exclusive`，不覆盖目标、不回退到 copy、不吞 EXDEV；临时文件只在身份/hash 均吻合时删除。

stage 文件和目录先同步，再持久化 journal；两个 rename 使用已有同步 primitive，SQL state/BLOB/目录身份/receipt/outbox 同一事务提交。未提交按 old 回滚，已提交按 new 清理，不因之后外部编辑撤销已提交状态。清理同步后才清 journal，任何占用或父目录身份冲突保留材料。没有新增目录、schema 迁移、UI 参数或保存协调框架；不可变历史和 FileEditSession 不变。

旧 journal 缺少 `placement` 时，只接受该 File 原有 `history_dir_path` 下的 `working-new/old-<token>`；不把新路径规则无条件套到升级前 pending。旧格式没有持久父目录身份，不能凭空追溯补齐；仍执行原有文件 identity/hash/归属/路径及目录类型校验。旧跨卷尝试在第一次 rename 即 EXDEV，只会留下 prepared journal；该状态清理 stage 不需要跨卷 rename。

### 构建与验证口径

独立 Cargo target `<temporary-root>/project-mind-wp04-target` 从 WP03 target 作 APFS clone 后独立编译；`CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 TMPDIR="$BUILD_TMPDIR"`，使用 WP03 同版本 Sherpa ONNX 1.13.8 静态库。依赖与固定 Node 复用本机副本，不宣称 clean install。

Office 实测前从本分支源码构建 DOCX、XLSX engine/native sidecar、PPTX，再用 `office-distribution.mjs` 和 `stage-office-runtime.mjs` 校验、组装。XLSX 仅构建原生服务所需 engine/sidecar，未重建无改动的 GUI renderer；补齐现有 notices/LICENSE/NOTICE。最初分发组装因 engine-only 不产出 notices 中止，未执行测试；生成现有 notices 后重新组装。没有把不匹配的原 checkout Office bundle 当成本分支验证结果。

以下命令均使用上述独立 target/构建环境，日志在 `<temporary-root>/`。

| 验证 | 实际结果 | 日志 |
| --- | --- | --- |
| 新布局集中验证：working、owner move、WP03 根恢复和 startup | 45 passed、3 ignored；包含十次真实 SIGKILL（新增准备前时点随后由下项覆盖） | `wp04-native-validation.log` |
| 完整受影响范围 | 280 passed、1 failed、17 ignored；唯一失败为本次新增占用测试错误断言，见下方诊断 | `wp04-final-affected.log` |
| 占用失败单项诊断 | 稳定复现 revision 实际 1、断言 0；外部字节和 journal 已保留 | `wp04-occupant-diagnosis.log` |
| 修正断言、新增 moved legacy startup 后，仅重跑受影响 sidecar | 8 passed、0 failed；生产代码未改，复用完整套件其余 280 个通过项 | `wp04-final-volume-tests.log` |
| 普通及 moved 真实 Office working 保存 | 2 passed；每项内部覆盖 DOCX/XLSX/PPTX 两次保存、重开、单次归档、历史元数据/hash/字节 | `wp04-real-office.log` |
| 生产配置 `cargo check --lib --quiet -j 2` | 通过，覆盖非 `cfg(test)` 路径 | `wp04-production-check.log` |
| diff、Rust 格式和文档链接 | 通过 | 最终提交前检查 |

完整受影响命令：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j 2 -- \
  --test-threads=1 db::file_ db::project_directory file_office::tests \
  --skip imported_file_legacy_registration_rejects_foreign_physical_owner_and_forged_scope
```

WP03 已在固定审计基线上复现该排除项：拒绝 forged scope 时错误码为 `io_failed`，契约预期 `ownership_mismatch`。本包未改其导入/授权实现，不重复运行同一失败，不放宽断言。原失败和解锁条件仍见 WP03 报告，不能称为全库全绿。

失败诊断后的定向验证：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j 2 \
  db::file_working::tests::volume_tests -- --test-threads=1 --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j 2 \
  working_saves_share_fixed_base_and_archive_once -- --ignored --test-threads=1 --nocapture
```

占用测试最初误以为 placement 后出现额外 staged 文件会使 SQL 自动回滚。实际 live 仍是已核验的新文件，state/BLOB/receipt 已按原协议提交；清理随后遇到外部 staged 占用而报错、保留 journal。这不应撤销已提交结果。修正测试为：准备期占用保持 old；placement 后占用保留已提交 new；两者均不覆盖外部文件，并在 fixture 将占用移到保留位置后，用原请求验证精确重放/安全继续。只改测试预期，未改变生产逻辑或安全断言；随后八项全过。

### 实际覆盖与未测项

- working 的六个时点 × 普通/真实 A→B 移动两种布局，共十二次真实 SIGKILL：准备前、journal 持久化后、old 移走后、new 放置后、SQL/receipt 提交前、提交后清理前。重开核验 revision、live 字节、旧历史元数据/字节与原请求重放。全部是在本机同一物理卷的隔离 Workspace；不代表第二卷或断电验收。
- 升级前不含 `placement` 的四种 journal 状态；另有 moved legacy prepared journal 经真实 `Database::open` 启动恢复，并在 EXDEV 测试边界禁止跨历史/live rename。恢复清除自己 stage，保留无关命名文件和旧历史。
- 新 journal 的物理父目录替换（文件 inode 不变）、符号链接替换、backup 占用与 placement 后 staged 占用。冲突保留 journal、owned/foreign 字节；没有覆盖、扫除或吞错。
- 新路径无额外目录残留；temporary File 仍按既有隐藏文件规则从业务列表排除。旧不可变历史继续位于原 A 根；working save 不创建 File Version，显式/空闲归档保留原语义。
- 完整套件 17 个 ignored 中，11 个为由父测试显式启动的崩溃 helper；2 个 Office working 实测已单独执行。另 2 个真实系统回收站测试与 2 个其他 Office 固定版本实测未执行，不把 ignored 计为通过。清单：`wp04-ignored-tests.txt`。WP03 的真实 Record worker 既有证据复用，本包未重复。
- **真实第二卷 move→文本/Office 保存→重开仍未验收**。解锁必须提供同一 Workspace 内合法挂载、源历史与目标 live 的实际设备号不同；不能用 symlink 或注入单测代替。本轮没有 GUI 多窗口、Windows/Linux 真机、断电、前端全量或 clean install 证据。

## Standards / Spec 自检

- Standards：沿用现有内部保存 Module、文件 primitive、owner/File lease、commit fence 和原子 receipt/outbox；调用方与 Working DTO 未变。新增 wrapper 仅提供 EXDEV 测试边界，生产仍直接使用原 exclusive rename。没有通用文件系统层、额外重试、路径 alias 或跨包重构。新临时目录方案在实现期间弃用，最终布局与已有 restore 一致。
- Spec：新保存/旧 pending 两种布局各有严格路径规则；新父目录 identity 与真实文件 identity/hash 一起验证；旧历史原位，外部占用保留，CAS/权限/幂等与同步未削弱。已执行场景无剩余代码发现；真实第二卷是明确未完成的产品验收，不能据本地代码交付关闭 Issue。
- 依据仓库 Review agents 规则由主 agent 自检两轴，未启动 review 子 agent；实现子 agent 仅承担独立测试文件的明确编辑任务。

## 本地交付与整合

仅修改 `db/file_working.rs`、其现有/新增测试、`file_office_tests.rs` 与本报告。没有修改 `db.rs`、恢复入口或 schema，不与后续 WP06 争用这些文件；WP03 的根恢复顺序及 schema42 保持。

一次 `ps` 管道读取被 sandbox 拒绝（`operation not permitted`）；改用已有批准的独立 `ps -axo pid,command` 后读取成功，确认无 Tauri/Vite watcher。首次 `git add` 被 sandbox 拒绝创建 `<original-checkout>/.git/worktrees/project-mind-wp04-20261111/index.lock`，没有暂存或提交；显式升级执行权限重试相同五文件暂存后成功。没有改变权限策略、安全或网络设置，没有未解决的执行审批。

交付为独立分支上的本地提交，基于已核实的 WP03；未推送、合并 develop、创建 PR、部署、发布或写外部 Issue，未向其他工作包的用户会话发送消息。集成者可只读获取本报告、最终完整提交及上述日志。产品第二卷验收保持开放，不将阶段提交当成 Issue 完成交付。

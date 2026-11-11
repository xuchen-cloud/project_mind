# WP03: Project 根改名恢复与资源定位

本机路径以 `<temporary-root>` / `<original-checkout>` 占位；命令变量须按执行机设置。原始路径保留于各包源提交及 WP00 外部证据，验证结果未变。

## 范围

- 审查基准：`ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`。
- 发现：ARCH-02 → ARCH-01 → ARCH-03。
- 关联真实 Issue：[#62](https://github.com/xuchen-cloud/project_mind/issues/62)（Project 改名无需重写富文本、资源相对路径），[#304](https://github.com/xuchen-cloud/project_mind/issues/304)（跨归属移动保留身份与历史）。没有为本轮另建 Issue；#316 是集成 PR。
- 依赖：现有 owner lease、不可变 Record/File 历史、原生 outbox 事务和资源归属校验。
- 交付：持久 intent 与目录身份恢复；精确 Record 资源路径映射；迁入 File 的外部历史保持原位。
- 非目标：改写不可变快照/hash、放宽 Scope、覆盖外部占用、跨卷 working save（WP04）、Voice 标题（WP06）、发布或远端写入。

## 验收与验证范围

1. 隔离 Workspace fixtures，子进程在 intent/rename/SQL commit 前后真实强制退出；重开后 DB/FS 一致，外部占用不覆盖，冲突保留 intent。
2. 图片/附件 canonical Record 改名后 GUI 投影、编辑保存、Agent patch、历史预览/恢复保持可用，原 UUID/历史 hash 不变；其他 Project 资源仍拒绝。
3. Workspace→B、A→B 的 File 在 rename B 后保留原历史路径及字节，源根承载 foreign history 的保护继续生效。
4. 收口集中执行受影响原生保存/恢复测试；纯 Rust 改动不自动重跑前端全量。

## CD-01 契约

`Database::project_update(ProjectUpdateInput)` 是外部 Interface：调用者只提交稳定 Project ID 与新名称。一个原生 Module 负责意图、目录身份、FS、SQL/outbox 和恢复；已有 native SQL/outbox writer 和 owner lease 继续复用，不暴露 begin/stage/swap/commit。

| 角色 | 身份与位置 | 改名规则 |
| --- | --- | --- |
| Project | 稳定 ID，当前 root 可变 | owner lease 下身份核验与持久恢复 |
| File live | 稳定 File ID，当前位置在当前 owner 根内 | 随物理根移动，更新 DB 位置 |
| File immutable history | 版本 ID/hash 与字节不变，可位于旧 owner 根 | 根内位置随移动；合法根外位置保持原位 |
| Record canonical | 稳定 Record/版本身份，正文与 hash 不随根改名变化 | 不改不可变快照；只解析来源受约束的位置映射 |
| Record asset provenance | 该 Record 已持久的精确引用与实际来源 Project | 映射后仍按来源/Scope/托管路径校验，不变成任意旧前缀授权 |
| Foreign history/resource | 其他 owner 仍依赖本根的字节 | 继续拒绝源根改名/清理 |

参照追加审查 CD-01（`07a-native-module-design.md`）；没有新增通用重构工作包，也不扩张 WP04。

## 协议

- 项目独占 owner lease 覆盖预检、intent、物理改名、业务行/路径映射/outbox 的同一次 SQL 提交及恢复清理。
- intent 位于 Workspace 内部元数据目录，包含 Workspace 身份、项目 ID、旧/新相对根及目录物理身份；不写进尚未提交的业务事务。
- intent 先落盘，再执行不覆盖目标的 rename；恢复读取已提交的 Project 根。旧根表示回滚目录移动，新根表示保留已提交结果。任何身份冲突均保留 intent 并失败。
- canonical Record 仅增加该 Record 已持久资源的精确路径映射；不可变 JSON、UUID/hash 不变。解析后的路径继续通过现有 Scope、托管路径和符号链接检查。
- File live 路径必须位于旧根；历史路径仅在实际位于旧根时重设前缀，合法外部历史不改。

## 验证台账

执行环境：macOS arm64，隔离 worktree 与临时 Workspace，不启动 Tauri 窗口；使用独立 Cargo target、`CARGO_PROFILE_DEV_DEBUG=0`、`CARGO_INCREMENTAL=0`、`TMPDIR="$BUILD_TMPDIR"` 和与锁定依赖对应的 Sherpa ONNX 1.13.8 本地静态库。

### 缺陷复现

| 发现 | 修复前实际结果 | 证据日志 |
| --- | --- | --- |
| ARCH-02 | 真实 SIGKILL 到物理 rename 后，重开断言 `DB root missing after reopen` 失败 | `wp03-red-clean.log` |
| ARCH-01 | 改名后历史图片/附件投影被拒绝：`ScopeDenied: Record asset is outside this Project` | `wp03-record-red.log` |
| ARCH-03 | Workspace→B、A→B，分别单版本和多版本，四项均被 `document history … is outside project root` 阻断 | `wp03-history-red.log` |

日志保存在本轮临时证据目录；修复前后的测试使用相同业务断言，没有把安全断言改为允许。

### 收口验证与复用

| 验证 | 命令/范围 | 实际结果 |
| --- | --- | --- |
| 本包初次集中验证 | `cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j2 project_root_rename_ -- --test-threads=1` | 12 passed，1 ignored；ignored 是由父测试显式调用的崩溃子进程 helper |
| 完整受影响范围 | 下方集中命令 | 409 passed，4 failed，23 ignored；逐项诊断见下方，未伪报全绿 |
| 最终受影响改动及失败项重跑 | 下方定向命令 | 23 passed，0 failed，1 ignored；包含全部本包原有用例、native outbox、schema40 升级，以及两项真实 Record worker 用例 |
| 连续改名的真实转换链 | `cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j2 project_root_rename_real_worker_saves_new_paths_then_patches_and_restores -- --ignored --nocapture` | 1 passed；明确执行需准备运行时的新增集成用例，日志 `wp03-real-worker.log` |
| 生产配置编译 | `cargo check --manifest-path src-tauri/Cargo.toml --lib --quiet -j2` | 通过；覆盖非 `cfg(test)` 编译路径 |
| 改动与格式 | `git diff --check`；四个新增 Rust 模块的 `rustfmt --check --edition 2021` | 通过 |

完整受影响范围（执行一次，日志 `wp03-affected-suite.log`）：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j2 -- \
  --test-threads=1 db::native_changes:: db::record_ db::file_ \
  db::startup_tests:: db::project_directory db::project_root_rename_ \
  record_document_service:: file_version_service:: file_working::tests
```

最终定向命令（日志 `wp03-final-validation.log`）：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j2 -- \
  --test-threads=1 project_root_rename_ db::native_changes:: \
  g15_upgrade_schema40_preserves_version_bytes_and_defaults \
  g13_resource_subdirectory_and_single_file_guard_retains_foreign_record_assets \
  g13_review_retained_moved_reference_saves_but_new_copies_are_rejected
```

没有重复执行整套。集中验证后生产逻辑仅移动了测试崩溃 hook 的归属，重跑本包与 native writer 受影响范围；新增安全负例与 schema 断言修正也在最终定向命令中验证。其余通过项沿用同一源码、锁文件和工具链的结果。

四项集中失败的处理：

1. `g15_upgrade_schema40_preserves_version_bytes_and_defaults`：原断言硬编码 schema 41；迁移现在是 42。改为比较当前 schema 常量，保留历史字节及默认值断言，重跑通过。
2. 两项 `g13_*`：隔离 worktree 缺少固定 Node runtime 和构建好的 Record worker，报 `RuntimeUnavailable`。在本 worktree 克隆已有依赖与固定 runtime，执行 `npm run build:record-worker`，随后两项均通过。依赖是本机副本，不宣称 clean install；未修改原 checkout。
3. `imported_file_legacy_registration_rejects_foreign_physical_owner_and_forged_scope`：第二个 forged-scope 断言实际 `io_failed`，预期 `ownership_mismatch`。从固定审计提交单独 `git archive` 的原始代码执行相同用例，得到完全相同失败（`wp03-unrelated-baseline.log`）。本包未放宽断言、未修改该导入路径。记录为后续文件注册错误分类修复，解锁条件为保持拒绝伪造归属并返回契约错误码。这是完整套件仍存在的已有失败，因此不满足全绿发布门禁。

### 实际覆盖

- SIGKILL 五个时点：intent 前、intent 持久化后、物理 rename 后、SQL/outbox 提交前、提交后清理前。重开检查 DB/FS、File 版本 ID/hash/字节、Record body hash、outbox 水位和重复恢复。外部占用保护单独实测；移除仅属于 fixture 的占用后可以恢复。
- canonical 图片/附件：当前编辑器投影、GUI 路径规范化、native save、Agent patch prepare/preview/commit、历史 restore、二次改名及历史 UUID/hash/JSON/HTML 不变。其他 Project、未保留同级资源及符号链接负例继续拒绝。
- 真实固定 Node/Record worker：第一次改名后把 GUI 规范化的新路径经 `record.validate` 保存成新 canonical，再二次改名，执行真实 `record.patch` 和旧历史 `record.validate`/restore。新旧两组引用均能解析，原历史 JSON/hash 保持不变；这条测试在上述定向 23 项之后新增并单独显式执行，没有把 ignored 当成通过。
- File：Workspace→B、A→B，分别 v1 和三版本；native 导入/版本/working session/owner move 后 rename B，完整版本元数据、注册 hash、历史路径和实际字节保持一致；源 A 仍承载 B 历史时拒绝改名。
- schema41→42 升级、schema40 升级、失败保持旧版本并可重试；runtime connection 可以使用新映射。新表和 `user_version` 在同一事务提交。

### 覆盖边界

本轮实际完成原生服务与文件系统验收；未执行 GUI 多窗口、Windows/Linux 真机、真实第二卷或断电测试。SIGKILL 证明进程崩溃恢复，不代表断电持久性已验收。无前端 DTO/命令/事件更改，未自动重跑前端全量。原审查三项仅为静态确认，本轮增加了实际证据，但不据此关闭 Issue 或宣称全部产品平台验收完成。

构建准备中发生的旧 target 缓存失效、Swift 缓存写入限制和依赖下载 TLS 失败均为环境问题；使用独立干净 Cargo target、本机同版本 Sherpa 库及隔离依赖后完成编译，不以旧缓存的错误宣称产品回归或验证通过。

## Standards / Spec 自检

- Standards：外部 `ProjectUpdateInput` 未扩展；持久化流程归入一个内部 Module，复用 owner lease/fence、no-clobber move、目录身份和原生 SQL/outbox。移除旧 RAII-only 补偿；不增加通用 journal 框架、重试层或宽泛路径 alias。仅测试 hook 使用环境注入，生产分支无崩溃注入行为。
- Spec：历史 UUID/hash/正文不改写；确切资源映射随 Record rekey，仍经来源 Scope、managed path、document ID 及 symlink 校验；外部历史按物理包含关系保留，源根保护未削弱。失败保留恢复材料，不覆盖外部目录。
- 两轴由主 agent 自检，未启动未经同意的 review 子 agent。WP03 未发现剩余阻塞问题；上述已有测试失败及平台验收限制保留。此结论适用于本地工作包，不表示满足自动合并/发布门禁。

## 串行整合说明

- 本包基于固定审计提交，没有合并原 checkout 的未提交改动；交付为本地独立分支提交。
- 共享入口 `db.rs`：schema 41→42、新模块声明、启动先恢复 Project 根、移走旧 rename 实现；`native_changes.rs` 保留 SQL/outbox writer，Project update 调度移入新模块。
- `file_flow_migration.rs` 的最终 schema 步骤接入新表；`project_directory_changes.rs` 仅放宽内部 `directory_identity` 可见性。`record_owner_moves.rs` 的源根保护解析精确映射。
- 后续包整合时需保留恢复顺序和 schema42 表定义，逐项解决 `db.rs` 等共享文件交集；WP04 的跨卷 replacement 和 WP06 的 Voice 标题不在此提交。
- 只允许本地提交；未执行 push、PR、merge、部署、发布或外部 Issue 写入。

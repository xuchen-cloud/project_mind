# WP06：Voice 稳定标题后缀

## 范围与验收

- 关联：VC-02；[Voice Record Issue #94](https://github.com/xuchen-cloud/project_mind/issues/94)、[D-13 标题](../requirements/voice-record-decisions.md#d-13-标题)。未另建修复 Issue，原审查关联 PR #316 不是本包 Issue。
- 基线：WP04 `04bb493c882184c1220f59c6d86944075065cca8`，已核实包含 WP03 `428acbf794aa240dc960b565c7279aeec8d085fd`；原审查基线 `ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`。
- 依赖：现有 Recording Session 的 `started_at`、`voice_minutes_apply` 的 SQLite 事务及版本 CAS；WP03/WP04 已提交实现直接复用。
- 交付：纪要成功时把模型标题与固定 Recording Session 开始时间组合为 `AI 生成标题 · YYYY-MM-DD HH:mm`，Workspace/Project 共用事务内计算。
- 时区：AI 纪要标题使用 UTC。`started_at` 由 `now_iso()` 以 UTC 持久化；解析后显式转 UTC，不读取生成时刻或本机时区，重开、跨日、时区变化后后缀相同。创建录音的既有默认标题流程不在本包范围。
- 非目标：改变 AI 覆盖用户手动标题的 D-13 行为、模型协议、DTO、前端、录音设备/付费 Provider、共享恢复入口或 WP03/WP04 协议；不推送、合并、发布或关闭 Issue。
- 验收：Workspace/Project 均保存稳定后缀；固定历史开始时间与生成日期不同；连续生成仍用同一开始时间且不叠加后缀；手动标题可被后续成功纪要覆盖；CAS 失败不改纪要/标题。
- 验证范围：先通过既有原生纪要事务测试复现裸标题问题，再验证新增场景和全部原生纪要事务/处理测试、必要 Rust 编译及 Standards/Spec 自查。不运行无关前端全量。

## 隔离与执行记录

独立 worktree `/private/tmp/project-mind-wp06-voice-stable-title-20261111`，分支 `codex/wp06-voice-stable-title`。原 checkout 的用户未提交工作和其他组工作树保持原样。修改前检查未发现 Tauri/Vite watcher。只做本地提交，由 WP00 统一集成。

## 实现

`voice_minutes_apply` 在原有 Immediate 事务内、版本 CAS 成功后，同一次 Recording Session/Voice Record 查询读取 `started_at`。RFC3339 解析并显式转 UTC 后，追加到裁剪空白的模型标题；Workspace 和 Project 的原有 UPDATE 共用该值。纪要和标题继续一次提交；解析失败返回原因，不使用当前时间兜底。模型标题的既有 80 字限制、模型输出协议、DTO、Transcript、用户正文和恢复入口均未改。

Workspace 既有测试改为固定历史录音时间 `2020-09-24T23:30:45-07:00`，独立预期是 UTC `2020-09-25 06:30`，故同时检查 UTC 换日和生成日期不同。初始标题故意仍写另一日期，证明后缀不从旧标题推导。测试继续覆盖后续 AI 标题覆盖手动标题，并新增 CAS 失败时版本、纪要、生成时间和手动标题都不变的断言。

Project 新测试固定 UTC 午夜前最后一秒（含小数秒），通过真正的创建、转写、纪要应用、重开 Database、手动改名、再次生成及 Project page 读取，确认秒数不四舍五入、后缀不叠加、归属正确且开始时间持久稳定。固定历史时间通过测试 fixture 写入；没有修改系统时钟，也没有等待真实跨日。

## 验证台账

源码基于上述固定基线，最终 `src-tauri/src/db.rs` blob 为 `218e7fc9d221aca02104978db5a0a98bba29a217`。以下检查全部对应此源码（red 阶段除外）；后续仅追加本报告，不重跑已有效的验证。

构建环境为本机 macOS arm64，独立 Cargo target `/private/tmp/project-mind-wp06-target` 从 WP04 target 作 APFS clone 后独立使用；没有写入 WP04 target。沿用 `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 TMPDIR=/private/tmp` 和锁定版本 Sherpa ONNX 1.13.8 本地静态库。依赖复用不代表 clean install；测试与编译没有打开应用窗口或录音设备。

| 检查 | 实际结果 | 日志（`/private/tmp/`） |
| --- | --- | --- |
| 修复前 Workspace 回归 | 0 passed / 1 failed；实际 `发布计划`，期望 `发布计划 · 2020-09-25 06:30`，exit 101 | `wp06-red.log` |
| 最小实现后的同一回归 | 1 passed / 0 failed | `wp06-green.log` |
| 最终源码的 `minutes` 集中范围，`TZ=UTC` | 12 passed / 2 failed / 0 ignored；两项失败均为本机回环端口 bind 被 sandbox 拒绝，不是产品断言失败 | `wp06-minutes.log` |
| 仅重跑上述两项本地模拟 HTTP 测试 | 提升执行权限后 2 passed / 0 failed（21.03s）；未访问真实 Provider | `wp06-http-retry.log` |
| Workspace/Project 标题回归，`TZ=Asia/Shanghai` | 2 passed / 0 failed | `wp06-tz-shanghai.log` |
| 同两项回归，`TZ=America/Los_Angeles` | 2 passed / 0 failed；与 UTC/上海使用相同字面量后缀 | `wp06-tz-los-angeles.log` |
| 非 `cfg(test)` 配置 `cargo check --lib --quiet -j 2` | exit 0 | `wp06-production-check.log` |
| 变更函数的 Rust 格式、diff 空白及本报告本地链接/锚点 | 通过 | 最终提交前检查 |

集中测试范围为 14 项：纪要 schema/事务/preview、取消重开与迟到 gap、原生 processing、模型输出与本地 HTTP 取消/长生成、纯逻辑五分钟暂停。最终 14 项分别已有通过结果；未把第一次集中执行称为全绿，也未无理由重跑已通过的 12 项。测试名称清单保存在 `wp06-minutes-list.txt`。

上述命令均在本 worktree 运行，使用前述 Cargo/静态库环境：

```sh
TZ=UTC cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -j 2 minutes -- --test-threads=1 --nocapture
cargo check --manifest-path src-tauri/Cargo.toml --lib --quiet -j 2
git diff --check
```

HTTP 失败项使用 libtest 的两个完整名称仅重跑失败范围；时区验证只重跑两个标题回归。格式验证将 `rustfmt --edition 2021 --config skip_children=true --emit stdout src-tauri/src/db.rs` 输出到本包临时文件，比较三个变更函数，结果一致；未全量格式化已有的大文件。

## Standards / Spec 自查

- **Standards：0 项发现。** 按 code-review 技能的清单检查固定基线至本包 diff。遵循既有数据库事务、作用域、CAS 和错误传播方式；必要日期解析在唯一实际写入处执行，无兼容层、重试、全局时区修改或通用日期框架。测试用真实 Database 接口观察行为，只有时间 fixture 在系统边界写入；没有新增 Provider mock 协议或改动其他包。
- **Spec：0 项发现。** 对照 D-13 和 WP06：Workspace/Project 都追加 Recording Session 开始时间；日期固定且 UTC 明确；跨日、跨进程时区、重开及反复生成稳定；仍允许成功纪要覆盖用户标题；模型标题协议与 DTO 不变。事务 CAS 失败不产生部分更新。
- 由本会话自行完成两轴检查，未启动 review 子 agent、其他分组或向其他会话发送消息。只有 `db.rs` 的纪要事务/对应测试和本报告发生变更。

## 限制与交付边界

- 本包没有 UI/真实录音/付费 Provider、Windows/Linux 实机、全库测试、前端全量、安装包或 clean install 证据。UTC 标题规则由原生事务验证，不据此宣称整个 Voice 产品验收完成。
- 继承 [WP03](wp03-project-root-rename.md) / [WP04](wp04-cross-volume-working-save.md) 的既知基线失败：`imported_file_legacy_registration_rejects_foreign_physical_owner_and_forged_scope` 错误码实际 `io_failed`、预期 `ownership_mismatch`。本包未改该路径、未重跑或放宽断言。
- WP03/WP04 的真实第二卷、Windows/Linux、多窗口及断电等缺项仍在原报告中开放；本包没有新增这些验收证据，不将本地提交当作全库发布门禁通过。
- 一次管道 `ps` 读取被 sandbox 拒绝；使用已批准的独立 `ps -axo pid,command` 后读取成功。两项 HTTP 测试首次 bind 被拒绝后，显式申请提升执行权限，仅重跑该失败范围并通过；没有改变权限策略、网络或安全设置。
- 仅本地提交，未推送、合并 develop、创建 PR、关闭 Issue、部署或发布。唯一集成者为 WP00；原 checkout 的用户未提交工作保持原样。

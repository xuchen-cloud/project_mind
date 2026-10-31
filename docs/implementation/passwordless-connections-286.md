# 无系统密码弹窗的连接凭据（#286）

日期：2026-10-31。关联 Issue：[移除连接钥匙串密码提示 #286](https://github.com/xuchen-cloud/project_mind/issues/286)。状态：实现与自动验证完成；修复版桌面重启验收待执行。

## 依赖与交付行为

依赖 [#256](https://github.com/xuchen-cloud/project_mind/issues/256) 已建立的 Workspace 免密码打开和本地密钥边界，并复用现有 Scope Grant、Workspace 绑定、权限检查、版本 CAS、撤销和 Operation Receipt。[ADR-0011](../adr/0011-open-workspaces-without-a-user-password.md) 记录本次扩展决策。

应用与 CLI 统一从 `local_data_dir()/connection-credentials` 读写连接凭据，不再访问操作系统钥匙串。以 32 位十六进制授权 ID 定位私有文件，内容为随机的 64 位十六进制 token。数据库保存哈希和 `localCredentialVersion`，不保存 token 明文。Unix 目录为 `0700`、文件为 `0600`；Windows 使用应用数据目录继承的 ACL。文件写入采用原子持久化与同步，不能将未持久化的 token 对应哈希提交到数据库。

`WorkspaceRuntime` 启动时，在助手可使用连接前，基于受信任的本地数据库迁移版本 `0` 的启用且未撤销授权。迁移先写本地 token，再通过 SQL CAS 更新旧哈希和版本 `1`，保留 ID、作用域、权限、时间戳与历史回执。写文件后、SQL 提交前中断，重试复用待提交文件。禁用或已撤销授权不变。新授权使用版本 `1`；已迁移授权的文件丢失或损坏显式报错，不自动生成新 token。

## 非目标与安全边界

- 不读取、删除或回退到历史钥匙串条目；旧条目保持原样。
- 不修改 Workspace 密钥、API Key 密文或 #256 的历史 Workspace 密钥迁移。
- 不扩张连接权限，不改变 Workspace 绑定、CAS、撤销和回执语义。
- 不承诺同一操作系统用户下的进程隔离：可读取应用数据目录的进程可获得 token。私有文件权限限制其他用户访问，应用内授权限制连接实际可执行的操作。

## 验收条件

1. 新建、列出、读取、更新、使用及撤销连接的实际应用与 CLI 路径不调用操作系统钥匙串，不出现由连接凭据访问触发的系统密码弹窗。
2. 应用与 CLI 共用同一凭据存储；授权 ID 与 token 格式有明确校验，缺失或损坏显式失败。
3. 旧启用且未撤销的版本 `0` 授权在 runtime 启动时完成 token 轮换，旧 token 失效；迁移不改变授权和回执身份、作用域、权限或时间戳。
4. 迁移在文件持久化后、数据库提交前中断可恢复并复用文件；SQL CAS 防止覆盖并发变化，禁用及已撤销授权不被迁移。
5. 新授权直接标记版本 `1`；已迁移授权不因文件缺失或损坏被静默再生。Unix 权限及文件持久化行为符合 ADR。
6. Workspace 归属、权限、版本 CAS、撤销与跨工作区失效回归通过。

## 验证范围与记录

本包以 Rust 凭据存储、数据库迁移、Workspace runtime 启动和 CLI 连接路径为针对性验证范围；覆盖私有文件权限、格式错误、缺失文件、迁移保真、崩溃恢复、CAS 冲突、撤销与 Workspace 绑定。涉及跨端 DTO、命令或构建资源时补对应前端或集成验证。发布前执行仓库要求的完整验证和 Standards / Spec 双轴自查；未经用户明确同意不启动 review 子 agent。

验证基线为 `438095f7`，以下结果对应本分支本包 Rust 改动。复用同一后端构建缓存，测试不启动应用窗口；未改变前端 DTO、命令、事件或前端源码，不重复前端全量。

| 命令（均加 `--manifest-path src-tauri/Cargo.toml --quiet`） | 实际结果 |
| --- | --- |
| `cargo test --lib agent::bridge` | 229 通过、9 个显式集成用例忽略；新加客户端用例最初因测试 ID 多一位失败，修正为合法 ID 后定向重跑通过，不重跑其余已通过用例 |
| `cargo test --lib passwordless_tests::local_file_credentials` | 1/1 通过，真实 socket + 持久化文件重开、只读权限与撤销 |
| `cargo test --lib credential` | 27 通过、2 忽略；额外命中的 DSH 模型目录用例因本工作树缺局部依赖退出，确认 `ERR_MODULE_NOT_FOUND` 后复用本机已安装依赖，仅重跑该失败项 |
| `cargo test --lib dsh_assistant::tests::native_carrier_model_catalog_keeps_credentials_out_of_profile_labels` | 1/1 通过 |
| `cargo test --lib keychain_migration` | 1/1 通过，真实 SQLite + 本地凭据文件 + 原内置助手身份及回执复用 |
| `cargo test --lib db::agent_connections` | 23/23 通过，包含本包 7 项迁移测试 |
| `cargo build --bin mind --bin project_mind_alpha` | 通过；既有 unused/dead-code 警告未扩展处理 |
| `cargo test --lib real_cli_uses_local_file_credentials_without_keychain -- --ignored` | 新构建的 debug `mind` 真实子进程 1/1 通过，临时 App data，无运行时临时令牌环境；`doctor` 成功、撤销后 `SCOPE_DENIED` |

最终凭据目录创建和同步改动后，`credential` 范围内文件存储测试（含缺失 App data 父目录）已通过；本包客户端和原生回执路径也均在最终源码上通过。Cargo lock 删除 21 项独占依赖，没有新增或升级包版本；不再包含 keyring 包。历史大型 CLI/MCP 测试改为临时文件凭据，清除继承的执行令牌环境，消除对用户凭据目录的测试读写；其相关存储路径由本包真实 CLI 用例覆盖，本次未扩大执行无关 Office 编辑流程。

主 agent 自行完成 Standards / Spec 两轴检查：实现复用现有授权与本地数据目录；迁移只更新哈希及私有版本标记、逐行 CAS，文件写入与祖先目录同步失败显式返回，已迁移凭据缺失不再生；不访问旧钥匙串、撤销和作用域限制保持有效，实际 CLI 验证覆盖生产发现与凭据读取路径。两轴没有剩余发现，未启动 review 子 agent。文档 diff、相对链接、规则一致性及 `git diff --check` 通过。Windows 未做本轮实机验收，不据此声称平台验收完成。

产品验收需重新构建并安装应用及 CLI，停止旧进程后重启，再检查连接流程。旧安装或仍运行的旧进程不包含本次变更，可能继续访问钥匙串。界面验收前告知用户并集中执行；构建和单元测试保持静默，不启动应用窗口。全部门禁满足后按 [发布流程](../agents/publish-flow.md) 合并并确认 Issue 关闭。

# Open Workspaces without a user password

2026-10-25，依据用户明确要求及 [#256](https://github.com/xuchen-cloud/project_mind/issues/256)，Workspace 在 debug 与 release 中统一取消用户密码和手工锁定/解锁。

新建 Workspace 使用随机生成的本地密钥，和元数据一起保存于 `.project-mind/workspace.json`；元数据以原子替换写入，在 Unix 上权限为 `0600`。API Key 继续使用现有密文格式保存，但本地密钥随 Workspace 存放，因此不提供独立于目录访问权限的密码保护。复制 Workspace 时配置与密钥一起携带。

打开时先加载并校验本地密钥，再通过共享 `open_workspace_database` 初始化数据库。密钥缺失或损坏不能静默重新生成。Workspace 归属、Scope Grant、版本 CAS、原生权限与跨工作区失效规则不变。

旧密码格式仅用于读取历史 Workspace。迁移时优先复用可验证的开发本地缓存密钥；debug 验收配置中的显式 fixture 密钥仍可用于历史数据迁移。迁移完成后不再依赖缓存或环境变量。没有原密钥时生成本地密钥，保留原 API Key 密文；这些旧凭据无法解密，用户需在模型设置中重新填写 API Key。读取缓存失败或缓存密钥错误须显式失败，不能误判成没有缓存。元数据写入失败保留原文件。

UI 删除新建密码字段、解锁弹窗、解锁菜单/API 和 AI 设置中的密码门槛。既有 DTO 中的 `aiSecretsUnlocked` 保留作为凭据初始化状态；应用创建的 Workspace runtime 在成功打开后始终有密钥。

2026-10-31，依据 [#286](https://github.com/xuchen-cloud/project_mind/issues/286)，将免密码打开的边界补齐到外部连接凭据。连接不再读写或删除操作系统钥匙串，也不以钥匙串作为回退；历史钥匙串条目保持原样，避免迁移本身触发系统密码弹窗。

应用与 CLI 共用 `local_data_dir()/connection-credentials`，每个凭据文件以 32 位十六进制 Scope Grant ID 命名，保存随机生成的 64 位十六进制 token。文件原子持久化并同步；Unix 目录权限为 `0700`、文件权限为 `0600`，Windows 依赖应用数据目录继承的 ACL。数据库只保存 token 哈希及 `localCredentialVersion`。连接授权仍需核验 Workspace 绑定、Scope Grant、操作权限、版本 CAS 与撤销状态。

在 `WorkspaceRuntime` 启动且助手可使用连接前，通过受信任的本地数据库迁移处理 `localCredentialVersion = 0` 且启用、未撤销的历史授权：先持久化新的本地 token，再以 SQL CAS 替换旧哈希并将版本设为 `1`。迁移保留授权 ID、作用域、权限、时间戳和 Operation Receipt；禁用或已撤销的授权不变。在文件写入后、数据库提交前崩溃，重试复用已落盘的待提交 token。新授权直接使用版本 `1`；已迁移授权的凭据缺失或损坏必须显式失败，不得静默重新生成。

此方案以同一操作系统用户的文件访问权限为安全边界：能够读取该用户应用数据目录的进程也能读取连接 token，不再提供钥匙串隔离；应用内授权与撤销约束仍然成立。旧 token 在数据库轮换后失效。验收必须使用重新构建、安装并重启后的应用与 CLI，仍在运行的旧二进制可能继续调用钥匙串。实现和验证范围见 [#286 工作包](../implementation/passwordless-connections-286.md)。

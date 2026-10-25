# Open Workspaces without a user password

2026-10-25，依据用户明确要求及 [#256](https://github.com/xuchen-cloud/project_mind/issues/256)，Workspace 在 debug 与 release 中统一取消用户密码和手工锁定/解锁。

新建 Workspace 使用随机生成的本地密钥，和元数据一起保存于 `.project-mind/workspace.json`；元数据以原子替换写入，在 Unix 上权限为 `0600`。API Key 继续使用现有密文格式保存，但本地密钥随 Workspace 存放，因此不提供独立于目录访问权限的密码保护。复制 Workspace 时配置与密钥一起携带。

打开时先加载并校验本地密钥，再通过共享 `open_workspace_database` 初始化数据库。密钥缺失或损坏不能静默重新生成。Workspace 归属、Scope Grant、版本 CAS、原生权限与跨工作区失效规则不变。

旧密码格式仅用于读取历史 Workspace。迁移时优先复用可验证的开发本地缓存密钥；debug 验收配置中的显式 fixture 密钥仍可用于历史数据迁移。迁移完成后不再依赖缓存或环境变量。没有原密钥时生成本地密钥，保留原 API Key 密文；这些旧凭据无法解密，用户需在模型设置中重新填写 API Key。读取缓存失败或缓存密钥错误须显式失败，不能误判成没有缓存。元数据写入失败保留原文件。

UI 删除新建密码字段、解锁弹窗、解锁菜单/API 和 AI 设置中的密码门槛。既有 DTO 中的 `aiSecretsUnlocked` 保留作为凭据初始化状态；应用创建的 Workspace runtime 在成功打开后始终有密钥。

# Beta release

ProjectMind 使用公开的 `xuchen-cloud/project_mind` 源码仓库构建桌面应用，
并在同一仓库分发安装包、Updater 资产和 Beta 更新清单。应用固定读取：

```text
https://raw.githubusercontent.com/xuchen-cloud/project_mind/main/beta/latest.json
```

## One-time GitHub setup

源码仓库需要一个 `main` 分支，并允许 GitHub Actions 以 `contents: write`
权限创建 Release 和更新 `beta/latest.json`。仓库只需配置：

- `TAURI_SIGNING_PRIVATE_KEY`：本机
  `~/.tauri/project-mind-updater-v2.key` 的完整内容。
- 当前私钥使用空密码生成；工作流显式设置空的
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，无需额外 Secret。
- Apple 和 Windows 的正式代码签名凭据可随后加入；Updater 的 Tauri 签名不能代替操作系统代码签名。

当前工作流对 macOS 使用 ad-hoc 签名，Windows 安装包也尚未配置 Authenticode
代码签名，因此只适合内部或已知测试者。面向外部测试者分发前，应先加入 Apple
Developer ID、公证和 Windows 代码签名，避免 Gatekeeper 或 SmartScreen 警告。

Tauri Updater 私钥不得提交到任何仓库。丢失私钥后，已安装版本无法验证后续更新。

## Publish a Beta

1. 在 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml`
   中同步递增数字版本，并更新两个 lockfile。
2. 完成仓库规定的完整验证和 Standards / Spec 双轴 review。
3. 合并版本提交到 `main`。
4. 从该提交创建并推送标签，例如 `v0.1.0-beta.1`。
5. `Publish desktop Beta` workflow 会验证、构建三个桌面目标，在源码仓库创建
   Pre-release，验证合并后的 `latest.json`，再推进 `beta/latest.json`。

Windows 只发布 NSIS `setup.exe`；macOS 分别发布 Apple Silicon 与 Intel DMG。
应用内更新使用对应的签名更新资产，不会删除或移动 Workspace。

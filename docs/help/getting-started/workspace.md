# 创建与打开 Workspace

你可以从起始页创建新的本地 Workspace，或打开已有 Workspace；进入后，Project、Workspace Record 和 Workspace Todo 都在这条长期边界内组织。Workspace 密码只保护保存的 AI API Key，当前主界面没有切换 Workspace 的入口。

## 创建新的 Workspace

1. 在起始页点击“新建 Workspace”。“新建 Workspace”对话框出现。
2. 在“Workspace 根目录”中填写目录，或点击“选择”使用系统目录选择器。选中的目录将成为 Workspace 的根目录。
3. 输入非空的“Workspace 密码”，点击“创建 Workspace”。成功后，Project Mind 在根目录下建立 `.project-mind` 目录，并进入 Workspace 主界面。

<!-- VISUAL P0-WORKSPACE-01
type: 真实 UI 连续步骤
capture: 两幅连续图：Workspace Gate 点击“新建 Workspace”前；创建对话框已选虚构根目录、密码用圆点遮挡、创建按钮可用。保留触发入口与对话框标题。
purpose: 证明创建入口、必填项和提交按钮之间的关系。
asset: ../assets/getting-started/create-workspace.png
alt: 从 Workspace Gate 打开新建 Workspace 对话框
text-review: 补图后复核“Workspace 根目录”“选择”“Workspace 密码”“创建 Workspace”的实际界面文字；图片已经显示的字段不要在正文逐像素重复。
status: pending-user-capture
-->

如果这个目录已经包含 Project Mind 的 Workspace 元数据，创建不会覆盖它。关闭对话框，改用“打开已有 Workspace”。

## 打开已有 Workspace

1. 在起始页点击“打开已有 Workspace”。系统目录选择器随即出现。
2. 选择原 Workspace 的根目录，而不是根目录中的 `.project-mind`。确认后，Workspace 主界面出现，原有内容可继续使用。

打开 Workspace 本身不会要求 Workspace 密码。打开后，已保存的 AI API Key 仍处于锁定状态；读取或保存 AI API Key 时，才需要输入密码解锁。

起始页的“最近使用的 Workspace”列出最近成功打开过的 Workspace。点击其中一项会直接尝试打开对应根目录。启动应用时，如果上次使用的 Workspace 仍可读取，Project Mind 会直接重新打开它，因此你可能不会看到起始页。

## 密码保护什么

Workspace 密码的边界很窄：

- 它用于加密或解密保存在 Workspace 中的 AI API Key。
- 它不是打开 Workspace 的登录密码。
- 它不会加密整个 Workspace、数据库或普通的 Project、QuickNote、Record、Todo、File 内容。

因此，密码不能替代设备登录、磁盘加密或目录访问控制。关于本地数据边界，继续看[资料保存在什么地方](../trust-and-help/local-data.md)。

## 当前不能在主界面切换 Workspace

进入某个 Workspace 后，当前主界面没有“切换 Workspace”或“返回起始页”入口。标题下显示的根目录路径可以点击，但它只会在系统文件管理器中打开该目录，不会切换 Workspace。

只有起始页实际出现时，才能通过“打开已有 Workspace”或最近列表选择另一个 Workspace。请不要为了切换而移动或删除 `.project-mind`；当前版本没有主界面内的安全切换流程。

## 接下来

- 上一级：[开始使用](README.md)
- 上一篇：[10 分钟完成第一次工作闭环](10-minute-start.md)
- 下一步：[看懂界面、归属与 View](scopes-and-views.md)
- 相关：[资料保存在什么地方](../trust-and-help/local-data.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->

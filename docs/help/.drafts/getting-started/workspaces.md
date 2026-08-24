## 创建、打开与切换 Workspace

Workspace 是 Project Mind 中长期存在的工作与知识边界。你的 Project，以及不属于某个阶段性 Project 的 QuickNote、Record 和 Todo，都在当前 Workspace 的范围内组织。开始使用前，先确认自己进入了正确的 Workspace。

> Workspace 密码保护的是保存在这个 Workspace 中的 AI API Key。它不会加密整个 Workspace、数据库或普通内容，也不是打开 Workspace 的登录密码。

### 创建一个 Workspace

1. 在 Workspace Gate 选择“新建 Workspace”。
2. 在“Workspace 根目录”中选择一个目录，或直接填写目录路径。
3. 设置“Workspace 密码”。密码不能为空，之后解锁已保存的 AI API Key 时还会用到。
4. 选择“创建 Workspace”。

Project Mind 会在所选根目录下创建 `.project-mind` 隐藏目录，并初始化 `workspace.json`、`workspace.sqlite3`、AI 缓存、日志和临时目录。根目录本身就是这个 Workspace 的边界；创建成功后，你会直接进入它。

如果所选目录中已经存在 Workspace 元数据，Project Mind 不会在原位置重复创建。请改用“打开已有 Workspace”。

<!-- SCREENSHOT: getting-started-workspace-create.png | “新建 Workspace”对话框，展示根目录选择、Workspace 密码和创建按钮，不包含真实本机路径 -->

### 打开已有 Workspace

1. 在 Workspace Gate 选择“打开已有 Workspace”。
2. 在系统目录选择器中，选择已有 Workspace 的根目录。
3. 确认后，Project Mind 会读取该目录中的 `.project-mind/workspace.json`，并进入这个 Workspace。

打开 Workspace 本身不要求输入 Workspace 密码。打开后，普通内容仍可使用；只有需要读取或保存 AI API Key 的功能会要求先解锁 Workspace Secrets。

### 从最近列表继续

Workspace Gate 右侧的“最近使用的 Workspace”会显示最近成功打开过的 Workspace 名称和根目录路径。选择其中一项即可再次打开；最近打开的 Workspace 会排在前面。

如果某个目录已经不再包含可读取的 Workspace 元数据，它不会出现在可用的最近列表中。此时请检查自己选择的是否仍是原来的 Workspace 根目录。

<!-- SCREENSHOT: getting-started-workspace-gate-recent.png | Workspace Gate，展示“打开已有 Workspace”“新建 Workspace”和脱敏后的最近 Workspace 列表 -->

### 切换 Workspace

在 Workspace Gate 中，打开另一个已有 Workspace，或选择最近列表中的另一个 Workspace，就会把它设为当前 Workspace。切换后，Project Mind 会进入新 Workspace，并清理上一 Workspace 的界面状态和数据查询缓存，避免把两个 Workspace 的内容混在同一视图中。

当前版本在启动时会尝试重新打开上次使用的 Workspace。如果应用已经进入某个 Workspace，主界面暂时没有单独的“切换 Workspace”入口；不要把点击根目录路径理解为切换。只有在 Workspace Gate 可见时，才能通过“打开已有 Workspace”或最近列表选择另一个 Workspace。

### 打开 Workspace 根目录

进入 Workspace 页面后，标题下方会显示当前 Workspace 的根目录路径。选择这条路径，Project Mind 会使用系统文件管理器打开该目录。这个动作只帮助你查看本地目录，不会切换 Workspace。

<!-- SCREENSHOT: getting-started-workspace-root.png | Workspace 页面标题区域，展示可点击的脱敏根目录路径 -->

### Workspace 密码实际保护什么

创建 Workspace 时设置的密码有一个明确用途：加密保存在 Workspace 数据库中的 AI API Key，并在需要使用这些密钥时解锁 Workspace Secrets。

- 打开已有 Workspace 后，AI secrets 默认保持锁定。
- 需要使用已保存的 AI API Key 时，输入当前 Workspace 的密码进行解锁。
- 密码错误时，已保存的 AI API Key 无法解密。
- 普通 Project、QuickNote、Record、Todo、File 内容与元数据，以及 Workspace 数据库本身，都不受这个密码加密保护。

因此，请把它理解为 AI secrets 的保护密码，而不是覆盖整个 Workspace 的访问控制。本文不对离线使用、备份、迁移或更广泛的设备安全作额外承诺。

### 一个实际例子

你可以为长期工作建立一个名为“客户成功”的 Workspace，再在其中建立“智能客服知识库升级”等有明确结果的 Project。下次看到 Workspace Gate 时，从最近列表选择“客户成功”即可继续；进入后，点击 Workspace 标题下的根目录路径，可以在系统文件管理器中查看它的本地目录。

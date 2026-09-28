# Project Mind 产品基线

状态：当前正式基线

更新时间：2026-09-28

代码基线：`develop` / `880aafb`

## 1. 产品定位

Project Mind 是一个本地优先、`workspace-first` 的桌面工作台。它把即时捕捉、长期记录、项目材料、行动跟踪和语音记录放在同一个 Workspace 中，减少在笔记、待办、录音和文件工具之间切换时丢失上下文。

正式领域名称及边界以 [`CONTEXT.md`](../CONTEXT.md) 为准。

## 2. 当前信息对象

- Workspace 与 Project
- Workspace QuickNote 与 Project QuickNote
- Workspace Record、Project Record 与 Voice Record
- Workspace Todo、Project Todo 与 Subtask
- File 与 File Version
- Workspace Tag、Project Tag、Contact 与 Internal Reference
- AI Editor Skill、AI Metadata Fill 与相关 Job
- Recording Session、Voice Source Track、Transcript、Live Captions 与 Meeting Minutes Snapshot

旧 Brief、结论等对象只通过兼容迁移进入 Record，不再属于当前产品模型。

## 3. 当前工作流

### 3.1 Workspace Gate

用户可以创建、打开或从最近记录重新进入 Workspace。Workspace 的数据库、设置、日志、缓存和临时文件统一位于根目录的 `.project-mind/`。

### 3.2 Workspace 首页

Workspace 是始终可访问且不可关闭的首页页签。首页包含：

- 封面、Workspace 图标与标题。
- 唯一的 Workspace QuickNote。
- Workspace Record 列表和 Record 焦点入口。
- Workspace 级项目、标签与最近内容导航。
- Workspace View 的 Todo Rail，可同时查看 Workspace Todo 与活跃 Project Todo。

### 3.3 Project 首页

每个 Project 使用可关闭的浏览器式页签。首页包含：

- 封面、Project 图标、标题与 Project QuickNote。
- Project Record 列表。
- 最近记录、最近文件、搜索、标签筛选和受管文件操作。
- 可在 Current Project View 与 Workspace View 间切换的 Todo Rail。

Project 进入 Archive 后退出活跃列表，但数据不删除。

### 3.4 Record 焦点页

Workspace Record 与 Project Record 使用一致的焦点编辑体验：

- 富文本正文、标题与 `#标签`。
- `[[Internal Reference]]`、`@Contact Mention` 和 `#Tag` 推荐浮层。
- 图片、附件、表格、代码块与图片标注。
- AI Editor Skill 和 AI Metadata Fill。
- 后台保存协调；普通导航不等待持久化完成，退出和切换 Workspace 会经过保存屏障。

### 3.5 Todo

Todo 支持：

- Workspace / Project 归属与聚合视图。
- 完成、归档、优先级、截止日期、进展和排序。
- Subtask 的新增、回车连续创建、编辑和完成。
- Tag、Internal Reference、Contact Mention 与 URL。
- 完成态确认后再平滑退出，列表位置通过共享布局动画连续变化。

### 3.6 File

Project File 支持导入、搜索、Tag、重命名、标星、版本、打开所在位置、复制为新版本和删除。文件 Tag 使用统一的轻量推荐浮层，不在右键菜单中展开完整标签列表。

### 3.7 Voice Record

Voice Record 当前主体能力包括：

- 麦克风与系统声音双轨采集，保留原始来源。
- 暂停、继续、结束、滚动分片、异常恢复和删除清理。
- 纯录音、本地 SenseVoice 和云端 Paraformer 识别路径。
- 主窗口控制、独立字幕浮窗、最终 Transcript、点击回放和 Transcript 搜索。
- 手动、周期和结束时会议纪要，以及 AI 标题和复制到正文。

真实 Paraformer 断线恢复、macOS 集中设备验收和 Windows 完整闭环仍未完成，详见[未完成事项](remaining-work.md)。

## 4. 页面与全局导航

- `/workspace`
- `/workspace/records/:noteId`
- `/projects/:projectId`
- `/projects/:projectId/records/:noteId`
- `/settings/:section`

顶栏包含 Workspace 固定图标页签、Project 页签和页面级窗口控制。全局搜索位于右侧 Rail 顶部，与边栏按钮同一行；Todo、文件等区域通过一致的分隔和滚动遮罩组织。

## 5. 本地优先与数据边界

- 业务主库为 `<workspace>/.project-mind/workspace.sqlite3`，当前 schema 为 v25。
- Project 对应 Workspace 根目录下的真实文件夹。
- Workspace 自有资源使用相对路径持久化；机器相关绝对路径只允许存在于明确的外部来源字段和本地会话发现信息中。
- Transcript 是不可编辑的语音事实来源；用户要修改时复制到 Record 正文。
- Archive、完成与删除是不同状态，不能互相替代。

## 6. 当前不包含

- 多用户协作、账号权限和云端同步。
- 层级文件夹式 Tag。
- 把 Todo 变成团队任务分配系统。
- Voice Record 的实时翻译、Context Lexicon、AEC、通用模型下载器和分轨混音控制。

## 7. 当前验收边界

自动化测试、构建、UI 规范、路径可迁移性和 bundle 边界是日常验证的一部分。真实平台和发布层面的剩余工作只在 [`remaining-work.md`](remaining-work.md) 维护。

# File 导航刷新与目录操作

跟踪：[Issue #300](https://github.com/xuchen-cloud/project_mind/issues/300)。覆盖 G07/G08；Workspace File 与 Project File 共用此行为。

## 导航

- 平铺列表与文件树提供手动刷新；目录 dirty 通知按 Workspace binding、归属与父目录合并刷新。
- 原件确认不存在后从导航隐藏，保留 File 身份、历史版本、恢复 BLOB、引用和已打开的编辑现场。目录读取失败显示错误，不能当作删除证据。
- 检查已登记 File 的祖先及直接父目录；同路径的不同 File ID 不共享 presence 结果。工作区重新打开后旧 generation 的异步结果无效。
- 目录树沿用 `HomeSidebarList` 的滚动边缘遮罩。
- File 共用右键菜单提供“使用系统默认应用打开”。菜单捕获当前 Workspace binding，以 File ID 和归属调用现有原生打开命令，重新核验当前原件及真实路径；不打开历史版本或缓存的旧路径。缺失原件禁用，原生失败明确反馈。

## 文件夹菜单

支持鼠标右键、键盘菜单、内联重命名与“移入回收站”。操作前获取可信原生 prepare；重新准备时完整 token、目录身份、后代集合及 revision 必须一致。提交时再次核对。

重命名仅限同一父目录内的普通名称，不能覆盖已有文件或文件夹。目录路径、File 和版本引用一并更新；File ID、版本 ID/号与 hash 保持不变。

将整个目录移入回收站前，明确确认包括未纳管内容。原路径直接交给操作系统，便于系统恢复到原业务位置。受影响的历史版本先复制并同步到 Workspace 内部 `directory-history` 存储，再原子更新版本位置、missing 状态及回执；DB、历史与 working 恢复 BLOB 保留。复制失败不执行回收站操作。

本版存在活动后代编辑 session 时拒绝操作，提示先通过既有保存 guard 关闭相关文件，包括独立窗口。操作不能自动关闭编辑器或丢弃草稿。失败保留名称草稿并显示原因；切换归属或 binding 后取消旧异步 UI 操作。

## 原生边界

- prepare 不执行恢复，不写业务内容；锁元数据按需建立。空数据库及从未登记 File 的目录可操作，不依赖懒初始化目录辅助表。
- owner lease → File lease → lifecycle fence → SQLite。恢复扫描在 fence 外执行；目录/File try lease 竞争时返回可重试冲突。
- 拒绝根目录、隐藏系统目录、跨归属路径、符号链接和 Windows 重解析点；内部未纳管符号链接作为目录条目一起移动，不遍历其目标。
- 持久化 intent 后才改文件系统。rename 未提交时仅在物理身份匹配且路径空闲时回滚；Trash 后原路径缺失时完成 missing/回执。外来占用保留证据，不覆盖。
- 外部路径冲突只阻止相交的源/目标子树，不阻断无关 File、目录或 Workspace 打开。结构损坏、权限及 I/O 错误仍传播。
- 事务使用 FULL synchronous；回执与变更日志一起提交。相同请求重放返回原结果，不同 payload 不能复用请求标识。

## 验收与平台范围

自动化验收包含前端刷新/菜单、真实 DB 与文件系统、活动 session、版本与恢复数据保留，以及 intent/历史复制/文件系统变更/提交四阶段的进程崩溃。模拟 Trash 回调仅用于故障控制；真实系统回收站单独测试。

Windows 验收需 Windows 10/11 与 WebView2、可运行本分支构建的隔离 Workspace，验证目录/文件占用、大小写冲突、junction/reparse、外部删除恢复、系统回收站及系统恢复原路径。macOS 与 mock 不能替代该门禁。跨归属移动、拖入更新版本及版本名称/星标归后续工作包。

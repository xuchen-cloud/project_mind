# #250 共享助手后端实施与验收

关联 [Issue #250](https://github.com/xuchen-cloud/project_mind/issues/250)。实施依据为[交接文档](dsh-shared-runtime-handover.md)。当前基线 `c31f0647`，包含尚待用户界面验收的 #248 / #249；不得把这些既有提交当作 #250 新实现。

## 工作包与依赖

| 包 | 依赖 | 交付行为 | 验收与验证范围 |
| --- | --- | --- | --- |
| 历史迁移 | 固定版 DSH 存储格式 | 合并旧范围历史与 registry，保留 Session / workspace 身份、归档置顶、任务与回执；原数据保留；中断恢复及冲突拒绝 | 迁移单元测试与真实 DSH 存储恢复；目录移动保留身份 |
| 原生宿主 | 多范围请求契约、迁移 | 当前解锁 Workspace 唯一常驻 Harness；各范围保留独立 identity / carrier；原生统一启动和回收 | Rust DSH / CLI / Office / schedule 定向验证；真实进程数量与生命周期 |
| 会话和工具路由 | 原生注册 context、共享 registry | 按真实 Session 归属分配 workspace、CLI lease、Source / Office 权限；列表先过滤后读取冷标题 | 两范围真实 Node 会话与并发；越界、旧请求、凭据与取消隔离 |
| 产品与规格收口 | 前三包 | 保留 #248 导航、#249 任务加载；更新物理进程描述 | 前端类型、助手 API / 面板 / 任务回归；Standards / Spec 主 agent 自查；集中重启后用户人工界面验收 |

非目标：多个主应用 Workspace 同时解锁、替换 DSH Harness、升级依赖、重设计聊天界面、扩大 Project 授权、关闭尚未验收的 #248 / #249。

## 请求与生命周期契约

- Configure 传原生 Workspace 身份、模型凭据及真实 context 集合；进程 home 与每个 Session 的 cwd 分离。
- 原生私有 `mind/context` 注册 scope 与 CLI 绑定；`mind/session/list/create/delete/inventory/search` 显式选择已注册 scope。普通 Session 操作由原生按实际归属校验。
- `mind/session/context` 从真实 Session 查归属，原生再次以当前数据库、Workspace generation 和真实目录验证。工具参数及前端 Project ID 均不授予范围。
- `$events` 与 `workspace/follow` 按原生 scope 投影，事件回执绑定实际已投递的客户端与事件；附件只接受当前 scope 会话日志中的真实引用。会话搜索先选取当前范围的会话，再通过公开语义过滤 API 读取当前表层；`@` 会话引用在读取历史前校验归属。
- 原生统一管理唯一物理进程。页面载体断开只释放连接；工作区关闭、锁定、切换及应用退出撤销全部凭据和异步请求。
- 配置或目录变化需要实际重启时，先检查全宿主活动和未完成请求；运行中拒绝静默替换。

## 验证记录

主体实现与自动化验证已完成，正在按用户授权执行实机产品验收；验收发现的问题在本包补测修复，#250 不提前关闭，#248 / #249 仍保留各自验收状态。

| 范围 | 命令与结果 | 证据日志（本机临时日志文件名） |
| --- | --- | --- |
| Rust 库 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` 首轮 1314 passed / 9 failed / 41 ignored；3 处 DSH 旧 fixture 修正，另 6 项已有 SIGKILL / exit 测试竞争在独立重跑通过；9 个失败项定向重跑全部通过，合计 1323 passed / 41 ignored | `mind-shared-native-full.log`、`mind-shared-native-failed-rerun.log` |
| 原生最终改动 | DSH 范围 45 passed / 1 ignored；随后目录变更与 CLI 生命周期 6 项、搜索路由 fence 1 项补充通过；其余有效验证复用 | `mind-shared-native-final.log`、`mind-shared-native-lifecycle-final.log`、`mind-shared-native-search-fence.log` |
| Node 单元 | `npm --prefix packages/dsh-assistant test` 基础 157 passed；后续 registry、搜索、引用及真实无索引查询等新增与受影响范围 22 passed | `mind-shared-node-unit.log`、`mind-context-reads-final.log` |
| Node 完整集成 | 原完整运行 53 项中 51 passed；旧 Workspace fixture 的 Source / Office 假设及 inventory 越界错误码已修正，两项分别定向通过；其余通过结果复用 | `mind-shared-node-integration.log`、`mind-shared-node-integration-repaired.log`、`mind-shared-workspace-repaired.log` |
| 真实共享进程 | 一个子进程、Workspace 与两个项目、并发与定向停止、Source、scope 列表/搜索/默认目录/事件、跨范围引用拒绝、附件权限及重启恢复通过 | `mind-shared-session-scope-final.log` |
| 实机发现的增量协议问题 | `context-streams.test.mjs` 5 项、真实 Node 共享场景 1 项、真实客户端插件/UI 18 项通过；先复现新空会话输入禁用，再验证首次 baseline 后使用 scope 增量恢复归属 | `mind-workspace-delta-red.log`、`mind-workspace-protocol-unit-green.log`、`mind-workspace-delta-green.log`、`mind-new-session-ui-red.log`、`mind-new-session-ui-regression.log` |
| 迁移与目录变更 | `shared-runtime-migration.test.mjs` 与真实固定版本存储 integration，8 项通过；保留 Session / workspace ID、模型事件、归档置顶、任务 pending / receipts、旧副本与中断恢复 | `mind-migration-complete.log` |
| 前端 | 10 个相关文件、159 项通过，含原 UI 宿主、生命周期、业务 API、缓存、引用与查询键 | `mind-shared-front-complete.log` |
| 类型与构建 | `npx tsc --noEmit`、`npx vite build`、UI standards、bundle boundaries 通过；主脚本 225 KiB / 250 KiB；`cargo build --manifest-path src-tauri/Cargo.toml --bin project_mind_alpha --bin mind --quiet` 成功 | `mind-shared-tsc.log`、`mind-shared-vite-build.log`、`mind-shared-ui-standards.log`、`mind-shared-bundle-check.log`、`mind-shared-desktop-build.log` |
| 文档与 diff | `git diff --check`、本地链接检查通过。全仓 portable-paths 检查仍被既有文档中的机器路径阻止；与 `c31f0647` 比较，本次修改未新增该类问题 | `mind-shared-portable.log` |

Standards / Spec 两轴均由主 agent 自查，没有启动 review 子 agent。Spec 检查发现的全局事件、共享附件、搜索及会话引用隔离缺口已在本包修复并补测。没有以单范围 mock 替代共享进程测试，也没有重跑仍有效的全量验证。

## 发布边界

实现分支为 `codex/dsh-shared-runtime`。它继承 `c31f0647` 中 #248 / #249 尚待人工验收的提交，当前不自动将这些改动连同 #250 合入 `develop`。按用户已选择的人工界面验收方式收口后，再依仓库发布流程处理对应 PR 与 Issue；阶段提交不代表 Issue 完成交付。

## 本机运行状态

已重新构建并以关闭 Rust 文件监听的方式集中启动验收。由于裸开发程序无法被界面自动化识别，目前使用指向同一 debug 可执行文件的临时 macOS 启动包，沿用仓库原应用名称与 Bundle ID，并连接本机 Vite 开发服务。初次临时启动包使用了不同名称，触发系统钥匙串访问提示；已恢复原应用身份，用户已完成系统授权。没有降低钥匙串保护或清除既有凭据。

旧的两个 Harness 进程已随旧应用退出回收。生产历史迁移由原生启动流程执行，不在外部脚本中并行修改用户数据；旧范围目录持续保留。

用户可集中验收：打开工作区及两个项目会话、同时发送后只停止其中一个、切换 Tab / 分栏 / 设置后返回、检查既有历史及置顶归档、查看并执行原定时任务。此人工产品验收尚未完成。

## 实机验收进度

用户已授权主 agent 执行实机验收。裸开发程序无法被界面自动化识别，因此使用相同已构建可执行文件生成临时 macOS 验收启动包，连接同一个开发服务和当前 Workspace；没有改用已安装旧版本。

- 已真实打开当前 Workspace，原有内容 Tab 与记录视图保留。
- 锁定时会话列表提示“请先解锁工作区，再使用助手”，实际 Harness 进程数量为 0。按用户提供的原 Workspace 密码经产品正常流程完成解锁；密码不写入代码、文档或验收日志。
- 解锁后共享迁移 manifest 为 complete；4 个旧范围共 7 个原 Session ID 全部保留，原目录仍存在；原定时任务文件迁移后与旧副本字节一致。
- 工作区原有 4 个会话、两个项目的旧会话及原有内容 Tab 可打开；打开项目、返回工作区和进入设置时后端均为同一个 PID。
- 原有 3 个定时任务及绑定保留。通过正常界面创建暂停的“#250 实机验收任务”和专用工作区会话，立即执行后真实模型返回“#250 定时任务验收成功”；该任务保持暂停。
- 新建空会话实机发现输入框停在 Choose workspace：共享事件层把工作区增量误投射为第二个 baseline，上游客户端拒绝。已在真实客户端插件与真实 Node 运行时分别建立失败复现，修复为首次快照与后续受范围约束的官方增量；真实客户端/UI 18 项通过，重启后再通过界面新建空会话，可直接输入并发送。
- 两项目真实并行执行：项目 A 的 `sleep 120` 与项目 B 的 `sleep 45` 同时归属于同一 Harness PID `6529`；界面只停止 A 后，A 显示 Stopped，A 的命令退出，B 的命令继续，最终显示 Completed 与“验收 B 独立完成”。切换项目、分栏、打开设置没有重启后端。
- 专用任务在 20:42 自动触发，任务面板回读 lastRunAt 为 20:42、nextRunAt 为次日 20:42；绑定工作区会话中恰有 20:32 手动、20:42 自动两次成功回执。验收后已暂停该测试任务，原 3 个任务保持原状态。
- 集中退出后应用与 Harness 均回收为 0；重新打开后恢复原 Session ID、模型结果、任务回执、会话置顶及内容 Tab。工作区解锁后仅启动一个新 Harness，迁移没有重复导入。
- 最后整理验收会话名称时 macOS 锁屏，界面操作工具要求用户手动解锁。核心场景已验证；剩余界面恢复检查与工作区切换/锁定的实机场景尚未完成，不把原生自动化测试记为这些实机结果。

### 后续工作包（不扩张 #250）

本机旧工作区正常解锁成功，但重启后仍要求再次输入原密码，与开发模式“首次初始化后自动解锁”的文案不符。基线 `lib.rs` 的 `unlock_current_workspace` 只更新内存密码，而开发缓存写入目前仅在新建工作区调用；本包未改该凭据行为。正常解锁后历史及共享运行时均恢复，本问题单独处理。

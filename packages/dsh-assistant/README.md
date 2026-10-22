# DSH 助手

主应用“助手”页面直接渲染 DSH 原 React Chat、Trajectory、输入框、工具展示及必要客户端服务，经 Tauri 通信适配连接本地 Node 运行时。旧 native WebView 已全部删除，真实组件 GUI 验收、已有构建与 restage 已通过；debug 免密前端小改后的最终构建待主 agent 更新。用户方案见 [组件融合方案](../../docs/requirements/dsh-ui-component-integration.md)。

保留已有 Node 运行时及有效的项目、历史、统一模型接入；官方 `app-boot` 加载 `base + web-app`，复用上游 WebUI 与 dataelement/dsh-desktop UI 插件，不启动 Electron，不打开外部浏览器，不要求用户登录。

旧 Pi 聊天面板、conversation hooks 和消息 UI 已删除。本基础阶段仍保留 Overview 等后台 Pi 调用，不能视为全部 Pi 已移除或整体迁移完成。

## 已有运行时与统一模型设置

- 主应用统一 AI 设置是唯一配置权威。嵌入助手默认使用 Workspace 的 General AI 模型，同时提供已配置且可用的兼容文本模型；原生端复用 `db.agent_resolve_profile` 解析模型、密钥和代理配置，启动时经 stdin 提供给 Node。
- 模型名称和下拉菜单位于会话输入框内，每个 Session 独立持久保存选择，运行中也可切换；已发出的模型请求继续完成，后续请求使用新选择。重开会话保留选择；模型不可用时在菜单提示并允许选择替代模型。菜单采用紧凑行距，只显示模型名称，不附加生效时机标记或提示。
- 密钥仅通过各模型独立的内存凭据引用供 DSH 使用，不写入 DSH credentials。嵌入模式禁用独立 **Models** UI；菜单内“管理模型…”打开主应用 AI 设置，不需要再次配置 Provider 或登录。
- 打开助手时按需启动 Node，参数为 `--embedded --port 0 --no-open`。面板隐藏或组件卸载须保留历史，退出主应用时自动关闭 Node。
- 主应用模型、密钥或代理配置变化后刷新模型运行时，保留已有 DSH 会话历史。

## Workspace / Project 会话与主应用融合

- DSH workspace 映射原生提供的真实 Workspace 或 Project，工作目录分别为 Workspace 根目录和 `project.root_path`。每个范围独立运行，切换页面不停止后台任务；主应用负责导航和运行时生命周期。历史按 stable workspace ID / scope 分配独立子目录，旧范围延迟事件不得写入当前范围界面。
- 完全隐藏 DSH 左侧 sidebar。会话列表与新建、切换、继续、删除入口由主应用助手 header 管理，助手内容仅保留 **Chat / Trajectory**。
- 隐藏 DSH 文件树、预览、浏览器和终端 UI；文件浏览由现有主 Project 文件区承接。
- 主 Settings 导航新增 **DSH 设置**，提供“插件管理”和“运行设置”两个模式，优先复用官方 **PluginManager / Settings** 可独立表单，嵌入主 settings viewport；依赖完整外壳的部分由主应用表单调用对应服务，不使用独立 DSH sidebar。Models 继续由主应用统一 AI 设置管理，助手与插件配置默认共享，变更须影响实际运行时并明确生效时机。

- 文件链接与轨迹文件导航打开主 Project 预览，主文件区可插入文件引用；附件上传与项目文件引用分别按真实语义处理，并校验会话所属项目的访问范围。

当前 Tauri 通信适配保留 HTTP RPC、WebSocket mux 的完整客户端协议与会话语义，不用较窄的 stdio SDK 替代客户端协议；前端不获取模型密钥。项目文件引用按真实文件路径接入，外部附件上传 / 读取保持各自语义。

### Node configure 契约（#161）

嵌入模式第一行继续使用 `type: "configure"` 与现有 `provider` / `providers` 模型字段，并且必须且只能携带一个上下文：

- Project 保留原帧：`project: { id: 正安全整数, name: 非空字符串, directory: 实际绝对路径 }`。
- Workspace 使用 `workspace: { id: 稳定 Workspace UUID 字符串, name: 非空字符串, directory: 实际 Workspace 根目录绝对路径 }`，没有 `project` 字段。

`readContext` 校验身份和实际目录，`bindContext` 将会话绑定到该目录，禁止在 DSH 内更换目录或管理 Workspace / Project。创建、流式发送、停止、历史恢复和归档复用相同上游 controller / registry。原生为两种范围指定不同的 `PROJECT_MIND_DSH_USER_DATA`（即 `DSH_HOME`）：`projects/<workspace-id>/workspace` 与原有 `projects/<workspace-id>/<project-id>`；Node 不重写路径、不迁移 Project 历史，profile 目录仍由原生共享。

Workspace 模式沿用普通 Chat、附件、文件工具、权限与模型服务，不安装 Project 专属 source、source title 和 Office 服务。它不获得 Project File 的原生读写权限，也不接入记忆或额外业务工具。

## 本地开发与发布资源

本地开发要求 Node.js >=22.19.0 与 npm，并先安装本包依赖。从仓库根目录执行：

```sh
npm --prefix packages/dsh-assistant ci --no-audit --no-fund
```

发布时 desktop prepare 将运行资产及 production dependencies 放入 `resources/dsh-assistant`，复用桌面已有的固定版本 Node 资源。发布应用不要求用户另行安装 Node 或 npm。

### Skills

主应用「设置 → Skills」统一显示 DSH 发现的技能，可打开说明文件和目录。选择 Project 时使用其真实工作目录与助手数据目录；Workspace 视图使用当前工作区目录。读取列表无需配置模型或发起模型请求。

内置 Skills 置顶并带「内置」标签；每个 Skill 可打开说明文件及资源目录。「技能目录」展示去重后的扫描根目录，一个根目录可包含多个 Skill，包括空根目录及技能被同名高优先级技能覆盖的根目录。

发现与同名优先级复用官方 `dsh-skill` / `dsh-skill-filesystem`：项目 `.dsh/skills`、项目 `.agents/skills`、助手数据目录中的 `skills`、用户 `.agents/skills`，以及本包的 `skills/` 内置目录。项目根目录按 DSH 的 Git 根目录规则确定；设置展示合并后的有效技能，修改外部文件后可刷新列表。

`skills/project-mind-cli/SKILL.md` 是给 Agent 使用的 Mind CLI 内置 Skill。整个 `skills/` 目录随桌面资源默认打包并参与资源清单校验。启动时在全局助手数据目录的 `skills/builtin` 中准备指向安装包资源的托管链接，设置与运行时助手使用该根目录；工作区与项目助手共享其启用状态。独立启动从助手数据目录派生同一布局。本机用户安装的技能从其原目录发现。

### 原生 CLI 绑定 / #204

内置会话由原生端在启动帧提供应用附带的 `mind` 路径、Workspace 根目录、当前 Project 或 Workspace 范围、独立桥接发现文件及连接 ID。模型可通过 `--help`、`capabilities` 和 `schema` 发现现有接口；Record/Todo/File 操作复用原生授权、编辑器协调、版本 CAS、幂等和 Operation Receipt。独立调试入口没有原生绑定时仍按原流程工作。

每次真实工具 shell 执行根据 DSH 已解析的 sandbox policy，在父进程私有通道申请短期凭据；只读执行不能通过 CLI 写业务对象。凭据只放该子进程环境，执行及后台进程完全结束后失效；运行时停止、Workspace 锁定或切换后同时撤销。长期连接凭据保留在原生系统凭据存储，模型提示与配置帧不包含密钥。连接稳定归属当前作用域，收据身份跨运行时重启保留；显式禁用或撤销连接后不会自动重授。

独立桥接不更改用户外部连接开关，不安装系统 CLI 或修改用户 PATH。`npm run dev:tauri` 和 `npm run dev:tauri:manual` 会先编译 debug CLI；正式安装包使用已有 CLI sidecar。原生 CLI 仅在当前 shell 中获得 PATH 与短期桥接配置，其他 Project 和 Workspace 的授权仍独立检查。

2026-10-22 已在 macOS 原生界面用真实 Provider 验证 Record/Todo 的创建与更新、Subtask、目录 File 续改和版本历史。同步修复待办侧栏收到原生变更后仍复用旧页面缓存的问题；当前项目与工作区两个视图均验证了自动新增、完成状态和子任务更新，无需手动刷新。普通 bash 输出中的源码 marker 也不会再被误认为固定 File 投影而阻断后续会话。具体红绿测试、原生 ID、版本及检索覆盖限制见[会话验收记录](../../docs/technical/agent-session-acceptance-20261022.json)。

禁用将整个 Skill 条目移入同一扫描根的 `.disabled/`，启用时移回，遇到同名目标时拒绝覆盖。设置会额外展示其中的禁用项，助手不会扫描这些嵌套条目。内置技能仅移动托管链接，安装包资源不变，重启和资源路径升级后保留禁用状态；内置技能不可删除。外部技能需在确认弹窗后删除完整目录（含脚本、资源），flat Markdown 仅删除该文件，符号链接仅删除链接。

### 独立调试入口

`npm run start:dsh` / `npm run dev:dsh` 仅保留为开发调试入口，不是正常应用使用路径。它们默认监听 `127.0.0.1:3081` 并打开浏览器，使用独立配置；终端按 Ctrl+C 关闭服务，关闭浏览器标签页不会关闭 Node。

```sh
npm run start:dsh
npm --prefix packages/dsh-assistant run start -- --no-open
npm --prefix packages/dsh-assistant run dev -- --no-open --port 3082
```

独立模式可在 **Settings → Models** 添加或编辑 Provider，填写实际 Base URL、API protocol、Model ID 和 API key，保存后在会话中选择模型。该模式使用官方 credentials 存储，与嵌入模式的内存密钥引用不同；其配置不是主应用的配置来源。参数直接传给本包，不依赖根层嵌套 npm 脚本转发。

## 数据目录

DSH 历史当前仍单独存储，默认 `DSH_HOME` 如下，不读取默认 `~/.dsh`：

| 平台 | 默认目录 |
| --- | --- |
| macOS | `~/Library/Application Support/project-mind-dsh` |
| Windows | `%APPDATA%/project-mind-dsh`；APPDATA 未设置时使用 `~/AppData/Roaming/project-mind-dsh` |
| Linux / 其他 | `$XDG_DATA_HOME/project-mind-dsh`；未设置时使用 `~/.local/share/project-mind-dsh` |

`PROJECT_MIND_DSH_USER_DATA` 可覆盖数据根目录，必须为绝对路径。独立调试模式的 profile 位于 `profiles/assistant`，工作目录为 `<数据目录>/workspace`，也在此保存独立配置和凭据。主应用接入以 stable workspace ID / scope 划分历史子目录，工作目录使用原生提供的 Workspace 根目录或 `project.root_path`；模型配置仍来自主应用。

单独保存历史是当前实现选择，用户没有要求永久隔离配置或数据；未来业务工具可以共享配置和数据。Project 映射读取原生 DB 的 Project 归属与实际根目录，但尚无业务数据库工具桥；不转换旧 Pi 历史，不删除旧会话数据。

## 来源与通信

- DSH 官方运行包固定为 `0.2.0-rc.2`，Desktop UI 来源固定为 `115a0b474cc2c4794316171c640a8898398591fe`，详见 [upstream.json](upstream.json)。保留上游版权与许可证。
- Web UI 使用官方 Connection 的 HTTP unary RPC；Typert Remote 流走 API gateway 的 WebSocket mux `/api/remote.mux`。会话与历史由同一个 Node Web runtime 提供，主页面 React 组件通过 Tauri 通信适配保留完整客户端协议与会话语义，不增加第二个 SDK runtime。
- 模型 Provider 流式响应使用 SSE；它不是 UI Remote 流的传输协议。
- 已评估 `@deepseek-ai/dsh-sdk-client@0.2.0-rc.2`，其传递依赖引入完整 DSH CLI 与 Office/PPT adapters，当前不安装或使用 SDK client。原生业务接入复用项目自己的 Mind CLI，不依赖该 SDK。
- 官方 `dsh-web-app` 仍带有 `dsh-office-to-pdf` / `libreoffice-kit` 传递依赖；本包 overlay 禁用 `office-to-pdf`，不执行 Office/PPT build、Office prepare 或引擎准备。
- rc.2 stdio JSON-RPC SDK 没有轮次中取消方法；当前 UI 使用官方 Web session controller 的 `cancel`，停止后 runtime 可继续服务，已通过本地测试 Provider 验证。

## 历史验证

独立阶段干净 npm ci、check:dsh / build:dsh、21/21 单测与 2/2 真实 Node 集成曾通过；独立浏览器的模型配置 / 聊天 / 恢复与旧 WebView 三轮、model v3、HMR / 关闭行为保留为历史证据。

## 验证结果与限度（2026-10-11）

本包真实组件 GUI 验收已于 **23:12** 通过，使用主应用原 React 组件、原生 HTTP RPC / WebSocket mux 与本地 SSE Provider：

| 范围 | 结果 |
| --- | --- |
| Chat / Trajectory | 同 turn、正确项目 cwd；真实发送 / 流式、15 秒任务 Stop → Stopped 后续发、HTTP 400 → Failed 后恢复均通过；执行中 workspace 切换拦截通过 |
| 项目会话 | A / B 列表隔离、B 新建 / 发送 / 归档后自动切回首会话通过；重启后 B 仅列首会话 `49a`，已归档第二会话 `2bc` 不再列出 |
| 历史 blank 恢复 | A 旧 orphan `e2db` 恢复后可发送；23:10 真实 generation 的 Trajectory 请求 #1、A cwd 与最终本地回复正确 |
| 文件双向接入 | 主目录树 `notes/README`、README 预览 → 原输入框引用 → Send 携带引用 → 消息 README 按钮打开主预览通过 |
| Settings / 插件 | busy 后新建可用、Settings 可打开；3 个官方插件与原 Shell 表单保存 60000 → 61000 通过，重启后 B 读回 A 保存的 61000，跨 Project 共享通过 |
| 语言 / Portal | 原 Settings 的 English → 中文 Portal 菜单及聊天即时中文通过 |
| 前端回归 | 前端 60、延迟回调 2、文件 9、transport 3；原服务 bootstrap 6、Profiler 6、vendor 5、integrity 3、inventory 2、commands 1 项通过，含 same-ID cancel / reselect 和 React 19 root 非枚举 `$$typeof` 兼容 |
| 原生回归 | `dsh_assistant::tests` 12 passed / 1 ignored（含真实 session-follow、actor ACK），`debug_workspace` 3 passed，`project_directory::tests` 5 passed；原生项目映射另列，actor 4 与 Channel ACK 集成 1 项已有通过证据 |
| Node 最终验证 | 23:10 完整真实集成 5/5、单测 25/25 通过；含共享模型、两项目、归档重启与历史空会话恢复 |
| 构建 / 资源 | 无 unstable 静默 cargo build **22:54** 通过，app 已使用该 binary；`npm run build` 最终正式前端构建与 `TAURI_ENV_DEBUG=true npx vite build --outDir $TMPDIR/mind-dsh-debug-final-dist` debug 前端构建均于 **23:13** 通过；debug 判定及相关 UI 针对性测试 36 项通过；packaging 14/14 与 restage 已成功 |

Node 最终日志：`$TMPDIR/project-mind-dsh-runtime-final-all.log`、`$TMPDIR/project-mind-dsh-unit-final-all.log`。主 agent 自查发现 Vite `DEV` 不等同于 `tauri build --debug`：debug 原生构建即使使用生产前端 bundle，也应保持免手动密码。已补齐 `TAURI_ENV_DEBUG` define、helper 与 UI 分支；36 项针对性测试及正式/debug 两种生产前端构建通过，Rust 与已验收的聊天路径没有后续改动。

构建日志：`$TMPDIR/mind-dsh-component-final-build.log`；restage 日志：`$TMPDIR/mind-dsh-component-final-restage.log`。旧 native WebView 已全部删除，Cargo unstable 已移除，重启自动解锁无需手动密码通过。Orphan 修复由 `bindProject` 调用 `originalRegistry.attachSession` 恢复真实 cwd 下非 archived、遗漏 account 关联的历史会话。

**实现、验证与主 agent Standards / Spec 自查完成，无剩余阻塞项。** 本包不 publish，不标记全部 Pi 迁移或 #121 完成；后台 Pi、旧 Pi 历史转换、业务数据库工具桥、Office/PPT 不属于本包。确定性本地 Provider 验收不代表真实外部 Provider 已通过。

范围见 [迁移方案](../../docs/requirements/dsh-assistant-migration.md)，改动、命令与最终收口由主 agent 在 [执行说明](../../docs/requirements/dsh-assistant-execution.md) 维护。


## Workspace Node 验证（#161，2026-10-15）

在本包目录运行，基于当前 #161 Node 改动与固定 rc.2 依赖：

- `npm run check`：通过。
- `npm test`：38/38 通过。
- `npm run test:integration`：15 个顶层场景、含子用例共 29/29 通过。
- `git diff --check -- packages/dsh-assistant`：通过。

真实 Node 子进程、HTTP RPC / WebSocket mux 与本地 SSE Provider 验证 Workspace 创建、普通聊天、模型选择、普通文件 read、附件上传入聊、停止及续发、重启历史恢复、归档后恢复不可见，以及独立 DSH_HOME 下的 Project 历史与会话访问隔离。配置边界验证包括无上下文、同时携带两种上下文（含 null）、无效 ID、名称及目录；Workspace 不注册 Project source 路由和 Office 工具，既有 Project source / Office 场景保持通过。

早期依赖目录缺失导致的检查失败已由完整依赖恢复后的上述结果取代。本轮没有调用真实外部模型，也没有执行 Rust、前端或 GUI 验收；这些仍由主 agent 分别收口。未接记忆、新业务工具或历史迁移。

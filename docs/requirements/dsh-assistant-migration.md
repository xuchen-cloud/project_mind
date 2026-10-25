# DSH 助手迁移实施方案

日期：2026-10-11；架构更新：2026-10-25（#250）。关联：AI 工作上下文统一规格 #121。本文反映用户最新要求；历史交接保留原始记录，不将历史 Pi 工单或独立调试阶段的完成等同于本次迁移交付。具体工作包与验证记录由主 agent 更新 [执行说明](dsh-assistant-execution.md)。

## 当前架构：主页面原 React 组件

按 [用户组件融合方案](dsh-ui-component-integration.md)，DSH 原 React Chat、Trajectory、输入框、工具展示及必要状态绑定 / 注册服务直接渲染在主应用页面，经 Tauri 原生 HTTP RPC / WebSocket mux 连接 Node 运行时。旧 native WebView 已全部删除，Cargo unstable 已移除。真实组件 GUI、23:01 前端构建、22:54 原生构建与 restage 已通过；debug 免密前端小改后的最终构建待主 agent 更新。

已有 Node 生命周期、项目映射、历史、统一模型 / 密钥 / 代理与资源打包继续复用。本包收口范围不等于整体 Pi 迁移或 #121 完成。

## 已有基础接入与目标范围

### 依赖与交付行为

使用官方 `@deepseek-ai/dsh-app-boot` 加载 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，复用真实上游 DSH WebUI 与 dataelement/dsh-desktop UI 插件。DSH 运行包固定为 `0.2.0-rc.2`，Desktop 来源固定为 `115a0b474cc2c4794316171c640a8898398591fe`，保留来源与许可。安装、运行和资源说明见 [助手 README](../../packages/dsh-assistant/README.md)。

- 现有“助手”入口在同窗口主页面直接渲染原 React 组件，不打开外部浏览器、不要求用户登录。
- 旧 Pi 聊天面板、conversation hooks 与消息 UI 已删除；Overview 等后台 Pi 仍保留在本阶段，不宣称全部 Pi 已移除。
- 原生端按需启动当前 Workspace 唯一的常驻 Node Harness，使用 `--embedded --port 0 --no-open`；关闭助手面板或卸载组件保留会话历史，退出主应用自动关闭 Node。
- 主应用统一 AI 设置是唯一配置权威。通过 `db.agent_resolve_profile(None)` 解析 MAIN Workspace 的 General AI 模型、密钥和代理配置，启动时经 stdin 注入 DSH。
- 主应用密钥仅以运行时内存凭据引用使用，不持久化到 DSH credentials。嵌入模式禁用独立 Models UI，标题栏“模型设置”打开主应用 AI 设置。
- 主应用模型配置变化后刷新模型运行时，包括密钥与代理变更；刷新保留 DSH 历史，不建立可与主设置分叉的持久模型配置。

### Project 与产品融合范围

- DSH workspace 分别映射主应用 Workspace 与各 Project，目录取实际 Workspace 根目录或原生 DB 的 `project.root_path`。当前 Workspace 共用一个常驻 Harness，切换 Project 不更换后端、不停止任务；各范围的 Session、cwd、原生权限、输入输出和停止目标仍独立，旧范围延迟响应不能写入新范围界面。该物理承载由 [#250](https://github.com/xuchen-cloud/project_mind/issues/250) 替代早期每项目进程方案，并保留 A27 并发停止隔离要求。
- 完全隐藏 DSH 左侧 sidebar；会话列表与新建、切换、继续、删除入口由主助手 header 管理。助手内容仅保留 Chat / Trajectory。
- 隐藏 DSH 文件树、预览、浏览器和终端 UI，文件浏览由现有主 Project 文件区承接。
- 主 Settings 导航新增 DSH 设置，包含“插件管理”和“运行设置”两个模式，优先复用官方 PluginManager / Settings 可独立表单并嵌入主 settings viewport；依赖完整外壳的部分由主应用表单调用对应服务，不使用单独 DSH sidebar。
- Models 继续使用主应用统一 AI 设置；Project 映射不建立第二份模型配置或凭据权威。

项目历史独立，模型、助手设置与插件配置默认共享；插件变更须影响实际运行时，并明确需重启等生效时机。文件链接和轨迹导航统一打开主 Project 预览，主文件区可向输入框插入文件引用；路径按会话所属项目解析并校验范围，外部附件上传保持真实语义。初期不扩展文件重命名或删除。

Chat 与 Trajectory 共用会话绑定和事件源；主应用保存项目 / 会话选择及布局，DSH 客户端保存内容与执行状态，避免复制完整消息记录。样式限定作用范围，主题、语言、字体、Portal、焦点与快捷键接入主应用，遵循滚动边缘、连续过渡和 reduced-motion 规范。

### 数据与非目标

DSH 历史仍使用按平台确定的 `project-mind-dsh` 数据根目录，`PROJECT_MIND_DSH_USER_DATA` 可用绝对路径覆盖，不读取默认 `~/.dsh`。独立调试模式的 `DSH_HOME` 使用该目录，profile 为 `profiles/assistant`，工作目录为目录下的 `workspace`，保存独立配置与凭据。主应用接入使用 `projects/<workspace-id>/shared-runtime` 作为共享 Harness 数据目录，每个范围映射独立 DSH workspace 与 Session，执行目录取实际 Workspace 根目录或原生 DB 的 `project.root_path`。历史子目录 `projects/<workspace-id>/workspace` 与 `projects/<workspace-id>/<project-id>` 是 #250 的迁移来源；迁移须保留原始证据、会话归属及附件，不把物理目录合并当作授权合并。模型配置仍共享主应用设置。

用户没有永久隔离配置或数据的要求；各范围历史与授权隔离不构成未来业务工具共享配置和数据的禁区。未来共享方式随真实业务需求确定，主应用统一设置保持唯一权威。

Project 映射读取原生 DB 的 Project 归属和实际根目录；本阶段不接入业务数据库工具桥，不转换旧 Pi 历史，不迁移 Overview/Memory 后台运行，不删除旧会话文件或数据库。也不替换 Tauri 为 Electron，不重写 Record/Todo/File/Memory 服务，不执行 Office/PPT 引擎准备。已有原生授权、Scope Grant、CAS、操作回执、成果确认和撤销语义不因后续工具接入而放宽。

### 开发与发布

本地开发必须先安装 `packages/dsh-assistant` 的 npm 依赖，使用本包 lockfile 重现安装。发布的 desktop prepare 将 DSH 资产和 production dependencies 放入 `resources/dsh-assistant`，复用桌面已有固定版本 Node 资源。

`start:dsh` / `dev:dsh` 保留为开发调试入口，使用独立模型配置，可在浏览器 Settings → Models 配置 Provider；这不是正常主应用使用路径，也不是主应用模型设置的第二个权威。

## 组件接入分阶段结果

| 阶段 | 结果 |
| --- | --- |
| 0：技术验证 | 原 Composer / Chat / Trajectory 的真实发送、流式、停止、失败恢复、cwd 与切换拦截 GUI 通过 |
| 1：组件包整理 | 固定源码、许可与样式边界，React 19 / Profiler 回归、正式与 debug 前端最终构建通过 |
| 2：会话与运行接入 | 两项目隔离、会话新建 / 发送 / 归档、重启持久及历史 orphan blank 恢复 GUI 通过 |
| 3：产品融合 | 文件双向引用、官方插件 / Shell 表单、跨项目共享设置、语言与 Portal GUI 通过 |
| 4：替换与收口 | 旧承载与 unstable 已移除，Node 5/5 集成与 25/25 单测、原生构建 / restage 通过；前端正式/debug 最终构建与主 Standards / Spec 自查通过；仅本地提交 |

## 通信、取消与依赖边界

- Web UI 通过官方 Connection 使用 HTTP unary RPC；Typert Remote 流使用 API gateway 的 WebSocket mux `/api/remote.mux`。会话与历史由同一个 Node Web runtime 提供，不新增第二个 SDK runtime。当前 Tauri 通信适配承载普通请求、事件流、取消、必要双向消息以及附件上传 / 读取，并保留连接恢复与会话重新绑定。网页认证限制来源，不能直接换 URL 认定接通；原生侧管理运行时凭据与调用归属，前端不获取模型密钥。
- 模型 Provider 的流式响应使用 SSE（本地测试 Provider 亦如此），与 UI Remote WebSocket 是不同链路。
- 已评估 `@deepseek-ai/dsh-sdk-client@0.2.0-rc.2`；其传递依赖引入完整 DSH CLI 与 Office/PPT adapters，当前 Web runtime 不安装或使用 SDK client。组件移植不用能力较窄的 stdio SDK 替换完整客户端协议；未来业务 adapter 根据实际接口确定。
- rc.2 stdio JSON-RPC SDK 没有轮次中取消方法，放弃轮次需要关闭其 runtime；当前 Web UI 使用 `dsh-api-session-controller` 的 `cancel`，调用 `agent.cancel({ kind: "user" }, { keepInbox: true })` 取消当前轮次，Web runtime 可继续服务。
- 官方 `dsh-web-app` 保留 `dsh-office-to-pdf` / `libreoffice-kit` 传递依赖，本包 overlay 禁用 `office-to-pdf`。安装这些传递包不代表执行 Office 功能；聊天入口无需 Office prepare、Office/PPT build 或引擎准备。

## 历史验证

独立阶段干净 npm ci、check:dsh / build:dsh、21/21 单测与 2/2 真实 Node 集成曾通过；独立浏览器模型配置、聊天、恢复以及旧 native WebView 三轮、model v3、HMR / 关闭行为按原范围保留。

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

主 agent 自行维护执行说明中的改动范围、提交、命令和最终自查结果。本次只更新并冻结指定三份文档，不运行构建、测试或 review。

## 后续迁移范围

后续工作依据真实业务模块和接口另行拆包，复用已有实现，不虚构工具接缝：

1. 接入原生业务工具、来源与成果操作；明确 Workspace 归属、授权、工具预算及原生写入回执，DSH 专有类型封装在助手边界。
2. 确定旧 Pi 会话读取或转换方案，保留原始数据；当前没有历史转换实现，不伪造恢复。
3. 迁移 Overview/Memory 等后台调用，并验证结构输出、生命周期与错误恢复；完成之前继续如实记录后台 Pi 的存在。
4. 按真实生产调用链清理不再使用的 Pi 直接依赖，核验资源、许可和平台安装包。上游若传递使用 pi-ai，应说明其来源，不将它等同于旧 Pi 聊天实现。

每包明确关联 Issue、依赖、交付、非目标、验收和验证范围；复用仍有效的验证，只因相关改动、失败或未解决风险扩大检查。主 agent 自行完成 Standards / Spec 检查，未经用户明确同意不启动 review 子 agent；本包按用户要求仅本地 commit，不 publish；不标记 #121 全面完成。

## 官方依据

- [DSH Desktop](https://github.com/dataelement/dsh-desktop/tree/115a0b474cc2c4794316171c640a8898398591fe)：复用上游 Harness 与 WebUI 的来源。
- [DSH SDK](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/sdk)：独立进程 JSON-RPC 与会话事件；当前 Web runtime 未安装 SDK client。
- [DSH SDK minimal](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/bundle/sdk-minimal)：显式 Cordis 组合的后续接入参考。

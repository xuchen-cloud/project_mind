# DSH React UI

将 DSH 原 React Chat、Trajectory、输入框、工具展示及设置组件接入主应用页面的前端包。组件与主应用共用 React 19 实例；原 WebView 对照属于历史接入记录；当前助手使用主页面原 React 组件，旧 native WebView 已全部删除，Cargo unstable 配置已移除。方案见 [组件融合方案](../../docs/requirements/dsh-ui-component-integration.md)。

## 架构与来源

- `upstream/`：固定 DeepSeek Harness `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84` 的必要客户端源码。文件哈希、原始哈希、本地修改、依赖策略及派生资产记录在 [provenance.json](provenance.json)；保留 [MIT LICENSE](LICENSE) 与 [第三方声明](upstream/THIRD_PARTY_NOTICES.md)。
- `adapters/client.jsx`：组装每个 Project 的 DSH 服务图，Chat 与主设置共享客户端、会话绑定及事件源，复用上游注册与 slot 渲染机制。
- `adapters/index.jsx`：导出 `DshConversationHost`、`DshSettingsHost` 和 `insertDshFileReference`，连接主应用回调、组件生命周期、Portal 与滚动边缘。
- `adapters/transport.mjs`：通过 Tauri 承载 HTTP RPC、Remote WebSocket mux 与上传读取所需请求，保留 DSH 客户端协议。模型 Provider 的流式响应仍使用 SSE；前端不获取模型密钥。
- `vite-aliases.mjs`：将浏览器入口映射到固定源码；运行依赖由根 `package-lock.json` 锁定，React / React DOM 去重到主应用实例。`styles/scoped.css` 由 `scope-styles.mjs` 生成，将上游主题规则限定于 `.dsh-ui-host`；Portal 使用宿主样式范围。

## 职责边界

主应用管理 Project 导航、会话列表及新建 / 切换 / 继续 / 删除入口、面板布局、文件浏览和预览、统一模型设置，以及主 Settings 内的插件管理 / 运行设置。DSH 组件提供 Chat / Trajectory、输入与停止、流式状态、工具卡片、历史分页及轨迹检查，不引入独立 sidebar、账户或 Models 页面，也不承载文件树、浏览器或终端 UI。

原生端管理 Node 生命周期、项目归属和工作目录：目录取 DB 实际 `project.root_path`，历史按 stable workspace ID / project ID 分目录。模型、密钥与代理仍由 `db.agent_resolve_profile(None)` 解析 MAIN Workspace General AI 配置并经 stdin 注入，密钥仅驻留运行时内存。项目切换不能串用事件或静默终止执行，面板隐藏 / 卸载不能丢失历史。

本包不转换旧 Pi 历史、不提供业务数据库工具桥、不迁移后台 Pi 任务，也不启用 Office/PPT 引擎；Node 服务与发布资源由 [dsh-assistant](../dsh-assistant/README.md) 及桌面原生层负责。

## Debug 工作区密码

当前所有 debug 构建采用免手动输入密码的工作区流程，不限于 DSH 验收启动。新工作区自动生成加密密码并存入系统钥匙串；已有缓存的工作区打开时自动解锁。原有加密工作区若没有缓存，首次仍需初始化：手动解锁一次以建立缓存，或通过 `PROJECT_MIND_DEV_WORKSPACE_PASSWORD` 提供能实际解密该工作区的密码。不会绕过原有加密校验；release 流程不受此 debug 行为影响。

## 命令

从仓库根目录执行；本包使用根依赖安装与主应用 Vite 构建，没有独立启动或 `build` 脚本。

```sh
npm --prefix packages/dsh-ui run generate:styles
npm --prefix packages/dsh-ui run check:source
npm --prefix packages/dsh-ui run check:adapters
npm --prefix packages/dsh-ui run test:integrity
```

`generate:styles` 更新派生 CSS；`check:source` 验证上游浏览器源码构建，`check:adapters` 同时验证宿主适配器，检查未解析导入与独立网页 ModuleLoader 依赖；`test:integrity` 检查 vendor 来源完整性。脚本名称以 [package.json](package.json) 为准。

组件及适配器针对性测试使用根脚本：

```sh
npm run test:unit -- packages/dsh-ui/vendor-integration.test.tsx packages/dsh-ui/inventory-bootstrap.test.tsx packages/dsh-ui/commands-bootstrap.test.ts packages/dsh-ui/client-bootstrap.test.tsx packages/dsh-ui/adapters/transport.test.ts
npm run build
```

上述为可用命令，本次文档工作未运行测试或构建。

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

## Project File preview / #124 WP4

新增独立 [preview](preview/README.md) 导出，真实复用固定 DSH documentpreview 格式正文、缩放和 PDF 生命周期；输入由主应用 File / File Version 读取，不依赖 Session/模型。PDF Worker 与 cmap/font/wasm 纳入正式构建，许可与 SHA-256 在 preview 清单。HTML 使用原 DSH BasicHtmlFrame / sanitizer / CSP 做空 sandbox 静态预览，源码直接用同一 fixed text 的 DSH TextBody 行定位；无调用的原 FileHtmlPreview 已移除；当前入口是 ProjectFileContent，#115 交互执行仍未验收。current Markdown 图片及静态 HTML 图片/stylesheet 经 bound native resolveRelated + 固定 readBytes 加载；历史未保留的关联资源明确限制。Office 编辑不在本包。验证与具体限制见 [WP4 交接](preview/HANDOVER.md)。

## 运行中过程折叠适配（2026-10-22，#202）

ChatGroupSeat 将详细模式（含旧设置映射）的运行中过程也保留在单行最新活动标题下；原来的 history 判断在 Turn 运行时跳过分组，导致思考与工具步骤全部展开。沿用原活动摘要、150ms 标题更新节流、搜索可揭示的隐藏正文和滚动控制器；点击展开/收起后，流式活动不重置用户选择，过程组完成时重置为收起。显式“完全展开”模式继续展示正文。全局 disclosure、Turn 外层策略与其他组件不变。

针对真实 ChatGroupSeat / ChatNodeSeat 的回归（业务正文使用 fixture slot）：

```sh
npm run test:unit -- packages/dsh-ui/process-disclosure.test.tsx
npm --prefix packages/dsh-ui run test:integrity
```

红测试：standard 默认折叠通过，detailed 的标题不可访问且正文可见，2 failed / 1 passed。修复后 6/6 通过，覆盖默认单行、活动更新、展开/收起、流式新增、完成折叠、显式 verbose，以及展开时滚动跟随、用户向上滚动停止跟随和 reduced-motion。vendor integrity 3/3 与 adapters 浏览器构建通过。主 agent 在 develop 335a31b 加本补丁的 macOS 原生界面中，使用真实模型连续执行三次短命令，确认运行中默认单行、手动展开、完成折叠及重新展开/收起。未重跑无关全仓构建。主 agent Standards / Spec 自查无剩余发现。

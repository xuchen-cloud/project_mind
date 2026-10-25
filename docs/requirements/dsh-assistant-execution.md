# 主应用 DSH 助手工作包

日期：2026-10-11。关联规格：#121 及[组件融入方案](dsh-ui-component-integration.md)。旧独立助手交接已被主应用接入取代并移除；本文保留当时实施证据。无独立 DSH Issue；本包不发布、不关闭历史 Issue。

2026-10-25 架构更新：[#250](https://github.com/xuchen-cloud/project_mind/issues/250) 将物理承载统一为当前 Workspace 的单个常驻 Harness，Workspace / Project 保留各自 Session、cwd 与原生权限。早期“运行中拦截项目切换”已被 A27 的后台并发、定向停止要求取代。下文验证表保留 2026-10-11 当时证据，不作为 #250 的验收结论；重构范围见 [共享后端交接](dsh-shared-runtime-handover.md)。

## 依赖与交付行为

- 复用 DSH 0.2.0-rc.2 的原 Chat、Trajectory、composer、工具结果、权限与 Plugin 组件。前端源码固定于 `639ed015397290b3745d163aafe02ffee4aa3f84`，闭包、许可与必要改造见 [组件 README](../../packages/dsh-ui/README.md)。同一个 React 19 根树加载这些组件。
- 主应用 Project 对应 DSH workspace，cwd 使用数据库记录的真实项目目录；项目下列出、创建、选择及移除对应会话。移除使用上游 archive，保留历史文件。
- 原生端管理当前 Workspace 的一个常驻 Node Harness，读取主工作区的 General 模型、解密凭据及网络配置，通过私有 stdin 注入；前端只接收经过当前 Session scope 授权的 HTTP RPC 和 WebSocket mux 数据，不接收密钥或 runtime 认证令牌。
- 主应用“助手”入口使用组件面板，替换旧 Pi 聊天面板及消息 UI。保留原业务后台 Overview/Memory 与文档 worker。
- DSH 自带侧栏不挂载。设置和 Plugin 组件进入主应用设置面板；项目文件树、只读预览、行定位和文件引用由主应用负责。
- 全 debug 构建适用自动解锁：新工作区自动生成密码并保存至系统钥匙串；已有工作区验证密码后缓存，之后打开自动解锁。原有加密工作区没有缓存时需要一次初始化，不能跳过解密。仅 debug 接受专用开发密码环境变量，正式构建保留原密码行为。

## 非目标

业务数据库工具桥、旧 Pi 历史转换、Overview/Memory 后台运行迁移、Office/PPT 引擎、远端发布与关闭 Issue。当前前端采用固定编译的组件闭包，不提供独立 DSH 登录、模型设置、浏览器 ModuleLoader 或另一棵 React 树。

## 验收条件与验证范围

1. 在主应用当前窗口完成真实发送、流式、Chat / Trajectory 切换、停止与失败恢复；无需 Electron 或独立浏览器。
2. 两个真实 Project 的目录、会话和权限互相隔离，共用 Workspace 常驻 Harness；运行中切换项目保留任务，停止仅作用于目标 Session；关闭后重新读取历史。
3. 会话创建、选择、移除和档案持久化使用真实 runtime。模型沿用统一 General 配置，无独立登录步骤。
4. 原生传输支持项目归属校验、请求取消、二进制附件、连接关闭及原组件重连。文件访问须在实际项目目录内，拒绝越界与 symlink 逃逸。
5. 设置及 Plugin 数据来自同一个 runtime；文件预览及引用融入主应用。组件 Portal 继承主应用主题；有界列表按实际溢出显示渐变边缘。
6. debug 新建和重新打开工作区无需反复输入密码，覆盖所有目录；已有加密数据无缓存时说明初始化原因。release 不包含 debug 自动解锁路径。
7. 主 agent 自行完成 Standards / Spec 双轴检查，不启动未经用户授权的 review 子 agent。

编译、单元和 runtime 集成保持静默；保留用户已有 `tauri dev --no-watch` 窗口。界面验收集中使用独立测试 App 数据目录、两个真实项目目录及本地测试 Provider，不将其结果当作真实外部模型验收。

## 验证记录

2026-10-11，在本地 Provider 与隔离测试 App 上集中验收。测试 App 使用真实原生端、Node runtime 和原 DSH 服务/组件，未调用外部模型。

| 范围 | 命令或行为 | 结果 |
| --- | --- | --- |
| 原生构建 | `cargo build --quiet`，22:54；已移除旧 WebView 与 Cargo unstable | 通过 |
| 原生 DSH | `cargo test --lib dsh_assistant::tests --quiet`，23:02 | 12 通过、1 忽略；含实际 mux / Channel ACK |
| Debug 密码 | `cargo test --lib debug_workspace --quiet` | 3 通过；正式构建 `cargo check --release --lib --quiet` 通过 |
| 文件边界 | `cargo test --lib project_directory::tests --quiet` | 5 通过 |
| Node 最终验证 | `node --test test/runtime.integration.mjs` / `node --test test/*.test.mjs`，23:10 | 5 / 25 通过；含两项目、共享模型、archive 重启、历史空会话归属恢复 |
| 前端 | 项目会话、设置、App 与 debug 针对性测试；文件入口、传输 | 60 + 延迟回调 2、文件 9、传输 3 通过 |
| 全 debug 前端边界 | `TAURI_ENV_DEBUG` 配置判定与 App / 设置 / 密码 UI 针对性测试 | 最终 36 通过；覆盖开发、debug 生产资源与 release |
| 最终前端构建 | `npm run build`；`TAURI_ENV_DEBUG=true npx vite build --outDir $TMPDIR/mind-dsh-debug-final-dist`，23:13 | 两种模式均通过 |
| 原组件 | 实际服务 bootstrap、React 19 Profiler、vendor、integrity、inventory、commands | 分别 6、6、5、3、2、1 通过 |
| 打包 | `npm run test:desktop-runtime`；最新 production restage，23:08 | 14 通过；资源清单验证通过 |
| GUI 消息 | 真实发送、流式、Chat / Trajectory、正确 cwd、15 秒任务停止后续发、400 失败后恢复 | 通过 |
| GUI 项目与会话 | A / B 独立目录及菜单；运行中拦截切换；B 新建和归档后重启仅剩首会话；A 历史空会话恢复后实际发送 | 通过 |
| GUI 文件与设置 | 主目录树与 README 预览；预览引用进入原输入框后发送，消息文件按钮打开主预览；主设置官方插件表单保存，A 保存 61000 后 B 读回；中文 Portal 与聊天 | 通过 |
| GUI 自动解锁 | 多次关闭、重启 App，未提供密码环境变量 | 通过 |

已补齐 `tauri build --debug` 的生产前端密码 UI 判定。静态构建通过不能代替上述 GUI；本地 Provider 结果不能代表外部模型兼容验收。

## 主 agent 双轴检查

- Standards：检查实际组件闭包与来源许可、单 React 根树、服务激活顺序与释放、异步选择取消、项目归属和原生凭据边界、文件 canonical/symlink 校验及 archive 持久性；发现的开发 Profiler、busy 通知时序、历史空会话归属问题已修复并回归。
- Spec：核对 Project → workspace/cwd 映射、项目范围会话、原 Chat/Trajectory/Composer、统一 General 模型、主设置/插件与主文件浏览入口、删除旧 Pi 聊天以及全 debug 自动解锁。核查发现 `tauri build --debug` 与 Vite DEV 判定不同，已补齐并通过对应 UI / 构建验证。
- 两轴检查完成，无剩余阻塞项。保留原有未关联修改，不纳入本包提交；测试 App 与本地 Provider 已退出。
- 未启动 review 子 agent。后台 Pi 业务服务与旧历史转换属于非目标；本包仅本地提交，未发布或关闭 #121。

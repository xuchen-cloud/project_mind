# HTML 原生网页运行：实现与验证

日期：2026-10-23。Issue：[#115](https://github.com/xuchen-cloud/project_mind/issues/115)，父需求 [#118](https://github.com/xuchen-cloud/project_mind/issues/118)。实现基线：`7affb2383c4278d32381300005435c0165737392`，分支 `codex/html-webview-preview`。范围：[H01–H04 需求](../requirements/html-webview-preview.md)。

## 工作包与交付

- 依赖：现有 File、Workspace binding/generation、项目文件内容组件、版本与项目标签布局。
- H01：每执行会话独立 loopback HTTP 服务，认证、Host/Origin 检查、有界缓存/并发/超时/诊断、撤销；通过现有 File 服务读取原始字节和目录内资源。
- H02：直接复用已锁定的 Wry 0.54.4 原生 child，不注册 Tauri 初始化、invoke 或 asset/tauri 资源协议。独立临时 WebContext；异步 command 调度主线程，避免 WebView2 同步创建死锁。唯一网页消息通道只接收有界诊断文本。
- H03：`ProjectFileContent` 默认打开原生网页，保留源码/版本/刷新及外部打开；支持后退/前进和自适应/375/768/1440 视口。普通隐藏保留会话；遮挡/拖动隐藏原生层；关闭、源码、版本、刷新、Workspace 切换或宿主重载撤销会话。创建前捕获宿主文档生命周期，重载后迟到的创建不能复活。
- 非目标：源码编辑器、npm/后端启动器、完整下载管理与历史依赖原子快照。历史主文件仍按固定版本读取，缺少依赖快照时明确报错。
- 验收范围：新 HTTP/File/native 模块、组件生命周期、现有文件/项目标签接缝、TS/生产与原生构建、macOS 实际 Wry 集成。Windows 与完整项目壳验收单列。

## 自动验证

以下通过项对应本分支最终实现；前端未在通过后再改动。主线程文档生命周期与中文错误提示修改后重跑全部 17 项 Rust 网页测试，并重新完成默认配置原生构建。

| 检查 | 命令 / 范围 | 结果 |
| --- | --- | --- |
| Rust 网页模块 | `cargo test --manifest-path src-tauri/Cargo.toml --lib html_preview --quiet` | 17 通过：4 项真实 File/DB、8 项真实 HTTP、5 项 native 导航/坐标/缩放/生命周期 |
| 新前端服务与组件 | Vitest：`HtmlWebviewContent.test.tsx`、`htmlPreviewApi.test.ts` | 15 通过，覆盖迟到创建/过期响应、版本/代际/Project、隐藏、遮挡、导航和视口 |
| 已有文件/项目接入 | Vitest：`ProjectFileContent`、`ProjectContentWorkspace`、`ProjectContentLayoutView`、`ProjectFilePreviewLayer`、`ProjectSidebar` | 156 通过 |
| 类型 | `tsc --noEmit` | 通过 |
| 前端生产构建 | `node node_modules/vite/bin/vite.js build` | 通过 |
| 默认原生配置构建 | `cargo build --manifest-path src-tauri/Cargo.toml --bin project_mind_alpha --quiet` | macOS 通过；未启动应用窗口 |
| UI 规范 | `node scripts/check-ui-standards.mjs` | 通过 |
| 包边界与体积 | `node scripts/check-bundle-boundaries.mjs` | 通过，入口 249 KiB / 250 KiB |
| 可移植文档路径 | `node scripts/check-portable-paths.mjs` | 全仓检查被既有文档绝对路径阻塞；本次新增/修改文档无新增违规 |
| diff | `git diff --check` | 通过 |

开发中先确认 File/native 缺失实现、固定 CSS 视口缩放、宿主重载失效用例失败，再补实现通过。HTTP 模块的真实请求测试在集成时通过，不把它们记作已记录红灯的 TDD 证据。

### 构建环境与复用

该 checkout 原先没有 node_modules；复用了锁文件完全一致的本机工作树依赖。首轮 `npm run build` 停在未改动的 Office 构建下载 GitHub 资源时 TLS 连接被重置，因此不记为全命令通过。

随后复用源码树一致的 Office 构建产物，完成 TS 与 Vite 生产构建。三个源码树指纹为：

- office-docx：`c97c0ef21477d9dab5e09cc39b048702a3806846`
- office-xlsx：`c4f3173851b7929b14ed40424230c57ed0d3ba3c`
- office-pptx：`04f280b32ae4fa5e819139aad1ff3d6200a99afc`

这些产物和临时测试入口均未提交。没有修改 Office 源码、依赖或锁文件来绕过失败。沿用现有 Cargo 缓存，不启动 Tauri 自动监听或重启用户应用。

## macOS 原生集成验收

使用单独测试应用数据与临时 Workspace。测试入口直接装配真实 `ProjectFileContent`、真实 Tauri command、File/DB 与原生 Wry；没有用 iframe、浏览器 DOM fixture 或 mock 替代原生子视图。临时入口和进程已清理。

| 行为 | 实际结果 |
| --- | --- |
| 中文/空格目录，多文件网页 | HTML、相对 CSS、JS、ES module 正常；按钮与输入的事件 `isTrusted=true` |
| 跨源脚本/API | 独立测试 HTTP 源的脚本与允许 CORS 的 API 正常；不放宽 WebView CORS |
| 外部网站 | 在该子视图打开 [Wikipedia](https://www.wikipedia.org/)，输入 `Web browser` 搜索并实际跳转到文章，前进/后退可回外部首页与本地第二页 |
| 新窗口链接 | 本地 `target=_blank` 链接在同一原生子视图打开第二页 |
| 固定视口 | 页面实测 `innerWidth` 分别为 375、768、1440；自适应实测跟随内容区域 |
| 普通隐藏/显示 | 网页从原生 AX 树消失后重新出现，点击计数保留，未重建会话 |
| DOM 对话框遮挡 | 遮挡期间原生网页隐藏；关闭对话框后恢复相同计数 |
| 源码 | 显示原始 HTML；旧原生层移除，旧 HTTP 端口拒绝连接；返回网页使用新会话 |
| 刷新 | 旧 HTTP 端口停止监听，新端口/会话加载；计数重置，localStorage 初始值为空 |
| 关闭/重开 | 关闭后旧端口拒绝连接；重开得到新会话并正常显示 |
| 隔离 | `window.__TAURI_INTERNALS__` / `window.__TAURI__` 均为 undefined；asset、file、tauri 读取探针均不可读；同一会话内存储存在，重建会话为空 |
| 诊断 | 缺图和主动抛出的脚本错误可见；外部站点一次搜索建议资源失败也如实显示，实际文章导航成功 |

此证据覆盖原生组件集成；完整产品壳中的分栏、跨窗口/屏幕拖移、所有版本恢复入口及安装包仍需单独验收。最终自查补充的宿主文档失效边界由回归单测与原生构建验证，没有将此前 GUI 结果冒称为该竞态的实机复现。

## Windows 状态与解锁条件

已实现 WebView2 需要的异步主线程调度、独立临时数据目录、物理坐标/DPI 换算与固定 CSS 视口缩放。HTTP 真请求测试覆盖盘符、UNC、反斜线、ADS、编码/二次编码穿越；真实 File 测试覆盖中文空格与 Unix 符号链接逃逸。Windows junction、句柄释放和原生隔离不能据此标记通过。

尝试 `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --lib --quiet`，当前 macOS 没有 Windows SDK/MSVC 头文件，现有 `ring 0.17.14` C 构建报 `assert.h file not found`。检查尚未到达本项目的 Windows Rust 编译，不能称为编译通过或认定没有 Windows 专属错误。

解锁条件：具备 Windows SDK/MSVC 的构建环境与实际 Windows WebView2。完成原生构建和安装，再验收 100%/125%/150%/200% DPI、跨屏/分栏/遮挡、中文空格/大小写/junction、存储/IPC/协议探针，以及初始化失败与关闭后的 profile/句柄释放。

## Standards / Spec 主 agent 自查

- Standards：按基线检查完整变更，复用现有 File/归属/绑定与固定版本，不增建版本仓库或通用代理；诊断只传有界文本，缓存和资源读取有预算。修复宿主重载早于 Session 插入的异步失效问题。当前执行包无剩余已知代码发现。
- Spec：H01–H03 已实现，相关组件与 native 证据通过；H04 的 Windows/完整壳/安装验收仍未完成。原 #115 的源码编辑和完整历史依赖快照保留后续范围；不将当前包当作整个 Issue 完成。
- 未启动 review 子 agent。依据发布流程，当前不自动合并或关闭 #115/#118。

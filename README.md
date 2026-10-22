# ProjectMind

ProjectMind 是一个 `workspace-first`、本地优先的桌面工作台，当前技术栈为 `Tauri 2 + React 19 + TypeScript + SQLite`。它围绕 Workspace、Project、QuickNote、Record、Voice Record、Todo 与受管文件组织信息，并提供可配置的编辑器 AI 技能。

## 当前产品基线

- 通过 `Workspace Gate` 打开或创建工作区，并把数据库、配置、AI 缓存、日志与临时文件统一保存在工作区根目录下的 `.project-mind/`
- 提供始终可访问、不可关闭的 Workspace 图标页签，作为工作区级入口
- 在工作区页维护一份固定单例的 `Workspace QuickNote`
- 在工作区页维护工作区级Record列表，并支持新建、编辑、删除记录
- 在工作区页维护跨项目 Todo 视图，支持创建、状态切换、优先级、进展、引用、联系人提及与标签
- 在 Workspace 和 Project 首页将封面、标题、QuickNote 与 Record 编排为统一页面，滚动后标题吸顶
- 在项目Record中支持富文本正文、标题、`#标签` 自动同步、内部引用 `[[...]]`、联系人提及 `@...`
- 在项目侧边栏浏览记录与文件，支持搜索、标签筛选、文件导入、重命名、标星、版本切换、删除与拖拽导入
- 提供顶栏全局搜索、项目页签、归档项目入口、设置入口与工作区菜单
- 提供可配置、可绑定模型的编辑器 AI 技能
- 在 Project 内用独立内容页签打开 Record、File 和 DSH 会话，支持双栏、排序、移栏和布局恢复
- 在应用内预览文本、代码、Markdown、图片、PDF 和静态 HTML；读取和引用绑定实际 File 身份及版本
- Project 助手复用 DSH 原 Chat、Trajectory、输入框和插件设置，沿用工作区模型配置，可在输入区选择已配置模型
- 提供项目标签、联系人、AI 设置、富文本样式、页面宽度等设置能力
- 支持 Voice Record 双轨录音、录音恢复、纯录音、本地或云端识别、实时字幕、转写回放、搜索和会议纪要

## 当前主路由

- `/workspace`：工作区
- `/workspace/records/:noteId`：Workspace Record 焦点页
- `/projects/:projectId`：项目首页
- `/projects/:projectId/records/:noteId`：Project Record 焦点页
- `/projects/:projectId?content=<tabId>`：Project File 或会话内容页签
- `/settings/:section`：设置路由桥接

## 运行方式

需要本地可用的 `Node.js`、`Rust` 和 Tauri 桌面依赖。开发与测试建议使用 Node.js 24.21 或更新的 24.x（测试 DOM 依赖要求至少 24.15；22.x 至少 22.22.2）。

```bash
npm install
npm run dev:tauri
```

开发时需要避免源码变化自动重开窗口，可使用 `npm run dev:tauri:manual`。两个开发入口均先静默编译内置 `mind`，使会话使用与源码一致的 CLI，无需安装到系统 PATH。debug 工作区可使用开发专用本地密钥缓存自动解锁；正式构建仍执行密码与凭据保护。

仅启动前端：

```bash
npm run dev
```

构建：

```bash
npm run build
```

构建会按各包 lock 安装 Word、PPT、Excel、Markdown 的局部依赖，并校验固定上游源码。首次仅启动开发服务器前，先运行 `npm run build:office` 生成编辑器资源。Windows 构建使用 Windows 的 Node 与 XLSX sidecar，PDF/打印接入 WebView2；macOS 使用 WKWebView。

前端单元测试：

```bash
npm run test:unit
```

UI 约束检查：

```bash
npm run check:ui-standards
```

生产分包边界检查（先执行构建）：

```bash
npm run build
npm run check:bundle-boundaries
```

后端检查：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## Workspace 结构

```text
<workspace-root>/
  .project-mind/
    workspace.json
    workspace.sqlite3
    cache/ai/
    logs/
    tmp/
  <Project A>/
    .project-mind/embedded-note-assets/
  <Project B>/
```

说明：

- `workspace.sqlite3` 是当前业务主库
- 项目实体对应工作区根目录下的真实项目文件夹
- 项目导入文件默认落到对应项目目录
- 记录中托管的图片资源落在 `<project-root>/.project-mind/embedded-note-assets/`

## 生成演示 Workspace

```bash
npm run seed:demo -- --password "demo-password"
```

默认会在 `~/Documents/ProjectMind Demo Workspace` 下生成仅包含当前领域对象的演示数据，也可以指定路径：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin seed_demo_data -- --workspace-root "/path/to/demo-workspace" --password "demo-password" --force
```

## 目录结构

- `src/`：React 前端、页面、编辑器、状态管理、Tauri API 封装
- `src-tauri/`：Tauri 宿主、SQLite 数据层、工作区运行时、文件与 AI 命令
- `docs/product-prd.md`：当前产品基线
- `docs/system-design.md`：当前系统架构与模块边界
- `docs/alpha-ux.md`：当前信息架构与主用户流
- `docs/design-system.md`：当前设计与交互约束
- `docs/remaining-work.md`：当前唯一的仓库内未完成事项总表
- `docs/README.md`：文档索引与归档规则
- `.impeccable.md`：设计上下文与产品气质

## 当前限制

- 当前数据库 schema 为 v37，包含原生 AI、Record/文件版本、会话索引、Overview 和记忆服务；旧领域数据通过兼容迁移复制为当前 Record。
- DSH 会话通过应用附带的 Mind CLI 接入当前作用域的原生 Record/Todo/File 读取与保存；固定 File 来源与自动版本管理仍沿用原生服务。知识/记忆的完整统一工作流仍未交付；原生保存和外部 CLI/MCP 继续保留。
- Office 编辑仍处于候选验证阶段；静态 HTML 预览禁用脚本、导航与表单，不代表交互 HTML 执行能力已交付。
- macOS 是当前主要开发和验证平台；Windows 的 Voice Record 与页面驻留仍缺完整实机验收。
- 当前未完成事项统一记录在 [`docs/remaining-work.md`](docs/remaining-work.md)。

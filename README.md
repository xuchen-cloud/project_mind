# Project Mind Alpha

Project Mind Alpha 是一个 `workspace-first`、本地优先的桌面工作台，当前技术栈为 `Tauri 2 + React 19 + TypeScript + SQLite`。它围绕“工作区、QuickNote、Record、Todo 与受管文件”组织信息，并在本地工作区内提供 AI 总结与 Ask 问答。

## 当前产品基线

- 通过 `Workspace Gate` 打开或创建工作区，并把数据库、配置、AI 缓存、日志与临时文件统一保存在工作区根目录下的 `.project-mind/`
- 提供始终可访问的 `Workspace / 工作区` 页面，作为工作区级入口
- 在工作区页维护一份固定单例的 `Workspace QuickNote`
- 在工作区页维护工作区级Record列表，并支持新建、编辑、删除记录
- 在工作区页维护跨项目 Todo 视图，支持创建、状态切换、优先级、进展、引用、联系人提及与标签
- 在项目页维护项目名称、QuickNote与项目级Record
- 在项目Record中支持富文本正文、标题、`#标签` 自动同步、内部引用 `[[...]]`、联系人提及 `@...`
- 在项目侧边栏浏览记录与文件，支持搜索、标签筛选、文件导入、重命名、标星、版本切换、删除与拖拽导入
- 提供顶栏全局搜索、项目页签、归档项目入口、Ask 入口、设置入口与工作区菜单
- 提供 `Project Brief` 与 `Daily Brief` 两类 AI artifact，以及基于当前范围的单轮 Ask
- 提供项目标签、联系人、AI 设置、富文本样式、页面宽度等设置能力

## 当前主路由

- `/workspace`：工作区
- `/projects/:projectId`：项目Workspace与项目Record
- `/projects/:projectId/records/:noteId`：记录焦点页
- `/settings/:section`：设置路由桥接

## 运行方式

需要本地可用的 `Node.js`、`Rust` 和 Tauri 桌面依赖。

```bash
npm install
npm run dev:tauri
```

仅启动前端：

```bash
npm run dev
```

构建：

```bash
npm run build
```

前端单元测试：

```bash
npm run test:unit
```

UI 约束检查：

```bash
npm run check:ui-standards
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

默认会在 `~/Documents/Project Mind Alpha Demo Workspace` 下生成演示数据。也可以直接调用 Rust bin：

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
- `.impeccable.md`：设计上下文与产品气质

## 当前限制

- 当前正式主路由以工作区和项目Workspace为主，仓库中仍有部分旧 Activity 代码与测试遗留，尚未作为当前主产品面暴露
- Ask 当前只保留最新一条回答，不提供多轮历史
- AI artifact 当前只保留 `project_brief` 与 `daily_brief`
- 当前只明确验证了 macOS 桌面工作流，其他平台仍需补完整验收

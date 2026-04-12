# Project Mind Alpha

本仓库实现了 Project Mind Alpha 的 `workspace-first`、本地优先桌面应用原型，技术栈为 `Tauri 2 + React 19 + TypeScript + SQLite`。应用围绕 `Workspace -> Project -> Activity` 组织资料、记录、结论、Todo 与 AI 辅助流程。

## 当前能力
- 打开或新建 Workspace，并把数据库、配置、AI 缓存、日志和临时文件统一收纳在 Workspace 下的 `.project-mind/`
- 记录最近使用的 Workspace，支持切换 Workspace、打开 Workspace 根目录，以及锁定 / 解锁 AI secrets
- 在当前 Workspace 内创建项目，并在根目录下生成同名项目文件夹
- 在项目页维护摘要、项目级文件、结论时间线、Todo Rail，并支持归档 / 恢复项目
- 在项目内创建 Activity，维护活动属性与活动状态字典，并自动为 Activity 生成独立目录
- 在 Activity 中编写记录，支持自定义记录类型与模板、富文本正文、图片 / 附件 / 表格、截图粘贴、文件插入和单条记录置顶
- 在 Activity 中沉淀结论，并提升到项目首页展示
- 在项目级与 Activity 级创建 Todo、切换状态、调整优先级并追加进展
- 管理项目 / Activity 文件，支持拖拽导入、导入前批量打标签、标签筛选、打开 / 定位 / 重命名 / 标星 / 删除、版本浏览与新增版本、失效检测
- 在顶部工作台搜索项目、活动、结论、Todo 和文件，并跳转到对应锚点
- 提供 `Today`、`Ask`、`Activity Summary`、`Project Brief` 等 AI 入口
- 配置 AI provider profile、能力绑定、能力开关、执行并发，并用 Workspace 密码加密保存 API Key
- 配置富文本正文、标题和列表的全局排版样式

## 运行方式

需要本地可用的 `Node.js`、`Rust` 和 Tauri 桌面依赖。

```bash
npm install
npm run tauri dev
```

仅构建前端：

```bash
npm run build
```

运行前端单元测试：

```bash
npm run test:unit
```

检查 UI 约束：

```bash
npm run check:ui-standards
```

仅检查 Rust/Tauri 后端：

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
    <Activity A>/
    <Activity B>/
  <Project B>/
```

说明：

- Workspace 级元数据与数据库存放在 `<workspace-root>/.project-mind/`
- 项目实体对应 Workspace 根目录下的真实项目文件夹
- Activity 级文件默认落在对应项目目录 / Activity 目录下
- 记录里插入的托管图片资源落在 `<project-root>/.project-mind/embedded-note-assets/`

## 生成演示 Workspace

```bash
npm run seed:demo -- --password "demo-password"
```

默认会在 `~/Documents/Project Mind Alpha Demo Workspace` 下生成完整的 demo workspace。也可以直接传参自定义：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin seed_demo_data -- --workspace-root "/path/to/demo-workspace" --password "demo-password" --force
```

## 目录结构
- `src/`：React 前端、页面布局、编辑器组件、状态管理、Tauri API 封装
- `src-tauri/`：Tauri 宿主、Workspace 运行时、SQLite 数据层、文件系统能力、AI 作业与命令接口
- `docs/product-prd.md`：基于当前实现整理的产品基线 PRD
- `docs/system-design.md`：当前 workspace-first 架构、模块边界与数据流
- `docs/design-system.md`：当前视觉基础、组件约束、状态语义与交互规则
- `docs/alpha-ux.md`：当前信息架构、页面职责、核心用户流与状态清单
- `.impeccable.md`：项目设计上下文

## 当前限制
- 文件失效后的“重新定位”流程后端已具备，但前台仍以提示重新导入为主
- 文件角色 UI、项目级 Conclusion 直接创建入口尚未完整开放
- 不包含显式导出向导；当前导入 / 导出方式是直接复制整个 Workspace 目录
- `Ask` 默认只保留最新一轮问答，不提供多轮会话历史
- 当前只验证了 macOS 构建；Windows 兼容按代码层和路径层预留，但未做真机打包验收

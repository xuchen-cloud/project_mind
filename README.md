# Project Mind Alpha

本仓库实现了 Project Mind Alpha 的本地优先桌面应用原型，技术栈为 `Tauri + React + TypeScript + SQLite`。

## 当前能力
- 创建项目，并在指定工作目录下生成同名项目文件夹
- 在项目内创建 Activity，并维护活动属性与活动状态字典
- 在 Activity 中编辑 quick note 与 meeting minutes
- 在 Activity 中沉淀结论，并提升到项目首页展示
- 在项目级与 Activity 级创建 Todo、切换状态并追加进展
- 导入文件到项目受控目录，支持打开、打开所在位置、新增版本、重命名、标星、删除与失效检测
- 在顶部工作台搜索项目、活动、结论、Todo 和文件
- 配置 AI provider、测试连通性，并从 Note 生成候选结论 / Todo
- 配置富文本正文、标题和列表的全局排版样式

## 运行方式
```bash
npm install
npm run tauri dev
```

仅构建前端：

```bash
npm run build
```

仅检查 Rust/Tauri 后端：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

重置当前本地数据库并写入一套演示数据：

```bash
npm run seed:demo
```

默认会写入当前应用的本地 SQLite，并在 `~/Documents/Project Mind Alpha Demo Workspace` 下生成演示项目目录与导入源文件。也可以直接传参自定义：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin seed_demo_data -- --db-path "/path/to/project_mind_alpha.sqlite3" --workspace-root "/path/to/demo-workspace"
```

## 目录结构
- `src/`：React 前端、页面布局、编辑器组件、状态管理、Tauri API 封装
- `src-tauri/`：Tauri 宿主、SQLite 数据层、文件系统能力、AI 接入与命令接口
- `docs/product-prd.md`：基于当前实现整理的产品现状基线 PRD
- `docs/alpha-ux.md`：当前信息架构、页面职责、核心用户流与状态清单
- `docs/design-system.md`：当前视觉基础、组件约束、状态语义与工程守则
- `.impeccable.md`：项目设计上下文

## 当前限制
- AI 的 `assistant` / `summary` 能力仍停留在绑定配置层，前台尚无独立工作流
- 文档版本历史浏览 UI、文件角色 UI、项目级结论创建入口尚未完整开放
- 不包含导出、云同步和多人协作
- 当前只验证了 macOS 构建；Windows 兼容按代码层和路径层预留，但未做真机打包验收

# Project Mind Alpha

本仓库实现了“项目资料管理系统”Alpha 版本的本地优先桌面应用原型，技术栈为 `Tauri + React + TypeScript + SQLite`。

## 当前能力
- 创建项目，并在指定工作目录下生成同名文件夹与 `documents/` 受控目录
- 在项目内创建活动时间线，支持折叠/展开、固定展开、整理状态切换
- 在活动内追加 quick note、编辑 meeting minutes
- 手动沉淀 Conclusion / Todo，并在项目首页汇总关键结论与未完成待办
- 更新 Todo 状态与进展记录
- 导入文件并复制到项目目录，支持角色区分、标星、失效检测与重新定位
- 使用本地 Mock AI 生成标题 / 结论 / 待办候选，并由用户确认采纳

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

## 目录结构
- `src/`：React 前端、页面布局、编辑器组件、状态管理、Tauri API 封装
- `src-tauri/`：Tauri 宿主、SQLite 数据层、文件系统能力、AI Mock、命令接口
- `docs/alpha-ux.md`：信息架构、核心用户流、低保真说明与状态清单
- `.impeccable.md`：项目设计上下文

## 当前限制
- AI 仍为 Mock 适配器，尚未接入真实模型
- 不包含搜索、标签体系、归档、导出、云同步和多人协作
- 当前只验证了 macOS 构建；Windows 兼容按代码层和路径层预留，但未做真机打包验收

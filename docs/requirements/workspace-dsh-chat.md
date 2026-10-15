# Workspace DSH 聊天

日期：2026-10-15。关联 [#161](https://github.com/xuchen-cloud/project_mind/issues/161)，承接 #108/#121 中 Workspace 聊天入口差距；本包不关闭这两个更大范围的 Issue。

## 工作包

- 依赖：现有 DSH Chat / Trajectory / composer、原生传输和模型配置、Workspace 身份与 generation、独立 Project 运行时。
- 交付：已打开 Workspace 时可直接打开助手；Workspace 会话可创建、选择、发送、停止、移除并恢复历史。Workspace 与 Project 独立存储、独立执行，页面切换跟随当前范围且不停止后台任务。
- 非目标：用户明确暂缓记忆。本包不接记忆读写、Overview 自动维护、行为 Skill/Harness、额外原生业务工具或 CLI/MCP 扩展。
- 验收：入口无 Project 前置；Workspace / Project 会话及运行隔离；Workspace 关闭、锁定、切换统一撤销运行时；旧 Project 历史不搬迁；沿用原生模型与设置、滚动边缘规范。
- 验证：前端入口/面板/状态/API/transport 回归；Node 真实 Workspace 会话、发送停止、重启恢复及 Project 隔离；Rust 原生目录、运行时、窗口授权和既有 File/Office 回归；前端构建。逐步补失败行为用例，收口复用仍有效结果。Standards / Spec 由主 agent 自查，未获授权不启动 review agent。

## 接入契约

原生命令、carrier 事件与前端适配器沿用 `projectId` 字段：正整数表示真实 Project，显式 `null` 表示 Workspace；不创建占位 Project，不使用 0 或负数模拟 Workspace。原生只允许主窗口操作 Workspace 助手，项目窗口仍限定到该项目。

Node configure 保留现有 Project 帧；Workspace 帧携带 `workspace: { id, name, directory }`，由原生已打开 Workspace 的真实身份和目录解析。Workspace 历史放在助手数据根的 `projects/<workspace-id>/workspace`，Project 保留 `projects/<workspace-id>/<project-id>`；共享同 Workspace 的助手配置。

Workspace 会话在助手面板内显示原 Chat；项目会话沿用主内容 Tab。切换页面更新当前范围，关闭面板和离开页面不结束既有任务。已访问的 Workspace Chat 保留挂载，返回时保留选中的会话、草稿和阅读位置；切换 Workspace 后释放。Workspace 聊天不授予所有 Project 的原生 File/Office 权限；这些现有桥仅为实际 Project 安装，Workspace 的普通附件/文件工具沿 DSH 既有权限运行。

## 验证与审查记录

验证基线为 `08ac664`（包含上游 #159），以下结果覆盖本包最终改动；未改动的依赖和 Office 构建结果复用，不重复启动应用。

| 范围 | 命令与结果 |
| --- | --- |
| 前端行为 | Vitest 定向覆盖 launcher、WorkspacePage、面板、设置、App 布局、API、事件、Project Session 内容和适配器：12 文件 / 86 用例通过；后续面板保留修复重跑受影响面板、入口、布局 15 用例通过。最后仅调整两处通用错误文案。 |
| Node 静态与单元 | `npm run check:dsh`、`npm run test:dsh`：通过，38 单元用例。 |
| Node 实际运行时 | `npm run test:dsh:integration`：29 用例通过；本地模型 SSE 驱动真实 Node 子进程，覆盖 Workspace 创建/发送/停止/续聊、附件、重启历史、移除和 Project 隔离。 |
| 原生与既有桥 | `cargo test --manifest-path src-tauri/Cargo.toml --lib dsh_assistant --quiet`：24 通过、1 个已有 GUI 种子辅助用例忽略；随后新增目录别名/重定向用例单独通过，合计 25 通过。包括真实 Project 与 Workspace Node carrier、事件范围及 File/Office 回归。 |
| 构建 | `npm run build` 通过（Office 与前端）；面板最终调整后 `npx tsc` 和 `npx vite build` 再次通过。已有大 chunk / dynamic import 警告，无构建失败。 |
| 界面规则与产物 | `npm run check:ui-standards`、`npm run check:bundle-boundaries`、`git diff --check` 通过；主包 249 KiB / 250 KiB。会话列表复用现有 `HomeSidebarList` 滚动边缘行为。 |
| 文档路径 | 本包 4 份新增/修改 Markdown 按仓库 portable-path 规则检查通过。全仓 `check:portable-paths` 仍报告基线文件 `project-file-auto-management-20261015.md` 的两处绝对路径，本包未修改该文件，留给文档清理工作包。 |

Standards 自查：检查了真实 Workspace 身份和目录、窗口授权、请求/连接归属、运行时 generation、独立数据目录、Project File/Office 授权及异步状态保留；发现的忙碌态配置复核和跨页面旧会话保留问题已修复并回归，无剩余本包发现。

Spec 自查：#161 的 Workspace 入口、会话基本生命周期、模型与设置沿用、范围隔离、Project 历史路径和后台运行要求均有实现与验证；记忆按用户要求暂缓，不计入本包交付。无剩余本包发现。

本次未启动 GUI，不声称已完成窗口实机验收；未连接外部真实模型服务，也未验证 Windows。集成测试使用实际 DSH 与本地测试模型服务。

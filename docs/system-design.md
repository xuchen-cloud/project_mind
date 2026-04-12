# Project Mind System Design

状态：当前正式基线  
更新时间：2026-04-06

## 1. 当前架构结论

Project Mind 当前采用如下前端组合：

- `Tauri 2`
- `React 19`
- `TypeScript`
- `React Query`
- `Zustand`
- `Tailwind CSS v4`

同时采用五层边界：

1. `App Shell`
2. `Feature Layer`
3. `UI Layer`
4. `Service Layer`
5. `Lib / Domain Helpers`

## 2. 边界约束

### 2.1 App Shell

入口在：

- `src/main.tsx`
- `src/App.tsx`

职责：

- 路由
- QueryClient 注入
- Workspace 顶层壳
- 状态栏、toast、modal、todo rail 挂载

不负责：

- 具体业务命令调用
- Tauri API 细节
- 页面级视觉实现

### 2.2 Feature Layer

当前主要包括：

- `src/components/project/*`
- `src/components/activity/*`
- `src/components/todo/*`
- `src/components/layout/*`
- `src/components/rich-editor/*`

职责：

- 页面内容编排
- 面板和局部流程组合
- 调用 query / mutation / store / service

不负责：

- 自定义设计系统
- 直接调用 Tauri

### 2.3 UI Layer

位于：

- `src/ui/components/*`
- `src/ui/lib/cn.ts`

职责：

- 统一按钮、输入、卡片、弹层、badge、空状态、toolbar 视觉
- 统一 Lucide 图标节奏
- 统一 token 消费方式

### 2.4 Service Layer

位于：

- `src/services/desktopApi.ts`
- `src/services/projectMindApi.ts`

职责：

- `desktopApi`：唯一桌面桥接层，封装 `invoke`、对话框、文件 reveal、文件 URL
- `projectMindApi`：唯一 typed command wrapper

约束：

- Feature 层禁止直接引用 `@tauri-apps/*`
- Feature 层禁止自己拼 command 名称

### 2.5 Store Layer

位于：

- `src/state/ui-store.ts`
- `src/state/feedback-store.ts`

职责：

- `ui-store`：modal、rail、composer、当前选择态
- `feedback-store`：底部状态栏消息、toast 队列

约束：

- 持久数据和实体列表不放 Zustand
- 实体查询统一交给 React Query

## 3. 数据流

正式数据流如下：

1. Feature 发起 query 或 mutation
2. Query / mutation 调用 `projectMindApi`
3. `projectMindApi` 调用 `desktopApi.command`
4. `desktopApi` 调用 Tauri command
5. 结果回到 React Query cache
6. 瞬时 UI 状态单独进入 Zustand

## 4. 样式系统

- `src/styles/app.css` 是唯一全局 token 入口
- 所有页面样式通过 Tailwind utility 组合
- token 是唯一正式视觉 API
- Lucide 是唯一正式图标 API

禁止项：

- 旧 Notion token 命名
- 业务页面里的硬编码色板
- feature 层自建按钮 / 卡片视觉体系

## 5. 质量门槛

当前质量门槛为：

- `npm run build`
- `npm run test:unit`
- `npm run check:ui-standards`

其中 `check:ui-standards` 负责拦截：

- 旧 token 命名回流
- 旧 store / api 入口回流
- 非 Lucide 图标库
- 非 `desktopApi` 的直接 Tauri 调用

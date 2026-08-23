# Project Mind Cache Strategy

状态：正式基线  
更新时间：2026-08-23

## 目标

项目页签应具有浏览器式切换体验，同时保证内存、后台查询和编辑器实例数量有明确上限。

## Project 驻留层

每个最近访问的 Project 由一个统一的 resident shell 承载。shell 保留该 Project 的 Overview 页面实例、最近 Project 路由，以及仍命中全局 Focus LRU 的 Record Focus 页面。Project 分为三种状态：

- `Active`：当前可见项目，完整运行。
- `Warm`：最近访问的四个 Project，保留 React 页面和可驻留编辑现场，但页面不可交互并暂停页面级查询。
- `Cold`：更早的已打开页签，不保留页面实例；React Query 数据、已保存内容、最近路由和持久化 UI 偏好仍然保留。

驻留列表使用 LRU 顺序。每次访问或返回 Project 都将它移动到列表末尾，最多保留 5 个 Project：1 个 Active 加 4 个 Warm。访问第 6 个 Project 时只卸载最久未访问的 shell；关闭页签会立即移除对应 shell，并释放其中的页面和 Focus 实例，不等待 LRU 淘汰。

Workspace Overview 是独立的全局单例，首次打开后作为 `Pinned` 页面常驻内存。它与 Workspace Record Focus 位于独立的 Workspace shell，不进入 Project LRU，不会因 Project 切换、超过 Warm 上限或数据缓存 GC 而卸载。只有关闭/切换整个 Workspace，或显式禁用页面缓存时才释放。

Warm shell 使用不可见布局、`aria-hidden` 与 `inert`。shell 内的 Overview 和 Focus 都必须收到 `visible=false`：页面级 Query、Todo 加载、autofocus、焦点恢复和页面交互随之暂停；Warm Project 的页签 hover/focus 不重复预取已有驻留数据。

## 数据缓存层

React Query 是持久业务数据的前端唯一内存缓存：

- 默认 `staleTime`：15 秒。
- 默认 `gcTime`：10 分钟。
- 不在窗口聚焦、网络重连或重新挂载时自动刷新。
- mutation 应优先精确更新缓存；确实影响聚合结果时才失效对应 query family。
- query key 必须从 `src/lib/queryKeys.ts` 获取，禁止新增散落的同义 key。
- Todo 集合 key 显式区分 Workspace 自有集合、Project 自有集合和 Workspace Rail 聚合集合；聚合结果不得使用含义模糊的 Workspace Todo key。

项目页签在鼠标移入或键盘聚焦时预取 `project-page` 与项目标签设置。预取不得阻塞点击导航。

只有 Cold Project 执行页签预取。resident shell 持有的 `project-page` 与 Project Label observer 在驻留期间不因时间经过自动重新请求；显式 mutation cache update 或 query invalidation 仍可刷新。Cold Project 命中 React Query 或预取结果时先显示缓存，只有目标数据真正缺失时才显示 loading 并请求后端。

## 本地 UI 与草稿

- Zustand persistence 只保存跨会话 UI 偏好。
- Todo 未提交草稿使用其独立 localStorage key。
- 页面临时状态应尽量可以从路由、React Query 数据或草稿恢复，不能依赖页面永久驻留。
- workspace 切换必须清理所有 workspace-scoped query、搜索结果、Todo 草稿和临时同步任务。

## Record Focus 驻留

Project Record Focus 与 Workspace Record Focus 共用一个 Workspace 范围、独立于 Project LRU 的全局 Focus LRU，最多保留两个富文本编辑器实例：当前 Active Focus 与最近一个 Warm Focus。Project Focus 渲染在所属 Project resident shell 内，Workspace Focus 渲染在独立 Workspace shell 内。打开第三个 Focus 时只释放最久未使用的编辑器实例；所属 Project shell 被淘汰或关闭时也会释放其中的 Focus 实例。Query 数据、最近路由、滚动恢复信息以及待保存/失败快照继续由各自缓存保留。

Record Focus 草稿在组件首次构造时按以下顺序选择来源：

1. 后台保存协调器中最新的待保存或失败 Committed Content 快照。
2. React Query 中已有的 `project-page` 或 `workspace-page` 数据。
3. 仅在前两者都不能提供目标 Record 时请求后端。

命中前两种来源时首帧直接显示 Record，不经过 effect 复制缓存导致的 loading。页面实例一旦拥有本地草稿，后台 Query 更新不得覆盖 Active 或 Warm 编辑现场。

Warm Focus 使用不可见布局、`aria-hidden` 与 `inert`，暂停页面级查询，并将编辑器切换为不可编辑状态；它不获取焦点、不自动聚焦，也不响应 Active 页面交互。重新成为 Active 时复用同一编辑器实例，以保留光标、选区、撤销历史和滚动位置。

## 富文本与图片缓存

- Viewer HTML、图片 pending promise 和缩略图缓存必须有 TTL 或最大条目数。
- 缓存 key 必须包含足以区分内容版本的信息。
- 测试必须提供显式清理入口，避免跨用例污染。

## Project Record 后台保存

- 离开 Project Record Focus 时始终捕获并提交一次不可变的 Committed Content 快照；这一语义不以 dirty 状态替代。
- 普通 Project 与 Record 导航只同步读取当前 Committed Content、标题、标签、代码语言及 Record/Project 身份，然后立即提交路由。内容规范化、managed image 外部化、数据库写入和 React Query 同步均在导航之后执行。
- 保存任务由当前 Workspace 的 `RecordSaveCoordinator` 持有，不依赖来源页面继续挂载。任务按 Record 串行，不同 Record 可以独立推进。
- 同一 Record 只有最新提交的成功结果可以写回 React Query；仍在排队或失败的较新快照不会被较旧结果覆盖。
- 失败任务保留其快照，并通过全局状态和 Toast 显示。可重试失败能够从状态栏重试，且不阻塞普通导航。
- 正常退出、切换 Workspace 和安装更新是 flush barrier：必须等待对应 Workspace 的队列完成；flush 失败会取消该生命周期动作并保留任务。

## 性能验收

- Warm 项目切换应直接复用页面实例，不发起阻塞式数据请求。
- Cold 项目在预取命中时应先渲染缓存，再按明确动作刷新。
- 无论访问多少 Project，resident Project shell 不得超过 5 个，Record Focus 编辑器不得超过 2 个。
- Workspace Overview 首次打开后必须始终保持挂载，且不占用 5 个 Project 驻留名额。
- 隐藏页面必须设置 `aria-hidden` 与 `inert`，并暂停页面级查询。

## 平台验证记录

2026-08-23 的自动化门禁使用真实 Workspace layout、router 与 QueryClient，确定性覆盖 A → B → C → D → E → A、访问第 6 个 Project、LRU 重排、关闭页签、Project/Workspace Focus 跨壳复用、请求计数以及 5/2 实例上限。这些契约不包含平台分支。

| 平台 | 当前结果 | 记录 |
| --- | --- | --- |
| macOS WebKit | 自动化通过；实机切换/内存采样待执行 | 已成功启动当前分支的 Tauri dev binary，但 dev binary 不是可由本会话 Computer Use 识别的 `.app` accessibility target；未把启动结果误记为切换或内存实测。 |
| Windows WebView2 | 自动化通过；实机切换/内存采样待执行 | 当前执行环境没有 Windows/WebView2 主机。发布前需在 Windows 上执行相同 A–F、跨 Project Focus、关闭页签与长历史场景，并记录 resident shell/Focus 数量和进程内存稳定结果。 |

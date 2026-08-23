# Project Mind Cache Strategy

状态：正式基线  
更新时间：2026-07-11

## 目标

项目页签应具有浏览器式切换体验，同时保证内存、后台查询和编辑器实例数量有明确上限。

## 页面驻留层

项目 Overview 页面分为三种状态：

- `Active`：当前可见项目，完整运行。
- `Warm`：最近访问的两个项目，保留 React 页面和编辑器现场，但页面不可交互并暂停页面级查询。
- `Cold`：更早的已打开页签，不保留页面实例；React Query 数据、已保存内容、最近路由和持久化 UI 偏好仍然保留。

驻留列表使用 LRU 顺序。每次访问将项目移动到列表末尾，最多保留当前项目加两个 Warm 项目。关闭页签会立即移除对应驻留页面。

Workspace Overview 是全局单例，首次打开后作为 `Pinned` 页面常驻内存。它不进入项目页的 LRU 驻留列表，不会因项目切换、超过 Warm 页数上限或数据缓存 GC 而卸载。只有关闭/切换整个 workspace，或显式禁用页面缓存时才释放。

## 数据缓存层

React Query 是持久业务数据的前端唯一内存缓存：

- 默认 `staleTime`：15 秒。
- 默认 `gcTime`：10 分钟。
- 不在窗口聚焦、网络重连或重新挂载时自动刷新。
- mutation 应优先精确更新缓存；确实影响聚合结果时才失效对应 query family。
- query key 必须从 `src/lib/queryKeys.ts` 获取，禁止新增散落的同义 key。
- Todo 集合 key 显式区分 Workspace 自有集合、Project 自有集合和 Workspace Rail 聚合集合；聚合结果不得使用含义模糊的 Workspace Todo key。

项目页签在鼠标移入或键盘聚焦时预取 `project-page` 与项目标签设置。预取不得阻塞点击导航。

## 本地 UI 与草稿

- Zustand persistence 只保存跨会话 UI 偏好。
- Todo 未提交草稿使用其独立 localStorage key。
- 页面临时状态应尽量可以从路由、React Query 数据或草稿恢复，不能依赖页面永久驻留。
- workspace 切换必须清理所有 workspace-scoped query、搜索结果、Todo 草稿和临时同步任务。

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
- 无论打开多少项目页签，完整驻留的项目 Overview 页面不得超过 3 个。
- Workspace Overview 首次打开后必须始终保持挂载，且不占用项目 Overview 的 3 个驻留名额。
- 隐藏页面必须设置 `aria-hidden` 与 `inert`，并暂停页面级查询。

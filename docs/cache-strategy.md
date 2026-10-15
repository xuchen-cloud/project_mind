# Project Mind Cache Strategy

状态：正式基线  
更新时间：2026-10-14

## 目标

项目页签应具有浏览器式切换体验。Overview 驻留数量有上限，内容页签的编辑现场随打开/关闭管理；后台查询、任务与保存按实际生命周期释放。

## Project 驻留层

每个已打开 Project 有一个内容 shell，保存项目布局、已访问的内容页及编辑现场。Project Overview 单独使用 LRU，最多保留 5 个实例：1 个 Active、4 个 Warm。访问第六个项目时淘汰最久未访问的 Overview，不卸载其仍打开的内容页签或 Record 编辑器。Cold Project 仍可保留已打开内容，返回概览时使用 Query 缓存/预取重新创建 Overview。

关闭 Project 会先协调保存，再释放整个内容 shell；关闭单个内容页签只释放对应页面，不删除 Record、File 或 Session。会话任务属于原生 Project/Session runtime，隐藏或关闭其展示不等于停止任务。

Workspace 首页首次打开后作为 Pinned 单例保留，不进入 Project Overview LRU。Workspace Record Focus 使用独立 shell 和最多两个实例的 Focus LRU；Project Record 内容页签不占用该名额。

不可见页面使用隐藏布局、`aria-hidden` 与 `inert`，收到 `visible=false`/`focused=false`，暂停页面查询、autofocus 和交互。DSH 展示可卸载订阅，原生任务与会话状态仍保留；Project 切换后重新绑定实际 Session。

## 数据缓存层

React Query 是持久业务数据的前端唯一内存缓存：

- 默认 `staleTime`：15 秒。
- 默认 `gcTime`：10 分钟。
- 不在窗口聚焦、网络重连或重新挂载时自动刷新。
- mutation 应优先精确更新缓存；确实影响聚合结果时才失效对应 query family。
- query key 必须从 `src/lib/queryKeys.ts` 获取，禁止新增散落的同义 key。
- Todo 集合 key 显式区分 Workspace 自有集合、Project 自有集合和 Workspace Rail 聚合集合；聚合结果不得使用含义模糊的 Workspace Todo key。
- 待办侧栏必须通过 Query observer 订阅实际渲染的集合及项目元数据；仅监听 QueryCache 事件不会阻止 GC。Active / Warm 侧栏保留这些缓存，卸载后仍按默认 GC 回收。重新挂载时若视图缓存仍在但集合已缺失，自动重新加载集合。

项目页签在鼠标移入或键盘聚焦时预取 `project-page` 与项目标签设置。预取不得阻塞点击导航。

只有 Cold Project 执行页签预取。resident shell 持有的 `project-page` 与 Project Label observer 在驻留期间不因时间经过自动重新请求；显式 mutation cache update 或 query invalidation 仍可刷新。Cold Project 命中 React Query 或预取结果时先显示缓存，只有目标数据真正缺失时才显示 loading 并请求后端。

## 本地 UI 与草稿

- Zustand persistence 只保存跨会话 UI 偏好。
- Todo 未提交草稿使用其独立 localStorage key。
- 页面临时状态应尽量可以从路由、React Query 数据或草稿恢复，不能依赖页面永久驻留。
- workspace 切换必须清理所有 workspace-scoped query、搜索结果、Todo 草稿和临时同步任务。

## Record Focus 驻留

Workspace Record Focus 最多保留两个富文本编辑器实例。Project Record 由内容页签按稳定 Record ID 保留已访问实例，独立于 Overview LRU；移栏和项目切换保留编辑器、草稿、选区与撤销历史。关闭页签时先执行保存协调，失败保留页面和快照，不能无声丢弃。

Record Focus 的页面元数据与草稿在组件首次构造时按以下顺序选择来源：

1. 后台保存协调器中最新的待保存或失败 Committed Content 快照。
2. React Query 中已有的 `project-page` 或 `workspace-page` 数据。
3. 前两者都不能提供目标 Record 时请求页面数据。

命中前两种来源时首帧显示缓存的页面元数据，避免重复请求整页。canonical 正文和编辑基线仍由 `useCanonicalRecordEditor` 调用原生 `editorGet` 获取；工作区绑定、head revision 和编辑注册就绪后才允许编辑。同 generation 的待保存 canonical 快照可恢复草稿与 base revision，HTML 投影缓存不能替代权威正文。已驻留页面保留加载状态和编辑器；后台 Query 更新不得覆盖其编辑现场。

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
- 失败任务保留其快照，并通过 Toast 显示。可重试失败能够从失败通知重试，且不阻塞普通导航。
- 正常退出、切换 Workspace 和安装更新是 flush barrier：必须等待对应 Workspace 的队列完成；flush 失败会取消该生命周期动作并保留任务。

## 性能验收

- Warm 项目切换应直接复用页面实例，不发起阻塞式数据请求。
- Cold 项目在预取命中时应先渲染缓存，再按明确动作刷新。
- Project Overview 不得超过 5 个，Workspace Record Focus 不得超过 2 个；Project 内容 shell 与编辑器数量随实际打开的内容页签变化，关闭后释放。
- Workspace Overview 首次打开后必须始终保持挂载，且不占用 5 个 Project 驻留名额。
- 隐藏页面必须设置 `aria-hidden` 与 `inert`，并暂停页面级查询。

## 平台验证状态

自动化门禁覆盖 Project Overview 的五实例 LRU、Workspace Focus 两实例上限、跨六个 Project 保留已打开内容和 Record、移栏不重建编辑器、关闭/保存协调及请求次数。原 5/2 组合不再表示所有 Project 内容编辑器的总上限。

macOS WebKit 与 Windows WebView2 的真实切换、长历史和内存采样仍未完成，由 [Issue #56](https://github.com/xuchen-cloud/project_mind/issues/56) 跟踪；统一验收清单见[未完成事项](remaining-work.md)。

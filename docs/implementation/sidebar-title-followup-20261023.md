# 会话标题与导航收尾（2026-10-23）

## 工作包

- 关联 Issue：[#226](https://github.com/xuchen-cloud/project_mind/issues/226)。
- 基线：`codex/builtin-cli-compat`，接手 HEAD `22a89a0`；先保留已有七文件改动，再合入 `origin/develop@77afa4f`（含 PR #223 会话标题同步）。
- 需求依据：本轮用户明确要求首问标题预算、heading 新增按钮前的加载状态、无文字运行 spinner、Workspace / Project 导航密度与高亮一致；滚动规范见 [设计系统](../design-system.md#滚动区域与边缘遮罩默认规范)，发布分工遵循 [发布流程](../agents/publish-flow.md)。
- 交付：OpenAI 兼容首问标题保留完整输入、短标题/语言/超时策略，并为 reasoning 提供有界输出预算；加载及运行 spinner 可访问；记录、文件、会话导航排版与高亮统一，复用连续边缘遮罩及 reduced-motion。
- 非目标：模型/业务协议重构、HTML、其他 runtime 工作树、`codex/memory-system`；不启动 review 子 agent，不运行 UI/Tauri，不 push / 创建 PR / 远端合并。
- 验收：长中文首问及含 reasoning 的输出能生成标题；输入和输出预算边界仍生效，原 prompt 不变；加载 spinner 紧邻新增按钮之前，运行状态只有可访问图标；导航共享密度/颜色规则，既有遮罩与 reduced-motion 不回退。
- 验证范围：定向 Node 标题/共享模型用例、真实本地 provider 子进程标题集成、DSH check；定向 Vitest 会话/导航/滚动遮罩和上游标题同步回归。生产构建及双轴检查由主 agent 集中完成，不重复 Cargo 或整个前端测试。
- 修改前进程检查：已有本工作树 Vite（PID 43147）；未发现 Tauri dev。验证全部静默，无窗口启动。

## 实现与验证

### 提交与实现

- `edad079` 保存交接时七文件意图和工作包；`0494709` 无冲突合入 `origin/develop@77afa4f`，保留 PR #223 的目录/标题/Tab 同步及手动重命名行为。
- 本包相对 develop 仅七个指定文件与本文。标题配置复用固定 rc.2 `session-title-llm`，最终 JSON 封装输入上限 32768 bytes，输出上限 1024 tokens（包含 reasoning）；仍为 5 个非 CJK 词 / 10 个 CJK 字、输入语言、60000ms 超时。超过输入预算明确拒绝标题请求，不截断或修改原会话 prompt。
- 标题测试补齐刚好 32768 bytes 接受、多 1 byte 拒绝且不发送/记请求、reasoning 消耗预算后成功及耗尽预算拒绝。真实子进程经 RPC/mux/SSE 验证长中文首问摘要、原文同时保留给主模型/辅助模型/持久消息、目录标题更新。
- 加载/打开状态位于 heading 新增按钮之前；运行中使用 `role=status` / `aria-label=运行中` 图标替代文字。复用全局 `.spin` 与 reduced-motion 停转规则。
- Workspace / Project 共享 caption 字体、常规字重、26px 导航行基准及 hover/active 颜色；文件列表保持 2px 间距，文件图标列 16px 对齐记录/会话图标列，目录视图行高也收敛至 26px。现有 `HomeSidebarList` 的距离连续遮罩、内容/尺寸重测及无延迟反向滚动沿用。

### 静默验证

命令均在本工作树根目录运行。下文 `NODE24=packages/agent-host/runtime/darwin-arm64/node`（v24.21.0，仓库随包 runtime），没有修改依赖或重建 Office。

| 命令 | 结果与覆盖 |
| --- | --- |
| `$NODE24 --test packages/dsh-assistant/test/session-title.test.mjs packages/dsh-assistant/test/shared-model.test.mjs` | 18 passed；标题 5、共享配置/凭据与目录标签 13 |
| `npm run check:dsh` | passed；固定版本、脚本语法和上游资源存在性 |
| `node --test --test-name-pattern='long first questions\|fixed source auto titles\|embedded runtime uses the piped main AI model\|embedded model catalog' packages/dsh-assistant/test/runtime.integration.mjs` | Node 26.8.1：4 passed；标题、来源投影、主模型/历史和目录路由 |
| `$NODE24 --test --test-name-pattern='long first questions' packages/dsh-assistant/test/runtime.integration.mjs` | 1 passed；补充原 prompt 双模型精确保留断言后，仅重跑受影响项；不重复累计前一行 |
| `$NODE24 node_modules/vitest/vitest.mjs run src/components/home/ProjectSidebarSessions.test.tsx src/components/home/HomeSidebarList.test.tsx src/components/home/HomeProjectSidebar.test.tsx src/components/workspace/WorkspaceOverviewSidebar.test.tsx src/components/project/ProjectContentWorkspace.test.tsx packages/dsh-ui/client-bootstrap.test.tsx --maxWorkers=1` | 6 文件 / 86 passed；分别 32 / 5 / 8 / 8 / 17 / 16。含 PR #223 标题同步回归 |
| `$NODE24 node_modules/vitest/vitest.mjs run src/components/home/ProjectDirectoryBrowser.test.tsx --maxWorkers=1` | 1 文件 / 7 passed；目录导航与遮罩容器 |
| `$NODE24 node_modules/vitest/vitest.mjs run src/components/home/ProjectSidebarSessions.test.tsx src/components/home/HomeProjectSidebar.test.tsx src/components/workspace/WorkspaceOverviewSidebar.test.tsx --maxWorkers=1` | 最终导航 CSS 调整后，3 文件 / 48 passed；为上述用例子集，不重复累计 |
| `npm run test:unit -- src/components/home/ProjectSidebarSessions.test.tsx src/components/home/HomeSidebarList.test.tsx src/components/home/HomeProjectSidebar.test.tsx src/components/workspace/WorkspaceOverviewSidebar.test.tsx src/lib/dsh-host-events.test.ts src/components/project/ProjectContentWorkspace.test.tsx packages/dsh-ui/client-bootstrap.test.tsx --maxWorkers=1` | 首轮默认 Node 26.8.1：41 passed / 53 failed；失败均涉及 `Invalid Chai property`（jest-dom matcher 未注册），不是绿色结果。上述六文件同断言在 Node 24 下 86 passed；未失败的 host-events 8 项沿用。主 agent 另在共享依赖 symlink 环境复现 matcher 问题，正在隔离其依赖；本包未改测试基础设施 |
| `npm run check:ui-standards`、`git diff --check` | passed |

有效不重复覆盖：Node 单元 18、runtime 集成 4；Vitest 101（Node 24 下 93，首轮未失败的 host-events 8）。后续只调整本文与删除无实际匹配节点的 CSS selector；以上相关代码/依赖没有其他改动。无 Cargo、前端全量、最终生产构建、review 子 agent 或可见 UI 验收。

### 集中 UI 检查与交接

由主 agent 完成最终生产构建及 Standards / Spec 双轴检查，再按 #226 发布；此分支未 push / 建 PR / 远端合并。待集中 UI 验收：

1. 项目会话初始加载、打开现有/新建会话时，只有 heading 新增按钮前出现加载图标；已有会话仍可读，按钮禁用/恢复正确。
2. 运行状态在标题行末尾显示无文字 spinner；长标题省略、置顶图标及焦点高亮不被挤压。减少动态效果时图标静止且可访问名称保留。
3. Workspace 项目/记录与 Project 记录/会话/文件平铺/文件树的字号、行密度、标题左对齐、悬停和选中颜色；文件版本按钮、缺失文件状态与树缩进仍清楚。
4. 窄/宽侧栏在无溢出、顶部、中间、底部和反向滚动时遮罩随距离连续变化；过滤/增删/树展开和尺寸改变后更新，heading/按钮/滚动条不被覆盖。
5. 真实 OpenAI 兼容配置发送多段中文首问，确认短标题同时到侧栏、聊天 heading、前后台 Tab，手动重命名不被旧目录覆盖。本包确定性 reasoning fixture 不等同真实供应商验收。

环境交接：主 agent 已确认 fe83 的 Office docx `dist/editor-types.d.ts` 落后源码（缺 `captureSelection` / `replaceSelection`）；仓库根 `/Users/xuchen/project_mind` 三类 Office 源码与 develop 相同且 dist 类型完整，可复用其产物。此项不是本包源码错误；本包未运行大型 Office 构建或修改生成物。

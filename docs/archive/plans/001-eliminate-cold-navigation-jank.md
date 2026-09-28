# 001 — 消除项目与记录冷切换卡顿

- **Status**: IN PROGRESS
- **Commit**: baff931
- **Severity**: HIGH
- **Category**: Performance / Purpose & frequency / Missed opportunity
- **Estimated scope**: 实现已完成；剩余为 002 与 #56 平台验证

## Problem

本计划在 `31dfc46` 首次编写时，Project/Workspace 页签没有完整预取，cold overview/focus 使用 spinner，Record chunk 未 idle preload，隐藏历史列表会同步构建富文本，普通导航还可能被保存等待阻塞。当前 commit 已完成这些实现和自动化契约，但原 Done 条件包含的真实长历史 trace、macOS/Windows 实机切换与内存采样尚未全部完成。

当前统一预取已经同时覆盖 Project Page 与 tag：

```ts
// src/lib/project-prefetch.ts:6 — current
export async function prefetchProjectPageData(
  queryClient: QueryClient,
  projectId: number,
) {
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.projectPage(projectId),
      queryFn: () => projectMindApi.projectPage({ projectId }),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.projectTags.project(projectId),
      queryFn: () => projectMindApi.projectTagSettingsGet({ projectId }),
    }),
  ]);
}
```

路由 chunk 已用共享 loader 和 idle/timeout 调度：

```ts
// src/routes/record-focus-modules.ts:18 — current
export function scheduleRecordFocusModulePreload() {
  const run = () => {
    void Promise.all([loadProjectNoteFocusPage(), loadWorkspaceRecordFocusPage()]);
  };
  // requestIdleCallback with timeout, fallback timer, and cleanup live below.
}
```

静态 skeleton 与 cold-only handoff 已落地：

```css
/* src/styles/app.css:2607 — current */
.page-cold-entry {
  opacity: 1;
  transition: opacity var(--duration-standard) var(--ease-decel);
}
```

隐藏 Viewer 的富文本 repair 也已延迟：

```tsx
// src/components/record/RecordListItem.tsx:617 — current
<CollapsibleRecordContent>
  <RichTextViewer
    html={record.contentHtml}
    markdown={record.contentMarkdown}
    active={active}
    deferUntilVisible
    eagerManagedImages
  />
</CollapsibleRecordContent>
```

剩余风险是隐藏 Record section 仍 map 全部条目并安装折叠测量 observer，以及 skeleton 没有 120ms 显示门槛；这两个实现已拆入 002。平台记录明确说明实测延期：

```text
// docs/cache-strategy.md:87 — current
维护者已明确批准将 macOS / Windows 的实机切换与内存采样延期至 #56；
该延期不阻塞 #48 的提交、合并或发布，也不应被解读为平台实测已通过。
```

## Target

- 保留当前已完成实现，不重新设计导航架构。
- 完成 002：隐藏历史列表不承担条目级 React/observer 成本，cold skeleton 只在 pending 超过 120ms 后显示。
- 完成 #56：macOS WebKit 与 Windows WebView2 实机切换、resident 上限和稳定内存证据写入 `docs/cache-strategy.md`。
- warm/resident navigation 继续即时；cold content 只做已有 160ms opacity，reduced motion 为 120ms opacity-only。

## Repo conventions to follow

- `src/lib/project-prefetch.ts` 是 Project Page/tag 预取单一入口；`src/App.tsx:692-704` 负责与 Todo 预取组合并跳过 resident id。
- `src/routes/record-focus-modules.ts` 是 lazy loader 与 idle preload 单一入口；`src/main.tsx:19-28` 复用它。
- `src/ui/components/PageLoadingSkeleton.tsx` 是共享静态 fallback；不得恢复 shimmer/pulse/spinner。
- `docs/cache-strategy.md:75-92` 是 residency 与平台性能验收的正式记录。

## Steps

1. 执行并完成 `002-finish-cold-navigation-performance.md` 的代码、定向测试与 Performance profile。
2. 确认现有预取、resident、skeleton、同步草稿与 deferred viewer 测试仍通过；若失败，只修回归，不重新实现已完成架构。
3. 在 #56 的 macOS/Windows 环境执行 A→B→C→D→E→A、第 6 个 Project、跨 Project Focus、关闭页签和 30+ 长 Record 场景；记录 resident Project ≤5、Record Focus ≤2、请求计数与稳定内存。
4. 将平台、日期、commit、数据规模、cold/warm 路径、内存/trace 结果写入 `docs/cache-strategy.md:83` 表格。
5. 全部 Done 条件满足后，把本文件与 `plans/README.md` 的 001 状态改为 `DONE`；不要因 #48 已发布而提前关闭性能验证。

## Boundaries

- 不恢复保存前阻塞普通导航；保存继续后台协调。
- 不为 warm navigation 增加整页动画，也不用 skeleton 掩盖主线程长任务。
- 不取消 5 个 Project / 2 个 Record Focus residency 上限。
- 不把自动化、debug app build 或“无法启动可操作 UI”写成平台实测通过。
- 若 002 的隐藏列表门控与现有 residency 契约冲突，停止并先修契约设计，不通过增加动画绕过。

## Verification

- **Mechanical**: `npm run test:unit -- src/App.test.tsx src/components/layout/WorkspaceTopBar.test.tsx src/components/project/ProjectOverviewPage.test.tsx src/components/workspace/WorkspacePage.test.tsx src/components/project/ProjectNoteFocusPage.test.tsx src/components/workspace/WorkspaceRecordFocusPage.test.tsx src/routes/record-focus-modules.test.ts src/ui/components/PageLoadingSkeleton.test.tsx && npm run build && npm run check:ui-standards`；全部退出码为 0。
- **Feel check**: 30+ 长 Record 下反复 cold/warm/resident 切换；warm 必须即时，cold 结构稳定、无双 spinner、无整页位移。
- 在 DevTools Performance/Network 中确认预取命中、隐藏列表无条目级 observer、cold query <120ms 不闪 skeleton。
- 在两平台验证 `prefers-reduced-motion`，确认 skeleton 静态、cold content 只做 120ms opacity。
- **Done when**: 002 完成，#56 两平台证据入库，完整机械验证与 feel check 通过；此时 001 才能标记 `DONE`。

# 002 — 收尾冷导航的真实成本与实机证据

- **Status**: TODO
- **Commit**: baff931
- **Severity**: HIGH
- **Category**: Performance / Purpose & frequency
- **Estimated scope**: 8–11 files，约 180–320 行（含测试与性能记录）

## Problem

001 已解决数据预取、静态 skeleton、Record chunk 预加载与同步富文本构建，但隐藏的 Record 视图仍完整创建列表节点，并为每项安装测量 effect / `ResizeObserver`。resident Project/Workspace 切换因此仍可能把不可见历史列表的 React 与布局成本留在主线程。

```tsx
// src/components/project/ProjectOverviewPage.tsx:778 — current
<section
  className={withPageWidthClass(
    "project-overview-focus__page project-overview-focus__page--history",
    pageWidthMode,
    "history",
  )}
  data-testid="project-overview-body-history"
  style={{ display: currentView === "record" ? undefined : "none" }}
  aria-hidden={currentView === "record" ? undefined : true}
>
```

```tsx
// src/components/project/ProjectOverviewPage.tsx:868 — current
{records.length > 0 ? (
  <div className="grid gap-2.5">
    {records.map((note) => (
      <div key={note.id}>
        <RecordListItem record={note} /* ... */ />
      </div>
    ))}
  </div>
) : null}
```

```tsx
// src/components/record/RecordListItem.tsx:641 — current
useEffect(() => {
  const content = contentRef.current;
  // ...
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  resizeObserver?.observe(content);
  // ...
}, [children]);
```

Workspace 也在 QuickNote 视图下保留完整历史组件：

```tsx
// src/components/workspace/WorkspacePage.tsx:683 — current
<div
  style={{ display: currentView === "record" ? undefined : "none" }}
  aria-hidden={currentView === "record" ? undefined : true}
>
  <WorkspaceOverviewHistory notes={filteredWorkspaceRecords} /* ... */ />
</div>
```

此外，cold miss 当前立即显示 skeleton，没有约 120ms 的短等待门槛；非常短的请求会产生一次不必要闪烁。原计划要求的 macOS/Windows 实机切换与内存采样仍待 #56 执行，`docs/cache-strategy.md:87-92` 明确记录了该延期。

## Target

1. resident 页面继续保持挂载和缓存，但不可见 Record 视图不创建全部 `RecordListItem`，也不安装其测量 observer。
2. 从 QuickNote 切到 Record 时，历史列表在同一帧可用；只允许已有的 cold-only `160ms` opacity handoff，不添加整页 slide/scale/crossfade。
3. skeleton 仅在 cold pending 持续 `120ms` 后显示；数据在门槛内返回时直接显示内容，不闪 skeleton。已经显示 skeleton 后不得人为延长最短展示时间。
4. macOS WebKit 与 Windows WebView2 的 A→B→C→D→E→A、访问第 6 个 Project、Record Focus、长历史切换和内存稳定性结果写入 `docs/cache-strategy.md`；这一步继续依赖 #56 的平台环境。

## Repo conventions to follow

- `src/components/rich-editor/RichTextViewer.tsx:48` 已用 `active` / `deferUntilVisible` 延迟重活；新的列表门控应复用同样的“可见才做工作”语义，不另建动画系统。
- `src/App.tsx:1350` 与 `src/components/record/RecordFocusResidentPages.tsx:123` 已对 resident shell 使用 `aria-hidden` + `inert`；不要破坏可访问性边界。
- motion token 位于 `src/styles/app.css:76-81`；本计划只复用 `--duration-standard` 与 `--ease-decel`。

## Steps

1. 在 `src/components/project/ProjectOverviewPage.test.tsx` 和 `src/components/workspace/WorkspacePage.test.tsx` 先补契约：QuickNote 可见时不应渲染历史 `RecordListItem`/安装折叠测量；切到 Record 后列表恢复，内容与焦点过滤不变。
2. 在 Project 与 Workspace overview 提取一个轻量、可测试的历史视图激活门控。页面 shell、查询与缓存保持 resident；只把列表节点和其测量副作用限制在 `currentView === "record"`。不要通过 `display:none` 保留重节点。
3. 保持 Record 视图切回时的滚动位置与筛选参数；如重新挂载会丢滚动位置，使用仓库现有 `useRememberScrollPosition`，不要常驻整棵列表来保存滚动。
4. 为 overview 与 record cold query 增加共享 `useDelayedPending(120)`（名称可按仓库惯例调整）：pending 开始后设定单一 120ms timer；pending 结束立即清理；组件卸载必须清理；不得设置 minimum-visible timer。
5. 更新 `PageLoadingSkeleton` 相关测试：120ms 内数据返回不出现 skeleton；超过 120ms 才出现；出现后数据返回立即切到内容；fake timers 每条测试后恢复。
6. 在具备平台环境时执行 #56：分别记录 macOS WebKit / Windows WebView2 的切换 trace、resident 上限、长历史切换和稳定内存。将日期、构建 commit、Record 数量、冷/热路径和结果写回 `docs/cache-strategy.md:83` 表格。

## Boundaries

- 不取消最多 5 个 Project shell 与 2 个 Record Focus editor 的 residency。
- 不对 warm navigation 添加页面级动画，不用 skeleton 掩盖同步主线程工作。
- 不引入 virtualization/motion 依赖；若 100+ Record 仍有显著成本，另开虚拟化议题，不在本计划中临时实现。
- #56 平台验证未完成时，不得把 macOS/Windows 标记为实测通过。
- 若当前分支不再保持 overview resident，停止并重新审计，不要套用本门控方案。

## Verification

- **Mechanical**: `npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/workspace/WorkspacePage.test.tsx src/ui/components/PageLoadingSkeleton.test.tsx && npm run build && npm run check:ui-standards`；全部退出码为 0。
- **Feel check**: 准备至少 30 条长 Record，在 QuickNote / Record 与 A→B→A 间反复切换；确认 warm 页面立即响应、QuickNote 隐藏期间没有历史项 observer、Record 首次激活没有明显长任务。
- 在 Network/Performance 面板分别验证 <120ms 与 >120ms cold query：前者没有 skeleton flash，后者结构稳定，数据返回即交接。
- 开启 reduced motion，确认不新增位移；cold content 仍只做现有 120ms opacity。
- **Done when**: 隐藏历史列表不再承担条目级 React/测量成本，skeleton 门槛测试通过，且 #56 的两平台记录完成；在此之前 001 保持 `IN PROGRESS`。

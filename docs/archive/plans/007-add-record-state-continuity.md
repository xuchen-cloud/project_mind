# 007 — 补全视图切换与 Record 增删连续性

- **Status**: TODO
- **Commit**: baff931
- **Severity**: MEDIUM
- **Category**: Missed opportunity / Spatial continuity / Purpose & frequency
- **Estimated scope**: 8–12 files，约 220–360 行（含测试）

## Problem

QuickNote / Record 是高频视图切换。内容保持 resident 是正确的，但 segmented button 的 active 背景与文字颜色瞬时跳变，没有最小的状态反馈。

```css
/* src/styles/app.css:2737 — current */
.project-overview-focus__view-switch-button {
  /* ... */
  background: transparent;
  color: var(--color-text-soft);
}
.project-overview-focus__view-switch-button--active {
  background: var(--color-text);
  color: var(--color-bg);
}
```

Record 增删也直接改变 query 数组。Project 新建头插、删除 filter：

```ts
// src/components/project/ProjectOverviewPage.tsx:315 — current
const nextRecords =
  existingIndex >= 0
    ? currentRecords.map((item) => (item.id === record.id ? record : item))
    : [record, ...currentRecords];

// src/components/project/ProjectOverviewPage.tsx:336 — current
return { ...current, records: current.records.filter((item) => item.id !== noteId) };
```

Workspace 增删后 invalidate，历史组件直接 map 新数组：

```tsx
// src/components/workspace/WorkspaceOverviewHistory.tsx:242 — current
{notes.length > 0 ? (
  <div className="grid gap-2.5">
    {notes.map((note) => (
      <RecordListItem key={note.id} record={note} /* ... */ />
    ))}
  </div>
) : null}
```

结果是新增项突然挤入、删除项瞬间消失，后续卡片跳位。

## Target

- QuickNote / Record 的内容切换保持即时、无 crossfade/slide；只给 active button 的 `background-color` 与 `color` 添加 `160ms var(--ease-soft)`。高频点击不创建 JS timer。
- Record 新增：新卡片从 `opacity:0; transform:translateY(-6px)` 到稳定态，160ms `--ease-decel`。
- Record 删除：业务 cache/query 立即删除；视觉副本保留 160ms，`opacity:0; transform:translateY(-4px)`，同时 `aria-hidden`、inert、pointer-events none。
- 其余卡片使用 005 的 transform-only FLIP，160ms `--ease-soft`；不 stagger，不动画 height/margin/top。
- 更新已有 Record 内容不播放 entry；初次 query hydration / 筛选条件变化不把所有现有项误判为新增。
- reduced motion：view-switch 颜色仍可 160ms；Record translate/FLIP 关闭，只保留 opacity 或即时增删。

## Repo conventions to follow

- 使用 `src/styles/app.css:76-81` 的 standard、soft、decel token。
- Project 与 Workspace 必须共享同一个 keyed presence/FLIP primitive；不要维护两套时间和 class 协议。
- `RecordListItem` 的业务保存/删除、context menu、focus page 跳转 API 不变。

## Steps

1. 在 Project/Workspace overview 测试中补 view-switch 契约：两个内容 section 的可见性立即改变，按钮 class/aria-selected 正确；不要用 timer 测内容切换。
2. 给 `.project-overview-focus__view-switch-button` 添加显式 `background-color,color` transition，160ms soft；不添加 transform，不为 content section 加动画。
3. 在 005 的 list FLIP helper 旁增加 keyed presence list（或把两者组成单一 hook）：首次初始化把所有 id 视为 present；后续新增标 entry；props 消失标 exiting 并保留快照 160ms；同 id 在退出期重新出现时从当前状态反向。
4. Project Overview 与 WorkspaceOverviewHistory 都通过共享 presence result 渲染。外层 wrapper 持有 `data-state="entering|present|exiting"` 和 element ref；业务 `RecordListItem` 本身不感知动画阶段。
5. exiting wrapper 立即添加 `aria-hidden="true"`、`inert`、pointer-events none；若被删除项原先含焦点，业务删除前把焦点移到稳定的列表标题/新建按钮，避免焦点落在即将卸载 DOM。
6. 在 `app.css` 定义 Record wrapper 的 transition 与 `@starting-style` entry；exit 由 data-state；reduced-motion 删除 translate/FLIP。
7. 添加 fake-timer/rAF 测试：初次 30 项不 entry；新增仅新 id entry；内容更新不 entry；删除保留 160ms后移除；筛选切换不把返回项全部当成新建；快速删/恢复同 id 不重复节点。

## Boundaries

- 不动画 QuickNote/Record 内容面板本身；高频切换必须即时。
- 不延迟 cache mutation、query invalidation、导航或删除成功反馈。
- 不给每条历史记录 stagger，不让初次加载的 30+ 条记录依次出现。
- 不把筛选结果变化解释为业务删除；筛选时直接更新可见集合，除非产品明确要求另一个动画语义。
- 依赖 005 的 FLIP helper；如果 005 尚未完成，只实施 view-switch 子项，不复制临时 helper。

## Verification

- **Mechanical**: `npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/workspace/WorkspaceOverviewHistory.test.tsx src/components/workspace/WorkspacePage.test.tsx && npm run build && npm run check:ui-standards`；全部退出码为 0。
- 快速交替点击 QuickNote/Record 20 次：内容即时，无双重曝光；按钮颜色可中断地追随最后一次选择。
- 在 30 条列表首部新增、删除首/中/尾项；10% 慢放确认仅目标项淡入/淡出，兄弟 transform 补位，不出现逐条 stagger。
- 开启 reduced motion，确认没有 translate/FLIP，焦点不落在 exiting 节点。
- **Done when**: view switch 有最小状态反馈，Project/Workspace Record 增删共享同一 presence/FLIP，初次加载与筛选不误播。

# 005 — 移除布局属性动画并修复折叠跳位

- **Status**: TODO
- **Commit**: baff931
- **Severity**: HIGH
- **Category**: Performance / Interruption / Missed opportunity
- **Estimated scope**: 7–10 files，约 220–360 行（含测试）

## Problem

侧栏 resize 已不再 transition width，但 Todo 仍直接动画 `width`、`height`、`max-height` 与 `margin`。这些属性在繁忙列表上逐帧触发布局与绘制。

```css
/* src/styles/app.css:3266 — current */
.todo-rail__priority-dot {
  width: 0.55rem;
  height: 0.55rem;
  transition: width 160ms var(--ease-soft), height 160ms var(--ease-soft), box-shadow 160ms var(--ease-soft);
}
.todo-rail__priority-dot--active {
  width: 0.72rem;
  height: 0.72rem;
}
```

```css
/* src/styles/app.css:3550 — current */
.todo-card__subitem-row {
  max-height: 0;
  overflow: hidden;
  transition:
    max-height var(--duration-standard) var(--ease-soft),
    opacity var(--duration-standard) var(--ease-soft);
}

.todo-card__expand {
  transition:
    opacity var(--duration-standard) var(--ease-soft),
    width var(--duration-standard) var(--ease-soft),
    margin var(--duration-standard) var(--ease-soft);
}
```

长 Record 的 320px 折叠和完整高度之间则完全瞬时切换；后续卡片会直接跳位。

```tsx
// src/components/record/RecordListItem.tsx:688 — current
className={cn(
  "project-history-record__collapsible",
  canCollapse && !expanded && "project-history-record__collapsible--collapsed",
)}
style={
  canCollapse && !expanded
    ? { maxHeight: `${RECORD_COLLAPSED_CONTENT_HEIGHT}px` }
    : undefined
}
```

Todo 已完成子项面板同样整块条件挂载：

```tsx
// src/components/todo/TodoListItem.tsx:462 — current
{expanded && canExpand ? (
  <div className="todo-card__finished-panel">...</div>
) : null}
```

## Target

- 生产 motion 只动画 `transform` 与 `opacity`；`clip-path` 只用于单个 reveal 的视觉裁切。不得 transition `width/height/max-height/margin/padding/top/left`。
- priority dot 占位固定为 `0.72rem × 0.72rem`；inactive 用子元素或伪元素 `scale(0.76)`，active `scale(1)`，`160ms var(--ease-soft)`。
- Todo subitem row 的布局开/关即时提交；内部内容从 `opacity:0; transform:translateY(-4px)` 到稳定态，160ms。expand button 始终保留固定宽度槽位，隐藏仅用 opacity/visibility/pointer-events，不压缩 width/margin。
- Record expand/collapse 和 Todo finished panel 使用 transition-based presence：视觉内容 `160ms` opacity + `clip-path: inset(...)`；同一列表内受影响的后续卡片使用 transform-only FLIP，160ms `--ease-soft`，从旧位置过渡到新位置。
- 快速反复点击必须从当前 transform/opacity 状态 retarget；不得使用重启动画的 keyframes。
- reduced motion：布局直接切换，不做 FLIP/clip/translate；保留 160ms opacity 或直接状态反馈。

## Repo conventions to follow

- 复用 `src/styles/app.css:76-81` 的 `--duration-standard`、`--ease-soft`。
- `src/ui/motion.ts` 提供 JS duration；rAF/timer 必须在卸载时清理。
- 侧栏的 `src/ui/components/ResizeHandle.tsx` 已证明 resize 期间应直接更新布局；不要重新给侧栏宽度加 transition。

## Steps

1. 用 `rg -n "transition:.*(width|height|max-height|margin|padding|top|left)|transition-property:.*(width|height|max-height|margin|padding|top|left)" src` 固定当前违规基线；本计划完成后该命令不应再命中 Todo 的三处规则。正式自动门禁在 008 添加。
2. 将 priority dot 改为固定外框 + transform 内核/伪元素；更新 Todo rail 测试，断言 active class/aria 不变。
3. 重构 `.todo-card__subitem-row`：删除 `max-height` transition；行容器的布局状态直接变化，子内容使用 opacity/translate。`.todo-card__expand` 保留固定 slot，删除 width/margin transition 与隐藏态的 width/margin 写入。
4. 为 `TodoListItem.test.tsx` 补充快速 pointer hot-zone、progress editing、expand button 焦点测试，确保视觉隐藏的按钮不可聚焦/点击，重新出现时 slot 不推动输入框。
5. 提取一个局部、无依赖的 list FLIP helper（放到现有 UI motion 目录或最靠近两个消费者的共享位置）：按稳定 id 记录更新前后 `getBoundingClientRect().top`，只把 `deltaY` 写入 transform，然后下一帧 transition 到 0；连续更新先读取当前 visual position，取消旧 rAF。
6. 在 RecordListItem 的 expand/collapse 上增加 open/closing presence 与 reveal data-state；列表容器在高度提交前后调用 FLIP helper，让后续 Record 卡片补位。保留 320px collapsed 业务高度，但不得 transition max-height。
7. Todo finished panel 使用同一 presence/FLIP 模式；关闭时视觉层保留 160ms、从辅助技术树和 tab order 立即移除，完成后卸载。
8. 在 reduced-motion 分支关闭 FLIP、clip-path 和 translate；确保现有 `.todo-card__subitem-row` reduced rule 不再掩盖生产 layout transition，因为后者已删除。

## Boundaries

- 不动画侧栏 resize，不给拖拽增加 inertia。
- 不改变 320px Record 折叠阈值、Todo hot-zone 400ms 交互延迟、完成/未完成业务状态或焦点顺序。
- 不通过 `grid-template-rows`、CSS `max-height:9999px` 或 JS 逐帧写 height 替代现有 layout transition。
- 不把所有列表接入全局 FLIP；只覆盖 Record 展开与 Todo finished panel 两个已审计跳位点。
- 不同时给父子元素相同方向 translate，避免位移叠加。

## Verification

- **Mechanical**: `npm run test:unit -- src/components/todo/TodoListItem.test.tsx src/components/project/ProjectOverviewPage.test.tsx src/components/workspace/WorkspaceOverviewHistory.test.tsx && npm run check:ui-standards && npm run build`；全部退出码为 0。
- 在 DevTools Performance 录制长 Todo/30 条 Record 展开折叠；动画区间不应连续出现 Layout 事件，composite layer 只包含 transform/opacity/clip reveal。
- 10% 慢放快速反复展开/收起，确认视觉从当前位置反向、不闪回、不双重位移；后续卡片平滑补位。
- 开启 reduced motion，确认布局立即到位，无 translate/clip；隐藏控件不在 tab order。
- **Done when**: UI standards 检查找不到 layout-property transition，三个 Todo 违规全部删除，Record/Todo 展开无跳位且可中断。

# 003 — 补全 Dialog 与 Toast 的退出生命周期

- **Status**: TODO
- **Commit**: baff931
- **Severity**: MEDIUM
- **Category**: Interruption / Easing & duration / Accessibility
- **Estimated scope**: 9–12 files，约 260–420 行（含测试）

## Problem

Dialog 与 Toast 已有合格的进入态和 reduced-motion 降级，但都在业务状态关闭时立即卸载，导致只有“出现”没有“离开”。Dialog 快速关闭/重开也无法从当前视觉状态反转。

```tsx
// src/ui/components/Dialog.tsx:160 — current
if (!open || !hostRef.current) {
  return null;
}
```

```css
/* src/styles/app.css:261 — current */
.dialog-backdrop {
  opacity: 1;
  transition: opacity var(--duration-deliberate) var(--ease-decel);
}

.dialog-surface {
  opacity: 1;
  transform: scale(1);
  transform-origin: center;
  transition:
    opacity var(--duration-deliberate) var(--ease-decel),
    transform var(--duration-deliberate) var(--ease-decel);
}
```

Toast 的 store 直接删除数据，组件也只渲染当前数组：

```ts
// src/state/feedback-store.ts:63 — current
dismissToast: (id) =>
  set((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  })),
```

```tsx
// src/components/layout/ToastStack.tsx:13 — current
if (toasts.length === 0) return null;
// ...
{toasts.map((toast) => (
  <div key={toast.id} className="toast-item ...">
```

`MoveSelectionToRecordCard` 还是自建遮罩 + Popover，既没有 Dialog 的 motion，也没有其 role/focus/inert 语义；两个父页面又以条件挂载让它无法退出保留：

```tsx
// src/components/record/MoveSelectionToRecordCard.tsx:70 — current
return (
  <div className="fixed inset-0 z-[95] flex items-start justify-center bg-[var(--color-overlay)] px-4 pt-[12vh]">
    <PopoverPanel className="w-[min(34rem,calc(100vw-2rem))] p-3 shadow-[var(--shadow-lg)]">
```

## Target

- Dialog 打开继续使用现有 `220ms`、`--ease-decel`、`scale(0.97) + opacity`；关闭使用 `160ms`、`--ease-soft`、`scale(0.985) + opacity`。
- `open=false` 时业务语义立即关闭：Escape/按钮只调用一次 `onClose`，焦点立即恢复，关闭层立即 `aria-hidden`、`inert`、`pointer-events:none`；仅视觉 portal 保留 160ms。
- 160ms 内再次打开时取消卸载，从当前 computed state 反向过渡，不重新播放 `@starting-style`。
- Toast 进入保留现有 160ms `translateY(-8px) + opacity`；退出为 `160ms` `translateX(8px) + opacity`。
- Toast 删除后的兄弟重排使用 transform-only FLIP，`160ms var(--ease-soft)`；不动画 `top`、`height`、`margin`，不 stagger。
- reduced motion 下 Dialog/Toast 都只保留 `160ms opacity`，不 scale/translate；关闭仍有同样的 presence 生命周期。
- `MoveSelectionToRecordCard` 迁移到共享 Dialog/presence 协议，获得 `role="dialog"`、focus trap、背景 inert、Escape/外点关闭与同样的 entry/exit；视觉仍保持顶部约 12vh 的搜索卡片布局，不强制改成居中大模态。

```css
/* target */
.dialog-backdrop[data-state="closing"] { opacity: 0; pointer-events: none; }
.dialog-surface[data-state="closing"] {
  opacity: 0;
  transform: scale(0.985);
  transition-duration: var(--duration-standard);
  transition-timing-function: var(--ease-soft);
}
.toast-item[data-state="closing"] {
  opacity: 0;
  transform: translateX(8px);
  pointer-events: none;
}
```

## Repo conventions to follow

- 只使用 `src/styles/app.css:76-81` 的 `--duration-standard`、`--duration-deliberate`、`--ease-soft`、`--ease-decel`。
- `src/ui/motion.ts:1-5` 是 JS timer 的单一时间来源；不要在 TSX 里写裸 `160`。
- 保留 `src/ui/components/Dialog.tsx` 现有 portal、stacked dialog、background inert、focus trap 和 restore-focus 逻辑；presence 只能包在其外层，不能弱化这些语义。

## Steps

1. 在 `src/ui/components/primitives.test.tsx` 增加 fake-timer 测试：关闭后业务焦点立即恢复；visual portal 在 160ms 内仍存在但 `aria-hidden`/inert/不接收指针；到期卸载；关闭中重开会取消卸载且不会重复 `onClose`。
2. 在 `Dialog.tsx` 增加最小 presence state（例如 `mounted` + `visualState`）和单一 cleanup timer。`open=true` 立即挂载并设 open；`open=false` 设 closing，160ms 后卸载。所有路径必须清 timer，快速反向不得创建第二 portal host。
3. 将 focus/inert effect 的业务开放状态与视觉 mounted 状态分开：`open=false` 立即移出 active dialog stack、恢复背景与焦点；closing DOM 添加 `aria-hidden="true"`、`inert`、`pointer-events-none`。
4. 在 `app.css` 添加 `[data-state="closing"]`，显式覆盖关闭时长/曲线；保留当前 `@starting-style` 作为首次进入；reduced-motion 规则同时覆盖 closing transform。
5. 在 `src/components/layout/FeedbackSurfaces.test.tsx` 增加 Toast presence 测试：dismiss 后保留 160ms closing DOM；到期移除；新 Toast 在旧 Toast closing 时加入不会丢项；错误 Toast 的 live-region 语义不重复播报。
6. 在 `ToastStack.tsx` 本地维护 rendered/present items；props 中消失的 id 标为 closing，160ms 后从 rendered 列表删除。重新出现的同 id 取消 closing。不要把视觉 phase 写进 Zustand 业务 store。
7. 使用 element ref map + `useLayoutEffect` 实现 transform-only FLIP：提交前保存旧 rect，提交后计算 `deltaY`，先无 transition 放置到旧位置，再在下一帧清 transform，让 CSS transition 到 0。组件卸载时取消 rAF；已有 closing transform 时以当前 computed transform 为起点。
8. 扩展 Dialog 的布局 API，只开放窄的 alignment/position class 注入；把 `MoveSelectionToRecordCard` 改为 `open` 驱动的共享 Dialog。Project/Workspace 父页面必须始终渲染组件并传 `open={Boolean(quickNoteMoveSelection)}`，使关闭时组件仍可完成 presence；业务 action 在 selection 为空时必须 disabled/no-op。
9. 为 MoveSelection surface 增加测试：可访问名称、初始搜索焦点、Escape/外点、关闭后焦点恢复、160ms visual presence、busy action 不重复提交。

## Boundaries

- 不延迟 `onClose`、`dismissToast`、焦点恢复或业务提交。
- 不用 `setTimeout` 模拟动画完成以外的业务逻辑；如果 `transitionend` 可用，以其为主并保留 160ms 安全 timer。
- 不给 Dialog 加 bounce/overshoot，不给 Toast 做逐条 stagger。
- 不改变 toast 去重、tone、live-region 文案；退出节点必须从辅助技术树隐藏，避免重复播报。
- 不保留 MoveSelection 的无语义自建 backdrop；也不要把它做成默认带动画的 PopoverPanel。
- 不引入 motion/presence 依赖。

## Verification

- **Mechanical**: `npm run test:unit -- src/ui/components/primitives.test.tsx src/components/layout/FeedbackSurfaces.test.tsx src/components/record/MoveSelectionToRecordCard.test.tsx src/state/feedback-store.test.ts && npm run build && npm run check:ui-standards`；若 MoveSelection 尚无测试文件，按现有组件路径新建；全部退出码为 0。
- **Feel check**: 10% 慢放下打开/关闭 Dialog，确认关闭更快、更克制；在退出中立刻重开，确认从当前尺寸反向而不是闪回 0.97。
- 连续创建 3 个 Toast，关闭中间项，确认其淡出/右移，邻项只用垂直 transform 补位；快速连关不跳位、不重播进入。
- 开启 reduced motion，确认所有 scale/translate 消失，只剩 opacity，且业务响应没有 160ms 延迟。
- **Done when**: Dialog 和 Toast 都有可中断退出 presence，业务语义即时，FLIP 不触发布局属性动画，机械测试与上述慢放检查通过。

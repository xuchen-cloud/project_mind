# 006 — 删除键盘滚动与编辑器悬停位移

- **Status**: TODO
- **Commit**: baff931
- **Severity**: HIGH
- **Category**: Purpose & frequency / Accessibility / Consistency
- **Estimated scope**: 5–7 files，约 70–130 行（含测试）

## Problem

编辑器“查找下一个/上一个”是键盘高频路径，但匹配项离开舒适区时两处硬编码平滑滚动。连续按键会反复 retarget 滚动，造成输入滞后感，且没有 reduced-motion 分支。

```ts
// src/components/rich-editor/editorSearch.ts:64 — current
scrollParent.scrollBy({
  top: matchMiddle - (rect.top + rect.height * 0.42),
  behavior: "smooth",
});
// ...
window.scrollBy({ top: matchMiddle - viewportHeight * 0.42, behavior: "smooth" });
```

Record 聚焦虽然已从多次滚动收敛为一次并支持 reduced motion，但默认仍是 smooth；该 helper 无法知道触发来自鼠标还是键盘。

```ts
// src/hooks/useUtilityHooks.ts:33 — current
const scrollBehavior =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
```

Rich Editor 高频工具还在未 gate 的 `:hover` 上移动 1px，触摸设备可能产生 false hover；active 状态也与 hover 共用位移。

```css
/* src/styles/app.css:1078 — current */
.rich-editor__rewrite-widget-icon-button:hover:not(:disabled) {
  /* ... */
  transform: translateY(-1px);
}

/* src/styles/app.css:1501 — current */
.rich-editor__ai-menu-tool:hover:not(:disabled),
.rich-editor__ai-menu-tool.is-active {
  /* ... */
  transform: translateY(-1px);
}
```

## Target

- 编辑器搜索匹配滚动始终使用 `behavior:"auto"`；每次键盘动作在同一帧把目标放进 comfort zone，不进行浏览器平滑滚动。
- `focusTargetElement` 默认也使用 `auto`。若未来确有低频、纯 pointer 的空间导航需要 smooth，必须通过显式参数传入并在调用处证明触发来源；当前调用点不启用。
- 保留现有 220ms opacity-only focus cue，让瞬时定位后仍可识别目标。
- 删除两个 Rich Editor hover/active 的 `translateY(-1px)` 与 transform transition，只保留颜色、背景、边框反馈，统一为 `var(--duration-standard) var(--ease-soft)`。
- 不需要为这两个高频工具再套 hover media query；最强修复是删除移动。reduced motion 与 touch 因此天然一致。

## Repo conventions to follow

- `docs/design-system.md:165-173` 规定只使用 `100/160/220ms` token；把这两个控件的裸 `140ms ease` 收敛到 `--duration-standard` / `--ease-soft`。
- `src/styles/app.css:234-259` 的 focus cue 已是合格的 opacity feedback，不恢复旧的 1.1s box-shadow flash。
- `src/hooks/useUtilityHooks.ts:5-15` 已保存滚动位置；瞬时 focus 定位不得破坏它。

## Steps

1. 为 `editorSearch` 增加/更新单元测试：scroll parent 与 window 两条路径都断言 `behavior:"auto"`；连续调用不会创建 timer/rAF。
2. 将 `editorSearch.ts` 两处 smooth 改为 auto；不要读取 matchMedia，因为键盘高频路径在普通 motion 偏好下也应即时。
3. 更新 `useUtilityHooks.test.tsx`，普通与 reduced-motion 两种环境都断言 `behavior:"auto"`；保留 focus cue 在 `MOTION_DURATION_MS.deliberate` 后清理的断言。
4. 简化 `focusTargetElement`：删除仅用于决定 smooth 的 matchMedia 分支；若 API 保留 behavior option，默认必须为 auto，且当前调用不传 smooth。
5. 在 `app.css` 删除两个 `translateY(-1px)` 与 `transform 140ms ease`；将剩余 color/background/border transitions 改用 standard/soft token。把 `.is-active` 的视觉状态与 hover 分开书写，避免未来误把 pointer motion带入 active。
6. 增加一条静态 UI standards 测试或 008 的 fixture，确保这两个 selector 不再包含 transform；不要为了测试导出 CSS 内部实现。

## Boundaries

- 不删除 editor search 的 comfort-zone 计算，不改变 28%/72% 边界与 42% 目标位置。
- 不删除焦点提示，只删除滚动运动和装饰性 hover 位移。
- 不把浏览器 `scroll-behavior:smooth` 加到全局 CSS。
- 不改 ProseMirror 自身为保持选区可见而触发的内部 `tr.scrollIntoView()`。
- 不扫描并机械替换整个仓库的 `140ms`；本计划只处理两组审计 selector。

## Verification

- **Mechanical**: `npm run test:unit -- src/hooks/useUtilityHooks.test.tsx src/components/rich-editor/RichEditor.test.tsx && npm run build && npm run check:ui-standards`；全部退出码为 0。
- 按住 Enter/快捷键连续跳转 20 个搜索匹配，确认视口即时跟随、不排队、不追赶。
- 从搜索结果或内部引用打开 Record，确认目标立即定位，220ms focus ring 仍清楚提示目标。
- 用触控模拟与鼠标悬停 Rich Editor 两组工具，确认无 1px 位移，颜色反馈与 active 状态仍明确。
- **Done when**: 生产代码没有这两处 smooth scroll 与 hover transform，测试证明普通/reduced 两种偏好均即时。

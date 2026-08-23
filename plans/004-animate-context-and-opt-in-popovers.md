# 004 — 为右键菜单与低频 Popover 添加有来源的进入动效

- **Status**: TODO
- **Commit**: baff931
- **Severity**: MEDIUM
- **Category**: Purpose & frequency / Spatial continuity / Accessibility
- **Estimated scope**: 7–9 files，约 130–220 行（含测试）

## Problem

右键菜单已正确处理 viewport clamp 和即时关闭，但主面板仍瞬时出现，且没有从点击点生长的空间来源。

```tsx
// src/ui/components/ActionContextMenu.tsx:179 — current
const position = useMemo(() => {
  // ...
  return {
    left: Math.min(/* viewport clamp */),
    top: Math.min(/* viewport clamp */),
  };
}, [actions, x, y]);

return (
  <PopoverPanel
    ref={menuRef}
    className="context-menu__panel fixed z-[80] w-[11rem] ..."
    style={position}
  >
```

```css
/* src/styles/app.css:4355 — current */
.context-menu__panel,
.context-menu__submenu-panel {
  border-color: color-mix(in srgb, var(--color-border) 84%, transparent);
  background: color-mix(in srgb, var(--color-bg) 96%, var(--color-bg-subtle));
  box-shadow: var(--shadow-context-menu);
}
```

共享 `PopoverPanel` 是静态容器。点击触发、低频的颜色与文件版本下拉只旋转箭头，面板仍瞬时出现；而 mention/reference picker 与插表面板属于高频键盘/编辑路径，应继续即时。

```tsx
// src/ui/components/PopoverPanel.tsx:5 — current
export const PopoverPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("rounded-...", className)} {...props} />
  ),
);
```

```tsx
// src/components/settings/ColorKeyDropdown.tsx:101 — current
{open ? (
  <PopoverPanel className="absolute left-0 top-[calc(100%+8px)] ...">
```

## Target

- ActionContextMenu 主面板首次进入：`100ms var(--ease-out)`，从 `opacity:0; transform:scale(0.97)` 到稳定态。
- `transform-origin` 指向原始右键坐标相对 clamp 后面板的位置，而不是固定 center：

```tsx
// target calculation
const originX = Math.min(MENU_WIDTH, Math.max(0, x - position.left));
const originY = Math.min(menuHeight, Math.max(0, y - position.top));
style={{ ...position, transformOrigin: `${originX}px ${originY}px` }}
```

- 外点、Escape、滚动、resize、blur 继续立即卸载；子菜单继续即时出现/切换，不添加退出动画或 submenu animation。
- `PopoverPanel` 增加显式 opt-in（例如 `motion="trigger"`），默认完全无动画。opt-in 面板使用 `160ms var(--ease-out)`、`scale(0.97)+opacity`，origin 由调用方按 placement 提供。
- 首批只启用 `ColorKeyDropdown` 与 `DocumentVersionPicker`：向下展开 origin 为 `top`，向上展开为 `bottom`；水平 origin 对齐 trigger。
- reduced motion：主菜单与 opt-in popover 使用 `100ms opacity-only`；Chevron 旋转取消，只保留颜色/状态变化。

## Repo conventions to follow

- 使用 `src/styles/app.css:76-81` 的 `--duration-fast`、`--duration-standard`、`--ease-out`。
- `ActionContextMenu.tsx:140-177` 的即时关闭监听器是正确行为，必须保留。
- `PopoverPanel` 默认静态是重要频率边界；新增能力必须 opt-in，不能通过全局 `.popover` 选择器让所有调用点自动运动。

## Steps

1. 在 `src/ui/components/ActionContextMenu.test.tsx` 增加 origin 测试：普通位置、右/下 viewport clamp、左/上 padding clamp；断言 style origin 仍指向可见面板内最接近原始点击的位置。保留 Escape/scroll 即时关闭测试。
2. 将 ActionContextMenu 的 `menuHeight` 从 memo 内局部值提升为 position 结果的一部分或共享计算，生成 `transformOrigin`；只给最外层 `.context-menu__panel` 添加 entry class。
3. 在 `app.css` 用 `@starting-style` 添加主面板 `scale(0.97)+opacity`，100ms `--ease-out`。不要覆盖 `.context-menu__submenu-panel`。
4. 给 `PopoverPanel` 增加窄类型 opt-in prop（例如 `motion?: "trigger"` 与 `motionOrigin?: CSSProperties["transformOrigin"]`），把它映射为 data attribute/style；默认 DOM/class 不变。为 primitive 添加测试，证明默认无 motion attribute，opt-in 才有。
5. `ColorKeyDropdown` 启用 opt-in，origin 为 `top`；给 Chevron 增加 `motion-reduce:transform-none motion-reduce:transition-none`。
6. 在 `DocumentSharedComponents.tsx` 复用已有向上/向下 placement 计算，为文件版本面板传 `top` 或 `bottom` origin；Chevron 同样 reduced-motion 降级。
7. 在 `app.css` 添加 opt-in popover 的 160ms entry 与 reduced-motion opacity-only 规则。

## Boundaries

- 不动画 `ContactMentionPicker`、`TagMentionPicker`、`InternalReferencePicker`、全局搜索、Rich Editor 插表 grid、AI 工具菜单或 ContextMenu 子菜单。
- 不为 ContextMenu 添加退出 presence；右键菜单是中高频工具，dismiss 必须即时。
- 不动画 `top/left` 定位，不使用 bounce、blur、stagger 或 `scale(0)`。
- 不改变 roving focus、submenu delay、menu action 顺序或 portal 层级。
- 不引入 floating-ui 或 motion 依赖。

## Verification

- **Mechanical**: `npm run test:unit -- src/ui/components/ActionContextMenu.test.tsx src/ui/components/primitives.test.tsx src/components/settings/ColorKeyDropdown.test.tsx src/components/document/DocumentSharedComponents.test.tsx && npm run build && npm run check:ui-standards`。若两个组件测试文件名称已漂移，先用 `rg --files` 找到现有同组件测试，不新建重复套件。
- **Feel check**: 在窗口四角打开右键菜单，10% 慢放确认面板从点击点而非中心出现；Escape/外点时立即消失。
- 打开颜色与文件版本下拉，确认面板从 trigger 边缘展开；快速开关不残留；mention/reference picker 仍完全即时。
- 开启 reduced motion，确认没有 scale/arrow rotate，只剩短 opacity。
- **Done when**: ContextMenu origin 通过 clamp 测试，两个 opt-in popover 有方向正确的 entry，所有高频/键盘 surface 仍无动画。

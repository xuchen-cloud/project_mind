# 009 — 优化 AI 设置折叠区的揭示与焦点

- **Status**: TODO
- **Commit**: baff931
- **Severity**: LOW
- **Category**: Missed opportunity / Accessibility / Interruption
- **Estimated scope**: 3–5 files，约 100–180 行（含测试）

## Problem

AI Provider Profile 与 Editor Skill 都是偶发使用的复杂 disclosure，但内容直接条件挂载/卸载。展开时长表单突然把后续卡片推开，收起时若焦点仍在表单内也缺少明确的焦点回收协议。

```tsx
// src/components/settings/AiSettingsPanel.tsx:808 — current
{expanded ? (
  <div className="border-t border-border px-3 pb-3 pt-3">
    <AiProfileEditorFields /* ... */ />
  </div>
) : null}
```

```tsx
// src/components/settings/AiSettingsPanel.tsx:1485 — current
{expanded ? (
  <div className="border-t border-border px-3 pb-3 pt-3">
    <EditorSkillEditor /* ... */ />
  </div>
) : null}
```

## Target

- 两类 disclosure 共用相同 presence 协议，不能各自复制 timer/class。
- 展开内容从 `opacity:0; clip-path:inset(0 0 8% 0)` 到稳定态，160ms `--ease-soft`；收起反向 160ms。
- 不 transition `height/max-height/grid-template-rows/margin/padding`。后续卡片位置变化复用 005 的 transform-only FLIP。
- 收起命令的业务状态立即生效：内容立刻 `aria-hidden`、inert；若焦点在内容内，先把焦点移回对应展开按钮；视觉副本保留 160ms 后卸载。
- 快速展开/收起从当前 opacity/clip 状态反向，不重播 keyframes。
- reduced motion：去掉 clip/FLIP，只保留 opacity 或即时切换。

## Repo conventions to follow

- 依赖 005 的 presence/FLIP helper 与 `src/ui/motion.ts` duration，不再新建一套 helper。
- 使用 `src/styles/app.css:76-81` 的 standard/soft token。
- 保留现有 card、button、form field、save/test/delete 业务组件和状态；motion wrapper 只管理视觉生命周期。

## Steps

1. 在 `AiSettingsPanel.test.tsx` 补两类 disclosure 的展开、收起、快速反向与焦点回收测试；使用 fake timers/rAF，并在测试后恢复。
2. 抽取局部 `DisclosurePresence`（若 005 已提供足够通用的 primitive，直接复用）：输入 `open`、trigger ref、children；输出 open/closing/present data state 与 inert/aria props。
3. 将 Provider Profile 与 Editor Skill 两处条件渲染替换为同一 wrapper；保留各自内容组件，不移动业务 mutation state。
4. disclosure 列表容器接入 005 的 FLIP，让后续 card 用 transform 补位；单个表单只用 opacity/clip reveal。
5. 添加 reduced-motion CSS；确认 closing 内容无法 tab 进入，timer/rAF 在切换设置页或卸载时全部清理。

## Boundaries

- 不动画表单字段逐项出现，不 stagger，不用 spring/bounce。
- 不通过 height/max-height transition 解决长内容展开。
- 不保留所有关闭表单永久挂载；只允许 160ms visual presence，避免隐藏的 provider/editor 状态持续占用交互树。
- 不改变 Profile/Skill 排序、保存、测试、删除语义。
- 若性能 profile 显示表单首次 mount 本身超过一帧，先修 mount 成本并暂停本计划，不能用 reveal 掩盖长任务。

## Verification

- **Mechanical**: `npm run test:unit -- src/components/settings/AiSettingsPanel.test.tsx && npm run check:ui-standards && npm run build`；全部退出码为 0。
- 展开含完整字段的 Profile/Skill，10% 慢放确认内容从自己的卡片边界揭示，后续卡片 transform 补位，无逐字段动画。
- 在输入框聚焦时收起，确认焦点回到同一卡片的展开按钮；快速反复点击不闪回。
- 开启 reduced motion，确认无 clip/FLIP，表单仍可立即打开/关闭且 tab order 正确。
- **Done when**: 两类 disclosure 使用同一 presence，焦点协议可靠，无 layout-property transition，性能 profile 没有被 motion 掩盖的长任务。

# 动效审计剩余项执行文档

复核基线：`baff931`（2026-08-24）。本目录只描述执行方案，不代表产品代码已经修改。本轮将旧审计逐项对照当前实现，已经完成的内容不重复规划；部分完成和未完成项拆为可独立实施、测试和 feel check 的计划。

## 结论

- 已完成：Project/Workspace 数据预取、静态 skeleton、Record chunk idle preload、cold-only opacity handoff、后台保存不阻塞普通导航、RichTextViewer 延迟重活、Todo 长关键帧删除、侧栏 resize width transition 删除、共享按钮按压反馈、220ms focus cue、spinner reduced-motion。
- 部分完成：001 的代码与自动化已完成，但隐藏历史列表成本、120ms skeleton 门槛和 #56 两平台实测未完成；Dialog/Toast 只有进入态；reduced-motion 与 token 已有基础但覆盖和门禁未闭环。
- 尚未完成：ContextMenu/低频 Popover 进入、退出 presence、Todo 布局属性动画清理、Record/设置折叠连续性、键盘 smooth scroll/hover 位移删除、Record 增删与 view switch 状态反馈、自动化 motion 规则。

## Plans

| # | Plan | Severity | Status | Dependencies |
| --- | --- | --- | --- | --- |
| 001 | [消除项目与记录冷切换卡顿](./001-eliminate-cold-navigation-jank.md) | HIGH | IN PROGRESS | 代码完成；最终关闭依赖 002 与 #56 |
| 002 | [收尾冷导航的真实成本与实机证据](./002-finish-cold-navigation-performance.md) | HIGH | TODO | #56 提供 macOS/Windows 平台环境 |
| 003 | [补全 Dialog 与 Toast 的退出生命周期](./003-complete-surface-presence-lifecycles.md) | MEDIUM | TODO | 002 后实施 |
| 004 | [为右键菜单与低频 Popover 添加有来源的进入动效](./004-animate-context-and-opt-in-popovers.md) | MEDIUM | TODO | 002 后实施 |
| 005 | [移除布局属性动画并修复折叠跳位](./005-remove-layout-property-motion.md) | HIGH | TODO | 002、006 |
| 006 | [删除键盘滚动与编辑器悬停位移](./006-remove-high-frequency-motion.md) | HIGH | TODO | None |
| 007 | [补全视图切换与 Record 增删连续性](./007-add-record-state-continuity.md) | MEDIUM | TODO | 005 的 FLIP/presence primitive |
| 008 | [统一 motion token 并加入自动门禁](./008-enforce-the-motion-system.md) | MEDIUM | TODO | 003–007 完成后收口 |
| 009 | [优化 AI 设置折叠区的揭示与焦点](./009-polish-settings-disclosures.md) | LOW | TODO | 005 的 FLIP/presence primitive |

## 推荐执行顺序

1. **002 — 先处理真实性能。** 隐藏列表工作量和 skeleton flash 是体感“卡”的根因；先测清并降低主线程成本，避免后续动画掩盖问题。平台实测可在 #56 环境到位后补齐，不阻塞同计划的代码子项。
2. **006 — 先删错的 motion。** 键盘搜索 smooth scroll 与高频 hover 位移属于负收益，改动小、风险低、收益直接。
3. **005 — 清掉 layout-property transition。** 建立窄范围 FLIP/presence primitive，作为 Record、Todo、设置 disclosure 后续连续性的基础。
4. **003 与 004 — 完成全局 surface。** 先做 Dialog/Toast presence，再做 ContextMenu 与 opt-in Popover；两项可分支并行，但都必须保留即时业务响应和 reduced-motion。
5. **007 — Record 生命周期。** 复用 005，不另建第二套 FLIP；view-switch 只动画按钮状态，内容仍即时。
6. **009 — 低优先级设置 disclosure。** 仅在 profile 证明 mount 本身没有长任务后实施。
7. **008 — 最后收口门禁。** 统一存量 token，加入 fixture-backed 检查，防止 `transition-all`、layout motion、超长 duration、`scale(0)` 和 reduced-motion 缺口回归。

## 本轮明确不添加动画的区域

- warm/resident Project、Workspace、QuickNote、Record 页面内容切换：保持即时，不做整页 slide、scale 或 crossfade。
- 全局搜索、Contact/Tag/InternalReference picker、Rich Editor 插表 grid：键盘或编辑高频路径，保持即时。
- ActionContextMenu 子菜单与主菜单退出：保持即时；只给主菜单首次进入添加 100ms 来源动画。
- 侧栏拖拽 resize：直接跟手，不恢复 width transition 或 inertia。
- Todo 完成/恢复：保留当前 160ms transition，不恢复 390–560ms keyframes、stagger 或庆祝动画。

## 每批执行的共同门槛

每个计划必须同时通过：

1. 计划内列出的定向单元测试。
2. `npm run check:ui-standards`。
3. `npm run build`；高风险/共享 primitive 批次还需 `npm run test:unit` 全量通过。
4. DevTools 10% 慢放 feel check：来源、曲线、退出、快速反向均符合计划。
5. `prefers-reduced-motion: reduce` 检查：删除位移/scale/连续运动，但保留必要 opacity、颜色和即时状态反馈。
6. Performance 录制确认动画期间不持续触发 Layout；任何长任务先修真实工作量，不用 skeleton/reveal 掩盖。

## Status values

- `TODO`：尚未实施。
- `IN PROGRESS`：已有实现，但仍缺计划内 Done 条件或正式验证。
- `DONE`：实现、机械验证和 feel check 均完成。
- `STALE`：commit stamp 后代码漂移，步骤与当前代码不再匹配，需要重新审计。

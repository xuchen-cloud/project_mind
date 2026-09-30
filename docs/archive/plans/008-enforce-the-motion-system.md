# 008 — 统一 motion token 并加入自动门禁

- **Status**: TODO
- **Commit**: baff931
- **Severity**: MEDIUM
- **Category**: Consistency / Performance / Accessibility
- **Estimated scope**: 15–30 files，约 220–380 行（以机械替换与规则测试为主）

## Problem

motion 基础 token 和共享按压反馈已经建立，但旧 CSS 仍混用裸 `120/140/160/180ms` 与 bare `ease`。例如：

```css
/* src/styles/app.css:1064 — current */
transition:
  border-color 140ms ease,
  background-color 140ms ease,
  color 140ms ease,
  transform 140ms ease;
```

```css
/* src/styles/app.css:1494 — current */
transition:
  border-color 140ms ease,
  background-color 140ms ease,
  color 140ms ease,
  transform 140ms ease;
```

仓库规范已经要求新增/调整动效只使用三档：

```text
// docs/design-system.md:165 — current contract
100ms：按压反馈
160ms：颜色与常规控件状态
220ms：偶发的浮层或较大状态变化
```

但 `scripts/check-ui-standards.mjs:162-198` 目前只检查旧设计模式、Tauri 边界、图标库、硬编码颜色和 emoji；不会阻止 `transition-all`、布局属性 transition、`scale(0)`、高频 `ease-in`、超长 UI 动效或新增移动缺少 reduced-motion。

## Target

1. 生产 UI motion 的 duration 只引用 `--duration-fast|standard|deliberate`；JS 视觉清理只引用 `MOTION_DURATION_MS`。连续 spinner 的 `1s linear infinite` 是明确例外。
2. easing 只引用 `--ease-out|soft|decel`；如果 005 的 FLIP 确需对称位置曲线，可新增 `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`，除此之外不新增曲线。
3. 自动检查拒绝：
   - `transition-all` / `transition: all`；
   - transition `width|height|max-height|margin|padding|top|left`；
   - `scale(0)`；
   - UI interaction 的 `ease-in`；
   - transition/keyframe duration >300ms（allowlisted continuous spinner 除外）；
   - 新增裸毫秒 motion duration；
   - transform/translate/scale entry 没有对应 reduced-motion 降级协议。
4. 规则对 CSS 与 TSX class string 都生效，并有独立 fixture 测试；报错包含文件、行号、规则名和短 snippet。

## Repo conventions to follow

- token 源为 `src/styles/app.css:76-81`，JS 镜像为 `src/ui/motion.ts:1-5`，设计说明为 `docs/design-system.md:163-173`。
- 沿用 `scripts/check-ui-standards.mjs:105-160` 的 match collector 与错误格式，不引入 CSS parser 依赖。
- 测试/原型目录不进入生产门禁；`src/prototypes/**` 应像当前 test skip 一样显式排除或单独检查，不能让原型阻塞产品 build。

## Steps

1. 用 `rg` 只盘点真正的 CSS/Tailwind motion declaration，不把 debounce、autosave、tooltip open delay 等业务 timer 当动画。为每个裸 duration 分类到 fast/standard/deliberate；不能凭机械四舍五入决定语义。
2. 将颜色/hover/control 状态统一为 standard + soft；按压为 fast + out；Dialog/大 surface entry 为 deliberate + decel；小 popover 为 standard + out。删除不再使用的 transform transition。
3. JS 中属于 visual presence/cleanup 的裸 timer 改用 `MOTION_DURATION_MS`；SUBITEM hot-zone 400ms、autosave 120000ms 等交互/业务延迟保持命名常量，不纳入 motion rule。
4. 把 motion rule 定义提取为可单测的纯函数模块（例如 `scripts/ui-standards-motion-rules.mjs`），由 `check-ui-standards.mjs` 调用。不要让测试 import 主脚本时触发 `process.exit`。
5. 为每条规则添加 pass/fail fixture：多行 CSS transition、Tailwind `transition-all`/arbitrary properties、CSS variable duration、spinner allowlist、业务 `setTimeout` 非误报、reduced-motion pair。
6. reduced-motion 规则采用显式 motion contract，而非脆弱地猜 CSS selector：所有新增位移 surface 统一添加 `data-motion` 或稳定 motion class，并要求 reduced block 覆盖该 contract。现有合法组件逐步接入；不要通过全文件 allowlist 绕过。
7. 更新 `docs/design-system.md`，写清默认无动画、opt-in surface、键盘路径即时、允许属性、reduced-motion protocol 和连续 spinner 例外。
8. 在 003–007 全部实施后运行门禁并修净存量；如其他分支新增违规，逐项修代码，不扩大 allowlist。

## Boundaries

- 不检查普通数字 timer；只检查 transition/animation/motion class 与明确 visual constants。
- 不用全仓 `140ms→160ms` 替换；先判断该 transition 是否应该删除。
- 不允许按文件永久豁免 `app.css`，否则门禁失去价值；例外必须是窄 selector/pattern 并写理由。
- 不要求 reduced motion 删除所有颜色/opacity feedback；只删除位移、scale、旋转和连续 movement。
- 不引入 stylelint/PostCSS/motion 依赖。

## Verification

- **Mechanical**: `npm run test:unit -- scripts/check-ui-standards.test.mjs && npm run check:ui-standards && npm run test:unit && npm run build`；全部退出码为 0。
- 手工向临时 fixture 分别加入 `transition-all`、`max-height 400ms ease-in`、`scale(0)`、无 reduced-motion 的 entry transform，确认四类都失败且定位正确；删除 fixture 后门禁恢复通过。
- 全仓运行 `rg -n "transition-all|transition:\\s*all|scale\\(0\\)|[0-9]+ms ease" src --glob '!src/prototypes/**'`，生产 motion 不应命中；业务 timer 不受影响。
- 开启 reduced motion 抽查 Dialog、Toast、ContextMenu、Popover、Record/Todo list，确认位移/scale/连续旋转被移除，opacity/颜色反馈仍在。
- **Done when**: 存量 motion 符合三档 token，自动检查能拒绝六类高风险回归，规则 fixture 与完整 build 通过。

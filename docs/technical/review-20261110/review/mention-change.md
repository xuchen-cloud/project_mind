# Windows AI @mention 候选浮窗可读性修复

## 工作包（2026-11-10）

- 用户需求：Windows AI 对话输入 `@` 后候选浮窗半透明、透出底层内容；可靠可读优先，不能仅增加 blur。
- 关联 Issue：无；本次为用户直接授权的独立小 UI 修复。
- 依赖：仓库 AGENTS.md、docs/design-system.md、docs/requirements/dsh-ui-component-integration.md、packages/dsh-ui/README.md；固定 OSS 源码与 provenance 完整性约束。
- 交付：在真实候选浮窗源码上最小调整表面样式，复用 light/dark 主题实色，Windows 无 blur 仍遮挡底层；高对比模式保留可见边界。
- 非目标：交互逻辑、编辑器、Office zoom、其他共享 MenuSurface；不启动 GUI、不进行原生/全量/包构建、不提交或推送、不委派 agent。
- 验收：真实 `@` 路径定位；背景不依赖 backdrop-filter；light/dark token 均为实色；forced-colors 使用系统背景与可见轮廓；既有几何、列表和键盘行为不变。
- 验证范围：CSS/调用链静态检查、现有 vendor integrity 针对性校验、git diff --check 与 Standards / Spec 自查。纯样式不新增镜像测试；Windows 实机视觉交由主 agent 集中验收。
- 修改前进程检查：`ps -axo pid,command | rg '[t]auri.*dev|[v]ite'` 无匹配。

## 定位

`ui-reference/src/client/index.ts` 注册 `trigger: '@'` → `ui-input-trigger` 的检测与 MenuView → `ui-primitives/MenuSurface` material。共享主题原填充为 light `rgba(248,249,250,.58)` / dark `rgba(67,69,74,.45)`，依赖 `blur(40px) saturate(150%)`；不是缺少 blur 声明。

MenuView 同时承载 `/` 和 `@`，现有 DOM 无触发字符样式属性。为遵守不改逻辑约束，将实色修复限定于该候选浮窗 `.menu`；同一浮窗的 `/` 候选也获得相同表面。其他命令 popupSelect 和共享菜单不变。

## 实现与结果

- 修改 `packages/dsh-ui/upstream/client/ui-input-trigger/src/client/MenuView.module.css`：仅在 `.menu` 上重绑 material 填充、滚动提示底色和 backdrop token；使用 `--dsw-alias-bg-layer-2`，light 为 `rgb(255,255,255)`、dark 为 `rgb(44,44,46)`。取消本浮窗对 blur 的依赖，保留既有圆角、阴影、排版和滚动行为。
- forced-colors：填充使用 `Canvas`，以 `1px solid CanvasText` outline 替代会被系统去除的阴影；不禁用系统自动配色，不改选中态逻辑。
- 修改 `packages/dsh-ui/provenance.json`：登记局部 OSS 样式补丁并更新该源文件 SHA-256，保留 originalSha256。CSS Module 由现有 Vite alias 直接消费，不属于 scoped.css 派生输入，故无需生成主题 CSS 或包构建。
- `npm --prefix packages/dsh-ui run test:integrity`：5/5 通过（含源文件哈希、补丁登记和主题派生文件一致性）。
- `npm run check:ui-standards`：通过。
- `git diff --check`：通过。
- Standards 自查：仅候选表面 CSS 与必要来源登记；未更改共享 MenuSurface、逻辑、编辑器或 Office 文件。静态确认主题与 Portal 均沿现有 data-ds-dark-theme 同步机制；material 子元素继承局部 token。
- Spec 自查：已有 blur 声明不足以保障用户报告场景，改为无透明度的实色 material；浅/深主题和 forced-colors 均有对应规则。没有新增测试来镜像 CSS 声明。
- 验证限制：未运行 Windows WebView2/高对比实机 GUI，不将静态检查称为视觉验收；界面由主 agent 独占并集中验收。未进行任何构建、全量测试、commit/push 或子 agent 委派。
- 并行工作：收口时工作树出现 Office zoom 相关改动，属于另一 agent，本包未触碰；初始未跟踪文档也保留。

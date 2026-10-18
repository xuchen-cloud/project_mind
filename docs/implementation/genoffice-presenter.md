# PPT 演讲者视图：用户明确非目标

关联：子 Issue #191；父 Issue #118。

## 最新范围决定

2026-10-18 用户明确：**PPT 演讲者视图不需要支持**。已停止 presenter 支线，不继续第二屏 audience、显示器交换、专用 audience 入口或相应 native 窗口/权限实现。先前调查和最小方案不再是待实施承诺或发布阻塞。

普通单窗口幻灯片放映保留；此前未验证项仍在 [PPT 功能矩阵](genoffice-parity-ppt.md) 如实记录，不把本次撤除当作全功能完成。

## 本轮安全撤除

- 删除仅本轮新增的 `packages/office-pptx/presenter-types.ts`。
- 删除 `packages/office-pptx/test/browser-presenter.mjs`。
- 删除 `packages/office-pptx/test/ui/presenter-transport.ts`、`presenter-main.tsx`、`presenter.html`。
- 仅从既有 `test/ui/main.tsx` 撤除本轮新增的 presenter import 和条件 prop；保留原有 caret/save、失败保存、两次保存、外部替换、PDF/export/print 测试 harness。
- 本轮尚未新增生产 audience renderer、root audience HTML/TSX、PptxEditor presenter props 或原件保存接缝，故没有整体 restore 或反向覆盖这些生产文件。固定 vendor 与来源/license 不变。
- 已停止本轮 Vite 5189；首个 presenter 浏览器红例未通过，不保留为通过证据。

## 产品入口收口

用户随后明确保留标准放映、隐藏未接的演讲者/换屏入口。`parity-build.mjs` 仅在固定 Ribbon 源码的构建适配中移除演示者按钮，不改 vendor，不删除普通放映、从当前页放映、自定义放映或原版 show 组件。没有新增 presenter props/native 接缝。为保留这一范围保证，新增的是普通放映回归 `test/browser-slideshow.mjs`，并非恢复 presenter 测试。

## 验证与复用

- 撤除阶段前后比对包内顶层生产源码/配置、dist 文件和 PptxEditor TSX/CSS，共 50 个文件哈希相同。随后产品入口收口只改 Ribbon 构建适配，并定向重新生成本包 bundle。
- 复用 19:05 核心冻结证据：本包 build/check、15/15 实际格式字节测试、37/37 UI 单测，以及 Chromium/WebKit caret/protocol/resources 等已通过结果；对应核心生产逻辑和依赖不变，仅重建包含入口移除的包产物，不重复 root 构建或全量测试。
- 必要定向检查：确认测试 harness 仅移除上述两处接缝；删除文件无残留 import；文档链接与范围一致；无本包测试服务残留。此前核心功能的真实剩余项继续以功能矩阵为准。
- 本轮实际检查通过：`git diff --check`；本地文档链接/空白检查；TSX 无输出语法解析；5 个删除文件不存在，代码中没有其残留引用。
- `../../src-tauri/resources/agent-host/node build.mjs`（cwd `packages/office-pptx`）通过，97 handlers、501 原版源和 4 fork 源全部校验通过，固定来源与 license 保留。
- `OFFICE_PLAYWRIGHT_MODULE=/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs OFFICE_ACCEPTANCE_URL=http://127.0.0.1:5189 src-tauri/resources/agent-host/node packages/office-pptx/test/browser-slideshow.mjs`：先红（仍渲染 1 个演示者按钮），修复后 Chromium/WebKit 均绿。真实按钮从头开始、从当前页开始、左右翻页、Esc 回位、原 iframe、无演示者/换屏入口、无 pageerror；结果 [slideshow-results.json](../../packages/office-pptx/output/playwright/slideshow-results.json)。不将 headless 放映冒充 native 全屏/实机验收。
- Vite 5189 已再次 Ctrl-C 停止，没有进行中的本包构建/浏览器测试。不运行 root 全量 build/test；更新后的包产物由主下一次统一打包/stage 收入。

## 最终冻结确认

2026-10-18 已冻结本包生产源码和 dist。复查固定源的实际调用链，Ribbon 这一按钮是 `startPresenterView` 唯一用户入口；F5、Shift+F5、macOS Cmd+Enter 仍进入普通放映，没有新增其他演讲者入口。固定 `Ribbon.tsx` 与来源锁中的 Git blob `b66afef1bbde4b4f1256f3ae1717c24473a21d0e` 一致，适配只命中一个按钮；相邻从头、从当前页和自定义放映按钮均保留。

当前包构建产物和两浏览器绿色结果均产生于该适配变换之后，主已读取结果并开始集中最终构建。本轮不再修改生产源码/dist，不另起本包服务或构建；仅完成此文档澄清和定向 diff 检查。

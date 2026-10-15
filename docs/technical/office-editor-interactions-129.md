# Office 编辑交互工作包 #129

关联：[Issue #129](https://github.com/xuchen-cloud/project_mind/issues/129)，属于 #118。

依赖：已接入的 GenOffice DOCX / PPTX 引擎、真实渲染数据、宿主 Office 编辑会话和 File 保存/CAS。

交付行为：PPT 原位文字编辑、移除右侧属性栏、可折叠缩略图、多页纵向滚动、缩放与页导航；连续页间距 8px，页码位于幻灯片左侧。Word 固定原稿纸张宽度和边距，默认适应宽度、自动最小 50%，其后横向滚动，并支持手动缩放。

非目标：完整 Office 排版、Word 分页、新增文字段落、PPT 结构或格式修改、表格/图表编辑、保存协议变更。

验收：在宽窄容器中保持文稿比例；PPT 可直接在原位置输入中文、撤销重做、跳页和连续滚动，折叠后仍能导航；Word 缩放不改变纸张宽度和内容布局，缩放后正文和表格仍可编辑保存。两种编辑器保持只读冻结和随滚动距离变化的边缘遮罩。

验证范围：先更新 PPT 组件行为测试，分别验证两种编辑器的真实浏览器交互；收口复用有效结果并执行 Office 引擎、宿主集成测试、TypeScript、生产构建。Standards / Spec 由主 agent 检查，不启动 review 子 agent。

环境：源码修改前检查现有 Tauri 进程，主 checkout 运行的是 `tauri dev --no-watch`，本工作树的源码和构建不会自动打开应用窗口；UI 验收使用独立无头浏览器。

## 验证与 review（2026-10-15）

基准提交：`ec1238e`。用户明确指定合入 `develop`，覆盖发布规则中的默认 `main` 目标；避免夹带开发分支已有的无关提交。

- TDD：先将 PPT 组件验收改为点击画布、折叠和连续页布局，旧实现 3 失败 / 3 通过；实现后组件和渲染器 14 项通过，覆盖中文/IME、空文本恢复、只读、撤销重做、基线重置、粘贴拒绝和四向遮罩。
- `npm --prefix packages/office-pptx test`：7 项通过，真实字节两轮回存、原样式及未编辑部分保留、拒绝结构编辑和可迁移 bundle。
- `npm --prefix packages/office-pptx run check`：通过。
- DOCX 原有测试 13 项通过；独立的 bundle 验证起初因本地依赖符号链接使 notices 遗漏依赖而失败。将依赖恢复为本地安装目录并重建后，单独重跑 `node --test packages/office-docx/test/build.test.mjs` 通过；未放宽任何断言。
- `npm run test:office`：worker 4 项、宿主 105 项通过，复用 File 保存/版本/冲突/退出协议。
- DOCX `test/browser-zoom-acceptance.mjs`：Chromium / WebKit 均通过固定纸张/边距、原始换行与表格布局、50% 横向滚动、手动缩放、编辑/保存/重载、只读、长文档及四向连续遮罩。
- PPTX `test/browser-acceptance.mjs`：Chromium / WebKit 均通过原位中文、两轮保存/重开、撤销重做、只读、折叠、多页滚动同步、缩放及位置保持、8px 页间距/左侧页码、窄容器不溢出；无页面脚本错误。实际截图保存在 `packages/office-pptx/output/playwright/`。
- `npm run build`、`check:ui-standards`、`check:portable-paths`、`check:bundle-boundaries`：通过。生产构建仍提示既有动态/静态混合导入及大 chunk。

Standards 自查：主题 tokens、ToolbarButton、缩略图 HomeSidebarList、四向距离驱动遮罩、reduced-motion、UI/原稿样式隔离、引擎与宿主边界符合现有规范，无剩余发现。

Spec 自查：#129 与用户追加的紧凑页间距均已覆盖；未修改 File 持久化和格式引擎支持范围，无剩余发现。PPT 仍按原有文字片段编辑，不支持新增段落，复杂文字的编辑态浏览器字体度量可能与 SVG 预览略有差异。

收口同步 `origin/develop` 的 `9d78508`（项目/工作区导航更新，与本包源码无冲突），只补生产构建、受影响 PPT 用例与宿主集成验证；格式引擎和浏览器验收结果按未变更范围复用。

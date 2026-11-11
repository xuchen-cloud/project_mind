# WP09：当前文档与工程规则修复

## 范围与验收

本包来源于固定基线 `ca8ecfc4806ac0c9ce3736a97bd9de556717ab71` 的审查发现 DOC-01、DOC-02、STD-01，以及工作包 WP09。相关产品 Issue 为 [#118](https://github.com/xuchen-cloud/project_mind/issues/118)，已有文档路径问题由 [#187](https://github.com/xuchen-cloud/project_mind/issues/187) 跟踪；本包不据此关闭父 Issue。

- 依赖：现行 HTML WebView 规格、ADR-0011、Agent bridge 实现、已合并基线和既有动效规则。
- 交付：README/产品与 Agent 说明反映实际 HTML、凭据、schema、方法发现和 grant 契约；当前操作命令可用于其他 checkout；路径和 UI 规则有通过基线及有效负例。
- 非目标：改变 HTML 或凭据安全模型、Todo 组件、根依赖/lock、pinned vendor、发布和合并，以及删除或改写历史证据。
- 验收：HTML/凭据说明与当前实现一致；历史/上游/生成材料分类明确，当前路径新增违规仍失败；合法 1.1 秒 caret 周期保留，普通长动画及缺失 reduced-motion 仍失败。
- 验证范围：文档 diff、相对链接与实现对照；两条标准检查；路径/动效定向正负例；caret CSS 的周期与 reduced-motion 定向验证。不运行整应用构建或无关全量测试。

## 修复前证据

在上述固定提交、独立工作目录中，两条检查均 exit 1。UI 检查只报告 `rich-editor-caret-blink 1.1s step-end infinite` 的 raw/long 两项；按 tracked Markdown 复核路径规则为 373 文件、375 条命中、48 个文件。命中数量不等于产品缺陷数量。

原 checkout 存在用户改动，所有本包修改在隔离分支进行；修改前确认没有 Tauri/Vite 自动重启进程。原有 Windows、跨窗口、真实 Provider、Office 绘制与性能验收缺口不属于本包通过结论。

## 验证结果

### 交付

- README、产品基线和 Agent README 对齐原始 JS/CSS、联网/HTTP(S) 导航、局部资源授权、历史依赖限制及 FileCredentialStore；schema 与方法清单改为链接实际代码来源，新建 grant 与旧对象限制 grant 分开说明。
- 两份当前 harness 操作说明使用仓库相对命令、PATH Node 和明确路径变量，移除个人 checkout 与仓库外的私有锁脚本；串行协调要求和既有验收范围保留。
- 路径检查覆盖 tracked 与未忽略的新 Markdown，明确排除根 `.full-review/` 生成报告和 Git 忽略的依赖/构建物；已跟踪文件即使位于被忽略目录仍受检查。47 个文件的 270 条原始行以固定基线行号、整行 SHA-256、出现次数和分类保留。原始规则仍有 369 次命中，其中历史/协议/上游原文保持不动；当前命令修正了原基线中的 6 次命中。检查通过不表示历史路径可用于当前机器。
- `--rhythm-caret-blink: 1.1s` 保留原节奏，仅在实际样式文件、caret selector、对应 opacity 关键帧、`step-end infinite` 与 reduced-motion 契约下允许；普通长动画和将此 token 用于其他 transition 继续失败。

### 命令与证据

使用本机现有依赖（Node `26.8.1`、Vitest `4.1.2`），没有安装或修改依赖。以下针对最终代码改动树；规则文件及 CSS 在通过后未再修改。完整日志和截图保存在 [WP09 验证目录](../technical/review-wp09-20261111/)。

| 范围 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 规则定向回归 | `node node_modules/vitest/vitest.mjs run --config scripts/rules.vitest.config.mjs --maxWorkers=1` | **58/58 通过**，见 [final log](../technical/review-wp09-20261111/rules-final.log) |
| UI 标准 | `node scripts/check-ui-standards.mjs` | **通过**，见 [log](../technical/review-wp09-20261111/ui-final.log) |
| 文档路径标准 | `node scripts/check-portable-paths.mjs` | **通过**，见 [log](../technical/review-wp09-20261111/portable-final.log) |
| 文档 | diff、当前实现/ADR 对照、64 个相对链接目标存在性检查 | **通过**；不覆盖外部链接与所有标题锚点 |
| 差异空白 | `git diff --check` | **通过** |
| caret CSS 浏览器验收 | 独立无界面 Chromium 页面加载实际 `:root` 和 caret CSS 片段；正常/降低动态效果两种媒体状态 | **通过**：1.1 秒、`steps(1)`、infinite；100/800/1200ms 的 opacity 为 1/0/1；reduced 为 animation none、opacity 1，宽 1px。[结果](../technical/review-wp09-20261111/caret-browser.log)、[正常截图](../technical/review-wp09-20261111/caret-normal.png)、[reduced 截图](../technical/review-wp09-20261111/caret-reduced.png) |

负例包括普通 400ms/1s 动画、literal 长 caret duration、错误 selector/keyframe/节奏/easing/循环、transform 关键帧、缺少或不匹配的 reduced-motion、token 用于普通 transition；路径覆盖新增、改变、重复或移至其他文件的路径、tracked 与 untracked 当前说明，以及被忽略目录中的已跟踪来源。

修复前两条检查失败日志保留：[UI](../technical/review-wp09-20261111/baseline-ui.log)、[路径](../technical/review-wp09-20261111/baseline-portable.log)。首次新增规则用例为 57 通过、1 失败：实际样式开头的 `@import` 导致原解析器漏掉 `:root`，修正 statement at-rule 解析后相关 32 项通过；最终独立配置集中执行 58/58。首次 reduced 截图空白而计算样式断言已通过，改为文件夹具并等待两帧后重新截图，最终视觉复核正常。这些是修复过程中的规则/验收夹具问题，不作为产品通过证据。

### Standards / Spec 自查

主 agent 分别完成两轴自查，未启动 review 子 agent。

- **Standards：0 个剩余发现。** 原文历史与 pinned vendor 没有修改；例外按文件/整行/次数约束，没有目录级历史豁免；新增当前说明仍失败。凭据和 HTML 只改描述；没有新兼容框架、root package/lock 改动或窗口启动。规则回归使用现有可观察 collector/CLI 接口及临时真实 Git 仓库，不依赖旧提交对象在浅克隆中存在。
- **Spec：0 个剩余发现。** DOC-01、DOC-02、STD-01 交付及工作包负例均覆盖；原 1.1 秒节奏和 reduced-motion 保留。遵循 Codebase Design 补充的 WP09 局部范围，没有新增架构前置或扩张重构。

**未执行：** 整应用构建、Rust/前端全量、完整编辑器/WebKit/原生 GUI、Windows、跨窗口、真实 Provider、Office 格式/绘制与性能矩阵。本次 CSS 片段验收不能替代这些平台或产品验收。没有推送、合并、部署或关闭 Issue。可选根 npm 脚本接入留给集成负责人，当前已有稳定独立规则配置可直接运行。

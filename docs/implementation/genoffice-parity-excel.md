# GenOffice Excel 完整编辑移植（#191 / #118）

## 工作包与验收

- 子 Issue #191，父 #118。固定官方 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`，完整 Sheets renderer/App、create-univer、visual/dialog/actions 保持官方来源。
- 只改 `packages/office-xlsx/**`、`src/components/office/XlsxEditor*`、本文。File/CAS/宿主/native 由主 agent 负责。
- 依赖：本包 native sidecar、完整 gateway、OSS Univer 0.25.1、React；包内锁依赖，不需要根依赖。固定 fork `Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4` 的 Web shim；不使用任意路径 relay。
- 交付：原 XLSX → 真实完整 renderer 选中/输入/粘贴/拖动/缩放/工具栏 → 官方 typed journal → 修改原 OOXML → 原 XLSX 保存重开；保留 `registerBeforeSave` / `onPendingChange`。
- 非目标仅独立 App 文件管理、更新和重复 AI 聊天；不排除上游编辑器功能。
- 验收 seam：真实编辑器用户操作、包 `inspect/edit` 对真实 XLSX 字节保存重开。TDD 逐项红绿。只运行包定向验证，不启动可见 App、Tauri watch 或根全量构建/测试。

## 当前真实状态（2026-10-18 本轮冻结，已 stage / 原生整合通过）

完整官方 **App 已能在局部 iframe 运行**，生产入口为完整 renderer。真实文字、加粗、新柱状图、新表格都已通过原 XLSX 保存重开；CSV 导出、分页打印 HTML 宿主回调和只读原生公式计算已分别通过。末轮已修 native PDF 暴露的默认打印范围裁剪、首次 ready 尚未完成时 beforeSave 挂起，以及native验收暴露的运行期sessionId泄入快照；下述最新证据优先于旧 callback-only 结论。

**本轮定向回归已收口并按主要求冻结；#191 未完成全部功能组/实机验收，不应关闭。** 顶部 CSV/打印已修复宽度；窄屏解除上游独立窗口的 720px 最小宽度，QAT/页签可横向访问，保留连续方向遮罩。主已目视当前 full-renderer.png 确认顶栏重叠修复。

10月18日最新通信修复版 **6/6 通过**，日志 `tests/output/channel-regression-20261018.log`：Chromium/WebKit 完整长合同、PDF 等待/取消及混合纸张、打印、50k+真实存储格长表 ready/只读 native fallback/原件保存。WebKit 的真实问题是异步窗口 reply 的 event.source 与 iframe.contentWindow 不相等；保留严格初始窗口握手，之后改专属 MessageChannel（替换/销毁关闭旧 port）。使用现有匹配 WebKit2336、打包 Node24，无浏览器下载。

图片/形状、byte gateway、计算查询 **18/18 通过**，见下方命令。当前页尺寸来自官方每页实际有向尺寸，Legal 横向1008×612pt、跨 sheet Legal/A5 连续分组后保持原页序，PDF 各组等待 native bytes 再合为一次导出；包内锁定 MIT pdf-lib@1.17.1，无需根依赖。混合尺寸仍是 callback 证据；Legal 原生 WK/AppKit 的真实图表/图片输出现已有包侧及主目视证据，见“末轮打印与首次 ready 修复”。

**外部工作簿合并 callback 已接线，Chromium/WebKit 真实保存重开与 picker 取消 2/2 通过**：主已提供 `onInspectImportedWorkbook(bytes):Promise<Model>` 真实 data-only native/service。复用官方合并 UI，用户选择 bytes 后创建独立临时只读 Model/session，按 session 路由范围/公式/媒体/透视读取，合并结束释放。目标 journal/CAS 一次保存。已修固定上游列宽参数不匹配、合并行高多余舍入、显式字体继承 minor 绑定的真实红例（精确构建转换/patch SHA 可重建）。验收为真实 picker→源值/样式/合并/行高列宽→原件保存重开；上游合并明确仅缓存值（公式转值），不导入表格/图片/图表对象，这是上游现有范围，不能报告为对象合并完成。

最新主题/透视/迷你图/保护组合 UI 保存重开 **1/1 通过**；结构变化与新 sheet 表格/透视的两阶段保存红例已修，按保存后工作表身份重映射延后对象。当前 engine/parity **19/19 通过**，含稳定快照身份两项红绿。截图纯 DTO `ScreenSourcesResult` / `ScreenCaptureResult` 与两项 callback 已公开，选择来源→PNG→原件保存 fixture 通过；实际 native 采集尚未验收。

主已同步最新 XLSX dist、重新生成整个分发 manifest 并 re-stage 通过；复用已编译 native test binary，仅重跑原失败 `office_real_formats_native_save_reopen_and_retained_history`，**1/1 通过，4.54s，1250 filtered**。固定源 DOCX/XLSX/PPT 的真实保存、完整 Model reinspect 深相等、历史版本，以及本项内 XLSX IronCalc/导入路径均已通过；未放宽 native 断言。本包只读取结果并记录，未重复运行该项。

包 build/typecheck 与本轮定向验收已结束，没有仍在改动/构建/测试的 Excel 进程。未运行根构建/native 编译或可见 App。历史局部 presets UI 证据不能代替当前完整 App 验收。

## 架构与可重建来源

- `scripts/pin-renderer.mjs <固定官方源码目录>` 收集完整 renderer/shared、workspace 闭包；`upstream.json` 固定 Git blob，`source.mjs` 构建前校验。局部 bridge 在 `build-renderer.mjs` 做精确可验证转换；gateway 与 `print-html.ts` 的必要补丁以 `patches.json` 固定 SHA/原文变换，可从固定官方源重建。
- fork bridge、node-shims、control、web-xlsx/media/config 与 LICENSE 逐项 SHA-256 锁在 `fork-source-lock.json`；实际复用 Node 浏览器 shim。该 commit 没有用户提到的 `web-sheets-control.ts`（404），实际为 `control.ts`。采用官方 parser/native 生成 Model，未切换保存基线。
- `inspect` 提供完整只读 WorkbookFile、公式、行轮廓、媒体、透视源；不暴露临时文件路径。完整 App 的惰性读取通过此 snapshot，现阶段无需宿主任意路径 query。
- 保存复用官方 `handleSave(...,'recovery')` 整理全部 typed journal，不提前清脏或宣称写入成功；父宿主 beforeSave 提交后，由原 File/gateway/CAS 决定成功并传新基线。
- 上游保存限制需要分阶段的结构/表格/透视/名称，先写临时 candidate 再写下一阶段，最终 bytes 一次返回 CAS；保存后用最终 sheet 名称重映射 gateway 的位置 ID，支持新增/重排 sheet 上的表格、透视及透视源，不向业务层暴露中间文件。
- Apache-2.0、fork license、npm/native notices、Carlito OFL 保留。iframe 自包含 JS/CSS/font/image，无运行时源码下载。App 从超大 srcdoc 属性换为本地 Blob URL，替换/销毁时回收，避免浏览器调试预览反复复制约38MB HTML；当前 Chromium/WebKit 公共合同已通过。

## 功能矩阵（接入与验收分别记录）

| 上游功能 | 完整 renderer 当前接入 | 真实证据与剩余差距 |
| --- | --- | --- |
| 选中、输入、公式栏、pending、beforeSave、只读 | 官方 App/create-univer 与命令守卫，React 合同保留；真实内容变化才 pending | 完整 Chromium 长合同通过：输入/提交/只读/rebase/Escape/dirty remount；快捷保存真实字节通过。WebKit2336 完整长合同当前通信修复版通过 |
| 格式、富文本、撤销重做 | 完整官方工具栏、格式弹层、日志/undo | 当前官方加粗保存重开通过；API 字号、填充、边框、富文本及未触及 parts 既有通过；更多 UI 验收未逐项完成 |
| 公式、名称、跨表、计算模式 | 官方 Univer 计算、typed 数值/文本/布尔/错误缓存，名称/计算 UI 全部纳入 | 历史文本 IF/TRUE 重开通过；当前完整 Chromium IF 文本、TRUE 布尔公式保存重开通过。`onRecalculate`/`engine.recalculate(bytes,{edits,reads})` 已实现，真实 native 35/30 结果与原件未变通过；主已接原 File/hash 的只读 worker并报告整合 host17项通过；长表真实 UI fallback→保存重开已通过 |
| 行列、合并、冻结、轮廓 | 官方结构/菜单/自动行高、结构 journal 全量纳入 | API 插行/公式/中文/行高列宽/空白合并通过；“插行+新表”保存红绿通过；完整 App 在复制/改名/重排后的工作表插行、跨表公式和原对象保留保存重开通过。未逐项枚举行列/轮廓控件 |
| 外部工作簿合并 | 官方合并 UI/合并器＋真实 bytes inspect callback；独立临时只读 session、释放清理 | Chromium 真实文件 picker→源值/样式/合并/行高列宽→保留目标草稿/对象并一次保存重开通过；公式按上游转缓存值，源表格/图片/图表按上游不导入。Chromium/WebKit 与 picker 取消回归均通过 |
| 工作表结构 | 官方新增/复制/删除/重命名/排序/隐藏/颜色及结构保护 guard | 完整 App 新增、普通工作表复制、改名、排序、隐藏/取消隐藏组合保存重开通过。含图表/图片/表格/批注的 sheet 复制仍被固定上游 gateway 明确拒绝，未算支持；删除/标签颜色单独 UI 未验收 |
| 范围、滚动、缩放、粘贴、拖填/移动 | 官方 grid-growth、clipboard、fill、zoom/页面模式；官方大表按 viewport 加载已接入 | 取消 A1:Z100；全部已用范围按 100k 分块，总矩形 2m，blank 1000×26。完整 App TSV/鼠标拖填/超初始网格/新表保存通过；50k+存储格的 viewport ready→native fallback→远端格保留→原件保存重开通过。宿主 inspect 仍先收集预算内源数据；超过2m矩形的源端按需查询未实现，超过预算明确拒绝 |
| 筛选/排序、CF、验证、批注、名称 | 官方 presets+自定义 UI/actions，原规则转换和保存全部纳入 | 名称管理器添加名称、批注快速输入后离开/保存、插入复选框验证的 UI→原件保存重开通过；既有列表验证与 CF 同次保留。CF 新建/编辑、验证高级规则、筛选排序、批注会话单独 UI 尚未验收 |
| 屏幕截图 | 官方 ScreenshotDialog＋onCaptureScreenSources/onCaptureScreenSource，纯DTO与上游一致 | fixture 来源选择→等待真实回执PNG→插图→原件保存重开且PNG bytes一致1/1通过；实际系统采集/权限由主的native agent实现/验收，未算通过 |
| 图片、图表、形状 | 官方 WorkbookVisuals/visual-actions/形状图库、格式、拖动缩放、图表向量编辑 UI 已纳入；原媒体在 Model 读取 | 原图表/图片在真实画布可见；**新增柱状图保存重开通过**；真实图片 picker、源图片移动/缩放、新形状拖绘及原件保存重开已通过 |
| 表格、透视、迷你图 | 官方全套 UI/dialog/actions 纳入，完整保存 schema/gateway | 新表格真实 UI+保存重开通过；主题/透视字段选择/折线迷你图/保护组合 UI 保存重开通过。新增及重排 sheet 的表格与透视/源跨阶段原件保存 2/2 通过 |
| 页面、打印、PDF/CSV | 官方页面布局/分页/PrintDialog/print-html 纳入 | `onExport/onPrint/onRenderPdf` 真实 UI 回调、等待/取消、混合纸张页序通过。默认范围已按 oneCellAnchor 实际像素尺寸修复；Chromium/WebKit 跨页图形覆盖与明确 Print_Area 裁剪通过。真实 WK/AppKit Legal PDF：100%整列分页2页（尾页9.2pt图框续片），官方 Fit Columns 为1页；标题/双柱/图例/图片目视通过，未改默认缩放。设备打印对话框与 Windows输出仍未实测 |
| 工作表/工作簿保护、允许编辑范围、文档主题 | 官方完整 UI/密码验证/guard、主题及 gateway 纳入 | 实际 UI 设置 Ember 主题、SHA-512 密码/允许行格式权限、工作簿结构保护后保存重开通过；允许编辑范围单独交互尚未验收，不以整张 protected sheet 全局只读代替官方允许操作 |
| 宿主主题、滚动遮罩、reduced-motion | 真实 host token 映射；有界列表连续遮罩与尺寸/内容观察；reduced-motion | 完整 App 1200/560/360px QAT/页签可横向访问，主已目视顶栏修复；未逐项枚举全部弹层；canvas 原命中区域保留 |
| 源件与草稿保真 | 按原 ZIP 保存，草稿带 SDK snapshot+全部 typed journal；运行期 native session 不进入持久快照 | 非编辑 chart/drawing/media payload 既有 API 通过；完整 App dirty remount/公式通过；图片/形状操作组已通过。同字节双 inspect/保存重开稳定 UUIDv8 两项红绿通过；主已 stage 后真实 native all-formats 保存/reinspect完整深相等及历史版本1/1通过 |

## 已执行验证（勿混淆版本）

### 10月18日新增证据与当前未解项

本轮最终汇总（有重叠，不能把分组计数简单相加）：

| 验证 | 当前结果 | 证据 |
| --- | --- | --- |
| `src-tauri/resources/agent-host/node packages/office-xlsx/scripts/build.mjs --skip-native` | 快照身份修复版通过，exit0；完整 renderer/browser/engine、锁源校验和 notices；native 未改，复用 binary | `tests/output/snapshot-identity-build-20261018.log` |
| `npm --prefix packages/office-xlsx run typecheck` | 快照身份修复版通过，exit0 | `tests/output/snapshot-identity-typecheck-20261018.log` |
| 末轮 frame-requests + print-output + pdf-output，`node --test --test-concurrency=2` | 6/6通过，33.71s；含首次pre-ready、失效请求、Chromium/WebKit打印图形覆盖、PDF等待/取消 | `tests/output/print-lifecycle-regression-20261018.log` |
| 末轮 browser，`node --test --test-concurrency=2 packages/office-xlsx/tests/browser.test.mjs` | Chromium/WebKit长保存合同2/2通过，38.20s | `tests/output/print-lifecycle-positive-browser-20261018.log` |
| 打印设置补充，`node --test packages/office-xlsx/tests/print-output.test.mjs` | 2/2通过，19.08s；含真实 Fit Columns 单页与源 Print_Area 裁剪 | `tests/output/print-fit-regression-20261018.log` |
| engine + parity | 最新19/19通过，3.11s；含2项新增同字节深相等/保存重开稳定快照红绿及原17项原件保存 | `tests/output/snapshot-identity-engine-green-20261018.log` |
| 主整合：已编译 native binary，仅重跑 `office_real_formats_native_save_reopen_and_retained_history` | 最新 XLSX dist 同步、分发 manifest 更新并 re-stage 后1/1通过，4.54s，1250 filtered；固定源三格式真实保存、完整Model深相等、历史版本；项内IronCalc/import也通过 | 主提供临时日志 `genoffice-native-real-formats-xlsx-fixed-20261018.log`；本包已只读核实，不重复运行 |
| 前轮帧 IO 正向组：frame-requests、browser、save-request、output、pdf-output、print-output、import-workbooks、capture-screen、recalculate-browser | 12/12通过，54.57s；未改路径复用，重叠路径以末轮结果为准 | `tests/output/final-frame-io-regression-20261018.log` |
| 前轮 beforeSave 跨已完成 ready await 的 epoch 修复后：frame-requests + browser | 当时3/3通过，38.82s；不覆盖首次未完成 ready，末轮已补该红绿 | `tests/output/final-lifecycle-20261018.log` |
| rules-and-notes + worksheet-structure（同组另含frame-requests旧版） | 2项真实 UI 保存重开通过；全组3/3，13.9s | `tests/output/final-boundaries-20261018.log` |
| document-settings | 1/1通过，7.26s；主题/透视/迷你图/密码权限保护 | `tests/output/document-settings-20261018.log` |
| 复用有效结果 | query/visuals 的20k跨批计算与图片/形状保存；完整 App 图表/表格、粘贴/拖填组；相关产品路径本轮未变 | 下方原命令/结果，非旧 presets UI |
| 范围 diff | `git diff --check -- packages/office-xlsx src/components/office/XlsxEditor.tsx docs/implementation/genoffice-parity-excel.md`通过 | 无根全量验证 |

最新实际截图：`tests/output/worksheet-structure.png`、`rules-and-notes.png`、`document-settings.png`、`imported-workbook-chromium.png`、`imported-workbook-webkit.png`。图片、draft、生成 XLSX/PDF及日志在本包忽略的 output 目录；命令、结论和限制保存在本文。

- `src-tauri/resources/agent-host/node --test --test-concurrency=2 packages/office-xlsx/tests/frame-requests.test.mjs packages/office-xlsx/tests/rules-and-notes.test.mjs packages/office-xlsx/tests/worksheet-structure.test.mjs`：**3/3 通过**（13.9s），日志 `tests/output/final-boundaries-20261018.log`。旧 frame 请求在 Model 替换/销毁前已收到、异步执行前失效时，8类 host callback 均不调用；重复 bootstrap 不新增 port。普通 sheet 结构组、名称/批注/验证组均从真实 UI 保存原 XLSX 重开。
- 帧请求真实红例 `tests/output/frame-requests-red-20261018.log` 记录旧请求误调用新 File 的全部8项 callback；现在每次请求捕获 epoch 和 callback，在 host IO 前检查，回执绑定原 port。窗口层仅接受初始握手及握手前错误。
- 同边界 beforeSave 红例 `tests/output/stale-commit-red-20261018.log` 记录 `commitEditing()` 已调用、跨 ready await 后替换 Model 会挂起。现在 await 前捕获 epoch、之后检查，旧提交明确拒绝；最终生命周期组3/3通过。
- 批注快速输入后立即离开/保存的红例 `tests/output/note-quick-save-red-20261018.log`：旧 Univer 300ms debounce 未及时落入 journal，保存未写 comments。固定依赖精确构建 patch 将批注更新同步入日志；当前真实 comments XML 内容/位置验收已通过。

- 新增/重排 sheet 的表格和透视保存红例：旧实现明确拒绝新 sheet 延后对象，旧位置 ID 在重排后也失效。现在两阶段按最终 sheet 身份重映射，原件一次保存重开 **2/2 通过**；日志 `tests/output/staged-pivot-20261018.log`。完整受影响 `src-tauri/resources/agent-host/node --test --test-concurrency=2 packages/office-xlsx/tests/engine.test.mjs packages/office-xlsx/tests/parity.test.mjs` **17/17 通过**（3.53s），日志 `tests/output/staged-save-regression-20261018.log`。
- `src-tauri/resources/agent-host/node --test packages/office-xlsx/tests/document-settings.test.mjs`：**1/1 通过**（7.26s），日志 `tests/output/document-settings-20261018.log`。完整官方 UI 操作实际主题、透视创建/字段选择、迷你图、密码和权限保护；原件保存后 inspect/native XML 验证，不用按钮存在代替功能。

- `src-tauri/resources/agent-host/node --test --test-concurrency=2 packages/office-xlsx/tests/query.test.mjs packages/office-xlsx/tests/engine.test.mjs packages/office-xlsx/tests/parity.test.mjs packages/office-xlsx/tests/recalculate-browser.test.mjs packages/office-xlsx/tests/visuals.test.mjs`：**18/18 通过**，11.9s，日志 `tests/output/native-visual-regression-20261018.log`。包含 50k 以上真实存储格的流式工作簿 UI 输入→真实 readonly native 计算→原件保存重开、源图移动/缩放、新图片、鼠标拖绘形状。gateway 未编辑图表/媒体保留仍通过。
- 长表红例还定位到 native 每请求最多20k读格，已在 JS 包内按20k分批、每批保留同一输入集合，复用真正 native model；不改 Rust、不放宽预算。公开100k总读预算与保存2m矩形预算保持，新增跨20k只读结果用例通过。
- 当前纸张几何版本的 PDF callback **2/2 通过**（7.1s + 6.5s），打印 callback **1/1 通过**（6.1s）：Legal 横向1008×612pt、跨 sheet Legal/A5页序与合成 PDF 的每页尺寸、等待与取消无 anchor。此结果只证明包回调，真实 WKWebView/WebView2 PDF 由主验收。
- `npm --prefix packages/office-xlsx run typecheck`：**通过**，包含 pageSize 公开类型及计算分批实现。
- MessageChannel 通信修复后 `src-tauri/resources/agent-host/node --test --test-concurrency=2 packages/office-xlsx/tests/browser.test.mjs packages/office-xlsx/tests/pdf-output.test.mjs packages/office-xlsx/tests/print-output.test.mjs packages/office-xlsx/tests/recalculate-browser.test.mjs`：**6/6 通过**，49.7s；日志 `tests/output/channel-regression-20261018.log`。Chromium/WebKit 长合同、native callback 等待/取消、混合尺寸和长表真实计算/保存全部通过。已移除临时窗口 message 诊断。无诊断再次运行 WebKit+CSV+快捷保存 **3/3 通过**（19.6s），日志 `tests/output/channel-final-20261018.log`。

- 导入新增字体修复后的 `src-tauri/resources/agent-host/node --test --test-concurrency=2 packages/office-xlsx/tests/engine.test.mjs packages/office-xlsx/tests/parity.test.mjs`：**15/15 通过**（3.46s）；日志 `tests/output/font-save-regression-20261018.log`。新字体 patch 反向恢复后与固定官方 Git blob 完全一致。

- `src-tauri/resources/agent-host/node --test --test-concurrency=2 packages/office-xlsx/tests/import-workbooks.test.mjs packages/office-xlsx/tests/capture-screen.test.mjs`：**3/3通过**，12.1s；日志 `tests/output/import-capture-20261018.log`。Chromium/WebKit各一次真实picker取消+独立源导入+目标一次保存，样式/32pt行高/列宽/合并/目标已有草稿与媒体保留；截图fixture等待PNG回执后保存且bytes一致。没有实际屏幕采集。
- 同一版本 `npm --prefix packages/office-xlsx run typecheck`、`node packages/office-xlsx/scripts/build.mjs --skip-native` 均通过，包含三项新callback、纯DTO导出、MessageChannel、固定上游样式/合并补丁。

### 当前完整 renderer

- `node packages/office-xlsx/scripts/build.mjs --skip-native`：通过，完整 renderer+engine/browser+声明+notices；复用未修改的 native binary。
- `node --test packages/office-xlsx/tests/full-renderer.test.mjs packages/office-xlsx/tests/print-output.test.mjs`：**2/2 通过**（加入本次顶部布局红例前）；文本/加粗/新图表/新表格实际 XLSX 保存重开、打印按钮等待回调、官方分页内容与 data 字体/图片，无编辑控件。输出 print HTML 约 11 MiB。
- `node --test packages/office-xlsx/tests/output.test.mjs`：**1/1 通过**；CSV UTF-8 BOM 字节、等待、true/false 取消、无 anchor 下载。
- `node --test packages/office-xlsx/tests/query.test.mjs`：**1/1 通过**；只读 native 改输入 B3=15 计算 B5=35/B7=30，源 bytes/hash/值未变，错误 sheet 与预算拒绝。
- `node --test packages/office-xlsx/tests/engine.test.mjs packages/office-xlsx/tests/parity.test.mjs`：新增两项跨阶段身份用例前 **15/15 通过**；当前19项结果见10月18日记录。
- `node --test packages/office-xlsx/tests/browser.test.mjs packages/office-xlsx/tests/save-request.test.mjs`：快捷键实际触发原 File edit 保存成功 **1/1 通过**。之后 `node --test --test-name-pattern=Chromium packages/office-xlsx/tests/browser.test.mjs` **1/1 通过**（70.4s）；原 rebase pending 的同步断言改为等待跨 frame 回调，内容仍未提交，未放松保存断言。WebKit后续当前验证见10月18日记录。
- `node --test packages/office-xlsx/tests/parity-browser.test.mjs`：**1/1 通过**（50.4s）；完整 App 原生加粗/clipboard/像素命中真实填充柄/超初始网格/新 sheet，实际原件 edit+inspect。
- `node --test packages/office-xlsx/tests/pdf-output.test.mjs`：**1/1 通过**（43.9s）；官方分页 HTML、data 字体/图片、有效 PDF fixture 字节原样传递、等待、取消不下载。
- `pdfinfo packages/office-xlsx/tests/fixtures/host-output.pdf`：有效 PDF 1.4、1 页、未加密/无脚本，608 bytes；由包内 make-pdf-fixture.mjs 可重建，仅测试 callback 合同，不是产品 PDF 生成器。
- `node --test --test-name-pattern='row shift and' packages/office-xlsx/tests/parity.test.mjs`：**1/1 通过**。红例实际 gateway 拒绝“结构与新表同次保存”；修为官方同等临时 candidate 两阶段，最终只返回一次 bytes，表格 A3:B5 与原数据位置正确。
- 包 typecheck 与无 alias 的公开 DTO 检查此前通过；`generated/desktop-api.ts` gateway 引用已改 vendor 相对路径。最近 bridge 改动后会集中复验。

### 历史局部入口（生产已替换，当前不能复用 UI 通过结论）

- `node --test packages/office-xlsx/tests/engine.test.mjs packages/office-xlsx/tests/parity.test.mjs packages/office-xlsx/tests/browser.test.mjs`：当时 **16/16 通过**（11 engine、3 parity、Chromium/WebKit 各1）。其中 engine 纯字节保存可作基线，新 inspect enrichment 后仍需当前回归。
- `node --test packages/office-xlsx/tests/parity-browser.test.mjs`：当时 **1/1 通过**，真实加粗、系统剪贴板 TSV、鼠标拖填、D1100、新 sheet。已定位 Univer Steady 才有拖填 controller；ready 生命周期修复保留。
- WebKit 可用 `OFFICE_WEBKIT_EXECUTABLE=${OFFICE_WEBKIT_EXECUTABLE} node --test packages/office-xlsx/tests/browser.test.mjs`；无本机绝对命令路径。headless WebKit 不等于 Tauri WKWebView 验收。

## 主整合具体依赖 / 未解问题

1. 根宿主已由主接 `onSaveRequest`/`onExport`/`onPrint`。本包快捷保存实际字节已通过；取消不 anchor 重试。
2. 公开 `onRenderPdf({html,title,pageSize?}):Promise<Uint8Array>`，官方分页 HTML 复用打印生成器，收到有效 PDF bytes 后 `onExport`。主负责 native `desktop_render_editor_pdf`，本包不接路径、不自行写 exports。有效 fixture 仅证明合同；末轮另用主现有隐藏 native helper 生成 Legal 实际 PDF 并目视，不能把此样本扩称所有纸张/平台通过。
3. `onRecalculate`/`recalculate` 包接口保持，主已接 `data={...FileBytesInput,recalculation:{edits,reads}}`，并报告整合 host17项通过（含此前 baseline 保存/异步失效13项），原 File/hash 校验、无 sessionID/path/新版本。max 10k edits、200 reads、总100k读格；真实 engine 只读计算测试已通过。
4. 打印发送官方分页内容，静态 Carlito 四款字体与图片已内嵌验证；运行时 `FontFace` 的本地字体无法从浏览器提取 bytes，具体包括宋体/SimSun/NSimSun、黑体/SimHei、仿宋/FangSong、楷体/KaiTi，及默认 PingFang SC、日/韩/繁中字库。隔离打印文档仍依赖系统安装字体，不能宣称所有字库自包含；不能将 headless 打印算 WKWebView 成功。
5. 屏幕/窗口截图公开 `ScreenSourcesResult` / `ScreenCaptureRequest` / `ScreenCaptureResult`，与官方纯 DTO 相同。仅当前选择器临时 ID，上游约20MiB 图片预算，无文件路径。主报告 desktopApi/capture adapter2项、native capture8项、共享tsc及 Windows模块检查通过。本包两 callback、官方来源选择器→PNG→原件保存重开 fixture通过；未实际采集屏幕或弹权限。不能把单元测试或常量 denied 算实机采集验收。
6. 主已提供并接好外部 bytes inspect（主报告15 host tests）；本包只传选择的 bytes、限制64MiB且固定xlsx。服务100MiB为外层上限，原包64MiB/2m矩形预算保持。
7. 本轮完整 App 浏览器合同已收口，暂冻结供主 stage/build；下列未验收功能与平台项仍保留，#191 不应关闭。移除只属于独立 App 文件管理的另存为 QAT；仍保留宿主 XLSX 保存和真实内容导出。

## 剩余项分类（不是全部视为未实现）

### 已知实现边界 / 固定上游限制

- 宿主 `inspect` 仍完整收集预算内源快照；超过总2m已用矩形的源端按需查询未实现。已实现的官方 renderer viewport 模式与50k+ ready/保存证据不受此描述否定；64MiB源文件、100k单次读格是明确资源预算。
- 隔离打印未提供本地系统 CJK/Office别名字体的实际 font bytes；具体字体见主整合第4项。Carlito与图片已内嵌。
- 固定上游合并器只合并缓存值/样式/合并/尺寸，公式转值，源表格/图片/图表不会导入。目标原对象保留已验证。
- 固定 gateway 的 `xlsx-sheets.ts prepareClonedSheetRels` 明确拒绝复制带图表/图片/表格/批注等关系的 sheet；真实 UI 复制复杂源后保存已复现此拒绝，未将它算完成或放松保存。普通 sheet复制保存已通过。官方 `workbook-ops.ts applyAiPivotAdd` 仍阻止在未保存的新 sheet 上通过 UI 新建透视；包 API 的新 sheet透视保存已修复，两者不能混报为同一覆盖。

### 已接入但尚未完成单独 UI 保存验收

- CF新增/编辑、验证高级规则、筛选/排序、threaded comments、允许编辑范围；名称添加、legacy note及复选框验证已验收。
- 删除工作表/标签颜色、部分行列/轮廓/尺寸菜单，以及图表/形状更多格式变体；完整renderer代码均已纳入，当前只按矩阵实际操作组声明通过。

### 仅缺实机 / 平台输出验收

- Tauri 全流程和真实设备打印对话框/纸张输出、更多纸张和系统字体组合、真实系统截图权限及PNG采集仍未实测。Legal WK/AppKit PDF图表/中文/图片与官方Fit Columns已实际生成目视通过；该样本不等于所有平台输出通过。主报告 native/adapter/host编译及测试不等于实际采集或打印。
- 用户无 Windows 测试机。主报告 Windows模块检查通过；本包未声明 Windows实测。

## 变更文件索引

- 完整 renderer 与来源：`vendor/apps/sheets/**`、闭包 `vendor/packages/**`，精确清单在 `upstream.json`；`fork-research/**`、`fork-source-lock.json`、`patches.json`；三处固定gateway补丁所在 `xlsx-structure.ts` / `xlsx-styles.ts`。
- 包接入：`engine.ts`、`types.ts`、`gateway-contract.ts`、`editor-journal.ts`、`file-decorations.ts`、`browser.ts` / `browser.d.mts` / `browser.css`、`frame-browser.ts`、`renderer-entry.ts`、`renderer-host.ts`、`renderer-channel.ts`、`renderer-output.ts`、`renderer.css`、`scroll-masks.ts`、`generated/desktop-api.ts` / `generated/save-workbook.ts`。
- 构建/依赖/来源：`scripts/build.mjs` / `build-renderer.mjs` / `extract-upstream.mjs` / `pin-renderer.mjs` / `patch-univer.mjs` / `source.mjs` / `notices.mjs`、包 `package.json` / `package-lock.json` / `tsconfig.json` / `.gitignore` / `README.md`。根依赖和lock未改。
- 回归：`tests/*.test.mjs`与可重建 `tests/fixtures/host-output.pdf` / `make-pdf-fixture.mjs`；本轮新增 `frame-requests`、`rules-and-notes`、`worksheet-structure`、`document-settings`、`import-workbooks`、`capture-screen` 等；结果见上表。
- React合同：`src/components/office/XlsxEditor.tsx`；文档为本文。未修改主负责宿主、服务、共享DTO或Rust文件，无git提交/重置。

## 末轮打印与首次 ready 修复（已冻结）

本轮追加仅涉及 `frame-browser.ts`、`vendor/apps/sheets/src/renderer/print-html.ts`、`patches.json`、`tests/frame-requests.test.mjs`、`tests/print-output.test.mjs` 及其构建产物。package source/dist 已冻结供主统一 build/stage；以下记录不触发再次构建。

### 原生打印裁剪的来源与实际输出

- **源设置证据**：`tests/fixtures/complex.original.xlsx` 的 `xl/workbook.xml` 是空 `<definedNames/>`，没有 `_xlnm.Print_Area`；`sheet1.xml` 没有 `<pageSetup>`，只有空 `<pageSetUpPr/>`。原页边距左右0.75in、上下1in。`print-settings.ts resolveEffectivePageSetup` 因而解析为 `printAreas:[]`、`scale:100`、`fitToPage:false`；`PrintDialog.initialSettings` 对应 `scaling:'none'`。测试只先选择横向与 Legal，未设置缩放或手动分页。这个100%并非为了验收临时编造的设置。
- **失败原因**：源图表为 `oneCellAnchor`，从E2开始，ext为5400000×2700000 EMU；右下坐标由跨格 offset 表示，`toColumn` 仍可能等于起点列。上游 `usedArea` 只取 `toColumn/toRow`，导致 `.ov` 仅500pt宽，图表实际 `left:448pt;width:425.2pt`。纸面从x502到约554pt后被裁，图片也被截断。不是 native SVG/use 丢失，也不是源用户有意指定的 printArea。
- **修复**：仅在默认 used area 分支，沿实际可见行高/列宽将图形 offset＋像素宽高折算为完整范围；沿用官方分页/页边距/缩放与50k打印格预算。用户明确的 Print_Area 和 Print Selection 仍走原分支。`patches.json` 固定原文变换和补丁SHA，未改变上游来源commit。
- **失败对照保留**：`tests/output/print-document-before-geometry-fix-7318ed85.html`，SHA256 `7318ed85976654bbd94ce81c5f0a77f072bf8445239122ddc96c33f74eaf1763`。新增真实XLSX定义名 `'明细'!$A$1:$E$18` 后输出 `print-explicit-area.html` 的SHA与此完全相同，证实修复后明确区域仍有意裁剪，而原fixture并没有该区域设置。
- **最新正式HTML**：`tests/output/print-document.html`，SHA256 `76fc8748f6c3be6b9d9dc32f332040a63a8ab822b4aeab3e11d163320377cc26`。完整App真实打印操作后，Chromium/WebKit均检查实际打印DOM的图形可见面积之和，跨页不漏图；不再仅断言callback含`img`。
- **实际 WK/AppKit 对照已检查**：复用主已编译的隐藏 `src-tauri/target/debug/examples/editor_pdf_verify`，没有Cargo构建/可见窗口。`tests/output/native-print-final-20261018/fixture-2.pdf` 为37220bytes，2页，每页1008×612pt；`default-1.png` 与 `default-2.png` 均已目视。第一页标题、两柱、坐标轴、图例及下方图片正常；主也独立消费该SHA并目视通过。
- **第二页不是多余空白**：默认范围扩到M列，总宽916pt；Legal可用宽为900pt。`print-paginate.ts bandIndices` 按整列分页，不拆列：A:L为864pt，M为52pt。`print-html.ts` 第二片 `.ov` 宽52pt，图表 `left:-416pt;width:425.2pt`，故余9.2pt右边框在第二页；纸面约x54～63pt可见，PDFKit无文字符合该续片内容。保留100%与真实对象续页，不全局强制fit、不吞页。
- **明确选择 Fit Columns 的单页证据**：通过实际 PrintDialog 的 `columns` 设置生成 `print-fit-columns.html`；官方fit宽1页、高自动。相同native helper输出 `tests/output/native-print-fit-20261018/fixture-2.pdf` 为35994bytes，1页1008×612pt；`fit-1.png` 已目视完整图表/图例/图片。这个单页属于用户选择的设置，不替代默认100%语义。

可移植重放命令（helper由主预先编译；本包没有重复native构建）：

```sh
src-tauri/target/debug/examples/editor_pdf_verify \
  packages/office-xlsx/tests/output/native-print-final-20261018 \
  1008x612:packages/office-xlsx/tests/output/print-document.html \
  1008x612:packages/office-xlsx/tests/output/print-explicit-area.html
src-tauri/target/debug/examples/editor_pdf_verify \
  packages/office-xlsx/tests/output/native-print-fit-20261018 \
  1008x612:packages/office-xlsx/tests/output/print-fit-columns.html
```

这里只证明此macOS真实输出样本；未宣称设备打印对话框、全部字体/纸张或Windows实测。

### 首次未 ready 的 beforeSave

前轮3/3只覆盖ready已完成后跨await的epoch变化，**没有覆盖首次ready尚未完成**。新增精确红例在同步mount后立即调用公开`ready`/`commitEditing`，不等待iframe bootstrap，随后同步replace/dispose。旧实现两Promise持续waiting，见 `tests/output/pre-ready-red-20261018.log`。

现在 `start()` 在新建ready前拒绝旧ready（首mount用可空reject处理），`dispose()` 也拒绝ready；创建Promise时附观察catch，返回的原Promise仍向调用方拒绝，未被改成成功。红例转绿，包含无人观察ready就replace/dispose不产生未处理拒绝。原8类host请求epoch/callback快照和一次bootstrap规则保持。最终6项合同与2项长保存合同结果见上表；不把前轮不足覆盖写成早已验证。

## 原生 saved/reopened 快照身份修复（#191，已重新冻结）

依赖主已构建的native sidecar，复用现有release binary；不改native断言、schema或根接线。主真实all-formats失败日志逐字段比较仅 `rendererData.file.sessionId` 不同，其余Model包括源SHA完全相同。目标是同源bytes inspect深相等、保存后重复inspect稳定，且renderer所需UUID键仍存在；native查询必须继续使用真实 `metadata.sessionId`。非目标为>2m接入和任何其他编辑器功能变更。验证范围仅新增engine红绿、engine/parity相关字节测试、本包build/typecheck（skip-native），不运行根测试或重新编译sidecar。

- 已核实 `renderer-host.ts` 中该字段仅为内存snapshot路由/断言键；范围/公式/轮廓/媒体查询从本Model读取，计算桥剥离此键，reopen返回同snapshot。外部合并源仍分配独立临时UUID。真实sidecar调用均持有private `metadata.sessionId`，不会把snapshot身份交给native session表。
- `workbookFileSchema` 与各请求schema要求合法UUID，不能使用字面`snapshot-<sha>`或删除字段。`engine.ts snapshotIdentity` 将源SHA256的128bit前缀标记为确定性UUIDv8；完整256bit SHA仍保留在file.sha256中。该UUID是内容身份，不是File权限或native capability；原File/epoch/CAS边界保持。
- `tests/engine.test.mjs` 新增两项：同一bytes双inspect完整Model深相等并验证required UUID；实际保存中文/数字/公式后双inspect仍深相等，且变更bytes的snapshot身份改变、跨表公式值为40。先红2/2（仅sessionId随机不同），再绿；未删任何Model字段或放宽native比较。
- `node --test --test-name-pattern='deeply equal snapshots|reinspects to a stable snapshot' packages/office-xlsx/tests/engine.test.mjs` 记录红例：`tests/output/snapshot-identity-red-20261018.log`。修复后 `node --test --test-concurrency=2 packages/office-xlsx/tests/engine.test.mjs packages/office-xlsx/tests/parity.test.mjs` **19/19通过，3.11s**，见 `snapshot-identity-engine-green-20261018.log`。
- 本包 `build.mjs --skip-native` 与typecheck均exit0，未重编sidecar、未跑根测试或重复浏览器验收。source/dist已重新冻结。主已同步dist、更新整个分发manifest并re-stage，复用已编译native binary只重跑原all-formats失败项，**1/1通过，4.54s，1250 filtered**；包侧只读核实其日志。原完整Model深相等和历史版本断言保持，项内IronCalc/import路径也已实际通过。

## 下一包契约：超过2m矩形的源端按需查询（只读核实，尚未实施）

### 关联、交付与边界

- 继续关联#191 / 父#118。依赖主的原File/hash权限核验、OfficeUtility/worker命令接线；本包负责Model覆盖状态、公开query/props、iframe路由与官方renderer接入。当前不修改根文件、package source/dist或这些接口。
- 交付：合法稀疏大sheet无需密集预载即可打开、定位远端格、输入/结构操作；journal按原XLSX一次CAS保存并可重开，未显示对象保持。超过2m的矩形面积不等于有2m实际存储格，不应继续把它当统一编辑器打开上限。
- 非目标仍仅独立App管理/更新/重复AI聊天。计算/打印/排序各自真实资源预算继续明确保留；不以删除所有预算、把未读区域当空白或绕过原File保存来解锁大表。

### 当前阻断路径、预算与实际调用

1. `engine.ts inspect` 在native `open` 获得metadata后，先将所有 `rowCount*columnCount` 求和；超过2m即抛 `Workbook used area exceeds the 2000000-cell editor budget`，尚未开始100k分块读取。它限制的是矩形而非storedCellCount。
2. 现 `renderer-host.ts sourceRange` 只过滤预载 `Model.ranges`，并固定返回 `indexingComplete:true`；`readWorkbookFormulas/RowOutline` 只返回预载inventory。**今天完整快照使其成立，partial Model直接套用则会把未读格伪装为空白。** 当前50k+流式ready证据属于renderer按viewport消费完整源快照，不能当作>2m源查询已实现。
3. 值保存还有第二处阻断：typed gateway写值、结构或sheet变更且无`formulaValues`时，会进入`recalculateCandidate`。它在检查是否存在公式前就对全矩形设2m门槛。legacy scalar保存也有同门槛。因此只改inspect或只接query仍不能完成大表原件保存。格式类无需重算的保存不能混称值保存已通过。
4. 已有公开 `loadRange(bytes,sheetId,area,context)` **不含全工作簿2m门槛**，可以直接复用native读取与schema。它每次通过 `withWorkbook` 创建私有scratch/sidecar/session，最终清理，不暴露路径。单次100k格；源ZIP64MiB；JSONL16MiB；sidecar请求180s。`loadedRange` 目前等待整个sheet索引完成，独立5s截止，不能直接宣称它已经支持官方部分索引轮询。
5. 主现有inspect/recalculate的File/hash/只读worker模式可复用权限与源bytes边界；当前没有已接通的范围/公式inventory/outline query宿主命令。native内部已有 `Engine.read_range/read_formula_cells/read_row_outline` 与session对象，不需要重新写XLSX解析器。

### 固定上游 streaming 的精确接口与消费路径

以下均在固定 `vendor/apps/sheets/src`，无需网络或路径relay：

源码定位：协议见 [shared/desktop-api.ts](../../packages/office-xlsx/vendor/apps/sheets/src/shared/desktop-api.ts)，结构坐标映射/90k分块与轮询见 [univer-sync.ts](../../packages/office-xlsx/vendor/apps/sheets/src/renderer/univer-sync.ts)，公式/全载预算判断见 [load-budget.ts](../../packages/office-xlsx/vendor/apps/sheets/src/renderer/load-budget.ts)；当前打开/保存门槛和可复用 `loadRange` 见 [engine.ts](../../packages/office-xlsx/engine.ts)，完整快照假设见 [renderer-host.ts](../../packages/office-xlsx/renderer-host.ts)，底层索引与查询见 [native engine](../../packages/office-xlsx/native/engine/src/lib.rs)。这些是下一包的实际修改/复用位置，本轮均保持冻结。

| 官方接口 | 输入 / 输出 | 必须保留的语义 |
| --- | --- | --- |
| `readWorkbookRange` / `workbookRangeRequestSchema` | `{sessionId,sheetId,range:{startRow,endRow,startColumn,endColumn}}`；输出稀疏cells/rows、merges/hyperlinks、CF/filter/DV/protection/pageSetup/breaks/protectedRanges、`indexedThroughRow:number|null`、`indexingComplete:boolean` | 0-based，正向矩形≤100k；未完成时全sheet装饰项尚未最终返回，空数组不能当最终不存在 |
| `readWorkbookFormulas` | `{sessionId,sheetId}`；`{cells,sharedGroups,indexingComplete,truncated}` | cells/sharedGroups各≤100k；含共享公式组，truncated inventory不能当完整计算闭包 |
| `readWorkbookRowOutline` | 同上输入；`{rows:[{row,level,collapsed?,hidden?}],indexingComplete}` | 行轮廓独立加载；最多XLSX行数，仍受实际响应bytes预算 |

官方主进程 `sheets-main.ts` 先以caller找到所属entry、校验session归属，再调用真实session query并验证结果。这里的原生session能力只可在本地worker内部保留；iframe当前logical snapshot UUID不能直接成为native capability。

官方 `App` 打开后调用 `loadVisibleRange`；`univer-sync.ts readSheetRangeMappedOnce` 以**90k**格分请求，按结构journal把屏幕坐标映回源坐标，复制sheet路由到源sheet。`loadRange` 对未完成索引每250ms轮询并处理旧generation、冻结列、装饰与viewport淘汰；`activateFormulaClosure` 以公式inventory和源范围构建≤50k闭包。native索引按256行写稀疏chunk，读范围等待最多750ms，远于已索引4096行时直接返回已有进度。应复用这些真实路径。

注意两种不同预算：`load-budget.ts` 的公式模式≤50k存储格，并依赖full-load的≤1m值格、≤2m存储格、**≤10m值矩形**；`recalcOverBudgetAtOpen` 的IronCalc fallback矩形上限才是2m。只移除inspect门槛可能让2m～10m稀疏Model仍进入密集preload；partial源需明确选择viewport路径，不能将两者误认为同一预算。

### 最低可实施合同（交下一包确认并实现，不是现有API）

```ts
type WorkbookQuery =
  | {kind:'range';sheetId:string;range:Area}
  | {kind:'formulas';sheetId:string}
  | {kind:'rowOutline';sheetId:string}
// Result为同kind的判别联合，value使用上述官方纯结果schema；不含native sessionId/path。
type WorkbookQueryResult =
  | {kind:'range';value:WorkbookRangeResult}
  | {kind:'formulas';value:WorkbookFormulaCellsResult}
  | {kind:'rowOutline';value:WorkbookRowOutlineResult}

query(bytes:Uint8Array,input:WorkbookQuery,context?:Context):Promise<WorkbookQueryResult>
onQueryWorkbook?: (input:WorkbookQuery)=>Promise<WorkbookQueryResult>
onQueryImportedWorkbook?: (bytes:Uint8Array,input:WorkbookQuery)=>Promise<WorkbookQueryResult>
```

- 当前File命令建议采用 `{...FileBytesInput,query}`，沿用实际归属/hash/只读utility权限核验；不传native session、任意路径或新File版本。导入源使用只含用户已选bytes的data-only query，不借原File handler查询另一个源。主决定最终命令名，本包不伪造根接缝。
- Model需要显式“complete / viewport source”覆盖状态和真实seed范围；已有完整小表保持原路径。未覆盖窗口必须query，完整范围的空格才可视为空白。保留样式、元数据、媒体、透视与页面资源；importedSources按独立逻辑session路由并在释放后清理源bytes/查询状态。
- 最少可先复用 `withWorkbook` 的受控bytes解析、单次query只返回所需范围，避免密集矩形分配；若该操作等待完整索引，必须明确其等待预算与重复索引开销。要保留官方partial-index/poll语义，则需worker内部复用索引session并定义失效/释放，不能每次重开后声称沿用旧进度。两者需按真实大XML的响应时间决定，不能只在2格fixture上宣称性能完成；前端合同无需因此获得session/path权限。
- 继续单次100k读格、XLSX最大行列、64MiB ZIP、16MiB响应等现有预算。公式与outline query按schema返回真实完整/截断标志；旧model/旧epoch查询不调用新File callback，IO后结果只回原port。未知或已释放源明确拒绝。
- 值保存先用完整公式inventory判断是否需要重算：无公式候选不能被无条件全矩形2m门槛阻断。有公式时复用完整、可验证的官方小闭包/typed缓存；原生IronCalc2m预算保留，超预算且未能完成依赖计算时明确报告，不能写旧缓存冒充成功。结构变换后范围映射与新基线重开必须一起验收。

### 当前只读探针与下一包一个真实稀疏验收

已通过一次性 `node --input-type=module` 以现有JSZip从真实fixture修改dimension/sheetData生成probe，没有分配大矩阵：

- `tests/output/sparse-12m-source.xlsx` **5841bytes**，sheet1只有A1和AN300001两个实际cell，矩形12,000,040格；`sparse-query-boundary-20261018.json` 保存结果。
- 当前 `inspect` 按2m打开预算拒绝；当前 `loadRange` 只请求AN300001一格，真实native返回42且`indexingComplete:true`；typed gateway仅改A1值后，真实candidate保存仍被 `Formula save exceeds the 2000000-cell workbook budget` 拒绝。此探针证实两处门槛与可复用读取，不是大表UI/保存已通过。

下一包保留此稀疏尺寸，在真实复杂XLSX中只存近端输入、远端数值和一条引用它的公式，并保留原媒体/图表/样式parts。单个浏览器验收串联：实际打开至ready→名称框定位AN300001并看见源值→改值→滚回近端公式看到更新→公开beforeSave→一次原File/gateway保存→新Model重开再定位远端、验证值/公式/样式和未显示媒体parts。统计query窗口均≤100k、无全矩形seed/preload；fixture不生成300001行数组或12m空格。真实请求替换/销毁与读取预算在已有帧合同边界补一项定向用例即可；不重跑旧preset或无限枚举控件。

**只读调查与下一包契约已完成；>2m query接入、密集preload避免、值保存解锁和上述UI重开验收均未实施。** 主已完成当前版本stage及预算内真实native all-formats验收；该结果不解锁>2m路径。后续由主另分工作包，先确定stateless完整索引或worker私有session复用，再实施Model覆盖状态/query接线与保存解锁。此轮仅更新本文，没有改生产实现、dist或新增回归。系统CJK字体bytes由主共用规划，未扩入此包。

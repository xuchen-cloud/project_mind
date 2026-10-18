# GenOffice PPTX 编辑交付移植

关联：子 Issue #191；父 Issue #118。上游固定 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`。

## 工作包

- 依赖：上游完整 slides renderer、pptx-engine / pptx-render / pptx-ops；浏览器侧 React / Konva；宿主继续管理 File 版本、CAS、只读、保存和 rebase。
- 文件范围：`packages/office-pptx/**`、`src/components/office/PptxEditor*`、本文。
- 交付行为：复用上游 Canvas、文本覆盖编辑和完整 ribbon；编辑意图由同源上游 ops 执行，原格式保存后重新 inspect；未改 ZIP 部件保留实际字节。保持 `{model, edits, onChange, readOnly}`。
- 非目标：独立 App 的文件管理、自动更新、重复 AI 聊天；2026-10-18 用户明确不需要 PPT 演讲者视图（含跨屏 audience / swap），详见 [范围决定](genoffice-presenter.md)。
- 验收：真实选择 / 输入 / IME / 拖动 / 缩放 / toolbar 操作，撤销重做，跨页管理，操作产物保存为 PPTX 并重开验证；readOnly 阻止 mutation；基线换入重置编辑会话。
- 验证范围：本包 Node inspect/edit 测试、组件和 headless browser 用户操作测试、本包构建与类型检查。禁止根全量 build/test、可见应用、Tauri watch。

## 功能对照与移植矩阵

| 上游交付 | 复用位置 / 计划 | 验收 |
| --- | --- | --- |
| Konva 场景渲染、选择/多选、框选、组合内选择 | `SlideCanvas` / `NodeBody` 原始源码 | 点击对象、选择手柄、反选 |
| 拖动、Transformer 缩放/旋转、吸附、键盘微移 | `SlideCanvas`、arrange / keyboard actions | 坐标和尺寸保存重开 |
| 文字原位输入、IME、富文本/段落/字体格式 | `TextEditOverlay`、style actions、pptx-ops | 中文、多段、粗体、字号保存 |
| 插入/删除/复制、形状、图片、几何与样式 | 上游 ribbon/actions 和原始 ops | 新对象及样式保存 |
| 幻灯片新增/删除/复制/重排/布局/隐藏 | 上游 slide actions + ops | 页数、顺序和内容保存 |
| 表格文字、行列、合并、样式 | 上游 table actions + ops | 单元格/网格保存 |
| 图表数据、类型、样式 | 上游 ChartDataDialog / ops | 图表 XML 和 embedded 数据保存 |
| 撤销/重做、剪贴板、查找替换 | 上游动作 + 包内会话历史 | 用户操作与重新保存 |
| 图片裁剪/替换、填充/描边/效果、连接线、编辑顶点 | 原始 panels/actions 与 ops | 逐项进行实际覆盖核对 |
| 母版/布局、备注/批注、切换/动画/放映 | 上游 renderer 与文档操作桥 | 逐项覆盖，不以按钮存在视为完成 |
| 原格式保真及 File/CAS | 上游 patch save；宿主边界不变 | 未改实际部件字节比较、两次 save/reopen |

## 当前状态（主整合可复核）

### 连续文字保存与协议 epoch 工作包（已冻结）

- 关联 #191 / #118；依赖已有 TextEditOverlay DOM 提取、原版 editText/undo 与 native 保存 acknowledgement。
- 交付：shape 中文/拉丁混合文字的中间 caret / range 在内部 Save 或主 File 保存、pending/readOnly 暂停和原件回执后保持同处继续输入；二次保存与跨保存 undo 正确。复用原版提取/提交，不另造富文本编辑器。
- 非目标：独立 App 管理/更新/重复 AI；本轮先不扩大 presenter/window/native 范围，其他完整编辑功能仍在总体范围。
- 验收 seam：真实浏览器 input/selection/保存操作 + 格式包 inspect/edit 的真实字节重开；只读和不同外部源不得恢复旧 overlay。先取得最小红例再逐步实现。
- 协议交付：同一 iframe 的 init / 请求 / 回应带非秘密递增 epoch；props 替换同步失效旧上下文，跨 await 后复核；旧 pending flush / output 在替换或卸载时拒绝，native 输出回调不得借新 File 的 props 或 channel 回填。正常 ack 仍按真实归档匹配保留 editor / undo，并明确结案旧内部 save Promise。
- 验证范围：本包定向 caret / protocol 浏览器用例、受影响的 host bridge/renderer/资源导出回归及本包 build/check；复用前轮未变的字体/布局/真实字节预算证据，不跑根全量。

2026-10-18 本轮 caret / protocol：Chromium 与 WebKit 均已通过真实 mixed Chinese/Latin caret、向后 range、同一 DOM、主 File 保存、内部 File 保存、两轮 native 字节保存重开、跨保存 undo/redo、真正 readOnly 与外部历史替换，以及旧 change / initialized / 乱序 init / 晚到 native PDF 的真实 MessagePort 边界。内部保存特意保持宿主 callback Promise 未结束，确认先到的 native model ack 已将 child save Promise 成功结案，不依赖被旧 epoch 丢弃的 save-finished。

实现复用原版 extractParagraphs / commitEdit / editText；仅把保存提交改为 checkpoint，不关闭 shape overlay。用该 overlay 自己的准确 text render 对象标记，防止自身提交后原 effect 重写 DOM；仍保留原字号 norm。保存期间 inert 阻止输入，恢复只针对仍连接的同一 DOM 和有效原生选区；用户已点击宿主其他输入时不抢回焦点。真正只读或外部模型替换关闭旧 overlay。保存失败也结案 hold，后续只读不会误保留编辑器。表格单元格与备注仍沿用原版提交退出，未宣称同样保留 live caret。

红绿证据：最小 native save 后 overlay 数量为 0；真实 host File 点击 blur 也导致 DOM 被卸载，修复后同一 ElementHandle 始终连接。旧 change / initialized 和三种 output late-reply 共 4 条 bridge 红例转绿；保存失败后真实只读仍留 inert overlay 的红例也已转绿。WebKit 初轮 Home 键不能按 macOS 语义置 caret，改用真实 Meta+ArrowLeft 后完成全部保存断言；焦点测试以真实 click + input 替代不产生指针/键盘事件的 Playwright fill，不把这两次测试前置失败写成产品修复。

以下字体 / 资源 / pageSize 为前一工作包已通过证据，本轮只重跑被 caret / epoch 与 export adapter 影响的范围：

2026-10-18 本轮定向收口：保留共享工作树全部改动。Chromium / WebKit 完整交互、资源导出与占位符保护回归均通过。新增真实 pageSize 和授权 face OpentypeMetrics 后，完整用户流也再次通过。WebKit 历史换入的旧失败来自验收脚本把 async predicate 的 Promise 当成成功；改为显式 await 轮询后真实通过，不把脚本误报算产品修复。当前产品修复包括 ribbon 滚动 mask 裁剪固定弹层：最小真实点击用例先红，单独移除 mask 对照变绿，再将 ribbon 边缘渐变改为同级、不拦鼠标的 overlay。窄窗口两浏览器均验证渐变连续、反向滚动归零和嵌套版式菜单实际新建页面。`onRenderPdf` 已交付原版 vector HTML + 有效 PDF 原字节合同与源 EMU 纸张，原生排版实机验收仍归主整合。本轮不声明 #191 全功能完成。

占位符事实：原 fixture slide1.xml 确有 id=2 的 ctrTitle、id=3 的 subTitle 空 placeholder，非 parser 凭空添加。现实现仅在已有实质内容页抑制灰色空提示，不删除或隐藏真实节点；已有空节点实际双击输入、保存、非空文字显示及 vector 导出已验证。真实菜单新建标题布局后仍显示标题/副标题提示，再直接输入标题保存重开通过。`pptx-webkit-new-placeholder.png` 已目视，真实新页提示存在；主已目视最新 WebKit wide 无原页灰提示叠层。

本轮字体 / 资源 / pageSize 实现与 scoped 验证已结束，交回主整合，**未声明 #191 全功能完成**。完整上游 App / Canvas / TextEditOverlay / ribbon / panels 已取代简化 SVG。501 个固定原版文件、4 个固定 Web fork 文件均由 lock 校验；97 个真实文档 IPC handler 从原版生成。复用 fork 的 browser picker，未使用任意路径 relay 或旧版 ops。

### 当前功能与证据

| 能力 | 实现与实际验证 | 剩余验收 |
| --- | --- | --- |
| 直接文字、中文 IME、多段、粗体 | Chromium / WebKit 实际双击 contenteditable、两段中文、toolbar 粗体、原格式保存重开；IME flush 明确拒绝 | 表格单元格/备注仍沿用原版提交退出；复杂富文本选区尚无逐项手势证据 |
| 选择、拖动、Transformer 缩放、键盘 | 原版 Konva；Chromium / WebKit 完整真实流均通过，包含拖动、缩放、键盘和保存重开 | 多选/旋转/编辑顶点尚无逐项 UI 手势证据 |
| 两次保存、跨保存 undo | 正常 ack 精确比较归档部件后 rebase，保留 App、选择及 100 个 undo snapshot；两浏览器两次保存后续编辑、undo/redo 和真正外部历史换入重置均通过 | shape live caret/range 本轮两浏览器均通过；table cell 不在该保证内 |
| 长编辑会话 | flush 产出一个受限候选，两浏览器 300 次实际 ArrowRight→单候选→native edit→undo→再次保存通过 | 无放大共享 MAX_EDITS；100 个 undo snapshot 为现有预算 |
| 样式/几何/插页 | 原版 handlers/ops；真实字节验证多段、字体、旋转、位置大小、空白页及未改 part | 复杂 panels 不以按钮出现算 UI 验收 |
| 表格/图表 | 字节通过 cell 富文本、行列结构、导入图表数据保存 | 完整逐项 UI 对话框手势待补 |
| 组合/图片/页面复制 | 字节通过 group 内改字、ungroup、crop、background、copy/paste、主题 repaste | 图片替换/媒体/3D/连接线等已接原 handler，未逐项 UI 验收 |
| 母版/主题/布局 | 红绿用例验证 master 文字及保存、theme 后继续 edit-text、theme undo；修复 theme reparse 后旧引用；真实嵌套版式菜单新建页与标题保存通过 | 完整母版/布局编辑 UI 手势待补 |
| 备注/批注/节/切换/动画/链接 | 原版动作及真实 XML 字节保存/reparse 用例通过 | 放映动画、评论 UI 各动作未逐项手势验收 |
| 主题/字体/布局 | iframe 隔离 CSS；实际根 data-theme/.dark 与 computed 字体同步；删除 AI dock 空列和不可用 AI controls；两浏览器 wide/820px compact 截图已刷新，无左空栏 | 宿主产品其他尺寸仍随整合验收 |
| 字体 | 原版 sfnt/TTC + 真 picker / FontFace / IndexedDB；已加载授权 face 用固定 OpentypeMetrics + opentype.js 2.0.0，真实 advance/ascent/descent/hhea leading；两浏览器 Caladea 装载/重载重新 layout、字体等待后导出、原件无改动及编辑重存通过 | 未加载/缺字 face 才走原版 HeuristicMetrics；系统/Office 字体目录与完整平台 shaping/substitution 未接，不宣称 PowerPoint 像素一致 |
| 剪贴板/查找 | 原版内部 clipboard/级联，browser 系统 MIME/text 适配 | 外部系统 clipboard 的实际权限/跨应用粘贴待平台验收 |
| 占位符保护 | 原件真实空 ph 保留，仅抑制已有内容页的空提示；两浏览器现有 ph 输入保存、非空文字 SVG 导出、新页提示与输入保存均通过 | 不将其描述为 parser 新增/删除 shape 的修复 |
| 导出/打印 | 原版 File actions；两浏览器 standalone PDF 3 页/PNG zip 3 页；native vector 精确 SVG 页/嵌入资源/隐藏页筛选、有有效两页 PDF 回传字节、导出取消/失败/render 失败及 print HTML 均通过 | 有效 PDF fixture 只验证桥合同；macOS/Windows 原生排版/打印 UI 效果待实机，standalone PDF 为 raster |
| 放映 | 普通单窗口放映沿用原版；Chromium/WebKit 实际从头/当前页开始、前后翻页、Esc 回到原页均通过；构建适配不渲染演示者按钮 | 复杂放映/动画仍未逐项 UI 验收；演讲者视图/audience/swap 由用户明确排除，不计实施或发布要求 |

### 已通过 scoped 命令

- `npm run build --prefix packages/office-pptx`：通过；501 原版 + 4 fork 来源校验，生成 97 handlers，构建隔离 frame / Node / browser bundle。
- `npm run check --prefix packages/office-pptx`：本轮通过，包含 caret checkpoint / epoch 和 native output 类型；未改公共宿主 DTO。
- `npm test --prefix packages/office-pptx`：**15/15 通过**，已包含 `test/engine.test.mjs` 与 **`test/parity.test.mjs`**。覆盖旧 legacy 兼容、真实 ops、候选预算和基线、theme 后续编辑等。
- `src-tauri/resources/agent-host/node --test test/engine.test.mjs test/parity.test.mjs`（cwd `packages/office-pptx`，node 用绝对路径）：本轮 **15/15 通过**，实际使用随包 Node 24.21.0，包含 parity 测试；未只验证 legacy 用例。
- `npm run test:ui --prefix packages/office-pptx`：本轮 **37/37 通过**，5 个文件；17 个 iframe 契约（含旧 epoch 消息、三类输出跨 await / microtask、新 props callback 隔离、卸载与 pending flush 替换）、7 个 renderer、10 个 vector PDF/纸张几何、2 个真实字体 metrics/session、1 个真实 placeholder 保存测试，无未处理错误。
- `... node packages/office-pptx/test/browser-caret.mjs`：本轮 Chromium / WebKit 均通过。实际鼠标打开 shape、中文/拉丁中间 caret / backward range、保存期间冻结、同一 overlay DOM、连续主 File / 原版内部 File 保存、ack 早于 callback 结案、二次字节保存重开、跨保存 undo/redo、失败保存明确结案、真实只读关闭与外部替换不复活、用户移到宿主输入框不抢焦点；`caret-results.json` 和 `pptx-*-caret-saved.png`。
- `... node packages/office-pptx/test/browser-protocol.mjs`：本轮 Chromium / WebKit 均通过，使用真实 MessageChannel / ports；两次 external replacement、旧 change / initialized 不改变新 File 或解除初始化，乱序旧 init 被拒，旧 output Promise 在替换时拒绝、迟到 native PDF 不生成新 File 导出；`protocol-results.json`，pageerror 为空。
- `... node packages/office-pptx/test/browser-layout.mjs`：先红（Canvas 截获真实点击），修复后 Chromium / WebKit 通过；820px 宽下 ribbon 左右渐变连续/边界归零/反向滚动，真实嵌套菜单新增标题页。没有 force click。
- `... node packages/office-pptx/test/browser-resources.mjs`：本轮 Chromium / WebKit 全部通过；字体安装与持久化、原件真实空 ph 输入保存、standalone PDF/PNG、native vector HTML/隐藏页筛选/有效两页 PDF fixture 原字节、取消/写失败/render 失败、print HTML、新页提示/真实标题保存。
- `... node packages/office-pptx/test/browser-fonts.mjs`：Chromium / WebKit 均通过。真实 Caladea 文件选择；刻意延迟 FontFace 装载时真实 File→PDF 等待，尚无宿主渲染/导出调用；释放后重新 layout（原 4 行→真实字体 5 行）并嵌入 data 字体；IDB 重载后 layout 相同；仅加载字体后 native save 的 sourceBase64/hash 完全相同；随后真正 contenteditable 输入和 native 保存正确。证据 `output/playwright/font-results.json` 和 `pptx-*-font-metrics.png`。有效 PDF fixture 仍只代表 native 桥合同。
- `... node packages/office-pptx/test/browser-acceptance.mjs`：本轮 Chromium / WebKit 完整流通过；`output/playwright/acceptance-results.json` 与按浏览器 JSON 已刷新。包含真实拖动/缩放、300 操作保存及 undo、两次保存、外部历史换入、IME、readOnly、实际主题字体、内部幻灯片复制、连续遮罩/compact 截图；pageerror 均为空。旧 drag-failed 截图是历史失败，非通过证据。

上述 browser 命令使用 `OFFICE_PLAYWRIGHT_MODULE=/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`、`OFFICE_ACCEPTANCE_URL=http://127.0.0.1:5189` 和随包 Node 24.21.0，仅 headless 浏览器与包内 fixture，无浏览器下载、无可见应用、无根全量 build/test。本包 Vite 5189（PID 21986）已在本轮结束时停止；无本包构建/浏览器验收进程继续运行。后续改动需据受影响边界重验，不把本轮证据扩展为所有上游面板手势均通过。

### 保存与资源边界

`{kind:'candidate', sourceHash, base64, changedParts}` 始终为单条，不将日志套入嵌套 checkpoint。格式包校验当前原件 hash、规范 base64、压缩 ≤100MiB、ZIP ≤10000 parts / 单 part ≤100MiB / 总解压 ≤256MiB、全部 XML，并重新计算实际增删改部件清单。未改 part 保留原字节。旧 command API 总量 ≤256，旧 checkpoint 禁嵌套且重建必须匹配当前原件。File/CAS 决定最终写入。

### 宿主契约与 native 依赖

保持 `{model,edits,onChange,readOnly}`，已增加可选 `registerBeforeSave`、`onPendingChange`、`onSaveRequest`、`onExport`、`onPrint`、`onRenderPdf`；主已接实际 File save Promise、native 导出、打印和 PDF service。异步回填使用经 own-frame 握手建立的 MessageChannel，避免 WebKit 异步 window source 差异造成悬挂。每个 model/外部 edits 上下文带递增 epoch；React 同步失效旧上下文，renderer init / snapshots / queues / picker 与输出跨 await 后检查，host 捕获原 callback / port / epoch，不在微任务里读取新 File 回调。普通 native ack 会增 epoch，但 child 在 samePackage 真实候选匹配分支结案先前内部 save 请求，保留 App / overlay / undo；不同源拒绝旧请求并重新挂载。

`onPrint` 提交原版 print-html 模板产物：inline CSS + data PNG（字体已烘焙）、无脚本/编辑控件/blob/外部网络。无 callback 的 standalone 才隐藏 iframe 解码图片后调用 `window.print()`。浏览器产物通过不代表 macOS 原生打印窗口已通过；主打印 agent 负责 sandbox / 真机，Windows 无实机，验收待定。

`onRenderPdf({html,title?,pageSize?}):Promise<Uint8Array>` 与 `onPrint({html,title?,pageSize?})` 已交付。`pageSize:{widthPt,heightPt}` 使用实际当前 deck 的 EMU / 12700，不能用适配画布后的 1280px 反推物理尺寸。PDF 复用原版 `buildPdfExportHtml` 和链接层，宽高传入真实物理值；整页打印 HTML 加相同 pt 页面规则，讲义/备注沿用原模板 A4 横纵向纸张；不再统一按 7.5in 高度归一化。16:9、4:3、自定义竖版、source 尺寸优先于 fitted pixels、2/3/6 讲义和备注纸张均有红绿用例（缺 pageSize 时 8 例红）；两浏览器真实 File PDF/print payload 也验证等于源 EMU。native 返回 PDF 后原字节交 onExport，无第二次 raster，无 callback 才用 standalone raster PDF。单测禁止 native 路径调用 Canvas，用有效两页 PDF 断言选页顺序、页面尺寸、嵌入字体/图片/链接及实际回传字节。主提供 renderer service 并应用 payload 的原生纸张矩形，无须格式包接 Tauri 或路径；平台 PDF 字体/分页效果不由 fixture 冒充验收。

### 授权字体排版接线

`browser-font-metrics.ts` 直接解析已授权的真实 sfnt face，向固定上游 `OpentypeMetrics` 提供同一 face 的 advance、glyph availability、ascender、descender、hhea lineGap；缺 face/字形沿用其明确 heuristic fallback，没有新建 Canvas 度量引擎。`browser-fonts.ts` 在首次 IDB 装载时完成 parse/FontFace.load 才开放首轮 layout；本地安装先验证/解析/装载，再原子保存 IDB，随后发布真实 face/metrics。`parity-session.ts` 接受 provider，浏览器注入动态字体 provider；Node 格式引擎保持无路径权限的默认 provider，没有新增字体路径入口。

装载完成发布仅重新生成 render tree 的 deck-changed，不 journal、push history 或修改原件。原版 File PDF/PNG actions 在字体等待后取新 render tree，再 bake SVG/PNG；print preview 同样刷新，防止只延迟 native callback 却导出旧 glyph positions。session 级 Caladea 红例原为注入被忽略、换行不变；接入后真实换行/advance 与上下行度量通过，全部原件 part 字节及 undoStack 不变，后续编辑保存也通过。依赖已存在且固定的 opentype.js 2.0.0 在本包声明，license 已自动入 THIRD-PARTY-NOTICES；未改根依赖。

### 当前真实剩余项

- 编辑侧：完整多选/旋转/顶点、复杂图片替换/媒体/3D、表格/图表对话框、母版编辑、批注面板、动画/放映仍缺逐项 UI 手势证据。已有相应原版 handler/ops 和部分真实字节测试，不据此写成逐项交付完成；继续按这些实际用户操作补验证与发现的实现差距。
- 保存：shape 连续 live caret / range 与跨保存 undo 已由本轮真实用户流验证；表格 cell / 备注未改为 checkpoint，仍沿用原版提交退出，不能将 shape 证据泛化到它们。字体重排与复杂格式面板操作时的 live 选区尚未逐项验收。
- 平台：演讲者视图/跨屏 audience 由用户明确排除；已授权本地字体有真实 OpentypeMetrics，但系统/Office 私有字体枚举/授权字节桥未接，完整上游平台 shaping、可变字体实例化和 substitution 未全部移植（包括原 CSS bundled Carlito/Calibri 别名尚未注入本 face registry），缺 face/字形仍 heuristic。`slides:font-download` 未接，catalog 仅列已安装的授权 face，没有下载按钮；`slides:font-missing` 当前返回空列表，尚无真实缺字体清单/下载补齐能力，不能视为已无缺字体。实际外部剪贴板权限/跨应用粘贴未验收；屏幕录制依赖 WebView 的 getDisplayMedia/MediaRecorder 支持，未实机验收。
- Native 导出/打印：prop/桥/真实页面 HTML 均已接，主负责 macOS 真机 vector PDF 排版和原生打印界面；Windows 用户无测试机，跨平台实现的实机验收待定。

### 演讲者视图范围决定（用户明确非目标）

2026-10-18 用户明确 PPT 演讲者视图不需要支持，presenter 支线已停止并撤除本轮新增类型、测试/测试入口和测试 harness 接缝。跨屏 audience、swap、专用入口和 native 窗口不再列为下一包或发布阻塞；具体撤除及验证复用见 [genoffice-presenter.md](genoffice-presenter.md)。既有核心编辑、caret/save/protocol、真实格式字节保存和导出代码保持不动，普通放映及其他未验证编辑行为仍按矩阵如实列缺口。

产品入口收口仅通过 `parity-build.mjs` 的固定 Ribbon 构建适配移除演示者按钮，vendor/source lock 不变，保留普通单窗口放映与自定义放映入口。新增 `test/browser-slideshow.mjs` 的真实 UI 用例先红（演示者按钮仍在），修复后 Chromium/WebKit 均通过：从头/当前页播放、左右翻页、Esc 返回最后页、同 iframe、无演示者/换屏控件和 pageerror。`output/playwright/slideshow-results.json` 为本轮证据；本包 Node 24 build 再次通过，501 原版/4 fork 来源和 97 handlers 校验通过。原 File 保存、caret/epoch、字体、导出生产逻辑不改，前轮相应通过证据复用。Vite 5189 已停止，无进行中本包 build/test；不执行 root 全量验证。

### 本轮文件与工作状态

caret / epoch 包改动文件：

- 新增 `parity-text-edit.ts`、`parity-text-edit-build.mjs`、`parity-protocol.ts`。
- 修改 `parity-build.mjs`、`parity-entry.tsx`、`browser-clipboard.ts`、`src/components/office/PptxEditor.tsx`。
- 新增 `test/browser-caret.mjs`、`test/browser-protocol.mjs`；扩展 `test/editor.test.tsx`、`test/ui/main.tsx`。
- 更新本包 `README.md`、本文与 `output/playwright/` 实际证据；`.gitignore` 仅放行本轮两份结果 JSON 和两张 caret 截图，便于主整合 stage。之前字体/资源/PageSize工作包的实现和 source locks 保留，本轮未改 root/native/共享 DTO、未提交或 reset。

冻结点：**2026-10-18 19:05:32 Asia/Shanghai**。本轮最后 caret 和 protocol 两浏览器均通过，WebKit `pptx-webkit-caret-saved.png` 已目视为保存后的混合文字与同一编辑 overlay，无灰占位提示叠层。Vite 5189 / PID 21986 已 Ctrl-C 停止，进程清单无本包 Vite、caret/protocol/resources 脚本；没有进行中的 build/test。主可以执行 build:office → stage → native utility / 根验证与发布。PPT 实现冻结，本轮不继续 presenter 或字体 native 包；无新增 native 依赖或根依赖。

二进制 `.ppt` 上游不支持，本包无转换；非目标为独立 App 管理/更新/重复 AI，以及用户最新明确排除的 PPT 演讲者视图。其余未完成编辑能力不擅自移出范围。

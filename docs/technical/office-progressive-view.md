# Office 首屏与增量读取

Issue: #303，范围 G04 / G09。

## 读取与保存的权威

File working session 的完整不可变 OOXML 基线 B 与从 B 开始累计的编辑 E 是保存输入。已加载视图不是完整文档，coverage 之外的内容不表示空白或删除。成功回执只确认被冻结的编辑 revision；之后的编辑仍保留。原生 CAS、hash、journal、原子写入和幂等回执继续生效。

完整 `engine.inspect` 供 authoring 和现有工具使用。GUI 使用 `engine.inspectView`，初始模型标记 partial coverage，并带首屏所需内容或固定源包的读取入口。DOCX 按块、PPTX 按 slide materialize；XLSX 使用原生持有的读取进程。

## XLSX 读取服务

`createViewSession(bytes, context)` 返回 `{model, read, close}`。第一次 `office.view.open` 传完整源包，之后的 `office.view.read` 只传有界请求。读取进程不允许替换源包、执行编辑或接收文件系统能力。

读取联合类型：

- `range`: sheetId 和最多 100,000 格的矩形。
- `formulas` / `outline`: 工作表 ID。
- `media`: 已声明 visualId。
- `pivot`: 已声明的 OOXML part 标识；引擎必须核对它来自原件目录。

工作模型使用固定源 hash。原生 cache key 包含 Workspace generation、File 身份、固定 hash 和 working session；历史版本使用版本号与 hash。原生读取服务沿用受限 Node 环境、进程树终止、2 个进程上限、128 MiB 基线总预算和 30 秒闲置淘汰。缓存丢失后可以从同一完整基线重建。warm working 读取只查询会话元数据，不复制恢复 BLOB。

`file_working_read_view` 只接受已授权的 working session；读取前后再次检查 session、owner 和 generation。关闭 session 终止它的读取进程；Workspace 关闭使所有 generation scope 失效。GUI 再用生命周期 epoch 拒绝晚到响应。视图读取不会改变 working revision 或编辑日志。

## 可用性与验证边界

窗口出现、首屏内容出现、首屏可编辑及全局功能就绪分别记录。全局功能必须等待实际依赖；未加载公式依赖不能当空白计算。完整包安全准入与可靠快照仍可能形成必要下限，应从首屏解析成本中分别计量。

XLSX 的依赖集合同时包含原文件公式和当前累计编辑，范围覆盖新增的编辑坐标。手动输入、粘贴或撤销改变单元格内容时，旧集合立即失效；本地计算等待新集合的实际依赖装入，驻留值包含只存在于编辑日志中的数据。每个已安装的依赖范围在下一次异步读取前立即驻留，避免加载其余范围期间的滚动淘汰。每次失效推进依赖 revision 和 native recalculation generation，旧异步读取/计算不能重新激活或覆盖新结果。完整加载后的计算继续走已有路径。滚动写入从稀疏请求中省略驻留依赖坐标；不能用 `{}` 表示不修改，因为公式观察器会将缺少公式字段解释为删除公式。格式重放也携带当前原始单元格内容，保留公式身份。

内容输入会重复携带继承字体。写入累计编辑时，以变更前的有效样式过滤这些未变化字段；显式格式命令、真正改变的样式字段和清除格式仍保留。实际浏览器双保存重开验收同时检查 `styles.xml` 逐字节保真，以及显式加粗的保存和恢复。

已确认范围就绪的读取也覆盖其中的空白行。映射后的视口 coverage 使用请求边界，原生 `indexedThroughRow` 保留真实解析进度；未就绪的读取不扩大覆盖。这样可编辑声明维度内、实际最后一行之后的空白单元格，同时继续拒绝尚未读取的内容。

视口补充数据、编辑日志重放及 native 重算结果通过内部同步 mutation 投影到网格，保留原有单元格转换和 mutation 观察器。只读拦截允许当前投影的原参数，以及同一次同步调用中限定 ID、`onlyLocal` 和来源范围的必要公式观察器子 mutation，并在调用结束或失败时立即撤销。普通编辑、其他来源和晚到重用继续被拒绝；预览读取不需要临时开启编辑权限。隐藏公式栏仍保留可测宽度，避免预览缩放把排版页宽设为零。

只读预览保留公式计算生命周期；依赖未完成时仍由原有 stream hold 拦截启动。引擎返回结果时，通过固定源码适配器在同步投影内发布当前工作簿的计算结果及派生写入，完成或失败后撤销授权。它不向普通用户 mutation 开放 `onlyLocal` 通行条件，也不改变编辑模式和初始化阶段的结果接收。

工作内容只有在不再等待归档，且版本目录确认相同版本号与 hash 时才能发布为不可变来源。原生无变化保存保留已验证的来源；等待归档、版本缺失和 hash 不匹配均返回空引用。

验收包含只编辑首屏、连续两次保存再重开、从未访问的尾部、跨 sheet 公式、media/关系和未修改 parts 的保真；三格式缩放全部入口统一为 50%–150%。Windows release 实机是独立必需证据，macOS debug/浏览器结果不能替代。实际验证结果随 Issue 与 PR 记录。

## 已取得的本机证据

截至 2026-11-11 的结果分开记录，不表示 Issue 已完成：

| 范围 | 证据 |
| --- | --- |
| 宿主 | 161 项 / 8 文件通过；worker 与私有读取协议 15 项通过；根 TypeScript 检查通过 |
| 原生读取 | 4 项通过，包含真实长期读取进程复用、关闭/晚到结果，以及历史与 working 读取的 generation 变化 |
| 原生格式保存 | 3 项 opt-in 回归通过，覆盖三格式真实 working 连续保存、重开、历史保留及原生 authoring 兼容 |
| DOCX | 50 项单测；Chromium/WebKit 真实编辑器只解析 64 个块即显示可编辑正文，320 个附加段落仍未访问；两次保存、重开及未修改 entries 保留 |
| XLSX | 格式层 50 项有效检查，含 100,000 行真实 native reader；最新定向回归 15/15；Chromium/WebKit 完整真实 renderer 两项通过，另有一项结果发布/清理检查通过。覆盖累计保存、手动公式、依赖竞态、空白行、只读重放和全部适用 DOM 缩放入口 |
| PPTX | Node 36/36、UI 50/50；Chrome/WebKit 真实 App 保持 14/48 页加载，尾页 parser 持续阻断下两处编辑/双保存/重开通过；只改 slide1.xml，其余 parts 逐字节保真；全部适用 DOM 缩放入口通过 |

DOCX 最终一次 Node 24.21.0 无界面浏览器导航样本为 Chromium 435.1 ms、WebKit 549 ms 的可见且可编辑正文，真实键盘修改分别在 489 ms、584 ms 确认。它们包含测试 HTTP 宿主，不含原生 IPC/文件系统成本，未清系统缓存，不是 p95 或 Windows 性能结论。DOM 缩放入口和合成 wheel/pinch 已验；fit 从不同手动比例开始，按实际视口和页面尺寸检查预期比例及渲染缩放。原生菜单快捷键、物理触控板及平台视觉验收另计。

PPTX 最终一次无界面浏览器导航样本（Node 26.8.1）分别为 Chrome 567.1 ms / WebKit 593 ms 首内容绘制，857 ms / 926 ms 实际输入确认。它们采用真实 App、Canvas、MessagePort 与 engine，仍不包含 Tauri/File working IPC；ZIP / 全 XML 准入耗时单独记录。fit 检查真实纸面与视口几何，数值缩放对话框在该产品中不适用；物理手势及 Windows 验收仍未执行。

XLSX 最终浏览器套件使用 `8a09a09568f306e9194f59ae9e41f3b480134a43` 的构建输入，Node 24.21.0、Chrome 157.0.8103.39 和 WebKit 27.2；3/3 Node 检查代表两个完整浏览器用例和一个结果发布检查。两浏览器均无 page、console、HTTP 或 native-host 错误，成功结果只在完整性检查及浏览器/读取进程清理均成功后发布。160,443 字节、20,000 行 fixture 的首屏模型为 A1:Z100，真实键盘输入时 A19000 仍未驻留或请求；该 fixture 的 native index 已完成，不能据此声称编辑早于索引完成。

两次累计标量保存、真实关闭重开、新公式依赖及第三次公式保存重开通过；未改变的 15 个 ZIP parts（含 `styles.xml`、媒体和未访问 witness）逐字节保留。只读用例将未保存的 D8=23/加粗实际淘汰并重放，在预览中释放 A14000 依赖后得到 14008，内容日志不变且没有权限弹窗。另一个隔离 WebKit 用例确认普通 F2 编辑仍被拒绝。完整原始记录见 `packages/office-xlsx/tests/output/browser-progressive-complete.log` 与 `progressive-browser-complete/`；包内 `PROGRESSIVE-VIEW.md` 记录精确源码/构建/harness hash 和重现命令。

原生广泛回归最初为 60 通过、1 个 Source 运行资源缺失导致的初始化失败、8 跳过。补齐生成资源后，该失败项单独复测通过；原始失败日志保留，不将这次运行重写为全绿。

用户已确认没有可用 Windows 机器，#303 保持开放。解锁需要可访问的 Windows release 环境及 OS/WebView2/硬件/版本记录，以同一 fixture 完成内容、编辑、保存保真和缩放验收。

## 原生界面与测量限制

`e1ed194` 的 pinned Node 24 根 TypeScript、生产 Vite、bundle 边界、测量前端及 macOS opt-in 原生构建通过。隔离的 `Office Fixture.app` 使用独立 app data 与 Workspace；CUA 实际确认了 DOCX large 正文、表格和图片。该次 G12 observer 仍收到 shell/iframe 的 `document.visibilityState=hidden`，double-RAF 超时，因此未取得可用的首屏/编辑计时或完整原生验收。原始失败保留在 `output/playwright/office-native/docx/docx-large-1.json`，检测到共用 observer 问题后未继续 XLSX/PPTX 原生样本。该构建早于 `11b773c` 的依赖驻留竞态修复，不能作为该修复的原生验收。

闭包竞态的定向回归执行真实构建适配后的 `activateFormulaClosure`，暂停第二个 range 读取并在其间模拟已缓存视口淘汰。旧 `e1ed194` 适配器返回 11 而非 18；`11b773c` 对同一交错返回 18，6 项定向回归通过。这项测试证明异步闭包驻留行为，不代替完整 renderer 或平台验收。

后续 `02bddfd` 的独立 Round3 构建使用 macOS 26.5.2 arm64、Node 24、优化前端与 embedded-debug 原生程序，binary SHA256 为 `f09f744c49526d2cebf1489d5de707f1802d4d729f28f899d56f69a935448750`。三格式均通过可见性前置检查，早先的 hidden/RAF 阻塞已解除。PPTX 七项功能验收通过，包括真实修改、保存、关闭重开、归档、历史只读和 stale CAS；DOCX 的导航缩放、修改、保存、重开和归档通过，随后历史内容 witness 超时；XLSX 在首屏图片 witness 检查处停止。整轮不记为通过。

Round3 暴露两项 G12 观察器兼容缺口：`native-page.tsx` 的模型回执监听没有包含新的 `file_office_view`，DOCX 切换历史后仍使用当前模型作为 witness；XLSX 图片检查要求初始 `rendererData.media`，而渐进模型按约定在实际需要时读取媒体。原始报告位于 `output/playwright/office-native-round3/`，交由观察器所属集成组处理，Office 组未修改共享测量脚本。此前 Round2 的无变化保存清空来源问题已修复，相关宿主 13/13 测试通过。

Round3 单次 `cold_open`：DOCX 1188 ms、PPTX 1117 ms，均超过现有 1000 ms 门槛；后续 `preview_to_edit` 分别为 137 ms、110 ms，属于独立操作，不能相加当成冷开首次可编辑。XLSX 因 witness 失败没有有效计时。它们不是 release、全应用启动、Windows 或 p95 结论，也未证明性能门槛达成。最终空白范围修复晚于该 GUI 构建，其实际交互另由浏览器验收记录。

### Round4 原生验收

已吸收 G12 审查通过的 `214a3789` / `96239b53` 观察器修复（104/104 边界检查及入口/应用 TypeScript 检查由 G12 提供）。`8a09a09568f306e9194f59ae9e41f3b480134a43` 的统一构建通过 XLSX 构建、根 TypeScript、观察器入口 TypeScript、生产 Vite、bundle 边界、测量前端与静默原生编译。macOS 26.5.2 arm64、Node 24、优化前端和 embedded-debug Rust 程序，**不是 release**；binary SHA256 为 `2644f22f6773a0b8922a877dd8eb3c0a293e114817f37ad7520af3095efe608e`。隔离的 app data 与 Workspace 不复用用户工作区。

三格式可见性前置检查均通过。DOCX、PPTX 各七项功能验收全部通过，含导航缩放、真实修改/自动保存、关闭和原生读回、归档、重开、历史只读和 stale CAS。XLSX 后六项通过，导航缩放/模式连续性一项仍未完成，因此整轮不记为通过。原始报告与构建清单保留在 `output/playwright/office-native-round4/`。

XLSX 剩余项由独立 Spec 检查定位为 G12 观察器不匹配：`说明` 页选择 B3 并滚动至行 2/列 1 后，`sheetState()` 仍要求已离开视口的 A1 文本 `未编辑工作表：请保留中文` 出现在绘制记录，导致后续已有的选中单元格位置绘制证明及模式连续性检查未执行。native 内容/公式比较和计算周期已通过；composition cache 中存在该表的数值，但不足以补记未执行的位置证明。需由 G12 保留初始首屏和 native 内容检查，在导航后使用选中单元格的绘制证明，并增加 A1 离屏/B3 可见的回归。Office 未自行修改共享观察器，失败记录保留。

Round4 单次 `cold_open` 为 DOCX 1193 ms、XLSX 1701 ms、PPTX 1133 ms，均超过现有 1000 ms 门槛。对应 `preview_to_edit` 为 138/407/110 ms，属于不同操作。计时不是全应用启动、release、Windows 或 p95 结论；Windows release、剩余 XLSX 原生验收和性能门槛均未达成，#303 保持开放，PR 保持草稿，`ready_for_merge=false`。

### Round5 XLSX 受影响验收

G12 的固定提交 `6919ba7552fdbf31aa27e6dfae02951823cbc215` 已完成 Standards/Spec 双轴审查，均无发现；其真实入口边界由 1 过/2 失败转为 3/3，全 native observer 107/107、入口 TypeScript 通过。这些结果由 G12 提供。Office 无冲突吸收为 `d34123601b7d19f701cd8cc1eb442ed232159e46`，三个文件与审查提交完全一致；只移除导航后对旧首屏的等待，初始 ready/sheetState 和实际 B3 内容、格式、主画布合成证明继续保留。

本机重新通过测量入口 TypeScript、测量 Vite 和静默原生构建，只执行 XLSX large 的隔离 Mac 验收。构建时工作区干净，产品 bundle 仍来自 `8a09a095`；Round5 binary SHA256 为 `8615c32945a091e4c6b35166522df27ab8170363d02ee5b532b93b1eb3a6353c`，环境与 Round4 同属优化前端加 embedded-debug，非 release。原始记录在 `output/playwright/office-native-round5-xlsx/`；Round4 三份报告的 SHA256 前后相同，DOCX/PPTX 未重复执行。

原离屏 A1 阻塞已解除：B3 的 native 值/实际值均为 30、格式 General、缩放 1.1，并取得其当前屏幕位置的主画布合成证明。随后 preview→edit 的连续性检查失败，XLSX 仍为六项通过、一项失败。五个 RAF 样本中，iframe 未移除，sameFrame/sameSurface/present 始终为 true；painted 在 5585 ms 为 true，5597/5629/5644 ms 为 false，5651 ms 恢复 true。当前记录将视图状态不匹配和缺少位置绘制证明都归为 false，未保存失败帧的分支原因，因此尚不能判断实际闪屏还是观察器漏证。后续需要区分这两条路径并保留严格绘制门槛；不将本轮记为通过。

Round5 单次 XLSX `cold_open` 为 1764 ms，仍超过 1000 ms；`preview_to_edit` 为 351 ms，是独立操作。当前剩余项为 XLSX 模式连续性证明、性能门槛及不可用的 Windows release 实机验收；Issue 和草稿 PR 继续保持开放。

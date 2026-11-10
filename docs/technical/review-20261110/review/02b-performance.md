# Phase 2B：Office 首屏与渐进打开性能审查

基线：`fe9fe9c188f05c23bae369074446e38c0859a0c8`，2026-11-10。关联 Issue：用户直接发起的 full-review，未新建 Issue。依赖：`00-scope.md`、`01-quality-architecture.md`、`01b-persistence-architecture.md`、`evidence/measurement-notes.md` 和 full-review 上游 Step 2B 提示。交付：首屏阻塞与重复工作证据、分级发现、保留完整 OOXML 的实现设计。非目标：修复源码、发布、重复执行基准、GUI/build/test、递归委派；独立缩放工作包不在本报告范围。

验收与验证范围：追踪 DOCX engine/upstream renderer、PPTX engine/vendor renderer、XLSX inspect/native/renderer gateway；读已有原始测量、核对行号；明确实测与推断，保持固定基线、累计 edits、CAS 和未加载内容的完整保存。此次只进行了静态阅读及已有 JSON/log 归纳，没有运行应用、构建或测试。以下 4 项是本阶段新增发现；持久化全字节快照/BLOB/hash、全帧 worker 协议及 Record 无分页列表交主审汇总，不重复计数。

## 已有实测及解释边界

环境为 **macOS arm64，隔离临时工作区，可见窗口，embedded-debug（优化前端＋debug Rust）**。每种 large fixture 一次 cold-open 样本，操作系统缓存没有清空；不是 Windows、release、p95 或用户真实文档结果。

| Fixture | cold_open 至可见内容稳定 | 同次 file_working_open | 切回 large 文件 |
|---|---:|---:|---:|
| DOCX，500 个新增段落，约 20 页 | 1,725 ms | 917 ms | 879 ms |
| XLSX，10,000 个新增行，含公式 | 6,151 ms | 3,886 ms | 3,159 ms |
| PPTX，40 张幻灯片 | 1,859 ms | 791 ms | 866 ms |

原始证据：[DOCX JSON](/tmp/project-mind-full-review-20261110/docx-measured/docx-large-1.json)、[XLSX JSON](/tmp/project-mind-full-review-20261110/xlsx-measured/xlsx-large-1.json)、[PPTX JSON](/tmp/project-mind-full-review-20261110/pptx-measured/pptx-large-1.json)。三者 cold_open 均超过该脚本 1,000 ms 预算。JSON 的 commandOffset/commandCount 将相应 `file_working_open` 定位到同次测量。完成条件含内容 witness 和 3 次 stableDoubleRaf；XLSX 包含到可见主 canvas 的文本绘制链。它们证明可见内容到达时间，不能替代首次编辑响应、滚动流畅度、尾部加载完成或保存验收。

首个请求的 native log 累计 `worker-response` / `worker-decode`：DOCX 830.134 / 857.014 ms，XLSX 3,609.170 / 3,709.088 ms，PPTX 见其对应日志。前两项分别见 [DOCX log](/tmp/project-mind-full-review-20261110/docx-measured/native-last.log)、[XLSX log](/tmp/project-mind-full-review-20261110/xlsx-measured/native-last.log)。计时点是 worker 请求链上的累计时间，不是纯 engine CPU 或纯 IPC；response→decode 还含进程收尾。尤其 XLSX 的 6,151−3,886=2,265 ms 只是其余路径总差值，含 renderer 初始化、公式处理及 witness 等待等，不能归因于其中一个函数。

测量脚本原本只观察旧 `file_office_inspect/save`，主审临时修正生成产物的 observer 才测到 `file_working_open`。旧 DOCX 45 秒超时是 witness 缺口，不是产品打开耗时。save observer 未同步修复，因此这些样本不声称保存通过。详细限定见 [measurement-notes](evidence/measurement-notes.md)。内存 JSON 明示 WebKit candidate 可能含无关进程；没有可靠的 retained-heap/leak 证据，本报告不把聚合 RSS 当作 Office 泄漏或精确峰值。

## P1-PERF-1：XLSX 分块接口被全工作簿预取屏障抵消

**严重度：High / P1。** 触发：有较大 used area、多个工作表、公式或媒体的工作簿，即使用户只需要当前表首屏。

**代码与调用链：**

- [engine.ts:164](/Users/xuchen/project_mind/packages/office-xlsx/engine.ts:164)，164–208：`inspect` 遍历每张表的整个 used rectangle，串行收齐所有 chunk、合并 cells/rows/merges，再逐表读取所有公式和 outline、所有媒体及 pivot，最后重读含公式的 worksheet XML 做 warnings，才返回。
- [engine.ts:151](/Users/xuchen/project_mind/packages/office-xlsx/engine.ts:151)，151–159：`loadedRange` 即便请求范围已经可用，也必须等 `indexingComplete`；重试重复读取相同 rectangle。native [lib.rs:703](/Users/xuchen/project_mind/packages/office-xlsx/native/engine/src/lib.rs:703)，703–737 已能按 `indexed_through_row` 等待指定范围；这里的 `indexing_complete` 是整表完成，而不是该范围完成。
- [native lib.rs:255](/Users/xuchen/project_mind/packages/office-xlsx/native/engine/src/lib.rs:255)，255–327：metadata open 本身读取共享字符串，并逐表扫描 dimensions/tables/comments/sparklines/cell images/pivots。`read_sheet_dimensions` [workbook.rs:344](/Users/xuchen/project_mind/packages/office-xlsx/native/engine/src/workbook.rs:344)，344–373 对可信 dimension 仍按预算计数走过 sheetData；预算耗尽时才有提前退出。故“先只返回现有 metadata”也不能被称为已消除全部整表工作。
- [renderer-host.ts:34](/Users/xuchen/project_mind/packages/office-xlsx/renderer-host.ts:34)，34–48：所谓 streaming 使用的是已经装满的 immutable snapshot；每次读取都返回 `indexingComplete:true`。上游 [App.tsx:4544](/Users/xuchen/project_mind/packages/office-xlsx/vendor/apps/sheets/src/renderer/App.tsx:4544)，4544–4565 已有 visible range 与延迟 formula closure，但到达此处时宿主全工作簿 inspect 已经完成；formula mode 还调用 `startFullLoad`。

**影响：** 首屏依赖工作簿总量，而非当前 viewport；内存同时持有原始压缩文件、native index、Node chunk/汇总数据、完整返回 JSON 及 renderer 数据。200 万格预算是上限，不能使单次 10 万格 range 自动成为按需加载。XLSX 6.151 秒与 3.886 秒 open 为实测；各子阶段占比、内存放大倍数以及优化收益尚未测量，不能断言全量预取独占这段时间。

**修复方向：** 保留 native session 的生命周期；先返回工作表目录、当前表必要元数据和 viewport＋小范围预读，后续受控 range 请求复用同一索引。为 `rangeReady` 与 `sheetComplete` 建立不同状态；不能直接把 `indexingComplete` 改为 true。当前 native 在整表完成前会暂缺 protection/validation/filter 等尾部元数据（`lib.rs:760` 起），应先取得影响编辑权限与当前视图正确性的元数据，之后再开放相应编辑。公式依赖/媒体/pivot 按实际可见内容或操作需求加载，公式原始值和缓存状态须保留。完整性预算仍逐次累计执行，不通过取消 ZIP/解压上限提速。

**验收建议（未执行）：** 固定首屏数据，扩大未访问表及尾部行，记录 first paint、first editable、native bytes/ranges；首屏阶段不得收到全部其他表 cell JSON。注入尾部加载错误，首屏保留错误可见且不能把未知单元格作为空值提交。分别测 metadata prepass、range ready 和全表完成，才能判断剩余原生瓶颈。

## P2-PERF-2：DOCX 已有分帧挂载，但首屏前重复完整解包、解析与模型转换

**严重度：Medium / P2。** 触发：打开 DOCX，段落、关系、字体和媒体越多，重复工作越显著。

**代码与调用链：**

- [engine.ts:15](/Users/xuchen/project_mind/packages/office-docx/engine.ts:15)，15–37：先 `assertZipInflatesWithinLimits`，再 JSZip 打开并逐 XML/rels 解码，之后 `parseDocx`，再整文档 `blocksToPmDoc`/normalize，附带 authoring、nodes/assets 和 sourceBase64。
- `parseDocx` [parse.ts:333](/Users/xuchen/project_mind/packages/office-docx/upstream/packages/docx-engine/src/parse.ts:333) 调用 `loadDocxZip`；后者 [zip-load.ts:112](/Users/xuchen/project_mind/packages/office-docx/upstream/packages/docx-engine/src/zip-load.ts:112)，112–120 又做 metered inflation、JSZip 和 normalization。因此同一 engine open 已有重复解压校验路径，不能把每次 `loadAsync` 简化称作“都解压全部文件”，真正的全量 inflate gate 和 XML 解码要分别计时。
- 宿主 [full-editor-host.ts:28](/Users/xuchen/project_mind/packages/office-docx/full-editor-host.ts:28) 仍将 sourceBase64 交给完整 editor；[renderer-host.ts:80](/Users/xuchen/project_mind/packages/office-docx/renderer-host.ts:80) 制成 Blob URL，225 行通过 `consumePendingOpenDocx` 交给上游。
- 上游 [file-actions.ts:399](/Users/xuchen/project_mind/packages/office-docx/upstream/apps/docs/src/renderer/file-actions.ts:399)，399–430 再取全字节、`parseDocxOffThread` 全文解析、等待嵌入字体、整文档转换，随后才 `setContentPhased`。`parse-off-thread.ts:65–84` 以 transferable buffer 避免一部分复制，但返回的仍是完整 parsed model。

**已存在的优化：** `phased-content.ts` 确实分帧插入尾部；App 也有分页节流。不能报“DOCX 没有渐进挂载”，也不能将移到 Web Worker 误认为可以提前获得首屏 parsed blocks。

**影响：** 宿主 inspect 与 renderer 第二遍解析串联；首屏仍等待全文 parse/convert，而正常首开并不把服务端 PM model 直接作为完整 editor 的初始化来源。1,725 ms 是测得的总 cold_open；没有 parse span，重复解析具体毫秒数只可推断。

**修复方向：** GUI open 与完整 authoring inspect 区分需求；选择一个解析所有者，重用同一 validated package 与必要的解析结果，避免先生成只供其他接口使用的全量 authoring/model，再由 GUI 重建。ZIP gate 在同一信任域内复用已校验对象/结果，跨 IPC 仍验证身份、尺寸与必要的内容边界。先复用现有 phased mount 消除重复工作；下一步将 `document.xml` 解析及 PM 转换改为有稳定 block ID/原文 offset 的批次。DOCX 没有可靠预存分页，按 block/section 连续排版至填满 viewport，不能按“第 N 页 ZIP part”加载。字体与当前段落布局依赖先解决，远端媒体及无关 authoring 汇总延后。

**验收建议（未执行）：** 记录每次 open 的 ZIP gate/parse/PM conversion 次数和耗时；比较短首段＋大尾部；前几屏内容、页眉脚注和字体稳定后可读，尾部追加不重置当前选择及滚动锚点。首屏编辑后在尾部未挂载时保存，必须能重开并保留尾部全文。

## P2-PERF-3：PPTX worker 提前构建全 deck 布局，renderer 又从原件重建全部 slide model

**严重度：Medium / P2。** 触发：多 slide 或媒体较大的 PPTX。

**代码与调用链：**

- [engine.ts:32](/Users/xuchen/project_mind/packages/office-pptx/engine.ts:32)，32–80：open＋所有 XML 校验后，将全部媒体转换 data URL，clone 整 deck、收集所有可编辑元素并对每张 slide `buildRenderSlide`，连同 sourceBase64 返回。
- vendor [zip.ts:72](/Users/xuchen/project_mind/packages/office-pptx/vendor/packages/pptx-engine/src/zip.ts:72)，72–87 将整个 archive entries 展开；[index.ts:654](/Users/xuchen/project_mind/packages/office-pptx/vendor/packages/pptx-engine/src/index.ts:654)，654–665 再解析全部 slide。
- renderer [parity-entry.tsx:199](/Users/xuchen/project_mind/packages/office-pptx/parity-entry.tsx:199)，199–225 等待 fontsReady 后，用 sourceBase64 **再次 `openPptx`**，建立 candidate baseline，再建 parity session 并 mount App；它没有用 worker 的 renderSlides 直接恢复这个编辑会话。

**已存在的优化：** renderer 传入 `lazyInitialLayout:true`；[parity-session.ts:59](/Users/xuchen/project_mind/packages/office-pptx/parity-session.ts:59)，59–70 的 nodes getter 按需布局。这个优化有价值，但不消除前面的全 archive 解包、全部 slide 解析以及 worker 全 deck layout；不能建议“只给 renderer 加 lazy layout”作为修复。

**影响：** 非首屏 slide 布局及媒体编码先消耗 worker 时间和 payload，renderer 又保留 archive/slide model。40 slide cold_open 1,859 ms、working open 791 ms 为实测；不是已证明每张 slide 都已绘制 DOM，也没有逐 slide 成本或收益百分比证据。

**修复方向：** 为 GUI 引入轻量 open，返回 presentation 顺序/尺寸、当前 slide 所需 theme/master/layout/关系与资源；完整 authoring/renderSlides 按明确调用需求生成。保留现有 lazy layout，进一步让 archive 条目和 slide parse 按需 materialize，媒体以基线绑定的有界资源句柄获取并缓存。初始化只需一种可恢复编辑会话的数据表示，避免“全 render model＋全 source＋全 reparse”。隐藏 slide 的原始 OOXML 与未建模节点仍由完整原件托管，修改采用现有 patch/candidate 审核语义。

**验收建议（未执行）：** 固定第一页，将后续 slide 和大媒体扩大，检查首屏前 parse/layout/media 次数；访问未加载 slide 后应准确可编辑。保存首张 slide 时逐项核验未打开 slide、speaker notes、master、动画、关系及媒体条目，不能仅比较可见渲染截图。

## P2-PERF-4：XLSX 的每个 viewport 读取在 renderer 主线程扫描整表数组

**严重度：Medium / P2。** 触发：大工作表滚动、视区切换，或公式模式按块预载。

**位置：** [renderer-host.ts:45](/Users/xuchen/project_mind/packages/office-xlsx/renderer-host.ts:45)，45–48，`sourceRange` 每次调用执行 `range.cells.filter(within)` 和 `range.rows.filter(...)`。最多 10 万格只限制请求矩形，不限制被扫描的完整 cells 数量。上游 visible range 调用见 `App.tsx:4544`；full load 入口见 [full-load.ts:24](/Users/xuchen/project_mind/packages/office-xlsx/vendor/apps/sheets/src/renderer/full-load.ts:24)。

**影响：** N 个存储单元格、K 个范围请求会做 O(K×N) 过滤，并分配 K 组结果数组；每次小 viewport 也与整表规模相关。若全表按固定 B 个单元格块读取，过滤部分可增长为 O(N²/B)。这是从真实调用路径推导的复杂度，不是已测 CPU 火焰图，不把所有 2,265 ms 后端返回后的耗时归给它。本项独立于首次 inspect：即便消除初始重复解析，只保留当前 gateway 也会继续产生扫描成本。

**修复方向：** 短期为 immutable snapshot 建一次按 sheet/row 分桶或有序索引，仅访问请求行和列；与 PERF-1 合并实施时直接走 native range index＋有界 viewport cache，不再同时维护整张表的大数组。cache key 包含 fixed baseline/session 与 sheet/range；叠加累计 edits，不能让旧读取覆盖较新的编辑或结构变更。

**验收建议（未执行）：** 在相同 viewport 下从 1 万行扩大到更大表，记录单次请求访问的 cells 数量和主线程 long tasks；滚动成本应随可见/预读区增长，不随全部行数线性增长。验证合并单元格、行高、条件格式及编辑 overlay 与索引查询一致。

## Worker 启动、IPC 与内存：供主审合并，不重复计发现

- [office_worker.rs:439](/Users/xuchen/project_mind/src-tauri/src/office_worker.rs:439) 每请求 spawn；474–494 等完整响应、收尾并 decode。Node [worker.mjs:74](/Users/xuchen/project_mind/packages/office-runtime/worker.mjs:74) 已按 format 动态 import。因此本轮不以“加 async/lazy bundle”替代消除全文工作。
- XLSX [engine.ts:121](/Users/xuchen/project_mind/packages/office-xlsx/engine.ts:121)，121–140，每次 withWorkbook 写一份临时原件，创建 Sidecar，操作结束 stop＋rm；[sidecar.ts:18](/Users/xuchen/project_mind/packages/office-xlsx/sidecar.ts:18) 再 spawn native。现有 `loadRange`（engine.ts:248）每调用也重开 workbook，不能直接拿它做每滚动一次的渐进 RPC。
- 当前 source base64、完整模型、媒体 data URL 和各侧 JSON 形成多种并存表示。base64 字符数约为源字节的 4/3；实际 JS/Rust 对象开销和 RSS 不能仅按这个比例计算。范围协议及单一解析所有者能减少 payload/驻留数据；单纯扩大 frame budget 会增加峰值，不能解决首屏屏障。
- 可以复用既有 recalculation session 的受控生命周期思路，构建按 File edit session 绑定的读取服务；不是建立无界全局 worker pool。保持进程权限、预算、取消、close/Workspace generation 隔离，旧异步返回不能被新会话接纳。进程启动与私有临时文件在 Windows 上的耗时需实际拆分测量，不能据 macOS 结果归因于 Defender、WebView2 或磁盘。
- Windows 历史/旧 inspect 的 checksum 分支见 [file_office_read.rs:89](/Users/xuchen/project_mind/src-tauri/src/file_office_read.rs:89)；`file_working::open` 不走它，不能加到当前 working open 成本里。完整快照/校验/写事务问题复用 01b 的证据；不能通过删 CAS、hash 或恢复 BLOB 获得性能数字。

## 可实施的首屏/渐进加载设计

以下为接口草图与工作拆分，不是已存在 API 或完成实现。

```ts
// Native 拥有完整不可变包；Web 层只持范围读取能力，不暴露路径。
const session = await openOfficeView(fileIdentity);
// session = { id, generation, baselineHash, expectedWorkingRevision,
//             catalog, firstViewport, coverage }
renderFirstViewport(session.firstViewport);
const page = await readOfficeView({
  sessionId: session.id, generation: session.generation,
  baselineHash: session.baselineHash, target: nextViewport,
});
// 先匹配 session/generation，再将已提交范围叠加本地累计修改后显示。
mergeView(page, cumulativeEdits);
await saveOfficeView({
  sessionId: session.id, baselineHash: session.baselineHash,
  expectedWorkingRevision, requestId, cumulativeEdits,
});
```

1. **完整基线先被可靠托管。** 保留打开时完整不可变 OOXML 与来源身份，文件级快照/hash 与恢复持久性仍是必要边界。先消除重复读、重复解析和长写事务，再让格式读取服务提前返回。若沿用当前必须全包验证的准入规则，第一阶段首屏仍需等待这一次完整验证，明确报告该下限；进一步改为逐 entry 解压必须有累计预算与安全元数据策略，不能把尚未检验的内容标成“整包验证通过”。
2. **把首屏可见、首屏可编辑和全局功能就绪分开。** 当前页/sheet 的样式、布局、权限和合并等影响首屏的状态先准备；全局查找、全工作簿计算、导出/打印等只在其依赖齐备时执行。XLSX 可展示现存 formula cached result 并标记计算状态，但不能把未加载依赖当空白计算；需要时由持完整基线的 native 计算服务或实际依赖闭包求值。DOCX 使用连续 block/section 排版；PPTX 按 slide＋依赖图读取。
3. **完整源包＋累计编辑 overlay 是保存权威。** 加载缓存只用于视图，未加载状态绝不代表删除。保存将会话开始的完整固定基线 B 与从 B 起累计 edits E 组合为候选包；重复保存后的后续操作仍保留此前修改，不能清空 E 却继续对旧 B 只应用新一笔。DOCX 当前整 snapshot 路线在真按需解析前必须改成保留未知尾部的 patch，或保存时先完整 materialize 原件再叠加编辑；不得 serialize 当前已挂载 PM 前缀。PPTX candidate 也必须以完整 archive 生成，XLSX 保持 gateway patch 语义。
4. **原件不动的条目完整保留。** 在原始包上替换已修改 XML/binary parts；未读取的工作表/slide、未知扩展、关系、公式、媒体和字体沿用原件。ZIP 重封装可以改变容器压缩字节，未修改条目的解压后内容须一致；完全无修改时可直接返回原始包。结构操作（跨未加载页删除、全局替换、表行列变换等）只 materialize 操作实际依赖，无法完整表达时先完成该部分加载，不猜测未知状态。
5. **提交协议保持原有安全约束。** 保存冻结一个 edit revision，native 重验权限/归属、当前工作 revision 与实际文件身份/hash，沿用 journal、原子替换、版本/回执和幂等；成功只确认该 edit revision，期间新增 edits 保留。对外部修改保持冲突语义。基线或 generation 失效时取消旧请求，数据 cache、派生模型及编辑 overlay 使用明确版本键，不能混入其他文件的数据。
6. **有界后台工作。** 首屏优先，邻近页面/range 预读，远端媒体按需；CPU 工作分片、原生索引有背压，缓存有容量和淘汰策略。保留完整源包不意味着 renderer 必须驻留所有展开对象。现有 DOCX 分帧挂载、PPTX lazy layout、XLSX native index/visible range 应复用，集中改它们被前置全量阶段堵住的接入处。

建议顺序：先修 XLSX inspect/gateway（PERF-1＋4），同时给现有各阶段打点；再分别清除 DOCX/PPTX 重复解析与无用全量模型（PERF-2＋3）；最后按格式推进真正的解析/数据按需化。每一步都可独立验收，不要求一次替换所有引擎。

## 后续性能与完整保存验收

- 固定同一 commit、fixture hashes、构建模式和机器，分 cold process / warm open / 切回大文件；测 resolve、snapshot/hash、SQLite 写事务、worker spawn/import、native metadata/index、range ready、传输字节数、renderer parse/model/layout、可见 witness、first editable、tail complete。阶段未改变时复用已有结果，不能跨 debug/release 或 OS 混算。
- 保存首屏的一处修改，期间从未访问最后一页/其他 sheet/后续 slide；关闭重开验证编辑和所有未加载条目。连续保存两次验证前一次仍保留，尾部后台返回不得覆盖本地新编辑。覆盖 Undo/Redo、外部修改 CAS 冲突、关闭中取消、失败重试幂等和 crash recovery。
- 公式依赖未加载 sheet、共享字符串、图片关系、合并单元格、DOCX 脚注/section、PPTX master/notes/动画要有真实 fixture；既检查显示行为，也比较修改 part 清单及未修改 entry 内容，不能以“能打开 ZIP”代替保真。
- Windows 需要相同 fixture 的可见 release 实机证据，记录 OS/WebView2、CPU/磁盘、构建与依赖版本。当前无法执行 Windows；结论仅是跨平台代码路径中的确定重复工作及 macOS 单次观测，没有 Windows 根因、达标结果或预计收益承诺。

本阶段完成静态审查与报告，不表示性能问题已修复或整个 full-review 完成。后续由主审合并 Phase2A/2B、处理上游 checkpoint；本 reviewer 不推进其他阶段。

# GenOffice XLSX 实际验证（#118 / F03，2026-10-13）

## 判断

**建议将 GenOffice 的 XLSX 原件保存链列为有条件采用的候选。** 真实 Node gateway → mutation plan → Rust sidecar → XLSX 落盘链已跑通。两份样本 no-op 完整保留；显式 IronCalc 重算并通过公开 API 载入 cache-only 表后，指定编辑、依赖与跨表缓存、原字体/样式和所有受测对象均通过。本次没有修改上游源码、自己 ZIP patch、引入 EE 或移除许可检查。

**固定上游的普通保存和仅传入 IronCalc 缓存仍失败。** `edited-default` 三个缓存错误，`edited-ironcalc` 的“说明”!B3 仍为 30。追加成功分支不能覆盖这些失败，也不表示上游 planner 已修复。采用前必须明确处理这个缺陷，并完成主产品 File/会话与 GUI 接入。

## 工作包与范围

- 关联 Issue：#118/F03，候选验证，不是 Issue 完成或生产交付。
- 固定上游：`d32d1711f1bf985430757b8c6b3fbddd3831d946`，154 个下载文件逐个校验 Git blob SHA；`source-provenance.json` 与 `tree.json` 可追溯。
- 输入只读复用 Univer 工作包的 simple/complex 原件与 fixture metadata。归档原件 hash 未变；仅将复制的 manifest 文件路径改为相对路径。
- 交付：四个真实引擎分支、独立校验、raw SDK 再读、已测接口、中文结论、机器结果、可复跑脚本及主 agent 的 browser 产物。
- 非目标：完整 Electron 应用、完整 GenOffice GUI、全仓测试/review、其他文件格式、生产保存服务及大表性能。
- 实测环境：macOS arm64、Node 26.8.1、Cargo 1.94.1、Python 3.12.14、openpyxl 3.1.5；Rust 采用上游 Cargo.lock，IronCalc 0.7.1。debug sidecar 编译成功，用时 4 分 40 秒。npm 依赖和 Rust target 位于独立 scratch；Cargo 使用系统 registry 缓存，未修改 root 依赖或本仓库 Cargo.lock。

## 引擎结果

编辑目标固定：明细 A3=`香蕉（SDK编辑）`，B3=15，B5=`=SUM(B3:B4)+5`。期望 B5=40、B7=30、说明 B3=40。

| 分支 | simple | complex | SDK/文件公式缓存 B5、B7、说明 B3 |
| --- | --- | --- | --- |
| noop | 74/74 passed | 88/88 passed | 保留原缓存 30、20、30 |
| edited-default | failed，3 项 | failed，3 项 | 空、20、30 |
| edited-ironcalc | failed，1 项 | failed，1 项 | 40、30、30 |
| edited-ironcalc-cache-sheet-touch | 74/74 passed | 88/88 passed | 40、30、40 |

74/88 包含原 70/84 个 openpyxl 检查，以及元数据、未触及压缩 payload、XML 改动范围和 ZIP 无增删四项。SDK 值/公式与缓存另有明确断言；全部成功分支 SDK 语义与缓存也通过。`results.json`、`sdk-results.json` 保留逐项结果。

no-op 的 ZIP entries 内容没有一项改变，未触及压缩字节也全部相同；整个 ZIP 文件 hash 会因重组容器而不同，不宣称整文件字节相同。普通编辑仅改变 `sheet1.xml`；成功诊断分支改变 `sheet1.xml` 和 `sheet2.xml`。未增加或删除部件。

未改表序/隐藏、行列尺寸、merge、freeze、字体、完整样式、CF（含 differential style）、DV、chart、image、其他单元格内容与公式均通过。creator=`openpyxl`、Application 保留原值，原件没有 Company 字段，导出后仍无 Company。后者证明没有新增 Company，不覆盖“已有非空 Company”的另一个样本场景。

## 具体缺陷与公开调用解锁

1. `recalc_cells` 对两个样本均正确返回跨表 B3 的 `number:40, isFormula:true, isError:false`。本包传入 `formulaValues` 的“说明”表也有 `{row:2,column:1,value:40}`，不是缺少 reads 或漏传结果。
2. `xlsx-gateway.ts` 850 行附近的 `sheetNames` 收集 edit/fill/结构等工作表，却没有包含 `formulaValues` 的 sheetName。1081 行后的缓存写入发现 `worksheetXmls.get(sheetName)` 不存在即跳过。没有用户编辑的“说明”表因此没有进入 mutation plan。
3. `edited-ironcalc-cache-sheet-touch` 显式附加公开 `CellEdit`：`{sheetName:'说明',row:2,column:1,writeValue:false,cell:<原值与原公式>}`。这载入该表，不改值、公式或样式；后续同一 `formulaValues` 正确写入 40。没有引擎替换或手工 ZIP 编辑。
4. `fixture-save.ts` 导出的 `prepareFixtureSave` 已用于实际探针，返回准确的 recalc、formulaValues 与 marker。主 backend 可以直接复用；这是明确的受控样本适配，不能当成通用兼容层。

正式解锁选择：保留可追溯 caller 适配，或在 planner 的工作表收集阶段纳入缓存涉及的表并进行对应验证。本次不修改上游或生产集成。

## 默认计算的边界

gateway 本身不会自动计算；不给 `formulaValues` 会清掉新公式缓存并保留依赖旧缓存。上游小表真实 GUI 默认把公式交给 Univer 实时计算，大表/closure 不可用时才有 IronCalc 路径。headless gateway 的默认失败不能描述成 GenOffice GUI 的默认行为；本次完整 GenOffice GUI 未运行。

IronCalc 在本样本范围支持 SUM、四则运算、乘法依赖和中文跨表引用。没有测试一般 Excel 函数、动态数组、外链或宏；`prepareFixtureSave` 对非数值/错误公式结果显式报错，不用格式化字符串伪装数值结果。

SDK 公式 raw 返回含 `=`。首轮断言误把无 `=` 的预期当作接口完全相等，初始报告已保留；最终同时记录 `rawPassed` 和仅处理开头 `=` 的 `semanticPassed`。该差异属于接口表示，不计为内容失败。

首次 range 返回可能含全部 cells 但 `indexingComplete:false`，CF/DV 尚未返回。本包小样本接口等待真实索引完成（5 秒超时报错）；最终 complex 导入模型含 1 条 CF、1 条 DV、chart/image 两个 visuals。此等待有实际协议依据。

## 主 agent 的薄浏览器闭环

主 agent 编写并操作 `browser/`：loopback Node server + HTML grid/form，真实 form 输入 → IronCalc → 公开 gateway/sidecar → 再读 → 渲染。主 agent 已完成 Chrome/Chromium 与 WebKit 两种浏览器、两个样本共四份候选。本 agent只读取产物补独立检查，没有重复 GUI 或转换。

| 浏览器候选 | 主原始 compare | 补完独立检查与 SDK 再读 |
| --- | --- | --- |
| Chromium simple | 70/70 | 80/80 passed |
| WebKit simple | 70/70 | 80/80 passed |
| Chromium complex | 84/84 | 94/94 passed |
| WebKit complex | 84/84 | 94/94 passed |

**这是薄 HTML grid，不是 GenOffice 原 Univer UI。** 它显示 cell 和部分基本字体/颜色，未绘制 merge、chart、image 或 hidden sheet，也未实现完整格式工具栏。文件中相应对象保留通过，不能因此宣称预览/编辑它们的 UI 已实现。截图由主 agent 保存在 office-validation 证据目录，本包未复制其他任务截图。

外部工具重开由主 agent 承担，见 [外部重开证据](../office-validation/evidence/genoffice-xlsx-external/)。主已完成原件加四分支及四份浏览器候选共 14 条外部重开记录（simple 2 页、complex 3 页），其中两份同 hash 原件复用既有证据，12 份候选实际由 bundled LibreOffice headless 重开；所有源文件 hash 不变、no-op 全文/尺寸一致。外部 Excel 类工具可能自行重算，不能覆盖本包实测的 default/ironcalc 缓存失败；四份浏览器候选的外部重开也通过，详见该证据目录。

## 相对 Univer 的判断

| 维度 | 既有 Univer 试验 | 本次 GenOffice |
| --- | --- | --- |
| 值/公式及依赖 | FORCED 所测语义通过；默认依赖缓存错误 | 公开调用解锁后通过；默认和原 IronCalc 分支真实失败 |
| 保存保真 | 受测数据对象语义保留；重序列化出现样式/XML/元数据差异 | no-op 所有 ZIP entry 内容相同；编辑只触及两个 sheet，原字体/样式与 metadata 保留 |
| 人工 A3 编辑 | 用户/主报告 typed A3 font loss 与 creator/Company 改变 | 薄 form 编辑保存保留原字体与 metadata；完整 GenOffice 网格 typed 行为未验收 |
| UI 接入成本 | 已有 Viewer/Gateway；集成面较现成 | 上游仍用免费 Univer 0.25.x 网格，OOXML gateway/sidecar 是优势；拆取网格同步、日志和 preload 更费工程 |
| Node/Rust 资源 | 既有转换 SDK | 最小 Node gateway 加独立 Rust sidecar；本次已避免整 Electron 构建 |

因此 GenOffice 对“修改现有 XLSX、尽量保留未改 OOXML”有实际优势；Univer FORCED 的内容语义已经通过，不能把它笼统判为对象丢失。若要求完整 Excel 网格体验，GenOffice 仍需要裁剪迁移，不是免接入的现成嵌入 SDK。

## React/Tauri 改装与最小可编辑范围

- 已提供的 Node `integration.bundle.mjs`（构建生成）和浏览器纯 `view-model.mjs` 可支撑本次薄 grid。主 File 服务必须承担权限、真实归属、会话绑定、CAS/版本/hash、串行编辑与业务提交；本包不具备这些产品约束。
- 真实 gateway 有 Node fs/crypto/path，不能直接放入 Tauri WebView。可复用主项目 Node runtime 承载 gateway，Rust CLI 用受控 sidecar 进程；如果希望纯 Rust 宿主，还需移植 TypeScript mutation planner，不能因两边都有 Rust 就认为可以直接链接替代。
- Rust CLI 的 JSONL v1 包含 open/read_range/read_formula_cells/read_media/recalc_cells/close 及 archive manifest/read/save；主宿主应保持协议与限额。平台二进制构建/签名/分发、进程退出和会话重建仍是接入工作。
- 已验收最小编辑：可见 sheet 的纯文本、数值、上述数值结果公式，以及依赖/跨表缓存；原有字体和未编辑对象保留。图表/图片/CF/DV/merge/结构编辑、完整撤销和大表不在已验收范围。
- 完整网格迁移需接上上游 import→Univer 映射、edit journal、公式完成状态与 `formulaValues`、visual overlays、流式范围及 Electron preload 替换。薄 grid 成功只证明接口接缝，不估算未测的整应用迁移时长。

## watermark / branding / 许可

已扫描实际使用的公开 gateway、zip-gate、Rust runtime 及部分 renderer：未发现运行时强制 watermark/branding/许可注入；匹配仅为“避开 Pro presets”的说明及已有水印绘图测试。npm 安装没有 `@univerjs-pro` 或 EE 依赖。真实输出没有新增 branding 部件或改 creator/Company。

上游 `create-univer.ts` 专门组合免费 Apache presets；Sheets App 的自有品牌/ribbon 属于完整 UI，未在本包运行。上述结论覆盖已执行保存链及所读源码，不宣称完整 UI 没有任何品牌。保留 LICENSE/NOTICE；实际发行还须依据依赖/字体生成第三方通知，本实验不移除许可逻辑。

## 源引用

- [gateway planner 与缓存写入](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/xlsx-gateway/src/gateway/xlsx-gateway.ts#L850)
- [真实 streaming save](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/xlsx-gateway/src/gateway/xlsx-package-io.ts#L144)
- [Node sidecar client](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/main/xlsx-sidecar-client.ts)
- [IronCalc 实现](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/native/xlsx-engine/src/recalc.rs)
- [免费 Univer presets 组合](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/create-univer.ts)
- [GUI 流式/计算模式](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/univer-sync.ts)
- [GUI 保存缓存收集](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/save-actions.ts)
- [gateway 独立包依赖](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/xlsx-gateway/package.json)、[LICENSE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/LICENSE)、[NOTICE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/NOTICE)
- [既有 Univer XLSX findings](../office-validation/evidence/xlsx/findings.md)，GUI font/metadata 问题按用户与主 agent 的实际验收记录，未由本包重跑。

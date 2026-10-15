> 历史证据来源：2026-10-13 的 `$VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx`。此文中的临时文件名是历史引用；归档复跑命令与当前文件清单以 ../../README.md 为准。

# DOCX 直接 Univer SDK 实际验证

路径约定：`$VALIDATION_TMP_ROOT` 为原验证产物的临时根目录。复跑前按环境设置；历史临时产物不随仓库提供。


日期：2026-10-13。关联 #118 / F03。工作包见 `work-package.md`。仅在本目录创建生成器、脚本、样本、候选和证据；没有修改主项目源码$HOME package/共享依赖，没有打开应用窗口、运行全量测试、派子 agent 或自行运行 LibreOffice。

## 结论

**内容编辑链可用范围为 limited；完整保真验收仍为 failed。** 显式 `DocxCompatibilityMode.TRADITIONAL` 确实保留两个样本的纸张尺寸与主要页边距。不能将默认/modern 的纸张变化归因到 traditional：三种模式均实际测试并分别存档。

18 条转换（3 模式 × 2 样本 × aggregate 无改、unit 无改、unit 编辑）都成功执行导入、导出、SDK 再导入和独立 python-docx 重开。没有仅以文件非空或 ZIP 可读判成功。显式 traditional 的每条候选通过 16 项中 15 项断言，保留原 `sections` 严格断言失败：导出省略了原来的 `w:pgMar/@w:gutter="0"` 以及 `w:cols/@w:space="720"`。这不是纸张尺寸/主要边距失败；这些省略项是否影响视觉布局未在本 agent 中验收，因此未放宽断言改称 passed。

默认结果与显式 modern 的 `documentStyle` 和 `body.sectionBreaks` 在两个样本中完全一致（`mode-diagnostic.json`）；两者 `documentFlavor=2`，显式 traditional 为 1。可据本版本、本输入和本入口的实测推断默认产生 modern 模型，而不是 traditional。声明提供枚举但未声明默认值；Node 包实际把 options.compatibilityMode 传入原生导入。此处不推断其他 SDK 版本的默认行为。

默认/modern 的页面从 simple 的 12240×15840 twips、complex 的 11909×16834 twips，统一变为 14400×16840；top/bottom 从 1440、left/right 从 1800 变为 750 twips。Traditional 的上述值全部保持原值。失真已在导入 `documentStyle`/`sectionBreaks` 可见，aggregate 无改链和产品模型无改链均可复现。

## 实际 API 家族

读取实际 `@univerjs-pro/exchange-node/lib/types/index.d.ts` 与 README 后执行：

- **完整 protocol aggregate**：`importBufferToSnapshot(input, options)` 得到 `{snapshot,sheetBlocks}`，`exportSnapshotToBuffer(aggregate, options)` 导出。DOCX 的 snapshot 键为 unitID/type/rev/doc；doc 包含 unitID/rev/creator/name/resources/originalMeta。sheetBlocks 为空。它不是 WebSDK 的 UI 产品快照，本轮仅验证无改往返。
- **产品内存模型**：`importBuffer(input, options)` 得到 `IDocumentData`，可交给 WebSDK `createUnit(UNIVER_DOC, unit)`。`exportToBuffer(unit, options)` 导出。该家族实际执行无改与编辑两条链，并重开候选核对。
- 输入 options 包含 `type: UniverInstanceType.UNIVER_DOC`、`format: ExchangeFormat.DOCX`、fileName；traditional 显式传 `DocxCompatibilityMode.TRADITIONAL`。输出 options 为同 type/format。

产品模型关键字段：`body.dataStream/textRuns/paragraphs/tables/sectionBreaks/customBlocks/customRanges`，`documentStyle`，`tableSource`，`headers`，`footers`，`drawings`，`drawingsOrder`，`resources`。表格文字也在 body.dataStream 内，tableSource 存表格结构/样式；图片在 drawings 中，报告仅打印字段名，不打印图片 base64。

## 样本与断言

simple：中文 Title、Heading 1、待编辑段落、未编辑粗体段落、2×2 表格、160×80 PNG、图片后的未编辑段落。complex 另有两套独立页眉页脚、显式分页、分节、分页后/分节后中文内容、外部超链接。

固定 16 项断言：正文段落完整序列、表格完整矩阵、标题文本及样式 ID、图片 extent、原始 sections 属性、所有页眉页脚文本、引用数、逐节页眉页脚绑定、显式粗体内容、显式分页数、超链接目标、页面尺寸及主要边距、section 数及 break type、图片字节 SHA256、图片像素 SHA256、图片尺寸。未删除失败断言。`*.checks.json` 存每项 expected/actual。

所有模式下中文段落、表格、未改正文、标题、粗体、图片字节/像素/尺寸、图片 extent、超链接、显式分页和逐节页眉页脚绑定均通过。Complex 保持两节及各自页眉页脚；结构通过不代表视觉页数和页序已经验收。

| 模式 | 样本 | 链 | 全部断言状态 | 失败项 |
| --- | --- | --- | --- | --- |
| default | simple | aggregate-noop | failed | sections, page_size_and_main_margins |
| default | simple | unit-noop | failed | sections, page_size_and_main_margins |
| default | simple | unit-edited | failed | sections, page_size_and_main_margins |
| default | complex | aggregate-noop | failed | sections, page_size_and_main_margins |
| default | complex | unit-noop | failed | sections, page_size_and_main_margins |
| default | complex | unit-edited | failed | sections, page_size_and_main_margins |
| modern | simple | aggregate-noop | failed | sections, page_size_and_main_margins |
| modern | simple | unit-noop | failed | sections, page_size_and_main_margins |
| modern | simple | unit-edited | failed | sections, page_size_and_main_margins |
| modern | complex | aggregate-noop | failed | sections, page_size_and_main_margins |
| modern | complex | unit-noop | failed | sections, page_size_and_main_margins |
| modern | complex | unit-edited | failed | sections, page_size_and_main_margins |
| traditional | simple | aggregate-noop | failed | sections |
| traditional | simple | unit-noop | failed | sections |
| traditional | simple | unit-edited | failed | sections |
| traditional | complex | aggregate-noop | failed | sections |
| traditional | complex | unit-noop | failed | sections |
| traditional | complex | unit-edited | failed | sections |

## 实际编辑与浏览器交接

Node 实际修改产品模型中的两处 body.dataStream，长度保持不变，未移动 textRuns/paragraph/table/section 的索引。导出并再次导入后，新中文段落和新单元格同时存在，python-docx/OOXML 内容矩阵也准确匹配。

| 目标 | UTF-16 范围（end exclusive） | 对象定位 | 修改 |
| --- | --- | --- | --- |
| 中文段落 | [18,31) | para_2，段落结束索引 31 | 待修改中文段落：春风拂面。 → 已修改中文段落：秋风拂面。 |
| 单元格 | [71,75) | table-1 / para_7；row=1,column=1（从 0 起） | 待改单元 → 已改单元 |

两样本目标范围相同。table 范围 startIndex=48,endIndex=80。**仅直接快照修改，不是 GUI、命令/Facade、撤销或用户选区验收。** 主 agent 后续应通过 WebSDK 的实际编辑动作生成保存模型，并独立导出核对。

当前 `imported-unit.json` 已更新为 **simple + 显式 traditional**，default 原产品模型保留在 `simple.imported-unit.json`，traditional 另存 `simple.traditional.imported-unit.json`；complex 对应 `complex.traditional.imported-unit.json`。浏览器交接路径、checksum 和目标见 `browser-targets.json`。完整 protocol aggregate 不应用作 UI 产品模型。

## 版本、性能与校验和

Node v24.19.0，darwin arm64。Exchange/core/collaboration 均 1.0.4；exchange-node-binding 1.0.2（遵循发布包真实依赖）。原生平台包为 exchange-node-binding-darwin-arm64。Python 使用用户指定的 bundled 环境：python 3.12.14, python-docx 1.2.0, Pillow 12.3.0, lxml 6.1.1, exchange-node-binding-darwin-arm64 1.0.2。

Traditional 同一进程样本转换：module import 480.7 ms；单次导入 8.5–32.4 ms（包含首次调用）；导出 6.7–8.6 ms；再导入 7.9–9.1 ms；独立 Python 重开/检查 64.6–174.2 ms。整批含加载与检查 1200.5 ms；进程 max RSS 417.8 MiB。这是小型受控样本的一次测量，不是吞吐/大文件/UI 性能承诺。初次 probe 产品模型转换约 773.6 ms；默认批 module import 373.3 ms，modern 370.1 ms。分步原始 timing 均在 results*.json。

| 文件 | SHA256 |
| --- | --- |
| simple 原件 | `b41ac08b4c1eae689a25280fdbb9a772d8ff9b242979ab2f76d81ea330fbb8da` |
| simple traditional 编辑候选 | `de93f391493438ee57bae4ce370798fa218262c8e3f7b874d1adba889c0580b2` |
| complex 原件 | `7b9750877adf72cd9817edf8582979a6877f3bc67f4cc0267dcb7e2041067f09` |
| complex traditional 编辑候选 | `dc51b2e6665b507e535010bfd90c8e34de815ff6cc33cf679e281ddfc3dcc86c` |

所有候选的 checksum/字节数在 results*.json；原件生成后未覆盖，fixtures.json 保留最初基线。运行时没有出现 license 拒绝或要求输入许可凭证；未提供凭证、未跳过任何运行时检查。该事实仅表明本轮转换可执行，不是授权范围结论。

## 可复跑命令

共享依赖只由主 agent 安装，本目录脚本不会安装或修改依赖。原件已存在时不要重新生成；fixture.py 的 generate 会拒绝覆盖。

```sh
node $VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx/validate.mjs --traditional
node $VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx/validate.mjs
node $VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx/validate.mjs --modern
"${OFFICE_VALIDATION_PYTHON:-python3}" $VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx/fixture.py compare $VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx/complex.original.docx $VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx/complex.traditional.unit-edited.docx edited $VALIDATION_TMP_ROOT/project-mind-univer-validation-20261013/docx/complex.traditional.unit-edited.checks.json
```

新目录的样本生成命令：将 fixture.py 复制到新的空 fixture 目录后，用 bundled Python 执行 `fixture.py generate`。无需修改 package；Node 脚本保持在本共享根的子目录以解析已装包。

## 最小适用范围与剩余条件

现有证据支持 **显式 traditional 的受控中文段落/2×2 普通表格内容修改与原格式导出**，且本轮未改图片、页眉页脚、分页及超链接均保留。不能推及合并单元格、修订、域、脚注、目录、嵌入对象等未测试字段；没有搭建兼容补丁或兜底框架。

继续 F03 的具体条件：主 agent 对 traditional 原件/候选集中执行 LibreOffice 或其他原格式工具外部重开与分页渲染，核对 cols/gutter 省略的视觉影响；用交接的产品模型验证 WebSDK 的实际编辑与输出；目标 Tauri/WebView 的中文输入、保存/版本/CAS 仍是后续接入验收。当前 Node 试验没有阻塞，主项目 Office 功能及 Issue #118 仍未交付。

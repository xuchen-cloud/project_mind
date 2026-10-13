> 历史证据来源：2026-10-13 的 `/tmp/project-mind-univer-validation-20261013/pptx`。此文中的临时文件名是历史引用；归档复跑命令与当前文件清单以 ../../README.md 为准。

# #118 / F03 PPTX：Univer 1.0.4 直接 SDK 实际验证

## 结论

**基础文字、三页页序、图片字节/位置通过；复杂内容保留失败。** 简单样本整体为 `limited`，复杂样本为 `failed`。产品模型链与完整 protocol aggregate 链的无修改导出逐字节相同；它们都不是复杂 PPTX 的无损保存路线。本轮只验证转换和真实产品模型编辑，Web 人工编辑与 LibreOffice/PDF 外部重开由主 agent 补充，不能据此宣称 F06 或 #118 已交付。

## 样本与真实编辑

- 简单原件 `simple.original.pptx`：三页中文、独立文本框、第一页一张 PNG、固定 `PAGE-1/2/3` 页序标识。模板默认仍带 1 个 master 与 11 个 layout。
- 复杂原件 `complex.original.pptx`：在同样三页基础上加第二页 3×3 原生表格、第三页原生簇状柱状图（中文类别、业务数量 12/24/18 与嵌入 XLSX），每页中文 speaker notes，实际使用 Title Slide、Title Only、Blank 三种 layout。
- 实际文字编辑：第一页“项目进展正常”→“项目进展更新”，六字同长度；修改产品模型富文本 `dataStream` 与相应普通 `text`，保留段落与 run 索引。
- 实际图片编辑：原 PNG 字节保持不变，`transform.left` 从 57.6 改到 75.6，即右移 18 points / 0.25 英寸 / 228600 EMU；导出后 Python 核对 left 960120、top 2560320、width 2926080、height 1645920。
- 原件 checksum 在实际验证前后均不变；生成器拒绝覆盖已有原件。全部候选另存为 `*.product-unchanged.pptx`、`*.aggregate-unchanged.pptx`、`*.edited.pptx`。

## 验证链与判定

| 检查 | 简单样本 | 复杂样本 |
| --- | --- | --- |
| 产品模型 importFile → exportToBuffer 无修改对照 | API 成功；内容范围 limited | API 成功；复杂保留 failed |
| aggregate importFileToSnapshot → exportSnapshotToBuffer 无修改对照 | 同产品模型输出 SHA-256 | 同产品模型输出 SHA-256 |
| 产品模型文字修改 + 图片移动 → 导出 → 再次导入 | 修改真实生效 | 修改真实生效 |
| 独立 python-pptx 文字、页序、字体/字号、文本框几何、图片 hash/几何 | 通过 | 通过 |
| 未编辑表格内容 | 不含表格 | 3×3 中文/数字原文通过 |
| speaker notes、notes master | 不含备注 | 3 页备注、1 个 notes master 全丢失 |
| 图表模式与可解析性 | 不含图表 | 原 `clustered` 变 `standard`，python-pptx `.chart_type` 报 `KeyError: 'standard'` |
| 图表中文类别、系列名、数值缓存 | 不含图表 | 仍为一月/二月/三月、业务数量、12/24/18 |
| 图表嵌入 workbook | 不含图表 | 单元格值保留，工作表 Sheet1 改名 ChartData，图表公式引用同步改写；原身份断言失败 |
| ZIP CRC 与关系目标存在性 | 通过 | 通过，但 notes 关系被删除 |

导入时复杂产品模型没有 `speakerNotes`、`notesMasterPages`；虽然类型声明提供这些字段，实测并未带入。导出复杂包也没有 `ppt/notesSlides/notesSlide*.xml`、`ppt/notesMasters/notesMaster*.xml`。因此丢失不是仅由编辑造成，aggregate 无修改对照亦失败。

**保留所有失败断言。** `*.verification.json` 各有 42 条独立检查；简单每条链 6 个 XML hash 失败，复杂每条链 16 个失败。初期 python-pptx 图表类型错误阻断清点后，校验器补充了 XML 图表缓存读取并保留该解析错误，使剩余表格/图片/备注断言也可完整执行。未通过删断言或吞 SDK 错误取得 passed。

## 母版、版式语义与 XML 诊断

所有 layout/master XML hash 差异均保留在 `*.verification.json` 与 `*.diff.txt`。**hash 不同只证明重写，不单独证明语义内容丢失。** `semantic-results.json` 使用已有候选文件核对以下属性，没有重复运行 SDK。

已保留：1 个 slide master、11 个 layout 的集合与名称；三页实际使用的 layout 引用；layout→master 与 master→theme 关系；母版与已使用 layout 的占位符数量、类型和 idx；主主题 `theme1.xml` 的 12 个解析色值与 major/minor 字体（含中文脚本字体）；物理页宽高 12191695×6858000 EMU；已使用 layout 的占位符有效几何。原 layout 未声明坐标的占位符按对应 master 类型解析后，几何与导出显式坐标相同，不能把这种显式化当位置丢失。

实际损失/改写：

1. master 与 layout 的日期/页码占位符原有 `a:fld type="datetimeFigureOut"`、`a:fld type="slidenum"`，导出均消失，变成普通文本 `Click to edit Master text styles`。Blank layout 原日期 `1/27/13` 与页码提示 `‹#›` 不再保留。这是动态字段语义丢失；本 fixture 未启用正文页脚展示，不能推定当前三页正文出现可见变化。
2. master body 占位符原五段示例（含 Second level～Fifth level）导出只剩一段；标题、日期和页码提示也改成统一正文提示。说明后续基于该模板编辑/新建页的模板结构不完整，现有正文文本仍通过。
3. 日期/页脚/页码的 `sz="half"/"quarter"` 被省略为默认 full；未使用 layout2/5/8 的 obj/twoTxTwoObj/objTx、layout9/10/11 的 picTx/vertTx/vertTitleAndTx 改成 blank；layout4 的 twoObj 改成 twoColTx。layout2/4/5/8 的内容占位符类型也被改写（原 obj 变成 body），不能声称全部 11 个 layout 的占位符语义保留。已使用的 Title Slide/title、Title Only/titleOnly、Blank/blank 类型保留。
4. 页尺寸标识从 screen4x3 变 custom，但原 fixture 已手动设 13.333×7.5 英寸，物理宽高未变；这是尺寸标识规范化，不称页面尺寸丢失。
5. master 背景从 theme/bg1 引用变成显式白色，layout 背景也显式化；原 theme1 的 bg1→lt1 白色映射保留，不因表示变化判视觉丢失。
6. 复杂样本随 notes master 使用的 `theme2.xml` 被删，与备注部件损失一致；主 slide theme1 保留。

## Web 编辑交接

`imported-unit.json` 是简单样本 `ISlideData` 产品模型，适合 `univer.createUnit(UniverInstanceType.UNIVER_SLIDE, unit)`。`*.aggregate.original.json` 是 `{snapshot,sheetBlocks}` protocol aggregate，不能直接当 UI unit；PPTX 的 sheetBlocks 实测为空。

| 定位 | 简单 | 复杂 |
| --- | --- | --- |
| unitId / slideId | rust-pptx-unit / slide-1 | rust-pptx-unit / slide-1 |
| 文字 elementId / type | shape-3 / shape | shape-5 / shape |
| 图片 elementId / type | image-5 / image | image-7 / image |
| 文字路径 | slides.slide-1.elements.shape-3.shapeData.shapeText | slides.slide-1.elements.shape-5.shapeData.shapeText |
| 实际富文本路径 | 上述路径 + .dataModel.doc.body.dataStream | 同左 |
| 图片位移 | transform.left 57.6→75.6 | 同左 |

图片 source 为 data URL；快照文件保留受控 fixture 数据，工具输出只给概要、hash 和元素定位，没有输出图片 base64。`*.edit-locator.json` 和 `*.structure-summary.json` 可直接供主 agent 使用。

## 版本与耗时

- macOS darwin arm64，bundled Node v26.8.1；`@univerjs-pro/exchange-node`、`@univerjs-pro/slides`、`@univerjs/core` 均 1.0.4；exchange-node-binding 1.0.2 是 SDK 自带依赖。
- Python 3.12.14、python-pptx 1.0.2、Pillow 12.3.0、lxml 6.1.1；图表 workbook 用 openpyxl 读取。
- 两个样本分别完整执行 8 个转换步骤。简单产品导入 8.316ms，aggregate 导入 5.816ms，无改产品/aggregate 导出 3.157/2.167ms，编辑导出 2.396ms、编辑再次导入 4.452ms。
- 复杂产品导入 8.763ms，aggregate 导入 7.530ms，无改产品/aggregate 导出 3.184/2.811ms，编辑导出 3.068ms、编辑再次导入 6.670ms。此为一次已加载模块的测量，不代表大文件/冷启动或 Web 编辑时延。
- 本轮没有注入许可、没有绕过 license 检查、没有输出许可凭证；列出的 API 调用未抛运行时许可错误。该事实只覆盖当前 SDK/API/样本执行范围。

## Checksum

完整 checksum、大小、每步耗时见 `results.json` 与 `sdk-results.json`。

| 文件 | SHA-256 |
| --- | --- |
| simple.original.pptx | 0ba04d437657fec81a5c0ebcbd896bac03fddb3498c07ef8f035db24a4fe769d |
| complex.original.pptx | dd650366d8e764a6b088df6cd531b0747c1ad01a99f23abe8d5f361dfbe3f891 |
| simple.edited.pptx | fd2cb8000797014fdadf64ddcd682ab984b4d3efe8f04ea82abdbd306013d19a |
| complex.edited.pptx | aab8203b4953cd6524b3e36f2a688276287f0b5577ae22eedf97b63fbb9967cd |
| 原/导出 PNG | 4e345e8790a8a3b9e0d57e5c60abb33f5890b757c05e3acd49d2bff63558c305 |

## 可复跑命令

目录为 `/tmp/project-mind-univer-validation-20261013/pptx`。只读取共享 node_modules，不安装、不更改 root package。

```sh
node /tmp/project-mind-univer-validation-20261013/pptx/validate_sdk.mjs
"${OFFICE_VALIDATION_PYTHON:-python3}" /tmp/project-mind-univer-validation-20261013/pptx/verify_pptx.py simple /tmp/project-mind-univer-validation-20261013/pptx/simple.edited.pptx edited
"${OFFICE_VALIDATION_PYTHON:-python3}" /tmp/project-mind-univer-validation-20261013/pptx/verify_pptx.py complex /tmp/project-mind-univer-validation-20261013/pptx/complex.edited.pptx edited
"${OFFICE_VALIDATION_PYTHON:-python3}" /tmp/project-mind-univer-validation-20261013/pptx/verify_semantics.py
"${OFFICE_VALIDATION_PYTHON:-python3}" /tmp/project-mind-univer-validation-20261013/pptx/collect_results.py
```

无改链独立校验：把格式参数替换为 `product-unchanged` 或 `aggregate-unchanged`，并将文件路径对应改为 `simple.product-unchanged.pptx` 等；现有六组结果均已保存可复用。严格校验脚本因保留的失败断言会返回 exit 1；不能把有结果 JSON 或非空 ZIP 当作成功。生成器 `generate_samples.py` 只在无原件的空格式目录首次使用，已有原件时拒绝覆盖。

## 最小适用范围与解锁条件

实际可编辑范围：受控独立文本框的同长度中文替换、PNG 的位置变更；三页页序与未编辑正文文字/字体/几何保留，表格内容可保留。**仅能作为无备注、无复杂图表、接受模板规范化的简单文稿候选**，仍须主 agent 完成 browser 编辑、外部重开与视觉核对后确认。

复杂保存的具体解锁条件：转换链保留每页 speaker notes/notes master 与其主题；簇状柱状图模式可被独立工具正确解析；动态日期/页码字段与母版层级结构保留，或建立有证据的明确格式拒绝/限制策略并保存原件。当前不应对含这些内容的文件允许静默保存。本轮没有修改主项目，也没有新建格式兼容框架来掩盖损失。

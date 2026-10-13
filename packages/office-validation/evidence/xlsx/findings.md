> 历史证据来源：2026-10-13 的 `/tmp/project-mind-univer-validation-20261013/xlsx`。此文中的临时文件名是历史引用；归档复跑命令与当前文件清单以 ../../README.md 为准。

# #118 / F03：Univer SDK 1.0.4 XLSX 实际执行结果

## 结论

**最小适用范围为 limited。** 直接 SDK 的产品内存模型链已实际完成中文文本、数字、简单公式修改→XLSX 导出→SDK 再次导入，并经独立 openpyxl 与 ZIP/XML 核对。在这两份受控样本中，显式 `formulaCalculation: FORCED` 的数据与计算语义通过；这不表示原 XML 严格不变、浏览器保存或 #118/F05 已交付。

**真实失败：默认导出策略会留下过期的依赖公式缓存。** 原样保留已有缓存的 B7 `=B3*2` 和 说明!B3 `='明细'!B5`，编辑 B3=15、B5=`=SUM(B3:B4)+5` 后，默认 WHEN_EMPTY 导出得到 B5=40、B7=20、说明!B3=30。期望分别为 40、30、40。显式 FORCED 的输出正确。不能仅删掉修改目标的缓存就宣称所有依赖公式已更新。

复杂样本的严格保留检查仍为 **failed**（7/84 个断言不同）；新增独立语义判断将这些差异分类为等价重序列化、默认属性补全和正确的依赖数据缓存更新，**没有在本次覆盖的属性中发现实际对象丢失**。原严格断言与 counts 保留，不改为 passed。

## 环境与实际 API

- 执行日期：2026-10-13，macOS darwin / arm64。
- 此执行 agent 实际使用用户提供的 bundled Node：`v24.19.0`；主 agent 的 `v26.8.1` 探针是另一运行环境，不混写。
- Python：3.12.14；openpyxl：3.1.5；lxml 与 PIL 由 bundled runtime 提供。
- `@univerjs-pro/exchange-node`：1.0.4；其实际 native dependency `@univerjs-pro/exchange-node-binding`：1.0.2（这是 SDK manifest 自身指定的版本）。
- SDK cold load：380.288 ms；本轮 6 条转换分支总耗时（含装载与 JSON 文件写入）413.795 ms。独立比对耗时在 `results.json` / `semantic-results.json` / `reimport-results.json` 中记录。
- 不配置许可、不提取许可、不改 runtime license 检查；本机上述 API 真实调用未出现运行时许可错误。此事实仅指本次转换 API，不推论其他 Pro 功能。
- 声明读取来源：共享安装目录的 `node_modules/@univerjs-pro/exchange-node/lib/types/index.d.ts` 和 README。没有安装或修改任何共享依赖。

两类 API 分开运行：

1. 产品模型：`importFile(path,{type:UNIVER_SHEET,format:XLSX})` → `IWorkbookData`，可作为 Web SDK 创建 unit 的输入；`exportToBuffer(unit,{type,format,formulaCalculation:FORCED})`。
2. 完整 protocol aggregate：`importFileToSnapshot(path,options)` → `{snapshot,sheetBlocks}`；`exportSnapshotToBuffer(aggregate,options)`。只作为无编辑保留对照，未拿它冒充 Web SDK unit 或 UI 保存验证。
3. 输出统一通过 `importBuffer(buffer,{type,format,fileName})` 再次导入产品模型，再次导入断言 6 条分支均通过。

数字在 SDK 输入产品模型中实际呈现为 `{v:"10",t:2}`。首轮验证器错误假设 v 必须是 JS number，编辑前置检查因此失败；`attempt-1-sdk-results.json` 保留该失败。修正为同时检查 `t===NUMBER` 和数值等于 10 后执行编辑，没有删掉前置条件或篡改结果。

## 样本与编辑

| 样本 | 内容 | 原件大小 |
| --- | --- | --- |
| simple.original.xlsx | 明细、说明两张中文 sheet；中文值、SUM、依赖公式与跨表公式；A1:C1 合并；字体、填充、边框；金额/百分比/小数格式；换行、行列尺寸、freeze panes | 6,188 bytes |
| complex.original.xlsx | 上述内容，加 B3:B4 条件格式、C3:C4 中文列表验证、柱形图与标题/轴标题、PNG 图片、隐藏数据 sheet | 9,106 bytes |

实际只修改 明细!A3=`香蕉（SDK编辑）`、B3=15、B5=`=SUM(B3:B4)+5`。B7 及跨表 B3 的公式字符串保持不变，但缓存应随依赖更新。图表未编辑，数据源涉及 A3/B3，因此导出图表缓存更新是正确行为。

生成器在原件的 XML 中显式播种已知基线缓存 B5=30、B7=20、说明!B3=30；openpyxl 本身不计算公式。SDK 导出文件的缓存没有由验证脚本补写。两份原件 SHA-256 仍与 fixtures.json 完全一致。

## 严格断言与语义断言

| 样本/API/分支 | 严格 assertions / failed | 严格状态（保留） | 所覆盖语义判断 | 导入/导出/再次导入 ms |
| --- | --- | --- | --- | --- |
| simple / unit / noop | 70 / 4 | limited | passed | 3.147 / 2.132 / 0.784 |
| simple / unit / edited | 70 / 4 | limited | passed | 3.147 / 1.560 / 0.819 |
| simple / aggregate / noop | 70 / 4 | limited | passed | 0.843 / 1.056 / 0.735 |
| complex / unit / noop | 84 / 7 | failed | passed | 1.922 / 2.154 / 1.203 |
| complex / unit / edited | 84 / 7 | failed | passed | 1.922 / 2.040 / 1.266 |
| complex / aggregate / noop | 84 / 7 | failed | passed | 1.133 / 2.224 / 1.271 |
| simple / unit / edited-default | 70 / 6 | failed | failed：2 个真实缓存错误 | 单独探针 65.856 ms |

语义判断为追加结果，原严格检查在 results.json 里没有删除、修改通过状态或调整 counts。无编辑往返也存在全部相应 XML 差异，不能将其全部归因于人工编辑。

### XML 差异的独立分类

| 严格失败项 | 实际差异 | 已证明的语义范围 |
| --- | --- | --- |
| 明细!A1/A2/B2/C2 样式 | `font family=2` 补全；solid fill 补 `bgColor indexed=64`；边框补空 left/right/top/diagonal sides | 名称 Arial、字号、粗体/颜色及其他本样本字体属性、solid 前景色、实际边线/颜色、对齐、保护、数值格式一致。family 属性自身确有变化；特定渲染器中的字体 fallback 和像素外观未证明 |
| conditional_formatting | 阈值 `12` → `12.0` | 范围 B3:B4、greaterThan、priority、阈值数值、differential fill 均一致 |
| data_validation | 缺省 errorStyle 补成 `stop` | 列表、范围、allowBlank、中文错误标题/正文、showErrorMessage、下拉设置及缺省错误行为一致 |
| charts | 标题引用 B2 → $B$2；文字类别 numRef → strRef；新增正确的 strCache/numCache | 柱形图类型/方向/grouping/gapWidth、全部标题、归一化源引用、完整轴属性树、drawing anchor、series 顺序一致；输出缓存独立与当前 worksheet 数据比对通过 |

图表无编辑往返缓存为 金额 / 苹果、梨子 / 10、20；编辑分支为 金额 / 香蕉（SDK编辑）、梨子 / 15、20。原图表缓存为空，新增缓存并不是丢失原数据。XML 数值类别引用改为实际字符串类别引用，在本 fixture 的文本类别中保留源数据语义。

图表在 Excel/LibreOffice 的原生渲染、字体度量、标签遮挡、像素位置和交互效果未验证；未覆盖其他图表族或高级图表功能。单个 controlled chart 的语义通过不证明全部图表保真。

### 通过的保留检查

- 所有非空单元格/公式字符串和编辑目标；没有意外新增非空单元格。
- FORCED 下全部公式缓存和跨表依赖缓存；再次导入的文本、数字、公式、缓存。
- sheet 顺序/名称/可见性，隐藏数据 sheet 仍 hidden，值 99 与中文保持。
- 合并 A1:C1、冻结窗格、行列尺寸、金额/百分比/小数格式。
- PNG 文件字节 SHA-256、图片尺寸与 anchor 完全一致。
- CF differential styles 与对应 fill 完全一致；DV 语义一致。
- 没有删除原件 OOXML parts；加入 `xl/sharedStrings.xml` 与 `xl/calcChain.xml`，多个 XML parts 被重序列化。完整列表在 results.json。

此结果未将非空 ZIP 当成功。实际输出由 openpyxl 按公式/缓存两种模式读取，且独立读取 worksheet/chart/media XML，并再次交给 SDK 导入。

## 浏览器交接

- `imported-unit.json`：simple 的完整 IWorkbookData，**不包含 aggregate wrapper**，受控样本无私密数据。
- `browser-targets.json`：当前 unit ID、sheet ID、零起始行列、编辑字符串/数值/公式及 FORCED 导出 options。
- sheet ID 为 `uni1`（明细）；A3=(row 2,col 0)、B3=(2,1)、B5=(4,1)。unit ID 以 JSON 中当前值为准。
- 复杂样本 Web SDK 输入可用 `complex.unit.imported.json`；简洁概要是 `complex.unit-summary.json`，仅打印资源名称与长度，未打印图片 base64。
- 模型包含 workbook `_xlsx` 的 sourcePath/themeXml、worksheet `_xlsx.raw`，复杂样本另有条件格式/数据验证/drawing/chart/raw legacy drawing 资源。这些字段在直接转换链保留。**Web SDK createUnit → 用户编辑 → save 的快照是否保留必要元信息，需由主 agent 的浏览器探针实际验证**，当前执行不代替该环节。
- 此执行未开窗口、未自行运行 LibreOffice。外部工具重开由主 agent 统一验证两份原件、两份 unit.edited 输出；默认策略输出可作为过期缓存的对照。

## 可运行命令

在 `/tmp/project-mind-univer-validation-20261013/xlsx` 中，依赖由主 agent 准备后执行以下各条命令。当前已有原件，generate.py 会校验并复用，不覆盖。

```bash
"${OFFICE_VALIDATION_PYTHON:-python3}" generate.py
node validate.mjs
node default-calculation-probe.mjs
"${OFFICE_VALIDATION_PYTHON:-python3}" compare.py
"${OFFICE_VALIDATION_PYTHON:-python3}" reimport-check.py
"${OFFICE_VALIDATION_PYTHON:-python3}" semantic.py
```

`default-calculation-results.json` 用同一 compare() 对 `simple.unit.edited-default.xlsx` 进行独立比对。复跑快捷命令：

```bash
"${OFFICE_VALIDATION_PYTHON:-python3}" -c 'from compare import *; r=compare(ROOT/"simple.original.xlsx",ROOT/"simple.unit.edited-default.xlsx",True); (ROOT/"default-calculation-results.json").write_text(json.dumps(r,ensure_ascii=False,indent=2))'
```

若只重查严格/语义诊断，复用现有 outputs，运行 Python 命令即可。本次增加语义判断时没有重跑转换或重新安装 SDK。

## 文件索引与 checksum

- `fixtures.json`：样本构造、已知期望、原件 hash。
- `sdk-results.json`：版本、timing、转换结果和 output hash；“exported_pending_independent_validation”仅是转换阶段，不是整体验收状态。
- `results.json`：严格独立断言、原/输出缓存 XML、差异 parts、原件 checksum 未变。
- `semantic-results.json`：追加语义检查与无法证明的性质；严格 status/counts 保留。
- `reimport-results.json`：再次导入明确断言。
- `default-calculation-results.json`：默认 WHEN_EMPTY 真实失败。
- `checksums.json`：所有样本/输出/脚本/结果/本报告的 SHA-256。

原件 SHA-256：

- simple：`4db4acbc91829621907faed84e7d1d79b05e85a7b0acd6dd5d6b96331943aa46`
- complex：`33966ea8ccc5fa0bab13d2cd345bfd969d5673794f11b5b454d4e78725dac8b2`

产品模型 edited 输出 SHA-256：

- simple：`2f92e856ac41fbc5642e8795a66cebe9bc00e94df7df533e21902a13ea261c7f`
- complex：`9f956d2073a41623ac633b66643df84f29b23a3014759fa48fa1f5d11b4a532a`

## 后续最小接入与解锁条件

最小可继续验证：两张中文 sheet、基本值、SUM/乘法/跨表依赖，明确强制计算；保留完整产品模型元信息。复杂 fixture 中已知 CF/DV/一个柱形图/PNG/隐藏 sheet 的受测语义可保留，但只称这个实例通过，不能泛化到全部 Excel 文件。

解锁完整 UI 保存结论：主 agent 对 imported-unit.json 实测 Web SDK 编辑与 save，导出 save 返回模型，复用这些独立断言；统一执行外部工具重开并记录原生显示结果。然后再验证主 File ID/CAS/版本/历史保存接缝。本执行包没有修改主项目源码/root package、没有窗口、全量测试或子 agent，不作为 review 或 Issue 发布。

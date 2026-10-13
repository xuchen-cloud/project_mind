# Office 候选验证 harness（#118 / F03）

这是 2026-10-13 Univer SDK 1.0.4 试验的可复跑归档，独立于主项目依赖与 File 服务。**本包不计作 Word/Excel/PPT 格式交付，也不表示 #118 完成。** Vite 只把受控模型导出到本包 `browser/output/`，不写主 File，不提交版本、CAS 或数据库。

**PPT 必须无水印。当前 Slides Pro 截图有明显水印，方案判定不接受。** 基础文字/页序/图片编辑通过不能覆盖该硬要求；复杂 PPTX 的备注丢失、图表模式改写及母版字段损失也保持 failed/limited。GenOffice 验证属于另一个工作范围。

## 目录与证据

- `docx/`、`xlsx/`、`pptx/`：样本生成器、Node 探针、独立 Python/ZIP/XML 校验器，各格式两份 original 和图片、相对路径 metadata。
- `browser/main.js`、`index.html`、`vite.config.mjs`：React 19 / Univer Web 候选宿主与本地导出接口。
- `evidence/<格式>/`：历史 findings 与精选 JSON。XLSX 严格结果和 PPTX 大份语义结果仅摘录，保留全部断言名称/结果和原状态；摘录字段在 JSON 的 `archival_selection` 说明。
- `evidence/browser/`：主 agent 提供的 Chromium/WebKit 浏览器 events（历史阶段证据，不代表修正后最终验收）。浏览器 checkpoint 与外部重开脚本由其他 agent 单独归档。

来源是 `/tmp/project-mind-univer-validation-20261013`。历史 evidence 中的临时路径只用于追溯，**不是归档运行依赖**；部分被引用的完整快照/输出没有归档，会由脚本重建。保留的 originals 是当次受控原件，metadata 的 checksum 与其字节对应。没有归档 node_modules、导入模型、aggregate、大份重复库存或候选 Office 输出。

**Word 候选宿主必须使用 Docs Core + Docs Drawing preset，配合 traditional 导入。当前 browser/main.js 已包含 UniverDocsDrawingPreset，不宣称 only-core 足够。** 历史失败不抹除：DocsCore 未注册 drawing 的宿主配置曾在 save 时丢失图片，主 agent 已修正配置并负责针对性复验；XLSX 键盘修改 A3 的字体变化以及各格式元数据写入 Univer.ai 均已记录。最新宿主结果以主 agent 的浏览器证据为准，不能以转换探针成功替代 Web 保存验证。

## 环境与安装

先进入此目录；后续命令均从本目录执行。Node 24 或 26 可用于这份 harness，历史分别测过 Node 24.19.0/26.8.1（macOS arm64）；其他平台 native binding 须按实际 optional 包核验。

```sh
cd packages/office-validation
npm ci --ignore-scripts
export OFFICE_VALIDATION_PYTHON="${OFFICE_VALIDATION_PYTHON:-python3}"
"$OFFICE_VALIDATION_PYTHON" verify-fixtures.py
```

使用本目录自己的 lock，不能在仓库 root 安装；`--ignore-scripts` 保留 npm 的平台 optional 原生包选择，不等于禁用 optional 包。不要加 `--omit=optional`：Exchange 依赖已发布的平台 binding（1.0.2 为 SDK 实际声明的依赖版本）。安装失败/平台二进制缺失按真实结果报告；不绕过运行时 license 检查，也不提供许可凭证。

Python 需要 `python-docx`、`python-pptx`、`openpyxl`、`Pillow`、`lxml`。若有已准备好的 Python 环境，将 `OFFICE_VALIDATION_PYTHON` 设为其解释器路径即可。DOCX Node 校验器使用 `process.env.OFFICE_VALIDATION_PYTHON || 'python3'`，无个人机器路径。原试验版本见 metadata/evidence；归档没有捆绑 Python 环境。

当前原件已归档，复跑只需核验 checksum 后执行探针。生成器行为保持：DOCX/PPTX 在原件存在时拒绝覆盖；XLSX 校验已有 manifest 的原件 hash 后复用，存在原件却没有 metadata 时也拒绝覆盖。需要重建时，在新的空归档副本中移除其复制的 original/metadata 后执行生成器，**不覆盖这份历史原件**。生成 OOXML 的时间戳可能使新文件 hash 不同，须使用新生成 metadata。

首次在空格式目录生成的命令：

```sh
"$OFFICE_VALIDATION_PYTHON" docx/fixture.py generate
"$OFFICE_VALIDATION_PYTHON" xlsx/generate.py
"$OFFICE_VALIDATION_PYTHON" pptx/generate_samples.py
```

## DOCX：traditional 页面模式

```sh
node docx/validate.mjs --traditional
```

每个简单/复杂样本运行 aggregate 无改、产品模型无改、产品模型真实中文段落/表格单元格修改，随后再次导入并由 `fixture.py compare` 独立重开。结果在 `docx/results.traditional.json`，供浏览器使用的 `docx/imported-unit.json` 也在该步骤生成。

需要比较默认/modern 的页面行为时分别执行：

```sh
node docx/validate.mjs
node docx/validate.mjs --modern
```

`docx/probe.mjs` 是默认模式结构探针，会覆盖浏览器导入模型；做 Web 验证前重新执行 traditional 验证。独立重查某个候选：

```sh
"$OFFICE_VALIDATION_PYTHON" docx/fixture.py compare docx/complex.original.docx docx/complex.traditional.unit-edited.docx edited docx/complex.traditional.unit-edited.checks.json
```

traditional 的纸张/主要边距通过不等于全部 section 属性保留，历史严格失败仍保留。

## XLSX：forced 与默认计算对照

```sh
node xlsx/validate.mjs
node xlsx/default-calculation-probe.mjs
"$OFFICE_VALIDATION_PYTHON" xlsx/compare.py
"$OFFICE_VALIDATION_PYTHON" xlsx/reimport-check.py
"$OFFICE_VALIDATION_PYTHON" xlsx/default-calculation-check.py
"$OFFICE_VALIDATION_PYTHON" xlsx/semantic.py
```

`validate.mjs` 显式使用 FORCED，真实修改文字、数值和公式；检查依赖公式/跨表缓存、中文、表序/隐藏状态、样式、图片、图表、条件格式和数据验证。默认计算探针故意省略 formulaCalculation，用同样断言记录 WHEN_EMPTY 的实际不足；默认失败结果不能靠 FORCED 的通过覆盖。`semantic.py` 依赖先前五步生成的文件，独立检查可复用现有输出。

## PPTX：真实编辑与复杂内容保留

```sh
node pptx/validate_sdk.mjs
```

两条 API 家族分别做无改对照，实际修改使用 `ISlideData` 产品模型。然后对六份候选逐一校验；单份严格校验出现 exit 1 时仍需执行其余项，不用 `&&` 将后续证据跳过：

```sh
for sample in simple complex; do
  for mode in product-unchanged aggregate-unchanged edited; do
    "$OFFICE_VALIDATION_PYTHON" pptx/verify_pptx.py "$sample" "pptx/$sample.$mode.pptx" "$mode"
  done
done
"$OFFICE_VALIDATION_PYTHON" pptx/verify_semantics.py
"$OFFICE_VALIDATION_PYTHON" pptx/collect_results.py
```

严格 XML hash 差异保留为诊断；语义脚本进一步核对 layout/master 占位符、动态字段、主题、关系、物理尺寸和继承后的有效几何。基础编辑通过、复杂保留失败分开记录。`pptx/imported-unit.json` 用于 Web 创建 unit；`*.aggregate.original.json` 是 protocol aggregate，不能当作 UI 产品模型。

## 浏览器候选宿主

先运行以上 DOCX traditional、XLSX 与 PPTX Node 探针生成各自 `imported-unit.json`，再按需启动：

```sh
npm exec -- vite --config vite.config.mjs
```

仅监听 `127.0.0.1:1438`。打开对应本地地址，选择格式、载入样本、实际编辑、导出候选。SDK 命令与键盘/鼠标人工编辑应分别核对；页面显示、截图或按钮成功返回不等于原格式内容保留通过。原件不变，输出在 `browser/output/`，静态文件根和输出目录均相对本包配置定位。

本归档没有运行应用窗口、没有主项目接线，也没有运行全量测试。浏览器事件、LibreOffice/PDF 外部重开与目标桌面验收是独立证据，不能由此宿主代替。

## 独立浏览器输出与外部重开

浏览器输出按引擎保留到 `browser/output/chromium/` 与 `browser/output/webkit/`，文件名使用 `<格式>.browser-edited.<格式>`。为独立核对，也须保留格式探针产生的无编辑基线。

```sh
"$OFFICE_VALIDATION_PYTHON" browser/check-output.py
export OFFICE_VALIDATION_SOFFICE=/path/to/soffice
"$OFFICE_VALIDATION_PYTHON" external/reopen.py
```

外部脚本另需 `pypdf`，使用 LibreOffice 无窗口转换，每件独立 profile、最长 60 秒；`OFFICE_VALIDATION_SOFFICE` 未设置时查找 PATH。PDF、输入副本与运行结果留在被忽略的 `external/` 运行产物中；归档历史记录在 `evidence/external/`。成功重开不代表排版保真。

`evidence/browser/verification.core-only.*` 保留未加载图片插件的失败；最终 `verification.*` 证明补插件后图片保留，仍含字体/元数据等既有失败，不能称整体验收全绿。需要完整大树字段时复跑独立验证，归档 JSON 标明摘录范围。

## 结果与退出码

- 多数探针用 JSON 的 status、逐条断言和 error 表示实际结果，进程 exit 0 只表示执行结束。
- PPTX 严格校验与 XLSX 默认计算独立检查在失败时可正常返回非零；这是已知候选缺陷证据，不能删除断言使其变绿。
- failed/limited、图片丢失、字体变化、Univer.ai 元数据改写、PPT 水印等记录需保留。语义补查不能覆盖原严格失败，原证据保存在 evidence，新输出在各格式目录并由 .gitignore 排除。
- 记录实际版本、timing、checksum、可编辑目标与最小适用范围；没有独立重开/内容比对时不得将非空 ZIP 当作成功。

## GenOffice 对照与新增格式

- [Word](../genoffice-docx-validation/README.md)：公开引擎、原 PM/schema、真实 Tiptap 键盘候选，保留原 ParsedDoc 与原件。
- [Excel](../genoffice-xlsx-validation/README.md)：真实 Node Gateway/Rust sidecar，明确保留默认/跨表缓存失败与受限修正分支。
- [PPT](../genoffice-pptx-validation/README.md)：公开 core + 薄 SVG 宿主，原格式检查与无水印截图分别留证。
- [PDF 表单](../pdf-validation/README.md)、[GenOffice PDF 原文](../genoffice-pdf-validation/README.md)、[Markdown](../markdown-validation/README.md)：按格式记录新调查/试验，未将 Office 结果外推。

GenOffice Word/Excel 外部重开另用 `external/genoffice-reopen.py`，见 `evidence/genoffice-docx-external/`、`evidence/genoffice-xlsx-external/`；原件同 hash PDF 证据复用，候选实际转换。旧 XLSX 缓存可能被外部工具重算，失败仍看候选原字节。调用者应在隔离目录运行并提供原件重开基线 JSON：

```sh
export OFFICE_VALIDATION_SOFFICE=/path/to/soffice
export OFFICE_VALIDATION_PDFTOTEXT=/path/to/pdftotext
"$OFFICE_VALIDATION_PYTHON" external/genoffice-reopen.py \
  --format docx --source /path/to/genoffice-docx-probe \
  --baseline /path/to/original-reopen-results.json --output /path/to/new-evidence
```

该脚本需要 pypdf，已有成功记录仅在源/PDF hash 一致时复用。`--format xlsx` 对应四条引擎分支及浏览器输出。

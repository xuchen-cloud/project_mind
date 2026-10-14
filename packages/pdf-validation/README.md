# #118 PDF 最小验证

路径约定：`$RUNTIME_DEPENDENCIES` 为提供记录所用 Node/Python/外部工具的运行时依赖目录。复跑前按环境设置；历史临时产物不随仓库提供。


本目录是独立候选试验，不是应用功能。没有启动 GUI、安装依赖、改 root package 或调用 Office 外部重开。

## 已执行范围

- bundled Node **v24.19.0**、PDF.js **6.2.108**（仓库现有依赖）、pdf-lib **1.17.1**（bundled 依赖）、Python **3.12.14**、pypdf **6.10.0**。
- 两份 2 页原件；复杂原件另有未编辑中文、图片、链接和目录。
- 每份分别用 PDF.js `annotationStorage` + `saveDocument()` 和 pdf-lib 表单 API 将 `customer` 从 Alice 改为 Bob，并勾选 approved。
- 独立 pypdf 断言：页数、页尺寸、正文抽取、解码后的页面内容流 SHA、图片像素 SHA、链接/其他批注及目录不变；字段值、Bob 外观流和 checkbox `/AS=/Yes` 正确。4 个组合通过，原件 SHA 未变。
- 中文默认表单字体导出 **failed**：`WinAnsi cannot encode "中" (0x4e2d)`。未测自定义中文字体。
- 覆盖反例 **limited**：新旧正文均可抽取，不能称原文修改。
- PDF.js Node 发出 OffscreenCanvas 外观警告；有 AP 内容结构证据，没有视觉保真、GUI 或 WebView 证据。

完整结果在 [results.json](results.json)，各 `.checks.json` 保存独立读取的前后内容及断言。总体 `limited`，仅受控英文文本框和 checkbox 往返通过；批注 GUI、GenOffice PDFium 原文修改、XFA、签名、加密 PDF 和业务 CAS 未验收。

## 可跑命令

在仓库根目录运行。原件已保留，不要重新生成；生成器会拒绝覆盖。只有在清空的新隔离副本里才运行 `fixture.py generate`。

```sh
$RUNTIME_DEPENDENCIES/node/bin/node packages/pdf-validation/validate.mjs
$RUNTIME_DEPENDENCIES/python/bin/python3 packages/pdf-validation/fixture.py compare packages/pdf-validation/complex.original.pdf packages/pdf-validation/complex.pdfjs-form.pdf packages/pdf-validation/complex.pdfjs-form.checks.json
```

`validate.mjs` 只读现有依赖；可通过 `PDF_VALIDATION_PYTHON`、`PDF_VALIDATION_BUNDLED_MODULES` 指定 bundled 位置。它没有依赖安装逻辑。重新执行会另存/替换本目录候选与结果，保留 originals。日志记录实际 Node 版本：系统 `node` 当前为 v26.8.1，不能把它写成此次 bundled 执行版本。

第二次仅增强独立 AP 断言并复用四个已导出 PDF，未重跑候选库；对应时间另记为 `appearance_assertion_recheck`。脚本的告警/独立读取器版本采集随后补入，现有结果中的告警来自首次实际运行。

研究报告：[PDF 集成候选调查](../../docs/technical/pdf-integration-candidate-research-20261013.md)。

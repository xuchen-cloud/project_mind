# Office 外部无窗口重开验证

关联 #118 / F03。仅创建 scratch/external/ 内的脚本、输入副本、独立 profile、独立 PDF 输出和证据；没有重跑 SDK。使用 bundled soffice --headless，逐文件 subprocess timeout=60s。LibreOffice 打开 SHA256 一致的 scratch 输入副本，来源文件只读并检查转换前后 hash。

## 结果边界

记录 26 件输入版本，其中可重开 26 件。**reopened 只代表返回值 0、PDF 可被 pypdf 读取并有页面，不代表保真通过。** 转换成功、相同页数和相同可抽取文字均不能证明图片、字体、表格位置、公式缓存或未支持对象保留。

原件/候选路径、原件与候选 SHA256、转换完整命令、返回值、stdout/stderr、耗时、PDF checksum、每页尺寸和可抽取文字见 results.json。每件独立目录里也有 text.txt。未对全部页面执行视觉验收。

DOCX 选显式 traditional 的 product unit 输出；XLSX 使用现有 forced 候选；PPTX 使用现有 product-unchanged/edited。原样本与候选均未覆盖，来源 hash 变化件数：0。

| 来源 | 文件/链 | 原件 PDF 页数 | 候选 PDF 页数 | 全文相同（忽略空白） |
| --- | --- | --- | --- | --- |
| SDK | docx / simple / product-noop | 1 | 1 | True |
| SDK | docx / simple / product-edited | 1 | 1 | False |
| SDK | docx / complex / product-noop | 3 | 3 | True |
| SDK | docx / complex / product-edited | 3 | 3 | False |
| SDK | xlsx / simple / product-noop | 2 | 2 | True |
| SDK | xlsx / simple / product-edited | 2 | 2 | False |
| SDK | xlsx / complex / product-noop | 3 | 3 | True |
| SDK | xlsx / complex / product-edited | 3 | 3 | False |
| SDK | pptx / simple / product-noop | 3 | 3 | True |
| SDK | pptx / simple / product-edited | 3 | 3 | False |
| SDK | pptx / complex / product-noop | 3 | 3 | False |
| SDK | pptx / complex / product-edited | 3 | 3 | False |
| chromium | docx / simple / browser-edited | 1 | 1 | False |
| chromium | pptx / simple / browser-edited | 3 | 3 | False |
| chromium | xlsx / simple / browser-edited | 2 | 2 | False |
| webkit | docx / simple / browser-edited | 1 | 1 | False |
| webkit | pptx / simple / browser-edited | 3 | 3 | False |
| webkit | xlsx / simple / browser-edited | 2 | 2 | False |

编辑候选文字应变化，表中 False 本身不判丢内容。页数变化是实际外部重开观测，需结合逐页文字/渲染定位。浏览器输出按 chromium/webkit 子目录读取；未就绪项记录在 results.json 的 pending_browser_formats。

## 失败与待解锁

[]

浏览器尚缺：{"chromium": [], "webkit": []}。后续文件落盘后重跑脚本；来源 checksum 和现有 PDF 未变时复用已经完成的转换，不重跑 SDK。

## 可跑命令

```sh
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 /tmp/project-mind-univer-validation-20261013/scratch/external/reopen.py
```

工具版本：{"python": "3.12.14", "pypdf": "6.10.0", "soffice": "/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice", "soffice_version": {"returncode": 0, "elapsed_ms": 292.557583999951, "stdout": "LibreOfficeDev 26.8.0.0.alpha0 2c87e51eeaa2b413ff4ae097b2705eea1995d8e5\n\n", "stderr": "", "timeout": false}}。

## 更新的 DOCX 浏览器候选

本次只新增两个文件版本的 soffice 转换；先前 24 条转换记录和 PDF 保留并按 SHA256 复用，没有重跑 SDK或其他已成功转换。results.json 共 26 个版本记录、24 个当前文件；比较表对相同 source 路径采用最新记录。旧 DOCX 版本未冒充新版本。

- chromium：20160 bytes，SHA256 `7b4b0ee2d3b3ca97cc38890c5b5997605578047800fc5ebfc66b1cde696ff4c1`；返回值 0，953.8 ms，PDF 1 页，图片数 [1]；原件同为 1 页，图片数 [1]。新候选完整 PDF 路径见 new-docx-results.json。
- webkit：20160 bytes，SHA256 `c70e728760d0b7aaa38b888948287ee2e825600bd3f890fd34943d20cd7ab780`；返回值 0，581.6 ms，PDF 1 页，图片数 [1]；原件同为 1 页，图片数 [1]。新候选完整 PDF 路径见 new-docx-results.json。

两个新文件的 hash 与用户提供值完全一致，转换前后来源未变。PDF 可重开及存在图片只说明外部输出确实包含图片，不能替代完整版式/图片位置视觉验收。新候选 Poppler 中文抽取也已单独执行；其他文字抽取证据按 hash 复用。

## 已保留的限制

复杂 PPTX 无修改及编辑候选的 PDF 不再包含图表标题“业务数量”；源 chart XML 仍含该值。既有诊断截图还显示未编辑图表绘图区位置/尺寸、配色发生变化。当前 bundled headless 原件也有中文不可见/方框，中文视觉保真正对照尚不有效。已保留三个诊断 PNG 和 text-diagnostic.json；初始 pypdf 中文抽取异常，主文字比对使用 Poppler，原始数据未删除。

## 路径说明

实际目录为 `/tmp/project-mind-univer-validation-20261013/scratch/external/`（macOS 解析为 `/private/tmp/project-mind-univer-validation-20261013/scratch/external/`），不是共享根下直接的 `external/`。本轮最初 24 件转换已经产出，新两件也已产出；没有 soffice 路径或进程阻塞。

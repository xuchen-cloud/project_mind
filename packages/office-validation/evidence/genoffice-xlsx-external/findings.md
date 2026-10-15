# GenOffice XLSX 外部重开（2026-10-13）

主 agent 对两份相同原件和每份四条引擎保存分支（noop、default、IronCalc、IronCalc + cache-only sheet touch）执行外部重开。另补 Chrome/WebKit 两样本的四个实际浏览器候选，共 14 条记录全部成功：simple 2 页、complex 3 页，页数与尺寸保持；无改分支全文相同（忽略空白）。2 条同 hash 原件复用既有 PDF 证据，12 条候选实际运行 bundled LibreOffice headless。所有源文件 hash 不变。

**外部工具重开成功不等于文件的公式缓存正确。** LibreOffice 自身可能重算并修复候选中的旧缓存，default / IronCalc 分支的原 XLSX 失败仍以 openpyxl/OOXML 直接读取结果为准；没有用 PDF 结果覆盖失败。

详细记录：[results.json](results.json)。没有做像素保真、Microsoft Excel、完整表格 UI、Tauri/CAS 验收；浏览器与原格式数据保留单独判断。

脚本与参数：[genoffice-reopen.py](../../external/genoffice-reopen.py)，使用 `--format xlsx`；依赖与工具环境变量同 DOCX 外部记录。

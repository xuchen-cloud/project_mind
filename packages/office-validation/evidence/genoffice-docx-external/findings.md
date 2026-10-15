# GenOffice DOCX 外部重开（2026-10-13）

主 agent 对两份相同原件、公共编辑模型无改/编辑候选、Chrome/WebKit 实际键盘编辑候选进行了外部重开。10 条记录全部成功：simple 1 页、complex 3 页，页面尺寸与原件一致；无改全文相同，编辑全文仅有预期的段落和表格单元格替换（比较忽略空白）。

4 条原件/无改记录复用既有完全相同原件 hash 和已验证 PDF hash 的转换，6 条编辑候选实际运行 bundled LibreOffice headless。所有候选源 hash 保持不变。详细命令、来源、PDF 页数/尺寸、Poppler 文字及比较见 [results.json](results.json)。

本证据没有验收 Microsoft Word、像素外观或 Tauri。前轮同 hash 原件的中文视觉限制仍成立；抽取到中文与页面数量正确不能代替字体/分页视觉验收。浏览器中中文和原 PNG 可见另由真实截图与独立 DOCX 保存检查证明。

复跑脚本：[genoffice-reopen.py](../../external/genoffice-reopen.py)。提供 `--format docx --source <GenOffice DOCX 探针目录> --baseline <Univer 原件重开 results.json> --output <隔离证据目录>`，通过 `OFFICE_VALIDATION_SOFFICE` / `OFFICE_VALIDATION_PDFTOTEXT` 配置外部工具；需要 pypdf。

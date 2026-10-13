# #118 PDF 原文修改最小执行包

- 授权：独立执行任务，固定 GenOffice SHA 与 PDFium 2.15.1/HarfBuzz 0.10.3；不 review、不派 agent。
- 写入：本目录、隔离 scratch `/tmp/project-mind-genoffice-pdf-validation-20261013`；既有 PDF 报告仅追加执行段及更新原文状态。
- 交付：原件保留、真实 validate/apply/verify API、英文单对象与中文嵌入字体样例、候选与独立 pypdf/Poppler 内容检查、小 PNG 对比、源码/依赖/字体校验和、失败/限制。
- 非目标：native build、Electron/GUI、主源码或 root package、完整 save-pdf 依赖图、其他报告/Office 全量检查。
- 验收：目标旧整句消失且新整句出现；未改正文/页数/图片/链接/表单保留；任何目标 skipped 均不算通过；原文最终 private verify 接缝分别判断。中文困难时保留一个具体失败及解锁条件，不以英文成功外推。

# PDF 候选最小运行 findings

总体 **limited**。运行证据：[results.json](results.json)，方法和命令：[README.md](README.md)，网络源码研究与后续方案：[完整报告](../../docs/technical/pdf-integration-candidate-research-20261013.md)。

## 实际执行

PDF.js 6.2.108 和 pdf-lib 1.17.1 各修改 simple/complex 的英文 AcroForm 文本框与 checkbox，另存后由 pypdf 6.10.0 独立读取。4 个组合通过：2→2 页，Bob 字段值与外观流正确，checkbox `/Yes`状态正确，未编辑正文、页面流、图片像素、链接及目录保留；原件 SHA 未变。候选 SHA 和耗时在结果中。

## 失败与限制

- **failed**：pdf-lib 默认 Helvetica/WinAnsi 字体写“中文填写”时抛出 `WinAnsi cannot encode "中" (0x4e2d)`；未测试自定义中文字体。
- **limited**：白色覆盖并绘制新字后，旧正文仍可抽取；不是原文修改。
- PDF.js Node 发出 OffscreenCanvas 外观告警。AP 内容有独立结构证据，没有视觉显示/GUI 保真证据。
- 未执行 GenOffice PDFium core、中文原文编辑、批注 GUI、Tauri/WebView 或 File CAS。因此英文表单通过不能外推中文编辑或产品交付。

## 推荐

预览复用已有 PDF.js；标注/表单增加直接保存链；GenOffice 固定 core 确实有原文字对象修改，作为后续原文编辑优先 runtime 候选。先在独立 Node+PDFium/HarfBuzz WASM 和 font-metrics 宿主验证原文，暂不扩张 native build。完整报告列出了模块闭包、真实 API、受控英文/嵌入中文样本、skips/最终回读与独立重开要求。

所有候选最终经主程序既有单一 File ID、版本/hash 与 staged/CAS 生效。库导出成功不能当业务保存成功。

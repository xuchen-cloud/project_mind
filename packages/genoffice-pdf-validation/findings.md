# #118 PDF 原文 core 执行结论

## 推荐

采用 **现有 PDF.js 预览 + GenOffice core 局部原文编辑**。两份受控原文样例已实际通过 validate/apply/verify 与独立内容核对；批注/表单无法替代用户要求的中文正文修改。产品仍需实际字体供给、PDFium/HarfBuzz WASM、目标文字/几何定位、真实最终 verifier 和单 File ID 版本/hash CAS 接入。

## 已验证最小范围

英文单对象及中文 ArialUnicodeMS 嵌入子集中的一处等字符数替换。中文替换含子集外“星辰”，默认字体路径真实取到 Arial Unicode.ttf，经真实重建生成新的 Type0/FontFile2；没有自定义字体 shim 或 patch 限制。字体文件 SHA `876af2cd4854644e7f3e7feb2f688997fdb3343c6df6693611209c9dfb47ccec`，OS/2 fsType=8，原字体/flags 未修改。字体不归档。

旧目标整句消失，新目标整句出现；pypdf 与 Poppler 未改全文有序一致，2→2 页、图片、链接、表单/widget、目录均保留。中文外目标区像素 0 差，第二页 0 差。主 agent 确认中文清晰、未改正文/图片/Alice 与第二页可见，没有观察到新增水印。

## 有限或未完成

- 英文新词字符数相同但字形总宽度增加：差异 bbox `[105,61,221,73]`，原框外差异 `[217,61,221,64]`；该断言原样 false，external overall 为 limited。未见遮挡是主 agent 对此图的观察，不是任意固定框保真。
- Poppler 26.05.0 均提示默认 fontconfig config 缺失；本组中文嵌入字形能渲染，没有借用旧 CID nonembed 试验推断。
- 精确提取的 private verifier 对 pdf-lib 最后保存字节通过，对缺失新文真实抛错；未接完整 save-pdf/applySaveRequest、image 分支或应用保存，也没有为两份 final-stage 附加文件声称独立视觉通过。
- 未测扫描 PDF、任意字体/复杂段落、GUI/选区、WebView、应用 CAS。整体 limited。

## 耗时与证据

PDFium 初始化 50.95ms；英文 validate/apply/verify 9.33/5.32/0.96ms，中文 2.92/148.52/1.22ms。单次测量不当基准；退出均 0，skipped 空。错误 oldText 正对照明确 skipped，输出原件同 SHA。脚本/锁/原件/候选/结果与小 PNG 均在本目录；无需启动应用复核内容。

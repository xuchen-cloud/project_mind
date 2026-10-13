# GenOffice PDF 原文修改真实 runtime

固定 SHA `d32d1711f1bf985430757b8c6b3fbddd3831d946`。隔离 scratch `/tmp/project-mind-genoffice-pdf-validation-20261013`；没有 Electron、GUI、native build 或主项目依赖修改。

## 实际结果

- bundled Node v24.19.0 / darwin arm64；PDFium 2.15.1、HarfBuzz 0.10.3、pdf-lib 1.17.1、esbuild 0.25.12。
- 未修改上游 text-edit/字体模块，esbuild alias 解析真实 workspace font-metrics。实际 validateTextEdits/applyTextEdits/verifyTextEdits 两样本均通过，无 skipped。
- 英文目标 SIMPLE ORIGINAL TEXT→SIMPLE REPLACED TEXT；中文目标山川→星辰，原件为实际 ArialUnicodeMS TrueType 嵌入子集；未指定字体覆盖，真实默认查找得到本机 Arial Unicode 字体。source font SHA 与新嵌入 FontFile2 SHA 已记录。
- pypdf 与 Poppler：新整句存在、旧整句消失；未改全文及页序、两页尺寸、图片像素、链接、widget/表单值和目录保留。
- 中文两页目标区外像素相等；英文目标原框外 4px 变化，原断言保持 false，标 limited。主 agent 看过 PNG，中文清晰、未改内容可见、没有观察到新增水印；不等于任意 PDF 布局保真。
- 真实不存在源目标正对照：validation 给出 reason，apply 返回一个 skipped，候选 SHA 等于原件；跳过没有当成编辑成功。
- final-verify.mjs 精确提取上游 private finalPageIndex/verifyContentEdits 函数体并仅加 export，真实 text-edit 动态依赖被打包；未执行 image 分支，没有 shim。core 候选经 pdf-lib 最后保存配置往返后，真实最终文字回读通过，missing-newText 正对照被拒绝。**未运行完整 applySaveRequest/savePdfToPath，也未对这两份额外 final-stage 文件做独立 Poppler/视觉核对**；不把它们当另一套完整通过样本。

整体 **limited**；推荐既有 PDF.js 预览 + GenOffice core 局部原文编辑。GUI/DSH 同 File CAS、字体供给、WASM 打包、目标定位及最终验证接入尚未交付。

## 证据与复现

- [源锁](source-fetch.lock.json)、[依赖锁](dependency.lock.json)、[字体锁](font.lock.json)、[打包输入](build-inputs.json)
- [core 结果](results.json)、[独立重开与像素](external-results.json)、[提取最终验证](final-verify-results.json)、[主 agent 视觉观察](visual-main-agent.json)
- [中文对比 PNG](evidence/visual/complex.page1-comparison.png)、[英文对比 PNG](evidence/visual/simple.page1-comparison.png)
- [findings](findings.md)、[完整报告新增执行段](../../docs/technical/pdf-integration-candidate-research-20261013.md)

从仓库根执行，第一次在空 scratch 获取官方固定源码；已有依赖/原件/结果可复用，不必重复库或渲染：

```sh
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 packages/genoffice-pdf-validation/bootstrap.py
npm ci --prefix /tmp/project-mind-genoffice-pdf-validation-20261013 --ignore-scripts --no-audit --no-fund
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node packages/genoffice-pdf-validation/build.mjs
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node packages/genoffice-pdf-validation/validate.mjs
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 packages/genoffice-pdf-validation/external.py
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node packages/genoffice-pdf-validation/final-verify.mjs
```

bootstrap 会自动将随附 dependency.lock.json 复制为 scratch/package-lock.json，上述空 scratch 的 npm ci 顺序具备锁文件；本次只检查代码路径，不重装依赖。首次实际执行为 `npm install --ignore-scripts --no-audit --no-fund`，版本完全固定。fixture.py generate 仅用于空的新副本，拒绝覆盖 originals；需相同本机字体路径。字体不随证据分发。

所有 upstream、node_modules、WASM 和 bundle 只在 scratch。实际抓取有 7 个文件遇到 HTTP IncompleteRead，明确记录并只读复用了相同 SHA 的 git object；完整 save-pdf.ts 由 Node fetch 获取。复现脚本在相同 raw 错误后先尝试 Node fetch，再提供只读 git 对照路径，便于没有旧 checkout 时独立获取；这一下载修正仅做语法检查，未重跑库/PNG。没有修补源函数或吞 runtime 错误，没有扩大 native build。

# GenOffice PPTX 技术验证

路径约定：`$RUNTIME_DEPENDENCIES` 为提供记录所用 Node/Python/外部工具的运行时依赖目录；`$REPO_ROOT` 为当前 checkout。复跑前按环境设置；历史临时产物不随仓库提供。


关联 #118 / F03。固定上游 SHA：`d32d1711f1bf985430757b8c6b3fbddd3831d946`。
这是独立技术 harness，不是产品交付或 review。只归档本新目录；没有修改根项目依赖或应用源码。

## 结论与证据

**GenOffice 公开 core + 本次薄 SVG adapter 可以作为 simple PPTX 无水印预览/基础文字编辑的备选。** 主任务在 WebKit、Chromium 实际看见中文及 PNG、未见水印，并通过表单保存候选。本 agent 只执行后端与独立文件验证，没有打开 GUI。不能由此推定完整 GenOffice 应用、复杂图表编辑 UI 或所有 PPT 文件都已验收。

| 样本/路径 | 独立结果 | 说明 |
| --- | --- | --- |
| simple no-op / 中文编辑 + 图片右移 228600 EMU | passed | SDK 实际 open/save/reopen；文本、图片、页序、字体、布局/母版保留 |
| complex no-op / 同样编辑 | limited | 131 项语义检查各通过；notes/chart/master/layout/theme/embedded XLSX 原部件字节保留。原 strict `zip_embeddings_part_count` 失败保留 |
| WebKit 真实表单候选 | passed，50 项 | 只替换“项目进展正常”→“项目进展更新”，图片完全不动 |
| Chromium 真实表单候选 | passed，50 项 | 独立输出文件，不能与 WebKit 候选互盖 |

机器结论：[findings.json](findings.json)，原始结果：[sdk-results.json](sdk-results.json)、[semantic-results.json](semantic-results.json)。每份 `*.verification.json` 保留全部原断言。浏览器记录位于 `browser/output/{webkit,chromium}/independent-verification.json`。

### 保留的诊断

- `sdkSemanticMatch=false` 未删除。上游 `sp_* / pic_*` 是进程局部临时 ID，重开改变；`sdkContentMatchExcludingProcessLocalElementId` 只排除每个元素的这一字段，其他模型字段仍比较。后端通过公开 `elementSpid` 将初始 JSON elementId 映射到 OOXML cNvPr ID，冷启动和重开后可定位原件元素。不要把这些临时 ID 用作产品长期标识。
- complex 的 embedding 严格数量是 **2 vs 1**。新增项为 `ppt/embeddings/` 零字节目录，非 embedding 文件；原 `Microsoft_Excel_Sheet1.xlsx` 仍被 `ppt/charts/_rels/chart1.xml.rels:rId1` 的 package relationship 使用，没有新增 unused embedding。`findings.json` 保留关系与逐部件 SHA-256。
- no-op 全部实际文件部件字节一致；编辑只改 `ppt/slides/slide1.xml`。JSZip 重装 ZIP 增加目录项、改变压缩策略，complex 文件体积增长约 31%，simple 约 40%。这是容器体积 limited；原严格失败不会被覆盖成通过。
- 薄 adapter 仅呈现 simple 的 text/picture/rect。复杂图表 UI、富文本编辑器、EMF/WMF、嵌入字体新增字形、真实复杂文档集合、IME 和主 File/CAS 提交未测。本后端每次从原件开始，仅编辑一个已有单段文字块，不是持久编辑会话。
- 外部 LO 证据由另一个任务维护于 `packages/office-validation/evidence/genoffice-external`，本目录不冒充其结果。

## 可复跑方法

在本目录运行，Node 26（本次 v26.8.1）或 bundled Node 24；Python 使用 bundled runtime（本次 3.12.14，python-pptx 1.0.2 / lxml 6.1.1 / openpyxl / Pillow）。无需根项目安装，不运行应用或 Electron。

```bash
cd $REPO_ROOT/packages/genoffice-pptx-validation
export PYTHON=$RUNTIME_DEPENDENCIES/python/bin/python3
"$PYTHON" fetch-core.py
npm ci --ignore-scripts --no-audit --no-fund
npm run probe
npm run build
npm run ui
```

`fetch-core.py` 按 [source-lock.json](source-lock.json) 下载 **253 个固定 core 文件** 至 `upstream/`，逐个核对 Git blob SHA-1 和字节数。只包括 pptx-engine/pptx-render/agent-core/zip-gate 与许可/配置；不下载 ee 或上游应用，也不删除任何许可检查。文件路径和 SHA 来自该固定提交的完整 Git tree。然后四个 `file:./upstream/packages/...` 依赖均实际存在，`npm ci` 使用归档 lock。失败时报告失败，不替换提交或静默降级。

`npm run probe` 生成浏览器所需 `browser/public/simple.noop.json`（以及其他模型/RenderTree JSON），大 JSON 未归档。归档包含两原件和四份小候选，baseline hash 保留；可设置 `GENOFFICE_ORIGINALS_DIR` 指向外部原件目录额外检查源 hash，默认检查本目录原件副本。

`npm run build` 用锁定 esbuild 0.27.7 打包引擎及 `browser/backend.ts`，生成 **`build/backend.mjs`** 和依赖 metafile；Vite config 实际 import 此文件。构建会检查没有 ee 输入。归档没有 node_modules、上游应用或大型 bundle；本次 scratch 的两次 bundle、TS runtime 调用、Vite build 与浏览器证据已成功。归档阶段只核对路径、锁与 hash，没有重新 npm 安装或重跑四条 SDK 转换。

`npm run ui` 启动本地 `127.0.0.1:1439`，不自动打开 GUI。`npm run ui:build` 可静默构建薄 adapter。再次浏览器验收后，将该浏览器产出的 `simple.browser-edited.pptx` 复制到各自 `browser/output/{webkit,chromium}/` 后执行：

```bash
"$PYTHON" verify_browser.py browser/output/webkit/simple.browser-edited.pptx browser/output/webkit/independent-verification.json
"$PYTHON" verify_browser.py browser/output/chromium/simple.browser-edited.pptx browser/output/chromium/independent-verification.json
```

两条只读候选，不重新 SDK 转换。`PYTHON="$PYTHON" npm run verify` 可对已生成的四条引擎候选和两个浏览器候选集中独立检查，并生成分类 findings；complex 原 count 失败继续留在原报告，分类要求所有实际部件、关系、语义通过。

## 主 React 的 JSON 接口

`browser/public/simple.noop.json` 包含 `{deck, renderSlides, media, textElements}`；`textElements` 提供 `{slideIndex, elementId, paragraphs, originalRichText, text}`。`deck` 是公开模型 `{slides, size, originalHash}`。所有 `RenderSlide` 使用 **fitWidthPx: 960**，图片 resolver 的 dataUrl 来自真实 Archive 字节。

`browser/backend.ts` 导出 `load / render / edit / save / editAndExport`。Vite config 暴露 `POST /probe/edit-export`，请求限定为：

```json
{"kind":"simple","slideIndex":0,"elementId":"初始JSON返回的ID","text":"项目进展更新"}
```

`editAndExport` 从原件 open，用公开 `replaceAllInDeck` 指定 slide/element 改文，实际 `savePptx` 写 `{kind}.browser-edited.pptx`，再从落盘字节 reopen、buildRenderSlide，返回：

```text
{renderSlides, deck, hash, bytes, candidate, media, textElements, editResult}
```

`bytes` 是候选文件大小，`hash` 是 SHA-256。本接口拒绝多段/动态字段编辑，保留原富文本给主 UI 扩展；不是任意富文本编辑 API。

### 字体、图片与许可边界

本样本 model 字体为 Calibri；未随 harness 分发字体文件。RenderTree 默认 `HeuristicMetrics`，浏览器由系统字体/CJK fallback 绘字，因此视觉无水印不等于字体排版与 PowerPoint 像素一致。精确布局可通过公开 `OpentypeMetrics` 注入与 browser `FontFace` 相同的字节及 style resolver，再等待字体加载后重建；本次没有验证此路径。

本样本为 PNG，resolver 使用 `image/png`。浏览器需支持 data URL；EMF/WMF 不是本 SVG adapter 的可解码图片，不能据此推定复杂图片可显示。

根 core [LICENSE](LICENSE) 为 Apache-2.0，[NOTICE](NOTICE) 原文保留；源码获取同时保留 vendor 与 Unicode 许可。引擎的 vendored libeot/MTX 文件标为 MPL-2.0，不能把每个第三方文件统称 Apache。**没有 ee、license key 或许可检查绕过**。构建闭包与实际 open/save 没有注入产品水印；视觉证据只覆盖本次 core + 薄 SVG adapter。

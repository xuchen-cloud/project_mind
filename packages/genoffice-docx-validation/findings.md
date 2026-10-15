# GenOffice Word/DOCX 对比 findings（2026-10-13）

## 实际结果

固定提交 `d32d1711f1bf985430757b8c6b3fbddd3831d946`，两份原件与 Univer 完全相同，fixtures.json 原样保留。simple SHA256：`b41ac08b4c1eae689a25280fdbb9a772d8ff9b242979ab2f76d81ea330fbb8da`；complex：`7b9750877adf72cd9817edf8582979a6877f3bc67f4cc0267dcb7e2041067f09`。

| 真实路径 | simple | complex |
| --- | --- | --- |
| parseDocx → original SaveBlock[] → saveDocx | 20/20，字节完全相同 | 20/20，字节完全相同 |
| blocksToPmDoc → pmDocToSavePlan，无编辑 | 20/20，字节完全相同 | 20/20，字节完全相同 |
| 公共 PM 模型段落+单元格替换 → save | 20/20 | 20/20 |
| 原 editorExtensions/getSchema → EditorState 无编辑 → save | 20/20，字节完全相同 | 20/20，字节完全相同 |
| 原 schema → EditorState.tr.insertText 两目标 → save | 20/20 | 20/20 |
| Chrome 真实 Editor selection + keyboard.type → getJSON → save | 20/20，主 agent 执行 | 20/20，主 agent 执行 |
| WebKit 同路径 | 20/20，主 agent 执行 | 20/20，主 agent 执行 |

全部引擎输出重新调用真实 parseDocx，并在重开 PM 中唯一匹配编辑后段落和第一个表第 2 行第 2 列。Python 独立消费者确实 Document(candidate) 重开，结合 ZIP/XML 解码；没有以文件存在判成功。主 agent 的四候选已独立复核，浏览器行为来源明确记录在 main-agent-browser-report.json，没有重复执行浏览器。

## 保留与实际变化

- 中文正文、标题样式、2×2 表、未改粗体文字、单图片原 PNG 字节/像素/尺寸与所在正文节点保持。
- complex 的 2 节、每节页眉/页脚文本和引用对应、1 个显式分页、链接文字与 URL、A4 尺寸、全部边距/列参数保持；simple Letter 参数保持。
- 全文 XML 的元素、属性、子节点顺序及文字都按语义核对，仅允许两个目标替换；不依赖整体文件哈希判断编辑结果。新增无意义的 `xml:space="preserve"` 在不含边缘空白的文字上按等价语义处理，原始 ZIP 修改列表仍保留。
- 无编辑保存所有路径直接保留原始字节。编辑计划只 regenerated 2 blocks、deletedCount=0：段落用 generated，表格用原 XML 的 cell text patch，其余为 original。
- 编辑输出的文件部件只改变 `word/document.xml`、`docProps/core.xml`。modified 变为实际保存时间，revision 1→2；created、author=`python-docx`、lastModifiedBy 空字符串及其他核心字段保持，app.xml 全部原样保留（包括 Application、Company、Manager）。Company/Manager 本 fixture 原值为空，不能外推非空值编辑的产品行为。
- ZIP 重打包增加空目录项，结果另列 zip_directory_changes；它们不是图片。最初独立 helper 错把 `word/media/` 当图片解码而报错，已只修正检查目录项；图片成功解码且 SHA/像素一致。另有字体二进制下载超时，最终研究取数限定相关源码/说明/许可，不将未下载字体视为预览已验证。
- 本组未发现正文、图片或复杂结构损失。稳定语义通过不等于整个编辑文件字节相同，全部 strictchanges 留存。

## 与现有 Univer 对照及可编辑范围

主任务提供的既有对照：Univer Traditional 主要格式保留；DocsCore UI 曾丢图片，接入 Drawing 后修正；作者/Company 发生改写。GenOffice 在相同 fixture 的无改及两处编辑中没有上述 metadata 改写，且无改为原包直返。这给 Word 材料保真带来更强的实测依据，建议把 GenOffice 列为 Word 优先候选继续产品验收；PPT 的选择和整体架构由主任务综合，不在本包扩张。

实际证明的编辑：普通段落文本、第一个简单表的单元格文本；主 agent 验证真实键盘输入及图片可见。复杂分节、页眉页脚、链接和页面设置在这两处编辑期间作为未编辑内容保留。未实测它们自身的编辑、插入删除、合并表、图片 resize/移动、跟踪修订、批注/注脚、公式、图表、嵌套表、多轮异步保存、保护文档或大文件。源码提供这些模型/选项不等于本次验收通过。

## 公开源码与真实 API 依据

验证时获取的源码全部对应同一 Git tree；528 份文件核对 Git blob SHA1，浏览器 bundle 的 242 份上游输入均能映射到该来源。精简归档仅保留源码锁和获取脚本，源码、bundle、依赖和重复完整模型复跑时重新生成；LICENSE/NOTICE 单独保留，不 vendor 源码或字体。未改上游源码；bundler alias 指向原导出文件，普通 tree shaking，无 ee 和许可模块删除。

- [engine 公共导出](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/docx-engine/src/index.ts)：parseDocx / saveDocx / readSections 与类型。
- [patch.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/docx-engine/src/patch.ts#L640)：原包和按 docxIndex 的 SaveBlock[]，original block 原片段复制；L623 起只更新 modified/revision，L651 起 save，L701 无改回传 originalBytes。
- [公共 GUI 转换](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/editor/convert.ts#L113)：blocksToPmDoc；L1948 起 pmDocToSavePlan，L2056 起表格结构/格式签名与 cell text patch。
- [真实宿主加载/保存](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/file-actions.ts#L692)：buildDocBytes 从 editor.getJSON 生成计划，L767 传入 saveDocx 和各 dirty state；L430 加载使用 readSections/pmDocOptions。
- [原 Tiptap extensions](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/editor/extensions.ts#L6767)：本包直接导出并使用该数组；[App](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/App.tsx#L1155) 也是直接 extensions: editorExtensions。

## 水印、品牌与预览

公开 [LICENSE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/LICENSE) 与 [NOTICE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/NOTICE) 已保留。docx-engine 包声明 Apache-2.0、private；private 表示本单仓包，不是可直接从 npm 获取的商业 SDK。

[watermark.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/docx-engine/src/watermark.ts#L13) 处理 Word 页眉里的 VML 文档水印。saveOptions.watermark 未指定时保留；它不是 trial license 叠层。[PaginationPreview](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/components/PaginationPreview.tsx#L1589) 的水印来自文档/用户 dirty state，不是固定品牌文字。调查的公开 core/预览路径没有发现运行时许可校验、强制 GenOffice 叠层或 ee 依赖；browser bundle 无未解析 import，core 在真实薄宿主中可独立运行。

完整 PaginationPreview 未实际挂载，字体别名含 GenOffice 命名不代表强制可见品牌。桌面外壳名称/About 与版权 NOTICE 属于不同层面。该结论限定本次固定提交的公开路径，不能替代完整分页/字体/打印运行时验收；没有删许可模块绕过任何机制。

## 宿主改装代价与未测项

1. 原 core 可以浏览器运行，但 Word 预览不在一个独立 docx-render 包里，而散在 `apps/docs/src/renderer`。薄 bundle 引入转换/schema 及依赖后约 5.46 MB 未压缩；需将相关公开模块组织为自有组件，处理 CSS、字体/metrics、页面/分节/页眉页脚展示、图层与分页状态。
2. 保留真实 ParsedDoc（尤其 originalBytes/extras/锚点），配对当前 PM JSON；成功落盘后重新 parse/rebase，避免对旧基线套用后续编辑。业务层 File Version、CAS、资源预算、读写边界和崩溃恢复尚未接入。
3. 对接 Tauri 的文件读写/另存/下载，拆出上游 window.desktop 的 clipboard、字体和文件能力。薄宿主文本保存不要求完整 Electron 启动。
4. header/footer/section/notes/ink/chart 等编辑需搬接 file-actions.ts 的 dirty state → SaveOptions/partXml/partBinary。当前 savePmDoc 遇到 chartPatches 显式报错，不能静默丢失图表编辑。
5. 主 agent 薄宿主已验证两种浏览器真实输入与原图可见；完整 toolbar、分页、页眉页脚 UI、字体行断、打印/PDF、辅助功能和用户产品交互仍未验收。Chrome 的 favicon404 是主 agent 报告的唯一 console error，未报告格式异常。
6. 主 agent 已完成 [LO 外部重开](../office-validation/evidence/genoffice-docx-external/results.json)：10 records 均 reopened，simple 1 页、complex 3 页；8 个 comparison 的页数、页面尺寸、预期文字（忽略空白）均为 true。记录中的 original/noop 按同源与 PDF 哈希复用，其余为实际 headless conversion；本包没有重复转换。此证据不等于字体逐像素一致或完整分页 UI 已验收。没有全仓 build/tests，没有子 agent/review，没有改 root 依赖或 docs。

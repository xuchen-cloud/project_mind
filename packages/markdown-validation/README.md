# Markdown 独立验证

报告：[Markdown 候选调研](../../docs/technical/markdown-integration-candidate-research-20261013.md)。本包仅验证既有解析/SSR预览、固定 SHA 的 GenOffice 纯函数，以及字节修改后真实文件保存；不是主程序编辑器接入。

## 已执行

- Node `v26.8.1`；本包安装锁定 `esbuild@0.27.7`，未改根依赖。
- `fetch-source.py` 校验 84 个 GenOffice 文件的 Git blob SHA1，提交固定为 `d32d1711f1bf985430757b8c6b3fbddd3831d946`。
- `npm run build`、`npm run probe`：31 项断言通过。真实限制另存 `results.json.limitations`，总状态通过不代表 GenOffice 任意编辑无损。
- `provenance.json` 记录实际依赖版本和参与 probe 的源码 SHA256；`results.json` 保留样本原件/候选 hash。
- 未启动 GUI、浏览器、Tauri、主程序全量构建或 review。

## 复跑

从本仓库检出运行；需要项目现有根 `node_modules` 已可用。本包只安装自己的 esbuild，不替调用者安装根依赖。所需 React、react-dom、jsdom、mdast/micromark、KaTeX 等实际版本见 provenance；本包直接引用仓库现有 DSH 源码，因而不是可脱离仓库的独立 SDK。

```sh
cd packages/markdown-validation
python3 fetch-source.py
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run probe
```

本次 Python 实际路径为 `/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3`。Python 仅需标准库及 `curl`。下载限定为 source-lock 中的固定提交文件，不要求 Git clone。源文件缓存于忽略目录 `upstream/`，重复运行校验已有文件，不无限等待 Git。

`build-probe.mjs` bundle 实际 parser、MarkdownText、图片预处理和 GenOffice source helper；仅将 CSS/font 导入置空，SSR 没有布局/字体/视觉验收。运行产生 `build/entry.mjs`，再由 probe 真实调用。`evidence/preview.html` 为无头 React SSR 结果。

## 文件与结果范围

- `entry.tsx`：明确导出所调用的现有/上游函数。
- `probe.mjs`：生成六种 UTF-8 样本，用 Buffer 定位中文片段进行单次替换；保存候选并重读。原件、no-op、edited 均位于本包 evidence。
- GFM 表格、转义竖线、任务/嵌套列表、有序列表起始值、围栏代码、中文、相对/引用图片、引用链接及危险 HTML/URL，使用真实解析器和 React renderer 核对。
- 图片 probe 使用已知 PNG data URL 映射；不调用本机文件归属鉴权、MIME 检查、历史附件读取或 File/CAS。
- GenOffice 仅调用 `readSourceText/writeSourceText`、`parseDocText/serializeDocText`；未运行 Tiptap/sourceSplice/Electron save。`serializeMarkdown` 被 bundle，但 probe 没有调用，不能计作实测。
- `evidence/.gitattributes` 将 Markdown 字节样本设为不转换换行，允许它们刻意保留的尾部空格/硬换行；原件、no-op、候选 hash 未改变。此属性仅限样本，不放宽脚本或产品源码检查。
- 原字符断言证明的是 **字节修改策略**，不证明 textarea/CodeMirror/Tiptap DOM、IME、undo 或主程序保存已通过。
- 诊断保留混合换行/CR 的 GenOffice helper 不相等，以及现有资源 helper 对重复引用取最后定义的差异。

## 许可与来源

上游 public core 来源和 Git blob 锁定见 `source-lock.json`。保留原文 `GENOFFICE-LICENSE`（Apache-2.0）及 `GENOFFICE-NOTICE`，NOTICE 的完整应用第三方说明不意味着本包打包该应用。本包不含 ee、许可检查修改或完整上游应用。现有 DSH 源码沿用仓库已有来源/许可记录。

# GenOffice DOCX 受控实际对比

固定上游：`genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`。Issue：#118 / F03。协议：`genoffice-docx-controlled-roundtrip-v1`。

## 结论

同一 simple / complex 原件下，**10 组引擎/公共转换/schema 往返 + 主 agent 的 4 组真实 Chrome/WebKit 编辑候选全部通过，每组 20 项独立断言**。所有无编辑往返逐字节等于原件；编辑保留原图片、分节、页眉页脚、分页、链接、页面参数和原作者信息。详细损失、来源、接入成本和边界见 [findings.md](findings.md)。这是支持 GenOffice 成为 Word 候选的证据。主 agent 已完成 [LO 外部重开证据](../office-validation/evidence/genoffice-docx-external/results.json)：10 records 均 reopened，simple 1 页、complex 3 页，8 组 comparison 的预期文字（忽略空白）、页面尺寸和页数均通过。完整分页预览 UI 仍待验收。

## 文件导航

| 文件 | 用途 |
| --- | --- |
| `results.json` / `engine-results.json` | 独立 20 项语义断言 / 真实引擎重开、编辑计划和异常记录 |
| `browser-results.json` / `main-agent-browser-report.json` | 四候选复核 / 主 agent 提供的真实交互事实及局限 |
| `browser/` | 主 agent 的薄宿主源码、4 DOCX 候选及原校验 JSON |
| `fixtures/` | 原件、原样 fixtures.json、独立 python-docx/ZIP 检查 helper |
| `evidence/save-plans/` | 已验证的 10 组保存计划；完整 parse/PM/重开模型复跑时生成至忽略的 `models/` |
| `*.docx.verification.json` | 每个引擎候选的完整 expected/actual、strictchanges |
| `prototype.ts` / `build.mjs` | 组合原公共转换的薄 API / 本地构建浏览器 ESM 的脚本 |
| `source-provenance.json` / `extra-source-provenance.json` | 上游路径、固定 commit 与逐文件 Git blob 校验 |
| `public-core-audit.json` | 许可、水印、品牌路径及依赖审计；不宣称完整预览已运行 |
| `external-reference.json` | 主 agent LO 外部证据的相对路径、哈希和验证摘要 |
| `archive-manifest.json` | 精简归档文件 SHA256；排除它自身 |
| `LICENSE` / `NOTICE` | 固定上游的两份许可说明；保留许可证文字，不 vendor 源码或字体 |

每个结果保留 `protocol_id`、`model_path`、`baseline_hash`、fixture manifest SHA256、`strictchanges` 和 ZIP 目录项变化。作者 `python-docx`、Company 空字符串均明确比对，未把空 Company 当缺测，也不外推非空 Company 的编辑功能。

## 独立复跑（不影响 root）

Node 22+、Python 3.10+。在本目录单独执行：

```sh
python3 fetch-core.py
npm ci --no-audit --no-fund
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
DOCX_VALIDATION_PYTHON="$PWD/.venv/bin/python" npm run validate
.venv/bin/python verify-browser.py
python3 audit-sources.py
```

- 提交仅保留两份源码锁、验证脚本、fixture 和结果证据，不提交上游源码、依赖、字体二进制、bundle 或重复的完整模型。`fetch-core.py` 默认按 `source-provenance.json` + `extra-source-provenance.json` 精确重取 528 份锁定文件，校验字节长度及 Git blob，不改写锁文件、不依赖完整 tree.json；不启动 Electron。`fetch-extra.py` 保留为只取额外依赖的兼容入口。
- `upstream/`、`node_modules/`、`build/`、`models/` 全部忽略；已从本归档目录移除。没有必要 vendor 额外源码。LICENSE/NOTICE 为原许可文字，源码和字体许可说明按锁重新获取。
- `npm run validate` 会重建 bundle、重新执行 10 组 engine/schema 检查和独立断言。保存时间是新值，因此编辑候选哈希可变；无编辑仍应完全等于 fixture，语义断言仍应通过。脚本对异常/断言失败返回非零，同时保存诊断。
- `verify-browser.py` 只重核现有四份浏览器输出，不启动 GUI、不覆盖主 agent 原结果。真实键盘步骤见下节。
- `fixtures/fixture.py` 是原独立 helper 的副本，仅修正 `word/media/` 目录项不应作为图片解码；真正 media 文件仍必须成功解码。两原件及 fixtures.json 从未改写。
- 本次实际 Node 为 26.8.1，Python 3.12.14，python-docx 1.2.0 / lxml 6.1.1 / Pillow 12.3.0。npm 锁定完整依赖；安装时 Tiptap React 可选菜单 peer 有上游范围警告，实际使用 core/pm/extensions 均为 3.31.0，不影响本次已验证路径。

## 真实 Tiptap 薄宿主 handoff

执行 `python3 fetch-core.py`、`npm ci`、`npm run build:prototype` 后生成 `build/prototype.browser.js`。本次已验证的 bundle 没有未解析 import，导出：`Editor`、`editorExtensions`、`getSchema`、`openDocx`、`savePmDoc`，以及原引擎/转换函数。扩展使用上游原数组，无 `.configure()` 必需参数。

```js
import { Editor, editorExtensions, openDocx, savePmDoc } from './build/prototype.browser.js';
const session = await openDocx(new Uint8Array(await file.arrayBuffer()));
const editor = new Editor({ element, extensions: editorExtensions, content: session.pmDoc });
const { bytes, plan } = await savePmDoc(session, editor.getJSON());
// bytes 是 DOCX；保留 session.parsed 中的原包和 docxIndex，成功落盘后重新 openDocx 建立下一轮基线。
```

薄宿主仅保留 `browser/server.mjs`、`index.html`、`main.js` 和结果证据；先执行上述获取/构建步骤。`node browser/server.mjs` 会显式启动本机 1440 端口。访问 `http://127.0.0.1:1440/?engine=chromium`（或 webkit），选择样本，点击“选择待改段落”，用真实键盘输入 `已修改中文段落：秋风拂面。`；点击“选择待改单元格”，输入 `已改单元`；点击“导出 DOCX”。候选 POST 到对应浏览器目录并用真实 engine 重开。不要把直接改 DOM/JSON 冒充键盘验收。

主 agent 已按该流程完成 simple/complex × Chrome/WebKit，图片可见且 naturalWidth=160。**薄宿主没有完整分页、页眉页脚 UI 或 toolbar**；复杂结构由独立候选断言确认保留，不代表这些内容已在 UI 呈现。WebKit 截图由主 agent 归于仓库 `packages/office-validation/evidence/browser/screenshots/genoffice-docx-webkit.png`，本包不重复写该目录。

本 API 对 chartPatches 非空显式报错：宿主需接入上游 `file-actions.ts:buildDocBytes` 的 chart part/workbook 写回后才能支持图表编辑。本 fixture 无图表，未触发这项限制。Header/footer/page setup、ink、comments 等 dirty state 也需按原函数映射；不能仅凭该薄 API 宣称完整 Word 接入完成。

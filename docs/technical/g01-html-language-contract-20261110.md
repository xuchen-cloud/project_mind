# G01 Code language 与 DOM 排版证据（2026-11-10）

## 工作包

- 关联：[#302](https://github.com/xuchen-cloud/project_mind/issues/302)，G01 内容保真子包。
- 依赖：当前共享 rich editor schema、canonical validator/serializer；本 worktree node_modules。
- 交付：修复 Node HTML adapter 的代码语言回读；为 G16 提供语言往返契约；对稳定块开关做真实浏览器排版对照。
- 非目标：Record 保存协调、Office、Mermaid 渲染实现、全局排版 token、发布与提交。
- 验收：原 `language-ts` 探针先红后绿；HTML 重解析不丢语言/显式标志/块身份；六类排版相同设置下比较实际 computed style、相对 rect 和行框。
- 验证范围：HTML Node 与 browser editor 回归；相邻 canonical/StableRecordBlocks 测试；headless Chromium DOM 对照。不声明原生保存、Windows 或完整 App 验收。

## Markdown / HTML / canonical 语言契约（G16 可复用）

| 表达 | 读取/投影规则 |
| --- | --- |
| Markdown fenced code | fence info 中的语言由现有 Markdown renderer 输出到 `code` 的 `language-*` class。 |
| HTML | `<pre data-language-explicit="true"><code class="language-ts">…</code></pre>`；语言由 `pre.firstElementChild.classList` 中首个 `language-*` token 的后缀读取；空后缀为 `null`。 |
| canonical | `codeBlock.attrs.language` 为原始语言字符串（例如 `ts`、`typescript`、`mermaid`），无语言为 `null`；`languageExplicit` 独立保存用户显式选择。 |
| canonical → HTML → canonical | 语言、显式标志、文本及 blockId 全量相等。 |
| canonical → Markdown → HTML → canonical | 语言保持；Markdown 不承载 blockId，也不能编码 `languageExplicit=false` 同时带语言的独立状态。 |

- 不将 `ts` 归一化为 `typescript`，不将未知语言改成 `null`。高亮/图表是否支持该语言由消费方判断，保存层保留源语言。
- `data-language` 本身不是 StarterKit language 的读取来源，不应替代 `code.language-*`。`data-language-explicit` 优先于基于 HTML class 推断的显式状态。
- adapter 只补 schema 实际读取所需的 `firstElementChild` 与可迭代 class token 集合；跳过注释/文本，用 HTML ASCII 空白拆分 class 并去重。不安装全局 DOM，不复制另一套代码语言 parser。
- G16 应用同一 schema/serializer 生成 HTML，消费 canonical 的 `language`（或标准 `language-mermaid` HTML class），不能通过删除 class 或强制清空语言绕过校验。
- **已有边界**：`renderMarkdownToHtml` 的末尾代码换行裁剪依赖浏览器 `DOMParser`；Node 环境保留 tokenizer 的末尾换行，因此跨 Markdown 的全文字节往返不在本包保证范围。测试显式记录此现状，HTML/canonical 全量往返仍严格比较。后续如修该差异，需统一 Markdown worker/浏览器行为。

## 实现与回归

语言产品改动仅 `src/lib/record-document-html.ts` 两个 DOM getter。回归见：

- `src/lib/record-document-html.test.ts`：从原 review probe 迁入 7 个实际 Tiptap Editor fixture，`ts` 在转换前后明确断言。
- `src/lib/record-document-html.node.test.ts`：ts/typescript/mermaid/未知/无语言、HTML 空白和首元素语义、显式状态独立保存。

### 语言验证（已定稿，可独立提交）

基线 `fe9fe9c188f05c23bae369074446e38c0859a0c8`。全部使用 `with-build-lock.py` 串行、`--maxWorkers=1`：

- 红灯：临时移除两个 getter，运行两个 HTML 测试文件，**7 failed / 12 passed**。包含原探针的 `ts → null` 失败；已恢复产品修复。
- 绿灯：`node node_modules/vitest/vitest.mjs run src/lib/record-document-html.node.test.ts src/lib/record-document-html.test.ts src/lib/record-document.node.test.ts src/lib/record-document.test.ts src/components/rich-editor/extensions/StableRecordBlocks.test.ts --maxWorkers=1`，**5 files / 41 tests passed**，2.74s。
- 原始日志：`output/playwright/g01/language-red.log`、`language-green.log`；红绿脚本 `red-green.py`。
- 主 agent 自查：Standards 为最小 DOM 读接口修复，无全局 polyfill 或重复语言转换；Spec 为原始语言保真、显式标志独立、严格 HTML/canonical 全量比较。不启动 review 子 agent。

## 实际 DOM 排版定位

环境：HeadlessChrome 156，macOS，1280×720，DPR 1；无可见 GUI。探针通过 Vite 加载实际 `app.css`、`buildRichEditorExtensions`、`applyRichTextStyleVariables`，使用真实 Tiptap Editor/ManagedTable node view。每对宽度 600px，仅稳定块开关不同。

矩阵：6 类 fixture（普通段落、hardbreak、中间空段、嵌套无序/有序列表、引用、表格）× 默认/自定义设置 × editable/readonly = 24 对。采集所有 DOM 元素的 computed font/line-height/margin/padding/border/white-space、相对 rect 和 Range 行框，保留完整 HTML。自定义正文 17px/1.8、段前 9px/段后 5px；列表 16px/1.7。

### 修复前（已采集）

原始证据 `output/playwright/g01/computed-style-before.json`，24 对中 12 对存在 DOM/几何差异。段落、hardbreak、空段的开关对照一致；列表/引用/表格结尾会因稳定块 mount 事务触发 StarterKit TrailingNode 多出一个空段。

| 默认设置 / editable | 关闭高度 px | 开启高度 px | 差值 px |
| --- | ---: | ---: | ---: |
| 普通段落 | 56.78125 | 56.78125 | 0 |
| hardbreak | 44.78125 | 44.78125 | 0 |
| 中间空段 | 91.171875 | 91.171875 | 0 |
| 列表 | 101.5625 | 135.953125 | 34.390625 |
| 引用 | 68.78125 | 103.171875 | 34.390625 |
| 表格 | 98.90625 | 133.296875 | 34.390625 |

普通段落 computed font-size 14px、line-height 22.4px；第二段 margin-top 12px、margin-bottom 0px，hardbreak 实际单段两行。列表内部 p margin 为 0。表格沿用已有局部排版（表头 11.5px/15.525px、正文 12px/16.8px），开关没有改变这些值。不能把这个尾部空段现象称作所有正文行距变大，也不能据此解释用户全部历史现场。

### 局部修复与收口

待补最终测试与修复后测量。

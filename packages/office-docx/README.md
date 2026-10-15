# Office DOCX：主 agent 接线与交付

关联 #118，执行 `docs/implementation/office-first-integration.md` 的 DOCX 内容编辑接入。交付为内存格式引擎和受控 React 编辑器；宿主负责固定版本、文件身份、CAS、冲突、上传和持久化。当前包不修改 root 依赖，不提交或发布。

## 构建与资源映射

在 Office worktree 根目录执行：

```sh
npm --prefix packages/office-docx ci --ignore-scripts
npm --prefix packages/office-docx run build
npm --prefix packages/office-docx test
```

`build` 自带准备流程，无需另一次 prepare。首次需要访问固定 GitHub raw 来源；缓存存在时只校验。需要提前准备或离线复用同一份源码时可执行：

```sh
npm --prefix packages/office-docx run prepare:source
node packages/office-docx/prepare-source.mjs --source /path/to/fixed-genoffice-checkout
node packages/office-docx/prepare-source.mjs --verify-only
```

固定来源为 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`。`source-lock.json` 记录实际源码闭包 252 个文件及每个文件的 Git blob SHA1、字节长度；准备流程逐个校验，拒绝错误来源。上游文件不打补丁，适配代码在本包。npm 直接与传递依赖由独立 lock 锁定。生产源码、产物和默认准备流程不依赖 tmp 或 validation 包。原始 `LICENSE` / `NOTICE` 已保留，构建收集所用源码和 npm 库许可证到 `dist/THIRD-PARTY-NOTICES.txt`。

将整个 `packages/office-docx/dist/` 复制到 `office-dist/docx/`。顶层 wrapper 可以是：

```js
export * from './docx/engine.mjs';
```

| 产物 | 接线用途 |
| --- | --- |
| `engine.mjs` | Node worker 引擎；全部 npm 库已包含，仅依赖 Node 内建模块，无 sidecar、字体或其他运行时资源 |
| `editor.mjs` | 浏览器 ESM，包含实际 GenOffice extensions 与其独立 Tiptap 3.31，保护 Record 当前版本 |
| `editor-document.css` | 固定 SDK 的文档规则，限定在 Word 正文作用域 |
| `editor-shell.css` | 使用实际 app tokens 的小工具条、canvas、滚动遮罩 |
| `runtime-manifest.json` | `engineAssets: []`、`nativeSidecars: []`；明确列出上述两个浏览器 CSS |
| `*.d.ts` / `*.d.mts` | engine/editor 公共 API 与类型 |
| `THIRD-PARTY-NOTICES.txt` | main 可收集的完整第三方 notice |
| `*.meta.json` | 构建输入及 import 审计；非必需运行时资源 |

`DocxEditor.tsx` 已相对导入两个 CSS，并相对动态导入 `dist/editor.mjs`，Vite 可直接解析。无绝对路径或 root Tiptap 升级要求。Node worker 应保留标准 `node:module` / `createRequire` 能力。源码准备目录 `upstream/`、依赖、dist 和验收输出均在包内忽略。

## API / DSH 编辑

公共类型来自 `types.ts`，命名导出 `DocxModel` / `Model`、`DocxEdit` / `Edit`、`PmJSON`、`DocxError`；React 组件同时 reexport Model/Edit。无默认组件导出：

```ts
const model = await inspect(bytes); // Promise<DocxModel>，format: 'docx'
const nextBytes = await edit(bytes, [
  { type: 'text', nodeId: model.nodes[0].id,
    expectedText: model.nodes[0].text, text: '新的中文段落' },
]); // Promise<Uint8Array>

// UI 输出完整 GenOffice ProseMirror JSON；document edit 必须单独使用。
const output = await edit(bytes, [{ type: 'document', document: nextDocument }]);
```

`inspect` 返回原件样式 `documentCss`、首节页面尺寸/边距/默认字体、可编辑文本节点和内嵌图片 data URL。文本节点 ID 如 `docx:2` 或表格路径 `docx:4/1/1/0`，同一基线内容编辑后稳定；保存后重新 inspect 取得新基线。`expectedText` 可选，提供时作为文本前置条件。单条 text edit 替换整个已有段落/单元格段落文本，沿用首个 run 的 marks；需要保留不同 run 格式时用完整 document edit。复杂内联字段/超链接段落不暴露为 text 编辑节点。

每次 `edit` 都从调用者传入的原始 bytes 重新解析，保留 GenOffice `original`、parsed 结构和 anchors，不从展示 JSON 重建 ZIP。未编辑部件保留；原件 chart、图片、分节、超链接等复杂内容不可删改。chart 不支持的变更明确抛 `UNSUPPORTED_EDIT`，不会静默丢弃。document edit 只能编辑现有普通正文/标题/列表及表格单元段落的文本和支持的 text marks，禁止增删节点、移动图片、改表结构或改原件属性。

边界校验包括 OOXML XML/rels 严格 UTF-8、字符串 Unicode 完整性、严格可序列化 JSON、实际 SDK schema 和原件节点属性。未知字段/节点/marks/attrs、稀疏数组、getter、循环、非有限数值均拒绝。ZIP 沿用 SDK 的解压预算门禁。源编辑保护在 inspect 中暴露 `readOnly` 并由 edit 执行。错误代码：`INVALID_UTF` / `INVALID_JSON` / `INVALID_EDIT` / `UNSUPPORTED_EDIT` / `READ_ONLY`。

## React 与设计契约

```tsx
<DocxEditor model={model} edits={edits} onChange={setEdits} readOnly={saving} />
```

组件只产生草稿 edits。saving 只读期间保留草稿；model 对象变化表示已提交的新基线，清空旧 undo/redo 历史及遗留 edits。宿主应在成功保存后重新 inspect 并一起设置新 model 和 `edits: []`；失败时保持原 model 与 edits。相同 model 上的受控 edits 更新不会回调循环。无自动上传/持久化或保存按钮。

已经使用 frontend-design 技能及 `.impeccable.md` context，落实 `docs/design/office-editor-direction-20261013.md` / HTML / Word 参考截图。仅撤销/重做工具条与浅灰 canvas，复用 ToolbarButton，12px UI、15px 图标、28px 控件；外壳引用现有 `--color-*` / `--font-ui` / `--radius-6`。原文件字体/颜色来自 GenOffice `docStyleCss` 和原节点 attrs，以独立作用域展示。SDK 文档 CSS 与应用外壳 CSS 分开，原件图片/表格交互保留；不可回存的 resize/move handles 隐藏。没有另外制造 SDK 应用主题。每个实例的原件 CSS 单独隔离。

文档面是单个正文滚动 viewport，不是列表，因此直接实现设计系统相同的连续边缘遮罩：只在方向存在隐藏内容时出现，随距离连续消失，ResizeObserver 更新。当前支持正文而非完整 Word 分页/页眉页脚预览；首节用于显示几何，保存保留全部节与未编辑部件。窄容器适配正文显示宽度，不改写原件页面属性。

## 验收与可复用证据（2026-10-13）

依赖：已验证固定 GenOffice 源码和真实 simple/complex DOCX fixtures；两份 fixture SHA256 记录在 `test/fixtures/manifest.json`。最初复用 `packages/genoffice-docx-validation` 与前期临时实验的验证成果，随后独立固定实际源码闭包，未重复全量 research。

- `npm ci --ignore-scripts --no-audit --no-fund`：通过。
- `npm run build`：通过；ci 后再次 build，全部 12 个 dist 文件 SHA256 完全一致，输出 `test/output/build-hashes.json`。
- `npm test`：13/13 通过。涵盖两个真实 fixture 的 text/full document 两轮保存重开、所有未编辑 ZIP 部件与独立 XML 语义对照、图片/链接/分节保留、实际 OOXML chart 修改拒绝、严格 UTF/JSON、原件保护、独立 worker 移位运行、实际 GenOffice DOM 输入、saving/rebase/history 和实例样式隔离。针对性红绿测试先复现了文本 run/新基线历史/严格 schema 等行为再实现。
- React 组件独立 strict tsc：通过；root 全量 tsc/build 由 main 统一执行。
- headless Chromium `155.0.8059.40`、WebKit `26.6`：各完成真实键盘中文段落与表格编辑、两轮保存重开、图片尺寸、saving 只读、提交后的 undo 历史清空、原件 26pt 标题、1440 宽与 480 窄截图。滚动遮罩顶部/中间/底部/16px 部分渐隐/反向与 resize 无溢出均通过；两浏览器 console/pageerror 均 0。截图已对照统一 Word 参考，未启动可见窗口或 Tauri。

真实浏览器验收为明确 opt-in，不在 build/test 内自动启动：

```sh
node packages/office-docx/test/browser-server.mjs
# 用上一行输出的 URL，以及本机已安装 Playwright 的 index.mjs：
OFFICE_ACCEPTANCE_URL=http://127.0.0.1:PORT \
OFFICE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
node packages/office-docx/test/browser-acceptance.mjs
```

脚本使用 headless 已安装 Chrome 和 WebKit；不自动下载浏览器。验收结果在 `test/output/browser/acceptance-results.json`，实截 `docx-{chromium,webkit}-{wide,narrow}.png`，保存原件 `saved.docx`。所有 server/browser 在验收后停止。后续仅因本包相关代码/依赖/配置或环境变化才重跑对应验证；不扩张 root 测试范围。

## 特权 DOM 链接边界补包（2026-10-14）

关联 #118。main 最终检查发现实际 `marks.ts` 与 `protected-render.ts` 都会将原 relationship href 直接写入 DOM，Office 主编辑器处于 Tauri 特权页面。补包范围仅本地 editor adapter 和对应 fixture/行为验证；不修改固定 SDK、来源锁、引擎或保存格式，不实现通用 sanitizer，也不靠 click 拦截处理链接。

本地 LinkMark extension 保留原 schema/marks attrs，renderHTML 只输出无 href 的 anchor、role、title 和原 class。受保护字段/嵌套表格等实际 NodeView 保留 SDK 行为，adapter 在其 detached DOM 创建及同步 update 返回前清除 anchor 导航/事件属性，保留 class/style/data-style/title。编辑器局部 plugin 同步检查挂载/transaction，作用域内 MutationObserver 覆盖子编辑器后续独立 DOM 变化并在销毁时断开；无全局 DOM monkeypatch。原 href 只作为 tooltip 展示和源 model 数据保留，所有协议均不可从文件内容导航或下载。

新增用例从真实 complex fixture 复制已有 hyperlink relationship，替换成 `javascript:window.__officePoisonedLink=1`，同时将该真实 hyperlink 放入 protected SEQ 字段结果，实际走 LinkMark 与 protected-render 两条路径。只读挂载后立即检查 DOM（不等待 observer），随后受控更新与保存重开仍检查链接惰性；两轮实际 DOM 中文编辑保存验证源 relationships 全部字节和完整 protected 字段段落原 XML 不变、源 marks/attrs 保留。

- `npm run build`：通过，252 个固定来源文件校验通过。只有 GUI editor bundle 更新，`engine.mjs`、notice 与 runtime manifest 哈希未变；main 需要重新复制本包 dist。
- `npm test`：当前 **14/14 通过**，包含新增只读 poisoned-link 渲染/源部件保留用例及原有行为回归。
- headless Chrome `155.0.8059.40` / WebKit `26.6`：两条真实渲染路径保留链接文字与下划线，全部 anchor 无导航/执行属性；普通点击、Enter、右键后零 JS 执行、外部请求、popup 或 console 错误。两轮中文修改保存重开后继续通过。

重现本次浏览器验证：以 `OFFICE_DOCX_POISONED_LINKS=1 node packages/office-docx/test/browser-server.mjs` 启动明确的验收 host，再使用同样的 `OFFICE_ACCEPTANCE_URL` / `OFFICE_PLAYWRIGHT_MODULE` 执行 `test/browser-link-acceptance.mjs`。结果记录在 `test/output/browser/link-acceptance-results.json`。此流程不启动 Tauri 或可见窗口，不进入常规 build/test。

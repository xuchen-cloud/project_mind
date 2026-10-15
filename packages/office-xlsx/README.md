# Office XLSX (#118 / F04–F06)

依赖：固定 GenOffice `d32d1711f1bf985430757b8c6b3fbddd3831d946` 的 gateway、JSONL native sidecar、IronCalc 0.7.1；OSS Univer 0.25.1。

交付：字节输入/输出、原件 OOXML 保留、明确类型的单元格编辑、基础数值公式真实重算并回写跨表缓存、React canvas 编辑入口。

非目标：File 身份/CAS/业务保存、二进制部署、结构/格式/图表编辑、大表公式计算、提交/发布。UI 对未接入的高级对象不宣称视觉保真，文件中的对应部件由原件保存链保留。

验收与验证范围：针对公开 `inspect/edit` 接口的真实 simple/complex fixtures，连续保存与重开、40/30/40 跨表缓存、ZIP 未改部件与样式、blank/string/number/formula 类型；UI 使用静默 headless 浏览器验证 canvas 和编辑 journal。不启动 Tauri。

## 主集成入口与 assets

```sh
npm --prefix packages/office-xlsx ci --ignore-scripts
npm --prefix packages/office-xlsx run build
```

源码已随包固定，不需要联网 prepare。`build` 先验证 `upstream.json` 的 Git blob SHA / `patches.json` 的补丁 SHA256，再 bundle engine/browser、编译 native 和收集 notices。需要重新取源码时可单独执行 `node packages/office-xlsx/scripts/source.mjs --fetch`，固定 commit 不变；生产不读取 validation 包或临时实验目录。

完整 `dist/` 复制至 `office-dist/xlsx/`；顶层入口可为 `export * from './xlsx/engine.mjs'`。

| 产物 | 映射/用途 |
| --- | --- |
| `engine.mjs` | Node ESM，npm 依赖已内嵌，外部 import 仅 Node builtins |
| `xlsx-sidecar` / `xlsx-sidecar.exe` | native executable；engine 默认寻找相邻文件，主 worker 可通过 `context.binaryPath` 指定聚合根路径 |
| `browser.mjs`, `browser.css` | 自包含 OSS Univer/React bundle；React wrapper 使用相对 import，交给根 Vite 打包 |
| `browser.d.mts`, `types.d.ts` | mount/mountEditor/Model/Edit/EditorProps/MountedEditor 类型声明 |
| `THIRD-PARTY-NOTICES.txt`, `LICENSE`, `NOTICE`, `browser.mjs.LEGAL.txt` | 收集原 GenOffice、Univer/npm、Cargo licenses 和内联依赖 notices |

浏览器 CSS 无附属 URL assets。`browser.d.mts` 的声明源也在包根，可在首次 build 前读取。binary 的最终资源部署由主 agent 接入。

`OFFICE_RUST_TARGET` 支持 Cargo target triple，例如 `aarch64-apple-darwin`、`x86_64-pc-windows-msvc`；build 显式传 `--manifest-path` / `--config` / `--target`，并移除 `CARGO_BUILD_TARGET` 的干扰。产物从对应 target 的 release 目录复制到固定 `dist/xlsx-sidecar[.exe]`。交叉编译需要宿主预装对应 Rust target 和 linker；本包实际编译验收为当前 macOS arm64，未声称已验证其他平台 executable。

## Engine 契约

```ts
inspect(bytes: Uint8Array, context?: {binaryPath?: string; tempRoot?: string}): Promise<Model>
edit(bytes: Uint8Array, edits: Edit[], context?: Context): Promise<Uint8Array>
loadRange(bytes: Uint8Array, sheetId: string, area: Area, context?: Context): Promise<Range>
```

坐标全部从 0 开始。`Edit` 区分 `{kind:'blank'}`、`{kind:'string',value:string}`、`{kind:'number',value:number}`、`{kind:'formula',formula:'=...'}`，都包含 `{sheetId,row,column}`。例如文字 `'=literal'` / `'15'` 不会被重算链误解释成公式/数值；空字符串与 blank 区分。拒绝 NaN/Infinity、错误字段类型、额外 Edit/context 字段、孤立 surrogate；native JSONL 严格 UTF-8、Unicode scalar、有限数值和 envelope/result shape 校验，错误不会降级成缓存成功。

`inspect` 返回 native `styles/sheets` 与 `ranges[sheetId]` 的 cells/rows/merges/保护及源扩展元数据。每表初始 **A1:Z100**，原数据之外的空白行列可直接输入。native 只读取与已用区域的交集，交集外为确定的空白；未加载范围不会被视为空白。`loadRange` 是显式扩展入口，单次最多 100000 格。UI 需要从 A1 开始的连续矩形；主层扩展前先提交并保存草稿，再用相同源版本请求更大 A1 矩形并替换 model；组件不自行读文件或发起 I/O。

输入 ZIP 最大 64 MiB、最多 32 sheets；保存的全工作簿已用矩形（含新增坐标）合计最多 20000 格。这是初期小表/基础数值公式预算。真实 IronCalc 重算每个公式并回写缓存，包括无用户编辑的依赖 sheet；修复 gateway planner 的 `formulaValues` sheet 收集。公式错误、非数值结果、共享公式 inventory、未完成/截断 inventory 或被引擎跳过的公式均拒绝 candidate；不借源缓存假装重算成功。受保护 sheet 和数组公式单元格编辑拒绝。

原 ZIP 保存链仅修改编辑/公式缓存所在 worksheet；源样式、合并、行列尺寸、关系、主题、图片、图表、数据验证、条件格式、注释等未触及 parts 保留。无 edits 时校验后返回原 bytes。浏览器显示基础网格、原单元格字体/填充/边框/数值格式/合并/冻结/行列尺寸；高级对象可保留于文件，但本阶段不承诺完整图表/图片/条件格式渲染或 Excel 功能覆盖。

## UI 与主保存流程

`XlsxEditor` 命名导出，`Model/Edit` 从 `package/types` re-export。基础 props 是 `{model,edits,onChange,readOnly,onPendingChange?}`；React 外层另接受：

```ts
registerBeforeSave?: (callback: () => Promise<void>) => () => void
```

`mount` / `mountEditor(container, props)` 返回 `{ready,commitEditing,update,dispose}`。注册回调等待 mount 完成，并调用真实 SDK `workbook.endEditingAsync(true)`。宿主 **先 await beforeSave，后读取最新 journal 并调用 session.save**；saving 阶段 `readOnly=true`。读写锁不能代替 commit：直接切 readonly 会取消未提交输入。关闭、Cmd+S、按钮保存、刷新 guard 均应走同一 beforeSave。

`onPendingChange(true)` 来源为实际 `SheetEditChanging` 内容改变，选择或打开未变单元格不触发；提交后的 journal 结算或 Escape 取消才发 false。主层把 pending 与 journal dirty 一起纳入外部版本重验保护。暂不接受 SDK boolean 编辑；尝试保存 TRUE/FALSE 会保持 pending/原输入并报错，文字可使用 SDK 单引号前缀。

model 引用替换视为已提交的新基线，宿主同时传 `edits:[]`；旧 undo/redo 随新 workbook 清除。组件只产生 edits/pending 通知，没有自动上传、持久化或业务版本操作。

## 主题与设计验收

应用 `frontend-design`，遵循 `docs/design/office-editor-direction-20261013.md` 与 `.impeccable.md`。外壳直接使用实际 `--color-bg/bg-subtle/canvas/border/text-primary/text-secondary/text-tertiary/accent` 和 `--font-ui`。仅有 28px undo/redo（16px 图标、6px radius）、原生公式栏、canvas、工作表导航；无重复标题/save row，无额外卡片。文档自身样式独立，不改源字体/颜色。

SDK 主题接口是 `new Univer({theme})`；本包 `hostTheme` 把宿主实际 tokens 映射到 `@univerjs/themes` 的 `primary/gray/white/black`，不添加颜色 fallback。core preset 配置禁用格式工具栏、上下文菜单、统计菜单和新增 sheet。禁止的结构/格式 mutations 同时有行为门禁。保留 SDK 原生选区、公式输入、工作表和滚动交互。没有新增自有有界滚动列表；原生网格保持 SDK 的横纵滚动条。

范围 notice 仅在当前 sheet 的 metadata 尺寸超出已加载 rectangle 时显示，工作表切换会更新；文字明确当前范围及其余区域仍保留。源含图表/图片时另提示“暂未预览，原件内容仍保留”。完整且无高级对象的小表不显示 notice；无分页/自动扩大读范围。UI 验收使用 complex 的真实候选文件新增 AA101 生成部分范围场景。

真实截图见 `evidence/` 的 Chromium/WebKit 宽 1100×700、窄 560×520。对照统一方向：小工具条/公式区/网格/底部 sheets 顺序一致，空白格可见，原文件标题单元格/色彩/合并/冻结保留，窄容器通过 SDK 横向滚动；截图是包编辑面，主文件 header 由宿主提供。

## 验证记录（2026-10-14）

- `npm run build`：通过，含 native、browser/engine、声明与 notices；`npm run check:source`：通过。
- `npm run typecheck`：通过，包含 React wrapper 与 browser 声明消费。
- Engine 11 个针对性用例：9 个核心用例及新增源 UTF-8/独立 dist 搬迁用例均通过；相关协议用例覆盖损坏 UTF-8/JSON、错误 result shape、孤立 surrogate，scratch 清空。
- simple/complex 各三次连续保存重开：40/30/40 → 35/20/35 → 40/30/40；新增 D20/D21/E21（空白格）连续保存重开，真实公式结果 10；显式扩展及预算拒绝通过。
- `python3 tests/verify-candidates.py`（openpyxl/lxml）：simple **80/80**、complex **94/94**，包括缓存、原样式、未改 worksheet XML、原 ZIP 压缩 payload、元数据与部件集合。
- `cargo test --locked --release --manifest-path native/engine/Cargo.toml --config native/engine/.cargo/config.toml --target-dir native/target recalc::`：**18/18**。
- `OFFICE_WEBKIT_EXECUTABLE=<installed WebKit pw_run.sh> node --test tests/browser.test.mjs`：Chromium **151.0.7922.34** / headless WebKit **26.5** 均通过实际键盘输入、pending true/false 及 journal 结算顺序、不按 Enter 提交、原 bytes 保存重开、冻结、undo/redo、新基线、取消、dispose、宽窄截图。WebKit 缓存路径是测试环境变量，不进入生产 bundle；安装匹配 Playwright 浏览器时可省略。headless WebKit 不能代替 WKWebView 最终应用验收。

输出 JSON/日志在 `tests/output/`；可复用的最终证据在 `evidence/`。未启动 Tauri/用户窗口、未提交/发布、未修改原 checkout/root package/lock。最终截图服务只使用临时 loopback 端口，并在测试结束释放。

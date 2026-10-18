# GenOffice 独立审查后的阶段修复（#191 / #118）

起点：`256d3d6`。用户授权并行实现；本包不代表 #191 全功能完成。

## 交付与依赖

- Excel 完整 gateway 日志在正式 Node 权限边界内保存、重开，不扩大文件权限。
- PPT 本地日志回传不重建会话，撤销、当前页与工具栏保留；外部替换和旧回执继续隔离。
- Word、PPT、Excel、Markdown 的导出与打印归入文件菜单；撤除 Excel 重复 AI 外壳。
- 双栏 490 / 640 CSS px 下菜单文字、Ribbon、状态栏可用，保留完整编辑功能。
- 默认先进入只读预览，预览与编辑复用同一完整渲染器、版式和实例，切换只改变编辑权限和工具界面；不以简化阅读视图换取速度。以版本/hash 隔离的有界模型缓存减少重开解析，历史版本仍走原生读取核验。保留 File / CAS / 历史。

依赖为已固定的 GenOffice 包、File/CAS 与现有原生输出服务。子任务文件范围按格式包分离，主负责共享宿主、Markdown、整合和真实桌面验收。

## 非目标

不扩展拼写/Zotero、新格式、加密、图床、演讲者视图，不以本包关闭整单。Windows 无实机，只报告实际执行层级。临时审查工作区之外不编辑业务文件。发布沿用此前用户的禁止推送、合并和关闭 Issue 约束。

## 验收与验证范围

1. 对应回归须先复现真实原因，再验证修复；不以 mock 或无限放宽权限替代生产链。
2. 运行受影响宿主、格式包及构建资源检查；未变原生实现的已有证据按范围复用。
3. 集中用可见 Tauri 临时文件复验 Excel 保存重开、PPT 编辑/撤销、四格式文件菜单、窄栏及预览/编辑切换。
4. 与审查记录同样本测量打开就绪耗时，分别记录首开与热重开，不把加载占位当作内容就绪。

## 结果

本包实现与下列范围的验证已完成，保留未提交改动供检查。分支仍为 `codex/genoffice-editor-parity`，HEAD `256d3d642b9c9f49285069565012f56a7d826b7d`；全部结果属于该提交后的工作区，不倒算为阶段提交本身的证据。

### 预览一致性修正

用户复验明确要求预览与编辑具有相同展示效果。本包撤下了早先的 Word 简化阅读模型、Excel print-HTML 与 PPT 独立 SVG 预览，不将其加载耗时算作最终性能成果。四格式现在复用完整渲染及挂载实例，预览只改变权限与编辑工具界面，保留文件菜单和底部导航/缩放。

- Word 真实 Tauri 490px 栏：预览/编辑均为三页、49% 缩放、相同页眉/页脚/图片/表格。截图 `fixes/word-final-{preview,edit}.png`。
- Markdown 真实 Tauri：同一块渲染内容切换只读/编辑；图片和格式保留。首次块渲染暴露的 StrictMode/Suspense 初始化崩溃已通过 `immediatelyRender:false` 修复，遵循现有 Record 编辑器生命周期方式；源码编辑器改为首次选择源码/分屏时加载。
- 完整渲染资源与原生 inspect 并行，模型缓存按 Workspace/generation/File/version/hash 隔离（4项/16MiB），历史读取继续原生验证。缓存仅保存模型，不包含写权限或原生回执。
- 原完整 renderer 资源仍较大：构建图显示 Word JS 约8MB加多字体，Excel JS约27MB/CSS约11MB，PPT JS约5MB/CSS约7MB；仅隐藏工具栏不会减少这些资源。后续性能结论须以稳定构建后的真实正文就绪计时为准，不以按钮启用或占位出现代替。


## 修复依据与收口检查

- Excel 正式 gateway 保存：生成器及生成文件将临时候选文件限定在目标目录，并标记 temporaryCandidate；没有扩大 Node 文件权限。正式 packaged permission worker 和真实 Tauri 都保存成功。
- PPT cloned edits 按 DTO 值比较，保持现有 session/epoch；原生基线与上游可变归档分离，避免首次保存前结构编辑污染 changed-parts 清单。保留原有 CAS 和候选清单校验。
- PPT 冷启动空 root：稳定窗口复现后增加监听器安装/onLoad 的确定性 ready 查询，重复应答不重建实例，清理时关闭旧连接，双方拒绝旧 port 消息。主动丢弃首次 ready 的浏览器红例转绿，随后真实 Tauri 冷启动显示正常。未添加定时重试或字体静默降级。
- Markdown 源码懒加载：首次行定位保留目标，源码控制器 ready 后再应用，按 documentKey 拒绝旧目标；真实 CodeMirror 选区回归通过。首次块渲染采用现有 Tiptap 推荐的延后初始化生命周期。
- 共享宿主：只读初始化 pending 不标记为用户修改；保存并预览等待实际回执，失败或保存期间的新输入保留编辑态与草稿。模型缓存仅在当前原生 resolve 验证后使用，历史绕过缓存。
- 主 agent 自查 Standards：检查固定上游与适配层边界、资源预算、只读和异步连接失效、File 身份隔离及保存错误路径。Spec：按下列真实桌面与包测试核验本包行为；不将浏览器或 mock 结果列为原生实机通过。不启动 review 子 agent。

## 实际验证命令与分层

所有命令 cwd 为 `/Users/xuchen/project_mind`，使用项目 Node24。`NODE` 指 `src-tauri/resources/agent-host/node`，`NPM` 指 `/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js`，实际运行时展开为绝对路径。证据根目录 `/tmp/projectmind-independent-audit-20261018/fixes/`。

| 层级 | 实际命令 / 范围 | 结果与证据 |
| --- | --- | --- |
| 完整资源构建 | `NODE NPM run build` | 通过，`root-build.log`；PPT 最终握手包随后另行构建 |
| 最终前端 | `NODE node_modules/typescript/bin/tsc --noEmit`；`NODE node_modules/vite/bin/vite.js build` | 通过，`final-tsc.log`、`final-vite-build.log` |
| 宿主 / worker | `NODE NPM run test:office` | worker 9/9、前端147/147，无 skip，`final-office-tests.log`；包含保存失败、保存中新输入、历史/切换/旧回执等测试；mock 原生部分不算桌面验收 |
| Markdown 实际组件 | `NODE node_modules/vitest/vitest.mjs run src/components/markdown/MarkdownEditor.test.tsx --maxWorkers=1` | 2/2，通过同一富文本 DOM/格式/图片/强制只读，以及首次源码行定位；`markdown-line-jump-final.log`；JSDOM 文本几何有测试替身 |
| 缓存 | `src/lib/office-preview-cache.test.ts` | 2/2，身份/版本/隔离与缓存限制；见 `markdown-preview-final.log` |
| 资源 staging | `NODE scripts/stage-office-runtime.mjs darwin-arm64` | 通过，`final-stage-office.log` |
| 正式权限 worker | `NODE packages/office-runtime/verify-packaged.mjs` | Word、Excel 完整 gateway / scalar、PPT 原生路径编辑重开均通过，`final-packaged-verifier.log` |
| UI / 包体 | `NODE scripts/check-ui-standards.mjs`；`NODE scripts/check-bundle-boundaries.mjs`；`git diff --check` | 通过；初始 main248KiB/250KiB，编辑器仍懒加载 |
| 格式包 | Word Chromium/WebKit presentation；PPT29单测、handshake/protocol/presentation/host-echo/caret；Excel gateway、presentation、renderer/protection/output | 对应范围通过。Word命令和产物见 `packages/office-docx/README.md`；PPT完整命令见 `packages/office-pptx/output/playwright/fix191-summary.txt`；Excel见 `/tmp/projectmind-independent-audit-20261018/fixes/xlsx-handoff.md` |
| macOS 真机 | 可见 Tauri，临时工作区 GUI | 下节列明；与 Chromium/WebKit headless 分开 |
| Windows | 本包未运行交叉编译，无 Windows 实机 | 未验收；不能从 macOS/headless 推导 Windows 通过 |

完整构建有既存 direct-eval/ineffective-dynamic-import 提示，退出码0。没有 Rust 产品源码改动，本轮未重复 Rust 全量。打印/PDF菜单搬移的包级输出用例通过；本包最终桌面重点为入口归位，未重新生成最终版 PDF，先前审查的实际 PDF 不能替代本包新增验收。

## 真实桌面步骤与证据

环境：macOS26.5.2 ARM64，Tauri 可见窗口使用固定调试二进制及本轮 staged 资源、localhost1420；禁用 Tauri watcher。仅临时工作区 `/private/tmp/projectmind-independent-audit-20261018/workspace`，没有操作业务文档。

1. Word 在490px侧栏打开三页样本：预览/编辑均三页、49%缩放、相同图片/表格/页眉页脚；File输出弹窗可用。`word-final-preview.png`、`word-final-edit.png`、`word-file-menu-narrow.png`。
2. Markdown 同一块编辑渲染预览/编辑，标题、粗体、图片保持；490px文件菜单五项可见。`markdown-fidelity-preview.png`、`markdown-fidelity-edit.png`、`markdown-490-file-menu.png`。
3. Excel 点击编辑，名称框打开GoTo对话框定位B3，F2将10改为15，回车，宿主保存。收到v2/已保存；实际ZIP内B3=15，SUM(B3:B4)=35、B3*2=30，百分比0.125、换行文本、图片/图表/关系文件保留。关闭后重开显示相同结果。`xlsx-native-save-v2.png`、`xlsx-native-bytes-v2.json`、`xlsx-reopen-v2.png`。490px菜单/横向工具栏/页签/缩放截图：`xlsx-490-edit.png`、`xlsx-490-file-menu.png`。
4. PPT 新增页后为2/5，等待超过160ms日志回传，切到绘图选项卡，Undo仍启用且当前页保持，撤销回4页且clean。`pptx-desktop-undo.png`。窄栏预览/编辑保持25%控件值（显示24%，上游取整），`pptx-490-preview.png`、`pptx-490-edit.png`；文件菜单包含保存/PDF/打印/图片，`pptx-490-file-menu.png`。
5. 最终握手包稳定重启后，初始双栏Markdown/PPT正常。另做PPT新增第五页→宿主保存v5→回执后第2页与Undo保持→关闭重开五页，ZIP含图片与备注。`final-cold-preview.png`、`pptx-native-v5.png`、`pptx-native-bytes-v5.json`、`pptx-reopen-v5.png`。

截图均位于证据根目录；早先简化预览和构建/HMR期间截图保留作过程记录，不是最终交付效果。

## 打开性能实测与未完成目标

稳定最终资源、无构建/测试竞争时，通过可见Tauri从点击起计时，轮询真实正文/页数，未以编辑按钮出现为就绪。单次样本，不是p50/p95：

| 场景 | 观测耗时 | 条件 / 证据 |
| --- | --- | --- |
| 新进程首次并发打开 Markdown/PPT | 3182 / 4194ms | 块正文/幻灯片1/4，`stable-cold-markdown-pptx.json` |
| 新进程首次打开 Excel 格式 | 3961ms | 另一栏PPT已开，完整工作簿就绪，`stable-first-xlsx.json` |
| 新进程首次打开 Word 格式 | 5211ms | 另一栏PPT已开，第三页内容与共3页已出现，`stable-first-word.json` |
| Word 热切回重挂载 | 586ms | 同样三页内容，`stable-warm-word.json` |
| Excel 热关闭重开 | 1004ms | 完整工作簿就绪，`xlsx-stable-warm.json` |

旧审查样本为Word热开2430ms、Excel首开6095ms、PPT首开4380ms、Markdown热开909ms；缓存状态、并发及首开定义不完全一致，因此仅作线索，不能据此给出统一提升百分比。没有把早先简化预览计时用于最终结果。

已实现原生inspect与精确renderer并行、有界模型缓存、Markdown源码首次使用加载。完整同渲染器意味着初开仍要解析大资源和初始化字体/排版/Univer，隐藏工具栏本身不能省掉这些成本。**首开普遍秒开仍未达成**，后续需拆分完整renderer初始化与非可视编辑模块，并重新做同条件冷/热统计；不能退回损失版式的预览冒充完成。

## 整单差距

本包修复已确认的保存、生命周期、菜单与窄栏问题，不代表 #191/#118 全量功能矩阵已完成。Windows 实机、矩阵未交付的编辑能力及复杂文档/大文件覆盖仍按原审查分层；上游限制与用户明确排除项不因此改变。未提交、推送、合并或关闭 Issue。


## 追加工作包：宿主文件菜单与窄栏收口

- 关联 #191/#118，依赖前述同渲染器预览；不发布、不改业务文件或 pinned upstream。
- 交付：四格式共用宿主第一行图标文件菜单、共同操作的名称/顺序/样式一致；格式专属导出保留；移除编辑器重复文件/保存/自动保存入口；默认自动保存；Word AI 容器与多余分隔线清理；三 Office 状态栏 28px 和窄栏功能可达。
- 验收：490/640px 预览只剩宿主第一行；编辑无重复保存/自动保存切换；菜单真实接线、只读可输出；自动保存等待输入完成、失败保留草稿、切换撤销旧定时器；macOS GUI 集中截图。
- 验证：各包针对性构建/浏览器输出与布局用例；宿主保存/生命周期/菜单用例；最终 TypeScript/Vite、资源 staging、UI/包体边界。Windows 不推定验收。


### Markdown 追加规格（用户最新指示，覆盖此前 Markdown 浏览态）

Markdown 默认直接块编辑，无独立预览态；只在同一工具栏用图标切换源码/块编辑，文件名行移除源码入口。精简可直接用 Markdown 语法完成的工具；保留复杂插入。共用记录编辑器右键菜单结构和命令能力，避免引入记录 AI/附件外壳；统一浮层、边距与 28px 状态栏，去掉整篇选中蓝框。只读历史仍强制只读，自动保存/手动保存沿用 File/CAS 回执。验收增加两模式往返、右键文本/表格真实命令、历史只读和窄栏控件。

### 公共界面追加规格

用户复验指出仅对齐状态栏高度不够，PPT 与 Word 的缩放滑轨、滑块和布局仍有差异。本包继续把四格式缩放实现与公共 chrome 样式收敛到共享模块，避免各包复制覆盖。文件菜单沿用同一宿主组件；工具栏与菜单的通用容器、控件和滚动提示共用样式，各格式的实际编辑命令保留。新增验收包括共享模块被各 renderer 真正使用、Chromium/WebKit 的缩放交互、490/640px 布局及最终桌面截图。

### 加载过程追加规格

四格式使用同一加载组件和骨架样式，按真实读取、编辑器加载、内容初始化状态展示。不得以固定计时或假百分比替代就绪信号；Word 暴露已有 renderer ready Promise，Excel 复用 ready，PPT 复用初始化消息。验收包括错误时退出加载、旧文档异步完成不解除新文档遮罩、窄栏、主题及 reduced-motion；加载表现与打开速度分别报告。

### 系统恢复与证据保存

2026-10-18 系统卡死恢复后，分支仍为 `codex/genoffice-editor-parity`，HEAD 仍为 `256d3d642b9c9f49285069565012f56a7d826b7d`，源码未丢失。原 `/tmp/projectmind-independent-audit-20261018` 与 `/tmp/project-mind-shared-chrome` 已消失。上文引用这些目录的测试和截图是此前工具回执记录，**当前原始文件无法复查**，不应当作本轮最新源码的可读证据。

后续证据改存持久目录 `/Users/xuchen/.codex/visualizations/2026/10/18/01a14ef6-bb52-7bf1-a68d-4427a90620aa/genoffice-ui-evidence`。恢复三个既有实现 agent，未新增 review agent；资源构建和浏览器检查串行执行。可见桌面复用现有 debug 二进制创建隔离的 `ProjectMind Review.app`，资源指向当前 staged resources，连接 localhost1420，使用独立 app-data 与新建测试 Workspace，不使用业务 Workspace。

### 共享实现入口

- 第一行文件图标菜单：`src/components/document/EditorFileMenu.tsx`，四格式复用同一个 `ActionContextMenu`，共同操作顺序一致，按格式保留实际支持的输出。
- 四格式缩放：`packages/editor-chrome/StatusZoom.tsx` 与 `status-bar.css`；Office 通过 pinned AST 适配接入，Markdown 直接引用。统一 28px 状态栏、12px 字号、24px 控件、100px 滑轨；保留各格式原生缩放模型、范围和对话框。滑轨逐百分比取值，按钮可沿用原生步进，避免自适应 72% 被 range step 强制显示为70。
- 菜单、工具栏公共外观与滚动提示：`packages/editor-chrome/editor-chrome.css`。共用通用控件和样式，格式专属命令、复杂画廊和内容模型保留在各自 renderer。
- Markdown 与 Record 的文本/表格菜单：`src/components/rich-editor/editorContextMenu.ts`。Markdown 通过同一菜单结构执行实际 Tiptap 命令，删除浮动表格工具条；异步剪贴板操作仍校验文档、选区与只读状态。
- 加载过程：`src/components/document/EditorLoading.tsx` 与 `EditorLoading.css`。读取、解析、模块加载、画布就绪使用真实所属阶段；ready Promise/当前初始化 epoch 解除遮罩，失败显示错误，不以定时器猜测完成。
- Markdown 白色内容区：块模式、源码正文和行号使用统一白色 `--md-paper`；去掉源码当前行灰底，保留文字选区和查找命中反馈。

### 恢复后桌面实际操作（当前工作区改动）

1. GUI 新建隔离 Workspace / GenOffice 项目，导入仓库 Word/PPT/Excel 固定复杂样本及新建 Markdown。首次打开 Markdown 实际出现共享骨架与“正在加载编辑器”，然后进入默认可编辑块模式。证据：`native-markdown-opening.png`、`native-markdown-default.png`。
2. Markdown 实际输入“恢复后块编辑保存验证 A1”，默认自动保存收到 v2；右键空选区表格单元格出现共享表格菜单，点击“下方插入行”新增一行，自动保存收到 v3。对选中文字右键显示共享文本格式菜单。证据：`native-markdown-table-context.png`、`native-markdown-table-menu.png`；实际文件 `workspace/GenOffice/Audit-Markdown.md` 含标记与新增空行。
3. 切源码可见同一已保存内容，历史 v1 显示“历史版本·只读”，表格/图片/公式等变更操作禁用，块内容不再可编辑；返回当前版本、关闭后重开仍有标记及四行表格。证据：`native-markdown-source.ax.txt`、`native-markdown-history.ax.txt`、`native-markdown-history-490.png`。中文输入是粘贴，不是中文输入法组合态实机验收。
4. Word 完整版式只读预览与 Markdown 并排，预览无额外 ribbon 行；窄栏 Markdown 文件菜单仍从第一行图标打开，显示共同输出入口。证据：`native-word-markdown.png`、`native-word-markdown-490.png`、`native-markdown-490-file-menu.png`。
5. 用户指出源码灰底后，移除行号栏与当前行灰底，桌面复验两者与正文均白色，块模式也明确使用相同纸面色。证据：`native-markdown-white-source.png`。

以上只列实际执行的步骤，不代表四格式全部编辑矩阵、中文输入法或 Windows 已验收。最终共享 Office 包与整合检查结果另列于后续记录。

### Markdown 正文与表格最后收口

- 按用户最新反馈，在宿主的 extensions 适配层移除 `blockDragHandle`，不再创建遮挡正文的点点按钮与其弹层；不修改固定上游。插入继续使用工具栏、斜杠和右键菜单。
- 正文、标题、列表与表格共用 Record 的 `--rich-text-*` 字体、字号、行距和段距，默认正文/表格14px、行高1.6。通过 `--md-zoom` 统一缩放正文、标题与表格。表格单元格 padding 为5px/7px，段落 margin 为0，避免段落空隙撑大行高。保留白色纸面。
- macOS 可见窗口约463px右栏实际验证：点击标题不再出现 gutter；100%→110%→100% 缩放有效；表格右键仍显示共享行列操作菜单，浮层完整可见。证据：`native-markdown-record-style.png`、`native-markdown-compact-context.png`、`native-markdown-final-clean.png`。
- Word/PPT 编辑态并排截图 `native-word-ppt-shared-edit.png`；Excel/Word 的预览及编辑态截图 `native-xlsx-word-shared-preview.png`、`native-xlsx-word-shared-edit.png`。缩放滑轨与按钮均来自公共组件；预览保留完整内容并隐藏 ribbon。

### 恢复后最终验证与复用范围

以下日志均在上述持久证据目录。没有重跑与改动无关的全量测试，也没有把历史临时证据当作可复查新证据。

| 范围 | 实际命令 / 结果 | 证据 |
| --- | --- | --- |
| 宿主、保存、生命周期、加载、Markdown、菜单 | 根 Vitest 13个针对性文件，148/148通过；发生在最后 Markdown 排版改动之前，未受影响范围复用 | `root-targeted-tests-final.log` |
| 最后 Markdown 改动 | Vitest `MarkdownEditor.test.tsx`、`RichMarkdownEditor.contextMenu.test.tsx`、`MarkdownFileContent.test.tsx`；38项中37项直接通过，1项旧16px缩放断言失效；改为验证Record字号所用的缩放比例后，仅重跑失败项通过 | `markdown-compact-final-tests.log`、`markdown-compact-zoom-retry.log` |
| Record 公共菜单提取回归 | Vitest `RichEditor.test.tsx -t …`，8个选中文本、剪切失败、表格菜单/插入相关用例通过；另123项因明确过滤未执行 | `record-context-menu-final.log` |
| TypeScript | `NODE node_modules/typescript/bin/tsc --noEmit`，最后源码通过 | `root-tsc-compact-final.log` |
| 前端生产构建 | `NODE node_modules/vite/bin/vite.js build`，最后源码通过 | `root-vite-compact-final.log` |
| UI / 包体 | `NODE scripts/check-ui-standards.mjs`、`NODE scripts/check-bundle-boundaries.mjs`通过；main248KiB/250KiB，编辑器仍按需加载；`git diff --check`通过 | 工具退出码0；此前同检查日志 `root-ui-standards-final.log`、`root-bundle-final.log` |
| 运行资源 | `NODE scripts/stage-office-runtime.mjs darwin-arm64`退出码0 | `runtime-stage-final.log` |
| 三 Office 公共组件 | 各包最后构建、共享tsc通过；Chromium/WebKit 490px实际菜单6/6，72%/49%精确缩放及真实画布尺度6/6通过 | `shared-chrome/commands.txt`、`summary.txt`、`final-results.json`、菜单/缩放截图 |

Office 菜单检查真实发现并修复了Excel字体菜单被画布截挡、PPT嵌套版式画廊超出490px视口；保留红例和修复后的命中测试，未放松断言。历史490/640/1440全宽度对照原日志丢失，公共几何未变部分沿用此前回执，最新受影响菜单/滑轨有上述持久证据。

这轮没有重新执行完整桌面格式功能矩阵、生成最终PDF、验证Windows或实测新的冷启动统计；不能据此认定秒开目标或 #191 整单完成。所有修改仍在工作区，未提交、推送、合并或关闭Issue。

## 用户授权发布后的最终审视

用户明确要求最后一次实机演示与代码审视，处理问题后提交、推送并合入develop，覆盖此前本轮不发布的限制。仍按阶段交付记录，不关闭未完成的#191/#118。Standards/Spec由主agent审视，未启动review子agent。

复核已修复一项异步权限缺陷：Word/Excel/PPT公共宿主和Markdown宿主在等待 `beforeSave` 时若同一File切为只读，之前会继续进入原生写入；现等待结束后重新核验最新只读状态，明确拒绝旧保存，保留草稿、不调用新旧 `onSaved`。两项新测试先红后绿，两文件36/36回归通过。证据：`readonly-save-beforeSave-{red,green,regression}.log`、`readonly-save-beforeSave-commands.txt`。

另补共享菜单选项卡样式遗漏：Excel上游按钮没有`.ribbon-tab`类，之前公共tab字体/选中规则没有命中；公共CSS现同时覆盖实际Excel按钮和Word/PPT tab，统一28px/13px、普通400/选中600、主色和2px下划线。复杂原生命令保留，最终浏览器复验另记。

### 最终增量回归

Excel 新增回归区分了两个事实：浏览器未复现“单纯预览切编辑即写版本”；实际红例是没有修改时 `commitEditing` 仍发出 `change([])`。初始化时以真实 edits 建立签名，干净保存不再发送保存请求；宿主仍以1200ms自动保存已提交修改。Chromium/WebKit 三项回归通过，包含真实输入、File回调返回格式字节、重开和公式/对象保留。证据 `xlsx-init-autosave-handoff.md` 与对应red/green日志。

最新公共选项卡回归在 `shared-tabs`：三Office串行重建、共享tsc通过；Chromium/WebKit六例通过，实际切换插入/开始，验证13px/28px、普通400/选中600、文字主色和2px下划线，并执行真实菜单命中与关闭。`shared-tabs/final-results.json`保留computed-style，Word README记录最终产物hash。

主agent对当前阶段修复按Standards/Spec复核：固定上游保留，公共组件被实际renderer使用；保存后跨异步权限重新核验、File身份/epoch和CAS路径保留；本轮已发现的菜单、预览失真、生命周期、MD样式与加载问题均有修复及针对性验证。此结论仅适用于本修复范围，不表示四格式完整矩阵、Windows实机或冷启动秒开目标完成。用户授权的最终同步develop、桌面演示及发布结果在后续段落记录。

## develop同步与最后实机演示

修复提交 `890fb38` 后同步 `origin/develop@3ee8184` 的七个提交。唯一源码冲突在 `ProjectFileContent.tsx`：保留删除/不可用原件关闭前确认、工作区复核、编辑revision与重复关闭保护，并沿用本包editor命名、共享菜单/加载及Markdown保存。Rust新增 `DeletedDisk` 测试适配当前 `OfficePayload` 接口，未改变测试行为。

### 合并后验证

- tsc、Vite生产构建、UI规范和包体检查退出0；main249KiB/250KiB，编辑器仍懒加载。日志 `root-tsc-merged.log`、`root-vite-merged.log`、`ui-standards-merged.log`、`bundle-merged.log`。既有dynamic-import提示仍在，不能称零warning。
- 关闭路径：最终 `ProjectFileContent.test.tsx` 76/76；同次初跑其他三个文件17项通过并按未变范围复用，共93项有效通过。真实点“编辑”、缓存隔离及已mock编辑器的无关预加载已适配；失败和重跑见 `merge-develop-closeguard-verification.txt`，未把首次失败整组标绿。
- `cargo build --manifest-path src-tauri/Cargo.toml --bin project_mind_alpha --quiet -j 2` 退出0。`cargo test --manifest-path src-tauri/Cargo.toml --lib office_save_ --quiet -j 2` 首次因新增测试旧trait签名编译失败，适配后6/6；`cargo test --manifest-path src-tauri/Cargo.toml --lib office_real_ --quiet -j 2 -- --include-ignored` 实际执行两个真实格式验收，2/2。日志 `native-merged-build.log`、`rust-office-save-merged-retry.log`、`rust-office-real-merged.log`；首次失败日志也保留。
- 最新Office构建重新stage darwin-arm64，`verify-packaged.mjs` 在生产permission worker完成三格式字节编辑重开及Excel renderer gateway/公式值保留。见 `runtime-stage-publish.log`、`packaged-permission-publish.log`。

### 合并后可见桌面操作

使用合并后debug二进制更新隔离.app并单次重开，全部操作仍在临时Workspace：

1. Markdown块模式输入ASCII标记B2，自动保存v7；实际文件及关闭重开仍含标记、表格和Mermaid。见 `publish-markdown-reopen.png`、`publish-markdown-reopen.ax.txt`。白色正文、Record字号、紧凑表格、无点点gutter及整篇蓝框维持。
2. Word粘贴“待修改中文段落：最终实机 B2。”，自动保存v2，关闭重开仍含该段、三页、表格、图片和分节内容。见 `publish-word-reopen.ax.txt`。PPT第三页备注追加B2，自动保存v2；关闭重开后点击第三页仍有B2，见 `publish-ppt-reopen.ax.txt`。备注编辑不等于全部幻灯片元素验收。
3. Excel v2进入编辑、等待并点击第一行无修改保存，实际SHA256和版本不变。见 `publish-excel-clean-save.png`、`publish-native-byte-proof.json`。实际B3最终保存为15(v4)，关闭重开显示15、合计35、依赖公式30、百分比12.5%。第一次F2/Cmd+A没有选中旧值，追加成1015(v3)；随后通过GUI删除旧值输入15修正。此过程保留在字节证据，未将中间值标为成功。见 `publish-excel-reopen.png`。
4. 约470px右栏Word文件图标菜单全部可见；长字体提示不会挤出共享缩放。Word/PPT编辑态及Excel/Word预览态共用控件。见 `publish-narrow-word-file-menu.png`、`publish-word-ppt-edit.png`。本轮不宣称640/1440全矩阵均做了实机复验。
5. Word第一行菜单实际执行导出PDF，经原生保存对话框保存 `Word-final.pdf`，37475字节，Quartz PDFContext、A4、3页。PDFium逐页渲染检查中文、B2、图片、表格、分页与分节页眉页脚。见 `pdf-final-info.txt`、`pdf-final-text.txt`、`pdfium-final-page-1.png` 至第3页。本机Poppler缺Adobe-Japan1语言包产生字体警告，改用PDFium核验，未只凭导出回执认定成功。

### 最终代码审视与边界

主agent完成Standards/Spec双轴：本轮确定的保存权限、旧异步回执、PPT父回显重置、Excel生产gateway权限、预览版式、共用菜单/缩放/加载、Markdown正文/表格/gutter问题均已处理。合并保留双方必要行为，当前阶段发布范围没有剩余阻塞发现；未启动review子agent。

非阻塞后续：Excel只读预览仍沿用上游“行列可编辑”的状态文案，实际权限由宿主及renderer限制，后续需收敛文案。首开普遍秒开目标未达成；Windows实机、中文输入法组合态、完整功能矩阵未验收。本次仅发布已验证阶段，不关闭#191/#118。

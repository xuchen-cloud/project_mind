# 项目内容 Tab 实施记录

路径约定：`$VALIDATION_TMP_ROOT` 为原验证产物的临时根目录。复跑前按环境设置；历史临时产物不随仓库提供。


更新：2026-10-13。父 Issue：#124。规格：[完整需求](project-content-tabs.md)、[handover](project-content-tabs-handover.md)。

## 接收基线

- HEAD `91b35defa55a8dc36b3e50de10127b0652800df5`，分支 `codex/ai-enhancement`。已有 AI 设置、Overview 与 Voice 等未提交改动必须保留；本任务只提交明确属于本包的文件或差异。
- 接收时用户进程为 `tauri dev --no-watch`；源码编辑不会触发原生重启。10 月 13 日继续时没有 `tauri dev` 进程。静默验证，GUI 集中执行前告知。
- 已有 File 版本/CAS/恢复/SourceRef、canonical Record 保存协调、真实 DSH Chat/Trajectory 与单项目运行时、目录读取边界，全部复用。
- 缺口：目录尚未纳入 File 身份、单一 File 预览请求、两条 Record 缓存仅单可见、DSH 当前 Session 可变、没有 Project 内容布局。

## 本轮包范围

| 包 / Issue | 依赖 | 交付 / 文件范围 | 非目标 | 验收与验证 |
| --- | --- | --- | --- | --- |
| WP1 / #124，复用 #114 | File/Version 原生能力 | 目录纳管、身份核对、版本读取；原生 File/目录服务和对应 DTO/API | 不新增通用数据库、自动清理 | A10–A19、A29–A30；原生身份/版本/路径针对性测试 |
| WP2 / #124 | 稳定对象身份 | 新布局 store/model；统一打开、唯一性、分栏/移栏/合并/恢复；主应用内容外壳 | 不复用 Session 布局为权威 | A01–A09、A31–A32；布局和真实页面接入测试 |
| WP3 / #124 | WP2 | ProjectNoteFocusPage 的 visible/focused 与保存协调；Record 内容接入 | 不重写编辑器或改变 AI 预览规则 | A04–A05、A08、A24、A28；双 Record 和保存失败测试 |
| WP4 / #124，协作 #115/#118 | WP1/WP2 | DSH 固定预览来源、File/Version 输入、必要资源与生命周期 | Office 编辑与回存仍归 #118 | A17–A23、A28；格式样例、版本和资源测试 |
| WP5 / #124 | WP1/WP2、真实 runtime | DSH adapter 每页 Session 绑定、内容会话入口、明确引用目标 | 不扩展跨工作区并行，跨项目并行已确认 | A18–A20、A25–A28；双 Session/引用/延迟回调测试 |
| WP6 / #124 | WP1–WP5 | 目录/Record/会话/搜索/最近访问/引用迁入统一入口，完整验收台账 | 不关闭未完成 #118 | A01–A32；集中受影响完整验证、主 agent 双轴检查 |

## 采用规则

- 采用 §1.2 常规布局默认值：聚焦栏打开；双栏会话文件引用优先另一栏；分栏移动当前 Tab；50% 初始比例；合并保留聚焦选中项；关闭空栏合并；窄窗临时只显示聚焦栏。
- Office 首版只读预览可另包；本轮基本格式清单遵循 P02，不宣称 Office 编辑。
- 不新增自动历史清理；引用版本保留。快照预算、目录排除、身份歧义核对及跨项目运行以工作包实际决策补充。
- Standards / Spec 由主 agent 自行执行；未授权启动 review 子 agent。
- 用户在实施会话明确确认首版跨 Project 后台并行。WP5 扩展 Project 独立运行时/连接；A27 改为运行中切项目不中止原任务，返回后历史和停止目标正确。原 §1.2 阻止跨项目切换建议不再采用。

## 验证与验收

### 2026-10-13 Record／AI 对话图标全局接入包（#124）

- 依赖：用户选定普通 Record 绿色书脊与记录线（`#1ED760`）、语音 Record 红色书脊与三条弧线（`#F05252`）、共同深灰封面（`#3A3A3A`）以及紫色 AI 对话 SVG；现有 Record、Session 与文件图标调用路径。
- 交付：共享彩色图标组件，全局替换已有记录／AI 对话身份图标，覆盖侧栏、引用候选、助手入口、设置分类、会话列表和内容标签。语音记录以红色弧线笔记本表示，不使用独立麦克风或记录线。
- 非目标：改动文件／其他应用图标策略、记录或会话数据、交互逻辑、用户自选项目封面图标和 DSH 上游图标库。
- 验收：Record 与 Session 使用用户选定 SVG，保留布局，内容 Tab 统一 16px 图标；装饰性图标不重复朗读，语音标记仍可识别，原有打开／切换／引用流程通过受影响测试。语音 Tab 的身份标记从原生 Record 读取，并在重开和布局持久化后保留。
- 验证范围：侧栏、引用候选、会话面板和内容标签的现有针对性用例；TypeScript 与前端构建／UI 标准／包边界检查；主 agent 完成 Standards／Spec 自查。无 Tauri dev 监听进程，保留并行 Agent／Overview／Voice 改动，本包不关闭父 Issue。
- 实现：`ContentTypeIcon` 共用三份 SVG，所有已有 Record／Session 身份图标统一接入；语音记录使用红色三条声音弧线，不再使用独立 Mic／Volume2。新开 Tab 从原生 Record 获取 `isVoice`，布局存储和去重保留标记；旧保存 Tab 通过已加载的 Project Record 身份补充呈现，不额外请求原生接口。AI 对话入口、会话列表、设置分类与 Tab 使用紫色气泡。
- 验证：元数据与原生来源三个测试文件 50 项；侧栏／引用／会话／记录／布局九文件 90 项；设置两项；恢复工作区 11 项，均通过。恢复补丁后的布局 41 项再次通过，包含在上述九文件计数中，未累加。新恢复用例修正了 Vite 内联 SVG 的 URL 断言；TypeScript 修复可空布局引用后，最终 `npm run build`、UI standards 和 bundle boundaries 通过，主脚本 235 KiB／250 KiB。普通 Record 改回绿色只更新 SVG 与预览，复用逻辑测试；28px XML／16px 配色与透明背景、静态 PNG 目视确认完成。
- 主 agent Standards／Spec 自查无剩余发现，未调用 review 子 agent；原有打开、保存、拖拽和文件系统图标策略保持。`check:portable-paths` 被仓库既有研究／验证文档的绝对路径阻挡；本包未新增此类路径（执行文档当前与 HEAD 均三项）。本包提交阶段成果，不发布或关闭父 Issue。
- AI 对话配色微调：按用户反馈改为更深、更饱和的紫色 `#7C5CFA`，形状与普通／语音记录配色不变；同步主 SVG 和当前预览，仅静态配色改动，复用已通过的接入测试。
- 预览：`docs/design/record-voice-chat-icons-20261013.html`／`.png` 为最终绿色普通记录、红色语音记录与紫色 AI 对话；早期麦克风及两条／三条弧线预览保留为设计过程。

### 2026-10-13 Record／AI 对话彩色图标设计包（#124）

- 依赖：上一包 DSH 彩色 FileTypeIcon 的图形和静态配色；用户要求新增 Record 与 AI 对话设计。交付：Record 两种配色与 AI 对话的可缩放 SVG、放大及 16／20／28／32px 预览；应用内接入另包。本包不涉及运行时、文件映射、版本、数据或 Tab 排版。
- 设计：用户反馈初版 Record 折角纸页与文件相似，并要求简化装订细节。Record 改为原创圆角笔记本、连续书脊和两条白色记录线，交付绿色 `#1ED760`、粉色 `#FB7299` 两个配色方案；AI 对话沿用 DSH 图片／视频紫色 `#8B76F6`、原创圆角气泡和白色星芒。相同 28px 网格，透明背景；Record 通过颜色与笔记本轮廓和原文件图标区分。
- 验收与验证：两份 SVG XML／viewBox 和无脚本／外部图片检查通过；通过 bundled Sharp 从 SVG 渲染 PNG，确认 16px 非空且透明背景保留；主 agent 检查预览中线条、星芒及轮廓，小尺寸清晰，Standards／Spec 自查通过。纯静态设计资产未运行应用构建或单元全量，未启动窗口。
- 文件：`src/assets/icons/record-color.svg`（绿色）、`record-color-pink.svg`、`ai-chat-color.svg`；`docs/design/record-ai-chat-icons-20261013.html` 和 `.png`，以及两种 Record 配色对比 `record-file-comparison-20261013.png`。当前临时选择页置顶 Record 两种配色和 AI 对话，保留 59 个 DSH 彩色参考项，用户可刷新查看。两种简化 Record 的最终 16px 渲染和透明背景已验证；主 agent 检查配色与装订点移除，纯资产变更复用原验证范围。
- 绿黑试版：按用户要求新增独立 `record-color-spotify.svg`，绿色书脊 `#1ED760`、近黑封面 `#191414`、纯黑记录线 `#000`；保留原绿色和粉色方案。新增 `record-spotify-trial-20261013.png`，HTML 和临时选择页置顶试版。XML 与 16px 渲染中绿色／深色／透明像素检查通过，主 agent 目视确认形状和配色；黑色记录线在小尺寸下较隐约。仅修改静态设计资产，未接入应用，未运行应用构建或启动窗口。

- 绿黑试版调整：按用户最新反馈将内部两条记录线改为与书脊相同的 `#1ED760`，同步 SVG、HTML、临时选择页和 PNG。复查 XML 与 16px 渲染，主 agent 目视确认绿色线条在黑色封面上的辨识度；仅静态资产变更。

- 深灰封面调整：按用户最新反馈将试版封面改为中性深灰 `#3A3A3A`，书脊和记录线保留 `#1ED760`；同步 SVG、HTML、临时选择页与 PNG。XML 和 16px 渲染检查通过，主 agent 目视复查；纯静态资产未启动应用或运行全量构建。

### 2026-10-13 文件与应用图标工作包（#124）

- 依赖：现有 DSH `FileTypeIcon`／分类器、File 当前原件身份核验、Workspace generation、紧凑工具栏。接收时无 `tauri dev` 监听进程；保留 Agent／Overview／Voice 等并行未提交改动。
- 交付：文件侧栏、项目目录与内容 Tab 使用 DSH 映射，未映射类型读取系统类型图标；新增其他应用打开菜单，应用图标只用系统图标，选择后打开当前原件。默认应用入口保留。
- 非目标：修改文件身份、版本或引用语义，新增格式预览／编辑，读取历史快照作为当前原件，改变 Record／Session 图标。
- 验收：已映射文件不请求系统图标；未映射类型按类型缓存，异步响应不串入其他类型；应用菜单图标来自系统，查询与打开失败明确，关闭／隐藏丢弃过期响应；应用选择核验系统关联及当前文件，历史查看仍打开当前原件；有界列表使用既有连续边缘遮罩。
- 验证范围：共享图标、应用菜单与 API 边界测试；侧栏／目录／Tab／File 预览受影响回归；原生图标、处理应用及绑定边界测试；集中 TypeScript／构建、UI 和 bundle 检查；macOS 图标与真实菜单验收。Windows 无运行环境时保留明确待验收项。Standards／Spec 由主 agent 自查，不启动 review 子 agent。
- 实现：直接复用 vendored DSH 分类器与 SVG，不改上游字节；Host 和 DSH 附件共用类型图标，未映射类型由原生系统查询，按扩展名共享缓存。系统图标加载中／失败／缺失使用有明确状态的中性占位；应用图标缺失保留空图标位，不替换为 DSH 文件图标。应用菜单复用 `PopoverPanel` 和 `HomeSidebarList`。
- 原生边界：四个并发许可在 blocking 任务入队前获取；应用枚举在 DB 锁外，查询后及打开前重新核验 Workspace generation、File 实际归属、当前路径和物理身份。只接受系统注册应用 ID，不接受客户端执行命令或原始路径。macOS 使用 NSWorkspace，Windows 使用 Shell association handler／GDI；历史视图打开当前原件。
- 前端验证：`npx vitest run` 的共享图标／native API 两文件最终 18 项、File 预览／API 两文件 47 项、侧栏／目录／Tab 三文件 37 项、DSH 附件／引用／集成三文件 22 项通过；真实 bootstrap／附件／图标／菜单四文件 27 项通过，其中较早的图标 9 项已由最终 15 项覆盖。结果有重叠，未相加为全量计数；未变化的通过结果复用。日志为 `$VALIDATION_TMP_ROOT/project-mind-file-icon*-tests.log`，仅供本地诊断。
- 构建与检查：`npm run build`（含 TypeScript）、`check:ui-standards`、`check:bundle-boundaries`、DSH `test:integrity` 3 项及 `check:adapters` 通过，主包 229/250 KiB，39 source entries／1043 modules；静态图标独立复用 chunk。macOS `cargo test --manifest-path src-tauri/Cargo.toml --lib native_file_icons --quiet -- --show-output` 7 项和 `cargo check --lib --quiet` 通过，含真实系统 PNG 解码、应用枚举、并发及 generation／归属／替换／缺失边界。Windows 适配模块通过隔离支架 MSVC 交叉 `cargo check`，未验证完整 Windows 构建或运行。macOS debug `.app` 静默包装通过，最终前端入口资源已嵌入 binary。
- macOS 实机：重用隔离验收应用、App data 和 Workspace；PPT Tab 显示橙色 DSH 图标，未映射 TXT Tab 显示系统文本文件图标。实际菜单列出 TextEdit、Word、Pages 等系统应用图标，默认标记正确、溢出下缘遮罩可见；选择 TextEdit 后打开测试 Workspace 中的 `import-first-open.txt` 原件，合成文本与文件 URL 正确，没有改写文件或发送模型请求。
- 主 agent Standards／Spec 自查通过：确认图标来源、异步缓存与取消、当前原件语义、原生身份和注册应用边界、GDI／COM 释放、上游完整性及滚动规范。本包提交仅含图标和应用选择改动；同期 Tab 排版等并行改动保留。#124 继续作为阶段交付，Windows 实际图标／打开和父 Issue 剩余验收仍待完成。
- 收尾补正：原生扩展名规则与 DSH 分类／缓存一致，含前导点文件名，避免 `.txt` 与 `note.txt` 共用缓存却查询不同类型；最终原生组仍 7/7 通过。补包装首次因磁盘不足失败，仅清理可重建 incremental 缓存和本包生成的静态 archive 后重试，最终 `.app` 包装通过。此前 macOS GUI 覆盖的菜单／打开实现未变，复用实机结果。

### 2026-10-13 DSH 调研后的界面优化包（#124）

- 基线：`4b6a5aa`；依赖已实现的 File 身份／版本读取／外部打开、统一内容打开、DSH Session 绑定和布局存储。源码编辑前确认没有 `tauri dev` 文件监听进程。
- 交付行为：File 单行工具栏、异常时位置恢复、外部打开当前原件、一键新建同 Project 会话引用；Project Tab 风格、类型及真实运行标记、拖动排序／跨栏、溢出滚动与连续遮罩、临时放大恢复；会话实际模型展示和统一设置入口。
- 非目标：Markdown 编辑及 `.md` 保存已由用户暂停，后续单独设计；不新增格式渲染器、第三栏、业务身份或版本模型，不把阶段优化视为 #124 全部完成。
- 验收：版本刷新与固定引用不漂移；外部打开失败明确；引用只入新会话草稿且防重复、取消和跨项目串入；Tab 拖动保留页面状态，滚动可发现，运行状态按实际 Session；放大不改持久布局，模型不以共享默认设置冒充实际运行。
- 验证范围：受影响 File／引用／Workspace、布局／Store／事件、DSH adapter／模型观察和 Session 页面测试；集中前端构建及 UI／bundle 检查；macOS 集中 GUI 验收。复用仍有效的原生身份、版本、跨项目运行证据；Windows 条件与 #124 未完验收继续保留。主 agent 完成 Standards / Spec 自查，不启动 review 子 agent。
- 已实施：引用在权威归属与工作区代次核验之后、布局变化之前入队，避免文件页隐藏取消投递。Tab 使用 pointer 拖动及 body portal，支持空栏落点、边缘滚动、Escape 取消及键盘移栏；阅读位置更新只测量溢出，不把手动滚动拉回选中项。放大与排序使用 220ms FLIP，支持 reduced-motion；按钮沿用共享动效 token 和 loading spinner。
- 模型及运行状态来自真实 Session projection / catalog。宿主按客户端 entry 丢弃过期事件，工作区或客户端关闭清理 Session map；卸载展示停止模型回调，运行 catalog 继续订阅。第二栏恢复时自动聚焦遵循宿主 focused 状态；WebKit root reconciliation 暂时关闭非聚焦编辑器的 editability，随后由已有 layout effect 恢复，保留草稿、选择和历史。两处 vendored 修改均登记在 `packages/dsh-ui/provenance.json`。
- 自动验证与复用：File worker 的 4 文件 93 项、布局／Store／事件／真实 Host 的 4 文件 45 项通过；整合后的受影响引用／Session／Workspace／统一打开 4 文件 47 项通过（`$VALIDATION_TMP_ROOT/project-mind-dsh-reference-handoff-green.log`），含初次投递、布局同步隐藏与归属拒绝；布局 22 项通过（`$VALIDATION_TMP_ROOT/project-mind-dsh-layout-final.log`）；模型观察器 2 项通过。最终真实双 Host/bootstrap 9 项通过（`$VALIDATION_TMP_ROOT/project-mind-dsh-focus-green.log`），验证实际模型回调身份、独立 running、卸载订阅及恢复焦点。93/45 与后续用例存在重叠，未相加为全量计数；源码未变的相关结果复用。
- 新问题按证据补测：引用同步隐藏用例先失败后修复；双 Host 恢复焦点用例先失败后修复，macOS 复验又确认 WebKit DOM selection 会聚焦，补 root reconciliation 的宿主约束后再包装。每次新源码只重跑受影响测试与失效构建，未重跑前端或原生全量。
- 最终 `npm run build`、`check:ui-standards`、`check:bundle-boundaries`、DSH `check:adapters` 和 vendor integrity 3 项通过；主包 230/250 KiB，39 source entries / 991 modules 无浏览器缺失导入。本地 debug `.app` 静默包装通过，使用原已验证的 runtime staging；本包没有修改 native command / DTO / 原生业务服务。日志在 `$VALIDATION_TMP_ROOT/project-mind-dsh-*.log`，不将可清理的临时日志当作永久附件。
- macOS 实机：保留隔离 App identity / App data / Workspace 及用户现场新增测试文件。单行工具栏在 26% 窄栏可用，正常阅读不显示位置；文本原件在 TextEdit 打开且未改写。实际 pointer 排序、跨栏、键盘移栏、窄栏滚轮横向滚动及两侧遮罩分别确认。小引用按钮新建同 Project 会话，草稿含正确文件；发送前无消息，使用数值 loopback 合成 Provider 显示固定 v1 消息、该 Session 的运行标记和 `main-ui-model`，结束后标记清除。未调用外部模型或读取用户业务 Workspace。
- 最后实机复验通过：左右会话同时可见，聚焦右栏后放大／恢复，再次放大仍显示右栏会话；左栏 DOM selection 不抢焦点，两边选中项与 26% 比例保持。复验后恢复 50% 分栏并展示文件／会话并排。隔离应用可执行文件 SHA 与最终包装产物一致，未将中间失败的投递或焦点操作记成通过。
- 主 agent Standards / Spec 自查：核查真实归属／generation、版本 hash、异步取消和 UI 切换交接、原件与历史语义、Session 与模型身份、布局状态及拖动清理、滚动／动画 token 与来源许可。相关发现均在本包修复；完整 #124 的 Windows 等待办继续开放，本包为阶段交付，不自动关闭 Issue 或发布未验收的整个分支。


实施中逐包补充命令、覆盖范围、结果和真实平台证据，阶段状态见下文。Windows 平台未提供，不能标记通过。完整确认范围交付前 #124 保持开放。

### WP2 状态与打开边界阶段

- 文件：`project-content-layout.ts`、`project-content-store.ts`、`projectContentApi.ts` 及对应测试。
- 状态验证：布局与 Store 25/25 通过；独立严格 TypeScript 检查通过。统一打开边界 7/7 通过；覆盖异步并发唯一性、权威 Record/File 归属、数字 ID 规范化、未知 Session、旧 Workspace 代次与取消。
- 主 agent Standards：布局只保存身份和视图元数据；入口调用现有原生业务服务核验，异步后核对 binding/generation；同步状态更新保证两栏去重；无新业务数据库。
- 主 agent Spec：默认单栏、显式分栏、项目独立布局、跨栏唯一、普通重复打开保留视图、明确版本更新同 Tab、移动/排序/合并和项目局部恢复已具模型证据。真实页面、关闭与 GUI 仍依赖 WP3–WP6，未将本阶段写为 A01–A09 整体通过。
- 本阶段可提交；#124 继续开放。

### WP1–WP6 集成实现与采用决策

- WP1：目录纳管复用 `documents` / `document_versions` / File hash、原生归属和 CAS；用户文件保留实际位置。扫描逐页可取消和继续，排除、失败和超限可见。应用改名/移动保持 ID，外部替换或移动证据不足要求核对。原位置恢复使用持久化 intent，提交版本与回执后清理；真实进程中断测试覆盖四个持久边界、事务内中断、幂等及外来同 hash 文件。
- WP2：主 App 接入项目独立内容壳、两个独立 Tab 栏、唯一打开、排序/移栏/合并、守卫关闭、窄窗和比例恢复。业务正文不进入布局存储。损坏身份、重复成员及坏视图仅使对应 Project 布局失效。宽窗比例在缩小时暂受阅读宽度约束，放宽窗口恢复原值。
- WP3：Record 显式身份、双可见/单聚焦，复用 canonical 保存、锁与 CAS。隐藏暂停展示保留 editor state 和撤销栈；保存失败/冲突/待审阅修改阻止关闭。GUI 发现标题异步保存后误抢焦点，已改为仅在原输入仍聚焦且页面可见时转移焦点，增加延迟保存回归。
- WP4：正式纳入固定 DSH 预览来源、MIT/第三方许可、PDF Worker/字体等构建资源；六格式与 File/Version 原生读取结合。静态 HTML 空 sandbox、禁止脚本；隐藏时保留同一静态 frame 的阅读位置，再显示核验版本及最终资源字节；内容变化、失败、切版本或关闭淘汰旧 frame。其他后台预览释放重型资源。
- WP5：Project 独立真实运行时，每页固定 Session；隐藏/关闭展示不停止后台任务。File 引用明确选择实际 Session，先固定已验证版本再插入草稿，失败保留引用并显式重试。原始路径读取、固定草稿及 PTC 内嵌 read 均走原生 File service；从政策处理后的实际模型输入登记已有 `agent_evidence` 和固定引用边。Provider 失败不写成功证据，政策替换/删除不补回旧正文。
- WP6：目录、侧边栏、Record、会话列表、搜索、最近路由、内部固定引用与旧预览请求接入统一打开。真实深链接核验归属与 Workspace generation；旧路径只解析当前身份，不伪造历史版本。

决策：沿用 100 MiB 单文件快照预算；超限仍纳管身份，不登记假版本。预览沿用原生文本/图像等 10 MiB、PDF 50 MiB 预算，超限明确提示并可本地打开。不自动清理历史；当前引用边、不可变 Record 历史和已有 Agent 证据均阻止删除固定来源，Project 级删除也在同一写事务中检查。Office 预览/编辑继续归 #118；静态 HTML 不宣称 #115 交互脚本支持。

定位：行范围是固定版本的 1-based 行；PDF 页号与 0-based 页内字符范围单独保留。提取段落序号不伪装成源码行号。不能精确高亮的段落/页内范围明确说明，仍打开固定版本或对应 PDF 页。

限制：历史 Markdown/HTML 关联资源没有版本绑定快照时不混入当前依赖。静态 iframe 因 opaque origin 无法持久读取内部滚动，关闭/重开或重启不能恢复其内部位置；普通隐藏与移栏通过同一 browsing context 保留。源码视图、其他格式的滚动/缩放按实际版本保存。

### 集中验证与复用依据

代码范围：布局与打开边界阶段提交 `2c36ea4`、集成源码提交 `9de227e`、固定 File 自动会话标题修复 `837b2ba`；接收基线已有 AI 设置、Overview、Voice 等 29 个未提交路径均未纳入上述提交，不作为本包交付或验证结论。集成提交前最后改动仅去除一个测试行的尾随空格，测试行为及构建输入未变。

| 验证范围 / 命令 | 结果与有效范围 |
| --- | --- |
| 布局 model/store 定向 Vitest | 28/28；新增损坏身份局部恢复，`$TMPDIR/project-content-layout-final.log` |
| LayoutView 定向 Vitest | 9/9，双页、移栏不重挂、草稿、关闭失败、遮罩与窗口宽度；`$TMPDIR/project-content-layout-resize-final.log` |
| 统一打开 service | 7/7；未变实现复用阶段结果 |
| 主 App/Workspace/Record 接入 | 原 90 项中 88 项通过；仅两个失败超时项诊断并保留断言后 2/2 通过，`$TMPDIR/wp2-app-resident-final.log`；后续 visited File 壳与定位变动针对受影响 21/21、41/41 通过 |
| Record 规范正文完整链 | 前端 193 项中 192 项通过；唯一失败是旧 File picker fixture 未提供新权威服务，补齐后原用例和固定 File 组通过，未放宽断言。worker 构建、host Record 6/6、原生 Record 195/195（含 ignored）通过 |
| Record 页面后续 | 隐藏入站同步、标题延迟焦点与原 Tab 焦点针对性通过；`$TMPDIR/project-content-title-focus.log` 2/2，其余未受影响页面用例复用 |
| File/版本工具条与引用目标 | 26/26；固定引用入口、身份核对、版本历史、取消与明确 Session 目标分别通过 |
| 六格式预览与资源 | 原 45 项有效、完整源码/资源 integrity 4/4；后续 HTML 受影响 10/10 与新增 9/9、源码模式跨格式回归 3/3。实际 PDF canvas/Worker 与 PNG decoder 验证，构建 closure 通过。详见 `packages/dsh-ui/preview/HANDOVER.md` |
| 目录身份及原生边界 | 原目录 20 项、路径/归属边界 6 项、旧 undo fixture 1 项、Project 删除保护 2 项通过；后续真实进程恢复 3/3（8 次 SIGKILL）通过，`$TMPDIR/wp1-restore-process-green.log`、`$TMPDIR/wp1-restore-sql-crash-green.log` |
| 固定引用与证据 | Record canonical/HTML/原生 CAS、保留历史、定位和跳转针对性通过；DSH evidence 10/10、真实 Node→Provider→原生证据及 read→edit 集成通过 |
| Session / PTC / 并行 | 前端 Session/store/adapter 针对性通过；真实 Node runtime 3/3 包含双 Project 并行与 PTC/7 种政策路径，`$TMPDIR/wp5-ptc-final-node.log`；真实原生完整证据链 1/1，`$TMPDIR/wp5-ptc-native-green.log` |
| `npm run build` / runtime staging | 最终 TypeScript/Vite 通过；`prepare:desktop-runtime -- aarch64-apple-darwin` 包含最新 DSH source bridge 和正式预览资源，通过；`$TMPDIR/project-content-final-build.log`、`$TMPDIR/project-content-runtime-final-stage.log` |
| macOS 本地包装 | `CARGO_INCREMENTAL=0 npm exec tauri -- build --debug --bundles app --config '{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'` 通过；`$TMPDIR/project-content-final-package.log`。核对当前 `dist/index.html` 引用的 24 个 JS/CSS 文件名均已嵌入产出的原生二进制 |
| 构建与规范 | desktop runtime 14/14、`npm run check:portable-paths`、`npm run check:ui-standards`、`npm run check:bundle-boundaries -- --diff` 均通过；主包 223/250 KiB。本任务源码 `git diff --cached --check -- . ':!packages/dsh-ui/preview/licenses/**'` 通过；第三方许可按原包字节保留，原有尾随空白不作改写，资源 integrity 验证其 SHA 一致 |

原生 File 扩大回归第一次为 175 passed、13 ignored、58 failed、1 未完成：macOS 临时目录别名根与 `SQLITE_OPEN_NOFOLLOW` 触发 SQLite 1550；并发 fixture 在 barrier 前同时初始化 DB 迁移触发 SQLite 5。使用 canonical `TMPDIR`，只将两个并发用例的连接初始化提前，业务操作仍并发、断言不变。失败/未完成去重 59 项最终组合 59/59 通过，`$TMPDIR/wp1-file-native-canonical-diagnostic-fullscope.log`；175 项未变范围复用，13 项是由父测试显式调用的 ignored 子进程 fixture。未将原 247 项写为一次完整绿跑。中间三项子进程强杀出现波动，增加退出诊断后单项、9 项并行及最终 59 项均通过；未放宽 SIGKILL 断言。

macOS WebView 另发现代码预览 MutationObserver 对未变化的遮罩数值持续更新 state，造成实际 renderer 循环。遮罩测量现在相同值返回原 state；真实 CodeBody、异步滚动恢复、无变化 DOM mutation 不重绘三个用例通过，`$TMPDIR/project-content-preview-observer-final.log`。此变动仅失效该预览测量范围及最终前端/包装，其他已通过检查继续复用。


### macOS 集中产品验收

使用自行构建的 debug `.app`、独立 App data / Workspace 和数值 loopback 合成 Provider；未访问用户业务 Workspace，也未调用外部模型。包装采用现有 runtime staging，关闭 updater artifacts 仅用于本地无签名验收。Windows 未提供可执行环境。

- A 项目首次扫描纳管 7 个 File，无失败/排除；无 Session 时六格式均真实显示。文本 120 行、Shiki 代码、Markdown 标题/列表/项目内图片、PNG 解码与缩放、PDF 两页 canvas/文本层/缩放、静态 HTML 均有实际 WebView 证据。不支持的 `.bin` 仍有 v1 和明确限制。
- HTML 含试图改写标题的 script；预览仍显示原始标题且没有执行标记。内部滚动条置于 0.5，切到 PDF 再返回仍为 0.5。
- 文本外部追加新内容后刷新登记 v2；同一 Tab 切 v1，新内容不出现；改名为 `renamed.txt` 后同一 Tab 与 v1 保留。历史版本未跳到当前字节。
- 双 Record 的实际编辑、移动和撤销已验收；标题延迟保存修复后再次在正文输入，内容进入正文且焦点不转入标签。File + 会话、Record + 会话、两个会话均实际并排显示。
- A / B 项目同时发送 20 秒延迟的合成任务；返回停止 A 后 A 显示 Stopped，B 仍在执行。关闭 B 的内容 Tab，列表继续显示“运行中”，重开后同一 Session 的历史与停止按钮连续。不同项目输入和历史没有串入。
- 同项目第二 Session 实际发送；强制本地 Provider HTTP 400 仅在对应 Session 显示 Failed，原 Session 历史保留。恢复 Provider 后续发成功，原失败历史保留。
- 文件引用选择器只列所属 Project 的实际 Session；选中后插入 `sample.txt` v1 chip，真实发送完成。发现发送消息显示整个固定来源投影，已在 adapter 展示副本折叠为文件名/版本并复用上游点击导航；不修改存储与模型投影。真实 user/steering renderer、同名不同 File、普通路径、非法字面量输入边界针对性通过（8 项注册/展示、16 项完整 File adapter；`$TMPDIR/wp5-file-display-final.log`、`$TMPDIR/wp5-file-display-input-green.log`）。10 月 13 日实际包装中消息仅显示文件名/v1 与用户提示，固定点击复验通过，见下文。
- 双栏布局在同一隔离 bundle 重启后恢复。代码预览测量循环、标题抢焦点以及全局标题栏覆盖内容操作条均在本轮定位并修复；操作条沿用现有标题栏高度。

主检查还发现：原生 Record 的 PDF 页内范围允许零长度，与前端及 DSH 的非空范围不一致；统一为 `end > start`，真实 canonical/边校验原用例新增两个零长度拒绝场景，1/1 通过（`$TMPDIR/project-content-page-range-final.log`）。目录失败保留相同扫描 cursor 时，前端原循环会无限请求；现在停止重复失败页、保留已登记 File 和失败项，显示“纳管未完成”并由用户修复后重试，完整受影响目录组 8/8 通过（`$TMPDIR/project-content-directory-retry-final.log`）。

### 2026-10-13 隔离环境重建与 macOS 复验

用户已处理上轮 Keychain 提示，并明确 Windows 暂无环境、保留待办。恢复执行时上轮临时目录及日志已被清理，保留其已记录结果；未把不存在的日志写成可用附件，也未重跑未受影响全量。新环境位于忽略的 `src-tauri/target/content-acceptance-20261013/`，使用同一已构建原生包、独立 App data、新建加密测试 Workspace、两个 Project、七格式样例及数值 loopback 合成 Provider。通过现有 ignored `dsh_assistant::tests::seed_embedded_ui_workspace --ignored --exact --nocapture` 创建真实业务 DB，1/1 通过。没有读取用户业务 Workspace 或调用外部模型。

- 最终工具条布局复验：内层项目操作条位于外层项目 Tab 下方，文件位置、引用、版本操作可见且可点击；没有临时 CSS 注入。
- 实际目录失败：仅在测试 Project 新建权限为 `000` 的空目录，纳管结束为“0 File、1 失败”，展开显示权限失败及修复后重新纳管说明，没有持续请求或重复失败项。修复为 `700` 后纳管完成 7 File/0 失败；再次扫描仍为 7 File，7 个内部版本目录明确列为排除项，没有重复身份。
- 实际固定版本：从文件页指定 Session 插入 v1 并发送成功，消息展示 `sample.txt · v1`，没有整段来源投影。文件外部追加唯一 v2 标记、刷新显示 v2/新字节；点击会话 v1 标签后同一 File Tab 显示固定 v1，v2 标记不存在。再经真实 UI 改名及同项目移动，历史引用仍导航同一 Tab/v1。
- 原生窗口已从宽窗缩至 1180 点宽；再调整项目侧栏使实际内容区缩至约 700 点，临时只显示聚焦栏，“切换另一栏”可切换到另一原有页。恢复内容宽度后双栏恢复，File v1 与会话历史保留。真实拖动分隔线到 61%，再次缩窄/放宽后恢复 61%，未改写保存比例。
- 会话自动标题仍显示内部来源 token 的问题已定位到 DSH `sessionTitle` 的 fallback 截断及标题 Provider 输入边界。仅生成标题时将来源投影映射为文件名/版本；原消息、主模型投影、固定来源交付 hash 保持原值。单测 2/2、真实 Node 运行时集成 2/2 通过，覆盖标题 Provider 输入、列表/header 共用持久投影、重启与普通手动标题。正式资源更新后创建新 Session，第一条消息从已改名/移动的 File 插入固定 v1，再真实发送；header 显示 `sample.txt · v1 final title`，消息仅展示 `sample.txt · v1` 与合成提示，没有内部来源 token。列表和重启后的持久标题由真实运行时集成验证；已存的测试旧截断标题不自动改写。

本轮日志保留于上述隔离环境：`seed.log`、`wp5-source-title-final.log`、`dsh-stage-final.log`、`package-final.log`。标题修复只有运行时标题生成代码变化；前端构建、Record/File 原生测试及未改动预览/布局测试继续复用。正式 DSH 生产树由现有 `prepareDshProduction` / `stageDshRuntime` 重建并校验分发清单；随后静默 macOS 包装通过，原生二进制与此前验收包 SHA 相同。停掉验收进程后更新其正式资源，核对 runtime、source bridge 与分发清单 SHA 一致，再执行上述新 Session GUI 复验。

### DSH Desktop 设计观察与后续优化

以下保留本轮观察摘要。后续确认的阅读工具栏、Tab 辨识与模型入口以[内容栏优化规格](tab-strip-refinement-20261013.md)和后续执行记录为准；被实施结果替代的独立调研交接已移除，临时放大阅读栏与平台限制汇总在[未完成事项](../remaining-work.md)。

用户要求查看已打开的 DSH Desktop。通过 Computer Use 观察真实窗口和无障碍树，与本包实际双栏页比较；未编辑用户文件、发送模型请求或记录其文档内容。实际展开“打开方式”，确认 Markdown、代码、纯文本三种选项；同一 Markdown File 切到代码显示，再恢复原 Markdown 阅读模式。外部编辑器、分栏和快捷键的完整操作尚未确认，不据此评价其功能正确性。

最有价值的复用方向是减少文件阅读页的常驻工具条高度，同时保持固定版本语义可见。DSH 的文件 Tab 带类型图标；路径、查看方式、刷新和外部打开集中在一条工具栏，提供分栏、全屏和收起右栏入口。会话输入区域可见当前模型、访问模式及命令/文件提示。我们当前文件位置、引用到会话、版本操作占三行；混合 File/Record/Session Tab 的类型和后台状态辨识较弱。

| 优先级 | 本产品优化候选 | 复用范围与验收条件 |
| --- | --- | --- |
| P1 | 压缩 File 工具栏 | 常驻文件名、版本/历史警告及主要查看操作；位置改名/移动和目标 Session 选择进入现有弹出层。复用 File 工具和来源能力。双栏及窄窗阅读空间增加，固定版本提示仍可见，键盘可访问所有操作 |
| P1 | Tab 类型与运行状态 | File 格式、Record、Session 图标；长标题截断并可查看全名，后台运行状态可发现。复用内容身份和 Session 订阅；不更改唯一性及布局权威，停止只作用于目标 Session |
| P2 | 会话内模型入口 | 复用统一 AI 配置，输入区展示当前模型并提供设置入口；运行中展示任务实际绑定模型。配置缺失时提供明确操作，避免用户离开会话寻找配置 |
| P2 | 单栏阅读专注 | 提供临时放大当前栏及恢复入口，保留双栏成员、比例和草稿；复用现有聚焦栏和可见性模型，连续过渡并遵循 reduced-motion |

局部启发式严重度（0 无问题，4 无法完成任务）：阅读工具密度 2、Tab 类型/运行状态辨识 2、模型入口发现 1。新用户主要受入口辨识影响，熟练用户主要受双栏有效阅读高度影响；键盘用户的新增入口需在后续包验收。未进行完整可访问性、性能或用户研究，不提供全产品评分。这些候选尚未实施，不扩展本轮 #124 收口范围。

### 实际导入失败排查

10 月 13 日用户在隔离验收应用操作后出现“导入文件失败 / File changed while preparing its version”。按用户要求委派实现子 agent，定位到版本复制前后 stamp/路径身份不一致的拒绝边界；已有导入失败回滚测试 1/1 通过，普通文件和 APFS 压缩文件的独立 metadata 探针未复现。随后用户补充源文件应该是 iCloud 尚未下载到本地的文件，并明确不优先处理。本项降为后续排查，未确认具体源文件和云占位状态，不认定已解决或已证实根因。继续保留 stamp/hash/CAS 校验；解锁条件为提供可重复的未下载云文件样例，比较下载前后状态，设计可操作的等待下载提示。

### 2026-10-13 助手标题下方白屏修复包（#124）

- 依赖：WP5 的统一内容会话入口、现有 `DshAssistantPanel` 和 `AgentWorkspacePanel`。交付：打开助手后展示可操作的项目会话入口或明确空态，创建/打开会话进入原有内容 Tab；关闭及项目切换可正常返回。非目标：模型/运行时协议、iCloud 导入及新布局能力。
- 验收：有会话及无会话项目均有正文；异步启动失败显式显示错误；关闭/重开、A/B 切换及打开会话不会串入另一项目。验证限定真实 callback 模式组件及 launcher/退出接入；最终前端构建、macOS 包装与真实 GUI 集中复验。
- 现场：用户报告两个项目显示“DSH 助手”标题、下方全白，随后恢复。主 agent 在项目 A 概览点击助手准确复现，标题和顶部会话/新建按钮可用、正文为空；点击关闭助手可回到主页。本次确认了白屏，尚未复现原生进程冻结，不把两者混为同一结论。
- 修复：真实 `AgentWorkspacePanel` 使用 `onOpenSession` 目录模式时，启动完成后原代码既不挂载 Host，也不显示目录。复用原会话列表、删除确认和 `HomeSidebarList`，补上常驻目录/空态与刷新；创建或打开会话仍走原内容 Tab，未增加第二个运行时。
- 红绿：真实 workspace launcher 的已有/空会话、项目切换和错误重试 4/4 基线失败，修复后 4/4 通过；受影响组件四文件 37/37 通过。主 App 关闭/重开及跨项目 `inert` 恢复用例通过。集中五文件去重共 71 项：其中四文件 59 项先通过、3 项超时；只重跑失败范围诊断，再保留原 15 秒上限后 3/3 通过；另内容 Workspace 9/9 通过。
- 测试清理：连续 App 用例出现超时、单项可通过，补齐 fixture 的延迟保存释放/flush、unmount、Router dispose、QueryClient 取消/清理。最终三项 3/3，共享 fixture 其余受影响三项 3/3；未放宽断言和原超时上限。证据不足以把资源竞争或 cleanup 缺口认定为唯一原因。日志为 `assistant-app-resident-final.log` 和 `assistant-app-resident-cleanup-affected.log`；未变化的已通过用例复用。

### 2026-10-13 导入后位置未核验修复包（#124）

- 依赖：既有文件导入事务、不可变版本与项目目录文件身份核验。交付：新导入事务保存已核验的物理身份，首次打开冻结既有 head；已导入且缺少核验记录的文件，显示明确待核对原因，并通过现有“文件位置”确认入口恢复。非目标：PPT 预览能力、云占位下载及移动/替换规则调整。
- 验收：完整“导入 → resolve”链路、历史导入首次打开、内容变化及物理替换拒绝边界；针对性 Rust 回归后集中构建 macOS 包，并打开现场文件核验。不以直接标记 ready、吞错或放松身份检查消除错误。
- 现场：项目 B 的 `Presentation12.pptx` 显示 `File location has not been checked`。该文案由缺少目录身份记录的投影返回，预览在格式判断前被位置核验拦住。导入服务未写入新服务需要的身份记录。
- 修复：导入时建立目录 schema，将放置时核验的物理身份与 File/head 同事务写入；首次 resolve 复用原快照发布服务。旧导入无身份或首次快照前内容变化保持 `ambiguous`，显示明确核对原因；register 同样经过核验，避免绕过 resolve 信任任意替换。
- 验证：完整导入/打开路径基线 3/3 失败；目录组 27/27、导入组 11/11 通过，各有一个供父测试调用的子进程 fixture 按约忽略。新增/扩展测试覆盖复制和就地导入、重开数据库、首次快照保留 v1、同字节物理替换、首次打开前内容变化、旧版提交 journal 缺少身份表的恢复。日志为隔离验收目录下 `file-location-*.log`。

### 两项修复的构建、检查与现场复验状态

- 源码提交：助手目录及退出测试 `21faeb5`；导入身份核验 `fe7f5f2`。上述测试和构建针对这两包的最终源码；提交后未修改业务实现。
- `npm run build`、`npm run check:ui-standards`、`npm run check:bundle-boundaries` 通过；主包 223/250 KiB。使用上表同一 debug/app/updater 配置重新包装成功，128 个 JS/CSS asset 名称均在原生二进制中，隔离应用与构建产物的可执行文件 SHA 一致；日志为 `bugfix-frontend-build.log`、`bugfix-native-package.log`、`bugfix-*.log`。
- 主 agent 自行完成本次 Standards / Spec 源码检查：复用原目录、唯一内容 Tab 与运行时；目录有显式空态、错误与原滚动遮罩；File 导入身份与 head 原子写入，首次快照及 register 不绕过物理身份和版本 hash，旧导入按原确认协议处理。未启动 review 子 agent；本包 diff 检查通过，接收时已有 29 个未提交路径未修改或纳入提交。
- 退出旧隔离应用后更新其 binary/resources，保留 App identity、App data、两个项目及现场用户新增记录/文件。新二进制曾触发 macOS Keychain 的 `SecurityAgent`；用户随后明确开发测试不要密码，按下一包移除开发模式钥匙串读写后完成现场复验。未操作系统 SecurityAgent，未把构建或自动测试记成现场验收；Windows 待办不变。

### 2026-10-13 开发验收免密码及免钥匙串修复包（#124）

- 用户要求开发测试不要密码。依赖：现有 debug 自动解锁、自动生成工作区密钥、隔离 App data 和验收环境变量。交付：验证测试配置后直接解锁；新建 debug 工作区自动密钥持久化到仅开发模式使用的本地缓存，重开无需密码输入或钥匙串交互。非目标：release 工作区认证及业务数据迁移。
- 验收：有效测试配置不读取/写入缓存；错误配置不能解锁其他工作区；新建工作区本地密钥跨重开可读，缓存持久化失败仍回滚创建；缓存按工作区身份隔离并阻止路径越界。针对性 Rust 测试后重新包装；现场启动无钥匙串，再继续上述两包真实 GUI 复验。
- 实现：`debug_workspace_password` 优先验证显式测试配置，成功后直接返回；自动生成的 debug 工作区密钥按工作区 ID 写入 App data 的 `debug-workspace-keys`，采用私有临时文件和原子替换（macOS 0600）。仅自动创建的开发密钥进入该缓存，手动解锁现有工作区不持久化输入密码。helpers 与创建接入均限定 `debug_assertions`，release 认证路径未改动；旧钥匙串缓存不迁移，当前测试工作区由已知环境配置解锁。
- 自动验证：`CARGO_INCREMENTAL=0`、canonical `TMPDIR` 下 `cargo test --manifest-path src-tauri/Cargo.toml --lib debug_workspace_auto_unlock_tests --quiet`，5/5 通过，覆盖真实本地持久化重开、权限、隔离、越界、配置核验和创建失败回滚。随后仅删除手动解锁的缓存写入，helpers 未变化，复用上述验证；最终原生包构建成功覆盖接入编译。前端与 File/目录实现未变化，复用上述已通过验证，未重复全量测试。日志 `debug-no-keychain-tests.log`、`debug-no-keychain-package.log`。
- 主 agent Standards / Spec 自查通过：生成密钥缓存只在 debug 编译、按实际工作区隔离、原子保存；显式配置仍须验证现有 verifier，没有重置业务密码或修改旧工作区元数据。本次源码与文档 scoped diff 检查通过，未启动 review 子 agent。
- 源码提交 `ee5d17e`；本轮此前助手与文件核验提交为 `21faeb5`、`fe7f5f2`。保护接收时 29 个未提交路径及随后出现的并行 `docs/README.md` 改动，均未纳入上述提交。

### 三项修复的最终 macOS 现场复验

- 更新后启动与退出再启动均直接加载测试工作区，没有密码输入或钥匙串提示；原项目、记录、布局与用户新增文件仍在。被阻塞的旧验收进程已停止，未操作 SecurityAgent。
- 助手：项目 A 显示两个已有会话，刷新可用；打开已有会话进入唯一的原内容 Tab 并关闭目录。关闭/重开可回到项目概览；助手打开时经 Workspace 切换到 B，B 展示“暂无会话，点击新建会话开始”，没有串入 A 的目录。B 创建会话进入新会话 Tab，真实 Host 可连接。观察到目录正文取代原白屏；未复现用户最初报告的原生进程冻结。
- 旧导入：`Presentation12.pptx` 先显示明确身份待确认，通过原“文件位置”入口选择同一相对路径并执行内容/版本核验后为“位置已核对”，版本仍 v1，引用入口启用；预览显示 PPT 格式暂不支持的明确说明。退出重开后核验与 v1 保留，原 `File location has not been checked` 消失。未确认内容替换、未查看其正文。
- 新导入：用 GUI 导入独立的合成 `import-first-open.txt`，首次打开直接显示预设文本、v1 最新已登记版本和可用引用入口，无位置未核验错误。重开后文件和 Tab 保留。
- Windows 平台和此前未完成的扩展产品验收仍按台账待办，#124 保持开放；本轮源码和文档阶段提交不等同完整 Issue 交付。

### 主 agent 双轴检查与发布状态

- Standards 源码检查完成：核查布局元数据与业务权威分离、异步归属/generation、File 身份与 CAS、恢复 intent/原子回执、历史引用保留、Record canonical 保存、每 Session/Project 运行归属、预览资源/许可和实际生命周期。上述代码发现均已修复并验证；未启动 review 子 agent。
- Spec 源码检查完成：逐项对照完整需求、接入入口及下表，确认跨项目后台并行按用户新指令交付。自动验证与已观察 macOS 行为分别记录；剩余产品及平台验收未冒充通过。Spec 最终交付门禁尚未满足。
- 上轮 Keychain 阻塞已由用户手动处理，本轮新隔离包已成功加载；未绕过系统 `SecurityAgent` 或修改原凭据。新版引用标签/固定 v1 点击、操作条布局与失败目录修复重试已完成，后续扩展 GUI 范围仍以下表为准。
- 用户明确 Windows 暂无执行环境、保留验收待办；解锁条件为可运行该应用的 Windows 环境，用于实际路径/身份识别、预览及快捷键验收。
- 源码阶段提交已完成，#124 保持开放，未推送、建立发布 PR 或自动合并。按仓库发布流程，在完整验收及双轴门禁满足后发布；本轮不关闭 #118。

### A01–A32 台账

以下“自动”指上表的实际代码/服务验证；“GUI”只计已观察的 macOS 行为。未把自动用例写为全部平台产品验收。所有 Windows 界面、路径/身份识别及快捷键均待实际环境验收。

| 编号 | 自动验证 | macOS 产品证据 / 待补范围 |
| --- | --- | --- |
| A01 | model/store、App 项目隔离/恢复通过 | A 默认布局、显式双栏、B 单栏、切换、重启恢复已观察；完整排序/选中恢复组合待补 |
| A02 | 多 Tab 成员与选中通过 | 同栏超过两个 File/Session Tab 已观察 |
| A03 | 双栏独立选择与最多两页通过 | 左栏文本保持、右栏六格式切换已观察 |
| A04 | Record/File/Session 真实组件接入通过 | File + Record、Record + 会话、双 Record、双会话已观察 |
| A05 | stable keys、移动/排序/合并通过 | Record 移栏、草稿与撤销保持已观察；原生拖排序完整手势待补 |
| A06 | 空栏合并、最后 Tab 回概览、不删除对象通过 | B 关闭唯一 Session 页回概览，列表能重开同一 Session 已观察 |
| A07 | ResizeObserver、窄窗临时聚焦栏、比例缩窄/恢复通过 | macOS 原生窗口缩小、约 700 点内容区切栏、真实比例拖动及 61% 比例恢复已观察 |
| A08 | 页面焦点、关闭/键盘/弹窗守卫、延迟标题焦点通过 | 双 Record 正文焦点与延迟保存已观察；全部原生快捷键组合待补 |
| A09 | 统一入口并发去重、跨栏/固定版本导航通过 | Record 重复入口定位原 Tab；File v1/v2 同 Tab 已观察 |
| A10 | 实际目录幂等、并发登记、分页/取消、排除失败与重试通过 | 首次扫描、无权限失败停止、修复后纳管、重复扫描不重复及内部目录排除已观察；GUI 扫描中取消待补 |
| A11 | 二进制快照、超限只保留身份通过 | `.bin` 身份/v1/限制与文件位置操作可用已观察 |
| A12 | 实际应用改名/移动保持 ID 与不可变历史通过 | 已开历史 File 改名及同项目移动保持 Tab/v1、会话历史引用导航已观察 |
| A13 | 实际外部移动、原子替换、旧路径占用与歧义核对通过 | macOS 文件系统测试通过；Windows 识别与 GUI 核对待验收 |
| A14 | 同 hash、同名不同路径及跨项目物理归属通过 | 由真实 macOS 原生文件 fixture 验证；GUI 待补 |
| A15 | 真实外部更新、相同字节登记、恢复新版本/回执与崩溃恢复通过 | 外部更新 v2、原 Tab 切回 v1 已观察；恢复操作 GUI 待补 |
| A16 | 快照复制前后 stamp/hash、固定版本读取及重开通过 | macOS 原生测试通过；离线修改重开 GUI 待补 |
| A17 | 缺失快照拒绝、保留原固定引用与历史读取通过 | 不代替同名文件；缺失文件 GUI 待补 |
| A18 | Record / 会话固定 ID/hash/version 与定位/跳转通过 | 展示适配后的 v1 标签、真实发送、v2 更新后点击恢复原 v1 字节、改名/移动后同 Tab 导航已观察 |
| A19 | 真 Node→Provider→原生证据、draft/read/PTC、政策替换/删除与失败原子性通过 | 固定 chip 真实发送已完成；模型依据一致性由实际链路验证 |
| A20 | 明确 Session 目标、失败保留和显式重试通过 | File 选择实际 Session 并插入对应草稿已观察 |
| A21 | File 服务与预览不启动会话、模型缺失通过 | 未启动任何 Session 时六格式预览已观察 |
| A22 | 六格式真实 renderer、资源/许可闭包与 HTML 沙箱通过 | TXT/TS/MD/PNG/两页 PDF/静态 HTML 均已观察 |
| A23 | 全源码分页、Line/Page 定位、版本依赖警告及资源边界通过 | v1 固定旧字节、Markdown 当前项目图片、PDF 两页已观察；完整定位 GUI 待补 |
| A24 | 双 Record 保存协调、CAS/锁、冲突/失败及未接受 AI 预览通过 | 双 Record 编辑/移动/撤销已观察；冲突与 AI 待接受 GUI 待补 |
| A25 | Session store/adapter、真实运行时及 HTTP 失败通过 | 双 Session 并排、指定 Session HTTP 400、恢复续发已观察 |
| A26 | 关闭展示保留 Session store/任务、重新订阅通过 | B 运行中关页、列表仍运行、重开历史连续已观察 |
| A27 | 真实双 Project Node 并行与停止隔离通过 | A/B 同时运行，停止 A、B 继续及独立历史已观察 |
| A28 | 延迟请求、订阅、Worker/Blob 释放、固定版本切换通过 | 六格式来回切换、HTML 保持、应用重启恢复已观察；资源释放由真实组件用例验证 |
| A29 | 既有 File 完整原生回归、旧引用与路径桥接通过 | 已管理列表/项目目录/最近 Record /会话入口均真实接入；旧数据迁移 GUI 待补 |
| A30 | 原生越界、symlink、跨 Project/Workspace、过期 generation 拒绝通过 | 真实 macOS 边界测试；Windows 路径边界待验收 |
| A31 | 真实溢出测量、滚动/ResizeObserver、遮罩不拦截输入通过 | 多 Tab 横向溢出与六格式滚动可操作已观察；所有反向/边缘 GUI 组合待补 |
| A32 | 损坏身份类型/重复/坏视图局部恢复、缺失对象可关闭/固定历史不回退通过 | 实际重启恢复有效布局；损坏/缺失对象 GUI 待补 |

## 2026-10-15：首页进入分栏与导航精简

### 工作包

- 关联 #124，基线 `c8d25a6`；依赖现有内容布局、居民页缓存与 QuickNote/Record 保存机制。
- 交付：删除项目概览操作行和放大模式；左栏固定唯一 Home，首页成为左栏内容页；侧栏项目名称打开首页；单栏末端提供分栏图标，右栏末端提供合并图标；外层项目标签的移动选中底面与内容 Tab 栏统一为白色，两侧弧形保持原样。
- 首页不复制业务对象或编辑器，切换时保留打开 Tab、草稿和右栏选中页；左栏空选择表示首页，右栏空选择仍为空栏。首页半屏宽度下复用待办侧栏的窄屏浮层方式。
- 非目标：文件格式、会话运行时、Record 保存协议、业务数据和 Workspace 首页改版。
- 验收范围：A01–A09、A31–A32 中的布局、状态恢复、导航、键盘与关闭行为。#124 其余格式／平台验收保持开放，本包不视为父 Issue 完成交付。
- 编辑前确认现有原生进程使用 `tauri dev --no-watch`，来自主工作副本；本工作树修改不会自动重启原生窗口。

### 验证与检查

- model/store 两文件 51 项；sidebar 三文件 17 项；LayoutView 原范围 41 项及新增 Home 键盘用例 1 项；Workspace 原范围 11 项及新增首页／历史导航用例 1 项；App 原范围 36 项及新增侧栏首页用例 1 项，共 159 项通过证据。
- 命令：`npx vitest run` 加对应 model/store、HomeProjectSidebar/HomeSidebarFooter/HomeNoteSidebar、ProjectContentLayoutView、ProjectContentWorkspace、App 测试路径，`--maxWorkers=1`。完整 App 首跑 35 项通过、六项目切换用例超时；单独复跑该失败项 6.32 秒通过，未调整超时阈值；新增侧栏与历史用例分别针对性通过。未重复运行仍有效的无关测试。
- `npx tsc --noEmit`、最终 `npx vite build`、`node scripts/check-ui-standards.mjs`、`git diff --check` 通过。构建保留既有 chunk／动态静态导入警告，无本包编译错误。
- 使用真实 React 页面和模拟业务 API 的浏览器预览检查单栏／双栏、首页与记录并排及图标位置；读取实际 computed style 确认顶部移动选中底面与内容 Tab 栏均为 `rgb(255, 255, 255)`，弧形沿用原侧栏底色。这些属于浏览器布局证据，不计原生数据保存或新增平台验收。
- 主 agent 完成 Standards／Spec 自查：布局只保存展示状态、首页保持唯一、业务对象去重与关闭守卫沿用原机制、窄窗口保留布局、滚动遮罩仍绑定滚动视口并响应尺寸变化；按用户最新纠正仅左栏有 Home。未启动 review 子 agent。

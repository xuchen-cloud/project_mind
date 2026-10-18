# 文件首开性能工作包（#191 / #118）

## 基线、范围与验收

- 基线：`origin/develop` 的 `b5dd7317f7d200a32537bba1ca996ea1e46af91f`（已合入 PR #194）。专用分支 `codex/office-first-open-performance`；主仓库及本 worktree 初始干净。
- 依赖：固定 GenOffice 完整 renderer、现有 Workspace / File / File Version 与 CAS、已验收的菜单/工具栏/状态栏及 Markdown Record 排版。
- 交付行为：测量四格式真实内容就绪的冷/热路径，依据测量优化关键路径，保留完整版式、计算、对象、交互和原生保存。
- 非目标：导出/打印功能扩张、静态截图预览、降低字体或媒体质量、将大型编辑器搬入应用启动。本包不关闭 #191 / #118。
- 目标：约定复杂常规样本在应用新进程中首次打开，实际首屏正确绘制、版式稳定且必要导航/滚动/缩放可响应，端到端 ≤1000ms。加载占位、可点击按钮、cache 命中和空工作表均不构成完成。
- 验证范围：所改格式资源构建/来源与许可、宿主生命周期/缓存/File/CAS、真实浏览器及 macOS Tauri、490/640/常规宽度、切换/历史/关闭/工作区失效、保存/自动保存/重开、主包边界、连续开关与进程/内存。Windows 代码检查、交叉编译、实机单独报告。

## 测量约定

机器 Apple M4 / 16GiB，macOS 26.5.2。使用项目固定 Node 24.21.0。原始证据目录由本机 `OFFICE_PERF_EVIDENCE` 指向（本次会话外部 artifact 的 `office-performance/` 子目录）；最终交付附可点击链接。仓库中保留脚本、原始数据摘录和证据来源。

不清理系统文件缓存；新进程、浏览器上下文缓存与模型缓存分别标注。生产资源浏览器测量、开发构建和原生测量不混算。多次串行采样，保留全部原始数据，中位数、最大值及样本量；5次样本的最近秩P95就是最大值，不能推断总体P95。

脚本拆分原生worker与renderer，避免将分段耗时冒充产品端到端结果。测量构建的 `office-performance` Cargo feature 与 `OFFICE_PERFORMANCE=1` Vite入口仅用于隔离测试工作区；普通构建无此入口。原生计时重新经过真实文件解析、版本、权限/hash读取、inspect及异步后核验。

每次 cold_open 都是新应用进程内第一次打开该格式，但时间起点为已打开隔离 Workspace、定位/登记测试 File 后的真实组件选中文件动作；终点包含首屏就绪、字体/图像、布局稳定与导航条件。不是从进程 spawn 到文件绘制的总时长，Workspace 解锁/列表/登记未计入文件打开；原始 shell/setup 命令均保留，Workspace open 在上一冻结复杂组约810ms。App 启动另测首页，**两者不能相加成实测完整 App 首文件总耗时**，本次缺少统一起点的完整 App 文件就绪计时。这个限制是验收缺口，不能用测试 shell 的秒开冒充进程启动至文件打开的秒开。

## 初始核验

没有发现 `tauri dev` 监听；已有主仓库Vite与此前Review应用保留。未修改用户业务文件。旧文档的3–5秒观察不是本轮基线。原始构建产物以APFS clone保存在 `baseline-artifacts/`，用于同条件前后对照。

## 已定位成本与修复

1. Word 原宿主入口内嵌完整 renderer、屏幕字体和打印字体，宿主解析后再生成 iframe 内容。现在产品使用约 13.5KB 的 `full-editor.mjs`，完整 renderer、CSS、原字体作为独立资源；打印派生字体仅在实际输出时请求。legacy 公开接口保留。
2. PPT 原宿主引入内嵌 HTML 的大入口。现在 iframe 直接加载完整脚本和独立 CSS/原字体，脚本与旧产物逐字节一致，CSS 只改变字体 URL；新增资源失败可见回执。
3. Excel 原内嵌资源改为同源完整 ESM 资源树。固定 Univer 的 300ms mount、3000ms Steady 等待改为可取消的两帧加任务调度，保留 mount/activate、全部 Rendered/Steady hooks 和顺序；完整初始数据到齐后的既有计算请求不再额外等待 1000+20ms 安静期。ready 必须观察该次真实计算的新 session 完成且 resultApplied，不能用先前部分计算放行。字体 guard、手动计算及未完成流式批次原规则保留。
4. 加速初始化暴露了 Excel 滚动时重装图片/图表的竞态。完整预载后由原 float DOM manager 更新位置，不再在每次滚动销毁重装；未完成流式安装、工作表切换及视觉编辑仍执行原安装路径。
5. 原生计时发现宿主两层 React lazy/Suspense 引入额外提交等待，Office 静态依赖还会递归带入 Record/Tiptap 图。改为选中格式的显式 import Promise、加载状态与生命周期取消；代码加载和真实 binding/resolve/inspect 并行。只挂载已解析的同一组件，仍保留原菜单、加载错误、File 会话与全部回调。打包规则先隔离 React 和共享宿主模块，普通生产静态图检查确认 Office 不执行 Record/Tiptap，主入口仍在预算内。
6. Excel bridge 的静态依赖提前执行保存、输出和全部 21 种语言字典。保存序列化和输出改在既有操作 Promise 内按需 import，权限、取消与错误路径保留；zh/en 完整字典随首屏，其余语言首次选择时加载完整字典后才发布，快速切换/取消不会应用旧结果。完整语言集合和字典值逐项比对。entry 静态闭包由 11,106,594B 降至 3,817,616B，entry+main 由 13,488,084B 降至 9,638,031B；不是按这两个数字相加推断网络流量。
7. 进一步拆分 Rendered 后的真实同步 hooks 与任务排队，只将完整初始 batch 的零延迟 task 改为可取消、合并的 microtask；保留部分流、滚动的合并等待以及真实计算/resultApplied 门槛。新增 marks 用于核验收益，不把原 74/78ms 全部声称为固定延迟。

资源 staging 以完整 manifest 的路径和内容 hash 命名目录，逐字节复制相对资源树。只在选中格式后并行 fetch/compile 它的脚本、CSS，退出即移除 hint；已开始的浏览器请求无法由移除 hint 保证取消。不会同时初始化四个编辑器，也不在应用启动时预初始化。资源 hints 不持有模型或保存能力。

## 缓存定义

本包未增加 File 模型缓存、worker 常驻池或活 renderer 缓存。既有预览缓存最多 4 项、16MiB UTF-16 JSON，Workspace ID/generation 改变即清空，键包含 File 对象、版本和 expectedContentHash；读取前仍由真实 File 链路核验归属及内容。缓存不包含权限和保存能力。独立资源 URL 绑定构建内容 hash；每次测试为新原生进程和 incognito WebView，系统磁盘/字体缓存保留。

新增代码 Promise 缓存仅包含宿主及三个格式组件模块，不保存 File/版本/权限/保存回调；语言缓存限单 iframe 的 21 种固定语言，关闭 iframe 后随该 realm 回收。资源预取在可见 File 明确选中格式后触发，取回/编译脚本和 CSS，不在父窗口执行 renderer；取消会移除 hints，已经开始的浏览器请求不保证中止。所选格式的 CPU/资源成本属于该次打开，未搬到应用启动阶段。

## 生产原生对照

生产原生、复杂样本首次打开，单位 ms，原始目录 `baseline-native-release-formal/`：

| 格式 | 全部原始值 | 中位数 | 最大值 |
| --- | --- | --- | --- |
| Word | 1864,1975,1880,1885,1953 | 1885 | 1975 |
| PPT | 1294,1254,1279,1251,1262 | 1262 | 1294 |
| Markdown | 792,808,803,792,794 | 794 | 808 |

Excel 基线使用后补的完整首屏图表/图片绘制门槛，目录 `baseline-native-release-xlsx-visual/`，复杂样本为 5497,5501,5464,5522,5477ms，中位数 5497ms，最大 5522ms。

最终冻结生产包 `Native Verified.app`，目录 `after-native-release-verified-formal/`，四格式各 11 个新原生进程，共 44 次。复杂常规样本：

| 格式 | 全部优化后原始 ms | 中位数 | 最大值 | ≤1000ms 次数 |
| --- | --- | ---: | ---: | ---: |
| Word | 844,859,803.0000000000002,860,862 | 859 | 862 | 5/5 |
| PPT | 644,596,538,589,565.0000000000002 | 589 | 644 | 5/5 |
| Excel | 1006,1051,1014,995,1039 | 1014 | 1051 | 1/5 |
| Markdown | 808,808,814,785,800 | 808 | 814 | 5/5 |

**四格式首开秒开目标未达成。** Excel 中位数已从 5497ms 降至 1014ms，但 4/5 次仍超预算。Markdown 没有获得显著提升，不能把原本达标描述为优化收益。以上统计不去掉超标项，不把 995ms 单次当成 Excel 完成。

同一最终矩阵的小型/较大样本：

| 格式 | 小型全部原始 ms | 较大全部原始 ms |
| --- | --- | --- |
| Word | 1440,811,836 | 1028,1022,1025 |
| PPT | 593,514,486 | 1141,1180,1136 |
| Excel | 1658,961,930.0000000000002 | 3306,2179,2190 |
| Markdown | 813.0000000000002,792,781 | 1174.9999999999998,1181,1167 |

所有超标和尾部均保留。较大 Excel 文件切换另出现 1694,4801,4799ms，不能用复杂常规样本的快速切换代替大文件体验。

先前生产阶段的 33 次 Word/PPT/MD 对照和非 formal 探索也保留为独立批次，不与最终矩阵合并；其中 Word 首轮 1499ms、后续功能验收冷开 1182ms、Excel 前一轮 1767/1046/1030ms，均不能被最终常规样本较快的重复试验掩盖。最终矩阵自身 Word/Excel 小样本首轮 1440/1658ms 也说明进程冷开仍有明显尾部。

可提交原始摘录、每次原文件与日志 SHA-256、统计公式、请求和两套独立 worker 时钟见 `scripts/office-performance/evidence/native-release-20261019.json`；生成器只读取明确 allowlist，不扫描挑选最快目录。完整原始 JSON、日志、RSS 轨迹与截图保留在外部 evidence 根目录。5 次的最近秩 P95 即本组最大值，不代表总体 P95。

较大 Word 原 fixture 插在段落内部 section 属性处，解析未包含 500 段，三次旧结果已排除并保留原因。修复为 body 末尾插入，真实引擎断言 500 段均存在；同条件替代三次为 2132,2034,2046ms。大样本属于确定性扩展压力文件；用户确认没有额外业务文件，不将其描述为客户真实大型文件。

独立 Chromium 生产 Office 资源测量（每格五次；包含服务器 inspect，**不包含 Tauri/File/native**）：

| 格式 | 优化前原始 ms | 优化后原始 ms |
| --- | --- | --- |
| Word | 2274.239,1840.197,1814.844,1744.472,1789.563 | 865.967,496.008,496.717,479.534,499.047 |
| PPT | 715.608,602.842,569.015,602.619,606.609 | 521.723,428.612,436.894,425.250,457.840 |
| Excel | 4973.285,4884.131,4733.616,4748.501,4834.033 | 855.860,703.915,737.022,715.877,725.686 |

原始目录分别为 `baseline-browser/`、`after-browser-formal/`。同一服务器 Node 引擎首次 import 只发生在第一轮，后续命中模块缓存，原始数据保留此差别；不能将这组数值代替新原生进程的验收。

### 热路径与应用启动

最终生产复杂 cohort 的热路径，中位数/最大值，单位 ms，每项 n=5；“另一文件”和“关闭重开”实际打开同格式 simple 文件，不能当作复杂文件的热开数据：

| 格式 | 首次另一文件（前→后） | 关闭重开 | 文件切换 | 预览进入编辑 |
| --- | --- | --- | --- | --- |
| Word | 938/971→585/587 | 660/675→294/325 | 679/696→328/331 | 146/159→120/126 |
| PPT | 390/405→354/357 | 277/292→246/255 | 290/294→247/267 | 127/129→125/130 |
| Excel | 4034/4271→586/608 | 3868/3890→433/503 | 3991/4043→438/462 | 202/260→107/110 |
| Markdown | 120/130→121/130 | 123/125→122/126 | 126/128→112/113 | 无预览模式 |

Markdown 块→源码为 427/442→427/429ms，源码→块为 93/95→96/98ms。完整逐次热路径见提交的 evidence JSON。

实际 App 首页生产三次，单独进程和隔离 app-data，目录 `baseline-startup-release/` 与 `after-startup-release/`：

| 指标 | 基线全部原始 ms | 最终全部原始 ms | 中位数前→后 |
| --- | --- | --- | --- |
| navigation→可见首页、字体和稳定绘制 | 298,306,300 | 344,311,310 | 300→311 |
| runner spawn→收到结果 | 614.078958,594.467292,566.314458 | 700.242916,578.301084,587.73275 | 594.467292→587.73275 |

前者不含 navigation 之前的原生创建；后者包含进程启动及本地报告 POST 开销。三次不足以证明启动没有回退，首轮 700ms 保留。文件测试 shell_ready 不是 App 启动。本包没有把三个 Office renderer 初始化移至启动，但基线 App 的静态图已有共享 Markdown/Tiptap，不能声称四格式启动 CPU 为零。

### 资源与代价

以下为最终保留版本的未压缩字节，不是网络传输量。完整 manifest 共 343 文件、65,917,870B；资源按所选格式请求。

| 格式 | 原内嵌 renderer HTML | 新 HTML/JS/preload/CSS 闭包 | 含静态字体/图片引用 | 完整 manifest |
| --- | ---: | ---: | ---: | ---: |
| Word | 36,061,732 | 8,295,383 | 23,046,887 | 29,117,852 |
| PPT | 12,822,864 | 5,491,797 | 8,241,145 | 8,241,145 |
| Excel | 38,445,404 | 9,854,030 | 12,622,007 | 28,558,873 |

Word 新宿主 13,508B；旧公开 editor API 的 40,785,428B 产物仍保留。PPT 旧 browser 13,338,164B 仍保留，产品不再导入它。Excel 宿主 39,437,518B→6,018B；entry 文件 59,671B 不能冒充其 3,817,616B 静态闭包。

包 dist 总量 Word 143,965,685→114,170,768B，PPT 23,351,630→31,702,946B，Excel 103,556,585→44,243,151B。PPT 因保留 legacy 并新增外部资源，磁盘占用增加。Word 36 个屏幕字体和 PPT 4 个字体逐字节保留；Word 五个打印字体 6,070,428B 仅输出时请求。没有降低图片或字体质量。

普通 App 初始静态 JS 闭包 10,745,454B，其中共享 rich-editor/editor 为 1,163,718B；三个 Office 宿主/runtime/renderer 不在启动闭包。构建输入 Word 692→692、PPT 721→721、Excel 4072→4086，未证明构建 CPU 减少。选中文件后的预取、模块编译和语言首次加载有 CPU/内存成本；关闭移除 hint，不能保证撤销已经开始的网络请求。

## 当前验证状态

- 普通生产 Vite 构建、根 TypeScript、UI Standards 通过；主入口 249KiB/250KiB，编辑器和大型对话框仍为懒加载。
- 普通 Rust（未启用测量 feature）`cargo check --lib --no-default-features` 通过，33.70s，37 项既有 warning；与已通过的测量 feature release / development 构建区分记录。
- 定向宿主功能 7 文件、120 项通过；复用此前有效的缓存/编辑会话/加载状态测试。jsdom 验证不等于真实原生竞态。
- Word 完整 renderer 外部资源、分页几何、生命周期、只读和回执等 headless 回归，Excel 最后调度/计算确定性 24 项及受影响浏览器功能 5 项、资源契约 1 项，PPT 原脚本/CSS/字体字节来源校验均已执行通过；具体命令及冻结范围见各格式包说明。
- 路径检查仍有基线历史文档违规；本次新增文档和改动新增项修正后单独核对。全仓库 rustfmt 检查存在大量基线格式差异，不以全仓格式化扩张本包。
- Windows 已检查同源资源、相对路径与现有 native worker/node.exe/进程树路径；交叉编译、Windows 实机未完成，不能标通过。
- Mac 锁屏期间的两次原生开发尝试作废；用户解锁后重测。Excel 的 Tauri canvas 像素读取存在 SecurityError，测量器保留真实计算/内容检查，并追踪实际 cache→主画布绘制及后续覆盖；绘制证明未通过的尝试全部保留为失败，不纳入有效耗时。

本文件随实际执行更新；尚未记录的验收均不视为通过，当前不宣称“原生首开秒开”完成。

## 开发环境对照（与生产分开）

### 未保留的 actions 拆分实验

静态图进一步找到插入图标专用 `react-dom/server` 和 CSV 生成 XLSX 专用 `jszip`，曾将两者移入原异步操作。固定 vendor、首屏 ready、计算和媒体门槛未改，entry+main 净减 289,839B 至 9,348,192B；九项 SVG/真实 XLSX ZIP/错误路径与产物边界测试、一个资源契约测试通过。但生产常规五次为 **1051,1200,1048,1050,1072ms**（中位数1051，最大1200，0/5≤1秒），小型 **1644,931,892ms**，较大 **2165,2153,3272ms**，较大切换 **6019,2723,2659ms**，均保留于 `after-native-release-xlsx-actions/`，不作为最终主比较。

为核对这项改动的实际价值，按 before/after 交替运行三组同一常规文件新进程：`native-actions-ab-before/` 为 **1028,999,1006ms**，`native-actions-ab-after/` 为 **1034,1066,1008ms**；配对差为 **+6,+67,+2ms**。没有观察到首开收益，不能将字节减少视为毫秒收益；样本量也不足以证明总体性能退化原因。最终撤销这两个额外拆分，恢复此前 renderer 字节与291项 Excel manifest，保留实验 patch、日志及原始数据。最终生产主表仍使用 `Native Verified` 的44次，开发主表仍使用原12次，不挑选新实验中较快的项混入。

原生 debug / Vite 1426、可见 incognito WebView，复杂样本各三次。基线 `baseline-native-development-unlocked/`（Excel 为 `baseline-native-development-xlsx/`），优化后 `after-native-development-final/`。原始完整热路径及哈希在 evidence 的独立 `development` 字段；没有合并进生产统计。后续 Excel 若再次改动，此组仅代表其记录的冻结版本。

| 格式 | 基线全部原始 ms | 优化后全部原始 ms | 中位数前→后 | 最大值前→后 |
| --- | --- | --- | --- | --- |
| Word | 3915,3611,3602 | 1306,940,919 | 3611→940 | 3915→1306 |
| PPT | 1727,1463,1481 | 679,637,649 | 1481→649 | 1727→679 |
| Excel | 6959,6564,7008 | 1509,1012,1075 | 6959→1075 | 7008→1509 |
| Markdown | 817,802,796 | 800,812,801 | 802→801 | 817→812 |

锁屏尝试不纳入有效数据。Excel 开发基线早于完整图表绘制门槛，保留当时公式与 canvas 证明；因此它的严格视觉条件不如生产对照一致，不能用该开发降幅补足生产验收。

## 实机行为、截图与内存证据

所有修改都只作用于复制到隔离 Workspace 的测试文件。原生自动化使用真实 ProjectFileContent、编辑器 API、版本菜单、自动保存和原生字节回读；没有替换 native 响应。Shell 宽度控制是精确 490/640/980 CSS px 的真实 File 组件，另有真实 App 双栏验收，二者不混称。

- Word：`native-acceptance-release-docx/` 七项功能验收通过、20 次交替开关通过。真实自动保存 v1→v2、原生读取编辑标记、关闭重开、历史 v1 只读、返回当前 v2、旧 CAS 恢复拒绝均通过。手动滚至第 3 页、74% 缩放后进入编辑，页码和缩放保留。截图 `preview-980.jpg`、`edit-490.jpg`、`menu-490.jpg`、`edit-640.jpg`、`preview-scrolled-640.jpg`、`edit-scrolled-stable-640.jpg`。
- Markdown：`native-acceptance-release-md/` 七项功能、20 次交替开关通过，真实 autosave→原生源码→重开→历史只读/CAS 通过。默认块编辑，只有块/源码切换，白色区域、Record 排版、紧凑表格和共享右键菜单经实机检查。截图该目录 `blocks-980.jpg`、`blocks-640.jpg`、`blocks-490.jpg`、`context-menu-490.jpg`、`source-490.jpg`（以实际目录清单为准）。
- PPT：`native-acceptance-dev-pptx-final/pptx-complex-1.json` 首次尝试七项功能、20 次开关通过；后续开发 HMR 触发重复验收，生成 v3，使固定 v1/v2 历史前提失败，另存 `attempt-2`，不能将重载后的截图当作 v2 证明。该问题影响测量会话，未触及业务文件。后续功能验收关闭测试 Vite 的 HMR/watch，保留所有失败，不覆盖首份报告。
- PPT 最终稳定生产功能验收：`native-acceptance-release-pptx-stable/` 八行通过（七项行为及独立 reset），20次开关通过，errors=[]，但本次非 formal 冷开超预算仍保留。真实 v1→v2 原生回读、重开、历史只读及旧 CAS 拒绝均成功。使用 `Native Actions` 发布二进制，其 PPT 代码/资源与最终保留版本相同，已撤销的 Excel 实验未执行；不能将此包当作最终 Excel。最终截图 `preview-980.jpg`、`preview-490.jpg`、`edit-490.jpg`、`edit-640.jpg`，确认 v2、完整幻灯片、原图片和备注。
- Excel 最终功能验收：`native-acceptance-dev-xlsx-final/` 为真实 Tauri debug + 无 HMR/watch 的 Vite 1426，使用逐字节恢复的最终 renderer。预览转编辑检查失败，五次观察中一次 `painted=false`，同一 iframe/surface 始终存在；画布尺寸重设清除绘制证明后下一次实际文本合成才恢复。不能据此证明合成画面一定闪白，也不能标记“无闪屏”通过，未放宽门槛。保留该错误后，七行独立 reset/真实修改自动保存/关闭原生回读/重开/历史只读与旧CAS/切文件/关闭均通过。20次开关内容就绪，19次在预算内、1次超标；不把功能成功当作耗时全部通过。截图 `preview-saved-980.jpg`、`preview-640.jpg`、`edit-640.jpg`、`edit-490.jpg`、`history-v1-490.jpg`，保留“验收失败”提示。开发功能证据不补充进生产统计。
- 三格式上述真实 pending inspect/source_read 的 File 切换及关闭均观察旧请求成功完成后的 DOM 与 source 所属，没有旧内容覆盖。历史在加载完成后选择；**打开中切换历史的原生竞态尚未验证**，不以顺序历史测试代替。
- 真实 App：`native-app-workspace-final/` 中 Markdown 左栏、Word 右栏同时展示，Word 进入编辑仍保留内容；50% 分栏约 640px，62% 分栏约 486px，精确 490px 由组件 shell 验证。截图 `dual-word-md-preview.jpg`、`dual-word-edit-md.jpg`、`dual-word-approx490-edit.jpg`。不能把第一次未成功拖动的 `dual-word-490-edit.jpg` 当作实际 490px。
- 同一真实 App，在未缓存 large Word 的 inspect 尚未完成时点击真实“切换 Workspace”。证据 `docx-complex-1.json`：inspect dispatch→close dispatch 时仍 pending，workspace_close 成功、旧 inspect 返回 WORKSPACE_NOT_OPEN、旧 root binding 再读失败、真实首页出现，观察到 0 次旧 File/iframe 回流及两次真实 RAF。截图 `workspace-closed-no-stale-file.jpg`。

### 内存：未取得无泄漏结论

RSS 每秒按 PID 记录，WebKit 候选进程归属不保证，RSS 不是 retained heap。没有强制 GC、清缓存或调整用户环境。原有用户进程保留；不是专用空载实验机。

Word 优化后早期 20 次开关中 WebContent 候选 715→1597.7MiB，19/19 步增长；相同旧 renderer 基线 20 次约 2119.5→2471.4MiB、峰值 3602.25MiB，开关总时间不同，不能直接比较净增长量并断言回归或无泄漏。

追加 `after-native-word-memory-80-opens/`，40 轮、80/80 次打开通过，最后一次保持当前文件后静置约 59.717s，无手动操作：

| 进程 | 全程初→末 MiB | 峰值 MiB | 最后五次打开检查点 MiB | 静置初→末 MiB |
| --- | --- | ---: | --- | --- |
| native host | 125.36→107.97 | 148.75 | 107.78,107.77,107.77,107.84,107.86 | 107.86→107.97 |
| WebContent 候选 | 238.66→1557.63 | 3515.53 | 3405.77,3352.86,3357.73,3333.64,3337.28 | 3301.98→1557.63 |

静置下降 1744.36MiB 说明有明显可回收/可释放部分，但不能据此声称 GC 原因或长期平台。Markdown 20 次开关 WebContent 约 311.80MiB（前）→425.58MiB（最后 target），最终报告 432.63MiB，host 约129MiB。连续打开期间内存预算/长期泄漏仍未验收通过。下一步需要独立 realm/对象存活证据和可重复长时轨迹，不能凭 RSS 对 renderer 添加猜测性清理逻辑。

### 首屏图像对照的边界

同一复杂样本、同一 Chromium 1280×900 首屏（第 2 次样本）的逐像素对照：Word 和 PPT 均为 0 像素差；Excel 仅右下角工作表概览按钮区域 153 像素不同（矩形 1233,847–1247,861），正文、网格、图表和图片目视一致。原始结果为 `browser-visual-comparison.json`。这只证明该视口的独立浏览器图像，不代替原生实机、编辑、窄宽度或屏外内容验收。

## 阶段拆解与剩余成本

`scripts/office-performance/evidence/native-phases-20261019.json` 固定最终复杂常规20次，保留命令、资源、marks 和两套独立 worker 时钟的原始值。下表中位数/最大值均为ms；并行阶段不可相加。空缺不是0。

| 阶段 | Word | PPT | Excel | Markdown |
| --- | --- | --- | --- | --- |
| File resolve | 7/8 | 7/8 | 8/9 | 6/7 |
| versions | 3/4 | 3/3 | 3/3 | 2/4 |
| inspect 命令往返 | 327/337 | 184/201 | 148/192 | 不适用；source_read 2/2 |
| 所选格式宿主模块请求至可用 | 13/17 | 14/15 | 14/15 | 不适用 |
| renderer wrapper 提交至首屏就绪 | 499/502 | 390/419 | 843/851 | 见独立块/源码数据 |

Word native 日志中原件读取中位数/最大值0.695/1.165ms，异步后归属/hash重读0.419/0.821ms，worker等待321.266/332.796ms。worker内部准备/排队0.061/0.129ms，临时文件与spawn1.004/1.568ms，Node收发/导入/inspect合段318.979/330.212ms，退出/解码0.3705/0.734ms。这些日志含cold与另一文件共10次；前端命令未携带可关联requestId，**不能伪装为逐次cold已对齐的链路**。

Excel iframe同一时钟的中位数/最大值：入口ready507/515ms，initialize1/2，完整main导入152/165，字体guard73/75（与main重叠48/49），首次React context→attach36/36，attach→初始内容118/124，Rendered同步hooks40/45，Rendered→Steady120/127，计算请求→start92/93，start→resultApplied127/134，applied→ready1/1。后两项不是可以直接删除的固定等待：真实计算start→end69/73ms，end→applied16/44ms；仍需定位任务/RAF、布局和计算回执成本。

Tauri自定义资源协议未提供可分离的有效ResourceTiming，现有记录不足以分别量化资源磁盘读取、模块解析/执行、字体解码、模型转换、全部分页布局与首屏绘制的CPU时间。保留组合阶段和缺失原因，不填0或由文件大小推算毫秒。独立worker60次诊断能分解引擎import、inspect和序列化，但不替代原生端到端。下一步条件是统一请求ID/时钟的native与WebView trace，结合真实paint/layout与realm对象存活证据；大文件切换及内存风险优先，不能只追剩余14ms均值。

## 验证复用与最终双轴审视

审视基点固定为 `b5dd7317f7d200a32537bba1ca996ea1e46af91f`。依据 AGENTS、CONTEXT、ADR-0003/0009、#191/#118、四格式功能矩阵、既有 GenOffice parity/review-fixes、资源 staging 与主包规范，由主 agent 自行进行 Standards/Spec 审视；未启动 review 子 agent。

### 有效验证范围

- 普通 shipping 构建：`node scripts/office-performance/build-host-graph.mjs`；最终恢复资源后执行，成功；其6项 `host-bundle-boundary.test.mjs` 全通过，`check-bundle-boundaries.mjs` 通过，249KiB/250KiB。原有Wavedrom eval、部分大懒加载chunk和既有重复静态/动态import warning保留。
- 根 TypeScript 与 UI Standards 已通过；产品TS在冻结后未再变化，复用对应结果。最后新增内容为证据生成与文档；最后一次UI Standards和diff检查再次通过。
- 宿主既有File/CAS/加载/Markdown及格式生命周期定向测试复用冻结范围；Word资源/分页/只读/回执，PPT脚本与字体来源，Excel 24项确定性、5项浏览器及1项资源契约、此前13+10项语言与异步操作定向验证均已通过。未反复执行无关全量测试。
- 原生测量器修复后执行当前canvas/visual、PPT真实编辑入口、history、pending读/Workspace、acceptance错误保留及共享attempt内存归属测试，共86项通过（其中证据汇总5项）。早期 source-extraction 测试失败及 HMR 重复尝试不被删去或当作最终通过。
- 普通无测量feature Rust check成功；带feature release及开发构建成功，37条既有warning。没有声称完整Rust测试或全仓rustfmt通过；后者有大量既有差异。
- 本次6份新增/改动Markdown的portable路径检查和diff检查通过；全仓历史文档违规不属于本次“全仓通过”。所有测试/原生失败与超标数据保留，不能凭摘要status隐藏。

### Standards

**本阶段代码结构审视通过，未发现尚需修改的确定性规范问题。** 核验了代码缓存不携带File权限、真实binding/version/hash/CAS和异步后重读保留、选中格式才取资源、完整清单与内容hash、固定源精确变换及失配失败、初始化/计算取消、同一编辑会话和保存串行化、错误可见、普通构建剥离测量入口。未修改业务样式、源vendor或固定依赖。没有为未证实内存问题增加猜测清理，也撤销了无实测收益的actions拆分。该结论不等于Spec通过或可发布。

### Spec

**未通过，不得自动合并或关闭 #191/#118。** 剩余发现：

1. **P1：1秒目标未达成。** Excel常规新进程4/5超标；小型首轮及大文件尾部也有明显成本。Word/PPT/Markdown仅在本次约定复杂矩阵5/5≤1秒，不能宣称所有文件冷开完成。
2. **P1：Excel预览转编辑无闪屏未验收。** 当前画布绘制证明中断尚需查明真实合成结果和同步绘制路径，不能通过延迟按钮或弱化ready掩盖。
3. **P1：连续打开的内存预算未验收。** 80次打开后的WebContent峰值约3.43GiB，静置下降但未证明长期平台或无泄漏。
4. **P2：测量完整性仍有缺口。** 计时从已打开Workspace中的真实File组件选中开始，未取得完整App统一起点首文件数据；资源读取、模块执行、字体、layout/paint仍有不可分离合段。
5. **P2：打开中切换历史的原生竞态尚未实测。** 已验证完成后选历史、pending File切换/关闭及真实Workspace关闭，不能代替该项。

Windows只有代码路径检查，未做交叉编译或Windows实机；启动仅n=3，CPU峰值及长期内存未量化。以上限制随本阶段远端提交保留。按publish-flow的“任一review轴未通过”例外，仅推送阶段代码和draft PR，不合并、不写Closes。

### 证据入口与复现

- 正式前后及实验：`scripts/office-performance/evidence/native-release-20261019.{mjs,json}`，正式生产44+44、开发12+12、启动3+3，实验11+6独立。
- 分段原始值：`scripts/office-performance/evidence/native-phases-20261019.{mjs,json}`。
- 功能/内存/失败attempt及39张截图SHA：`scripts/office-performance/evidence/native-acceptance-20261019.{mjs,json}`，由固定12目录读取13份报告；共享sidecar不归因单次。
- 本机原始文件、日志和图像统一在 `$OFFICE_PERF_EVIDENCE`，设定该目录后用相同Node运行对应生成器即可重算。构建/测量步骤见 `scripts/office-performance/README.md`。逐次耗时与失败摘录随代码提交，完整raw的SHA可核对本机原件。
- 可见验收步骤：复制simple/complex/large到隔离Workspace；串行运行native-run的acceptance/races/cycles；真实菜单切换v1/v2、预览/编辑与缩放；组件控制切490/640/980保存截图；真实App并排Markdown/Word，拖动分栏后关闭含pending读的Workspace。未修改用户业务文件，未启动Tauri文件监听。Excel保留失败提示，不以截图替代交互内容。

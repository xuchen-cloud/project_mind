# 原记录 AI 编辑、保存与块间距验收

日期：2026-11-11。关联 [Issue #302](https://github.com/xuchen-cloud/project_mind/issues/302)。用户特别要求验证已有记录经 AI 编辑后能正常保存，以及块之间的间距。

## 实际链路与判定

使用真实 macOS debug App、全新临时 Workspace/app data、真实 canonical worker 和 SQLite。先通过普通粘贴和 Cmd+S 建立原记录，再用实际 DOM 选区和上下文菜单触发 modify 技能，经原生任务、HTTP SSE 和任务事件进入预览；modify 点击实际“接受”，answer 点击实际“插入”，执行普通 Cmd+S，关闭标签后重开同一记录。普通编辑对照从同一原始 HTML 开始，保留用户空段和 hardbreak；不用 AI 结果直接初始化对照记录。

HTTP provider 是受控 localhost fixture，用于确定性输出并验证真实原生请求/流式解析/事件链，**不声称调用了远程模型**。没有 mock IPC、注入 job store 或以直接 editor/controller 调用替代接受及普通保存。测试输入使用浏览器 DOM 事件，不等同于物理鼠标键盘操作；最终 App 退出由 CUA 点击真实 OS 关闭按钮。

每次运行独立核对原生 API 与只读宿主 SQLite 的 document、HTML、Markdown、text、codeLanguage、bodyHash 和 headRevision，以及兼容 notes 投影。预览期间不得改变已保存正文。保存与重开严格比较完整投影；跨记录的普通编辑对照只忽略不透明 blockId，不忽略空段、hardbreak、节点或样式。

间距测量在实际 Record 页面等待字体及两个真实动画帧，失败或超时不判视觉通过。采集字号、行高、margin/padding、相邻块间距、相对矩形、Range 行框、嵌套列表/引用/表格和语义节点数量。纯文字修改要求周围块完全不变；多块插入与等内容的普通编辑对照比较，允许新增内容本身增加高度。

## 场景矩阵

| 场景 | 目标 | 当前状态 |
| --- | --- | --- |
| text-default | 默认排版，原有段落 old→new | 通过 `wuqv94nz`；保存/重开/普通对照/间距/设置/OS自然退出。 |
| text-custom | 自定义字号、行高、段前/后距，原有段落修改 | 通过 `p_t81nlb`；全部门禁及复杂结构辅助检查。 |
| multi-default | 默认排版，原有末段前插入标题、段落、列表、引用、代码及表格 | 通过 `1imdbhea`；严格 canonical/节点/空段数量及几何对照。 |
| multi-custom | 同上，自定义排版 | 通过 `aaug8a40`；全部门禁。 |
| answer-default | AI 回答整体插入引用，内部含标题、列表、嵌套引用、代码和表格 | 通过 `bx_78f07`；另含实际 Markdown 文件完整验收。 |
| answer-custom | 同上，自定义排版 | 通过 `yn2_782e`；另含 Markdown 文件及实际菜单恢复默认。 |

六行来自分别通过的运行，均由真实 OS 关闭后自然退出0；不是一次连续六例全部绿的声明。最终产品源码 `1f1d91a16cb76ee26e5ad7e000c5c9b3e9754885`。text-default及两项multi旧提交复用的 Record、共享CSS、parser、worker/native源码与最终一致，差异仅限未使用的 Markdown 文件两处源码；text-custom为后续单独复验。两个 answer 场景覆盖最终产品全部源码。`final-matrix.json` 保存逐行精确提交、源码差异、原始manifest与result SHA。`wuqv94nz` 在固定门禁完成后用户又手工试写了子列表；其fixture投影/数量结论对应之前固定检查点，随后OS关闭仍正常保存并自然退出。

默认正文 14px / 1.6 / 段前8px / 段后0；自定义正文17px / 1.8 / 9px / 5px，列表16px / 1.7 / 11px / 3px。两者通过真实设置 API 持久化并由 App 应用，不在 harness 注入 CSS 变量。managed table wrapper 的12px保留既有缩放手柄空间，普通 wrapper 为2px。空段必须有一个真实行框，并与同字号的普通单行段落等高，避免把 WebKit 的行框取整误认为间距变化；computed style 仍按原容差严格检查。

## 已完成的失败定位与修复

### 实际 Record 样式覆盖

首轮 `project-mind-records-ai-20261110-49mpwfm3` 在源码 `0aa9e4c` 上采到实际 Record DOM：默认 surface 为15px/26.25px，而设置是14px/22.4px；h2为21px而非20px；标题段距26px/10px、普通及嵌套p为0/12px，覆盖了共享设置。按明确的 Record 规则重新核对该原始采样，仍有 **38 项真实差异**。

提交 `ffdbb87` 仅移除 `home.css` 的局部字号、行高、p与标题段距覆盖，使其继承共享 RichEditor 排版；保留容器、颜色、标题字重和首块边界；列表项额外间距在后续用户反馈后单独修正。该提交本身不改变全局默认值；后续8px默认值是用户明确确认的独立调整。

### 首轮部分成功与运行失败

同一轮实际完成原记录保存、流式及终态预览 head不变、接受、普通保存、关闭重开。宿主 SQLite 与原生投影一致，接受与重开投影完全相等；接受前后周围块几何零差异，接受与重开几何零差异，行数保持22。

随后在普通编辑对照准备阶段发生原生文件拖放监听清理的 unhandled rejection，完整运行失败，不能把上述阶段结果写成完整 case 通过。栈落在 `useWindowFileDrop` 已卸载后立即清理 SDK 最后一个 drag-leave listener。固定版本 Tauri 的安装 eval 与 IPC ACK 没有 JS安装完成确认，缺失 eventId 的清理会抛错，SDK 又丢弃子 unlisten Promise；具体失败监听的安装先后未直接测时，ACK竞态是结合栈与本地源码作出的推断。

提交 `386fe04` 将唯一的原生四监听归窗口/webview生命周期持有，不随组件卸载调用 SDK cleanup；窗口销毁时由原生回收。各组件及时注销自己的 subscriber，通过最新 callback refs 保留 enabled、位置过滤和多个编辑器的投递语义，错误有明确 toast。监听数量保持常量；本方案避开组件清理路径，不声称修复 SDK 内部 ACK。原生注册失败后本窗不自动重试，避免 SDK 部分成功后再次安装产生重复投递。

旧实现先红两条（延迟注册在卸载后完成、StrictMode及多个组件导致重复订阅），两条既有用例通过；修复后 hook 与实际 ProjectSidebar 共 **28项/3文件通过**，随后 TypeScript、Vite build和bundle boundary通过，主入口226KiB/250KiB。该回归的 SDK 事件受控，后续完整原生 AI 场景已执行对应关闭/重开路径；未用它声称物理拖放导入已验收。

### 用户补充：行距、段距和列表/引用节奏

`386fe04` 上两种纯文字场景已完成全部 functional/style/user-settings 检查及正常 OS 退出；随后用户指出正文、列表和引用的视觉间距仍不协调，并要求审视其他间距。已有检查只保证各场景与同内容对照一致，还需增加不同结构之间的节奏检查。

| 实际 native 样本 | 同段换行的行框步长 | 正文段间额外空白 | 引用段间额外空白 | 列表项额外空白 |
| --- | ---: | ---: | ---: | ---: |
| 默认 `vpdn6xnw` | 22px | 12px | 12px | 6px |
| 自定义 `6torissb` | 30px | 14px | 9px | 6px |

默认字号和行高相同，但列表的局部6px让单行项步长变成28px；正文/引用的新段落步长则是34px。自定义引用内部普通 block flow 会把段前9px与段后5px折叠为9px，正文 flex flow 则为14px。提交 `9151662` 取消列表项额外6px，显式设置共享 li margin-block0；使引用内部与正文一致地累加段距、清除容器首尾重复段距。分隔线外距沿用正文设置，表格内引用仍保留紧凑的 margin 折叠，表格内分隔线使用0.2rem。该版本已完成静态双轴 review，但用户再次指出引用内部仍过松，因此不是最终设计。

首轮多块场景 `u8yiir_p` 没有启动 AI job：harness 选择视口外末段后把 contextmenu 坐标 clamp 到其他可见位置，技能菜单超时。已改为正常滚动目标进入视口，等待真实布局并核对精确 DOM/PM 选区，从选中文字实际矩形内发菜单事件；没有直接调用技能或替换任务结果。

## 最终排版与表格修复

用户最终确认正文默认段距8px。默认正文/引用14px、1.6倍行高不变，引用内部相邻段落额外间距为0，列表项额外间距为0；引用对外保留正文段距。标题、列表组、代码块和表格保留各自的结构间距。前端默认、CSS回退和原生默认同步为8px；历史显式12px及自定义设置保留，不重写用户配置。

参考 [Typora 官方 GitHub 主题](https://github.com/typora/typora-default-themes/blob/master/themes/github.css)：正文行高1.6，段落margin为0.8em，16px字体下为12.8px，按14px等比为11.2px。我们的旧默认12px略大于后者，最终8px更紧凑。引用内部0间距是用户确认的项目选择，不声称完全复制该主题。[Typora 行距说明](https://support.typora.io/Line-Spacing/)也分别定义行高和段落margin。

### 换行后的高光标

原生诊断 `t2_qe6ca` 的37条折叠选区 Range 样本最高17px，但用户仍能看到第二行光标变高；DOM Range不能代表 WebKit 实际绘制的插入条。[WebKit bug 287429](https://bugs.webkit.org/show_bug.cgi?id=287429)记录了换行光标使用整行框高度的同类问题。

仅在 Apple WebKit 中使用独立可视光标：保留原生编辑、选区、撤销和文档，按实际文字Range绘制1px插入条，空段用字体高度约束的坐标回退。光标在正文DOM之外，不进入canonical或HTML；失焦、只读、非折叠选区、组合输入时恢复原生光标。滚动、尺寸和字体变化重新定位，销毁时清理；reduced-motion关闭闪烁，forced-colors恢复原生显示。最终原生辅助验证覆盖默认/自定义×Record/bare/QuickNote×硬换行首行、第二行、空段及自动折行，并检查只读/失焦和文档不变。

### 引用内部表格

AI回答插入时给各行加引用前缀。旧手工表格解析器只识别顶层行，导致带 `>` 的表格成为普通文本。改为独立的 CommonMark MarkdownIt 实例并启用table规则，保留html:false、富文本token恢复及代码尾换行处理；不修改全局tokenizer。新增引用内表格/嵌套引用/代码块保护回归先红2条，修复后RichEditor与内容转换153项通过，其中实际“插入”按钮检查表格仍位于引用内。原生最终矩阵另检查保存的canonical引用包含table节点，以及保存重开和普通编辑对照完全一致。

### 保留的失败历史

`9151662` 的默认 `3kt3c6be` 完成AI/保存/重开/设置/OS退出，但辅助代码块检查误把既有pre-wrap当成横向滚动要求，整轮失败。已按真实CSS核对代码实际折行及不溢出；宽表格仍严格要求自有横向滚动。自定义 `i7t_7xcy` 在新用户反馈后中断，未正常退出。`t2_qe6ca` 的紧凑引用诊断完成功能检查后等待现场光标观察超时，也不计最终通过。旧通过记录不替代最终版本验收。

### 子列表与恢复默认

用户补充要求后，有序列表使用 `1. → a. → i.`，无序列表使用实心圆→空心圆→小方块；混合列表按整体深度区分，任务列表保留复选框。有序方案参照 [Typora 官方嵌套列表示例](https://support.typora.io/List-Style/)，不是宣称所有主题默认相同。只改标记样式，保留序号起始值、缩进、行高和正文内容。原生辅助检查包含三层有序/无序、混合列表、start=3/2和任务复选框。

富文本样式设置顶部提供“恢复默认”，整套恢复正文、四级标题和列表配置。点击立即提交原生保存；旧按钮仅改draft并等待500ms自动保存，立即关闭设置会丢失恢复，新增回归先红1条，修复后设置组件3/3通过。

### AI流式预览额外尾空段

原生多块场景 `p20qfrj7` 发现接受后比普通编辑多出一个尾空段，canonical/HTML/text和节点数量严格对照失败；保存重开虽原样保留，仍不是格式正确。原因是预览中间态以heading结尾时，Tiptap TrailingNode自动追加的段落落在预览范围之外，之后接受或撤销均遗留。PreviewTrailingNode仅在最后一块仍受AI预览保护时跳过自动追加，实际接受后和用户普通编辑继续使用原始TrailingNode行为。不删除用户空段，不禁用普通末尾编辑段。

接受/撤销×stable开关四条真实RichEditor回归先红4条，修复后通过；包括原来用户空段完整保留。相关RichEditor、StableRecordBlocks、内容转换、原生HTML adapter及设置组件共195条独立检查已通过，TypeScript通过。前一轮194/195中reset断言收到React Query附加context参数，按真实参数边界检查第一个参数后设置组件3/3通过；旧实现原红为没有任何持久化调用。

原生caret辅助探针还发现bare初次选区滚动时节点视图有后续布局，首帧插入条位置差13px。验证进一步要求实际文字矩形连续两个采样不变，再严格比较caret x/y和高度；最多8次真实布局采样，超时或稳定后仍错位均失败，不用计时器制造布局成功。

### 最后复验中保留的检查与环境失败

`6d4c5a8` 的六例中，text-default/multi-default/multi-custom完整通过；text-custom误把引用段落后的嵌套引用边界期待为正文before+after，实际前段margin已归零，应只取嵌套引用marginTop。两个answer误把被整块回答隔开的p[0]/p[1]当成相邻段落，320px包含回答本体。修正harness后只复验受影响三例；严格canonical、节点数量和普通对照几何未放宽。

Markdown首次扩展fixture `ifd53obb` 把Record的CommonMark普通粘贴误当成支持GFM任务框，缺少预期“Task item”段落，故未进入文件验证；从此对照移除该无关能力差异，任务框仍由复杂结构辅助fixture独立验证。`ku1vjmaa`/`kt2uj0ab` 因native专用Vite配置noDiscovery漏掉文件预览的CommonJS依赖而加载失败，未计通过。使用Playwright纯模块诊断定位`anser`默认导出，补全测试服务器固定依赖后，实际FilePage/native复验通过；没有用浏览器模块加载成功替代原生验收。旧失败报告均保留。

## Markdown 文件与记录排版统一

用户追加要求核对实际打开的 Markdown 文件。此前 Markdown 虽使用相同设置变量，却独立定义段落/引用和列表 CSS，导致引用段距、嵌套标记及光标处理分叉。文件块编辑现在复用 `rich-editor__surface` 及同一 TextCaret，删除重复语义排版，保留文件页边距、工具栏、代码语言工具和源码等宽编辑器。字号按文件自身缩放；100% 时与同内容普通粘贴保存的 Record 比较。历史版本只读使用相同规则。

Markdown/上下文菜单/File 会话三套既有回归共49项通过，TypeScript通过。新增实际 native File 场景通过公开 documentImport 导入临时 Markdown，使用真实 FilePage 和工作会话，核对正文、四级标题、引用及嵌套引用、三层有序/无序列表、引用内表格；检查首/次行可视光标高度与文字 Range 一致、150%字号缩放和100%恢复、源码切换不改变渲染，以及普通编辑后 Cmd+S、关闭重开和原生文件字节。结果见最终矩阵。

## 证据与边界

运行入口、原始报告、native日志、provider请求、事件、几何和只读SQLite见 ignored `output/records-ai-native/`，交付时归档到共享 `review/evidence/records-delivery/ai-runs/`。新运行的 `manifest.json` 记录精确提交、源码及harness SHA。基础设施独立运行 `ds6gnwc6` 已通过，但未挂 App，通过 `app_exit` 退出；该结果不计正常 App 关闭验收。

所有重型/原生运行使用共享 build lock 串行。该验证限于所采集的 macOS fixture；不声明 Windows、真实远程模型、系统输入法、全部历史用户文档或 Office renderer 已通过。

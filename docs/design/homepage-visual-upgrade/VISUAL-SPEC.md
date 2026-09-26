# Workspace / Project 首页视觉规范（第一版）

状态：视觉方案，依据 Issue #95、`HANDOFF.md` 与五张参考图。可查看稿：[`prototype.html`](prototype.html)，可在页面内切换 Workspace / Project、筛选、空态、长列表、窄窗、矮窗与 QuickNote 状态。设计稿展示的是布局与状态，应用数据以当前作用域为准。

## 1. 页面结构

两页共用四区：左侧导航（宽 260px，可拖动 224–320px）、顶部页签（高 52px）、中间主内容（最小宽 520px）、右侧资源栏（宽 360px，可折叠至 48px）。1600×992 下中间可用宽约 970px；内容内边距 16px，最大阅读宽 1040px。顶部保留 Workspace 入口、已打开项目页签、关闭与新窗口能力、全局搜索和工具入口；项目图展示的页签较 Workspace 图多，统一按现有页签系统实现。

中间内容独立滚动。紧凑页头高度 198px，图像上覆盖自上而下透明至暖白的渐变，图标与标题叠在图像下沿；其下 QuickNote 在主内容滚动容器顶部吸顶。QuickNote 默认最小编辑高度 124px，内容自然增长，外框最大高度 `min(420px, 48vh)`，超过后仅编辑正文滚动。QuickNote 总高度不能占满矮窗。Record 标题/搜索/筛选随主内容滚动，卡片单列。记录在 QuickNote 下方，不通过视图切换隐藏。

Workspace 左上为活跃 Project，带创建、归档管理及项目既有操作；左下为**全部 Workspace Tag**与“全部记录”，不显示具体 Workspace Record。Project 左上为最近打开的 5 条 Project Record（设备内打开历史，按最后打开倒序；无历史时按创建时间倒序补足，不因 AI 标题/标签更新跳动），左下为**全部当前 Project Tag**与“全部记录”。点击最近记录仍进入该记录 Focus 页。标签选中只过滤中央 Record 列表；搜索与标签取交集，不影响 QuickNote、项目、最近记录、Todo 或 File。选中态在侧栏和列表顶部过滤片同步显示，任一处可清除。

Workspace 右栏上方为 Workspace View Todo，来源显示“工作区”或所属活跃项目。底部是安静品牌区：两行 slogan、署名、约 150×135px 的 Nori 胸像，距右/底 20/10px。Todo 区可滚动，小熊不覆盖 Todo；窗口高度低于 720px 时品牌区仅保留 90px 胸像，低于 560px 时隐藏品牌区，确保 Todo 操作可用。Project 右栏分为 Todo（上，约 42% 至 60%，最小 220px）和 File（下，剩余高度、最小 180px），各自滚动，分隔线可拖动。Todo 保留“当前项目 / 整个工作区”，后者是 Workspace View，不改 Todo 归属；File 永远是当前 Project 的 File。File 区有上传、拖入、搜索、Tag 筛选、打开/定位、版本、标星、重命名、删除等现有入口；长列表独立滚动。

## 2. 视觉系统

| Token | 值 | 用途 |
| --- | --- | --- |
| `--home-canvas` | `#FAFAF8` | 首页主背景 |
| `--home-surface` | `#FFFFFF` | 卡片、弹层 |
| `--home-sidebar` | `#F7F7F5` | 左右栏 |
| `--home-ink` | `#151719` | 主要文字与主按钮 |
| `--home-muted` | `#647089` | 摘要、时间、说明 |
| `--home-line` | `#E4E6E9` | 分隔、输入边框 |
| `--home-hover` | `#F0F1F2` | 悬浮 |
| `--home-blue` | `#2878F4` | 品牌点、选中竖线、链接、焦点环 |
| `--home-success` | `#55A963` | 已保存 |
| `--home-error` | `#B94A45` | 保存/转存失败 |
| radius | 8px 输入、10px 卡片、12px 页头 | 统一轮廓 |
| shadow | `0 2px 12px rgba(20,24,31,.035)` | 仅浮层/必要深度 |

字体：中文使用现有 Noto Sans SC，西文使用现有 Work Sans；页标题 28/36、区标题 22/30、正文 15/24、辅助 13/19。图标用 Lucide 18–20px、1.8px 描边。页面中以黑白灰为主，蓝色只用于交互强调。封面和文件缩略图保留自然颜色。图标底座独有 `rgba(255,255,255,.65)`、`backdrop-filter: blur(14px)` 的毛玻璃，其他区域不用玻璃。主按钮炭黑底白字；次按钮白底灰边。焦点环为 2px 蓝色，状态除颜色外配文字/图标。

## 3. 组件及状态

- **封面与身份**：共用自然彩色内置封面。图片使用 `object-fit: cover` 与可保存的水平/垂直位置；Project 可切换内置封面、上传图片、在裁切视图中拖动重定位并预览保存/取消。Workspace 可设置自己的封面与身份，不因此建立 Workspace File。封面右下“编辑封面”仅 `:hover` / `:focus-within` / 触屏明确菜单时显现。Project 图标选择器提供统一的 Lucide 白名单（Compass、FileText、UsersRound、Lightbulb、Target、Layers、BriefcaseBusiness、CalendarDays 等），存图标键名，不存 emoji；Workspace 使用 House。未设置或加载失败时使用默认内置封面和图标。
- **QuickNote**：标题左侧；右侧为“保存中… / 已自动保存 / 保存失败，重试”及展开。正文使用现有 RichEditor 的 Committed Content；工具栏底部，拆分按钮主项“存为记录”、次项“追加到记录…”。展开是模态窗，使用同一草稿及单一保存队列，关闭后恢复焦点和滚动。转存中禁用重复提交并显示进度；失败保留全文和资产引用、提供重试。没有内容时主操作禁用。QuickNote 的右键选区转存入口移除，其他编辑器功能不变。
- **整篇转存**：先 flush 草稿并固定 Committed Content 快照，写入目标 Record 成功后才清除匹配该快照的 QuickNote；提交期间若输入变化，清除仅已提交的部分或保留后续输入。自动保存与提交串行并使用草稿版本防止旧写回。新 Record 标题先取与正文相关且像标题的首行；显式正文 `#标签` 优先并复用当前作用域已有 Tag。排除 Markdown 标题、围栏代码与内联代码的 `#`。AI 元信息只补足缺失信息，失败时正文照常完成；异步结果应用前对比版本，且以原子命令写入标题/标签。追加保留目标原题和原正文，新增内容隔段追加、显式 Tag 去重合并。仅同作用域 Record 可选。
- **Record 卡片**：单列，最小高 116px；标题 17/25、摘要最多两行、Tag 胶囊、时间、更多菜单，图片/附件预览在有资源时靠右显示。Voice Record 标记并继续可打开。点击卡片进入 Focus；键盘可达。长列表采用既有性能策略，不把所有记录做成侧栏行。零记录空态提供创建 Record；筛选/搜索零结果提供清除条件，不混淆两者。
- **Todo**：保留创建归属、完成/未完成、来源、现有详情操作。Project 切换 Workspace View 时 File 区不变化。Todo 空态给出创建入口；长列表在右栏局部滚动。
- **File**：项目专有，空态是上传/拖入提示；待导入、失败、丢失、版本和标星均有文字状态及操作入口。小预览 40px；菜单承载重命名、定位、版本、标签等既有动作。

## 4. 响应式与空间

宽度 ≥1280px：三区并列。1024–1279px：左栏 224px、右栏 300px，封面及卡片随中间收缩。800–1023px：右栏默认折叠为可展开抽屉，左栏仍在，主内容最小 500px。<800px：左栏和右栏均以可独立打开的抽屉呈现，顶部页签横向滚动；中央占满余宽，QuickNote 上限 `min(360px, 42vh)`。高度 <720px：封面降至 150px、QuickNote 上限 `min(300px, 40vh)`；右栏 Todo/File 独立滚动，品牌区收缩。高度 <560px：封面 120px，Workspace 品牌区隐藏，QuickNote 上限 220px。模态窗宽 `min(760px, calc(100vw - 32px))`、高 `min(780px, calc(100vh - 32px))`。

## 5. 资源清单与加载

| 资源 | 文件/形式 | 尺寸与用途 |
| --- | --- | --- |
| 内置高山封面 | [`assets/alpine-cover.png`](assets/alpine-cover.png) | 2170×725，独立横幅，应用里另产优化 WebP；图片与渐变分层 |
| Nori 胸像 | [`assets/nori-bust.png`](assets/nori-bust.png) | 1312×1199 透明底，仅 Workspace 右下及小品牌标识裁切使用；另产优化 WebP |
| 品牌字样 | HTML 文本 `Nori` + `Mind` 与蓝点 | 避免把参考截图中的字裁成图；不做全局产品名迁移 |
| 功能与项目图标 | 当前 `lucide-react` | SVG，项目只保存白名单键名 |
| 自定义封面 | 项目/工作区界面资源 | 原图持久化、CSS `object-position` 预览；上传限制与失败回退 |

两张生成资产均依据参考图单独制作，不包含界面截图元素。参考图原样保存在 `references/` 供核对；应用不加载整张参考图。

## 6. 当前代码与实施分包

当前 Workspace / Project 均将 QuickNote 和 Record 分为两个视图；Workspace Tag 列表、Project Tag 列表当前由 Record 上已使用 Tag 聚合，遗漏未使用 Tag；Project File 功能集中在左侧 `ProjectSidebar`；Project Todo 切换已有实现。Workspace QuickNote autosave 现为 120 秒，Project 保存机制独立；两者均有选区转存菜单。以上是现状与新方案的具体差异。

1. 先建仅首页使用的 `home-*` 样式和共享页头/QuickNote/Record 展示组件，避免改变 Focus 页全局样式。
2. 改两页中央布局为一体化滚动页，接入各自完整 Tag 设置和筛选；左栏改为指定导航。最近打开历史用本地持久化的 Project Record ID 列表，按项目隔离，最多 5 条。
3. 建封面/身份设置与资源存储；Project File 控制区移到右栏且沿用现有 document 数据/操作。Todo rail 新增可组合上下区布局，保留现有 Todo API。
4. QuickNote 建共享草稿/保存协调器及整篇转存服务，分别接 Workspace / Project 后端；先写竞态/失败/范围测试，再接 UI。更新 ADR-0005 补充自动元信息约束。
5. 静默运行 TypeScript、单元/集成测试、Rust 相关测试和静态规则；通知用户后集中打开本分支 UI 检查两页所有状态与 Focus 回归；主 agent 自查 Standards / Spec，按 `publish-flow.md` 收尾。

## 7. 验收矩阵

Workspace / Project 各验正常、Tag 筛选与清除、搜索交集、无 Record、长 Record 列表、长 Tag 列表、窄/矮窗。QuickNote 验短/长内容、吸顶、展开/关闭、自动保存中/成功/失败、同草稿切换、整篇新建/追加、双击、写失败、提交中继续输入、图片/引用/Tag 保真、AI 不可用。封面验默认/悬浮/键盘、内置选择/上传/重定位/取消/失败；Project 验 Todo 两种 View 与 File 全操作；Workspace 验 Todo 来源与品牌区空间。最后回归 Focus 编辑/保存、页签切换/关闭、项目独立窗口、归档项目与现有键盘导航。

# Office 编辑器设计方向

范围：#118 的 DOCX / XLSX / PPTX；独立 Office worktree。用户要求先使用 `frontend-design` 出设计参考，与 Project Mind 统一，并参考成熟编辑器。

## 设计依据

已读取 `.impeccable.md`、`docs/design-system.md` 与 `src/styles/app.css`。目标用户是在项目中处理工作文件的人；视觉遵循 calm / rigorous / decisive：暖浅背景、墨色正文、紧凑工具栏、明确状态、编辑面优先。

主色与字体引用当前实际 app tokens（`--color-accent: #1976c9`；`--font-ui`），不修改全局主题。原文件正文/表格/幻灯片自身的颜色与字体继续来自原件，不能为了统一外壳改写文档内容。

成熟项目参考：[ONLYOFFICE 演示编辑器](https://helpcenter.onlyoffice.com/docs/userguides/presentation_editor/ProgramInterface.aspx)的缩略图、主画布与按对象展示的属性区；[ONLYOFFICE 表格编辑器](https://helpcenter.onlyoffice.com/docs/userguides/spreadsheet_editor/ProgramInterface.aspx)的公式区和工作表导航；[Univer UI 配置](https://docs.univer.ai/guides/sheets/features/core)的可定制工具栏、主题和组件。取其布局与明确的编辑对象，产品操作仍只呈现实际支持的内容编辑。

## 统一外壳

- 沿用 Project 内容 Tab 与文件头部。文件名、固定版本、保存状态/保存操作、刷新和外部打开在同一行；不另外添加重复的文件标题和保存条。
- 宿主控件复用 Button / ToolbarButton、UI 字号 12px、图标 14–16px、控件高度 28px；圆角 4/6px、细分隔线，状态用次级文字。
- 格式工具条只呈现已实现操作。内容编辑阶段不展示不能回存的字体、颜色、布局等控件。历史版本呈现“历史版本 · 只读”。
- 保存中冻结可写控件；失败不丢编辑，冲突不跳到他人新版本。切换版本、关闭与应用退出通过现有 guard 保存。

## 各格式编辑面

- Word：浅灰工作面上居中的文档正文，段落/表格可直接编辑；原图片可见。正文容器适合宽度，不宣称已经有完整分页、页眉或页脚预览。不要增加大块介绍/卡片。保留原件排版数据。
- Excel：复用 OSS Univer 原生网格、选区、公式栏与底部工作表导航；UI 主题取宿主 tokens，隐藏不能回存的结构/格式操作。原单元格颜色、字体、合并与公式属于原件内容，不能被宿主主题替换。
- PPT：左侧窄缩略图列、中间原比例幻灯片、选中对象时显示文字/图片位置编辑区；不显示内部 XML ID。窄容器中属性区改为可展开面板。选中框使用 accent，保留原稿色彩，无新增水印。

滚动列表遵循设计系统的连续边缘遮罩规范；动效只复用 100/160/220ms 与 reduced-motion。针对宽容器与内容分屏分别验收。

## 参考产物

[可切换三种格式的交互参考](office-editor-direction-20261013.html)。参考中的文字是独立示例，不是解析原件结果；仅用于布局与状态体验，不计为产品验收。正式实现以真实文件与实际支持操作为准。

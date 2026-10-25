# GenOffice Office 创作与 Skill 复用调研

调研日期：2026-10-25（Asia/Shanghai，23:31）。对应需求：在已交付的基本 DOCX 创建及原生 File 保存基础上，补齐复杂 Word 排版、Excel 和 PowerPoint 创建。本文为只读源码调研；未启动应用窗口，未把源码支持声明当作本项目已经交付的功能。

## 结论

**应复用上游已有的 Skill、结构化协议和本地保存引擎。当前锁定版本本身已包含完整 headless CLI，不必为此升级整个 GenOffice。** 本次检查的三个适配包都固定在 `d32d1711f1bf985430757b8c6b3fbddd3831d946`。该提交已经包含 `skills/genoffice/SKILL.md`（metadata version 2.67.1，CLI >=0.9.0）、`packages/cli` 的 DOCX/XLSX/PPTX 创作实现和幻灯片设计指南。[固定版 Skill](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/skills/genoffice/SKILL.md)、[创建命令](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/commands/create.ts)

上游当前 main 为 `28cee5ca8a3a1b6b069ea2640493bcb6fce45e0a`，提交时间 2026-10-24T07:21:50Z，比本项目锁定版前进 82 个提交。这是观察点，不是本包升级目标。新版增加了 `skills/recommended/` 业务配方；它们主要是写作、预算、分析、演示规划指导，不能替代实际引擎接口。[固定观察点目录](https://github.com/genspark-ai/genoffice/tree/28cee5ca8a3a1b6b069ea2640493bcb6fce45e0a/skills)、[提交比较](https://github.com/genspark-ai/genoffice/compare/d32d1711f1bf985430757b8c6b3fbddd3831d946...28cee5ca8a3a1b6b069ea2640493bcb6fce45e0a)

复用分为两层：模型沿用上游“先规划→结构化创作→检查→按需修正”的指导；本地 worker 接受结构化数据，用已有引擎生成可编辑 OOXML 字节。原生宿主继续负责实际归属、权限、File v1/v2、CAS、幂等回执和持久化。上游 Skill 中的独立 `genoffice` 命令、用户目录和账户配置需要替换为本项目已注册的工具，不能原样注入后假设系统装有另一个应用。

## 已有 Skill 是什么

上游存在两类不同的 skill：

| 类型 | 真实入口 | 适合复用的内容 | 宿主依赖 |
| --- | --- | --- | --- |
| 编码 agent 的文件配方 | `skills/genoffice/SKILL.md` | 文件类型选择、结构化编辑、检查、读回、PPT 设计流程、公式缓存与格式限制 | 指令使用独立 GenOffice CLI，需要映射本项目工具 |
| GenOffice 内部 AgentSkill | `apps/docs/.../docs-skill.ts`、`apps/sheets/.../workbook-skill.ts`、`apps/slides/.../slides-skill.ts` | 系统 prompt、工具 schema、上下文与校验逻辑 | 编辑器/IPC、panel-owned writer、模型与媒体 provider、用户选区等 |

内部 `AgentSkill` 不是一个能直接装进 DSH 的 `SKILL.md`。例如 Docs 的 `write_document` 需要面板 writer，Slides 的 `generate_deck` 需要规划、逐页生成和图片服务；它们不应连同原独立聊天和账户系统一起移植。[Docs 内部 Skill](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/ai/docs-skill.ts)、[Sheets 内部 Skill](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/ai/workbook-skill.ts)、[Slides 内部 Skill](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/slides/src/renderer/ai/slides-skill.ts)

建议在本项目现有 Office 配方中保留来源与版本，适配实际工具名、参数和原生保存规则；复制纯指导时保留上游许可和 NOTICE。推荐业务 Skill 可作为后续内容模板，不是本包创建能力的前置依赖。

## Word：直接复用上游 headless 编辑表面

固定版 `packages/cli/src/formats/docx.ts` 已将 renderer 的纯编辑逻辑置于 DOM 中运行：`blankDocument/openDocument → fillFromHtml/applyDocOps → saveDocument → closeDocument`。它动态装载 Tiptap editor、extensions、受限 HTML parser、ops、tools、页设置、浮动对象、表格、注释和脚注模块。该路径可以直接复用现有 schema 与执行器，避免另建一套复杂排版 DSL。[DOCX headless 实现](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/docx.ts)

实际支持范围不限于原先纯文本 HTML：

- 原生段落、标题、列表和表格内容，以及 `apply_ops` 定义的字体、对齐、间距、表格结构与格式。
- `set_page_setup`、`insert_section_break` 和分节保存，包括纸张、边距、方向、栏、页码设置。
- 普通/首页/奇偶页页眉页脚、样式定义与应用、水印、图片、文本框、脚注/尾注、图表；图表更新同时维护对应图表部件和内嵌工作簿。
- `docsCatalog()` 从真实工具定义及 apply-op schema 生成字段说明；适配后的配方应该复用该 schema，不让模型猜字段。

这些支持需通过本项目 worker 边界验证，并以 OOXML 内容、重新 inspect 及保存后读回证明。`saveDocument` 将正文 save plan 与 section edits、headers/footers、styles、notes 和 chart patches 一起交给 `saveDocx`；只改 PM 正文而遗漏 side state 会造成排版丢失。[分节实现](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/docx-sections.ts)、[实际工具 schema](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/ai/tools.ts)

上游 DOM helper、文件读写和图片下载属于需适配部分。可在构建时选择性 pin 同提交源码，使用声明依赖的 DOM runtime；图片入口只接宿主已批准的内联数据，禁止 worker 自行读取模型给出的路径或下载 URL。不要把独立 CLI 的文件输出、CLI 错误包装和应用资源定位整体带入宿主。

## Excel：完整 workbook 保存优于单表值导出

上游 `create --type xlsx --from` 支持 CSV、二维数组或 `{sheets:[{name,rows}]}`；以 `=` 开头的字符串作为公式。它使用 `blankXlsxBuffer`、gateway cell/structural edits 和 sidecar 计算，而非简单文本文件改扩展名。[XLSX 创建与保存](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/xlsx.ts)

`runWorkbookDsl` 是已有全功能 headless 编排，但不是可单独取用的极小纯函数：先读取完整 snapshot/meta，逐 op 通过 `InMemoryWorkbookAdapter` 校验和变更，再将 cells、结构、格式及不能保存在 snapshot 中的规则/visuals 转成 gateway payload。只调用 `expandToPrimitiveOps` 会遗漏图表、筛选、条件格式等保存数据。[DSL 编排](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/xlsx-dsl.ts)、[Gateway payload 生成](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/xlsx-gateway-ops.ts)

本项目已经拥有完整 gateway 和 sidecar，因此可以在空白 workbook 上复用同一条保存路径，接受初始多 sheet 数据及已验证的 gateway changes：单元格与公式、格式、行列尺寸、合并、结构、图表/图片、筛选、冻结、规则、链接、批注、打印和保护等。若没有暴露上游 DSL，不应让 Skill 直接推荐 `set_range` 等不存在的工具操作。上游 DSL 的 sheet 名、范围顺序和规则合并语义也不能凭近似字段重新解释。

需要明确的既有边界：部分函数不能由本地计算器求值，输出可以保留公式、由 Excel 打开后计算；不得虚构缓存值。上游 headless 仍拒绝依赖 live editor 的 `refresh_pivot` 及部分 session-created table/shape 编辑。“完整 Excel 创建”应指在已支持保存模型内完整生成可编辑 workbook，不能解释为覆盖 Excel 全部功能。[固定版 Skill 的公式及限制说明](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/skills/genoffice/SKILL.md)、[真实操作目录](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/xlsx-catalog.ts)

## PowerPoint：复用 DeckSpec 与真实 PPTX primitives

固定版已经有两个本地创建入口：

| 路径 | 输入与实现 | 适合任务 |
| --- | --- | --- |
| DeckSpec | `parseDeckSpec → buildDeckPptx`，每页经 `buildPagePptx` 生成并合并 | 从 brief 创作整套多页演示 |
| PPTX ops | `createBlankPptx → openPptx → runTxn → savePptx` | 精确对象操作及复杂原生对象补充 |

前者没有 HTML 中转，直接生成原生可编辑 shapes、text 和 pictures。宿主只需提供图片字节、尺寸和字体测量接口；CLI 使用 `HeuristicMetrics`，并不要求 Genspark 账户。画布固定 1280×720px，最多 60 页，每页元素/图片/文本有资源限制；本项目可设置更小总预算。[DeckSpec](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/pipelines/src/slides/deck-spec.ts)、[PageSpec](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/pipelines/src/slides/page-spec.ts)、[PPTX ops 包装](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/cli/src/formats/pptx.ts)

上游 parser 允许丢掉无效页/元素并携带 issue，图片失败也可能得到成功 deck。本项目原生创建不应悄悄丢页或媒体：遇到 error/不可解码媒体应拒绝并返回可修正原因；warnings 则需要保留。固定版 PageSpec 只有 shape/text/image；不能仅接 PageSpec 就声称已支持所有原生图表、动画、公式或媒体。此类对象需复用原生 ops，而非用不可编辑截图冒充。[布局 audit](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/pipelines/src/slides/audit-deck.ts)

最值得复用的 Skill 内容是设计流程：统一风格→提纲→逐页 spec→检查→生成→渲染与修正。上游指南包含配色、字号、布局变化、真实素材、几何审计与文字溢出规则，能明显改善“能生成但不好看”的问题。工具/路径需适配本项目，媒体只接受受控内联数据，避免 worker 带网络或文件权限。[固定版设计指南](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/pipelines/src/slides/guides/design.md)、[Spec 指南](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/pipelines/src/slides/guides/spec.md)

## 渲染与现有宿主接缝

上游 `render`/PDF 导出会启动隐藏的独立 GenOffice 进程，再用 PDFium 转 PNG。这一部分不能直接视为“纯 Node、无额外应用”的可复用能力。当前项目已拥有三个 renderer、原生输出与固定版本读写服务，应优先复用现有显示/输出入口；编译和引擎测试不启动窗口。若需要实际页面验收，集中执行并事先告知用户。[上游渲染实现](https://github.com/genspark-ai/genoffice/blob/28cee5ca8a3a1b6b069ea2640493bcb6fce45e0a/packages/cli/src/formats/render.ts)

本项目当前接缝（调研时工作树）：

- `packages/office-runtime/worker.mjs`：数据边界，`office.create` 当前限 DOCX 字符串。宜扩展格式及严格 JSON 输入，不暴露路径。
- `packages/office-docx/engine.ts`：`create/inspect/edit`；复杂 Word 可采用固定版 headless ops，已有 `snapshot` 仍保留 renderer 的固定基线保存。
- `packages/office-xlsx/engine.ts`：现有 `inspect/edit/recalculate`，完整 gateway changes 和 sidecar 已经接通；新增空白 workbook 创建复用这条路径。
- `packages/office-pptx/engine.ts`：现有 `inspect/edit` 及 command/candidate 保存；新增 DeckSpec/ops 创建复用相同引擎。
- `src-tauri/src/file_office_create.rs` 与 `dsh_office.rs`：已提供生成字节→原生 File 创建→回执→固定版本 inspect；增加格式和 JSON payload 时保留这些不变量。

这些是本地实际代码观察，不代表新增协议已实现。实施时应让新建与续改都经过同一 worker、native 保存及固定版本检查。

## 版本、许可与交付验收

保持三个包同一固定提交。选择性增补源文件时，沿用已有 source-lock/upstream manifest 的 Git blob hash 校验；不在构建时追随 main。GenOffice 使用 Apache-2.0；保留 LICENSE、NOTICE、上游来源和本地修改说明。新增 npm/DOM/字体依赖分别加入第三方许可清单，不能认为项目许可证自动覆盖依赖。[固定版 LICENSE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/LICENSE)、[固定版 NOTICE](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/NOTICE)

建议本包验收至少覆盖：

1. DOCX：字体/对齐/间距、原生表格、图片、页眉页脚与页码、页面或分节；创建后 inspect、ZIP 结构和再次编辑保存一致。
2. XLSX：多 sheet、跨表公式、格式与合并、图表或图片、筛选/冻结、至少一种规则；重开后公式、格式和媒体仍在，计算失败有明确行为。
3. PPTX：多页风格一致、富文本、图形及图片；页数/元素不丢失、原生可编辑、几何问题可发现，创建后续改同一 File v2。
4. 三格式均通过实际 DSH 工具→原生 File→固定 sourceRef 读回；只读与外域拒绝、幂等 replay、旧基线拒绝覆盖仍有效。
5. Skill 只写已注册的真实工具，明确结构化输入、媒体和完整性检查；资源可读、停用撤销、打包无隐式外部应用依赖。

本次检索方法：GitHub 官方 API 读取固定树和文件、compare API 读取提交差异；官方 GitHub README/Skill 搜索交叉确认；本地包锁及接口对照。未运行完整应用验证，未安装或调用另一个 GenOffice 应用。

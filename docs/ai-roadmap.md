# Project Mind AI 路标

## 1. 目标与原则

- 用 AI 把 `记录 -> 总结 -> 项目状态 -> 今日规划 -> 问答` 串成一个连续工作流。
- 以 `SQLite` 为唯一真相来源，不做 Markdown 导出，不把 Markdown 作为知识层依赖。
- AI 不直接读数据库或写 SQL，统一由应用层组装上下文。
- AI 生成的概览与规划默认只读；写入 `Conclusion` / `Todo` 仍采用显式采纳。
- Summary / Brief / Today 的生成逻辑需要预留对标准化 `Skill package` 的兼容能力，不把 prompt 与输出约束硬编码死在页面层。
- 每个阶段开始前先更新本文件中的实施前计划；阶段完成后回填现状、风险和下一阶段准备。

## 2. 当前基线

- 当前前台已具备的 AI 能力只有：从单条 Note 生成候选结论 / Todo，并由用户确认写入。
- 设置页已支持 `default / assistant / summary / suggestion_generation` 能力绑定。
- `assistant` 与 `summary` 当前仍停留在配置层，前台没有独立工作流。
- 当前工作台搜索覆盖项目、活动、结论、Todo 和文件，不覆盖 Note 正文。

## 3. 阶段路标

| Phase | 状态 | 目标 | 主要交付 |
| --- | --- | --- | --- |
| Phase 0 | `DONE` | 建立 AI artifact 基础层与执行机制 | roadmap 文档、`ai_artifacts`、`ai_artifact_citations`、artifact API、失效标记 |
| Phase 1 | `DONE` | 交付 Activity Summary / Project Brief / Today | Activity 页 AI 总结卡、Project 页 AI 概览卡、Today 页面 |
| Phase 2 | `DONE` | 交付 Ask 问答 | `ai_answer_question`、Ask 面板、scope 隔离与引用跳转 |
| Phase 3 | `PLANNED` | 检索增强 | Note 正文检索接入问答链路，文本文件内容接入 |

## 4. Phase 0：AI 基础层

### 状态

`DONE`

### 目标

- 建立统一的 AI artifact 数据模型与读写接口。
- 让项目、活动和今日概览具备“可缓存、可过期、可刷新”的派生结果层。
- 把后续 Phase 1 的 UI 能力建立在稳定的后端基础之上。

### 范围

- 新增 `ai_artifacts` 与 `ai_artifact_citations`。
- 新增 `ai_artifact_get` / `ai_artifact_refresh` 命令与前端类型。
- 为 Note / Conclusion / Todo / Document / Project Summary 变更补齐 artifact stale 标记。
- 复用现有 `summary` 能力绑定，不改变现有 `suggestion_generation` 流程。

### 实施前计划

- 在数据层新增统一 artifact 记录与 citation 记录，并提供基于 `kind + scope` 的唯一定位方式。
- 新增三类 artifact：`activity_summary`、`project_brief`、`daily_brief`。
- 生成器实现采用内置 `artifact skill spec registry`：
  - 当前版本先内置在代码中
  - 每个 artifact kind 都关联 `skillKey / skillVersion / section schema`
  - 后续可以替换为标准化 Skill package 加载结果，而不改前端页面和 artifact API
- 为 activity / project / today 组装固定上下文，要求模型返回结构化 JSON；由后端归一化为 `jsonPayload + markdown + citations`。
- 将 `ai_artifact_get` 设计为“只读取当前状态”，将 `ai_artifact_refresh` 设计为“强制重算并覆盖结果”。
- 在现有写操作后标记相关 artifact 为 stale，不改变现有业务对象的主存储。

### 接口 / 数据变更

- Rust / TS 新增：
  - `AiArtifactKind`
  - `AiArtifactRecord`
  - `AiArtifactCitationRecord`
  - `AiArtifactGetInput`
- artifact 记录额外保存：
  - `skillKey`
  - `skillVersion`
- Tauri command 新增：
  - `ai_artifact_get`
  - `ai_artifact_refresh`

### 测试点

- 新库 / 旧库启动后都能创建 artifact 表。
- 项目、活动、Todo、结论、文件变更后只标记相关 artifact stale。
- summary 能力未配置时返回受控错误，不影响现有 suggestion 流程。
- 结构化输出异常时，artifact 记录进入错误态而不是写入损坏内容。

### 当前现状

- roadmap 主文档已建立，并补充了开源方案参考与许可证边界。
- Rust / TS 已补齐 artifact 相关类型、`ai_artifacts` / `ai_artifact_citations` 表结构、`ai_artifact_get` / `ai_artifact_refresh` 接口。
- artifact 生成链路已切到内置 `artifact skill spec registry`，每种 artifact 都持久化 `skillKey / skillVersion`，为后续兼容标准化 Skill package 预留接口层。
- `summary` 能力已可用于 `activity_summary` / `project_brief` / `daily_brief` 三类 artifact 的结构化生成；mock provider 已支持 artifact 测试。
- Note / Conclusion / Todo / Document / Project Summary 相关更新路径已接入 stale 标记；Tauri command 接线已完成，`cargo check` 已通过。
- 已补两条后端测试：
  - artifact 可生成并带上 `skillKey / skillVersion / citations`
  - Note 更新后只让相关 `activity_summary / project_brief / daily_brief` 进入 stale，而不影响其他项目 brief

### 风险 / 阻塞

- Activity / Project / Today 三类 artifact 的 JSON 输出格式需要保持固定，避免前后端耦合反复变化。
- 当前仍依赖内置 skill registry；真正切换为标准化 Skill package 时，还需要补“外部包发现 / 校验 / 版本兼容 / 回退到内置 skill”的装载机制。

### 下一阶段准备

- Phase 0 完成后进入 Phase 1，接入 Activity / Project / Today UI。

## 5. Phase 1：总结与 Today

### 状态

`DONE`

### 目标

- 把 AI 结果真正放进主工作流，让用户在项目页、活动页和 Today 页直接消费。

### 范围

- Activity Page 新增 `AI 总结卡`。
- Project Overview 新增 `AI 项目概览卡`。
- 新增 workspace 级 `/today` 页面与顶栏入口。

### 实施前计划

- Activity Summary 展示：`本次概览`、`关键结论`、`未决问题 / 风险`、`下一步建议`。
- Project Brief 展示：`当前状态`、`最近变化`、`关键决策`、`阻塞`、`建议下一步`。
- Today 展示：`今日概览`、`优先做的 3 件事`、`等待 / 阻塞项`、`建议跟进行动`。
- 所有卡片统一支持：加载态、空态、错误态、刷新动作、来源引用跳转。
- 概览内容默认只读，不引入人工正文编辑。
- 具体实施顺序：
  - 先抽一层通用 `AiArtifactCard`，统一查询、自动懒生成、手动刷新、错误态与 citation 跳转
  - 再接入 `Activity Page` 与 `Project Overview`
  - 最后补 `/today` 路由、顶栏入口与 workspace 级 daily brief 展示
  - 同步把 `ai-artifact` 查询失效接入现有 mutation / 文档操作链路
  - 为 Note 补稳定 DOM anchor，保证 citation 能回跳到记录

### 接口 / 数据变更

- React Router 新增 `/today`。
- 顶栏新增 Today 固定入口。
- React Query 新增 artifact 查询键与刷新逻辑。

### 测试点

- Activity / Project / Today 页面在 summary 能力可用时能自动触发懒生成。
- 数据变化后页面能重新拿到 stale artifact 并刷新。
- 引用跳转能落到对应项目、活动、结论、Todo、文件上下文。

### 当前现状

- 已落地通用 `AiArtifactCard`，统一处理 artifact 查询、首屏懒生成、手动刷新、`fresh / stale / error` 展示与 citation 跳转。
- `Activity Page` 已接入 `activity_summary` AI 总结卡。
- `Project Overview` 已接入 `project_brief` AI 概览卡。
- 已新增 workspace 级 `/today` 页面与顶栏 Today 入口，展示 `daily_brief`。
- 已把 `ai-artifact` 查询失效接入现有 mutation / 文件导入链路，数据更新后页面能重新拿到 stale 状态。
- 已为 Note 补稳定 DOM anchor，citation 现在可回跳到 Note / Conclusion / Todo / Document 等对象。
- 前端验证已通过：
  - `npm run test:unit`
  - `npm run build`

### 风险 / 阻塞

- Today 的优先级规则一期只能基于现有 Todo 字段，推荐质量会受限。
- Note citation 目前能回跳到对应记录位置，但不会自动展开“其他记录”里的折叠预览；如果后续用户反馈需要更强的定位体验，可以再补自动展开。

### 下一阶段准备

- 进入 Phase 2，确定 `Ask` 的固定返回格式、scope 隔离策略、词法检索链路与 citation 结构。

## 6. Phase 2：Ask 问答

### 状态

`DONE`

### 目标

- 支持基于本地数据库内容进行单轮问答，并返回可跳转的引用。

### 范围

- 新增 `ai_answer_question`。
- 新增 Ask 面板。
- scope 支持 `workspace / project / activity`。

### 实施前计划

- Ask 入口固定为顶栏全局入口，打开 workspace 级单轮 Ask 面板，不做聊天历史。
- 面板挂在 `WorkspaceLayout` 层，默认 scope 自动跟随当前页面：
  - Activity 页默认 `activity`
  - Project 页默认 `project`
  - Today / 其他 workspace 入口默认 `workspace`
- 手动 scope 切换只允许当前页面可达的上层 scope：
  - Activity：`activity / project / workspace`
  - Project：`project / workspace`
  - Workspace：`workspace`
- Ask 复用 `assistant` 能力绑定；若未配置则展示受控空态与设置入口，不触发请求。
- 后端新增 `ai_answer_question` 与 ask skill spec registry entry，返回：
  - `answerMarkdown`
  - `citations[]`
  - `scope`
  - `generatedAt`
  - `skillKey`
  - `skillVersion`
- 问答检索统一走应用层原始对象聚合，不把 `activity_summary / project_brief / daily_brief` 作为 Phase 2 主上下文。
- 检索先构造候选 source 列表，再做词法打分和类型权重排序，最后将 top candidates 渲染为模型上下文。
- `activity` scope 允许直读该活动全部 notes 正文；`project / workspace` 只带有限 note 片段，不做全量 note 正文检索。
- 若命中不足或模型返回 citation 为空，则返回保守“依据不足”结果，不输出无引用答案。

### 当前现状

- Phase 1 已完成，Phase 2 已落地顶栏全局 `Ask` 入口与 workspace layout 级单轮 Ask 面板。
- 后端已新增 `ai_answer_question`、Ask skill spec、`AiAnswerScope / AiAnswerQuestionInput / AiAnswerCitationRecord / AiAnswerResult`，并复用 `assistant` 能力绑定。
- Ask 检索已按 `activity -> project -> workspace` 三种 scope 落地应用层原始对象聚合与词法排序：
  - `activity` 直读该活动全部 notes / conclusions / todos / documents
  - `project` 读取项目 summary、recent activities、project conclusions、open todos、project documents，以及最近活动中的有限 note 片段
  - `workspace` 读取未归档项目、recent activities、project-level conclusions、open todos、starred documents，不做全量 note 正文检索
- Ask 结果当前保持只读即时生成，不入库、不保留历史；模型返回的 citation 会被后端过滤为当前 scope 内真实对象，若无有效引用则降级为保守“依据不足”结果。
- 前端已支持：
  - 顶栏固定 `Ask` 按钮
  - scope 自动跟随当前路由并限制可切换范围
  - `assistant` 未配置时受控空态与“打开 AI 设置”
  - Markdown 回答展示与原始对象 citation 跳转
- 已完成验证：
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - `cargo test --manifest-path src-tauri/Cargo.toml ai_answer -- --nocapture`
  - `npm run test:unit`
  - `npm run build`

### 风险 / 阻塞

- 中文问句当前仍依赖轻量词法匹配与短语命中，复杂语义问答、跨对象归纳和模糊别名命中率会受限；这正是 Phase 3 需要优先补强的部分。
- workspace / project 级别目前只接入有限 note 片段与文件元数据，尚未接入文本文件正文，也未覆盖 `pdf / docx / OCR`。
- Ask 结果不持久化，适合当前单轮面板，但如果后续要支持自动复盘、周报沉淀或跨天追问，还需要单独设计“问答历史是否入库”的边界。

### 下一阶段准备

- 进入 Phase 3，优先补齐：
  - project / workspace 级 note 正文检索增强
  - `txt / md` 文本文件正文读取与问答检索接入
  - 更稳定的中文分词 / phrase match / per-source chunking 策略
  - 继续保持 `artifact / ask` 双链路都兼容未来标准化 Skill package 的装载方式

## 7. Phase 3：检索增强

### 状态

`PLANNED`

### 目标

- 提高问答命中率，补齐 Note 正文与文本文件的检索能力。

### 范围

- 将 Note 正文纳入问答检索链路。
- 支持 `txt / md` 的正文接入。
- 暂不处理 `pdf / docx / 图片 OCR`。

### 当前现状

- 未开始。

## 8. 决策记录

- `2026-04-08`：AI 一期到三期全部采用数据库优先，不做 Markdown 导出。
- `2026-04-08`：首阶段同时交付 `Activity Summary + Project Brief + Today`。
- `2026-04-08`：生成策略采用 `懒生成 + 手动刷新`，不做每次保存即强制生成。
- `2026-04-08`：AI 概览正文先保持只读，不提供人工直接编辑。
- `2026-04-08`：问答先做单轮，不做会话历史。
- `2026-04-08`：Phase 0 起就按可兼容标准化 Skill package 的方式实现 artifact generator，先内置 registry，不做一次性硬编码 prompt。
- `2026-04-08`：Phase 2 的 Ask 采用顶栏全局入口 + layout 级单轮面板，默认跟随当前路由 scope，并坚持 `raw objects first + citation required + evidence insufficient => conservative fallback`。

## 9. 开源参考与借鉴

### 参考项目

- [Karpathy `llm-wiki` 方案](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  - 核心价值：提出 `raw sources -> wiki -> schema` 三层结构，以及 `ingest / query / lint` 工作流。
  - 适合借鉴：持续编译知识层、答案可回写、周期性 lint、`index.md / log.md` 的运行观。
  - 不直接照搬：它天然以 Markdown wiki 为主，而 Project Mind 当前更适合以数据库中的结构化对象为主。
- [`lucasastorian/llmwiki`](https://github.com/lucasastorian/llmwiki)
  - 价值：这是目前较完整的开源实现，架构为 `Next.js + FastAPI + Supabase + MCP`，并给 Claude 暴露了 `guide / search / read / write / delete` 工具。
  - 适合借鉴：viewer / processor / retrieval / citations 分层，以及“上传资料 -> 编译 wiki”的完整链路。
  - 不直接照搬：它是云端知识库产品架构，不是本地优先桌面应用；而且它把 `write / delete` 权限直接交给 LLM，不适合我们当前结构化数据的风险边界。
- [`tobi/qmd`](https://github.com/tobi/qmd)
  - 价值：本地混合检索引擎，定位就是 `docs / knowledge bases / meeting notes` 的 all-local 搜索。
  - 适合借鉴：Phase 3 之后如果需要更强检索，可以参考它的 `hybrid BM25 / vector / rerank` 思路。
  - 当前结论：不作为 Phase 0 / 1 依赖，只作为后续检索增强候选。
- [`khoj-ai/khoj`](https://github.com/khoj-ai/khoj)
  - 价值：把“第二大脑、资料问答、agent、自动化、定时摘要”做成了完整产品。
  - 适合借鉴：`automations / newsletters / smart notifications` 这条线，对 `Today` 和定时摘要很有启发。
  - 不直接照搬：产品面过宽，不适合作为我们 v1 的范围；我们先做围绕 `Project / Activity / Todo` 的窄工作流。
- [`reorproject/reor`](https://github.com/reorproject/reor)
  - 价值：本地 AI PKM 工具，强调“每条 note 都被 chunk / embed，自动发现 related notes，Q&A 走 RAG”。
  - 适合借鉴：自动相关内容、语义连接、问答与知识发现的结合方式。
  - 不直接照搬：它是典型的 `markdown + vector database` 主导模式，而我们当前数据主体是结构化业务对象。
- [`AppFlowy-IO/AppFlowy`](https://github.com/AppFlowy-IO/AppFlowy) 与 [AppFlowy AI 文档](https://docs.appflowy.io/docs/appflowy/product/appflowy-x-openai)
  - 价值：证明“本地优先 workspace + AI inside objects”是可行方向，并明确支持会议记录总结、生成 next steps、本地模型。
  - 适合借鉴：AI 直接嵌入文档 / 项目对象，而不是单独做个聊天浮层。
  - 不直接照搬：它的 workspace、数据库、协作面更大，我们不需要把产品扩成通用 Notion 替代品。
- [`toeverything/AFFiNE`](https://github.com/toeverything/AFFiNE)
  - 价值：强调 `planning + sorting + creating` 的一体化知识工作台，以及 local-first / privacy-first。
  - 适合借鉴：知识库不是纯文档库，而是和计划、组织、图谱、AI 一起组成工作界面。
  - 不直接照搬：白板 / 文档 / block editor 的复杂度太高，不适合当前版本引入。

### 许可证边界

- `AppFlowy`、`Khoj`、`Reor` 为 `AGPL-3.0`；`lucasastorian/llmwiki` 为 `Apache-2.0`；`qmd` 与 `AFFiNE` repo 页面显示为 `MIT`。
- 当前结论：这些项目主要作为产品与架构参考，不计划直接拷贝其实现代码到仓库中。

### 对当前路线的影响

- 确认保留 `数据库优先 + artifact 层` 的主方向，不切换到 Markdown-first。
- 确认 Phase 1 只做 `总结 / 项目概览 / Today`，不引入 agent 写库或 delete 能力。
- 确认 `Today` 后续可以向 `scheduled digest / smart notification` 演进，但一期先做页面能力。
- 确认问答先走 `结构化上下文 + 词法检索`，向量检索推迟到 Phase 3 再评估。
- 确认后续如果要增强检索，应优先做 `Note 正文` 和 `txt / md` 文本接入，再考虑 `pdf / docx / OCR`。

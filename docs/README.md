# ProjectMind 文档索引

更新时间：2026-09-28

本目录只保留三类文档：当前基线、仍有效的决策、历史归档。正在推进但尚未完成的事项统一记录在[未完成事项](remaining-work.md)，不再分散维护多个执行计划。

## 当前基线

- [产品基线](product-prd.md)
- [体验与信息架构](alpha-ux.md)
- [系统设计](system-design.md)
- [设计系统](design-system.md)
- [缓存与页面驻留](cache-strategy.md)
- [Beta 发布](beta-release.md)

## 当前决策与工程约定

- [领域语言](../CONTEXT.md)
- [架构决策](adr/)
- [Voice Record 产品决策](requirements/voice-record-decisions.md)
- [Agent 工作约定](agents/)

## 当前待办

- [未完成事项](remaining-work.md)：唯一的仓库内待办总表；GitHub Issues 是正式跟踪器。

## AI 能力实施规格与参考

- [LLM Wiki 渐进式披露专项调研](technical/llm-wiki-progressive-disclosure-research.md)：原始模式与qmd源码核对，区分设计借鉴与实际集成。

- [AI 工作上下文主规格](requirements/ai-work-context-spec.md)：从用户目标到知识维护、渐进读取、成果操作与接入；Overview独立于QuickNote，尚未实现。
- [AI 工程契约](requirements/ai-work-context-engineering-spec.md)：按模块查数据、接口、版本与故障处理。
- [AI 交付计划与验收](requirements/ai-work-context-delivery.md)：对应 [父Issue #97](https://github.com/xuchen-cloud/project_mind/issues/97) 的19个工作包和A01～A72验收，执行状态以Issues为准。

- [AI 能力方向讨论稿](technical/ai-capability-direction.md)：早期讨论，实施范围与默认行为以开发规格为准。
- [AI 能力参考调研](technical/ai-capability-reference-research.md)：为讨论稿提供参考，不代表产品承诺。

## 历史资料

- [archive/](archive/)：已经完成、被替代或只用于追溯的方案、交接材料、验证记录和原型。

历史资料不代表当前行为，也不能作为继续实施的任务清单。需要恢复其中的想法时，应先在 GitHub 创建或更新 Issue，并同步到 `remaining-work.md`。

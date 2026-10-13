# ProjectMind 文档索引

更新时间：2026-10-08

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

## 文件能力选型参考

- [GenOffice、Univer SDK 与 DSH 插件集成调研](technical/office-integration-candidate-research-20261013.md)：核对应用内 Office 预览、基础编辑、原格式回存与主项目接缝；源码评估不代表格式能力已交付。
- [Univer / GenOffice 实际验证](technical/univer-office-validation-20261013.md)：三格式样本往返、Chrome/WebKit 编辑与保存限制；GenOffice 无水印 PPT 探针与同样本 Word/Excel 对比。
- [Markdown 选型与验证](technical/markdown-integration-candidate-research-20261013.md)：复用 GFM 预览、源码编辑方案、源字节和资源保留边界。
- [PDF 选型与验证](technical/pdf-integration-candidate-research-20261013.md)：预览、批注/表单、原文修改分别评价；GenOffice PDFium 候选与实际限制。

## AI 能力实施规格与参考

- [LLM Wiki 渐进式披露专项调研](technical/llm-wiki-progressive-disclosure-research.md)：原始模式与qmd源码核对，区分设计借鉴与实际集成。

- [AI 工作上下文主规格](requirements/ai-work-context-spec.md)：从用户目标到知识维护、渐进读取、成果操作与接入；Overview独立于QuickNote，实施中，完整工作流尚未交付。
- [AI 工程契约](requirements/ai-work-context-engineering-spec.md)：按模块查数据、接口、版本与故障处理。
- [AI 交付计划与验收](requirements/ai-work-context-delivery.md)：19个Issue、A01～A72验收；包含2026-10-08代码审查快照、交付阻塞和R01～R16执行拆分，实际关闭状态以Issues为准。

- [AI 能力方向讨论稿](technical/ai-capability-direction.md)：早期讨论，实施范围与默认行为以开发规格为准。
- [AI 能力参考调研](technical/ai-capability-reference-research.md)：为讨论稿提供参考，不代表产品承诺。

## 历史资料

- [archive/](archive/)：已经完成、被替代或只用于追溯的方案、交接材料、验证记录和原型。

历史资料不代表当前行为，也不能作为继续实施的任务清单。需要恢复其中的想法时，应先在 GitHub 创建或更新 Issue，并同步到 `remaining-work.md`。

# 仓库待办总表：AI 段整理前快照

日期：2026-10-10。保留当时待办及路线；当前入口见[统一规格](../ai-work-context-spec.md)与[交付总览](../ai-work-context-delivery.md#current-delivery)。

---

## AI 工作上下文：实施中

- [父 Issue #97](https://github.com/xuchen-cloud/project_mind/issues/97) 是完整 PRD 和开发工单入口；[开发规格](../../requirements/ai-work-context-spec.md) 说明产品行为；[工程契约](../../requirements/ai-work-context-engineering-spec.md)集中数据/接口/故障规则，[交付验收](../../requirements/ai-work-context-delivery.md)集中工单定义与验收。Overview独立于QuickNote，不建设首页“继续工作”卡片。
- 首期包含AI维护的Project Overview、每日/隔日增量整理、会话摘要检索及消息引用、按问题渐进读取、Pi 内置会话、带来源问答、Record块修改与版本恢复、项目File版本化修改、成果保存、CLI/MCP；后续为 Workspace分层Overview与长期记忆、多 Agent/菜单和无界面运行。
- 当前 AI 子任务为 18 个（#98～#116，去除 #115），原编号保留。首期验收为 #107；#113 Record 版本、#114 File 版本化修改及 #116 任务确认/撤销继续属于 AI。HTML 子包 #115 已迁入独立文件需求 #118，不再阻塞 AI。
- 2026-10-09 已对照规格、工程契约与 R01～R16 核对当前实现：主要服务已接通，真实模型与目标平台仍待验。近期按交付计划补确认体验、本地调度、成段摘要和会话模型选择，再完成 R13 的 AI/E16 验收；后续 R14～16 保留。历史 R01 开工顺序不是当前待办。
- [项目文件预览与编辑集成](../../requirements/project-file-integration.md)及[独立需求 #118](https://github.com/xuchen-cloud/project_mind/issues/118)负责 HTML、Markdown、Word、Excel、PPT 的项目内编辑预览与开源组件集成，当前为独立规划。AI 继续生成/修改支持的文件并复用保存、版本与撤销，不因拆分删除已有能力。
- [方向讨论稿](../../technical/ai-capability-direction.md) 和 [参考调研](../../technical/ai-capability-reference-research.md) 保留思路来源；默认沉淀行为以开发规格为准：过程自动保存、成果自主保存并可撤销，Overview随助手启用后定期增量维护。

# AI 历史规划与需求输入

归档：2026-10-10。本目录保留当时原文、编号、Issue 状态与执行证据，**不作为当前实施入口**。后来的明确用户决定已在[统一主规格](../ai-work-context-spec.md)、[工程契约](../ai-work-context-engineering-spec.md)和[生命周期细则](../workspace-memory-lifecycle.md)中归并；交付覆盖统一在 [V1～V5](../ai-work-context-delivery.md#current-delivery)，实际通过与缺口在[验收台账](../ai-work-context-acceptance.md)。

| 历史材料 | 保留内容与阅读用途 |
| --- | --- |
| [主规格整理前快照](ai-work-context-spec-history-20261010.md) | 原产品章节、旧 M0～M4 与逐轮追加的建模决定 |
| [交付历史](ai-work-context-delivery-history-20261010.md) | 旧 M/R/WP/S/LM 路线、估算、审视和带日期的提交/测试记录；当前导航保留旧锚点 |
| [记忆细则整理前快照](workspace-memory-lifecycle-history-20261010.md) | 原 LM1～LM5 和本轮逐次补充；ML01～ML22 已保留在当前细则 |
| [验收整理前快照](ai-work-context-acceptance-history-20261010.md) | 历史进展说明、A01～A76 和测试次数的原始解释 |
| [待办总表原 AI 段](remaining-work-ai-history-20261010.md) | 旧首期/后续划分及 R 路线，当前总表只指向统一规格 |
| [旧技术入口声明](technical-memory-entry-history-20261010.md) | 长期记忆说明中原 LM 执行入口；原 S7 正文留在技术基线 |
| [用户提供的 PRD v0.1](workspace-memory-behavior-prd-v0.1.md) | 完整原始草案；入口表解释迁移、行为审批、即时沉淀等已改变的取舍 |
| [领域证据归档](../../technical/ai-domain-evidence-history-20261010.md) | 从 CONTEXT 移出的 22 段实现与验证说明；领域词条只保留概念 |
| [GitHub 工单快照](github-ai-issues-20261010/snapshot.json) | #97、#98、#100～114（不含 #115）、#116，共 18 个工单的原题、正文、状态、标签和读取到的评论；各编号另有可读 Markdown |

## 原始 PRD 与当前要求

原草案编号是历史输入，不能与当前 ML 场景并列成为另一个需求包。M-01 当前为统一 Skill 的记忆/整理两节；M-04 扩展为明确记忆请求和明确决定即时增量；M-07 不做旧 AI 数据迁移；M-09 要有完整精简快照和总预算；M-13 改为有权限直接修改并告知。其余按当前主规格与细则核对。新增的整理冲突恢复和下游合并核对见 ML20～ML22。

## 现有工单的处理

父需求 #97 保留为导航，统一产品规格通过 `/to-spec` 发布为 [#121](https://github.com/xuchen-cloud/project_mind/issues/121)。旧子工单保留编号和开放状态，正文收敛为历史范围、现行覆盖及快照链接；移除旧 `ready-for-agent` 标签，避免继续执行旧批次。当前规格使用 `ready-for-agent`；后续实施工单和原生依赖图另走 `/to-tickets`，本次不生成、不替代，也不自动关闭任何历史工单。

#110/#111 外部 Harness/任务菜单与 #112 闭应用 Host 暂缓，不计当前范围。#115/#118 文件预览编辑以及 #119 AI Proxy 是独立需求，本次不改。原有评论、指派、原生依赖和 sub-issue 关系不因归档自动删改。

早期[方向讨论稿](../../technical/ai-capability-direction.md)已标为历史参考；[Overview 技术记录](../../technical/ai-overview-implementation.md)、[长期记忆基线](../../technical/long-term-memory-implementation.md)、[会话记忆技术记录](../../conversation-memory.md)和[旧实现指南](../../ai-enhancement-guide.html)均明确历史定位，当前要求统一回到 #121/V1～V5。

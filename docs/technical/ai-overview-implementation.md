# AI Overview 实施记录

需求：[主规格](../requirements/ai-work-context-spec.md)、[工程契约](../requirements/ai-work-context-engineering-spec.md)、[交付包](../requirements/ai-work-context-delivery.md)。Issue 状态以 [#101](https://github.com/xuchen-cloud/project_mind/issues/101) 为准；以下为内部阶段证据，不表示整个 Issue 已交付。

## P5a：Project Overview 持久版本与选择性读取（2026-10-03）

独立的 agent_overviews、agent_overview_versions、agent_overview_dependencies 和纠正表通过 savepoint 惰性准备。正式 Schema 仍为 28，本阶段不称为已发布 Schema 29。QuickNote、Record 和会话权威存储不复用为 Overview；Workspace Overview 留待 M2。

发布在同一个既有 operation receipt 事务中检查 head CAS、目标日志水位、设置修订和独立纠正修订，再写不可变版本、current pointer、来源依赖、证据和日志。按条目 upsert/remove，未修改条目保持 ID、正文和时间；同 scope/targetSeq/policyRevision/correctionRevision 的批次不能用不同内容重复发布。同请求回放稳定结果。共享服务只返回 scope/revision/asOfSeq 回执，不返回旧正文，避免重试成为来源排除后的读取旁路。通知在释放数据库锁后发出。

发布引用必须匹配本调用方在当前 Workspace generation 中通过真实共享 source 读取得到的 CapturedEvidence；该 token 不可反序列化，不能由模型指定摘录或定位来伪造。六类来源复用既有读取服务；File 直接沿用一次提取的 byte verification，在锁外核验实际字节，事务内只做授权、版本计划与短 stat 复核。新引用在提交事务内再次核对。recorded 条目必须能沿有界条目依赖到达原始来源，模型不能自授 user_confirmed；正式会话来源仍未接入。

读取以 context.read 授权派生内容。共享服务内部复用 source 校验器时保持原 Workspace/Project grant，不为调用方开放 source 工具。默认只返回章节目录；显式 sections/itemIds 后逐条按 Unicode 预算读取，默认 4000、硬限 8000 个序列化字符，包括引用、状态和游标。游标绑定 scope、版本、选择及可见性，正文过长可在条目内续读。目录不读取 File 正文；选择的 File 和依赖在锁外核验，每个对象/版本复用一次 proof，再做最终数据库检查。来源修改显示 stale；排除、删除或撤权隐藏派生条目及其依赖条目，当前版和历史版都执行，不改写原历史证据。

用户纠正只允许可信 GUI 以 settings 权限写入，独立 CAS、稳定收据、原文、删除标记和历史修订均保留。当前内部限制为每 scope 最多 100 个纠正 ID、每条 2000 Unicode 字符。模型不能覆盖纠正；旧 Overview 不会覆盖新纠正。读取比较实际设置/纠正修订，未消费新修订的当前条目标 stale，历史读取也展示最新纠正修订。将明确用户纠正晋升为带 provenance 的 user_confirmed 条目，以及用户管理界面，仍须后续接入。

内部存储预算为每 Project 最多 100 条、正文合计 8000 Unicode 字符，每条来源和条目依赖各最多 20；悬空/循环依赖和无原始依据的 recorded 链拒绝。目录、正文和版本页均有界。source_manifest_hash、coverage、modelProfileId 当前由可信内部维护调用提供；本包尚不证明增量消费完整性，不把调用者提供的 processed 数或 asOfSeq 作为整项目已理解的证据。持久 pending、增量输入和最小 context.get 入口接入为下一包 P5b。

没有注册新的 GUI/CLI/MCP/Pi adapter、模型 worker 或公开 capability；runtimeAvailable、source 与 File 发布门槛保持原状态。未发真实 Provider 请求、启动窗口或执行平台实包验收。

验证：Rust 全目标 470 passed、23 ignored；固定资源真实 source worker 显式专项 8 passed。随后对 context.read 授权、recorded 依赖链和纠正失效的小范围修改分别执行共享服务 6 passed、Overview 16 passed（1 ignored）及纠正专项 1 passed。复用未受影响的前端 141 文件 / 966 tests 与构建结果，不重复全量运行。主 agent 完成 Standards / Spec 自查；本包不满足整个 #101 的增量维护、知识节点和产品接入验收。

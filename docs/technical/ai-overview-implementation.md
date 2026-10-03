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

## P5b：持久 pending 与真实最小入口（2026-10-03）

关联 #101，复用 P5a / #100 来源 registry；本包不调用模型、不启动后台调度。pending 在首次 Overview/context 读取准备后以 SQLite trigger 跟业务 outbox 同事务合并，随后跨重开持续捕获。首次准备前的历史仅从真实 registry 引入最新对象与 tombstone，无法证明存量完整，因此持久 needs_rebuild 保持 true；没有清除该标志的伪完成入口。保持现有惰性表准备，不因此把普通打开改成全量索引初始化。

同对象保留 firstSeq、最新 lastSeq/operation/revision 与真实删除/排除状态；Overview 自己的 metadata 日志不循环入队。pending 不随变更日志裁剪，读取固定 targetSeq、按对象键分页（1–200），计数包含 target 后事件。发布显式 settledObjectKeys，只在同一个版本/回执/outbox 事务内确认 lastSeq≤targetSeq 的对应对象；失败保留旧版和 pending，晚到事件不被删除。实际剩余数量覆盖 snapshot 的 pendingCount/coverage.pending。消费事件不等于已读完该对象，也不等于项目覆盖完整。

已有 GUI context.get 接入真实 Overview L0：身份独立于 QuickNote；只显示可见 Profile 的最多 300 字符定位、更新时间、覆盖与失效状态。来源授权/归属/排除和依赖隐藏都使用真实元数据，不提取原文或读 File 字节；没有节点时不虚构节点。完整响应默认 2000、硬限 3000 个序列化 Unicode 字符。Workspace、归档 Project、无 Overview 保留有限身份入口。

新增 GUI agent_overview_get 和 typed agentApi.overviewGet，复用共享 service 的真实授权和选择性读取；context.overview.get 的 implemented=true 仅说明这个已实现读取服务与 GUI 适配器，不代表 CLI/MCP/Pi transport、模型维护或助手 UI 已开放。目录与分页都返回 pendingCount/needsRebuild，当前状态不伪装 ready。source/File capability、runtimeAvailable 与普通 worker 分发门槛保持原状态。

验证：Overview 专项 27 passed / 1 ignored，L0 专项 5 passed，Rust 全目标 481 passed / 23 ignored；前端 API 8 passed，TypeScript 类型检查通过。复用 P5a 的固定 source worker 8 passed 和未受影响的前端全量/构建结果。主 agent 完成 Standards / Spec 自查；P5c 知识节点、真实完整 inventory、模型调度与用户界面仍待接入，#101 保持 OPEN。

## P5c：知识节点、统一读取与检索（2026-10-03）

关联 #101 / A51–55、A66–72 的确定性知识层。topic、decision、source_summary 保存在独立 SQLite 版本中；current pointer 和 FTS5 trigram 仅为派生指针/索引。节点 upsert/remove 与 Overview 的版本、CAS、稳定收据、pending 确认在同一个事务内发布；失败整体回滚，未选中节点不重写。节点不能自授 user_confirmed，recorded 必须有本次真实 source 读取捕获的依据；单源摘要只允许一个实际来源对象。related/supports/contradicts 保留目标节点版本与一句原因，仅作导航，不能代替原始依据。

统一只读 registry 使用 node:<真实节点 ID>、overview:<真实条目 ID>。Overview 条目直接读原 Overview 版本，不复制正文或创建新 authority。正式会话节点尚无注册接缝，未造假 ID。GUI knowledge.get/search 与 typed API 已连接共享服务；L0 最多 8 张可解析卡片，响应预算不足时少返回并标 hasMore。

knowledge.get 默认 summary，总响应默认 1200 Unicode 字符；content 默认 4000、硬限 8000，含来源、状态、导航与游标。outline 只读目录，content 可选 section，按 Unicode 分页；related 最多 5 张卡片、不递归正文。返回实际 epistemicStatus、validState、coverage 与版本；当前和历史版都核对来源访问。来源排除/删除隐藏整个节点与相关导航的标题、摘要和原因；来源变化及更新的用户纠正/策略使旧节点 stale。File 字节核验在锁外，返回前重新核对绑定、head 和来源；没有为读取重复提取 File。

knowledge.search 支持标题/别名/关键词，trigram 与 1–2 字 literal LIKE 回退，fixture 包含中文及别名。默认 8 张、最多 50 张，snippet≤240，整个响应≤3000；单次最多扫描 200 个节点候选，再检索既有最多 100 条 Overview。所有标题先过来源授权，扫描预算耗尽也保留游标，不能因一页无可见结果而声称全库无资料。两个 authority 的结果在同一数据库锁内组合；游标绑定查询、scope 和 Overview revision。无匹配时返回 sourceFallbackRequired=true；实际 source.search 适配器仍未开放，本包不自动越过其发布门槛，因此“真实原文回退已接通”仍未验收。

修复了本包实际触发的分页问题：最后一页移除游标后，序列化大小不再单调。Overview/knowledge pager 先尝试完整剩余正文，再对 partial 页二分预算，避免短完整内容能装下却被游标误判超限。不放宽字符预算，也不在返回后截断正文而丢失游标对应关系。

存储内部限制：每次最多 20 个节点变更，批次文本最多 48000 字符；每节点正文合计最多 8000，最多 20 章节/来源，aliases/keywords 各最多 20。读取所需不可省略的引用元数据不能装入请求预算时明确 BudgetExceeded，不静默删证据。sourceCoverage 仍为可信维护输入，初始 manifest 未证明完整时 needs_rebuild 保持 true，不将节点存在或 pending 为零当作完整理解。

验证：节点存储 7 个真实 SQLite 用例通过；知识服务 3 passed、registry 3 passed、受影响 Overview 31 passed / 1 ignored、L0 6 passed；收口 Rust 全目标 495 passed / 23 ignored。前端 API 12 passed，TypeScript 类型检查通过；不重跑未变化的 worker staging、前端全量或平台验收。主 agent Standards / Spec 自查完成。#101 仍有实际原文回退、完整 inventory、纠正管理及真实维护消费等门槛，保持 OPEN。

## P5d：有界真实存量目录（2026-10-03）

关联 #101 的初始化输入与 A54/A60。复用原 source queue backfill 的六类 catalogue SQL，抽成共享 metadata 查询；索引仍排除不可索引对象，Overview inventory 则保留排除对象的实际状态。子任务继续属于 Todo，managed_note_image 不登记为独立 File，QuickNote 不变为 Record。没有虚构会话来源、File 历史 hash 或模型覆盖率。

每批 1–200 个实际对象，cursor、pending 登记、稳定回执和 metadata outbox 同事务提交。零历史日志的旧数据库也先分配一条真实 inventory metadata 日志水位，不伪造业务变更序号；缺少事件登记的对象标为 inventory:unprocessed，这不是 SourceRef semantic hash。已有 pending 的更新、排除和 tombstone 优先，目录只 INSERT OR IGNORE，不覆盖晚到状态。

遍历跨重开恢复；同 request 重放原结果，不推进下一页。首次准备后的永久 pending trigger 接住已过游标前新建的对象与删除，日志裁剪不清空该集合，因此完成当前六类目录遍历后可把 needs_rebuild 清零。directoryComplete 只证明目录与后续变更捕获闭环，不证明正文已读、知识覆盖完整或任务 ready；pending 通常仍非零，context 仍按实际知识状态返回。此过程不读 File 字节、不跑 worker、不建索引 job、不调用模型，也不创建正文副本。

共享服务通过当前 Workspace generation 与 knowledge.write 授权，释放锁后发通知；尚无生产助手初始化/定时调度调用，后续由 #102 真实 Host 接入。按用户确认，本阶段仅推进云端实现，真实 Provider 与 macOS/Windows 实包验收继续保留未完成。

验证范围预先限定为新增 inventory 与共享目录受影响的 source_queue：inventory 8 passed；source_queue 10 passed / 1 ignored，再显式运行这 1 个固定 Node 真实进程集成用例，1 passed。复用 P5c 未受影响的 Rust/前端/构建结果，不因纯 metadata 查询与新内部服务重复全量验证。主 agent Standards / Spec 自查完成；没有把目录完成当成模型维护、完整正文覆盖或 Issue 交付。

# GitHub 历史 Code Review 意见复核

> 本文保留审计基线的发现与原始计数。修复进度、最终验收和当前状态见 [统一执行记录](../implementation/performance-review-fixes-20261027.md)；相邻 probes 脚本现断言修复后的预期行为。

日期：2026-10-27。仓库：`xuchen-cloud/project_mind`。本次直连 GitHub 成功，已 fetch；本地 `develop` 与远端 `origin/develop` 均为 `5de9a91692136d378fd4595716109bf7c25e4d22`，ahead/behind 为 0/0。

结论：历史 **13 条具体意见中，10 条仍需修改，2 条已修复，1 条因旧功能移除而失效**。原始优先级中仍有效的为 2 条 P1、8 条 P2。性能审计中的语音回放发现与其中一条重合，不应重复建两份实现任务。

## 范围、方法与交付

- 关联：读取全部历史 PR 和开放 Issues；不创建或关闭 Issue，不发表评论或解决线程，不修改产品源码。
- 范围：124 个 PR（编号范围 #10–#272）、12 次正式 review、13 条行内评论/线程、83 条 PR 普通评论。GraphQL 的 PR 分页全部完成；reviews/comments/threads 及线程内评论无遗漏分页，REST 行内评论数量交叉核对一致。
- 普通评论包括 73 条自动 review 汇总、9 条额度不足提示、1 条本地合并验证说明。正式 review 正文是对应行内意见的汇总模板，没有另加重复问题。
- 所有 13 条行内意见均来自自动 reviewer；没有把机器人结论直接当事实，逐条追踪当前实现及后续提交。
- 验收：为每条意见保留原文链接、当前结论、代码证据、修改方向和验证要求。当前实现与原评论的文件名不同，仍按行为追踪。
- 验证：5 组隔离复现、8 项当前 UI 测试；复用此前相同基线的语音审计证据。本次不运行应用、不请求真实模型生成、不启动 review 子 agent。

## 逐条结论

| 原 PR / 意见 | 原级别 | 当前判断 | 当前影响 |
| --- | --- | --- | --- |
| [#235：Session 列表 null 默认值](https://github.com/xuchen-cloud/project_mind/pull/235#discussion_r4366610279) | P1 | **仍需修改** | CLI/MCP 省略分页参数或只设置 `limit:0` 会被拒绝 |
| [#189：首次快照前保留身份确认](https://github.com/xuchen-cloud/project_mind/pull/189#discussion_r4284992949) | P1 | **仍需修改** | version 0 文件被同路径替换后可能直接登记为 v1，丢失原身份与替换的区别 |
| [#231：新增音频块保留回放状态](https://github.com/xuchen-cloud/project_mind/pull/231#discussion_r4366338815) | P2 | **仍需修改；与性能审计合并** | 播放中新增块会停止播放、归零并重新加载全部历史 |
| [#205：模型输出预算保留上下文比例](https://github.com/xuchen-cloud/project_mind/pull/205#discussion_r4350199980) | P2 | **仍需修改** | 官方目录 `gpt-4` 的 capacity 结果被原生 Overview 校验拒绝 |
| [#193：移动失败测试不依赖 Unix 权限](https://github.com/xuchen-cloud/project_mind/pull/193#discussion_r4285186532) | P2 | **仍需修改，测试层问题** | root/CAP_DAC_OVERRIDE 环境下 0555 目录不保证 rename 失败 |
| [#186：剪贴板导入也校验临时文件名](https://github.com/xuchen-cloud/project_mind/pull/186#discussion_r4284815369) | P2 | **仍需修改** | 文件可以成功导入但立即被列表/目录过滤隐藏 |
| [#181：不要重试结果不明的分叉](https://github.com/xuchen-cloud/project_mind/pull/181#discussion_r4284581103) | P2 | **仍需修改** | 已持久化但丢失响应时，点重试可能再次创建子会话 |
| [#177：仅高亮 ready 文件身份](https://github.com/xuchen-cloud/project_mind/pull/177#discussion_r4284382765) | P2 | **仍需修改** | ambiguous 路径仍被作为已确认活动文件展示 |
| [#171：版本选择失败向菜单传播](https://github.com/xuchen-cloud/project_mind/pull/171#discussion_r4283806986) | P2 | **仍需修改** | 编辑器保存失败后，菜单仍认为切换成功并关闭 |
| [#11：取消项目列表后恢复查询](https://github.com/xuchen-cloud/project_mind/pull/11#discussion_r3676361900) | P2 | **仍需修改，问题随重构迁移** | 新 Todo 模块仍可能取消首次项目查询并留下空侧栏 |
| [#258：隔离不可解密的旧模型](https://github.com/xuchen-cloud/project_mind/pull/258#discussion_r4371204798) | P2 | **已修复** | 后续代码跳过不可读取的未选备选模型，不阻塞已修复默认模型 |
| [#166：跨可见性切换缓存打开应用](https://github.com/xuchen-cloud/project_mind/pull/166#discussion_r4283639645) | P2 | **已修复** | 当前 Query 缓存保留应用列表，同文件类型复用并合并请求 |
| [#11：Workspace Todo 纳入旧 AI 来源](https://github.com/xuchen-cloud/project_mind/pull/11#discussion_r3676361893) | P1 | **旧问题已失效** | 原 daily brief/ask collectors 已移除；现有 Todo 读取包含 Workspace 条件 |

## 仍需修改的依据与验收

### R01 / #235：Rust Option 的 null 与 JavaScript 默认值不一致

当前 [RecordListInput](../../src-tauri/src/agent/record_list.rs) 的 `limit`、`budget_chars` 是 Option，没有 `skip_serializing_if`；[dsh_assistant.rs](../../src-tauri/src/dsh_assistant.rs) 的 `cli_session_inventory` 约 4624 行直接通过 `json!` 传递输入。[session-inventory.mjs](../../packages/dsh-assistant/scripts/session-inventory.mjs) 约 22 行的解构默认值只处理 undefined，随后整数检查拒绝 null。

真实函数复现：`{limit:null,budgetChars:null}`、`{limit:0,budgetChars:null}`、`{limit:null,budgetChars:4000}` 均返回 `INVALID_ARGUMENT`；显式 `{limit:0,budgetChars:4000}` 成功。这是现有 Node 单测和跨端 DTO 测试之间的缺口。

修改：边界使用 nullish 默认值或在原生序列化时省略空字段，保留 `limit:0`。验收必须从 Rust 默认输入到 Node adapter 覆盖两端，不能只测手写 JS 的 undefined。

### R02 / #189：有业务记录不代表已有不可变版本

[project_directory_files.rs](../../src-tauri/src/db/project_directory_files.rs) 的 `directory_refresh` 约 834 行和 `directory_publish_locked` 约 607 行，仅以 `storage_mode == project_directory` 绕过已记录物理身份变化检查，没有要求已存在有效版本/hash。已有 `directory_file_budgets_preserve_identity_without_faking_initial_versions` 测试证明超预算文件可以停留在 version 0、hash None。

触发：初次登记未成功冻结内容；同一路径被原子替换为可登记的小文件；后续刷新可能将替换内容直接作为原 File 的 v1。正常已冻结版本允许编辑器原子替换，与从未冻结过版本的身份确认应分开处理。

修改：只有确实存在可信不可变 head 时放行相应替换；version 0/缺失快照仍需确认。验收组合：首次失败→替换→刷新、同一物理文件恢复到预算内、已有 v1 的正常原子保存、显式确认 replacement。该项本次为代码路径核验，没有新增执行 Rust 端到端复现。可关联现有 [#185](https://github.com/xuchen-cloud/project_mind/issues/185)/[#114](https://github.com/xuchen-cloud/project_mind/issues/114) 的版本与首快照范围，再明确具体工作包。

### R03 / #231：回放状态和重复解码是同一处问题

[VoiceRecordPanel.tsx](../../src/components/voice/VoiceRecordPanel.tsx) 约 213–237 行 effect 依赖 `chunks`，重建 `VoicePlayer` 并 `setPlaying(false)`、`setPositionMs(0)`，cleanup 销毁旧播放器。

不仅重新读/解码历史音频，也会在用户回听旧音频时中断播放和重置位置。与[首轮性能审计](performance-audit-20261026.md)“语音回放新增分块触发全部历史解码”合并整改。

验收：录制继续时新增两块，原播放/暂停状态、位置、速度保留；新增数据只加载增量。重录/切换 Session 时仍必须隔离旧音频。已有 60 次更新触发 3,660 次读取/解码的计数证据不重复运行。

### R04 / #205：真实目录模型触发跨端预算冲突

[model-utility.mjs](../../packages/dsh-assistant/scripts/model-utility.mjs) 约 54 行只取 `min(4096,maxTokens)`；[overview_model.rs](../../src-tauri/src/overview_model.rs) 约 214 行还要求 `outputTokens <= contextWindow/4`。

本次通过真实 `runModelUtility(operation:capacity)` 和已安装目录读取 `gpt-4`，得到 contextWindow=8192、maxTokens=8192、outputTokens=4096、inputBytes=3072；原生允许的输出上限为 2048。没有调用模型生成，也不是虚构的容量示例。

修改：统一 capacity 与生成预算，并保留输入 reserve 和原生校验。验收覆盖 8K、小输出上限、大上下文以及自定义端点的保守 fallback；真实跨端 response 应能通过原生解析。

### R05 / #193：失败夹具依赖运行身份

[project_directory_files_tests.rs](../../src-tauri/src/db/project_directory_files_tests.rs) 约 20–35 行仍使用 chmod 0555 后断言移动失败。以 root/CAP_DAC_OVERRIDE 运行时不构成可靠失败条件。当前 macOS 普通用户测试成功不能证明容器中稳定；本次没有提权运行或声称已重新复现 root 环境。

修改：用确定的文件系统失败场景或受控失败注入触发同一条提交失败路径。验收仍须证明不重试移动、不应用元数据、不留下 pending intent，并在普通用户和容器身份下通过。

### R06 / #186：导入入口没有共享文件名规则

[file_imports.rs](../../src-tauri/src/db/file_imports.rs) 普通文件导入约 602 行检查临时名字；剪贴板入口约 616 行只调用 `sanitize_import_file_name`、解码/预算检查，然后调用 shared commit。`file_import_commit_inner` 没有等价的临时名拒绝；[db.rs](../../src-tauri/src/db.rs) 约 7937 行 sanitize 只替换非法路径字符，不会拒绝 `capture.tmp`、`~$capture.png`、`Desktop.ini`。

修改：在适当的共享导入边界统一规则，保持托管笔记图片等其他业务入口的语义。验收以上名字被明确拒绝，普通剪贴板图片仍可导入；失败不产生落盘文件、Document 或版本残留。该项本次为代码路径核验。

### R07 / #181：分叉“失败”不等于服务端没创建

[ProjectSidebarSessions.tsx](../../src/components/home/ProjectSidebarSessions.tsx) 约 105–117 行只有在 `manageProjectSession` 返回 ID 后才设置 `forked`；异常处理对 `forked == null` 提供原 `manage` 重试。原生 [dsh_assistant.rs](../../src-tauri/src/dsh_assistant.rs) 约 1065 行发送 `session/fork`，request 只有 parent sessionId，没有稳定子 ID/幂等键；RPC ID 只用于响应匹配。

实际 UI manage 函数配合“持久化后响应丢失”的 transport 替身：第一次失败后点击 retry，后端 fork 调用次数为 2。它证明 UI 重放命令，不冒充真实 DSH 丢包创建两个孩子的端到端实验。

修改：分叉创建建立稳定幂等身份/回查能力；已知子会话只重试打开，结果不明时先 reconcile。不能给所有非幂等写操作套通用重试。

验收：丢响应、超时、创建后挂载失败、仅打开失败、成功返回后取消等情形，都不能创建额外子会话；原会话与创建结果可找回。

### R08 / #177：文件树高亮没有读取 resolve 状态

[useFocusedProjectContent.ts](../../src/components/home/useFocusedProjectContent.ts) 约 34 行仍在 File active 时直接返回 `resolved.data?.relativePath`，没有检查 `state === ready`。

修改：仅在身份已确认时产生树中的 activeRelativePath。验收 ready 高亮、ambiguous/unavailable 不高亮，确认恢复后再次高亮；不改变 Record/Session 活动定位。这是 UI 身份表达问题，不表示仅靠高亮就能绕过后端权限。

### R09 / #171：保存错误被吞掉，版本菜单收到成功

旧 `officeFlush` 已重构成 `editorFlush`，行为仍在：[ProjectFileContent.tsx](../../src/components/document/ProjectFileContent.tsx) 约 311–314 行 catch 只 `setError`，不 reject。[FileVersionMenu.tsx](../../src/components/document/FileVersionMenu.tsx) 约 101 行在 `await onSelect` 正常返回后关闭菜单。

直接执行当前 `choose` 函数、让 flush 拒绝：页面错误更新，但 promise 正常 resolve。当前路径覆盖 Office/Markdown 共用 editor flush，不仅原评论的 Office 名称。

修改：更新页面错误后仍向调用方抛出，交由菜单展示失败且保持打开。验收保存失败保留旧版本、草稿、菜单和可重试状态；成功切换才关闭菜单。

### R10 / #11：旧 hook 删除后，同一查询取消问题仍存在

原 `src/hooks/useTodoMutations.ts` 在重构中删除，但 [todo-cache.ts](../../src/todo/todo-cache.ts) 约 194 行仍无条件取消 `projects.all`；[todo-module.ts](../../src/todo/todo-module.ts) `create` 约 349–363 行调用 cancel，成功后只替换 Todo 缓存，不恢复项目列表。Workspace Todo 的 projectId 为 null，项目数量缓存更新也直接跳过。

真实 Todo module/cache 加真实 TanStack Query 实验：项目列表首次请求未完成时创建 Workspace Todo；创建成功、旧请求随后返回后，项目列表数据仍 undefined、fetchStatus=idle、查询次数仍为 1。当前业务变更同步针对 Workspace Todo 也不失效 projects.all，因此不能依赖它必然修复这次取消。

修改：Workspace Todo 不取消无关项目查询，或对必要取消提供有责任归属的恢复；保留乐观更新和真实冲突处理。验收使用尚未完成的首次项目请求，并覆盖成功与失败恢复，不能只预填项目缓存再测 Todo 创建。

## 已修复与已失效项目

### #258：已修复，但 GitHub 线程仍显示未解决

[提交 12d09c4](https://github.com/xuchen-cloud/project_mind/commit/12d09c4)（PR #265）在 `Configuration::configured_profiles` 中对 `SecretsLocked` 跳过未选备选模型；默认模型先单独成功 resolve，其他真实错误继续返回。当前 [dsh_assistant.rs](../../src-tauri/src/dsh_assistant.rs) 约 331–340 行保留该逻辑。符合原意见，不需要再次修改相同逻辑。本次为代码/提交核对，未重跑迁移实机验证。

### #166：已修复，并有当前测试支持

[提交 05b253d](https://github.com/xuchen-cloud/project_mind/commit/05b253d)（PR #177）加入 [useFileApplications.ts](../../src/hooks/useFileApplications.ts)；`FileOpenWithButton` 当前用共享查询，5 分钟 staleTime、30 分钟 gcTime，隐藏不再清空查询结果。测试覆盖请求进行中隐藏、随后显示同扩展名另一个文件仍只枚举一次，8/8 通过。

这解决原意见中的反复可见性切换重复枚举。它不意味着所有原生枚举都有真正取消，也不保证无限时间的操作系统应用关联变化无需刷新；这两点不是本次原意见重新成立的证据。

### #11 Workspace AI collectors：旧路径移除，不按当前缺陷保留

[提交 f0a6e1e](https://github.com/xuchen-cloud/project_mind/commit/f0a6e1e)（PR #64）移除了旧 `workspace_open_todo_sources/workspace_open_todo_ask_sources`。当前源码已无这两个 collector；[agent_todo_list.rs](../../src-tauri/src/db/agent_todo_list.rs) 约 190 行明确允许 Workspace scope 且 project_id IS NULL 的 Todo。

因此不再修改已删除 SQL。此判断仅消除原历史问题，不把当前所有 Overview/问答产品行为都宣称已完成端到端验收。

## 为什么历史意见会留下

GitHub 元数据中，13 条评论的 `created_at` **全部晚于各自 PR 的 mergedAt**，相差约 1–5 分钟。原始讨论线程本次获取时全部 `isResolved=false`，也包括已经在后续提交修复的 #258 和 #166；因此未解决状态与当前代码缺陷并不一一对应。

例子：[#235](https://github.com/xuchen-cloud/project_mind/pull/235) 于 2026-10-24 08:54:53 UTC 合并，意见于 08:59:18 UTC 发布；[#258](https://github.com/xuchen-cloud/project_mind/pull/258) 于 2026-10-25 14:38:22 UTC 合并，意见于 14:39:46 UTC 发布。仓库现行发布流程以本地验证/双轴 review 为门禁且立即合并，异步 GitHub review 的后到意见需要另外分诊。

建议保持现有发布规则，补一个明确的历史意见收口动作：有效意见关联工作包；修复后链接验证和提交，再处理线程状态。不要仅因 GitHub bot 还没结束就擅自增加外部门禁，本次也没有更改发布流程或代用户回复机器人。

另有 4 条汇总仍显示 Running（[#270](https://github.com/xuchen-cloud/project_mind/pull/270#issuecomment-6416630510)、[#238](https://github.com/xuchen-cloud/project_mind/pull/238#issuecomment-6398545431)、[#209](https://github.com/xuchen-cloud/project_mind/pull/209#issuecomment-6344998395)、[#188](https://github.com/xuchen-cloud/project_mind/pull/188#issuecomment-6196791103)），9 个较早 PR 只有额度不足提示。它们不能算“审查通过”，但也不能凭状态虚构待修改代码意见。

## 整改组织建议

1. **先修数据边界与常用入口**：R02 首快照身份、R01 Session 默认参数；R07 分叉幂等紧随其后。
2. **与性能工作合并**：R03 保留播放状态与增量音频加载同包，避免重复整改。
3. **小包修正交互和跨端契约**：R04 模型预算、R09 版本菜单错误、R10 Todo 查询取消、R06 剪贴板名字、R08 高亮状态。
4. **验证可靠性**：R05 改失败夹具，恢复后不再依赖运行用户是否有覆盖权限。
5. #258/#166 只需后续关联修复记录；旧 collectors 意见记录为已失效。未在 GitHub 上做任何状态变更。

原始 reviewer 的 P2 不妨碍把 R03 纳入已有 P1 性能包；表中保留原级别，执行顺序按当前影响安排。

## 本次验证与可复跑材料

[github-review-probes-20261027.mjs](github-review-probes-20261027.mjs) 包含五组复现：

```sh
node docs/technical/github-review-probes-20261027.mjs
node node_modules/vitest/vitest.mjs run src/components/document/FileOpenWithButton.test.tsx --maxWorkers=1
```

- 5 组缺陷行为断言通过；其中 UI callback 使用当前源函数及隔离依赖，Todo 使用当前模块/缓存和真实 QueryClient，模型 capacity 使用已安装真实目录。
- FileOpenWithButton：1 个测试文件、8 个用例通过。无新增 Rust 测试执行，未提权，未启动应用。
- 诊断脚本断言的是当前缺陷表现，不是修复后的验收测试；修复时应改为期望行为并进入相应正式测试套件。
- 本次材料初版引用了环境未安装的 esbuild，未能运行；已移除该依赖，使用现有 TypeScript 转译器和受限依赖替身，最终复现成功。没有安装新依赖或更改产品配置。
- 前面的性能报告曾记录 fetch 失败；本轮已成功恢复直连并确认仍为同一提交，因此其代码基线无需变更。

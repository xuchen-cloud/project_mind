# DSH 单个常驻后端：实施 Handover

更新：2026-10-25。关联 [Issue #250](https://github.com/xuchen-cloud/project_mind/issues/250)。

**交接时状态：用户已确认方向，尚未实施运行时重构。本次仅完成现有改动提交、应用重启与交接。**

当前实施与验证见[共享后端交付记录](dsh-shared-runtime-delivery.md)。下文保留重构开始前的基线、源码入口与原验收要求，不代表当前仍按范围启动物理后端。

## 1. 用户决定与交付目标

用户确认：Project Mind 采用 DSH Desktop 的方式，由一个常驻 Harness 后端进程管理多个 DSH workspace。不要再为主应用 Workspace 和每个 Project 分别启动 Node 后端。

- 一个后端管理当前主应用工作区及其各项目对应的 DSH workspace，分别保留工作目录、会话与原生权限。
- 项目切换、内容 Tab、分栏、设置面板的打开关闭，不启动另一套后端，也不终止其他项目正在执行的任务。
- 同一后端支持多条会话、不同项目并行；停止一个会话只停止它自身。
- “单个进程”指常驻 Harness 后端。主应用进程、窗口进程以及工具执行产生的 shell / Worker 子进程不在此限制内。
- 当前主应用只打开一个工作区。切换、关闭、锁定工作区必须失效旧绑定、请求与凭据；不要扩展为多个主应用工作区同时解锁运行。
- 后端启动/就绪检查由原生生命周期统一管理；业务页面不重复实现启动流程。应用退出需要回收后端。

用户要求当前项目重启，并提交代码及 handover，在一个新的会话完成这项重构；**不要把这次交接当成重构已完成，也不要自动新建会话。**

### 已核实的上游依据

我们锁定的上游信息在 [upstream.json](../../packages/dsh-assistant/upstream.json)：`dataelement/dsh-desktop`，commit `115a0b474cc2c4794316171c640a8898398591fe`，Desktop `0.1.1`，Harness `0.2.0-rc.2`。

- [上游架构](https://github.com/dataelement/dsh-desktop/blob/115a0b474cc2c4794316171c640a8898398591fe/docs/architecture.md)：Electron 主进程启动一个隔离的 Harness 后端。
- [上游主入口](https://github.com/dataelement/dsh-desktop/blob/115a0b474cc2c4794316171c640a8898398591fe/src/main/index.ts#L3259)：应用创建一个 `HarnessRuntime`。
- [上游运行时](https://github.com/dataelement/dsh-desktop/blob/115a0b474cc2c4794316171c640a8898398591fe/src/main/runtime/harness-runtime.ts#L409)：持有一个后端 child。
- 本地 `@deepseek-ai/dsh-workspace` 提供同一个服务中的多 Workspace registry，记录稳定 ID、真实目录、会话归属；不同 Workspace 不要求独立 Node 进程。

这里只确认了拓扑与基础能力；不能据此认定我们现有的单范围 CLI、工具和权限适配已能直接共用。

### 与旧规格的关系

[内容 Tab 规格](project-content-tabs.md)与[旧内容 Tab handover](project-content-tabs-handover.md)曾写明 Project 独立运行时。用户本次决定替代其中“每项目一个物理后端进程”的实现要求；A27 的跨项目并行、输入输出隔离、返回停止和历史恢复仍然必须满足。实施时同步这些规格、DSH README 与相应工程说明，避免保留两套相互冲突的现行描述。

## 2. 接收基线与当前改动

交接分支：`codex/workspace-navigation-polish`。本轮开始基线：`94a71ba0`（合并 PR #247）。本次交接后的准确提交以 `git log -3 --oneline` 为准；新会话先读取工作树与提交，不要直接 reset 或覆盖。

已提交的实现：`b59dce9`（#248 导航与记录打开）、`3158fa9`（#249 定时任务读取优化）。交接文档随后单独提交。

已完成但由用户人工验收的工作：

- [#248](https://github.com/xuchen-cloud/project_mind/issues/248)：工作区 Record 复用项目内容样式；顶栏工作区仅图标、固定首位；侧栏上项目、下会话/记录/文件 Tab，默认会话；首个项目 Tab 左下曲线修复；侧栏 Record 点击改为真正打开共享内容 Tab，保留筛选条件。
- [#249](https://github.com/xuchen-cloud/project_mind/issues/249)：定时任务列表不再在前端先等待 `start()`；任务先显示，会话列表随后补齐；重新进入使用缓存并后台刷新；任务写入取消旧查询，避免旧列表覆盖保存结果。任务原生接口目前仍需要运行时就绪，因此冷启动等待没有被完全消除。
- 当前没有实现 #250。不要将 #248/#249 的 UI/缓存改动误删为“旧运行时代码”。
- 用户要求开发后刷新，由其人工界面验收。#248、#249 仍开放；没有自动合并、关闭或发布。后续依会话中的人工反馈和仓库发布门禁收口。
- 未跟踪文件 `docs/technical/.ai-capability-direction.md.swp` 是已有文件，不属于本次提交，必须保留。

## 3. 当前代码为何是一范围一进程

| 入口 | 现状与重构关注点 |
| --- | --- |
| [dsh_assistant.rs](../../src-tauri/src/dsh_assistant.rs) | `ScopedRuntimes.scopes: HashMap<Option<i64>, RuntimeState>`；`None` 为 Workspace，每个 Project ID 一个 `RuntimeState.process`。`Identity`/`Configuration` 把进程绑定到单个范围与目录。`ensure_ready` 比较身份并按需启动/替换。 |
| [dsh_cli.rs](../../src-tauri/src/dsh_cli.rs) | `launch` 按单个 Identity 创建 `EmbeddedCli`、discovery、授权控制和 source handler；CLI lease 验证 Session 属于该目录。不能仅合并 process 字段而沿用此单范围授权。 |
| [runtime.mjs](../../packages/dsh-assistant/scripts/runtime.mjs) | 首帧 configure 读取一个 `context`；启动时 `process.chdir(context.directory)`；安装 CLI、source、office、schedule 服务时捕获这个 context。共享进程必须消除请求对全局 cwd 和单 context 的依赖。 |
| [project-workspace.mjs](../../packages/dsh-assistant/scripts/project-workspace.mjs) | `readContext` 恰好允许一个 Project 或 Workspace；`bindContext` 创建一个 DSH workspace，并包装 session/controller 方法限制为该范围。需要转为原生可信范围到 DSH workspace/Session 的映射与请求级检查。 |
| [mind-cli.mjs](../../packages/dsh-assistant/scripts/mind-cli.mjs) | 单个 context/connection/projectId；shell 环境注入真实 `PROJECT_MIND_SESSION_ID`、scope flag、短期 lease token。共享运行时必须按实际 Session 分配，不能泄漏另一项目凭据。 |
| [source-bridge.mjs](../../packages/dsh-assistant/scripts/source-bridge.mjs)、[dsh_office.rs](../../src-tauri/src/dsh_office.rs)及 source handler | 已有跨 stdin/stdout 原生服务；授权/归属很多在进程 Identity 中。请求与延迟响应必须带可信的会话/作用域关联。 |
| [dsh_schedules.rs](../../src-tauri/src/dsh_schedules.rs)、[scheduled-tasks.mjs](../../packages/dsh-assistant/scripts/scheduled-tasks.mjs) | 后台恢复 Workspace runtime；任务绑定 Workspace Session，使用持久消息/请求身份防重复。共享化不能改变此语义。 |
| [dshAssistantApi.ts](../../src/services/dshAssistantApi.ts) | 目前按 projectId 排队与合并并发 start；注释明确 native 拥有各范围 runtime。调整为共享生命周期时仍需保留各调用目标与取消隔离。 |
| [agent-panel-store.ts](../../src/state/agent-panel-store.ts)、[ProjectSessionContent.tsx](../../src/components/agent/ProjectSessionContent.tsx) | UI 仍按主应用 Workspace/Project/Session 显示与恢复，不能因为共享后端退回全局“当前会话”。 |
| [ScheduledTasksPanel.tsx](../../src/components/settings/ScheduledTasksPanel.tsx)、[queryKeys.ts](../../src/lib/queryKeys.ts) | 保留 #249 独立查询、缓存、原有 agent 范围清理及失败恢复。读 API 自己负责就绪；不要恢复页面的额外启动等待。 |

特别注意：`sessions.list` 当前会顺序读取冷会话的 projections 补齐标题。共享后端后，不应使一个项目的列表打开扫描所有其他项目会话。先按真实目标缩小读取范围，再考虑正确的并发；不要用跨范围缓存掩盖路由问题。

## 4. 历史数据迁移是必交付项

目前原生 `runtime_data_directory` 为不同范围分配独立 DSH_HOME：

```text
<assistant-data-root>/projects/<native-workspace-id>/workspace/
<assistant-data-root>/projects/<native-workspace-id>/<project-id>/
```

这里是已有会话与归档/置顶状态、workspace registry、定时任务文件等的真实存储，不能简单让所有进程改用同一个目录然后抛弃旧数据。

实施前检查固定版本真实存储格式和导入能力，再选择迁移方案。至少要求：

1. 原生 Workspace ID / Project ID 到 DSH workspace ID 的稳定映射；路径改名不导致会话重建或错误归属。
2. 保存既有 Session ID、对话、会话模型选择、归档/置顶状态及 UI 内容 Tab 恢复。不同旧目录若存在冲突 ID，必须明确检测并安全处理，不能静默覆盖。
3. 保留任务 ID、绑定 Session、nextRunAt、lastRunAt、pending 消息身份和 requestId 回执，恢复后不重复投递。
4. 迁移可在中断后识别、继续或恢复；旧数据保留可恢复副本，失败不能被标记为成功。
5. 不复制明文模型密钥或运行时认证 token 到持久数据；沿用原生解锁和内存凭据边界。

不要为了启动单进程的演示而先切断老历史；“新会话能聊”不足以验收迁移。

## 5. 建议实施顺序与必要约束

先读仓库 AGENTS、CONTEXT、[ADR-0003](../adr/0003-persist-only-committed-editor-content.md)、[ADR-0009](../adr/0009-bind-agent-operations-to-workspace-and-atomic-receipts.md)、DSH 接入规格及 Issue #250。按工作包实现，复用有效验证。

1. **确定共享宿主及请求契约。** 区分后端进程身份（原生 Workspace 稳定 ID、打开代次、模型/凭据配置）和请求范围（Workspace 或具体 Project、Session）。配置帧不再把整个进程授予某一 Project。保持一处启动并发合并与实际重启入口。
2. **迁移与多范围 registry。** 先实现可验证的历史迁移和可信映射，再接入真实多 workspace/Session。不要靠删除 `bindContext` 的限制直接放开所有范围。
3. **贯通原生与工具路由。** session list/create/follow/manage/delete、WebSocket/HTTP、CLI lease、文件/source/office 与异步事件都使用实际范围；前端传入的 projectId、模型生成字段或全局当前页面不构成授权。
4. **后台并发与生命周期。** 跨项目同时运行；切换页面不重启进程。主工作区关闭/锁定/切换、配置变更和应用退出时按已有授权规则失效旧请求和凭据。明确配置变化对正在运行会话的处理，不中途静默换凭据。
5. **定时任务与 UI 收口。** 继续使用 Workspace Session，保留任务重放/崩溃恢复；共享工作台布局、分栏、会话导航和任务列表缓存保持当前产品行为；更新相冲突的规格/README。

权限、归属、generation、CAS、幂等与跨 await 后的必要核验仍然保留；删掉的是多套物理宿主，不是安全边界。不要全局放开 shell cwd、Project File API 或把所有 CLI lease 提升为 Workspace 权限。

## 6. 新任务验收矩阵

| 场景 | 预期 |
| --- | --- |
| 工作区和两个项目同时打开助手 | 原生可观测到一个 Harness 后端；不因面板/Tab打开创建第二个。 |
| 两项目同时发送、切换、停止其中一个 | 两者可并行；输出、停止、文件工具与历史各自隔离；切换不终止任务。 |
| Workspace Session 访问项目；Project Session 访问其他项目 | Workspace 依既有授权访问；Project 越界被原生拒绝，不能靠共用进程绕过。 |
| 多 scope 同名文件、同数字记录 ID、伪造 Session/Project/cwd、旧异步响应 | 请求路由到真实归属，越界/过期拒绝，结果不进入新工作区/项目。 |
| 旧数据升级后重启、迁移中断 | 历史和 UI 恢复；归档/置顶与任务保留；无覆盖、无重复消息。 |
| 定时任务列表、新建、编辑、立即执行和自动触发 | 列表不等待无关会话加载；任务进入绑定 Workspace Session；失败重试与重启不重复投递。 |
| 工作区锁定/切换/关闭、凭据更新、退出 | 旧授权和凭据失效，不能继续写入新目标；后端无泄漏，恢复遵循已确认的补跑最近一次规则。 |

测试先覆盖实际的两个调用方/两个范围，不以单范围 mock 测试替代共享并发验证。涉及 configure DTO、原生事件与 Node 接口时要验证两端。

## 7. 当前有效验证与继续运行

以下是交接前 UI 与任务加载优化的验证，**不是 #250 的验证**。日志在 `/tmp`，可能不跨环境保留；文件/依赖/环境相关变更后只重跑受影响项。

| 范围 | 记录 |
| --- | --- |
| ScheduledTasksPanel、SettingsDialog、queryKeys | 20 passed，`/tmp/mind-schedules-loading-regression.log`。覆盖慢会话、慢启动调用、失败恢复、重开缓存、工作区切换、旧查询覆盖写入及原有创建/执行幂等。 |
| WorkspacePage | 20 个通过；两个旧测试需先选择新侧栏 Record Tab，调整后二者及侧栏保留筛选用例 3 passed。`/tmp/mind-workspace-record-page-regression.log` 与 `/tmp/mind-workspace-record-page-final.log`。 |
| App 工作区 Record 点击/从 Session 返回/共享分栏，缺失 Record 导航 | 3 passed，`/tmp/mind-workspace-record-open-final.log`。之前直接从 Record 深链接开页，漏测了侧栏点击；现已补实际点击链路。 |
| 顶栏与滚动条/首项目圆角 | 31 passed，`/tmp/mind-tab-corner-green.log`。 |
| Workspace Record 编辑、Header | 46 与 3 passed，`/tmp/mind-workspace-nav-record.log`、`/tmp/mind-workspace-nav-header.log`。 |
| App/Project 原回归 | 最初 145 passed/1 failed，失败为工作区按钮改为图标 Tab 后的旧 selector；已修 selector并在针对性 App 用例中通过。不是仍有已知失败。 |
| 类型/构建/规范 | 最新类型检查 `/tmp/mind-schedules-loading-tsc.log` 成功；UI standards `/tmp/mind-schedules-loading-ui-check.log` 成功；此前 Vite build 和 bundle 检查在 `/tmp/mind-workspace-nav-build.log`、`/tmp/mind-workspace-nav-bundle.log`，适用于当时导航改动，后续重构需重新建立验证依据。 |

本机 Node 如不在 PATH：

```sh
export PATH='/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':"$PATH"
```

开发使用关闭原生源码监听的模式，避免修改 Rust 时反复弹窗：

```sh
npm run dev:tauri:manual -- --config '{"build":{"beforeDevCommand":"npm run dev"}}'
```

本次重启日志：`/tmp/project-mind-shared-runtime-handover-dev.log`；Vite 地址 `http://localhost:1420/`。下一会话先检查实际进程与监听，不复制旧 PID，不重复启动。该命令仍有 Vite 热刷新；修改 Rust 后需集中手动重启，用户已允许项目重启。

编译和单元测试静默写日志，不主动打开额外窗口。用户当前选择人工 UI 验收；主 agent 自查 Standards / Spec，不擅自启动 review 子 agent。

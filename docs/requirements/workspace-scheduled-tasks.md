# 工作区会话与 Scheduled Task

日期：2026-10-24。关联 [#239](https://github.com/xuchen-cloud/project_mind/issues/239)，承接 #161 / #204 的 Workspace 会话与内置 CLI；不依赖 #112 的无界面 WorkspaceHost。

## 工作包

- 依赖：原生 Workspace 身份/generation/解锁、DSH 原始 Session 与真实模型、内置 Mind CLI 的执行 lease、现有设置与侧栏。
- 交付：工作区会话左侧中间列表；工作区级项目业务权限；CLI、会话自然语言和设置菜单共用的持久定时任务管理与执行。
- 非目标：云端或关机执行、独立系统守护进程、法定节假日与调休日历、跨 Workspace 授权、重新定义 Archive 的内容可见性、扩展现有 File/Office 直连桥。
- 验收：公开时间规则正确；保存后到点进入真实会话并启动 AI，正常重启不重复发送；工作区可访问所属项目而 Project 会话继续隔离。用户已明确确认这三个测试边界。
- 验证范围：Node 日历与真实运行时集成、原生绑定/恢复/权限/CLI、侧栏与设置行为、类型及前端构建、界面规范和 diff。Standards / Spec 由主 agent 自查；未获许可不启动 review 子 agent。

## 工作区会话

复用 #161 的 `projectId:null` 工作区运行时及历史，侧栏按“项目 / 会话 / 记录”排列。列表支持新增、选择、重命名、置顶、分叉、归档与删除；选择打开原会话。后台运行不依赖面板展开。

内置 Workspace 会话经原生 CLI 获得工作区内容及其项目身份权限，新项目自动纳入。内容读取、写入仍遵循当前业务规则，包括归档源可见性限制；恢复归档项目后即可按普通项目处理。Project 会话、项目窗口和其他 Workspace 的隔离不变。既有 Workspace 内置授权只对原生精确旧格式进行原子升级，保留身份与凭据；已撤销或人工变更的授权不会被覆盖。

## 管理入口与任务内容

三个入口操作同一份数据：

1. 设置 → 定时任务：列表查看、手动新建、编辑、暂停/启用、删除，显示原会话、时区、下次及上次执行时间和最近错误。
2. 工作区会话 → 自然语言：内置 `project-mind-cli` Skill 指导 AI 使用 `mind schedule` 创建和管理，绑定真实 `PROJECT_MIND_SESSION_ID`。
3. CLI：`mind schedule list|create|update|delete`；`mind schema schedule.create --json` 等提供输入契约，`--input-file -` 支持 stdin JSON。

新建必填名称、任务内容、工作区会话、首次日期、执行时间与重复方式。手动新建可以选择或新建一个工作区会话；创建后绑定会话保持不变。编辑与暂停不清除原会话消息；删除停止未来触发，保留历史对话。

创建/编辑由宿主读取系统本地 IANA 时区并保存，没有手动时区选项。任务按已保存时区运行；编辑时使用当时系统时区。日历规则的时间不存在时跳过该次，夏令时重复时刻只选较早的一个 UTC 时点；小时规则始终保持固定时长。

| 重复方式 | 参数与行为 |
| --- | --- |
| 每 N 小时 | 首次日期/时间作为锚点，之后按固定小时间隔。 |
| 每 N 天 | 每隔 N 个当地日历日，在指定钟表时间执行。 |
| 每周工作日 | 周一至周五执行，不包含节假日排除或补班。 |
| 每 N 周的周几 | 选择一个或多个星期；首次日期所在的周为周期起点，周一为一周开始。 |
| 每月几号 | 1–31 日；当月没有该日期时跳过该月。 |

新建或编辑任务只安排未来的下一轮，不因首次锚点已经过去而立即执行；恢复执行时只对已经保存且错过的触发补跑最近一次，避免离线积压多轮。

## 执行与授权

应用运行且对应 Workspace 打开、已解锁时执行。应用退出、工作区锁定/关闭/切换停止该运行时。原生后台恢复会检查持久任务，无需先打开助手面板；重新打开或唤醒后补跑最近一次错过的触发。

到点后原生绑定的 Node 运行时验证会话归属，通过真实 Session admission 投递带 `schedule` 来源的 user 消息，并沿用原模型与会话权限执行。消息先持久确认，再记录本轮完成；待确认消息保留同一身份，恢复时核对真实会话避免正常重启重复发送。上次触发时间只证明消息投递，AI 是否完成应查看原会话。

CLI 读取需要 `schedule.read`，修改需要 `schedule.manage`。内置 Workspace 会话具备这两项权限，Project 会话不具备。外部连接只有在明确授予整个 Workspace、全部项目及“管理定时任务”后才获得权限，因为任务将委托具有工作区权限的 AI 执行。read-only lease 禁止任何任务修改；锁定、撤销及 generation 切换仍在原生核验。

CLI mutation 沿用稳定 `requestId`；原始 payload 的请求回执与任务一起持久保存。同一 ID/内容可安全重试，变更内容时不可复用 ID。定时任务不产生 Record/Todo 的 Operation Receipt；创建后用 `schedule.list` 核对实际保存与下次触发。

## 验证记录

本次验证覆盖 #239 最终源码，未改动的 Office / Record / Source 构建资源复用本会话此前已成功准备的结果。

| 范围 | 结果 |
| --- | --- |
| 时间与持久状态 | Node 调度规则/严格输入边界 7 用例通过，覆盖 N 天、N 周锚点、工作日、月末跳月、DST、固定小时和损坏状态。 |
| Node 单元 | `npm --prefix packages/dsh-assistant test`：134 通过；最终边界改动另重跑上述 7 用例。 |
| 真实会话回归 | `npm --prefix packages/dsh-assistant run test:integration`：38 通过，含真实 Node/本地 SSE 模型、到点投递、恢复补跑、正常重启去重及幂等请求。 |
| 自然语言与 CLI | 新增单项集成通过：自然语言 prompt → 模型 bash 工具 → 实际 `mind schedule create/list` → 实际 Node 任务保存。原生 HTTP transport 使用 fixture；原生权限由下述 Rust 用例独立验证，不将 fixture 当作原生授权验收。 |
| 原生桥/CLI | `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::bridge:: --quiet`：120 通过、5 个既有忽略；CLI 新增实际参数路由与稳定请求身份后，`schedule_commands` 2 用例通过。 |
| 原生会话/恢复 | `cargo test --manifest-path src-tauri/Cargo.toml --lib dsh_assistant --quiet`：40 通过、1 个既有忽略；恢复目录、任务开关/损坏文件和真实鉴权 HTTP envelope 共 3 用例通过。 |
| 原生连接授权 | `db::agent_connections::tests` 14 通过；内置 Workspace/Project 权限测试 12 通过，含精确旧授权升级、撤销、用户变更及新增项目。 |
| 界面行为 | 受影响侧栏、会话面板、设置、任务表单与状态 8 文件 / 94 用例通过；只读连接修正后外部连接面板 12 用例通过。 |
| 构建与标准 | TypeScript、Vite 生产构建、桌面与 `mind` 二进制编译、实际 CLI help/schema、UI standards、bundle boundaries、diff 检查通过。只读连接修正后重新执行前端类型与构建。 |

Standards 自查：复核当前 Workspace/generation、主窗口限制、异步启动后的 CLI lease/grant 再授权、Project 隔离、精确授权 CAS 升级、任务输入/存储边界与稳定请求重放。Spec 自查：复核五类规则、三种入口、真实会话执行、未来首次运行、持久任务恢复及权限；发现的恢复路径、过去锚点立即触发和只读连接权限问题均已修正并定向回归，无剩余本包发现。

开发进程已重启，前端 HTTP 200；本次未完成新版原生窗口的人工交互验收，不声称外部真实模型服务、Windows 或关机执行已验证。实际模型链路使用本地测试 SSE 服务。

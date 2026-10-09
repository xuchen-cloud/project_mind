# AI 工作上下文

本目录实现[工程契约](../../../docs/requirements/ai-work-context-engineering-spec.md)中的共享领域服务、权限边界与适配器。交付状态及验收条件见[执行计划](../../../docs/requirements/ai-work-context-delivery.md)。

## 当前接入路径

GUI 通过 Tauri 命令进入当前 Workspace 的共享服务。会话侧栏、Pi Host、run、来源读取、Overview/知识、Record/Todo/File 成果与收据服务已有各自的真实调用路径；每项能力仍按交付计划区分内部服务、产品接入和平台验收。`RequestContext`、`ScopeGrant` 与 Workspace generation 在服务边界验证，不从模型或外部请求直接反序列化。对象读取与写入还需按存储中的真实归属、版本和排除策略复核。

本机外部调用路径为：

```text
mind CLI
  → 应用数据目录中的 agent-bridge.json（实例、端口、协议版本）
  → OS credential store 读取连接 secret
  → 127.0.0.1 HTTP JSON bridge
  → 当前应用内的连接 grant 和 Workspace binding 校验
  → 同一 Workspace 数据库与共享领域服务
```

连接 grant 在 Workspace 数据库保存范围、操作权限与凭据摘要；明文 secret 仅由当前用户的 OS credential store 保存。bridge 仅监听本机随机端口，发现文件不存 secret。CLI 通过 `--workspace` 指定的规范路径握手取得 binding，后续调用固定该 binding；Workspace 关闭、重开或切换不会自动转到新 Workspace。每次调用重新核对 grant，撤销和停用随即生效。CLI 不另开数据库，也不自动启动模型。

## 模块职责

| 位置 | 职责 |
| --- | --- |
| `models.rs`、`errors.rs`、`access.rs` | Scope、Workspace binding、统一响应、授权与对象归属边界 |
| `repository.rs`、`service.rs`、`context.rs`、`tools.rs` | 共享读取、上下文 DTO、业务工具定义与预算 |
| `sessions.rs`、`runtime.rs`、`outputs.rs` 等 | 会话、run、来源与成果服务；实际开放范围由各适配器决定 |
| `connections.rs`、`bridge/credentials.rs` | 连接 grant DTO 与 OS 凭据存取 |
| `bridge/protocol.rs`、`bridge/transport.rs`、`bridge/dispatch.rs` | 本机协议、HTTP 边界与当前应用服务分发 |
| `bridge/client.rs`、`bridge/cli.rs`、`bridge/registry.rs`、`../bin/mind.rs` | 本机客户端、参数/JSON 输出、外部方法注册和命令入口 |
| `capabilities.rs` | 共享能力的实现状态；不等同于外部 bridge 的可调用清单 |

## 当前外部调用范围

`mind --version` 和 `mind --help` 可离线使用。`mind capabilities --json` 区分共享能力清单与 bridge 已注册方法；共享能力的 `implemented` 只表示内部服务状态。`mind schema project.list --json` 与 `mind schema context.get --json` 从请求 DTO 生成参数 schema，与 MCP 工具发现共用。

运行中的应用可通过 `mind doctor --workspace PATH --connection ID --json` 检查连接；`mind project list` 和 `mind context get` 使用相同的 Workspace/connection 参数执行真实读取。`context get` 需显式选择 `--project ID` 或 `--workspace-scope`，可指定 query 与字符预算。JSON stdout 使用统一响应 envelope，诊断写入 stderr。连接 ID 只是索引，不是 secret。

bridge 注册表当前包含 38 个方法（24 读 / 14 写）。读取包括原有上下文、来源、会话、Record 正文/Todo、File 版本与源码、Record 历史、`operation.get/list`、`file.content.status`，原生 `reference.list`，以及 `record.patch.preview`、`record.create.preview`；写入包括 `record.create/patch/restore`、`todo.create/update`、`operation.undo/restore_created` 和下文八个 File 方法中的七个写方法。历史列表、比较和收据读取均有预算/分页；Record 版本 get 返回精确 source 目标，正文沿用 `source.read`。每个存储阶段重新核验当前连接和 Workspace binding。

`mind record get ID (--project ID | --workspace-scope) [--revision HASH] [--cursor TOKEN] [--budget-chars N] --workspace PATH --connection ID --json` 读取已提交 Record 正文；也可用 `record get --input-file PATH|-` 传 `record.get` 的完整 DTO。它和 `source.read` 共享 SourceReadPage、来源修订及分页，默认 4000、最多 12000 字符；继续阅读时传回 nextCursor，可同时固定返回的 SourceRef.revision（不同于正文 bodyHash）。CLI 不自动读取下一页，只有 complete=true 才读到末尾。需要块身份与修改基线时仍用 `record blocks get`。

`mind reference list --kind record|todo|file|quick_note --id ID --direction incoming|outgoing (--project ID | --workspace-scope) [--cursor TOKEN --limit N --budget-chars N] --workspace PATH --connection ID --json` 查询当前原生入链/出链；也支持 `--input-file PATH|-`。默认 20、最多 50 项，整个响应默认 4000、最多 12000 字符。引用两端都须允许来源读取，隐藏对象不返回身份或计数；Record 附件属于出链，File 正文本身不解析引用。原生 token 与 canonical 引用边共用实际对象身份，不把知识来源依赖当作正文引用。返回空 items 但 complete=false 时仍须按 nextCursor 续查；数据或授权范围变更后旧游标返回 SOURCE_CHANGED，需重新开始。超大旧正文明确报预算错误。

新增命令接受 `--input-file PATH|-`，JSON 内容与 `schema METHOD` 相同，CLI/HTTP JSON 输入最多 2 MiB；本地路径不发给服务端。可用 `mind search QUERY --project ID ... --json` 直接搜索来源，其余复杂选择及 cursor 放在输入 JSON 中。会话工具另需 `session.read`，索引推进和原文读取的所有 DB 阶段也经过连接核验。

`mind mcp serve --workspace PATH --connection ID` 基于固定 `rmcp 3.5.1` 提供 stdio 初始化、协议协商、工具发现和调用，初始协议兼容基线为 2025-11-25。stdout 仅承载 JSON-RPC，诊断发往 stderr；连接始终使用握手时的 Workspace binding。设置可复制不含 secret 的 MCP JSON 配置，command 为检测到的 CLI 绝对路径。其他尚未注册的共享工具不会因内部服务存在就授予外部连接，其他 dry-run 仍按后续子包推进。

设置预设已接通：默认「Workspace 协作」授予 Workspace 直属内容和所有当前未归档 Project（`workspaceContent: true`、`allProjects: true`），每次认证动态纳入新 Project；「单 Project 协作」仅授予所选 Project，「只读」覆盖同样的动态范围但无写权限，「自定义」使用显式 Project 子集及可选 Workspace 内容。会话依据 `session.read` 始终单独选择；任意历史版本恢复权限只在自定义预设中可选。旧 JSON 和旧 grant 的 `allProjects` 默认为 false，原有显式范围不会自动扩张。

「自定义」可在显式范围内选择 1–50 个当前可读的 Record/File，设置中的对象选择器只列当前可见元信息。`objects: null` 或旧 grant 缺少 `objects` 时保留范围授权语义；非空列表才启用对象限制，旧连接不会自动扩权。对象限制不能与 `allProjects`、`session.read`、创建或 Todo 修改组合；范围级 `context.get`、Overview 和知识读取被拒绝。来源搜索及直接读取、Record/File 修改、引用和历史只返回或作用于被选对象，仍按真实归属、归档、来源排除与撤回状态复核；选中 Project 的名称仅作为父级元信息出现，不扩张内容读取。

## Record 写入与撤销

设置中显式选择创建、块修改、历史恢复或本连接撤销权限，已有只读连接不会自动获得写权限。原生编辑器有未确认预览或正在提交时，外部修改会明确失败；成功提交沿用不可变版本、CAS、收据和应用变更通知。

写命令仍通过 `--input-file PATH|-` 接收实际 DTO。`record.patch` 使用已有包含 `requestId` 的补丁；其他写方法使用 `{ "requestId": "稳定请求 ID", "input": { ... } }` 包含对应原生输入。`schema METHOD` 给出完整字段。CLI 和 MCP 都把该 ID 用作原生幂等身份；CLI 另传 `--request-id` 时必须一致。成功结果包含 `result` 与 `operation`，可直接取得撤销基线。同一 ID 重试不重复写入，不同内容不能复用成功请求的 ID。

`record.create` 的 `input` 接受 canonical `document` 或 `markdown`，二者只能选一。Markdown 经过原生初始化后与文档创建共用元信息、引用、资产校验和提交事务；幂等收据绑定原始 Markdown 与稳定 `requestId`，相同 ID 不能换正文。`record.create.preview` 对两种输入均要求 `content.create` grant，无需 mutation `requestId`；它返回作用域、规范化标题/标签及限长文本，不创建持久对象、版本、收据或事件。预览文本默认 4000 字符、最多 12000 字符；正式创建仍重新校验授权和输入，预览不保证提交成功。

Markdown 快捷命令为 `mind record create --title TITLE --body-file PATH|- (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json`；加 `--dry-run [--budget-chars N]` 转为 `record.create.preview`，预览时可省略 `--request-id`。正文按 UTF-8 在本地读取，最多 1 MiB，路径不传给服务端；`--input-file PATH|-` 的既有 JSON 创建入口保持可用，也可搭配 `--dry-run` 预览，完整 DTO 以 `mind schema METHOD --json` 为准。CLI/HTTP JSON 输入仍限 2 MiB。

`record.patch.preview` 对已保存的 canonical Record 计算临时补丁预览，要求同一个 `record.patch` grant，但无需 `requestId`。CLI 用 `mind record patch --patch-file PATH|- --dry-run [--budget-chars N] --workspace PATH --connection ID --json`；`--patch-file` 接收原生 RecordPatch JSON，正式提交保留其中的稳定 `requestId`，预览时可省略。既有 `record.patch` JSON 调用仍可用。预览返回 `baseRevision`、`baseBodyHash`、创建/删除/规范化计数、`noChange`、`previewText`、`fullTextChars` 和 `previewTruncated`；文本预算默认 4000 字符，最多 12000。它不初始化或刷新编辑器，不写版本、收据或事件；worker 返回后再次核对 CAS、来源及引用授权。预览不是提交保证，正式提交仍重新检查当前版本，也不新增 GUI 确认流程。

`operation.get/list` 只返回本连接的收据；修改撤销把修改前内容保存为新版本，历史恢复本身也可按收据撤销。新建撤销只撤回可见性，`operation.restore_created` 恢复同一对象。撤销不能覆盖后续人工修改，也不能作用于其他连接或内置任务的操作。CLI 命令为 `operation restore-created`，MCP 名称为 `mind_operation_restore_created`。

历史恢复可用 `mind record restore --id ID --version VERSION_ID --base-revision N (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json`。`VERSION_ID` 是历史列表返回的版本身份，不是版本序号；恢复保存为新版本，重复请求返回同一结果。它要求明确的 `record.restore` 权限，Workspace/单 Project 协作预设不自动授予该权限。完整 JSON 入口仍保留。

## Todo 写入与恢复

`todo.create` 使用原生内容、优先级、日期、标签及子行动字段；`todo.update` 使用实际 Todo 对象、`expectedRevision` 和现有 mutation 类型。所有 `dueDate` 字段都必须出现，可为日期字符串或 `null`。连接使用稳定请求 ID 幂等，CLI/MCP 与 Record 写入共用请求身份约定；内置 Run 的 dedupeKey 保持独立。原生 Todo 提交、不可变字段快照、GUI revision、子行动身份及原子收据由同一数据库服务维护，不创建虚构 Run 或成果候选。

简单文本 Todo 可用 `mind todo create --body-file PATH|- (--project ID | --workspace-scope) --request-id ID --workspace PATH --connection ID --json` 创建；可加 `--priority VALUE` 和 `--due-date YYYY-MM-DD`。不指定时优先级为 `not_urgent_not_important`、`dueDate` 为 `null`，标签和子行动为空。复杂字段仍用 `--input-file` 传完整 DTO。`mind todo update --patch-file PATH|- --workspace PATH --connection ID --json` 把现有带 `requestId` 的 wrapped mutation JSON 作为输入，和 `--input-file` 互斥。

修改撤销生成新 revision 并恢复原字段和子行动；新建撤回仅改变可见性，`operation.restore_created` 恢复原对象。目标和引用按实际范围、归档、排除及撤回状态授权，持久连接在提交边界重查；旧版 GUI 写入与连接修改通过同一 revision 检出冲突。来源历史的 GUI 权限保持原样，撤回或排除后的模型来源读取仍被拒绝。

## File 写入与上传

外部方法为 `file.create`、`file.patch`、`file.update`、`file.version.restore`、`file.content.begin/chunk/complete/status`；其中 `status` 只读。`file.update` 和历史恢复分别要求连接显式授予 `file.update`、`file.restore`，旧只读连接不自动扩权。七个写方法均以 `{ "requestId": "稳定请求 ID", "input": { ... } }` 包装实际原生 DTO；`status` 只接受阶段票据 ID。`mind schema METHOD --json` 可查看精确输入。外部请求 ID 不得以原生恢复保留前缀 `fileundo:`、`filechainundo:`、`creationundo:` 开头；普通 ID 及 `output:` 前缀可用。

创建、精确文本补丁、完整替换和历史恢复共用原生 CAS、File Version、journal、恢复及操作收据，成功重放使用相同请求 ID，不构造内置 Run。上传阶段只处理字节和原生票据，不让服务端读取客户端路径；`file.content.complete` 校验长度/hash 并使票据可提交，本身不创建新版本。版本响应不向外部连接暴露 GUI 使用的绝对 `versionPath`。文件最大 100 MiB，每块最大 1 MiB，阶段票据有效期 10 分钟；base64 块仍受 2 MiB 的 HTTP/CLI JSON 输入上限约束。

`mind file upload --input-file target.json --body-file PATH --request-id ID --workspace PATH --connection ID --json` 在 CLI 本地读入字节并执行 begin、status、chunk、complete、update。`target.json` 使用 `{ "object": { ... }, "expectedVersionNumber": 1, "expectedContentHash": "sha256:…" }`，绑定真实 File 对象及预期版本/hash；`--body-file` 支持路径或 `-`（stdin）。相同 ID 重试会使用稳定的阶段 ID，从已接收字节续传；若最后一个短块已收到，可直接继续 complete。阶段过期时只尝试原始最终 `file.update` 收据：已提交可返回同一结果，未提交则明确失败。CLI 不把本地路径传给服务端。

文本 File 可用 `mind file create --name NAME --body-file PATH|- --project ID --request-id ID --workspace PATH --connection ID --json` 创建；复杂创建仍用 `--input-file` 提供完整 DTO。`mind file patch --patch-file PATH|- --workspace PATH --connection ID --json` 接受既有带 `requestId` 的 wrapped mutation JSON，与 `--input-file` 互斥。Todo/File 创建的 `--body-file` 在 CLI 本地按 UTF-8 读取，保留字符与换行，路径不会传到服务端；正文和生成的请求 JSON 均受 2 MiB 上限约束。二进制或较大 File 继续使用上述字节上传流程。

完整替换也可直接使用 `mind file update --id ID --source-file PATH|- --project ID --expected-version N --expected-hash HASH --request-id ID --workspace PATH --connection ID --json`。版本与 `sha256:…` hash 从 File 版本读取取得，Workspace 身份由连接握手补齐；文件在 CLI 本地读取，复用同一 100 MiB 分段上传、续传和收据流程。便捷参数与 `--input-file` 互斥，旧 JSON/`file upload` 入口保持可用。

## 桌面安装包中的 CLI

正式构建使用 `npm run build:tauri -- --target <Rust target triple>`；两个发布 workflow 使用相同的 `src-tauri/tauri.release.conf.json`。release 钩子在既有后端资源准备之后执行 `prepare:cli`，按同一 target 构建 `mind` 并交由 Tauri externalBin 打包。独立暂存命令为 `npm run prepare:cli -- <Rust target triple>`。开发/测试基础配置不要求发行用 sidecar，`npm run tauri build` 的基础配置不包含该 CLI；发行必须采用上述 release 入口。

CLI 在应用可执行文件同目录检测，设置复制其绝对路径及 MCP 配置。设置另提供显式的用户级终端命令安装、更新和卸载，事先显示命令及将修改的 PATH 配置位置。Unix 安装 `~/.local/bin/mind` 链接；bash 修改 Linux 的 `.bashrc` 或 macOS 的 `.bash_profile`，zsh 使用 `ZDOTDIR` 下的 `.zshrc`，fish 写专用 `conf.d` 文件。Windows 复制到应用数据目录的 `cli/mind.exe`，调整当前用户的 `HKCU\Environment\Path` 并通知环境变更。已有 PATH 项不重复添加；未知 shell 不猜测启动文件，而显示手动配置提示。安装收据限定应用可更新或卸载的命令及受管 PATH 内容，发现同名外来命令或被改写的受管配置会报冲突并保留用户修改。卸载不要求原打包 CLI 仍存在。Linux 已验证暂存和 Tauri 构建脚本的 sidecar 复制；macOS/Windows 最终签名、安装落位和干净安装仍须目标平台验收。

## 不应绕过的边界

- QuickNote 是用户缓冲区；AI Overview 与知识、会话记忆、Record 成果分别保存在各自的数据模型中。
- GUI grant、Pi run grant 与外部连接 grant 来源不同，不能把一个适配器的授权转给另一个适配器。
- Workspace 内容权限不隐式授权所有 Project。外部调用按连接保存的显式 Project 集合或独立 `allProjects` 动态范围及操作集过滤，不能相信请求参数自报的归属。
- `capabilities.implemented` 不代表 CLI/MCP 可用。外部方法以 `bridge/registry.rs` 与服务端分发的实际注册为准。
- Agent Host 不进入 Vite 依赖图；目标平台与真实模型验收状态以交付计划为准。

## 验收

当前工作包和平台验收结果见[执行计划](../../../docs/requirements/ai-work-context-delivery.md)。本阶段已通过 CLI 安装、对象授权、搜索/引用过滤及前端定向验证；生产 CLI 与真实 Linux 系统凭据链路也已通过指定对象读写/撤销/重放验证。具体数量与命令范围见执行计划；macOS/Windows 原生实包与真实模型仍未验证。

MCP SDK 依据：[Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)、[rmcp 3.5.1](https://docs.rs/rmcp/3.5.1/rmcp/)、[MCP 2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)。工具参数来自与 CLI 相同的 Rust DTO schema；连接授权仍由应用服务执行，工具提示本身不授予权限。

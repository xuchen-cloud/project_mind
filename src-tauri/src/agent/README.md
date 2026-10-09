# AI 工作上下文

本目录实现[工程契约](../../../docs/requirements/ai-work-context-engineering-spec.md)中的共享领域服务、权限边界与适配器。交付状态及验收条件见[执行计划](../../../docs/requirements/ai-work-context-delivery.md)。

## 当前接入路径

GUI 通过 Tauri 命令进入当前 Workspace 的共享服务。会话侧栏、Pi Host、run、来源读取、Overview/知识、Record/Todo/File 成果与收据服务已有各自的真实调用路径；每项能力仍按交付计划区分内部服务、产品接入和平台验收。`RequestContext`、`ScopeGrant` 与 Workspace generation 在服务边界验证，不从模型或外部请求直接反序列化。对象读取与写入还需按存储中的真实归属、版本和排除策略复核。

R12a 的本机外部读取路径为：

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

## R12a 外部调用范围

`mind --version` 和 `mind --help` 可离线使用。`mind capabilities --json` 区分共享能力清单与 bridge 已注册方法；共享能力的 `implemented` 只表示内部服务状态。`mind schema project.list --json` 与 `mind schema context.get --json` 从请求 DTO 生成参数 schema，与 MCP 工具发现共用。

运行中的应用可通过 `mind doctor --workspace PATH --connection ID --json` 检查连接；`mind project list` 和 `mind context get` 使用相同的 Workspace/connection 参数执行真实读取。`context get` 需显式选择 `--project ID` 或 `--workspace-scope`，可指定 query 与字符预算。JSON stdout 使用统一响应 envelope，诊断写入 stderr。连接 ID 只是索引，不是 secret。

bridge 注册表当前只暴露 `project.list` 与 `context.get` 两项读取。`mind mcp serve --workspace PATH --connection ID` 基于固定 `rmcp 3.5.1` 提供 stdio 初始化、协议协商、工具发现和调用，初始协议兼容基线为 2025-11-25。stdout 仅承载 JSON-RPC，诊断发往 stderr；连接始终使用握手时的 Workspace binding。设置可复制不含 secret 的 MCP JSON 配置，command 为检测到的 CLI 绝对路径。外部写命令、完整 MCP 工具集及对象级限制留待后续子包接入；共享服务已有其他工具不意味着外部连接有权调用。

## 不应绕过的边界

- QuickNote 是用户缓冲区；AI Overview 与知识、会话记忆、Record 成果分别保存在各自的数据模型中。
- GUI grant、Pi run grant 与外部连接 grant 来源不同，不能把一个适配器的授权转给另一个适配器。
- Workspace 内容权限不隐式授权所有 Project。外部调用始终按连接保存的 Project 集合和操作集过滤，不能相信请求参数自报的归属。
- `capabilities.implemented` 不代表 CLI/MCP 可用。外部方法以 `bridge/registry.rs` 与服务端分发的实际注册为准。
- Agent Host 不进入 Vite 依赖图；目标平台与真实模型验收状态以交付计划为准。

## 验收

当前工作包和平台验收结果见[执行计划](../../../docs/requirements/ai-work-context-delivery.md)。

MCP SDK 依据：[Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)、[rmcp 3.5.1](https://docs.rs/rmcp/3.5.1/rmcp/)、[MCP 2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)。工具参数来自与 CLI 相同的 Rust DTO schema；连接授权仍由应用服务执行，工具提示本身不授予权限。

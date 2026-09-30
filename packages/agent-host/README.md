# Agent Host

独立后端 Node 包，不作为前端依赖。生产入口仍是 `mind-agent-host/v1` JSONL 协议框架，握手返回 `runtimeAvailable:false`。Pi 接入是 AI-01 的独立验证入口，不能据此宣称应用内 Agent 已可用。

## 固定版本与复现

Pi SDK 固定为 `@earendil-works/pi-coding-agent@0.99.1`，安装包 Node 候选固定为 24.21.0。`runtime-manifest.json` 记录 macOS / Windows、arm64 / x64 官方压缩包与 SHA-256；开发脚本要求 Node ≥22.19.0。SDK 依赖与锁文件独立于前端。

```sh
npm --prefix packages/agent-host ci
npm --prefix packages/agent-host run check
npm --prefix packages/agent-host test
npm --prefix packages/agent-host run test:pi
```

下载 manifest 对应的官方 Node 压缩包后，使用 `prepare:runtime -- darwin-arm64 <absolute-archive-path>` 校验并提取 Node 与许可证；`smoke:runtime -- darwin-arm64` 会将运行时复制到含空格和中文的临时目录，清空 PATH，并运行 Pi 集成 fixture。runtime、node_modules、dist 均不提交。

当前已在 macOS arm64 的固定 Node 24.21.0 下跑通本地模型协议 fixture、受限反向工具、checkpoint、取消、搬迁后恢复和实际子进程 JSONL。真实模型 Profile、完整安装包、Windows 运行、签名与分发许可证检查尚未完成，M0 仍未通过。

## 生产协议框架

```sh
npm --prefix packages/agent-host start
```

stdin/stdout 每行一个 JSON 对象；stdout 无日志。请求帧包含 `protocolVersion`、`requestId`、`method`：

```json
{"protocolVersion":"mind-agent-host/v1","requestId":"init-1","method":"initialize"}
{"protocolVersion":"mind-agent-host/v1","requestId":"stop-1","method":"shutdown"}
```

已知会话/运行方法在初始化后返回 `RUNTIME_UNAVAILABLE`。协议不匹配返回 `RUNTIME_INCOMPATIBLE`，非法帧返回 `INVALID_ARGUMENT`，超过 1 MiB 或 EOF 时未终结的帧会安全退出。

## Pi 验证入口

`npm --prefix packages/agent-host run probe` 启动独立验证进程。initialize 需要可信适配器给出的绝对 workspaceRoot；握手仍不开放生产运行能力。session.open 只接受明确映射、启用、已核实支持工具调用的 openai_compatible Profile。凭据仅经进程管道进入内存，不使用 argv、环境或工作区配置。测试只使用临时目录与本地模型协议服务器。

Pi 不加载默认 shell/file 工具，也不发现本机 AGENTS、skills、prompts、themes、extensions 或 packages。仅提供受限 source.read / output.stage 反向调用；每次响应必须匹配运行与会话。Node 不直接写业务数据库或项目产出文件。

SDK settled 后先完整验证并 fsync 会话 JSONL 与 checkpoint，才发出 terminal completed。取消走真实 SDK abort。SessionManager 的公开恢复接口消费完整 JSONL；相对路径 codec 仅转换 SDK 工作目录和会话父路径，保留消息原文。历史损坏、断链、校验和不符或符号链接会拒绝恢复并保留历史。Rust 元信息、正式预算与 Workspace generation 绑定由后续 Host 服务接入。

## Record utility worker

```sh
npm run build:record-worker
npm --prefix packages/agent-host run test:record
```

`src/record-worker-entry.mjs` 独立加载构建出的无浏览器编辑器转换模块。它没有模型、工具、文件读写或数据库接口，只通过有界 JSONL 接收 `record.initialize`、`record.validate`、`record.patch`、`record.compare` 与 `record.schema`，输出稳定块 JSON、HTML/Markdown/text 投影及正文 hash。未知节点/属性与不合法 patch 返回诊断；不伪造成功。Rust fixture 同步脚本为 `scripts/update-record-schema.mjs`。

此 worker 和 Rust head/version 库仍在 AI-16 的实现阶段，尚未接入全部 GUI 保存入口、窗口协调、版本历史界面和正式资源分发。

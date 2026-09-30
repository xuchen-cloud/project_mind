# Agent Host

独立后端 Node 包，不作为前端依赖。当前是 `mind-agent-host/v1` JSONL 协议框架，尚未安装 Pi SDK，也未声明任何模型运行能力。

```sh
npm --prefix packages/agent-host run check
npm --prefix packages/agent-host test
npm --prefix packages/agent-host start
```

开发机器需要 Node 22 或更新版本。这里的 engines 范围仅用于运行框架测试，不是安装包运行时的版本锁定；发布前由 AI-01 锁定 SDK/Node 版本、许可证及目标平台资源并验证。

stdin/stdout 每行一个 JSON 对象；stdout 无日志。请求帧包含 `protocolVersion`、`requestId`、`method`，例如：

```json
{"protocolVersion":"mind-agent-host/v1","requestId":"init-1","method":"initialize"}
{"protocolVersion":"mind-agent-host/v1","requestId":"stop-1","method":"shutdown"}
```

握手返回 `runtimeAvailable:false`。其余已知方法 `session.open` / `run.start` / `run.cancel` / `session.close` / `tool.result` 在初始化后返回 `RUNTIME_UNAVAILABLE`；不生成虚假会话、文本或完成事件。协议不匹配返回 `RUNTIME_INCOMPATIBLE`，非法帧返回 `INVALID_ARGUMENT`，超过 1 MiB 或 EOF 时未终结的帧会安全退出。

AI-01 在这一边界后接入受限 Pi adapter；必须禁用默认 shell/file 工具、资源/AGENTS/extension 自动发现。模型凭据只能经进程管道进入内存，不写 argv、环境、日志和工作区配置。tool.call 返回 Rust 共享服务执行，Node 不直接写业务数据库或托管项目文件。

Pi 历史 JSONL 是模型恢复的唯一权威；Rust DB 保存元信息和 UI 投影。绑定 Workspace 的相对路径 codec、checkpoint、settled、取消及恢复要通过专门 fixture 后才使 runtimeAvailable 为 true。源码/HTML 提取 worker 与模型运行时另行隔离，不在本协议框架内实现。

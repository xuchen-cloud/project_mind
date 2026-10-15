# Agent Host

独立后端 Node 包，不作为前端依赖。生产入口使用 `mind-agent-host/v1` JSONL 协议，承载原生 Pi 会话、Overview/知识维护及历史读取；Record 和 Source 转换使用独立 utility 入口。Project 聊天界面已改用 [DSH runtime](../dsh-assistant/README.md)，不通过本包；当前 Workspace 聊天及知识/记忆 GUI 尚未接回。产品接入与验收状态见[待办](../../docs/remaining-work.md)。

## 固定版本与复现

Pi SDK 固定为 `@earendil-works/pi-coding-agent@0.99.1`，安装包 Node 候选固定为 24.21.0。`runtime-manifest.json` 记录 macOS / Windows、arm64 / x64 官方压缩包与 SHA-256；开发脚本要求 Node ≥22.19.0。SDK 依赖与锁文件独立于前端。

```sh
npm --prefix packages/agent-host ci
npm --prefix packages/agent-host run check
npm --prefix packages/agent-host test
npm --prefix packages/agent-host run test:pi
```

下载 manifest 对应的官方 Node 压缩包后，使用 `prepare:runtime -- darwin-arm64 <absolute-archive-path>` 校验并提取 Node 与许可证；`smoke:runtime -- darwin-arm64` 会将运行时复制到含空格和中文的临时目录，清空 PATH，并运行 Pi 集成 fixture。runtime、node_modules、dist 均不提交。

固定 Node 24.21.0 下已有本地模型协议、受限反向工具、checkpoint、取消、搬迁后恢复和真实子进程验证。真实 Provider 和目标平台产品验收按[交付台账](../../docs/requirements/ai-work-context-acceptance.md)分别记录。

## 生产协议

```sh
npm --prefix packages/agent-host start
```

stdin/stdout 每行一个 JSON 对象；stdout 无日志。请求帧包含 `protocolVersion`、`requestId`、`method`：

```json
{"protocolVersion":"mind-agent-host/v1","requestId":"init-1","method":"initialize","data":{"workspaceRoot":"/absolute/workspace","systemPrompt":"Trusted scoped instructions","tools":[]}}
{"protocolVersion":"mind-agent-host/v1","requestId":"stop-1","method":"shutdown"}
```

正式 initialize 校验可信 Workspace 路径、提示词和有界工具 manifest，成功返回 `runtimeAvailable:true`。实际协议包括 session.open、run.start、run.cancel、session.close、session.history.read/scan、overview.capacity/generate 和 shutdown；工具请求反向交给 Rust。协议不匹配返回 `RUNTIME_INCOMPATIBLE`，非法帧返回 `INVALID_ARGUMENT`；帧预算以 `src/protocol.mjs` 的 `MAX_FRAME_BYTES` 为准，超限或 EOF 时未终结的帧会退出。

## Pi 验证入口

`npm --prefix packages/agent-host run probe` 启动独立验证进程，其握手不开放生产运行能力。正式与验证入口的 session.open 均接受明确映射、启用且支持文本的 openai_compatible Profile；配置完整即可发起实际请求，不要求先运行工具调用探针。Provider 错误由实际请求返回。凭据仅经进程管道进入内存，不使用 argv、环境或工作区配置。测试使用临时目录与本地模型协议服务器。

Pi 不加载默认 shell/file 工具，也不发现本机 AGENTS、skills、prompts、themes、extensions 或 packages。验证入口仅提供受限 source.read / output.stage；正式入口使用原生 Host 经作用域和模式筛选的读/成果/收据工具 manifest，Node 再按 `tool-descriptors.mjs` 校验。每次响应必须匹配运行与会话，Node 不直接写业务数据库或项目产出文件。

SDK settled 后先完整验证并 fsync 会话 JSONL 与 checkpoint，才发出 terminal completed。取消走真实 SDK abort。SessionManager 的公开恢复接口消费完整 JSONL；相对路径 codec 仅转换 SDK 工作目录和会话父路径，保留消息原文。历史损坏、断链、校验和不符或符号链接会拒绝恢复并保留历史。Rust Host 已负责 run 元信息、授权、来源依赖、操作回执、预算和 Workspace generation。

## Record utility worker

```sh
npm run build:record-worker
npm --prefix packages/agent-host run test:record
```

`src/record-worker-entry.mjs` 独立加载构建出的无浏览器编辑器转换模块。它没有模型、工具、文件读写或数据库接口，只通过有界 JSONL 接收 `record.initialize`、`record.validate`、`record.patch`、`record.compare` 与 `record.schema`，输出稳定块 JSON、HTML/Markdown/text 投影及正文 hash。未知节点/属性与不合法 patch 返回诊断；不伪造成功。Rust fixture 同步脚本为 `scripts/update-record-schema.mjs`。

Record utility 已接 canonical GUI 保存、共享写入协调、版本历史和固定 Node 资源分发。AI-16 的剩余验收与发布状态以 Issue #113 为准。


## Source extraction utility

```sh
npm run test:source
npm run build:record-worker
npm run stage:record-runtime
npm run stage:source-runtime
```

AI-03 的独立提取层接收已授权、固定版本的字节快照，不接收路径、URL、工具或凭据。每进程只接一份输入；UTF-8 txt/Markdown/HTML 限 10 MiB，PDF 限 50 MiB、500 页；提取总量限 2 Mi Unicode 字符，每块 1800 字符、同段落或同页重叠 200。结果携带覆盖范围，截断、缺文本页、扫描件、加密、编码异常分别返回明确状态。HTML 索引文本不能替代原始 File 源码。

PDF.js 6.2.108、固定 DOMMatrix 兼容实现、CMap 和标准字体均打包进独立 bundle，含全部许可与 SHA-256 清单；不依赖 node_modules、开发 Node 或 native canvas。Node 和许可复用 Record 固定 runtime。原生端执行 Node 权限隔离、512 MiB JS heap 上限、60 秒硬超时及每 Workspace 一个任务；Record 转换仍保持自己的 10 秒/两个任务限制。

原生 Source 服务已接入 SourceRef 权限与固定版本、hash 复查、持久索引、排除策略及后台队列；读取和提取的边界见[提取实现](../../docs/technical/source-extraction-implementation.md)。这些内部服务不代表 DSH 聊天已接通所有知识/记忆和业务成果工具。

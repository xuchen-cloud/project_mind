# Document utility workers

本包仅保留独立 Record、Source 与 Office worker 和固定 Node 24.21.0。AI 模型调用、Overview 和连接诊断统一由 [DSH runtime](../dsh-assistant/README.md) 提供。旧 Pi SDK、Host、CLI 与会话读取执行路径已移除；历史用户数据保留。

`runtime-manifest.json` 固定各平台官方 Node 压缩包与 SHA-256。使用 `prepare:runtime -- darwin-arm64 <absolute-archive-path>` 校验并提取 Node 与许可证。运行 `npm --prefix packages/agent-host run check` 检查入口，`npm --prefix packages/agent-host test` 验证 worker。runtime 与构建产物不提交。

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

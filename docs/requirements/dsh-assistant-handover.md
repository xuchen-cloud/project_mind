# DSH 独立助手实施交接

> 历史交接，保留原始上下文。用户后续要求已改为融入主应用、替换 Pi 聊天、沿用统一模型与项目目录；当前范围和验证见 [实施工作包](dsh-assistant-execution.md)、[组件融入方案](dsh-ui-component-integration.md)及[迁移记录](dsh-assistant-migration.md)。本文原有独立 UI / Electron 脚本状态不代表当前实现。

日期：2026-10-11。仓库：`/Users/xuchen/project_mind`。本文供主会话继续实施；侧边会话已停止实现工作，只交付这份交接。

## 1. 用户最终要求

按以下顺序理解当前范围，最新指示优先：

1. 考察并复用 `https://github.com/dataelement/dsh-desktop`，长期以 DSH 替换项目直接使用的 Pi Harness。
2. 主项目框架与 DSH 助手保持低耦合。
3. **当前先完成独立 DSH + 上述 Desktop UI，可在会话窗口正常聊天，不做主项目业务对接。**
4. 用户指出已有 JSON-RPC SDK，没有必要引入 Electron。已认可该纠正：**不使用 Electron 外壳，不替换现有 Tauri。**
5. 用户允许主会话按工作项并行实施。侧边会话有系统级禁止子 agent 的限制，因此本次没有启动任何子 agent；主会话应按自身规则判断是否可委派。

当前交付不包含：接入主业务数据库、原生业务工具、Workspace 设置、旧会话迁移、后台 Overview/Memory、替换生产 Pi 入口、发布合并或关闭历史 Issue。

## 2. 最重要的纠正：现有启动脚本仍是错误的 Electron 方向

此前误把“复用 Desktop UI”做成“运行整个 Electron Desktop 应用”。仅完成下载和依赖安装，**没有启动 DSH 会话窗口，没有完成对话验收**。

用户纠正后已停止额外 Office 准备进程，但尚未改写启动脚本。因此：

- **不要直接运行当前 `npm run dev:dsh` 或 `npm run start:dsh`**，它们仍会调用上游 Electron 启动命令。
- `build:dsh` 仍调用整个上游 Electron/Office/PPT 构建，不符合当前范围。
- `scripts/isolation.mjs` 及其测试是 Electron 身份与数据目录补丁，需改为独立 Node 运行时的数据隔离，不应保留为最终架构。
- `upstream.json` 中 `electronVersion` 仅反映旧尝试，应从我们实际依赖与验收要求中移除。
- 原实施方案顶部“复用真实运行入口和完整桌面 WebUI”的描述需要明确改为 **Node DSH + UI 复用，不带 Electron**。

## 3. 已确认的技术事实与待决定接口

### 3.1 SDK 能力

固定版本 `0.2.0-rc.2` 的官方 TypeScript SDK：

- `@deepseek-ai/dsh-sdk-client`：`DeepSeekHarness` / `HarnessClient`，持有独立 Node 子进程，通过换行分帧的 stdio JSON-RPC 通信。
- `@deepseek-ai/dsh`：统一运行入口，`--profile sdk` 或 `sdk-minimal`，也支持 Web profile。
- `@deepseek-ai/dsh-sdk-jsonrpc-server`：可挂载到 Cordis 组合中的 stdio 服务插件。
- 高层接口支持会话、提示词、事件流及运行结束结果；关闭负责回收进程。
- **该版本 SDK 没有轮次中取消方法**。官方说明取消意味着关闭运行时；不要凭空实现或声称存在 `session/cancel`。
- SDK 服务端公开方法是 `initialize`、`session/prompt`、`shutdown`。不要假设它直接提供原 UI 的完整设置、历史列表、会话管理 API。
- `initialize` 校验实际 provider/model 路由，模型配置不能用未经验证的空值代替。

### 3.2 原 Desktop UI 的通信并非 stdio SDK

已读上游 Web 组合与本地发布产物，确认：

- Desktop 加载上游 DSH WebUI，并通过 `dsh-desktop-client-ui` 等插件定制界面。
- `dsh-desktop-client-ui` 的 host 文件 `index.js` 是空 `apply()`，`client.js` 是浏览器模块，**可脱离 Electron 复用**。
- 原 UI 使用 `@deepseek-ai/dsh-client-connection` 的 **HTTP RPC + SSE** 和 `api-remotes`；不是将 stdio JSON-RPC 直接放进浏览器。
- 设置、历史、停止等能力由 Web gateway/controller 提供。原 UI 存在打开本地文件等宿主动作，独立阶段应按真实调用路径处理，不能宣称所有宿主能力已接通。

因此，上一条回复中的“UI → 薄桥 → SDK”是架构方向，**不是已经证明可直接替换原 UI Connection 的实现**。主会话应先确认最小接缝，再编码：

- 优先保留原聊天 UI 与已有 Web 运行能力，独立 Node 进程承载；这可避免重写整个 UI 协议，但必须向用户说明聊天仍用原 Web RPC/SSE，而不是假称使用 SDK。
- 若当前要求严格限定聊天必须经 SDK，则先验证 UI 需要的会话/设置/历史接口能否由最小适配实现，以及停止时重建运行时和恢复的行为。不要另画一个简化聊天页冒充复用了 Desktop UI。
- 不为“用 SDK”另起第二个互不共享历史/模型配置的助手运行时；不要造成 UI 与 SDK 的两套状态。
- SDK 本身不依赖 Electron；上述两条路径都没有引入 Electron 的理由。

## 4. 当前文件与修改归属

侧边会话只修改了已有根 `package.json`，增加五个 DSH convenience scripts；新建以下文件。没有改动现有主项目源码。

| 路径 | 当前状态 / 后续处理 |
| --- | --- |
| `docs/requirements/dsh-assistant-migration.md` | 已写方案；顶部是独立阶段，DSH-1～4 是后续整体迁移，不属于当前交付。需同步无 Electron 方案。 |
| `packages/dsh-assistant/package.json` | 独立私有包，Node >=22；目前无直接依赖，scripts 指向旧 `desktop.mjs`。需改写。 |
| `packages/dsh-assistant/package-lock.json` | 只有独立包根记录，**不是最终 DSH/SDK 依赖锁**。 |
| `packages/dsh-assistant/upstream.json` | 上游源码 pin/hash，可复用源码校验部分。 |
| `packages/dsh-assistant/scripts/desktop.mjs` | 下载校验、解包、安装 receipt 和旧 Electron 启动包装。保留有用的 pin/cache 思路，替换运行路径。 |
| `packages/dsh-assistant/scripts/isolation.mjs` | 旧 Electron 身份补丁；需替换。 |
| `packages/dsh-assistant/test/isolation.test.mjs` | 旧补丁三项测试已通过，不能证明新的 SDK/UI 集成。 |
| `packages/dsh-assistant/.gitignore` | 忽略 `.upstream/`、`.downloads/`、`.acceptance/`、`node_modules/`。 |
| 根 `package.json` | 新增 `dev:dsh` / `start:dsh` / `build:dsh` / `check:dsh` / `test:dsh`，后续确保它们指向正确实现。 |

未提交、未 push，未创建 PR 或新分支，未写远端 Issue。

曾实验的 `packages/dsh-assistant/src/runtime.mjs` 与 `packages/agent-host/src/dsh-session.mjs` 已删除，**不属于现有交付**；不要基于旧测试结果声称这些模块还在。

## 5. 固定版本、源码和本地缓存

上游 Desktop 源码已固定并验证：

```text
repository: https://github.com/dataelement/dsh-desktop
commit: 115a0b474cc2c4794316171c640a8898398591fe
Desktop version: 0.1.1
DSH version: 0.2.0-rc.2
archive SHA256: 4c53f4da089590db938d0ebfbdd2447e71063426e5f1910456ba4b0bc79b93e2
```

本地可直接读取，减少重复下载：

- `packages/dsh-assistant/.upstream/`：固定的 Desktop 源码，含已装完整依赖（旧尝试含 Electron）。主源码 `src/main/index.ts` 仅加了身份隔离补丁；最终不需要运行该 Electron 主入口。
- `.upstream/.project-mind-upstream.json`：源码 pin receipt。
- `.upstream/.project-mind-install.json`：上游 lock checksum receipt，值 `4131cc03f4143369316181dd6b8095fd9e2dd32280cc340c3d27e06f4956335d`。
- `packages/dsh-assistant/.downloads/<commit>.tar.gz`：已校验源码包。
- `/tmp/mind-dsh-implementation/deepseek-harness-dsh-v0.2.0-rc.2/`：相应 SDK/运行时源码参考。
- `/tmp/mind-dsh-implementation/dsh-desktop-main/`：此前只读参考。
- `/tmp/mind-dsh-implementation/deepseek-harness-master/`：版本不同，只作背景；**不要把 master 类型当成固定 rc.2 API**。

上游当前 `.upstream/node_modules` **没有** `@deepseek-ai/dsh-sdk-client`，只包含 SDK server/protocol/app。真正使用 SDK client 还需安装并固定同版本。

许可证为 MIT，交付时保留实际复用来源的版权与许可证。

## 6. 已运行检查及局限

- `npm run test:dsh`：旧隔离补丁测试 3/3 通过。实现改为 Node/SDK 后必须更新对应测试。
- 上游 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json`：通过，只验证旧 Electron 主入口类型。
- 上游 `npm ci --no-audit --no-fund`：完成，安装 1004 个包，上游 patch-package 全部成功；这不是最终无 Electron 安装方案。
- 上游 `npm run ppt:build`：完成，但 PPT 不属于当前聊天交付，后续不用继续准备。
- 上游 `npm run office:prepare`：已主动停止，未完成，不属于当前范围。
- 未完成 DSH Web/SDK 启动、真实 UI 发送、流式、多轮、停止、持久历史验收；未获得或迁移用户真实模型凭据。
- 确定性本地模型服务可验证协议与 UI，但结果必须标注测试 Provider，**不能冒充真实模型接入**。

## 7. 建议工作项及依赖

| 工作项 | 交付 | 依赖 / 可并行范围 |
| --- | --- | --- |
| A：运行与依赖 | Node DSH、同版本 SDK、独立 profile/data、启动和关闭；去除我们对 Electron/Office/PPT 的安装和构建要求。 | 先明确第 3 节通信方案；负责 package/lock 与启动脚本。 |
| B：真实 UI 复用 | 上游 WebUI + Desktop UI 必要插件；会话页与配置模型入口；隔离样式与宿主边界。 | 可先只读梳理 roster/接口，之后依赖 A 的通信契约。不要修改主项目 AgentPanel。 |
| C：针对性验收 | 本地模型服务、真实运行集成、多轮/停止/恢复及窗口检查。 | 可先准备测试服务；运行验收依赖 A+B。 |
| D：文档与收口 | 启动说明、许可证、方案和真实结果更新。 | 接口明确后可写草稿，最终依赖 C。 |

如果主会话允许并行，A/B/C 划分不同文件范围，根 package/lock 只由一个实现者修改；不要多个 agent 同时安装同一 node_modules 或重复全量构建。

验收行为：

1. 独立入口不启动 Electron，也不重启现有主应用。
2. 窗口确实使用 DSH 与所述上游 UI，而非静态样图或替代聊天页。
3. 可配置 Provider/model，发送消息并收到流式回答，继续第二轮。
4. 停止后 UI 能继续使用；准确实现固定版本 SDK 的取消限制。
5. 关闭重开后能读取独立历史；失败后能再次发送问题。
6. 上游会话/配置只存放在独立数据目录；不触碰主项目业务数据。
7. 有可重复的依赖安装、启动命令和必要检查；真实 Provider 尚未配置时如实说明。

## 8. 保护主会话正在做的改动

仓库已有主会话大量未提交更改：`packages/agent-host/src/` 及 `test/pi/`、`src-tauri/src/agent/`、后台 DB/overview 维护、`src/components/agent/`、`src/components/settings/`、`src/components/voice/`、`src/state/ui-store.ts`。

主会话原有 untracked 文件包括 `AgentSettingsPanel.tsx` 及测试、`src/lib/agent-model.ts`、`src/lib/agent-workspace-settings.ts`。这些均不是侧边会话产物，不得覆盖、清理或夹带回滚。

交接时观察到当前主应用：`tauri dev --no-watch` PID 26226、Vite PID 26408、端口 1420。PID 只作当时记录，操作前重新确认。没有本侧的 DSH/Electron/Office 准备进程在运行。不要为了独立助手验收重启主应用。

## 9. 主会话建议起手顺序

1. 读取本文和仓库 AGENTS，确认主会话当前工作状态。
2. 以固定 rc.2 源码验证 SDK 与原 UI 的通信接缝，明确是否保留上游 Web RPC/SSE；同步说明实际选择。
3. 修改旧启动包装、依赖和方案，先让独立 Node 运行入口成立。
4. 接入真实 UI、配置模型、完成针对性验证，最后集中告知并打开验收窗口。
5. 记录结果，交付独立入口；整体 Pi 迁移另行推进，当前不要误标完成。

官方参考：

- https://github.com/dataelement/dsh-desktop/tree/115a0b474cc2c4794316171c640a8898398591fe
- https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/sdk
- https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/bundle/web-app

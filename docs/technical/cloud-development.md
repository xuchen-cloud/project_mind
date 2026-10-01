# Linux 云端开发环境

用途：在 Linux x64 环境静默验证共享数据库、服务、Record 转换和 source 提取；不代替 macOS/Windows 安装包、视觉或真实 Provider 验收。继续使用 `codex/ai-enhancement`。Mac 本地未推送提交及工作区改动不能从此克隆推定已包含。

## 工具链和资源

- `scripts/cloud/Dockerfile` 固定 Rust 镜像 digest，提供 Rust 1.98.1、GTK 3、WebKitGTK 4.1 及原生编译依赖。容器不启动应用窗口。
- `packages/agent-host/runtime-manifest.json` 的 `linux-x64` 是开发测试目标，固定官方 Node 24.21.0 的归档 SHA-256。Rust source worker 仅在 debug/test 构建接受该平台；这不扩展产品发布平台。
- 使用既有 prepare/build/stage 脚本验证 Node、许可证、bundle 和资源 hash；不要用系统 Node 替换固定运行时，或伪造 runtime 回执。
- sherpa-onnx 1.13.8 的构建脚本不读取注入的系统 CA；setup 用 curl 下载官方 Linux 静态库，校验 GitHub release asset 的 SHA-256 后通过 `SHERPA_ONNX_ARCHIVE_DIR` 提供，保持真实原生链接和 TLS 验证。
- Rust target/cache 保存在仓库外的环境目录，不能复用 Mac 编译产物。低内存环境设置两个编译 job、关闭编译调试信息；前端全量使用一个 worker。

## 准备及复用

托管环境先核对网络策略及本机 Docker daemon，保留平台 proxy/registry 配置。`scripts/cloud/setup.sh` 将当前系统合并 CA bundle 作为 build secret/read-only mount 提供给 HTTPS 客户端，保持 TLS 校验，并限定本机 Docker socket。需要宿主已有 Node/npm、curl、tar 和可访问的 Docker daemon。

从仓库根目录首次执行：

```sh
bash scripts/cloud/setup.sh > ../project-mind-setup.log 2>&1
```

脚本下载并校验固定 Node、安装两个 npm lockfile 的依赖、串行构建及 staging worker，最后创建名为 `project-mind-dev` 的容器。整个过程不启动应用或 Provider 请求。容器已存在时脚本拒绝覆盖；先核对现有容器，再决定复用或重建。

默认环境目录是仓库的同级 `project-mind-env`，包含 Node、Cargo 缓存和 target。可以用 `PROJECT_MIND_ENV_DIR`、`PROJECT_MIND_CA_BUNDLE`、`PROJECT_MIND_DEV_CONTAINER` 显式覆盖环境目录、合并 CA bundle 或容器名。不要将目录指向用户 Workspace 业务数据。

同会话复用已停止的容器使用 `docker start project-mind-dev`；新会话 proxy/CA 变化时重新创建容器，保留环境目录中的缓存。通过 `docker exec project-mind-dev` 使用容器内工具链；若在宿主执行下面的 npm 命令，先将环境目录中已验证的 `node-v24.21.0-linux-x64/bin` 放到 PATH 前面。

资源 build/stage 必须串行完成后再开始测试。测试期间不要同时重新 staging 或改写 hash 清单。普通 `build:desktop` 仍只准备 Record worker；source worker 由开发脚本显式准备。

首次 Rust 冷编译和前端全量建议串行运行，避免页面驻留测试在 CPU 竞争下超时；不因此放宽用例超时或断言。

## 静默验证

将命令输出重定向到日志，失败时读取诊断。修改源码前检查 `tauri dev` 进程；不要运行 `tauri dev` 作为单测前置。

```sh
docker exec project-mind-dev cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets --quiet
docker exec project-mind-dev cargo test --manifest-path src-tauri/Cargo.toml --locked --lib source --quiet -- --include-ignored
docker exec project-mind-dev cargo test --manifest-path src-tauri/Cargo.toml --locked --lib record --quiet -- --include-ignored
npm run test:unit -- --maxWorkers=1
npm --prefix packages/agent-host run check
npm --prefix packages/agent-host test
npm run build
npm run check:portable-paths
npm run check:ui-standards
npm run check:bundle-boundaries
```

Rust 专项显式包含真实进程测试，不能用默认 ignored 数量冒充已执行。`source.search/read` capability、普通桌面 source worker 分发、Schema 发布和 Issue 验收仍沿各自门槛；环境验证通过不代表 #100 已交付。

## 本次核对与验证（2026-10-01）

基线为 `codex/ai-enhancement` 的 `8cfb1094b6330c1038bfca148424a5fa21830fe5`。已读取 AGENTS、CONTEXT、协作规范、三份 AI 工作上下文规格、来源实施记录、ADR 0003/0004/0009 及 #97/#98/#100/#113/#114 最新正文。#100 仍处于阶段实现。远端未找到 `codex/record-block-versions`，GitHub 对 `7fbb771` 返回无此提交；Mac 本地桌面验收改动及用户交换文件未取得、未改动，也未合并。

本次环境适配仅增加固定 Node 的 Linux 开发目标与 debug/test worker 路径，修正语音恢复测试的类型导入，并把仅有 macOS/Windows 实现的字体渲染断言拆成对应平台的独立测试；通用图片缩放、签名与图形标注继续在 Linux 验证。产品字体渲染行为未改动。

| 检查 | 本次实际结果 |
| --- | --- |
| Rust 全目标 | 库 325 passed、14 ignored；其余三个目标零用例通过 |
| Rust source（include-ignored） | 94 passed，包含固定 Node 真实进程 |
| Rust record（include-ignored） | 99 passed，包含固定 Node 真实进程 |
| Node worker/协议/许可 | 15 passed |
| Pi 确定性 fixture | 10 passed；仅本地 fake provider |
| 前端全量，maxWorkers=1 | 138 文件通过；App 文件 20 passed、1 timeout；合计 954 passed、1 failed |
| 前端超时用例单独执行 | 1 passed、20 skipped；不能替代全量全绿 |
| TypeScript/Vite、portable paths、UI standards、bundle | 通过；主入口 188 KiB / 250 KiB |

前端保留问题：`keeps five unified Project shells resident and evicts only the LRU shell` 在文件/全量运行中超过原有 15 秒限制。临时测量显示连续六次真实 Focus 页面导航占主要耗时；收窄标签查询没有消除超时，已撤回该尝试与测量代码，保持原用例、断言和超时。不能以此环境声称前端全量验收通过，也不能进入发布流程。日志保存在环境目录的 `logs`，Issue 正文快照在 `context`。

后续业务阶段已接入 Project/QuickNote/Todo/子项/Transcript 与 Record/Project 删除的事务 outbox、提交后通知、删除 registry 和依赖失效水位；显式开发开关下接入自动索引循环与持久预算、前台优先、取消和 metadata 进度接缝，详见 [source 实施记录](source-extraction-implementation.md)。普通产品调度/进度 UI、真实知识 owner 的注册与消费仍待接通；File 写入需结合 #114 的版本/CAS/journal 约束。本次没有执行 UI、真实 Provider、macOS/Windows 实包验收，没有发布 PR、合并或关闭 Issue。


开发调度验证须同时设置 `PROJECT_MIND_SOURCE_INDEXING_DEV=1` 与 `VITE_MIND_SOURCE_INDEXING_DEV=1`，并使用 `npm run dev:tauri:manual`；这一步会打开窗口，执行前先告知用户。release 构建不接受此开关，普通 `build:desktop` 不分发 source worker。该入口不开放来源工具，也不发送模型请求。

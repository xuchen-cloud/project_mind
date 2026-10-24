# 说话人模型一键准备验收（2026-10-24）

关联 [#237](https://github.com/xuchen-cloud/project_mind/issues/237)，延续 #234 的事后识别，不新增实时说话人或文字复核。

## 交付行为

- 未就绪时，设置页只显示一个“下载并启用”动作；两个模型及许可共 45,599,092 字节，由应用后台下载、校验和激活。主界面不再要求手动下载多个文件或改名。
- 已有本地 ASR 模型收起重复下载与技术说明，保留“本地模型管理”；说话人离线导入保留在“高级选项”。
- 安装进程提供真实字节进度，关闭重开设置可读取同一任务。忙时不重复下载，失败只在用户点击后重试。成功时刷新设置与既有录音页的共享模型状态。
- 固定官方作者 HTTPS 源、revision、字节数、SHA-256；保留 TLS 校验和系统代理。每个请求包含请求级 30 分钟总 deadline，覆盖响应头和整个响应体。失败不激活半包，临时目录回收，旧模型缓存保留。

## 已通过验证

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| 原生集成 | `cargo test --lib --no-run`（Windows x64，test 包 debug=0） | 最终源码编译通过；测试 exe 使用既有 Common-Controls v6 激活清单 |
| 相关语音模型回归 | `<test-exe> diarization --quiet` | 初轮 22 通过、2 个外部资源用例 ignored；之后仅安装器增加请求级 deadline |
| 最终安装器 | `<test-exe> voice::diarization_install --quiet` | 5 通过、真实外网安装用例 ignored；覆盖 loopback 四文件、进度、去重、缓存复用/损坏重装、HTTP 失败手动重试、SHA/大小失败保旧缓存、临时清理、连续慢响应体总 deadline |
| 前端 | SettingsPanel / voiceApi 定向测试 | 累计 18 项有效通过：原相关 17 项及最后 ASR 已就绪折叠管理回归 1 项；未变范围复用 |
| 类型与构建 | `tsc --noEmit`、`vite build` | 均通过；生产构建 6.79 秒。沿用同基线已校验 Office 产物，PDF 资源由已有固定 pdfjs 生成脚本补齐 |
| 静态检查 | `check:ui-standards`、`check:bundle-boundaries`、diff | 通过；主入口 249 KiB / 250 KiB |
| 独立界面 fixture | 真实 VoiceSettingsPanel + 明确模拟后端，headless Chrome | 11 条断言通过；一个下载动作、实际模拟字节比例 50%、校验/就绪、失败手动重试、高级导入、390px 无横向溢出，无 pageerror |

原始说话人算法与联系人匹配未改变，沿用 #234 的固定模型 SHA 与真实四人中文音频验收，不将本包界面 fixture 当作实际模型推理或外网成功证据。

## 本机实际准备

已通过当前 `diarization_model::import` 的实际源码，把此前下载且 SHA 匹配的四文件原子导入 `%APPDATA%/com.xuchen.projectmind.alpha/voice-models/pyannote-3.0-eres2net-zh-16k-v1`。两个运行中的 debug app 均未设置专用 app-data override。

导入前 ready=false，导入后 ready=true，校验 marker 由实际导入流程生成。再执行当前安装器 `start`，确认复用缓存并返回 ready，无网络请求；loopback 缓存复用测试亦确认请求增量为零。未修改 Workspace、联系人、语音设置或录音数据。

这是本机已有资源的准备成功，不是完整联网安装成功。

## 尚未通过的发布门槛

真实官方外网完整下载没有通过。本次生产源码安装尝试取得首个文件部分内容后传输中断，正确进入 failed、清理暂存且没有激活半包。四文件元数据、两个许可的实际下载哈希、既有模型实物 SHA 均已核对一致。

有界对照中，curl 原链接、reqwest HTTP/1.1、`?download=true`、单 Range 完整范围均未完成约 6 MB 文件；不能据此声称 HTTP 版本、查询参数或 Range 能解决网络问题，因此没有添加盲目镜像回退、分段框架或自动重试。排查另发现 blocking client timeout 并不等于整个响应体总 deadline，已用请求级 timeout 修正，并以连续慢 chunk 的真实 HTTP 回归验证。

主 agent Standards / Spec 自查已处理状态读取失败恢复、安装 ready 后重新检查、离线导入后旧错误、已就绪 ASR 的配置噪音和请求总 deadline。仍需在可完整传输这些固定官方 HTTPS 文件的网络条件下，运行 `real_pinned_https_install`，验证完整下载、校验及激活成功。该项解锁前保持 PR 草稿、Issue 开放，遵循仓库发布门槛，不自动合并。

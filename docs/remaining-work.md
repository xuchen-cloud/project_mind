# ProjectMind 未完成事项

状态：当前唯一仓库内待办总表

更新时间：2026-10-24

GitHub Issues 是正式任务跟踪器。本文件只汇总仍需处理的产品与工程事项，不重复已经实现的历史计划。

## 当前状态

| 优先级 | 事项 | 当前结论 | 完成条件 |
| --- | --- | --- | --- |
| P0 | [#94 Voice Record](https://github.com/xuchen-cloud/project_mind/issues/94) | Windows 原生构建及部分播放、字幕、转写、纪要验收通过；麦克风采集仍有 P0 失败，保持 OPEN | 修复真实采集并完成下述实机验收后关闭 |
| P1 | [#115 HTML 交互执行](https://github.com/xuchen-cloud/project_mind/issues/115) | Windows H04 部分通过；完整历史、源码编辑、安全与平台矩阵未完成，保持 OPEN | 补齐需求验收及安装包、多屏/DPI 等证据 |
| P1 | [#118 文件集成](https://github.com/xuchen-cloud/project_mind/issues/118) / [#191 Office](https://github.com/xuchen-cloud/project_mind/issues/191) | Windows Office 编辑、保存重开及 GenOffice 真实回执已有证据；完整上游功能矩阵、macOS 与安装包未完成，保持 OPEN | 完成四格式上游功能矩阵和目标平台产品验收 |
| P1 | [#192 Windows File](https://github.com/xuchen-cloud/project_mind/issues/192) | 仅大小写改名尚未实现；网络/云盘、长路径与共享锁矩阵未覆盖，保持 OPEN | 实现仅大小写改名并补齐文件系统场景 |
| P1 | [#187 便携路径](https://github.com/xuchen-cloud/project_mind/issues/187) | 既有便携路径基线仍失败；bundle 249/250 通过不能替代验收，保持 OPEN | 修复失败基线并通过对应验证 |
| P1 | [#56 Project 驻留验证](https://github.com/xuchen-cloud/project_mind/issues/56) | 驻留、预取、LRU 和缓存契约已有自动化覆盖；两平台的真实切换和内存证据未完成 | macOS 与 Windows WebView2 完成同一套场景并记录结果 |
| P1 | [#60 帮助中心收尾](https://github.com/xuchen-cloud/project_mind/issues/60) | 文案草稿在独立分支；当前界面经历了较大调整，截图与操作说明需要重新核对 | 内容基于当前 UI，素材、首轮工作流和两平台说明验收完成 |

## AI 工作上下文：当前规格与待交付差距

AI 部分更新：2026-10-15。父需求 [#97](https://github.com/xuchen-cloud/project_mind/issues/97) 是导航，[统一规格 #121](https://github.com/xuchen-cloud/project_mind/issues/121) 是当前产品需求；详细要求、实现与验收分别见[主规格](requirements/ai-work-context-spec.md)、[工程契约](requirements/ai-work-context-engineering-spec.md)、[记忆细则](requirements/workspace-memory-lifecycle.md)和[验收台账](requirements/ai-work-context-acceptance.md)。

- 当前产品规格围绕 Context 与 Memory；Memory 包含 Overview 和长期记忆，行为按交互记忆与回顾整理区分。Project 与 Workspace 聊天均已由 DSH 承载，工作区入口无需进入项目，分别持有会话和运行时，见 [#161 工作包](requirements/workspace-dsh-chat.md)。原生 Pi 工具、后台维护及 CLI/MCP 保留；旧 Pi 聊天/知识/记忆管理界面已退出生产入口。DSH 与完整知识/记忆/原生成果工具、Workspace 统一可编辑 Skill 和 Harness 结构化设置仍待接线；用户明确本次先交付工作区聊天，记忆暂缓。
- 本轮主要差距为 Workspace 唯一长期记忆、项目背景栏目及沿用、请求绑定即时操作、明确决定的 Overview 增量、完整精简快照、下一次请求生效、联合整理与并发恢复。Project/Workspace 会话、分层 Overview、六类旧记忆、原生成果和 CLI/MCP 已有本地基础，真实 Provider 与目标桌面验收仍待完成。
- 当前覆盖只在[交付总览 V1～V5](requirements/ai-work-context-delivery.md#current-delivery)维护；它们尚不是批准的实施工单/排期。旧 M/R/WP/S/LM 与子工单原文已[归档](requirements/archive/README.md)，编号和开放状态保留、旧执行标签移除；后续拆票另走 `/to-tickets`。
- 外部 Harness、任务菜单和闭应用 Host #110～112 暂缓；既有 Mind CLI/MCP 继续维护。文件预览/编辑 #118/#115 与 [AI 网络代理 #119](requirements/ai-network-proxy.md)分别按独立需求及自己的证据验收。
- 普通成果默认 review 一次任务确认，协作/只读按用户选择；明确记忆请求和决定增量按具体授权规则处理。历史确定性测试或模拟模型通过不等于新记忆目标、真实语义与实机产品签收。

## Project 内容 Tab 与 DSH

[#124](https://github.com/xuchen-cloud/project_mind/issues/124) 的 Record / File / Session 内容 Tab、双栏、固定版本来源与独立项目运行时已有实现；阅读工具栏和 Tab 辨识见[优化规格](requirements/tab-strip-refinement-20261013.md)。[#125](https://github.com/xuchen-cloud/project_mind/issues/125) 已接入会话内配置模型选择。剩余条件：

- 真实 Provider 验证多 Project/Session 并行、停止目标归属、运行中模型配置变更与下一次请求绑定；当前原生助手设置不能视为已完整控制 DSH 行为。
- Windows 已开展部分实际验收；文件身份/移动、预览、双栏、快捷键、模型入口与后台任务仍按各自证据判断，不能由原生构建成功或单一路径通过推定全部完成。
- 临时放大聚焦阅读栏：先确定临时状态存续范围；放大/恢复须保留原双栏成员、比例、选中项、Record 草稿和 File 查看状态，后台 Session 继续。复用现有聚焦/可见性/保存协调，不改持久布局、不新增第三栏；覆盖键盘恢复、窄窗和 reduced-motion。
- 文件 Office 预览/编辑与 HTML 交互执行分别由 #118/#115 验收。当前 HTML WebView 允许正常网络访问，不提供 Tauri IPC；已不再局限于静态 HTML。iCloud 未下载文件导入问题仍待样本复现与根因证据。

## P0：Voice Record 收尾

### 当前实现边界

滚动分片、FSMN-VAD、云端有界重连与保存音频缺口回填、Transcript 搜索、Windows WASAPI 和跨屏约束已经进入代码。分片回放和 Transcript 定位复用前端播放器的区间跳转；纪要版本与恢复缺口已有 DTO，不再保留“后端实现后再添加”的注释。

当前 GUI 轮询权威快照并丢弃过期请求结果，不声明已提供带 epoch/sequence 的事件流或事件缺口协议。真实设备与服务的恢复效果仍按下述证据验收。

### 2026-10-24 Windows 实机结果与剩余条件

- 麦克风 P0 仍失败：Record 28 冷启动约 120 ms 即 fault，实际设备缺口为 4,320 frames（90 ms）；结束后录音已保存为 ended，但没有 ASR submit/decode，`captureIntegrityPassed=false`。不得将该记录视为采集通过，也尚不能指定驱动、DSP 或 APO 为根因。
- 模型就绪后的 SenseVoice 官方样本、本地字幕与 Transcript 已通过；Record 26 纪要新标题、复制到正文及重开通过。输出播放、暂停、继续，以及字幕结束后主界面刷新已有通过证据；最新独立 Wry 负载仅覆盖一次播放至暂停，不扩张为新的继续播放证据。
- 全局 Transcript 搜索可返回独立 Record；段落点击定位误差在 100 ms 内。全局结果自动精确跳转、删除后同步尚未通过验收。
- Windows 原生构建成功；完整安装包、多屏/DPI、麦克风与系统 loopback 双轨及两种识别链路的整体验收仍未完成。外部 ASR 负载与 Wry 播放负载各自通过，不能排除完整应用间歇采集故障。
- 设置已恢复为 DeepSeek profile 1、SenseVoice，`livePreviewEnabled=true`，凭据未变。Windows 黑窗口修复 `959d0aa1` / `d8975da0` 已在两个 Project 验证无可见黑窗口，Provider 未变；麦克风采集问题仍未解决，原生采集、ASR 诊断及性能相关改动暂保留在本地。

- 使用真实 Paraformer 服务验证断网、重连、去重和缺口补转写。
- 在 macOS 上集中验证真实设备切换、长录音、磁盘异常、退出保存和多屏浮窗。
- 本轮没有新增 macOS 或真实 Paraformer 验收证据。

保守润色、实时翻译、Context Lexicon、通用模型下载器、AEC、分轨音量控制等仍是暂缓范围；恢复时需要重新确认范围，不属于 #94 当前关闭条件。

## P1：文件集成与 Windows 验收

- #115 的 H04 Windows 部分证据覆盖同应用 HTML/CSS/ESM/JSON 与中文、可信按钮和筛选、第二页前进/后退、`target=_blank`、应用内外部 Example 页面、公共 CORS、375/768/1440 宽度、设置遮挡恢复，以及源码重建清空 store；对应 Rust 16/16、前端 149 项通过。完整历史与源码编辑尚未全部验证；安装包、多屏/DPI、junction 物理路径及恶意探针仍缺证据。
- #118/#191 已验证 Windows DOCX/PPTX 编辑、保存、重开；XLSX 数值粘贴 25 后 SUM=45，AI 修改为 30 后 SUM=50；三条 GenOffice 真实回执共 12 个历史 hash。以上不等于四格式上游完整功能矩阵通过；macOS 与完整安装包仍待验收。
- #192 的网络文件系统、云盘、长路径及共享锁组合未覆盖，仅大小写改名尚未实现；#187 的便携路径基线仍失败，两项保持 OPEN。
- [#224](https://github.com/xuchen-cloud/project_mind/issues/224) 的上游 [PR #229](https://github.com/xuchen-cloud/project_mind/pull/229) 启动修复已合并，Issue 已 CLOSED。本轮已验证的会话、Office、Record 与 Windows 窗口修复归 [#230](https://github.com/xuchen-cloud/project_mind/issues/230) 独立收口；该修复包不代表上述父需求完成，原生录音诊断与性能相关改动暂保留本地。

## P1：Project 页面驻留与性能

实现已经具备，不再保留旧动效计划中的重复任务。仍需：

- macOS：A→F 项目切换、第六个 Overview 淘汰而已打开内容仍驻留、Workspace Focus 两实例上限、关闭内容/Project 页签释放、长历史与长时间切换内存采样。
- Windows WebView2：执行同一套场景，记录驻留 shell、Focus 实例、请求次数、内存和可见闪烁。
- 依据实测结果判断是否需要减少隐藏 Record 列表成本，以及是否需要调整 loading skeleton 的出现阈值。

## P1：帮助中心

- 将 `codex/docs-help-writing-progress` 分支内容更新到当前 Workspace、Project、Record、Todo 和 Voice Record 界面。
- 重新拍摄真实 UI 截图，补齐必要示意图。
- 验证首次工作流能在十分钟内完成。
- 核对 macOS / Windows 快捷键、文件路径、`.project-mind`、导入移动/复制行为和 Provider 政策说明。

## P2：下一次发布

- 如果 `develop` 中的 0.1.4 改动需要交付给测试用户，按[发布流程](agents/publish-flow.md)合并到 `main` 并创建对应 Beta Release。

## 已实现，不再作为待办

以下能力已经进入当前代码，原执行材料已移至 `docs/archive/`：

- Workspace 与 Project 首页统一视觉、封面、QuickNote 和 Record 编排。
- Workspace 固定图标页签、浏览器式 Project 页签和切换动效。
- Workspace、Project、笔记页统一侧边栏、Todo Rail、滚动遮罩和推荐浮层。
- Todo 卡片、子任务编辑、完成动画、归档入口、标签/引用/联系人推荐。
- 统一右键菜单、外部点击关闭、标签编辑与删除。
- RichEditor 桌面右键粘贴与键盘粘贴语义统一，对应 Issue #22 已关闭。
- Dialog / Toast 生命周期、菜单来源动效、列表 FLIP、motion token 与自动规范检查。
- Project 数据预取、Overview LRU、独立内容页驻留、Workspace Focus LRU、后台保存协调和 bundle 边界。
- Voice Record 的双轨保存、录音会话、回放、字幕、转写、纪要、本地与云端识别的主体实现。
- `v0.1.2-beta.1` 已发布，对应 Issue #83 已关闭。

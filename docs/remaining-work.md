# ProjectMind 未完成事项

状态：当前唯一仓库内待办总表

更新时间：2026-10-14

GitHub Issues 是正式任务跟踪器。本文件只汇总仍需处理的产品与工程事项，不重复已经实现的历史计划。

## 当前状态

| 优先级 | 事项 | 当前结论 | 完成条件 |
| --- | --- | --- | --- |
| P0 | [#94 Voice Record](https://github.com/xuchen-cloud/project_mind/issues/94) | 主体、FSMN-VAD、有界重连和缺口回填已有实现；真实设备与跨平台验收仍未完成 | 完成下述实机验收，更新 Issue 后关闭 |
| P1 | [#56 Project 驻留验证](https://github.com/xuchen-cloud/project_mind/issues/56) | 驻留、预取、LRU 和缓存契约已有自动化覆盖；两平台的真实切换和内存证据未完成 | macOS 与 Windows WebView2 完成同一套场景并记录结果 |
| P1 | [#60 帮助中心收尾](https://github.com/xuchen-cloud/project_mind/issues/60) | 文案草稿在独立分支；当前界面经历了较大调整，截图与操作说明需要重新核对 | 内容基于当前 UI，素材、首轮工作流和两平台说明验收完成 |

## AI 工作上下文：当前规格与待交付差距

AI 部分更新：2026-10-14。父需求 [#97](https://github.com/xuchen-cloud/project_mind/issues/97) 是导航，[统一规格 #121](https://github.com/xuchen-cloud/project_mind/issues/121) 是当前产品需求；详细要求、实现与验收分别见[主规格](requirements/ai-work-context-spec.md)、[工程契约](requirements/ai-work-context-engineering-spec.md)、[记忆细则](requirements/workspace-memory-lifecycle.md)和[验收台账](requirements/ai-work-context-acceptance.md)。

- 当前产品规格围绕 Context 与 Memory；Memory 包含 Overview 和长期记忆，行为按交互记忆与回顾整理区分。Project 聊天已由 DSH 承载，原生 Pi 工具、后台维护及 CLI/MCP 保留；旧 Pi 聊天/知识/记忆管理界面已退出生产入口。Workspace 聊天、DSH 与完整知识/记忆/原生成果工具、Workspace 统一可编辑 Skill 和 Harness 结构化设置仍待接线。
- 本轮主要差距为 Workspace 唯一长期记忆、项目背景栏目及沿用、请求绑定即时操作、明确决定的 Overview 增量、完整精简快照、下一次请求生效、联合整理与并发恢复。Project/Workspace 会话、分层 Overview、六类旧记忆、原生成果和 CLI/MCP 已有本地基础，真实 Provider 与目标桌面验收仍待完成。
- 当前覆盖只在[交付总览 V1～V5](requirements/ai-work-context-delivery.md#current-delivery)维护；它们尚不是批准的实施工单/排期。旧 M/R/WP/S/LM 与子工单原文已[归档](requirements/archive/README.md)，编号和开放状态保留、旧执行标签移除；后续拆票另走 `/to-tickets`。
- 外部 Harness、任务菜单和闭应用 Host #110～112 暂缓；既有 Mind CLI/MCP 继续维护。文件预览/编辑 #118/#115 与 [AI 网络代理 #119](requirements/ai-network-proxy.md)分别按独立需求及自己的证据验收。
- 普通成果默认 review 一次任务确认，协作/只读按用户选择；明确记忆请求和决定增量按具体授权规则处理。历史确定性测试或模拟模型通过不等于新记忆目标、真实语义与实机产品签收。

## Project 内容 Tab 与 DSH

[#124](https://github.com/xuchen-cloud/project_mind/issues/124) 的 Record / File / Session 内容 Tab、双栏、固定版本来源与独立项目运行时已有实现；阅读工具栏和 Tab 辨识见[优化规格](requirements/tab-strip-refinement-20261013.md)。[#125](https://github.com/xuchen-cloud/project_mind/issues/125) 已接入会话内配置模型选择。剩余条件：

- 真实 Provider 验证多 Project/Session 并行、停止目标归属、运行中模型配置变更与下一次请求绑定；当前原生助手设置不能视为已完整控制 DSH 行为。
- Windows 环境提供后，验证文件身份/移动、预览、双栏、快捷键、模型入口与后台任务。macOS 既有观察和自动化结果不能替代此验收。
- 临时放大聚焦阅读栏：先确定临时状态存续范围；放大/恢复须保留原双栏成员、比例、选中项、Record 草稿和 File 查看状态，后台 Session 继续。复用现有聚焦/可见性/保存协调，不改持久布局、不新增第三栏；覆盖键盘恢复、窄窗和 reduced-motion。
- 文件 Office 预览/编辑与 HTML 交互执行分别由 #118/#115 验收；当前预览仅声明已支持的文本、Markdown、图片、PDF 和静态 HTML。iCloud 未下载文件导入问题仍待样本复现与根因证据。

## P0：Voice Record 收尾

### 当前实现边界

滚动分片、FSMN-VAD、云端有界重连与保存音频缺口回填、Transcript 搜索、Windows WASAPI 和跨屏约束已经进入代码。分片回放和 Transcript 定位复用前端播放器的区间跳转；纪要版本与恢复缺口已有 DTO，不再保留“后端实现后再添加”的注释。

当前 GUI 轮询权威快照并丢弃过期请求结果，不声明已提供带 epoch/sequence 的事件流或事件缺口协议。真实设备与服务的恢复效果仍按下述证据验收。

### 尚缺的验收证据

- 使用真实 Paraformer 服务验证断网、重连、去重和缺口补转写。
- 在 macOS 上集中验证真实设备切换、长录音、磁盘异常、退出保存和多屏浮窗。
- 在 Windows 上完成全量构建、安装包、麦克风与系统 loopback 双轨、两种识别链路和多屏/DPI 验收。
- 验证 Transcript 搜索结果的点击定位与删除后同步。

保守润色、实时翻译、Context Lexicon、通用模型下载器、AEC、分轨音量控制等仍是暂缓范围；恢复时需要重新确认范围，不属于 #94 当前关闭条件。

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

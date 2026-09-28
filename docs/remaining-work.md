# ProjectMind 未完成事项

状态：当前唯一仓库内待办总表

更新时间：2026-09-28

代码基线：`develop` / `880aafb`

GitHub Issues 是正式任务跟踪器。本文件只汇总仍需处理的产品与工程事项，不重复已经实现的历史计划。

## 当前状态

| 优先级 | 事项 | 当前结论 | 完成条件 |
| --- | --- | --- | --- |
| P0 | [#94 Voice Record](https://github.com/xuchen-cloud/project_mind/issues/94) | 主要功能和四个近期实现包已经进入代码；仍缺真实设备与跨平台验收，源码中还有与 Issue 描述冲突的 TODO | 完成下述真实性核对与实机验收，更新 Issue 后关闭 |
| P1 | [#56 Project 驻留验证](https://github.com/xuchen-cloud/project_mind/issues/56) | 驻留、预取、LRU 和缓存契约已有自动化覆盖；两平台的真实切换和内存证据未完成 | macOS 与 Windows WebView2 完成同一套场景并记录结果 |
| P1 | [#60 帮助中心收尾](https://github.com/xuchen-cloud/project_mind/issues/60) | 文案草稿在独立分支；当前界面经历了较大调整，截图与操作说明需要重新核对 | 内容基于当前 UI，素材、首轮工作流和两平台说明验收完成 |

## AI 工作上下文：已形成实施计划，尚未开始实现

- [父 Issue #97](https://github.com/xuchen-cloud/project_mind/issues/97) 是完整 PRD 和开发工单入口；[开发规格](requirements/ai-work-context-spec.md) 说明产品行为；[工程契约](requirements/ai-work-context-engineering-spec.md)集中数据/接口/故障规则，[交付验收](requirements/ai-work-context-delivery.md)集中工单定义与验收。Overview独立于QuickNote，不建设首页“继续工作”卡片。
- 首期包含AI维护的Project Overview、每日/隔日增量整理、会话摘要检索及消息引用、按问题渐进读取、Pi 内置会话、带来源问答、Record块修改与版本恢复、项目File版本化修改、成果保存、CLI/MCP；后续为 Workspace分层Overview与长期记忆、多 Agent/菜单和无界面运行。
- 19 个子任务为 #98～#116，依赖在 GitHub 跟踪；可先开始 [#98 Pi 技术验证](https://github.com/xuchen-cloud/project_mind/issues/98) 和 [#99 领域服务](https://github.com/xuchen-cloud/project_mind/issues/99)。首期完整验收为 #107；新增 [#113 Record块编辑与版本](https://github.com/xuchen-cloud/project_mind/issues/113) 和 [#114 File版本化修改](https://github.com/xuchen-cloud/project_mind/issues/114)，以及 [#115 HTML交互稿](https://github.com/xuchen-cloud/project_mind/issues/115)、[#116 自主执行与撤销](https://github.com/xuchen-cloud/project_mind/issues/116)，均是首期依赖。
- [方向讨论稿](technical/ai-capability-direction.md) 和 [参考调研](technical/ai-capability-reference-research.md) 保留思路来源；默认沉淀行为以开发规格为准：过程自动保存、成果自主保存并可撤销，Overview随助手启用后定期增量维护。

## P0：Voice Record 收尾

### 先核对实现真相

Issue #94 记录滚动分片、FSMN-VAD、云端重连与补转写、Transcript 搜索、Windows WASAPI 和跨屏约束已经进入代码；源码仍留有以下 TODO：

- `src-tauri/src/voice/recognition.rs`：FSMN-VAD 替换、云端有界重连和缺口回填。
- `src/lib/voice-types.ts`：持久化覆盖范围、派生状态、事件序列和缺口检测。
- `src/services/voiceApi.ts`：后端支持后的区间播放 API。

需要逐项判断它们是过期注释、部分实现，还是仍缺失的能力。核对后删除过期 TODO，真实缺口继续留在 #94。

### 尚缺的验收证据

- 使用真实 Paraformer 服务验证断网、重连、去重和缺口补转写。
- 在 macOS 上集中验证真实设备切换、长录音、磁盘异常、退出保存和多屏浮窗。
- 在 Windows 上完成全量构建、安装包、麦克风与系统 loopback 双轨、两种识别链路和多屏/DPI 验收。
- 验证 Transcript 搜索结果的点击定位与删除后同步。

保守润色、实时翻译、Context Lexicon、通用模型下载器、AEC、分轨音量控制等仍是暂缓范围；恢复时需要重新确认范围，不属于 #94 当前关闭条件。

## P1：Project 页面驻留与性能

实现已经具备，不再保留旧动效计划中的重复任务。仍需：

- macOS：A→F 项目切换、第六个 Project 淘汰、跨 Project Focus LRU、关闭页签释放、长历史与长时间切换内存采样。
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
- Project 数据预取、页面驻留、Focus LRU、后台保存协调和 bundle 边界。
- Voice Record 的双轨保存、录音会话、回放、字幕、转写、纪要、本地与云端识别的主体实现。
- `v0.1.2-beta.1` 已发布，对应 Issue #83 已关闭。

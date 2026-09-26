# 桌面会话接手续做

用户已要求停止 CLI 执行，转到桌面端会话继续。2026-09-26 已向原 CLI 进程 96384 发送中断并确认退出。不要恢复原 CLI 任务。

## 工作位置

- 目录：`<homepage-upgrade-worktree>`
- 分支：`codex/homepage-visual-upgrade`，基于本地 develop 创建。
- Issue： https://github.com/xuchen-cloud/project_mind/issues/95

## 先读

1. 仓库 AGENTS.md、CONTEXT.md 及适用领域和发布规则。
2. 本目录 HANDOFF.md（完整用户决策）及 references 内参考图。
3. VISUAL-SPEC.md 与 prototype.html（已有完整视觉方案和双首页原型）。

## 当前进度

视觉方案已提交 ea51050。应用实现仍在进行中，有未提交源码及新资源文件，全部保留。不要重置或覆盖。先检查差异与现有实现再续做；尤其检查 quick-note-metadata 与 quickNoteMetadata 两组相似文件是否重复或职责冲突。尚未确认最终编译、测试或验收通过，也未确认完成发布。

## 继续要求

只改 Workspace 与普通项目主页以及必要相关组件/后端，不扩展到 Focus。先向用户展示已有视觉方案，再继续完成实现和验证。遵循 HANDOFF 中全部视觉与交互约定；黑白灰为主、蓝色点缀、自然彩色封面。小熊仅 Workspace 右下角，小尺寸半身，身体略朝内、头看镜头，保留原 slogan。

用户未授权 review 子 agent，主 agent 自行 Standards / Spec 检查。源码变更前检查 tauri dev；编译测试静默，不擅自启动应用。

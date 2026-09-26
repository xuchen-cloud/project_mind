请在本会话独立完成「Workspace / Project 首页视觉升级」第一版。

用户已授权：基于 develop 创建新分支、新会话，携带参考图与已讨论结论，先生成完整视觉方案，然后开始修改。本会话即交接后的新执行会话。工作目录必须为 `/Users/xuchen/On My Mac/project_mind-homepage-visual-upgrade`，分支 `codex/homepage-visual-upgrade`；不要切换或修改原主目录。

首先读取 `AGENTS.md`、`CONTEXT.md` 和 `docs/design/homepage-visual-upgrade/HANDOFF.md`，真正打开该目录 references 下的五张图。前两张附图分别是最终 Workspace 与 Project 首页方向；其它图用途在 HANDOFF 中说明，旧图的蓝色大面积底色与旧导航已废弃。

严格按 HANDOFF 的顺序：先完成 `VISUAL-SPEC.md`、两种首页完整视觉稿/可查看原型、资源与状态规范，向用户展示后再修改应用源码；仅完成方案不算完成用户授权的第一版。随后实现并验证，只改两个首页与所需支持能力，不改 Focus 页、不做 Focus 悬浮 QuickNote 或全局重命名。用户后续如要求等确认，则服从后续指令。

启动时先简短确认已接手的目录/分支、参考图和“先方案后实现”顺序。落实当前作用域领域边界、标签联动、可靠的 QuickNote 自动保存与整篇转存、项目侧栏最近记录、右侧 Todo 视图切换与 File 能力、Workspace 底部小熊与 slogan。完整细节以 HANDOFF 为准。

仓库 Issues 是正式 PRD，先核对本交接目录的 TRACKING.md 获取工单；按 AGENTS.md 验证与发布流程执行。没有用户对 review 子 agent 的明确授权，Standards/Spec 均由本会话主 agent 自查。编译测试静默，不启动应用窗口；源码修改前排查 tauri dev 自动重启进程。需要界面验收提前告知用户。

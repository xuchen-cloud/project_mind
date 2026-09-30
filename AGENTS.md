## Agent skills

### Issue tracker

本仓库的议题和 PRD 使用 GitHub Issues 跟踪。详见 `docs/agents/issue-tracker.md`。

### Triage labels

议题分诊使用五个默认的标准标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库使用单上下文（single-context）领域文档布局。详见 `docs/agents/domain.md`。

### Publish flow

本仓库当前没有 CI 或外部 PR review 门禁。实现通过完整验证和 Standards / Spec 双轴 review 后，使用最小发布流程自动合并并关闭对应 Issue。详见 `docs/agents/publish-flow.md`。

### Local verification

编译和单元测试保持静默，不启动应用窗口。修改源码前检查是否已有 `tauri dev` 自动重启进程，避免代码变更反复打开窗口、打断用户工作。需要界面验收时集中执行，先告知用户；手动运行可用 `npm run dev:tauri:manual` 禁用 Tauri 文件监听。

### Review agents

启动子 agent review 前必须获得用户明确同意；未获同意时由主 agent 自行检查，不自动启动 Standards / Spec 子 agent。

### UI motion preference

同一页面元素在普通态与吸顶态、展开态与收起态之间切换时，默认设计连续的位移/缩放过渡，避免突然替换。滚动驱动的变化应跟随滚动进度、支持反向滚动，遵循 reduced-motion；标题与相邻卡片保持统一左对齐。

### Scroll affordance baseline

所有有界滚动列表默认遵循 `docs/design-system.md` 的“滚动区域与边缘遮罩”规范：仅在相应方向有隐藏内容时显示渐变，随滚动距离连续消失，并在内容和尺寸变化后更新。新增或修改列表时主动检查，工作区、项目、笔记和待办统一执行，不等待用户逐次提醒。

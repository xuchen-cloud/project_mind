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

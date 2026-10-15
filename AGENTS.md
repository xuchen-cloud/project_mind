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

### Verification scope and reuse

- 开始工作包时确定验收条件和受影响测试。开发中先运行针对性用例；失败后定位原因，只重跑失败项和受影响范围，不用反复全量运行代替诊断。
- 已通过的验证在相关代码、依赖、配置和环境未变化时复用，记录对应提交或改动范围、命令和结果。只有新改动、失败信号或未解决风险才扩大或重复验证，并说明原因。
- 纯文档改动检查 diff、链接和规则一致性，不运行应用构建或全量测试。纯 Rust 改动不自动重跑前端全量；若影响跨端 DTO、命令、事件或构建资源，再补对应前端/集成验证。
- 工作包收口时集中执行其完整验证；Issue 发布仍须满足 `docs/agents/publish-flow.md`，不能以减少重复验证为由跳过必要门槛，也不在发布时重跑仍有效的已通过检查。

### Implementation scope and defensive checks

- 实现以当前需求、真实调用路径和已复现问题为依据。不要为假设中的未来调用方、格式或故障组合增加兜底分支、兼容层、重试机制或通用框架。
- 在输入与信任边界校验；内部复用已建立的类型和不变量。只有跨异步、事务、锁或外部 I/O 后不变量可能变化时，才在必要位置再次核验，避免逐层重复检查。
- 权限、实际归属、CAS、幂等、数据完整性、资源预算及规格要求的崩溃恢复是必要约束，不属于可删除的过度防御。真实失败不得靠吞错、静默降级或放宽测试解决。
- 顺手发现的非阻塞问题记入后续工作包，不扩张当前包。直接影响本包正确性、数据安全或验收的问题在本包修复；完成既定验收后提交并进入下一项。

### Work package execution

每包开始前写清关联 Issue、依赖、交付行为、非目标、验收和验证范围。AI Enhancement 按 `docs/requirements/ai-work-context-delivery.md` 的执行拆分推进；已有实现先复用，只补差距。内部服务、真实接入和产品验收分别判断，阶段提交不能当作 Issue 完成交付。遇到缺少真实业务模块或平台的阻塞，记录具体解锁条件并继续可独立工作，不虚构接缝，也不无限打磨底层等待。

### Implementation agents

范围、输入输出和验收条件清晰明确的实现、测试或文档任务，交给 `gpt-6.1-sol` 模型的子 agent 执行，无需逐次询问。主 agent 负责需求澄清、架构与复杂问题决策、任务拆分、结果整合及最终检查；委派时明确文件范围、依赖和必要验证，避免多个 agent 同时修改相同文件或重复运行全量验证。简单到委派成本高于直接执行的改动由主 agent 完成。此授权适用于执行任务，review 子 agent 仍遵循下一条规则。

### Review agents

启动子 agent review 前必须获得用户明确同意；未获同意时由主 agent 自行检查，不自动启动 Standards / Spec 子 agent。

### UI motion preference

同一页面元素在普通态与吸顶态、展开态与收起态之间切换时，默认设计连续的位移/缩放过渡，避免突然替换。滚动驱动的变化应跟随滚动进度、支持反向滚动，遵循 reduced-motion；标题与相邻卡片保持统一左对齐。

### Scroll affordance baseline

所有有界滚动列表默认遵循 `docs/design-system.md` 的“滚动区域与边缘遮罩”规范：仅在相应方向有隐藏内容时显示渐变，随滚动距离连续消失，并在内容和尺寸变化后更新。新增或修改列表时主动检查，工作区、项目、笔记和待办统一执行，不等待用户逐次提醒。

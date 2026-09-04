# Publish flow

本仓库当前没有 CI，也不要求外部 PR review。功能实现完成后，以本地完整验证和 Standards / Spec 双轴 code review 作为合并门禁。

## Merge gate

进入发布流程前必须满足：

- 已按对应 Issue 完成实现与 TDD。
- 已运行该实现要求的完整验证，结果全部通过。
- Standards 与 Spec 双轴 code review 均已完成，且没有剩余发现。
- 最终提交包含已审查的完整变更。

## Minimal publish flow

满足合并门禁后，直接执行：

1. 推送实现分支。
2. 创建目标为默认分支的 PR。
3. 在 PR 正文中写入 `Closes #<issue-number>`。
4. 立即合并 PR，不等待额外的 CI 或外部 reviewer。
5. 确认 PR 状态为 merged，且对应 Issue 已自动关闭。

## Do not add redundant gates

执行 `/yeet` 时，不要重复：

- 探测或等待当前不存在的 CI checks。
- 探测外部 reviewer、review request 或 branch protection。
- 重新运行已经在 `/implement` 收尾阶段通过的完整测试。
- 为没有失败信号的发布增加额外审批或等待步骤。

## Exceptions

以下情况必须停止自动合并并处理实际阻塞：

- GitHub 拒绝合并、分支存在冲突，或 PR head 与已审查提交不一致。
- 本地验证或任一 review 轴未通过。
- 用户明确要求额外检查或人工确认。
- 仓库未来启用了真实的必需 CI、branch protection 或 review 规则；此时以 GitHub 的实际必需门禁为准，并更新本文档。

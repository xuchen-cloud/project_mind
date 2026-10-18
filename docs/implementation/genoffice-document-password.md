# GenOffice 文档密码：明确非目标

## 决策与范围

2026-10-18，用户明确不需要支持加密文档，停止 Issue #191 的加密支线。本项无加密功能交付，也不作为后续待办继续开发。

## 撤除清单

- 已删除本支线新建、尚未接入的 `packages/office-docx-crypto/`，包括源码、测试与固定样本、补丁、依赖锁、来源和许可记录、构建产物及包内安装依赖。
- 独立 crypto worker 仅讨论过 DTO，尚未创建实现或测试；`packages/office-runtime/docx-crypto-worker.mjs` 和 `packages/agent-host/src/docx-crypto-worker-entry.mjs` 均不存在。
- 此前密码研究、拟议 DTO、接入契约和独立适配器验证结果全部撤回，不代表产品支持或交付。不继续实施 native、session、CAS、宿主或 worker 加密接缝。

## 保留与冻结

已验收的 `packages/office-html2docx/` 及其实现文档保持不变。原有 Office runtime worker、agent-host 入口和测试保持不变，字体和只读重算工作不受影响。

本次只执行已确认属于本支线的文件撤除与文档更新，核对删除结果及保留文件的内容摘要；不运行构建、应用、全量测试或 git 操作。加密支线停止，helper 维持已验收冻结状态。

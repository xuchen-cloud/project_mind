# Phase 3：测试与文档审查汇总

来源：2026-11-10 基线 `fe9fe9c` 的 [测试审查](03a-tests.md) 与 [文档审查](03b-documentation.md)。两份原报告保留。本文汇总范围与证据约束，不新增重复缺陷，也不代表修复已通过。

## 测试

F1/F2/F3/F4/F6 探针证明旧缺陷可复现，需要转为正确行为回归；F5 需要真实普通保存入口。N1 需要真实 File lease 交错；N2 需要单文件故障注入且其余文件/Workspace 可用；N3 需要目录接受替换身份后 working 重开；N4 需要两条真实 DB 连接的 Project 录音启动事务。

Office 渐进验收必须区分已访问和从未加载的内容；仅首屏加载后两次累计编辑、保存、重开，均保留尾部与未修改 ZIP entry。G12 观察器独立 #307 正在接入 current working 协议；wrapper/orchestration 测试不充当原生验收。

## 文档 D1–D5

| 项 | 收口依据 |
| --- | --- |
| D1 | Record 可编辑状态发布时正文与 revision 同快照；由 records 修复 F2 后核对 |
| D2 | 区分明确未提交校验失败的修正重提、I/O 重试和未知提交结果的幂等回执；由 records 修复 F6 后核对 |
| D3 | 已在 PR #310 / 54e9315 核对：Voice 与普通 DB 独立连接；`voice_session_create` 在读取前 BEGIN IMMEDIATE，同事务 replay/唯一活跃 session/草稿写入。文档与 8 项真实双连接测试一致；Windows 录音现场不外推 |
| D4 | 历史固定版本性能结论不外推 current working-open；由 Office 原生渐进验收后核对 |
| D5 | 原生恢复 BLOB 只含最后成功提交；recovery-read 能力与用户入口分开，缺失入口不能记为已交付 |

## 平台与计数

基线去重产品问题仍为 16 项（8 P1、8 P2）；observer 是额外测试设施缺陷，D1/F2、D2/F6、D3/N4 和 D4/PERF 重复来源不重复计数。macOS、mock IPC、构建 portability 与 Windows 实机是不同证据。Windows 原生文件共享/录音、Office release 首屏及故障恢复未运行时必须明确保留。

Phase 4 与最终报告在本轮实际修改和必要验收后执行；本汇总不提前声明全流程通过。

## 已完成依赖核对

Native N1–N4 通用修复已合入 develop（PR #310，54e9315）；[最终结果](../verification/native/final-result.json)记录 290 项相关测试通过。D3 的独立连接、事务入口、原有 busy timeout、显式错误与采集前失败边界，已由 `docs/implementation/perf-package-F-20261027.md` 新节说明。D5 的 recovery-read 是原生能力；恢复 BLOB 仅代表最后成功提交的内容。此轮不把其视为已交付用户自助恢复界面。

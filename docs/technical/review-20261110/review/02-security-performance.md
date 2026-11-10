# Phase 2：安全、完整性与性能

基线与环境见 [范围](00-scope.md) 和 [测量限定](evidence/measurement-notes.md)。详细报告：[安全复核](02a-security-integrity.md)、[Office性能](02b-performance.md)。本阶段未修复下列架构缺陷；新增的缩放、浮窗、文件树工作包单独记录。

## Security Findings

- 独立复核保留 N1（锁序反转，P1）、N2（单文件 journal 冲突阻断全局，P1）、N3（同字节替换身份失配，P2）。已有权限、归属、CAS、回执和原子保存保障成立；未确认新的独立越权/路径漏洞，不重复计数。
- N1 的真实并发前提成立，完整应用＋真实 File lease 的三方故障注入仍未执行；N2 为静态错误传播证据。
- **主审原生补证 N3**：在隔离工作区把已经打开过的 `simple.docx` 用完全相同的37,956字节原子替换（inode发生变化），重新登记/resolve后，真实 `file_working_open` 在4ms内报 `Current File changed outside this working session; reconcile external content`。原生报告保存在 `evidence/native/same-content-replacement/`。这是macOS基线应用的实际复现，不是Windows证据。

## Performance Findings

| ID | 优先级 | 确认问题 | 主定位 |
|---|---|---|---|
| PERF1 | P1 | XLSX 等所有工作表/整表索引、公式、媒体预取完成才返回首屏 | `packages/office-xlsx/engine.ts:164` |
| PERF2 | P2 | DOCX 宿主全量解析/转换后，renderer 又完整解析，再分帧挂载 | `packages/office-docx/engine.ts:15`、上游 `file-actions.ts:399` |
| PERF3 | P2 | PPTX worker先生成整套slide布局，renderer从原件重建模型 | `packages/office-pptx/engine.ts:32`、`parity-entry.tsx:199` |
| PERF4 | P2 | XLSX 每个小范围请求在主线程filter整表cells/rows | `packages/office-xlsx/renderer-host.ts:45` |

| 可见原生样本 | 首次打开到稳定内容 | 其中working open | 切回大文件 |
|---|---:|---:|---:|
| Word，约20页 | 1.725s | 0.917s | 0.879s |
| Excel，新增10,000行及公式 | 6.151s | 3.886s | 3.159s |
| PowerPoint，40页 | 1.859s | 0.791s | 0.866s |

以上为macOS arm64 embedded-debug单次fixture样本，没有清除系统缓存，不是Windows/release/p95。保存observer仍基于旧接口，本次不据此声称Office保存验收通过。原始结果与fixture hashes见 `evidence/native/`。

Office建议按格式复用受控完整基线，先返回首屏依赖并建立按需范围/slide/block读取，保留未读取OOXML条目及累计编辑，保存始终对完整基线应用修改。不能将未加载部分当空内容序列化，也不能删除hash/CAS/预算来提速。详见02b的分阶段方案。

## Critical Issues for Phase 3 Context

- Phase1+2去重共14项：7项P1、7项P2；无已确认Critical/P0。质量4P1/2P2，架构2P1/2P2，性能1P1/3P2；安全复核不新增计数。
- 需要补充的是保存/关闭/旧正文与revision错配、校验失败恢复、真实并发锁序、journal外部冲突及未加载内容保存的行为测试，而非重复全量跑绿。
- 现有native benchmark遗漏`file_working_open`，导致45s假超时；仅生成脚本observer被临时适配后得到以上数值。后续应修正持久化性能/保存验收脚本本身。
- 普通Record p/hardBreak/空段落在隔离原生App保存成功，回主页能看到完整摘要；无法复现普遍立即保存失败。排版token没有随block引入变化，用户实际间距样本/设置尚缺，不能擅自修改全局行距。
- 用户新补充“每个新项目的会话列表都慢”，已另行追加真实列表/缓存/DSH启动链审查，结果追加报告；不得把全量会话内容预载到workspace启动当作默认修复。
- Windows实机环境不可用。voice开始时数据库锁机制与跨平台Office屏障已确认，但不宣称Windows现场根因已完全确定。

## Checkpoint

按上游full-review，在进入Phase3测试与文档审查前等待用户明确选择；新增独立UI实施工作可继续，不据此越过review checkpoint。

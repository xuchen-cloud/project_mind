# Phase 3B：文档与 API 审查

2026-11-10；当前 HEAD `fe9fe9c188f05c23bae369074446e38c0859a0c8`，同时以工作树当前源码为准。用户已明确批准 Phase 3 checkpoint。本包只交付此报告，未修改产品源码、产品文档或其他审查产物，未构建、测试、启动 GUI。

依据：已读 `AGENTS.md`、`00-scope.md`、`01-quality-architecture.md`、`02-security-performance.md` 及 full-review 上游 Step 3B。关联为既有审查，未新建 Issue；依赖现有规格、实现和前阶段证据。验收是逐项核对连续保存、Record 生命周期、录音启动、Office 首屏、失败恢复及平台证据，区分文档差距与代码缺陷。缩放、mention、文件树正在实施的工作包不在本报告结论内。

## 发现

### D1 · High · Record 加载契约未被异步注册路径完整履行（代码缺陷；复用 F2）

- **契约：** `docs/cache-strategy.md:47–53` 指定 canonical 正文与编辑基线来自原生读取，并在绑定、revision、注册就绪后允许编辑；`docs/requirements/ai-work-context-engineering-spec.md:468` 规定排队 autosave 基于对应 headRevision，禁止旧草稿无条件追写。
- **当前代码：** `src/hooks/useCanonicalRecordEditor.ts:54–70` 先读取正文及基线，再等待注册，最后发布先前的 `state`；同文件 `78–87` 的保存订阅可在等待期间只推进基线 revision/metadata。`src/lib/record-save-coordinator.ts:349–354` 随后移除已保存任务，使待保存快照无法必然补回新正文。于是正文与提交基线可来自不同时间点。前阶段 F2 的隔离时序证据仍与这些代码吻合；本轮未重跑实验。
- **判断与建议：** 这是代码未满足既定一致性要求，不能把规格改成允许旧正文覆盖。文档只需补一句可验收的不变量：“注册完成并发布可编辑状态时，正文和 revision 必须构成同一快照”；链接 F2 的已知限制，待修复后记录对应验证。没有证据要求重写全部 Record API 文档，也不把它概括为所有块保存都会失败。

### D2 · Medium · Record 不可重试错误缺少可执行的恢复说明（文档缺口；底层缺陷复用 F6）

- **契约：** `docs/cache-strategy.md:69–70` 区分可重试失败与退出/切 Workspace 的 flush barrier；工程规格 `docs/requirements/ai-work-context-engineering-spec.md:468` 的“查看差异/重载/另存 Record”针对冲突。这些描述本身没有承诺任意校验错误均可重试。
- **当前代码：** `src/lib/record-save-coordinator.ts:218–235` 跳过不可重试失败，`290–297` 又停在失败队首，修正后的提交仅追加至队尾（`172–192`）；flush 返回失败（`238–245`）。`src/hooks/useCanonicalRecordEditor.ts:137–148` 只为 `REVISION_CONFLICT` 建立 incoming conflict，`src/components/project/ProjectNoteFocusPage.tsx:652–670` 的恢复操作受该 conflict 条件控制。
- **影响与建议：** 不能指导用户“继续修改再点重试”来解除该队列，也不能声称退出重开能保留尚未落盘的正文。用一小段故障说明区分可重试 I/O、revision 冲突和不可重试校验错误：后者当前没有相同恢复入口，应保留编辑现场、另行复制可见内容并记录错误，避免把关闭应用当恢复办法。队列恢复入口仍需代码修复；文档补充不算 F6 已解决，也不新增一项同源代码缺陷。

### D3 · Medium · 独立 Voice DB 的并发边界未说明到“开始录音”事务（文档缺口；代码风险复用 N4）

- **已有说明：** `docs/adr/0007-serialize-voice-capture-into-one-terminal-session.md:3` 约束单一录音所有者；`docs/implementation/perf-package-F-20261027.md:7,22` 已准确记录 voice mutex 和独立 DB 连接。它们不等于所有 SQLite 写入被同一 mutex 串行化。
- **当前代码：** `src-tauri/src/lib.rs:282–295` 为普通 DB 与 voice DB 建立独立连接/锁；`src-tauri/src/voice/commands.rs:60–83` 只串行化 voice 路径。`src-tauri/src/db.rs:1084–1113` 的 Project 草稿事务先 SELECT 再 INSERT；`src-tauri/src/db/agent_operations.rs:111–115` 已解释另一写连接存在时 DEFERRED 升级的风险并采用 IMMEDIATE。`src-tauri/src/voice/runtime.rs:237–247` 表明草稿建立在实际 capture 启动之前。
- **建议：** 在包 F 的连接说明旁补充这个准确边界和 N4 链接：Project 开始录音可能与普通 Record/File 写入竞争；单录音约束、请求幂等和 busy timeout 不提供跨连接串行保证。故障记录应包含原始错误、Project/Workspace 目标、构建提交及当时是否有文件打开/保存。不能建议仅延长 timeout 或重新安装音频驱动，也不能把 N4 直接写成 Windows 现场已确定根因。实际事务修复与文档说明分别验收。

### D4 · Medium · Office 历史性能结论缺少通向当前 working-open 路径的适用性说明（文档衔接差距）

- **文档：** `docs/implementation/perf-package-G-office-20261027.md:3,7–9` 明示旧基线，并说明固定版本回执、锁外文件读取；`docs/implementation/office-first-open-performance-20261018.md:9,18–20` 将首屏正确绘制/可交互与分段计时区分开，且明确没有统一的 App 启动至文件就绪测量。这些历史记录不应被改写成错误记录，也不能直接外推到当前路径。
- **当前代码：** `src-tauri/src/file_working.rs:104–166` 等完整 `office.inspect` 模型后才返回；`src-tauri/src/db/file_working.rs:224–242` 在 IMMEDIATE 事务内校验磁盘并读整份恢复内容。`packages/office-xlsx/engine.ts:151–159,164–208` 等整表索引并遍历各表、公式及媒体后才返回模型。分块读取/renderer 延迟绘制不等于首屏已绕过全量准备。
- **建议：** 在当前保存说明链接上述历史报告时，加一条当前路径限定：GUI 使用 `file_working_open`，旧固定版本路径的锁外 I/O 与耗时证据不能自动覆盖它；当前尚不能宣称“先可用首屏、剩余内容随后加载”已交付。性能原因复用 PERF1–PERF3，不另计代码缺陷。本阶段不要求新增 CI 或补跑基准；后续验收须明确命令路径、构建模式、样本和计时起止。

### D5 · Medium · File 原生恢复能力与用户可达恢复流程没有明确区分（文档/产品接入缺口）

- **已核对契约：** `docs/implementation/file-working-content-notes.md:9–18,24–34` 已覆盖请求字段、双 CAS、累计 edits、固定 session 基线、精确重试、15 分钟归档、schema 40 和 AI handoff；`CONTEXT.md:135` 同样区分当前内容和历史。无需重复编写完整 API 手册。
- **缺口证据：** 原生说明 `file-working-content-notes.md:16,30` 的“最新成功保存恢复字节”真实存在于 `src-tauri/src/db/file_working.rs:910–941`，且是单份覆盖的恢复 BLOB；但 `src/services/fileWorkingApi.ts:32–41` 没有 recovery-read 封装，本轮搜索 `src/` 未见该命令调用。`src/hooks/useFileWorkingErrors.ts:13–20` 仅显示“文件历史归档失败”和错误详情，没有引导恢复操作。原生存在不等于用户已有恢复按钮。
- **建议：** 在现有连续保存说明增加简短状态/处理边界：当前内容保存成功与历史归档失败是不同状态；恢复副本只涵盖最后成功提交，不含仍在编辑器内的输入；当前原生 recovery-read 尚未接入用户流程。外部冲突发生时先保留双方内容，不能宣称自动覆盖或让用户删除 journal/工作区数据库。若产品要求用户自助取回恢复副本，必须单独完成入口接入及验收，不能用文档声称已可用。

## Windows 与证据边界

- `docs/implementation/file-save-sessions.md:43` 明确没有原生 macOS GUI/Windows 验收；`docs/implementation/office-first-open-performance-20261018.md:139` 明确 Windows 交叉编译及实机未完成。没有据此发现“Windows 已通过”的虚假声明。
- `docs/requirements/voice-record-decisions.md:19` 和 `docs/technical/voice-performance-20261101.md:21,66–68` 明确模拟队列、Mac 性能、Windows CPU/WASAPI 是不同证据，并由 #294 跟踪目标机验收。保留这些限制，补充开始录音的 DB 并发场景即可；不扩张为全平台文档工程。
- 本轮只重新核对源码。前阶段 macOS embedded-debug 单次 Office 样本、SQLite 双连接探针和 mock IPC 时序均不能替代 Windows 发布包验证；未把 N4 定为用户现场唯一根因，未对未完成的缩放/mention/文件树包作完成判断。

## 交付限定

README 已有开发/构建入口（`README.md:33–85`），连续保存文档已有迁移及请求/响应约束，故不提出泛化的“补全所有文档”、依赖过时或新建 CI 建议。本报告的新增工作是有限的契约补充、当前路径交叉链接和恢复指导；F2、F6、N4、PERF1–PERF3 仅作源码复核，不重复增加前阶段问题计数。无 Critical 文档发现。

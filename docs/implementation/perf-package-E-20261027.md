# 包 E：Office 编辑端重复计算

基线：`5de9a91`，分支 `fix/performance-review-20261027`。本包不提交；主 agent 统一整合和验收。

## 范围与验收

- 关联：#191 / #118；性能审计 E04 / E05。
- 依赖：已有 Office 固定版本/CAS 保存、DOCX beforeSave、Excel 重算请求契约；遵循 ADR-0003 的已提交内容边界和 ADR-0009 的原生授权/回执边界。
- 交付：DOCX 完整字节生成前合并输入，保存/输出/离开强制 flush；XLSX 索引等待削减重复 range 读取，相同 baseline 和相同内容的并发重算共享调用。
- 非目标：native Office / PPT / ProjectFileContent；不削减全工作簿 prefill 或公式/媒体字段，不保留无界 sidecar 会话。
- 验收：10 次连续输入只构建最后状态；IME 阻止未完成组合输入保存；异步粘贴、嵌套输入、显式保存和导出得到最新状态；重算不同请求不丢结果，错误与 baseline 失效继续拒绝。
- 验证范围：DOCX host 调度计数回归，XLSX 索引等待计数回归，OfficeFileContent 重算/保存生命周期测试；XLSX 包类型检查和针对性真实引擎用例。无运行中的 tauri dev/Vite watcher，未打开应用窗口，未运行全量测试。

## 修改文件与行为

| 文件 | 修改 |
|---|---|
| `packages/office-docx/renderer-host.ts` | 300ms 连续输入合并发生在 `buildDocBytes` 前；异步粘贴完成和 IME compositionend 只安排合并任务。后台构建过期后等待下一次输入稳定，不立即反复构建；显式 flush 取消等待、提交嵌套输入、等待异步操作并采样实时 Tiptap 状态，构建中出现更新则继续排空最新 revision。销毁取消定时器；失败继续通过现有错误通道上报。 |
| `packages/office-docx/test/renderer-host-scheduling.test.mjs` | 执行真实 host 源码，替换 DOM、时钟和字节构建器；覆盖连续输入、嵌套输入、IME、异步粘贴、过期后台构建、输出、销毁、实时 editor 状态、并发 flush、粘贴和构建失败/重试。 |
| `packages/office-xlsx/engine.ts` | 首次 range 立即读取；索引未完成时从 25ms 递增等待，上限 250ms，保留 5s 截止与真实错误；完整 prefill、公式、行纲要、媒体及所有返回字段保持原逻辑。 |
| `packages/office-xlsx/tests/range-indexing-scheduling.test.mjs` | 执行生产 `loadedRange` 函数，使用确定性索引时钟记录真实调用次数；验证裁剪、就绪、截止和传输错误。 |
| `src/components/office/OfficeFileContent.tsx` | 按 lifetime、完整 baseline、完整 recalculation JSON 合并相同在途请求。不同 edits/reads 分别计算；结果不持久缓存，成功和失败都移除在途记录，后续请求重新经过原生验证。保留完成后的 lifetime / version / hash 检查；切换和卸载清除索引。 |
| `src/components/office/OfficeFileContent.test.tsx` | 50 个相同在途请求只发起 1 次原生调用；与不同编辑并发时每个调用返回对应结果；同请求错误共享但允许显式重试；共享请求在关闭或保存更换 baseline 后一起拒绝。 |

已有 `DocxEditor.registerBeforeSave` → `full-editor.beforeSave` → `host.flush(true)` 与 OfficeFileContent 的离开 flush 链路继续复用。输出仍经 `host.output` 先强制 flush。未改 File 保存/CAS、权限、幂等和回执。

## TDD 与验证结果

1. 修改生产源码前：
   - `node --test packages/office-docx/test/renderer-host-scheduling.test.mjs packages/office-xlsx/tests/range-indexing-scheduling.test.mjs`：初始 9 项中 5 项失败。Word 10 次独立脏 render 实际构建 10 次；异步操作开始前已排入的旧构建继续执行；后台过期构建立即重建；XLSX 索引等待 1s / 5s 分别读取 101 / 501 次。
   - `npx vitest run src/components/office/OfficeFileContent.test.tsx -t 'coalesces identical|shares a failed' --maxWorkers=1`：新增 2 项均失败，相同并发请求未共享原生调用。
2. 修复后：
   - `node --test packages/office-docx/test/renderer-host-scheduling.test.mjs packages/office-xlsx/tests/range-indexing-scheduling.test.mjs`：12/12 通过。Word 10 次连续更新合并为 1 次构建；强制 flush 不等待 300ms；并发显式 flush 共享构建并保留最后 revision。
   - `npx vitest run src/components/office/OfficeFileContent.test.tsx --maxWorkers=1`：30/30 通过，包括原有只读、保存错误、原生回执、输入 flush、输出和关闭生命周期。
   - 后续只加强了关闭/保存换 baseline 的两个共享请求用例，使用 `npx vitest run src/components/office/OfficeFileContent.test.tsx -t 'rejects a calculation completed' --maxWorkers=1`：2/2 通过；此前其它用例结果复用。
   - 后续只给索引测试增加计数诊断，`node --test packages/office-xlsx/tests/range-indexing-scheduling.test.mjs`：3/3 通过。索引在 1000ms 就绪时实际读取 **8 次**、模拟等待 1125ms；一直未就绪时 **24 次**、等待严格 5000ms；立即就绪只读取 1 次。退避最多增加约 250ms 的索引就绪发现延迟。
   - `cd packages/office-xlsx && npx tsc --noEmit --project tsconfig.json`：通过。
   - 对包 E 修改的 tracked 文件执行 `git diff --check -- ...`：通过。

### 真实引擎验证和已确认的环境阻塞

使用 esbuild 的 `engine.ts` 单入口构建生成忽略目录中的 `dist/engine.mjs`，没有执行会重新提取 vendor/upstream 的完整构建脚本，没有修改 native 源码。构建参数沿用包构建脚本的 Node22/ESM、gateway aliases 和 createRequire banner。

`cd packages/office-xlsx && node --test --test-name-pattern='identical XLSX bytes|saving typed edits|blank, numeric text|loadRange|range' tests/engine.test.mjs`：

- 2 项通过：同内容 inspect 的完整快照身份稳定；inspect / loadRange 范围预算与裁剪。
- 2 项失败：typed edits 和 scalar 区分保存的原生重算。当前 `dist/xlsx-sidecar` 为 2026-10-18 的旧可执行文件，结果中缺少当前必需的 `cells[*].value`。
- 用临时 bundle 分别执行 `git show HEAD:packages/office-xlsx/engine.ts` 和修改后源码，同一真实 fixture、同一显式 binaryPath、同一编辑输入，均得到 `ZodError`，首个路径都是 `cells[0].value`；native 源码 `RecalcCell.value` 已存在。此失败在基线上已存在，未修改 schema 吞错或兼容旧协议。
- 解锁：主 agent 在统一原生构建阶段运行 `npm --prefix packages/office-xlsx run build:native`，再仅重跑上述两项失败及真实 recalculate 的结果/错误/跨表验证。本包不自行扩展 native 工作或与其它包争用完整原生构建。

另外用透明 sidecar wrapper 记录真实命令，依次 inspect simple、complex、从 simple 生成的 40000 行稀疏样本：

| 样本 | sidecar 启动 | read_range | 工作表 | 返回实际单元格 | visuals | 公式清单工作表 |
|---|---:|---:|---:|---:|---:|---:|
| simple | 1 | 4 | 2 | 23 | 0 | 2 |
| complex | 1 | 4 | 3 | 25 | 2 | 3 |
| sparse-40000 | 1 | 4 | 2 | 24 | 0 | 2 |

该实验使用生产 inspect 和旧 sidecar 的可用读取协议，确认多表、稀疏范围、图表/图片和公式字段仍读取完整；不是 UI 绘制或原生重算验收。一次观测耗时分别为 524/65/64ms，含 wrapper 和共享工作区系统竞争，不能据此声称耗时改善。真实 DOCX 压缩耗时、主线程长任务、连续 50 次不同编辑的原生重算 CPU/RSS 尚未测量，交由集中集成验收。

## 主 agent 协调事项与明确接口边界

### 同 baseline 初始化复用

目前只合并**内容完全相同且仍在途**的请求；50 个不同编辑或顺序执行的请求仍保持独立结果。仅凭 baseline 把不同 edits 合并或只保留最后一次，会失去每次调用的结果/错误，未这样实现。

现有 `packages/agent-host/src/office-worker-entry.mjs` 每进程只读一帧后退出；`withWorkbook` 每次拥有临时目录和 sidecar，finally 停止/删除。只在 engine 内加全局 Map 无法跨 utility 进程复用。

需要主 agent 在 native/utility 侧提供**宿主私有、进程固定归属的 baseline lease**：

1. 原生用 `(Workspace UUID, generation, ObjectRef, versionNumber, contentHash)` 获得已验证不可变源的 lease；每次重算仍重新检查当前权限、实际归属、固定版本及操作完成后的失效条件。lease/路径/native sessionId 不进入 renderer。
2. 同 lease 的 utility 可以复用临时源文件、sidecar、open metadata；每个请求保留 requestId 与独立的完整 edits/reads。计算必须从相同不可变 baseline 施加本次 overlay，不能把上次请求的临时编辑带入下次；可先串行处理以确保当前 native 计算缓存语义。
3. 提供 Workspace 关闭/generation 变化、文件 baseline 更新、编辑器关闭的 release/invalidate 信号，并落实字节/进程/会话容量、空闲到期和崩溃释放。只有该真实所有权与生命周期接口建立后，才把 `withWorkbook` 拆为可获取/释放初始化上下文的私有调用。

以上是解锁接口要求，未添加不可用的 renderer capability 或持久缓存框架。

### 隐藏编辑器

本包没有创建 `visible` prop。隐藏状态需要 D 包/主 agent 从实际 tab 激活状态向 OfficeFileContent 和格式控制器传递；当前指定文件之外的通路不由本包虚构。暂停渲染必须保留草稿、beforeSave/输出 flush、最新状态和错误；本包已完成可独立验证的编辑计算修复。

## 第一阶段结论（后续E05追加已更新）

E04 编辑计算修复和 E05 索引等待/相同在途重算去重已实现且针对性回归通过。真实原生重算、长期 baseline 初始化复用和隐藏编辑器生命周期尚不视为完成；以上具体解锁条件交由主 agent 集中整合。未编辑主执行记录，未提交或推送。

## E05 追加交付：原生私有 baseline lease

主 agent 在第一阶段记录之后明确授权跨层实现，并交接稳定的 E01/E02/E03。以下覆盖前述“同 baseline 初始化复用待解锁”的状态；D 的 OfficeFileContent 可见性工作由主 agent/D完成，本阶段没有再次修改该组件。

### 范围和接口

- `src-tauri/src/file_office.rs`：真实 `FileOfficeService::recalculate` 每次仍执行现有 retained byte读取/哈希、前后授权和固定计划复核。在授权DB锁内取得私有代次上下文；真实 `OfficeUtility::recalculate` 接收上下文，成功/失败都先复核权限和固定源，再向调用方返回。
- `src-tauri/src/office_worker.rs`：OfficeUtility增加私有重算方法，默认沿用现有request路径；真实OfficeWorker/AppOfficeUtility接入lease，普通inspect/edit/create继续沿用one-shot。没有新增renderer命令、sessionId或lease capability。
- 新增 `src-tauri/src/office_recalculation.rs`：仅为当前真实重算调用服务的私有池；每个完整 `(binding, ObjectRef, versionNumber, contentHash)` 独立排队。每次保留requestId、完整edits/reads和独立结果/错误，串行处理同lease并发请求；不同baseline互不借用结果。
- `packages/agent-host/src/office-worker-entry.mjs`：原生私有 `--recalc-baseline` 模式读多帧，帧仍受180MiB预算约束；源字节仅初始化发送一次，后续请求不能替换源。stdin EOF独立监听，能打断正在等待sidecar的请求。
- `packages/office-runtime/worker.mjs`：私有会话只接受recalculate及原有严格字段/预算，保留每帧requestId；原公共one-shot方法、错误、编辑和创建路径保持原逻辑。
- `packages/office-xlsx/engine.ts`：拆出可关闭的workbook初始化，复用原Sidecar/metadata和只读源。缺少公式`<v>`时生成的`formula-import.xlsx`也只准备一次；每次发送完整overlay。原native RecalcCache在overlay移除键时从不可变源重建，保持undo结果；未修改native Office/PPT或删除prefill字段。
- 新增 `packages/office-xlsx/tests/recalculation-session.test.mjs`、`packages/agent-host/test/office-recalculation-session.test.mjs`，Rust相关测试放在新模块内部。
- `src-tauri/src/lib.rs`：在G3的三处清理位置各加一条`office_worker::clear_baselines(binding)`，不改F的idle/退出恢复实现。

### 预算和释放

- 共享原Office进程信号量，最多2个utility worker，每个拥有自己的sidecar；普通one-shot工作会逐出未使用的warm lease，不会被两个空闲worker占满准入。
- 压缩baseline最多64MiB/个，池内最多128MiB、2个entry。64MiB来自原 `engine.ts LIMIT_BYTES`，与已有XLSX计算能力一致；通用Office retained read和其它格式100MiB能力没有改小。128MiB是源字节预算，不是公式图/整个进程RSS上限。
- 空闲检查间隔30s：满足30s空闲且没有请求使用时释放，因检查周期，释放发生在最后使用后30–60s内。Workspace关闭/切换/退出主动释放，不等待空闲检查；老代次的晚到请求不能回填。
- 缓存持有的Session保留原进程permit、私有TempDir和ProcessTree所有权；请求执行时从缓存取出Session，取消future或出错会Drop并杀整个进程树，成功才归还。关闭能在不等待请求锁的情况下直接终止正在计算的树。
- 原生父App SIGKILL不运行Rust Drop。Unix私有worker直接监听原生stdin EOF，对原生创建的私有进程组发SIGKILL，独立于计算await；Windows沿用现有kill-on-close Job Object。这里的真实SIGKILL证据仅针对新增persistent重算路径和当前Unix主机，未声称验证Windows或其它one-shot路径的父崩溃行为。

### 回归先行与实际计数

1. 新增session调用测试先复现缺少初始化复用（export不存在）。随后真实50次不同编辑通过。
2. 再补合法工作簿缺少公式`<v>`的样本：50次调用实际得到50次native模型导入，回归失败；固定计算源只准备一次后，结果变为1次导入/49次复用。
3. 真正启动原生父fixture、生产Office Node入口、透明sidecar wrapper和真实native XLSX sidecar，在`recalc_cells`请求在途时对原生父进程执行SIGKILL：原实现worker/wrapper/sidecar均仍存活，回归失败。独立EOF终止后，三者全部退出。测试确认父进程退出信号为9，失败路径自带独立清理，未依赖优雅退出。

| 真实样本 | 不同编辑次数 | sidecar启动 | workbook open | native模型导入 | native模型复用 |
|---|---:|---:|---:|---:|---:|
| simple.original.xlsx | 50 | 1 | 1 | 1 | 49 |
| 同样本移除所有公式`<v>` | 50 | 1 | 1 | 1 | 49 |

以上由透明wrapper记录真实进程、open、recalc_cells及native返回的cached字段。另有Rust生产池回归：连续50次不同编辑+2个并发调用只启动1个原生拥有的Node worker，两个并发结果分别为34和58，未把不同请求合成最后一次结果。

### 已通过的定向验证

没有运行Cargo，继续由主 agent串行协调。`$TMPDIR/build-perf-e05-harness.py`以已有rlib直接编译生产office_worker/office_recalculation/office_process/node_paths和文件内测试，仅替换外围AppHandle/模型类型，不打开窗口。

- `python3 $TMPDIR/build-perf-e05-harness.py`：生产模块和测试编译通过。
- `$TMPDIR/perf-e05-harness office_worker --test-threads=1`：11通过、1个原有环境条件忽略；包括6个新增条目（其中1个是只在子进程环境启用的fixture），覆盖50次真实编辑/并发、预算、空闲释放、generation关闭、取消/超时/关闭杀树和父SIGKILL。
- `MIND_OFFICE_TEST_NODE=src-tauri/resources/agent-host/node $TMPDIR/perf-e05-harness office_worker_permissions_protocol_and_timeout --ignored --test-threads=1`：上面的忽略项单独1/1通过，使用固定Node24.21.0。没有放宽权限测试。
- `node --test packages/office-xlsx/tests/recalculation-session.test.mjs`：3/3；包括上述两个50次真实计数样本、独立overlay、undo、错误后重试和close。随后只给第一个测试增加公式错误/最新数值断言，`node --test --test-name-pattern='one private baseline' packages/office-xlsx/tests/recalculation-session.test.mjs`：1/1通过，前述两个计数结果复用。
- `node --test packages/agent-host/test/office-recalculation-session.test.mjs`：1/1，50个不同requestId/输入完整保留，不能替换私有源，失败与undo互不污染，关闭后拒绝。
- `node --test --test-name-pattern='recalculation' packages/agent-host/test/office-worker.test.mjs`：5/5，复用严格边界、预算及真实错误契约。
- `node --test packages/office-xlsx/tests/range-indexing-scheduling.test.mjs`：3/3；本轮engine函数拆分后再次确认原E05轮询修复仍有效。
- `cd packages/office-xlsx && npx tsc --noEmit --project tsconfig.json`：通过。
- 对追加文件执行 `git diff --check`：通过。

### 主 agent 集成门槛与限制

Rust实现已stable，并已向主 agent报告可供C编译，本包不占用Cargo。前端组件D的改动、原Office CAS/幂等和G3主 agent后续quota修复均保留。

本轮仅构建了新的XLSX engine入口到忽略的dist，没有再次编译native sidecar，也没有重复主 agent已安排的旧value协议失败项。**打包分发尚需刷新**：源worker/entry与engine已经改变；请在当前Cargo结束后按现有流程组装并stage，再进行真实FileOfficeService/打包验收：

```sh
node scripts/office-distribution.mjs aarch64-apple-darwin
node scripts/stage-office-runtime.mjs darwin-arm64
```

这是当前机器目标，不是跨平台目标选择的替代。无需重跑三个格式的native构建；后续发行仍按正常构建流程。建议主 agent追加受影响Cargo过滤 `office_worker` 和 `file_office::tests::office_recalculate`（串行/固定Node），再完成其已安排的XLSX包与真实服务集成验收。

剩余边界：

- 新测试已覆盖独立结果、typed formula error、undo和在途清理；真实GUI输入到原生数据库服务的50次CPU/RSS/p95尚未量化，不以wrapper计数宣称这些指标改善。
- overlay缩小会触发既有native安全重建，保证恢复baseline；没有为追求缓存命中而保留上次已撤销的编辑。
- 本阶段不新增renderer“关闭lease”接口；编辑器停止使用后由有界空闲寿命/逐出释放，Workspace生命周期立即释放。
- 父SIGKILL测试确认进程退出；异常终止时操作系统临时目录的磁盘清理不等同Rust TempDir正常Drop，未把进程清理证据当作跨平台临时文件恢复验收。

E05跨层初始化复用实现完成，代码和定向回归就绪；主 agent仍负责最终Cargo/打包/产品整合验收和统一提交。未编辑主执行记录，未提交/推送。

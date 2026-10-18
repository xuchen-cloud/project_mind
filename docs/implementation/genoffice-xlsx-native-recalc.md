# GenOffice Excel 原生只读重算（#191）

## 工作包

- 依赖：已有 `FileOfficeService` 固定源读取与权限复核、Office utility 进程边界，以及 `packages/office-xlsx/engine.ts` 的 `recalculate` 与公开请求/结果类型。
- 交付：`file_office_recalculate` 接收 binding / requestId 与固定 File baseline、`recalculation: { edits, reads }`，调用 IronCalc 后返回计算结果。
- 非目标：写入 File、创建版本、重用持久 workbook session、传递文件路径或凭据、修改格式包/根 Cargo/lib、全量构建或应用窗口验收。
- 验收：真实归属与授权检查；仅 XLSX；等待后再次核验绑定、权限、版本、hash；请求最多 10000 edits、200 reads、累计 100000 cells，严格未知字段与值预算；无新版本或源字节变化。
- 验证：仅受影响 worker Node 用例、宿主服务 Vitest、Rust DTO/服务/utility/受签名影响的 DSH 用例。真实 utility 与集中发布验收由主 agent 统一运行。

## 契约

```text
file_office_recalculate({ input: {
  binding, requestId,
  data: { object, versionNumber, expectedContentHash,
          recalculation: { edits: [{ sheetId, row, column, input }],
                           reads: [{ sheetId, range }] } }
} }) -> ApiResponse<{ cells }>
```

- GUI 授权通过 `gui_request(..., false)` 从真实 File 归属导出，仅需 `source.read`。服务使用与 `inspect` 相同的固定保留版本读取，不把历史版本擅自换成最新磁盘内容。
- 原生请求、recalculation、edit、read、range 均 `deny_unknown_fields`；拒绝路径、sessionId、凭据与伪造授权。值验证检查 XLSX 坐标上界、非空 sheetId、正向范围，`input` 最多 32767 UTF-16 units（与上游 Zod 字符串长度一致），并落实三项集合/累计预算。
- 用 `OfficePayload::{Inspect, Edit, Recalculate}` 明确分离三种操作。DSH 的会话存活/撤权 delegate 与已有 mock 同步签名，原 edit 的 256 项 Node 边界保持有效。
- `OfficeWorker` 沿用固定 Node/entry/sidecar、100 MiB 源字节限制、180 MiB 帧限制、进程权限、临时目录、并发和超时机制。新增操作仅允许 XLSX，源编码必须非空且 canonical base64。
- utility 对操作、格式、顶层字段和粗预算先检查，再调用既有 `engine.recalculate`。引擎复用 `workbookRecalcRequestSchema` 的 edits/reads 严格子 schema，并检查累计范围、Unicode 和真实 sheetId；没有创建第二套 JS 坐标/value schema。
- 只读重算直接返回 `RecalculateResult`；不调用 edit/inspect，不返回 candidate base64，不执行 stage 或 commit。等待后重新执行固定源读取以核验当前绑定、授权、真实所有者和同版本 hash。结果再次按严格 native DTO 验证。
- 前端 `officeFileApi.recalculate(binding, { ...baseline, recalculation }, requestId?)` 仅 `import type` 格式包类型，使用已有 `callAgentCommand` 保留结构化错误和响应身份检查。

## 验证记录

### 2026-10-16：实现与回归

TDD RED：新增 Node 重算路由/预算/错误用例中 3 项失败；新增前端服务 3 项因方法尚未实现失败；Rust 的 3 项服务用例在 `recalculate` 尚为 `todo!` 时失败。随后补实现与更多边界用例。

- `node --test packages/agent-host/test/office-worker.test.mjs`：9 passed / 0 failed。临时测试目录中的 stub engine 仅验证路由和数据边界，不冒充真实 IronCalc 验收。
- `npx vitest run src/services/officeFileApi.test.ts --maxWorkers=1`：3 passed / 0 failed。
- `cargo test --manifest-path src-tauri/Cargo.toml --config 'profile.test.package.project_mind_alpha.debug=0' --lib office --quiet` 首次为 20 passed / 1 failed / 4 ignored。失败来自测试尝试直接修改不可变版本 hash，被数据库触发器正确拒绝；改为篡改真实保留版本快照字节后，仅重跑 `--lib office_recalculate_rechecks_fixed_version_hash_after_async_computation --quiet`，1 passed。其余代码未变，合计有效结果为 21 passed / 0 failed / 4 ignored。
- Rust 覆盖读取权限与真实所有者、固定源 hash、等待期间版本消失/快照被改/所有者变化/工作区 generation 变化、DTO 各层未知字段、UTF-16 输入预算、10000 edits / 200 reads / 100000 cells 精确边界，以及原 Office 保存/历史版本/DSH delegate 回归。只读测试同时断言原字节、版本号及版本记录数未变。

### 2026-10-18：恢复后的定向核验

默认系统 Node 已变为 26.8.1，以下检查明确使用打包的 Node **24.21.0**：

```sh
src-tauri/resources/agent-host/node --test packages/agent-host/test/office-worker.test.mjs
src-tauri/resources/agent-host/node node_modules/vitest/vitest.mjs run src/services/officeFileApi.test.ts --maxWorkers=1
```

- worker：9 passed / 0 failed；API：3 passed / 0 failed。
- 随后修正 worker 的 schema 错误传播用例：使用合法顶层请求，让嵌套未知字段到达 stub engine，断言其 `ZodError` 被转换为 `INVALID_ARGUMENT` 及保留消息。定向重跑 `--test --test-name-pattern='preserves engine schema' packages/agent-host/test/office-worker.test.mjs`：1 passed / 0 failed；其余 8 项结果复用。
- 本轮沿用同一 Cargo 配置、默认 features，编译并执行 `--lib office --quiet`。首次 20 passed / 1 failed / 4 ignored；失败为既有 `office_directory_staged_save_recovers_every_durable_boundary_and_replays_once` 的 phase 1 子进程 `signal() == None`，单独执行旧产物也复现。原断言只输出 stderr，未记录退出码/stdout，因此无法据此确定原因。
- 只增强该断言的诊断（完整 status/stdout/stderr），未改恢复逻辑或放宽断言。以相同配置定向重编译并运行 `--lib office_directory_staged_save_recovers_every_durable_boundary_and_replays_once --quiet`：1 passed。再执行同一已编译产物 `src-tauri/target/debug/deps/project_mind_alpha_lib-b18d1a732714fd2e office --quiet`，最终 **21 passed / 0 failed / 4 ignored**（6.04 s）。先前异常退出的原因尚未确认，不把后续通过描述成已定位修复。
- 新增的 ignored 真实重算分支已随上述主库测试编译；本包 Rust 文件的 `rustfmt --edition 2021 --check` 通过。编译没有启动窗口，也未增加依赖、feature 组合或运行根全量测试。

## 尚需主工作包完成的真实验收

- 既有 ignored 用例 `office_real_formats_native_save_reopen_and_retained_history` 的 XLSX 分支已加入只读重算：原件字节 + 两项 edits，读取本表与跨表公式均预期 40，并在后续真实保存前断言 File 原字节及版本 1 未变。这是已编译、待执行用例，不能视为真实 IronCalc 已通过。由主 agent 完成最终格式 dist / pinned Node / sidecar stage 后统一运行。
- macOS 已执行的是原生权限/存储服务测试及 worker/API 路由测试；本包未执行 Windows 编译或实机测试。平台实现与真实平台验证分别记录，不能由一侧结果推断另一侧通过。
- 宿主 callback、统一 stage、真实 utility、最终 Standards / Spec 检查与 Issue 发布由主工作包整合。本包不自行启动应用、根全量构建或发布。

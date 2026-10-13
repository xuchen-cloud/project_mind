# XLSX 薄宿主交接（实际运行接口）

主 agent 可以继续 GUI 验证，不必重做引擎实验。引擎实验目录为 `/tmp/project-mind-genoffice-xlsx-validation-20261013`，归档复跑会在调用者指定的空 scratch 中重建以下文件。

## 当前可用产物

- `integration.bundle.mjs`：Node ESM，导出 `XlsxSidecarClient`、`SheetSession`、`saveWorkbookViaSidecar`、`workbookViewModel`、`prepareFixtureSave`。已 bundle 上游公开源码，解决上游 workspace 的 ESM/CJS 边界；不能在浏览器运行 Node 文件能力。
- `target/debug/xlsx-sidecar`：macOS arm64 实际编译成功的 Rust CLI。其他平台需用固定 Cargo.lock 编译、分发；本次不宣称已支持所有平台。
- `view-model.mjs`：可直接在浏览器 import 的纯数据转换，零第三方依赖。`simple.view-model.json`、`complex.view-model.json` 为真实 sidecar 导入结果。
- `simple.edited-ironcalc-cache-sheet-touch.xlsx`、`complex.edited-ironcalc-cache-sheet-touch.xlsx`：独立校验全部通过的真实导出。其余分支和失败见 `results.json`。

## 最小调用

```js
import { XlsxSidecarClient, SheetSession, workbookViewModel, prepareFixtureSave } from './integration.bundle.mjs'
const client = new XlsxSidecarClient('/your/scratch/target/debug/xlsx-sidecar')
const session = new SheetSession(client, '/your/scratch/simple.original.xlsx')
try {
  const imported = await session.open()
  const view = workbookViewModel(imported) // 返回给 React；保存 raw metadata/ranges
  session.setCell('明细', 2, 0, '香蕉（SDK编辑）')
  session.setCell('明细', 2, 1, 15)
  session.setCell('明细', 4, 1, '=SUM(B3:B4)+5')
  const { recalc, formulaValues, marker } = await prepareFixtureSave(session)
  // 已实际测过的调用；只支持本组数值公式，错误直接抛出。
  session.edits.push(marker) // 显式启用 cache-sheet-touch 分支
  await session.save('/your/scratch/browser.edited.xlsx', formulaValues)
} finally {
  await session.close()
  client.stop()
}
```

`setCell` 参数和 wire 坐标都为 **0 基**。SDK 读回公式含开头 `=`，归档保留 raw 并做仅允许开头 `=` 差异的语义比较。`styleIndex` 指向 sidecar 返回的 `metadata.styles`；值修改不发送格式重置。不要用 React 样式重新生成 OOXML。

## 主宿主的边界

Node 端保持 workbook 会话、读原件、生成计划与调用 Rust；React 端只持有 view model 和编辑命令。可用现有 Node runtime/受控本地 RPC 或 Tauri→Node 桥接。文件路径须由主 File 服务根据 File ID 解析；主应用必须承担权限、真实归属、session→File 映射、CAS/版本/hash、编辑串行化及最终业务提交。本包 `SheetSession` 是受控样本接口，**不提供这些产品约束**，也不是完整 viewer。

本包 `open()` 为小样本一次性读取全表，不能直接用于大表。上游真实 `readRange` 可分页，元数据有尺寸/隐藏/冻结、styles 与 visuals，`readMedia` 可按 visual ID 获取图片。复杂表图表/图片/CF/DV 的 **文件保留通过**，不等于这个薄宿主已实现对应的视觉渲染或编辑。

## GUI 验收交接

可测试两份原件：键盘编辑 A3、B3、B5；保存后回到这里的 `compare`/ZIP 校验并用 sidecar 再读。重点是 A3 字体未丢、原 styleIndex 未重置、跨表缓存已提交、creator/Company 未变，以及主页面不额外打开窗口。GUI 默认计算需单独实测，不能以本次 IronCalc 分支替代。

本 agent 不开启 GUI 或完整 Electron app。主 agent 可自行选择已有浏览器宿主，继续它负责的界面验收。

## 上游定位与最小解锁

`packages/xlsx-gateway/src/gateway/xlsx-gateway.ts`：`sheetNames` 在 850 行附近没有 `formulaValues.map(s=>s.sheetName)`；1081 行起的缓存写入对 `worksheetXmls.get(sheetName) === undefined` 直接跳过。`recalc_cells` 和本包传入的 `formulaValues` 都含正确的“说明”!B3=40。

已实测的公开 API 解锁为上面的 `writeValue:false` 标记。正式接入应选择明确的 caller 适配或维护可追溯 planner 修复，并复验所有公式缓存涉及的表；不能把该诊断标记默认为上游已修复，也不能用通用 ZIP patch/fallback 隐藏问题。

## 独立验证 browser candidate

主 backend 保存和 sidecar 再读后，执行：

```sh
"$GENOFFICE_XLSX_PYTHON" /tmp/project-mind-genoffice-xlsx-validation-20261013/verify-candidate.py \
  --kind simple /tmp/project-mind-genoffice-xlsx-validation-20261013/browser/simple.browser-edited.xlsx
```

`GENOFFICE_XLSX_PYTHON` 须具备 openpyxl/lxml/Pillow；本次使用 bundled Python。复杂样本改为 `--kind complex`。返回 0 表示全部独立断言通过，返回 1 保留失败 JSON，默认输出相邻 `.verification.json`；不会修改 XLSX。也可 `from verify import verify_candidate`，传入 kind 和候选 Path。候选目标仍固定为 A3/B3/B5 与对应依赖缓存，未改期望。

协议的 `indexingComplete` 是 CF/DV 完整性的真实门槛，首次 `readRange` 即使已有所有 cells 也可能为 false。本包小样本 `open()` 等待它变为 true（5 秒超时报具体错误），现在 complex 模型含 1 条 CF 和 1 条 DV。薄 GUI 应保留此信号，不能用未完成快照宣称规则丢失或渲染完整。

主 agent 后续创建的 `browser/` 源码、依赖入口、执行脚本、交互证据和候选文件将一并归档；本包不会启动该 GUI。

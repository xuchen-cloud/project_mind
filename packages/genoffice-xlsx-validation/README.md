# GenOffice XLSX 可复跑归档

#118 / F03 的执行验证，固定上游 `d32d1711f1bf985430757b8c6b3fbddd3831d946`。结果与限制见 [FINDINGS](FINDINGS.md)，主 React/浏览器接口见 [HANDOFF](HANDOFF.md)。本包不计为 Issue 完成。

## 复跑

需要 Node 24+、npm、Cargo（支持 edition 2024）、Python 与 openpyxl/lxml/Pillow、curl 及网络。使用本包自己的 npm lock 和下载的上游 Cargo.lock；不安装完整 Electron 或 Univer GUI。

从本目录执行，选择一个尚不存在的输出目录：

```sh
export GENOFFICE_XLSX_PYTHON="/path/to/python-with-openpyxl"
"$GENOFFICE_XLSX_PYTHON" reproduce.py /tmp/project-mind-genoffice-xlsx-rerun
```

脚本复制归档输入/代码到新 scratch，获取并校验固定源码，npm ci，独立 Rust target 编译，生成 Node bundle，执行真实 gateway 和独立校验。每一步写 log 与 execution.json；真实失败直接停止，不提供替代引擎。default/原 IronCalc 的预期真实失败作为结果保留，命令执行成功不表示所有分支 passed。

当前安装版本：openpyxl 3.1.5；其余 Python 版本见机器 findings。无运行时库、Rust 二进制、vendor 源码或 bundles 被归档。`integration.bundle.mjs` 是执行 `node build.mjs` 后生成的 required Node 接口，`browser/server.mjs` 消费它。

## 薄 browser 复跑

引擎步骤完成后，在新 scratch 中启动：

```sh
TMPDIR="$PWD/temp" node browser/server.mjs
```

主 agent 可打开 `http://127.0.0.1:1441/?engine=chromium` 或 `?engine=webkit`，分别选 simple/complex，将 form 填为 A3=`香蕉（SDK编辑）`、B3=`15`、B5=`=SUM(B3:B4)+5` 后保存。这是 HTML grid/form 的接口验证，不是完整 GenOffice GUI。server 只监听 loopback，原件只读，候选写新 scratch 的 browser/output。

补独立检查（不会改 XLSX）：

```sh
"$GENOFFICE_XLSX_PYTHON" verify-candidate.py --kind complex \
  browser/output/webkit/complex.browser-edited.xlsx \
  --sdk-events browser/output/webkit/complex.events.json
```

返回 0 表示该候选所有断言通过；失败返回 1 并保留逐项 JSON。也可调用 `verify.verify_candidate(kind, candidatePath, sdk=events['sdk'])`。主 backend 用公开 `writeValue:false` 标记载入 cache-only sheet 的诊断分支，原失败依然保留。

## 目录

- `probe.ts`、`sheet-session.ts`、`fixture-save.ts`、`view-model.mjs`、`integration-api.ts`：实际接口与四分支执行。
- `compare.py`、`verify.py`、`verify-candidate.py`：只读 openpyxl/ZIP/XML/metadata、压缩字节与 SDK 检查。
- `fetch-core.py`、`tree.json`、`source-provenance.json`：固定下载范围与 blob 校验；不需要其他任务的临时源码。
- `package.json`、`package-lock.json`、`build.mjs`、`reproduce.py`：独立依赖与构建/执行。
- 两份 `*.original.xlsx` 与 `fixtures.json`：与源原件 hash 一致；`fixtures.source.json` 保留源 metadata，归档 manifest 路径相对化。
- `results.json`、`sdk-results.json`、`findings.json`：完整独立检查、SDK 结果和摘要。`*.initial.json` 保留最初 raw 公式表示误判，不能作为最终内容状态。
- `*.xlsx` 导出、`*.reopen.sdk.json`、`*.view-model.json`：真实引擎证据。
- `browser/`：主 agent 的 server、HTML/JS、四份真实候选及 events/原始 verification；`browser-results.json` 与 `*.independent.json` 为补完检查，simple 80/80、complex 94/94。
- `branding-audit.json`、`local-provenance.json`、`LICENSE`、`NOTICE`：公开运行范围与来源；没有 EE 或许可绕过。

外部重开与截图由主 agent 保存，见 [外部重开证据](../office-validation/evidence/genoffice-xlsx-external/)。外部工具可自行重算，不用于抹除原缓存失败。

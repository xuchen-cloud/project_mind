Use this format contract through `file_office_create` (`content`) or `file_office_edit` (`edits`). Package-level engine names below describe the data contract, not commands to execute from the assistant.

# XLSX 创建与完整编辑协议

`engine.create(content, context?)` 接受 JSON 对象，返回原生 XLSX ZIP 字节。它复用固定 GenOffice 的 `blankXlsxBuffer`、完整 gateway、`writeWorkbookTo` 与真实 native sidecar/IronCalc；不执行脚本，不启动独立 GenOffice 应用或模型账号。

创建协议为 `{sheets:[{id,name,hidden?,tabColor?}],changes?:{...}}`。`sheets` 是最终顺序，至少一个工作表可见，名称符合 Excel 规则且忽略大小写唯一。`id` 是本次创建的局部标识；所有 `changes` 中的 `sheetId`、`sourceSheetId` 使用该标识。保存后以 inspect 返回的实际 sheet ID 编辑，不复用创建时的局部 ID。坐标全部从 0 开始。

创建 `changes` 复用完整上游 gateway schema，只有 `sheetOps` / `sheetOrder` / `formulaValues` 不允许传入：前两者由 `sheets` 决定，公式缓存由真实计算生成。现有文件的完整编辑使用一个 `{kind:"gateway",changes:{...}}` 元素，支持 `sheetOps` / `sheetOrder`；不可与其它标量 edit 混用。

可运行示例：

```json
{
  "sheets": [{"id":"sales","name":"销售"},{"id":"summary","name":"汇总"}],
  "changes": {
    "edits": [
      {"sheetId":"sales","row":0,"column":0,"writeValue":true,"value":"项目","style":{"bold":true,"fillColor":"#DDEEFF"}},
      {"sheetId":"sales","row":0,"column":1,"writeValue":true,"value":"金额"},
      {"sheetId":"sales","row":1,"column":0,"writeValue":true,"value":"合同"},
      {"sheetId":"sales","row":1,"column":1,"writeValue":true,"value":125.5,"style":{"numberFormat":"#,##0.00"}},
      {"sheetId":"sales","row":2,"column":0,"writeValue":true,"value":"许可"},
      {"sheetId":"sales","row":2,"column":1,"writeValue":true,"value":74.5},
      {"sheetId":"summary","row":0,"column":0,"writeValue":true,"value":null,"formula":"=SUM('销售'!B2:B3)"}
    ],
    "structuralOps": [
      {"sheetId":"sales","kind":"set-col-size","start":0,"end":1,"size":24},
      {"sheetId":"sales","kind":"set-row-size","start":0,"end":0,"size":32},
      {"sheetId":"summary","kind":"merge-cells","range":{"startRow":2,"endRow":2,"startColumn":0,"endColumn":2}}
    ],
    "pageSetupStates": [{"sheetId":"sales","frozenRows":1,"frozenColumns":1,"orientation":"landscape","paperSize":9}],
    "tableAdditions": [{"sheetId":"sales","area":{"startRow":0,"endRow":2,"startColumn":0,"endColumn":1},"name":"Sales","columnNames":["项目","金额"],"bandedRows":true}],
    "visualAdditions": [{
      "sheetId":"sales",
      "anchor":{"fromRow":5,"fromColumn":0,"fromRowOffset":0,"fromColumnOffset":0,"toRow":15,"toColumn":7,"toRowOffset":0,"toColumnOffset":0},
      "chart":{"chartType":"column","title":"销售金额","series":[{"name":"金额","categories":["合同","许可"],"values":[125.5,74.5],"valuesRef":"'销售'!$B$2:$B$3","categoriesRef":"'销售'!$A$2:$A$3"}],"legend":"bottom","dataLabels":"value"}
    }]
  }
}
```

完整字段和枚举以引擎导出的 [creation schema](excel-create.schema.json) / [gateway schema](excel-gateway.schema.json) 为准，运行时分别由 `createSchema` / `gatewayChangesSchema` 验证。未知字段报错；不要按猜测制造字段或传上游 CLI 的 `ops` DSL。上游 CLI 的 DSL 转换器另含文件/网络/CLI 生命周期，本宿主调用的是其同源完整 gateway 操作协议。

编辑前读取当前模型：`styles[cell.styleIndex]` 是单元格格式；`visuals` 是纯语义对象集合，含 `id/sheetId/kind/anchor`、图表标题/系列/数据范围及格式。图表编辑目标使用 `visual.chartPath`；图片/形状编辑使用 `visual.drawingPath` 和 `visual.drawingIndex`；这些是 ZIP 包内对象定位符，不能当本地文件路径。表格编辑目标使用 `sheets[].id` 和该 sheet 的 `tables[].name` 对应的 `tableName`，区域由 `tables[].range` 提供。保存后必须再次读取当前模型，不能沿用重排或重新保存前的目标 ID。

```json
[{"kind":"gateway","changes":{
  "chartEdits":[{"chartPath":"xl/charts/chart1.xml","title":"更新后的销售图表","legend":"right"}],
  "tableEdits":[{"sheetId":"sheet-1","tableName":"Sales","name":"VerifiedSales","style":"TableStyleMedium2"}]
}}]
```

示例中的 locator 必须替换成当前 inspect 返回值。不要读取 `rendererData` 的渲染树、原始媒体 base64 或原始 XML 来猜测可写字段。

| gateway 字段 | 写入行为 |
| --- | --- |
| `edits` | 单元格值/公式/富文本、字体/填充/边框/对齐/数字格式；样式单独修改用 `writeValue:false,value:null,style:{...}` |
| `bulkConstantFills` | 矩形区域填充常量，创建时同样受已用矩形预算限制 |
| `structuralOps` | 插入/移除/移动行列、合并/拆分、行高/列宽、列样式、隐藏、分组轮廓 |
| `visualAdditions` | 原生图表、形状或内嵌图片，三者恰好一个；图表支持 column/bar/line/area/pie/scatter/radar/doughnut/combo |
| `chartEdits`, `visualEdits` | 修改已有图表/视觉对象，ID 来自 inspect 的最新模型 |
| `tableAdditions`, `tableEdits` | 原生 Excel 表格创建和编辑 |
| `pivotAdditions` | 原生透视表及 cache；`sourceSheetId`/`sourceArea` 和 `location` 都必须明确 |
| `cfStates`, `dvStates` | 该 sheet 的完整条件格式/数据验证规则集合，规则采用上游 Univer wire JSON；不支持的规则明确报错 |
| `pageSetupStates` | 冻结窗格 `frozenRows/frozenColumns`、纸型/方向/缩放/打印区域/标题/页眉页脚/分页/视图 |
| `filterStates`, `hyperlinkEdits`, `noteStates` | 筛选、超链接、批注；states 是该 sheet 的完整状态 |
| `sparklineAdditions` | 迷你图 |
| `definedNamesState`, `themeState` | 定义名称和主题 |
| `sheetProtections`, `workbookProtectionState`, `protectedRangeStates` | 工作表、工作簿结构、保护区域状态 |
| `pivotCacheRefreshPaths`, `pivotRefreshUpdates` | 已有透视 cache 的更新，必须引用 inspect 读到的实际包内对象 |
| `sheetOps`, `sheetOrder` | 现有工作簿编辑时的添加/复制/删除/重命名/隐藏/标签色/排序；创建使用顶层 `sheets` |

图片只接受 `visualAdditions[].image={mediaType:"image/png"|"image/jpeg"|"image/gif",base64:"..."}`，没有本地路径或远程 URL 读取字段。超链接及图表公式引用只是保存在文档中的内容，不触发下载。图片和图表示例已通过真实 sidecar 重开、ZIP 及后续编辑保留验证。

每次创建最多 2 MiB UTF-8 JSON、1000 个 sheet，已用矩形合计最多 2000000 格，输入和最终 XLSX 受现有 64 MiB 引擎预算限制。公式由真实 IronCalc 重算，数字、文本、布尔和真实 Excel 错误分别保存为正确的 OOXML cache 类型；例如 `=IF(A1>0,"通过","失败")` 保留文本、`=A1>0` 保留布尔，`=1/0` 保留 `#DIV/0!` 错误缓存。未实现函数/不支持的解析形态保留完整公式且不写虚构缓存，并保留打开后重算标记。`inspect.model.warnings` 是结构化 `{code,message,sheetId,row,column}[]`，`FORMULA_UNCACHED` 提醒打开 Excel 重算，`FORMULA_ERROR` 指明真实计算错误。文本结果 `="#N/A"` 不会被误标为错误。完整 renderer 的 Univer 计算能力与 native headless IronCalc 的支持集合不同，不能据 renderer 支持就假定 headless 均可计算。传统逐单元格标量 edit 仍保留原来的严格数值计算合同；完整创建/编辑使用本文的 gateway 协议。

创建的新公式没有缓存时，适配器先在私有计算副本写入临时数值缓存，让上游 IronCalc 正确导入，再以真实计算结果写最终字节。该副本不会成为原生 File；计算失败时不返回候选。业务 File 的权限、保存、CAS、版本和幂等仍由宿主负责。

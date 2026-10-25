import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import * as engine from '../dist/engine.mjs'

const content = {
  sheets: [{ id: 'sales', name: '销售明细' }, { id: 'summary', name: '汇总' }],
  changes: {
    edits: [
      { sheetId: 'sales', row: 0, column: 0, writeValue: true, value: '产品', style: { bold: true, fillColor: '#DDEEFF' } },
      { sheetId: 'sales', row: 0, column: 1, writeValue: true, value: '金额' },
      { sheetId: 'sales', row: 1, column: 0, writeValue: true, value: '合同' },
      { sheetId: 'sales', row: 1, column: 1, writeValue: true, value: 125.5, style: { numberFormat: '#,##0.00' } },
      { sheetId: 'sales', row: 2, column: 0, writeValue: true, value: '许可' },
      { sheetId: 'sales', row: 2, column: 1, writeValue: true, value: 74.5 },
      { sheetId: 'summary', row: 0, column: 0, writeValue: true, value: null, formula: "=SUM('销售明细'!B2:B3)" },
    ],
    structuralOps: [
      { sheetId: 'sales', kind: 'set-col-size', start: 0, end: 1, size: 24 },
      { sheetId: 'sales', kind: 'set-row-size', start: 0, end: 0, size: 32 },
      { sheetId: 'summary', kind: 'merge-cells', range: { startRow: 2, endRow: 2, startColumn: 0, endColumn: 2 } },
    ],
    pageSetupStates: [{ sheetId: 'sales', frozenRows: 1, frozenColumns: 1, orientation: 'landscape', paperSize: 9 }],
    tableAdditions: [{ sheetId: 'sales', area: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }, name: 'Sales', columnNames: ['产品', '金额'], bandedRows: true }],
  },
}

test('creates a native multi-sheet XLSX with cached formulas, styles, tables, geometry and frozen panes', async () => {
  assert.equal(typeof engine.create, 'function')
  const bytes = await engine.create(content)
  const model = await engine.inspect(bytes)
  assert.deepEqual(model.sheets.map(s => s.name), ['销售明细', '汇总'])
  const sales = model.sheets[0], summary = model.sheets[1]
  const data = model.ranges[sales.id]
  const cell = data.cells.find(c => c.row === 0 && c.column === 0)
  assert.equal(model.styles[cell.styleIndex].bold, true)
  assert.equal(model.styles[cell.styleIndex].fillColor, '#DDEEFF')
  assert.equal(model.styles[data.cells.find(c => c.row === 1 && c.column === 1).styleIndex].numberFormat, '#,##0.00')
  const formula = model.ranges[summary.id].cells.find(c => c.row === 0 && c.column === 0)
  assert.equal(formula.formula, "=SUM('销售明细'!B2:B3)")
  assert.equal(formula.value, 200)
  assert.equal(sales.columnWidths[0].width, 24)
  assert.equal(data.rows.find(r => r.row === 0).height, 32)
  assert.deepEqual(sales.freeze, { frozenRows: 1, frozenColumns: 1 })
  assert.equal(sales.tables[0].name, 'Sales')
  assert.ok(model.ranges[summary.id].merges.some(r => r.startRow === 2 && r.endColumn === 2))
  const recalculated = await engine.recalculate(bytes, { edits: [], reads: [{ sheetId: summary.id, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } }] })
  assert.equal(recalculated.cells[0].number, 200)
  const zip = await JSZip.loadAsync(bytes)
  assert.ok(zip.file('xl/styles.xml'))
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /state="frozen"/)
  assert.match(await zip.file('xl/worksheets/sheet2.xml').async('string'), /<f>SUM\('销售明细'!B2:B3\)<\/f><v>200<\/v>/)
})

test('creation rejects unknown fields, unknown sheet IDs, duplicate names and oversized JSON before saving', async () => {
  await assert.rejects(engine.create({ ...content, script: 'process.exit()' }), /Unrecognized key/)
  await assert.rejects(engine.create({ sheets: content.sheets, changes: { edits: [{ ...content.changes.edits[0], sheetId: 'missing' }] } }), /Unknown authoring sheet/)
  await assert.rejects(engine.create({ sheets: [{ id: 'a', name: 'Sales' }, { id: 'b', name: 'sales' }] }), /unique/i)
  await assert.rejects(engine.create({ sheets: [{ id: 'a', name: 'Sales' }], changes: { edits: [{ ...content.changes.edits[0], script: 'bad' }] } }), /Unrecognized key/)
  await assert.rejects(engine.create({ sheets: [{ id: 'a', name: 'Sales' }], huge: 'x'.repeat(2 * 1024 * 1024) }), /2 MiB/)
  await assert.rejects(engine.create({ sheets: content.sheets, changes: { formulaValues: [] } }), /Unrecognized key/)
  await assert.rejects(engine.create({ sheets: [{ id: 'a', name: '\ud800' }] }), /Invalid Unicode/)
  await assert.rejects(engine.create({ sheets: [{ id: 'a', name: 'Data' }], changes: { bulkConstantFills: [{ sheetId: 'a', startRow: 0, endRow: 1_048_575, startColumn: 0, endColumn: 16_383, value: 1 }] } }), /2000000-cell/)
})

test('creates charts, shapes, pictures, conditional formatting, validation, notes, names and native pivots', async () => {
  const anchor = { fromRow: 5, fromColumn: 0, fromRowOffset: 0, fromColumnOffset: 0, toRow: 15, toColumn: 7, toRowOffset: 0, toColumnOffset: 0 }
  const area = { startRow: 1, endRow: 2, startColumn: 1, endColumn: 1 }
  const bytes = await engine.create({ ...content, changes: { ...content.changes,
    visualAdditions: [
      { sheetId: 'sales', anchor, chart: { chartType: 'column', title: '销售图表', series: [{ name: '金额', categories: ['合同', '许可'], values: [125.5, 74.5], valuesRef: "'销售明细'!$B$2:$B$3", categoriesRef: "'销售明细'!$A$2:$A$3" }], legend: 'bottom', dataLabels: 'value' } },
      { sheetId: 'sales', anchor: { ...anchor, fromColumn: 8, toColumn: 12 }, shape: { shapeType: 'rect', fillColor: '#DDEEFF', text: '原生形状' } },
      { sheetId: 'summary', anchor, image: { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=' } },
    ],
    cfStates: [{ sheetId: 'sales', rules: [{ ranges: [area], stopIfTrue: false, rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 100, style: { bg: { rgb: '#FFCCAA' }, bl: 1 } } }] }],
    dvStates: [{ sheetId: 'sales', rules: [{ ranges: [area], rule: { type: 'decimal', operator: 'greaterThanOrEqual', formula1: '0', allowBlank: false, showErrorMessage: true, error: '请输入正数' } }] }],
    noteStates: [{ sheetId: 'sales', notes: [{ row: 1, column: 1, author: 'Mind', text: '金额已核验' }] }],
    definedNamesState: { names: [{ name: 'SalesAmount', formula: "'销售明细'!$B$2:$B$3" }], preserveNames: [] },
    pivotAdditions: [{ sheetId: 'summary', sourceSheetId: 'sales', sourceArea: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }, location: { startRow: 18, endRow: 21, startColumn: 0, endColumn: 1 }, name: 'SalesPivot', fieldNames: ['产品', '金额'], rowFieldIndices: [0], rowItems: ['合同', '许可'], values: [{ fieldIndex: 1, agg: 'sum' }] }],
  } })
  const model = await engine.inspect(bytes)
  assert.equal(model.visuals.length, 3)
  assert.equal(model.sheets[1].pivotTables.length, 1)
  assert.ok(model.definedNames.some(name => name.name === 'SalesAmount'))
  assert.equal(model.ranges[model.sheets[0].id].conditionalRules.length, 1)
  assert.equal(model.ranges[model.sheets[0].id].dataValidations.length, 1)
  const zip = await JSZip.loadAsync(bytes)
  assert.ok(Object.keys(zip.files).some(path => /^xl\/charts\/chart\d+\.xml$/.test(path)))
  assert.ok(Object.keys(zip.files).some(path => /^xl\/media\//.test(path)))
  const worksheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(worksheet, /<conditionalFormatting/)
  assert.match(worksheet, /<dataValidations/)
  const saved = await engine.edit(bytes, [{ kind: 'gateway', changes: { edits: [{ sheetId: model.sheets[0].id, row: 2, column: 1, writeValue: true, value: 84.5 }] } }])
  const reopened = await engine.inspect(saved)
  assert.equal(reopened.ranges[reopened.sheets[1].id].cells.find(c => c.row === 0 && c.column === 0).value, 210)
  const savedZip = await JSZip.loadAsync(saved)
  for (const path of Object.keys(zip.files).filter(path => /xl\/(?:charts|drawings|media|pivotTables|pivotCache)\//.test(path) && !zip.files[path].dir))
    assert.deepEqual(await savedZip.file(path).async('uint8array'), await zip.file(path).async('uint8array'), path)
  const chart = reopened.visuals.find(visual => visual.kind === 'chart'), image = reopened.visuals.find(visual => visual.kind === 'image')
  const formatted = await engine.inspect(await engine.edit(saved, [{ kind: 'gateway', changes: {
    chartEdits: [{ chartPath: chart.chartPath, title: '更新后的销售图表', legend: 'right' }],
    visualEdits: [{ drawingPath: image.drawingPath, drawingIndex: image.drawingIndex, anchor: { ...image.anchor, fromColumn: 3, toColumn: 9 } }],
    tableEdits: [{ sheetId: reopened.sheets[0].id, tableName: 'Sales', name: 'VerifiedSales', style: 'TableStyleMedium2' }],
  } }]))
  assert.equal(formatted.visuals.find(visual => visual.kind === 'chart').chart.title, '更新后的销售图表')
  assert.equal(formatted.visuals.find(visual => visual.kind === 'image').anchor.fromColumn, 3)
  assert.equal(formatted.sheets[0].tables[0].name, 'VerifiedSales')
})

test('blank native workbooks and hidden tabs retain declared order without accepting forged cached results', async () => {
  const bytes = await engine.create({ sheets: [{ id: 'sheet-2', name: '封面', tabColor: '#FFCC00' }, { id: 'sheet-1', name: '数据', hidden: true }] })
  const model = await engine.inspect(bytes)
  assert.deepEqual(model.sheets.map(s => [s.name, s.hidden]), [['封面', false], ['数据', true]])
  assert.equal(model.sheets[0].tabColor, '#FFCC00')
  assert.equal(engine.createJsonSchema.additionalProperties, false)
  assert.ok(engine.gatewayChangesJsonSchema.properties.visualAdditions)
})

test('formula caches retain exact text, boolean, numeric and error types; unsupported formulas remain uncached with warnings', async () => {
  const formulas = ['=IF(A1>0,"通过","失败")', '=A1>0', '=A1*2', '=1/0', '=MIND_UNSUPPORTED_FUNCTION(A1)', '="TRUE"', '="#N/A"', '=""', '=A1<0']
  const bytes = await engine.create({ sheets: [{ id: 'data', name: '计算' }], changes: { edits: [
    { sheetId: 'data', row: 0, column: 0, writeValue: true, value: 3 },
    ...formulas.map((formula, row) => ({ sheetId: 'data', row, column: 1, writeValue: true, value: null, formula })),
  ] } })
  const model = await engine.inspect(bytes)
  const cells = model.ranges[model.sheets[0].id].cells
  const at = row => cells.find(cell => cell.row === row && cell.column === 1)
  assert.equal(at(0).value, '通过')
  assert.equal(at(1).value, true)
  assert.equal(at(2).value, 6)
  assert.equal(at(3).value, '#DIV/0!')
  assert.equal(at(4).value, null)
  assert.equal(at(4).formula, formulas[4])
  assert.equal(at(5).value, 'TRUE')
  assert.equal(at(6).value, '#N/A')
  assert.equal(at(7).value, '')
  assert.equal(at(8).value, false)
  assert.ok(model.warnings.some(w => w.code === 'FORMULA_UNCACHED' && w.row === 4 && w.column === 1))
  assert.ok(model.warnings.some(w => w.code === 'FORMULA_ERROR' && w.row === 3 && w.column === 1))
  assert.ok(!model.warnings.some(w => w.row >= 5), 'text spelling TRUE/#N/A/empty and boolean false retain their exact types')
  const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(xml, /<c r="B2"[^>]*t="b"[^>]*><f>A1&gt;0<\/f><v>1<\/v>/)
  assert.match(xml, /<c r="B4"[^>]*t="e"[^>]*><f>1\/0<\/f><v>#DIV\/0!<\/v>/)
  assert.match(xml, /<c r="B5"[^>]*><f>MIND_UNSUPPORTED_FUNCTION\(A1\)<\/f><\/c>/)
  assert.match(await zip.file('xl/workbook.xml').async('string'), /fullCalcOnLoad="1"/)
  const original = Buffer.from(bytes)
  const numeric = await engine.recalculate(bytes, { edits: [], reads: [{ sheetId: model.sheets[0].id, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } }] })
  assert.equal(numeric.cells[0].number, 3, 'an uncached unsupported formula elsewhere must not corrupt read-only native calculation')
  assert.deepEqual(Buffer.from(bytes), original)
})

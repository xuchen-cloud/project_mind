import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium, expect } from '@playwright/test'
import { withRendererResources } from './renderer-server.mjs'
import { create, inspect, edit } from '../dist/engine.mjs'

test('created native Chinese workbook renders styles, frozen headers, picture and chart and reopens after an actual renderer edit', { timeout: 60000 }, async () => {
  const anchor = { fromRow: 5, fromColumn: 0, fromRowOffset: 0, fromColumnOffset: 0, toRow: 17, toColumn: 7, toRowOffset: 0, toColumnOffset: 0 }
  const source = await create({ sheets: [{ id: 'data', name: '销售报告' }], changes: {
    edits: [
      { sheetId: 'data', row: 0, column: 0, writeValue: true, value: '项目', style: { bold: true, fontSize: 16, fillColor: '#315A85', fontColor: '#FFFFFF' } },
      { sheetId: 'data', row: 0, column: 1, writeValue: true, value: '金额', style: { bold: true, fontSize: 16, fillColor: '#315A85', fontColor: '#FFFFFF' } },
      { sheetId: 'data', row: 1, column: 0, writeValue: true, value: '合同' },
      { sheetId: 'data', row: 1, column: 1, writeValue: true, value: 125.5, style: { numberFormat: '#,##0.00' } },
      { sheetId: 'data', row: 2, column: 0, writeValue: true, value: '许可' },
      { sheetId: 'data', row: 2, column: 1, writeValue: true, value: 74.5 },
      { sheetId: 'data', row: 3, column: 0, writeValue: true, value: '合计', style: { bold: true } },
      { sheetId: 'data', row: 3, column: 1, writeValue: true, value: null, formula: '=SUM(B2:B3)', style: { bold: true, numberFormat: '#,##0.00' } },
    ],
    structuralOps: [{ sheetId: 'data', kind: 'set-col-size', start: 0, end: 1, size: 20 }, { sheetId: 'data', kind: 'set-row-size', start: 0, end: 0, size: 32 }],
    pageSetupStates: [{ sheetId: 'data', frozenRows: 1, frozenColumns: 1 }],
    tableAdditions: [{ sheetId: 'data', area: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }, name: 'Sales', columnNames: ['项目', '金额'], bandedRows: true }],
    visualAdditions: [
      { sheetId: 'data', anchor, chart: { chartType: 'column', title: '销售金额', series: [{ name: '金额', categories: ['合同', '许可'], values: [125.5, 74.5] }], legend: 'bottom', dataLabels: 'value' } },
      { sheetId: 'data', anchor: { ...anchor, fromRow: 1, fromColumn: 9, toRow: 4, toColumn: 11 }, image: { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAHgAAAA8CAIAAAAiz+n/AAAAvUlEQVR4nO3coRGEQBAAQaAIiCDQqE/hU8KQBfqDIwJw34Katitua2r1jctnH/J/E3gjhXa6aKTQSKGRQiOFRgqNFBqZn8fnsapN3mD7/u5GXTRSaKTQSKGRQiOFRgqNFBopNFJopNBIoZFCI4VGCo0UGik0Umik0EihkUIjhUYKjRQaKTRSaKTQSKGRQiOFRgqNFBopNFJopNBIoZFCI4VGCo0UGhn76sfoopFCI4VGCo0UGik0Umik0INxAVp7Ba3k5pcOAAAAAElFTkSuQmCC' } },
    ],
  } })
  const model = await inspect(source), bundle = await readFile(new URL('../dist/browser.mjs', import.meta.url)), css = await readFile(new URL('../dist/browser.css', import.meta.url))
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
  const server = createServer(withRendererResources((req, res) => { res.setHeader('Content-Type', req.url === '/browser.mjs' ? 'text/javascript' : req.url === '/browser.css' ? 'text/css' : 'text/html'); res.end(req.url === '/browser.mjs' ? bundle : req.url === '/browser.css' ? css : html) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => Object.defineProperty(window, '__projectMindSheetsHost', { configurable: true, set(host) { const render = host.render; host.render = function(context) { window.testContext = context; return render(context) }; Object.defineProperty(window, '__projectMindSheetsHost', { configurable: true, writable: true, value: host }) } }))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.ready)
    const frame = page.frameLocator('iframe[title="Excel 完整编辑器"]')
    await frame.locator('svg.chart-svg').waitFor()
    await frame.locator('.xlsx-print-visual img').waitFor()
    const output = new URL('./output/', import.meta.url)
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: new URL('created-authoring.png', output).pathname })
    await writeFile(new URL('created-authoring-dom.html', output), await frame.locator('body').innerHTML())
    assert.equal(await frame.getByText('销售金额', { exact: true }).count(), 1)
    assert.equal(await frame.locator('.xlsx-print-visual img').evaluate(image => image.complete && image.naturalWidth > 0), true)
    const snapshot = await frame.locator('body').evaluate(() => window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().getSheet().getSnapshot())
    assert.equal(snapshot.cellData[0][0].v, '项目')
    assert.equal(snapshot.freeze.ySplit, 1)
    assert.equal(snapshot.freeze.xSplit, 1)
    await page.screenshot({ path: new URL('created-authoring.png', output).pathname })
    await writeFile(new URL('created-authoring.xlsx', output), source)
    const nameBox = frame.locator('input[type="text"]:visible').last()
    await nameBox.fill('D3'); await nameBox.press('Enter'); await page.keyboard.press('F2'); await page.keyboard.type('重开后继续编辑')
    await page.evaluate(() => window.editor.commitEditing())
    const saved = await edit(source, await page.evaluate(() => window.props.edits)), reopened = await inspect(saved)
    assert.equal(reopened.ranges[reopened.sheets[0].id].cells.find(cell => cell.row === 2 && cell.column === 3).value, '重开后继续编辑')
    assert.equal(reopened.visuals.length, 2)
    assert.equal(reopened.sheets[0].tables.length, 1)
    assert.deepEqual(reopened.sheets[0].freeze, { frozenRows: 1, frozenColumns: 1 })
    await page.evaluate(model => { window.props = { ...window.props, model, edits: [] }; window.editor.update(window.props) }, reopened)
    await expect.poll(() => frame.locator('body').evaluate(() => window.testContext?.univerRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getSheet().getSnapshot().cellData[2]?.[3]?.v)).toBe('重开后继续编辑')
    await frame.locator('svg.chart-svg').waitFor()
    await frame.locator('.xlsx-print-visual img').waitFor()
    await page.screenshot({ path: new URL('created-authoring-reopened.png', output).pathname })
    assert.deepEqual(errors, [])
    await writeFile(new URL('created-authoring-renderer-evidence.json', output), JSON.stringify({ viewport: { width: 1300, height: 900 }, freeze: snapshot.freeze, header: snapshot.cellData[0][0], visuals: reopened.visuals.map(visual => ({ kind: visual.kind, anchor: visual.anchor })), errors, result: 'passed' }, null, 2))
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})

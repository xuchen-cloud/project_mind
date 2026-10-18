import {withRendererResources} from './renderer-server.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium, webkit, expect } from '@playwright/test'
import { inspect, edit } from '../dist/engine.mjs'

for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) test(`${name}: full renderer switches presentation in place, preserving workbook, visuals, tab, selection, scroll and zoom`, { timeout: 90000 }, async () => {
  const source = await readFile(new URL('./fixtures/complex.original.xlsx', import.meta.url)), model = await inspect(source)
  const bundle = await readFile(new URL('../dist/browser.mjs', import.meta.url)), css = await readFile(new URL('../dist/browser.css', import.meta.url))
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh;--color-bg:#faf9f6;--color-bg-subtle:#f3f2ef;--color-border:#d6d4cf;--color-text-primary:#292d2c;--color-accent:#197a70;--font-ui:sans-serif}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.changes=[];window.exports=[];window.props={model:${JSON.stringify(model)},edits:[],presentationMode:'preview',readOnly:false,onChange(edits){window.props.edits=edits;window.changes.push(edits)},onPendingChange(p){window.pending=p},onExport:async file=>{window.exports.push(file.bytes);return true}};window.editor=mount(document.getElementById('editor'),window.props);window.initialReady=window.editor.ready;window.originalFrame=document.querySelector('iframe');await window.editor.ready;window.ready=true</script>`
  const server = createServer(withRendererResources((req, res) => { res.setHeader('Content-Type', req.url === '/browser.mjs' ? 'text/javascript;charset=utf-8' : req.url === '/browser.css' ? 'text/css;charset=utf-8' : 'text/html;charset=utf-8'); res.end(req.url === '/browser.mjs' ? bundle : req.url === '/browser.css' ? css : html) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await browserType.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 800 } }), errors = []
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message))
    // Observe the real runtime attach without adding a production debug API.
    await page.addInitScript(() => Object.defineProperty(window, '__projectMindSheetsHost', { configurable: true, set(host) {
      const attach = host.attach
      host.attach = function(runtime) { window.testRuntime = runtime; window.attachCount = (window.attachCount ?? 0) + 1; return attach(runtime) }
      Object.defineProperty(window, '__projectMindSheetsHost', { value: host, writable: true, configurable: true })
    } }))
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready)
    const frame = page.frameLocator('iframe[title="Excel 完整编辑器"]')
    assert.equal(await frame.locator('html').getAttribute('data-presentation-mode'), 'preview')
    await expect(frame.locator('.ribbon')).toBeHidden(); await expect(frame.locator('[data-u-comp="formula-bar"]')).toBeHidden()
    await expect(frame.locator('.excel-header')).toBeHidden()
    await expect(frame.locator('[data-u-comp="slide-tab-bar"]')).toBeVisible(); await expect(frame.locator('.zoom-value')).toHaveText('100%')
    for (const button of await frame.locator('[data-u-comp="sheet-bar-append-button"]').all()) await expect(button).toBeHidden()
    await frame.locator('body').evaluate(()=>{window.originalWorkbook=window.testRuntime.univerAPI.getActiveWorkbook().getWorkbook()})
    const changeMode = async (presentationMode, readOnly = false) => {
      await page.evaluate(({presentationMode,readOnly}) => { window.props={...window.props,presentationMode,readOnly};window.editor.update(window.props) }, {presentationMode,readOnly})
      await expect(frame.locator('html')).toHaveAttribute('data-presentation-mode', presentationMode)
    }
    await frame.locator('.xlsx-print-visual img').first().waitFor(); await frame.locator('svg.chart-svg').first().waitFor()
    const visualState = () => frame.locator('[data-print-visual]').evaluateAll(nodes => nodes.map(node => { const rect=(node.firstElementChild??node).getBoundingClientRect();return {id:node.dataset.printVisual,width:rect.width,height:rect.height,image:node.querySelector('img')?.getAttribute('src'),svg:node.querySelector('svg')?.getAttribute('viewBox')} }))
    const initialVisuals = await visualState()
    await expect(frame.locator('.chart-edit-button').first()).toBeHidden()
    const protectionAttempt=await frame.locator('body').evaluate(async()=>{
      const api=window.testRuntime.univerAPI,book=api.getActiveWorkbook(),unitId=book.getId(),subUnitId=book.getActiveSheet().getSheetId(),before=JSON.stringify(book.getSnapshot()),cancelled=[]
      const listener=api.addEvent(api.Event.BeforeCommandExecute,event=>{if(event.id.includes('protection')&&event.cancel)cancelled.push(event.id)})
      await api.executeCommand('sheet.command.add-worksheet-protection',{unitId,rule:{unitId,subUnitId,permissionId:'readonly-test'}})
      listener.dispose();return{unchanged:before===JSON.stringify(book.getSnapshot()),cancelled}
    })
    assert.equal(protectionAttempt.unchanged,true,'readonly protection command does not change workbook resources')
    assert.ok(protectionAttempt.cancelled.includes('sheet.mutation.add-worksheet-protection'),'the real protection command reaches the readonly mutation veto')
    await changeMode('edit'); await expect(frame.locator('.ribbon')).toBeVisible(); await expect(frame.locator('[data-u-comp="formula-bar"]')).toBeVisible()
    assert.deepEqual(await visualState(),initialVisuals,'same original image/chart geometry and content in both presentations')
    await expect(frame.locator('.chart-edit-button').first()).toBeVisible()
    await changeMode('preview'); assert.deepEqual(await visualState(),initialVisuals)
    // The host handle uses the original output path in preview.
    await page.evaluate(()=>{window.outputState='waiting';void window.editor.output('csv').then(()=>window.outputState='resolved',error=>window.outputState=error.message)});await frame.getByRole('dialog',{name:'导出 CSV',exact:true}).getByRole('button',{name:'继续导出',exact:true}).click();await page.waitForFunction(()=>window.exports.length===1)
    await frame.locator('[data-u-comp="slide-tab-item"]').filter({hasText:'说明'}).click()
    await frame.getByRole('button',{name:'放大',exact:true}).click();await expect(frame.locator('.zoom-value')).toHaveText('110%')
    await frame.locator('body').evaluate(()=>{const sheet=window.testRuntime.univerAPI.getActiveWorkbook().getActiveSheet();sheet.setActiveRange(sheet.getRange('D100'));sheet.scrollToCell(99,3,0)})
    const state=()=>frame.locator('body').evaluate(()=>{const book=window.testRuntime.univerAPI.getActiveWorkbook(),sheet=book.getActiveSheet();return {sheet:sheet.getSheetId(),zoom:sheet.getZoom(),scroll:sheet.getScrollState(),selection:book.getActiveRange()?.getRange(),attachCount:window.attachCount}})
    await frame.locator('body').evaluate(()=>new Promise(requestAnimationFrame))
    const before=await state()
    assert.ok(before.scroll.sheetViewStartRow>0)
    for(const mode of ['edit','preview','edit']){await changeMode(mode);assert.deepEqual(await state(),before,`${mode} preserves the actual live view state`)}
    assert.equal(await page.evaluate(()=>window.originalFrame===document.querySelector('iframe')&&window.initialReady===window.editor.ready),true,'no new iframe/bootstrap/ready')
    assert.equal(await frame.locator('body').evaluate(()=>window.originalWorkbook===window.testRuntime.univerAPI.getActiveWorkbook().getWorkbook()),true,'same Univer workbook object')
    // Real cell input still produces the production typed gateway journal.
    const nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.type('同实例编辑保存');await page.evaluate(()=>window.editor.commitEditing())
    const draft=await page.evaluate(()=>window.props.edits), saved=await edit(source,draft), fresh=await inspect(saved)
    assert.equal(fresh.ranges['sheet-2'].cells.find(cell=>cell.row===19&&cell.column===3)?.value,'同实例编辑保存')
    const originalChanges=await page.evaluate(()=>window.changes.length)
    await changeMode('preview')
    await frame.locator('body').evaluate(()=>window.testRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange('D20').setValue('不允许的覆盖'))
    assert.equal(await frame.locator('body').evaluate(()=>window.testRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange('D20').getValue()),'同实例编辑保存')
    await frame.getByRole('button',{name:'确定',exact:true}).click()
    await changeMode('edit',true)
    assert.equal(await frame.locator('html').getAttribute('data-host-readonly'),'true')
    await frame.locator('body').evaluate(()=>window.testRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange('D20').setValue('文件只读仍生效'))
    assert.equal(await frame.locator('body').evaluate(()=>window.testRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange('D20').getValue()),'同实例编辑保存')
    await frame.getByRole('button',{name:'确定',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.changes.length),originalChanges)
    for(const width of [490,640]){await page.setViewportSize({width,height:800});await changeMode('preview');await expect(frame.locator('.excel-header')).toBeHidden();await expect(frame.locator('.zoom-value')).toBeVisible();await expect(frame.locator('[data-u-comp="slide-tab-bar"]')).toBeVisible();assert.deepEqual(await frame.locator('.status-bar').evaluate(node=>{const rect=node.getBoundingClientRect();return{height:rect.height,bottom:rect.bottom,fontSize:getComputedStyle(node).fontSize}}),{height:28,bottom:800,fontSize:'12px'});await changeMode('edit');assert.deepEqual(await frame.locator('.status-bar').evaluate(node=>{const rect=node.getBoundingClientRect();return{height:rect.height,bottom:rect.bottom,fontSize:getComputedStyle(node).fontSize}}),{height:28,bottom:800,fontSize:'12px'});for(const control of ['.view-switch','.zoom-slider','.zoom-btn','.zoom-value'])for(const node of await frame.locator('.status-bar '+control).all())assert.equal(await node.evaluate(node=>{const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.height>0}),true,`${control} stays usable at ${width}`);for(const button of await frame.locator('.status-right .zoom-btn,.status-right .view-btn').all())assert.deepEqual(await button.evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})),{width:24,height:24});await changeMode('preview')}
    await mkdir(new URL('./output/',import.meta.url),{recursive:true});await page.screenshot({path:new URL(`./output/presentation-${name}-640.png`,import.meta.url).pathname});await writeFile(new URL(`./output/presentation-${name}.json`,import.meta.url),JSON.stringify({view:before,visuals:initialVisuals,exports:1,sameFrame:true,sameWorkbook:true,savedBytes:saved.length,errors},null,2))
    assert.deepEqual(errors,[])
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)) }
})

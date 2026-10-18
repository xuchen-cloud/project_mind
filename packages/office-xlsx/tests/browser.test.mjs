import {withRendererResources} from './renderer-server.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium, webkit } from '@playwright/test'
import { inspect, edit } from '../dist/engine.mjs'

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) test(`${name}: real Univer cell pending commit, save, freeze, undo/redo and rebase`, {timeout:120000}, async () => {
  // Missing bundle is a concrete red at the public browser entry point.
  const bundle = await readFile(new URL('../dist/browser.mjs', import.meta.url))
  const css = await readFile(new URL('../dist/browser.css', import.meta.url))
  const original = await readFile(new URL('./fixtures/simple.original.xlsx', import.meta.url))
  const model = await inspect(original)
  const appCss = await readFile(new URL('../../../src/styles/app.css', import.meta.url), 'utf8')
  const tokens = appCss.match(/:root\s*\{[\s\S]*?\n\}/)[0]
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}</style><link rel="stylesheet" href="/browser.css"></head>
    <body style="margin:0"><div id="editor" style="width:100vw;height:100vh"></div>
    <script type="module">import {mount} from '/browser.mjs';
    window.model=${JSON.stringify(model)}; window.changes=[]; window.pending=false; window.pendingStates=[];
    window.props={model:window.model,edits:[],readOnly:false,onPendingChange(pending){window.pending=pending;window.pendingStates.push({pending,edits:structuredClone(window.props.edits)})},onChange(edits){window.changes.push(edits);window.props.edits=edits;window.editor.update(window.props)}};
    window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true;</script></body></html>`
  const server = createServer(withRendererResources((req, res) => {
    if (req.url === '/browser.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle) }
    else if (req.url === '/browser.css') { res.setHeader('Content-Type', 'text/css'); res.end(css) }
    else { res.setHeader('Content-Type', 'text/html'); res.end(html) }
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await engine.launch({ headless: true,
      ...(name === 'WebKit' && process.env.OFFICE_WEBKIT_EXECUTABLE ? { executablePath: process.env.OFFICE_WEBKIT_EXECUTABLE } : {}) })
    await mkdir(new URL('./output/', import.meta.url), { recursive: true })
    await writeFile(new URL(`./output/${name.toLowerCase()}-version.json`, import.meta.url), JSON.stringify({ engine: name, version: browser.version() }))
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => { errors.push(error.message); console.error('Browser error:', error.stack) })
    console.log(name,'navigating')
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    console.log(name,'navigated')
    await page.waitForFunction(() => window.ready, undefined, {timeout:30000})
    console.log(name,'ready')
    const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]')
    const commit=async()=>{await page.evaluate(()=>{window.commitStatus='waiting';void window.editor.commitEditing().then(()=>{window.commitStatus='done'},error=>{window.commitStatus=String(error.message??error)})});await page.waitForFunction(()=>window.commitStatus!=='waiting');assert.equal(await page.evaluate(()=>window.commitStatus),'done')}
    await frame.locator('canvas:visible').first().waitFor()
    await mkdir(new URL('./output/', import.meta.url), { recursive: true })
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-wide.png`, import.meta.url).pathname })
    await writeFile(new URL('./output/browser.html', import.meta.url), await page.evaluate(()=>{const root=document.documentElement.cloneNode(true);root.querySelectorAll('script,style').forEach(n=>n.remove());root.querySelectorAll('iframe').forEach(n=>n.removeAttribute('srcdoc'));return root.outerHTML}))
    console.log(name,'initial view captured')
    // Navigate with the native name box, then type into the actual cell editor.
    await frame.locator('input[type="text"]:visible').first().waitFor()
    const inputs = await frame.locator('input').evaluateAll((nodes) => nodes.map((n) => ({ placeholder:n.placeholder, value:n.value, aria:n.getAttribute('aria-label') })))
    assert.ok(inputs.length, 'native name box exists')
    const nameBox = frame.locator('input[type="text"]:visible').last()
    await nameBox.fill('A3')
    await nameBox.press('Enter')
    assert.equal(await page.evaluate(() => window.pending), false, 'selection alone is not pending')
    await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => window.pending), false, 'opening an unchanged cell is not pending')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('香蕉（UI编辑）')
    await page.waitForFunction(() => window.pending)
    assert.equal(await page.evaluate(() => window.pending), true, 'actual pending input protects the model before journal commit')
    assert.deepEqual(await page.evaluate(() => window.props.edits), [], 'uncommitted cell is not yet journalled')
    console.log(name,'pending input observed')
    await commit()
    console.log(name,'input committed')
    assert.equal(await page.evaluate(() => window.pending), false)
    assert.equal(await page.evaluate(() => window.pendingStates.at(-1).edits[0].changes.edits.find(e=>e.row===2&&e.column===0).value), '香蕉（UI编辑）', 'journal settles before pending clears')
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-edited.png`, import.meta.url).pathname })
    assert.equal(await page.evaluate(() => window.props.edits[0].changes.edits.find(e=>e.row===2&&e.column===0).value), '香蕉（UI编辑）')
    await frame.getByRole('button',{name:'撤销',exact:true}).click()
    await commit()
    await writeFile(new URL('./output/undo-draft.json',import.meta.url),JSON.stringify(await page.evaluate(()=>window.props.edits),null,2))
    await page.waitForFunction(() => window.props.edits.length === 0)
    await frame.getByRole('button',{name:'重做',exact:true}).click()
    await page.waitForFunction(() => window.props.edits.length === 1)
    await nameBox.fill('D20')
    await nameBox.press('Enter')
    await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.type('7')
    await commit()
    await page.waitForFunction(() => window.props.edits[0]?.changes.edits.some((e) => e.row === 19 && e.column === 3 && e.value === 7))
    console.log(name,'undo redo and second input committed')
    const draft = await page.evaluate(() => window.props.edits)
    await page.evaluate(() => { window.props = {...window.props,readOnly:true};window.editor.update(window.props) })
    assert.deepEqual(await page.evaluate(() => window.props.edits), draft, 'freeze retains committed cell input')
    const saved = await edit(original, draft)
    const fresh = await inspect(saved)
    assert.equal(fresh.ranges['sheet-1'].cells.find((c) => c.row === 2 && c.column === 0).value, '香蕉（UI编辑）')
    assert.equal(fresh.ranges['sheet-1'].cells.find((c) => c.row === 19 && c.column === 3).value, 7)
    const count = await page.evaluate(() => window.changes.length)
    await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('F2')
    await page.keyboard.type('拒绝修改')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.changes.length), count)
    await page.evaluate((fresh) => {
      window.props={...window.props,model:fresh,edits:[],readOnly:false};window.editor.update(window.props)
    }, fresh)
    await page.evaluate(() => window.editor.ready)
    assert.deepEqual(await page.evaluate(() => window.props.edits), [])
    console.log(name,'saved and rebased')
    const currentNameBox = frame.locator('input[type="text"]:visible').last()
    await currentNameBox.fill('D22')
    await currentNameBox.press('Enter')
    await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.type('cancelled')
    await page.screenshot({path:new URL(`./output/rebase-${name.toLowerCase()}.png`,import.meta.url).pathname})
    await page.waitForFunction(() => window.pending)
    assert.equal(await page.evaluate(() => window.pending), true)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.pending)
    assert.deepEqual(await page.evaluate(() => window.props.edits), [], 'Escape cancels pending cell without a draft')
    await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.type('=IF(TRUE,"text result","other")')
    await commit()
    const formulaDraft=await page.evaluate(()=>window.props.edits)
    const formulaSaved=await inspect(await edit(saved,formulaDraft))
    assert.equal(formulaSaved.ranges['sheet-1'].cells.find(c=>c.row===21&&c.column===3).value,'text result')
    console.log(name,'formula saved')
    // Recover a dirty editor from its public JSON draft, then add another edit.
    await page.evaluate(()=>{window.editor.dispose();window.editor=undefined})
    await page.evaluate(async()=>{const {mount}=await import('/browser.mjs');window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready})
    const restoredNameBox=frame.locator('input[type="text"]:visible').last()
    await restoredNameBox.fill('E22');await restoredNameBox.press('Enter');await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.type('=TRUE()');await commit()
    const restored=await inspect(await edit(saved,await page.evaluate(()=>window.props.edits)))
    assert.equal(restored.ranges['sheet-1'].cells.find(c=>c.row===21&&c.column===3).value,'text result')
    assert.equal(restored.ranges['sheet-1'].cells.find(c=>c.row===21&&c.column===4).value,true)
    await page.setViewportSize({ width: 560, height: 520 })
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-narrow.png`, import.meta.url).pathname })
    // A real candidate extends beyond the old fixed viewport.
    const partial = await inspect(await edit(await readFile(new URL('./fixtures/complex.original.xlsx', import.meta.url)), [
      { sheetId: 'sheet-1', row: 100, column: 26, kind: 'number', value: 7 },
    ]))
    await page.evaluate((model) => { window.props={...window.props,model,edits:[]};window.editor.update(window.props) }, partial)
    await page.evaluate(() => window.editor.ready)
    await frame.locator('[data-print-visual]').first().waitFor()
    assert.ok(await frame.locator('[data-print-visual]').count()>0, 'source visuals are really rendered')
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-scope.png`, import.meta.url).pathname })
    assert.deepEqual(errors, [])
    await page.evaluate(() => window.editor.dispose())
    assert.equal(await page.locator('iframe').count(), 0)
    await page.waitForTimeout(100)
    assert.deepEqual(errors, [], 'disposing an editor cancels pending SDK work')
  } catch(error) { console.error(name,'failed:',error);throw error } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)) }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium, webkit } from '@playwright/test'
import { inspect, edit } from '../dist/engine.mjs'

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) test(`${name}: real Univer cell pending commit, save, freeze, undo/redo and rebase`, async () => {
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
  const server = createServer((req, res) => {
    if (req.url === '/browser.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle) }
    else if (req.url === '/browser.css') { res.setHeader('Content-Type', 'text/css'); res.end(css) }
    else { res.setHeader('Content-Type', 'text/html'); res.end(html) }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await engine.launch({ headless: true,
      ...(name === 'WebKit' && process.env.OFFICE_WEBKIT_EXECUTABLE ? { executablePath: process.env.OFFICE_WEBKIT_EXECUTABLE } : {}) })
    await writeFile(new URL(`./output/${name.toLowerCase()}-version.json`, import.meta.url), JSON.stringify({ engine: name, version: browser.version() }))
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => { errors.push(error.message); console.error('Browser error:', error.stack) })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.ready)
    assert.equal(await page.getByRole('note').isVisible(), false, 'complete simple model has no scope notice')
    await page.locator('canvas:visible').first().waitFor()
    await mkdir(new URL('./output/', import.meta.url), { recursive: true })
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-wide.png`, import.meta.url).pathname })
    await writeFile(new URL('./output/browser.html', import.meta.url), await page.content())
    // Navigate with the native name box, then type into the actual cell editor.
    await page.locator('input').first().waitFor()
    const inputs = await page.locator('input').evaluateAll((nodes) => nodes.map((n) => ({ placeholder:n.placeholder, value:n.value, aria:n.getAttribute('aria-label') })))
    assert.ok(inputs.length, 'native name box exists')
    const nameBox = page.locator('input').filter({ visible: true }).first()
    await nameBox.fill('A3')
    await nameBox.press('Enter')
    assert.equal(await page.evaluate(() => window.pending), false, 'selection alone is not pending')
    await page.mouse.dblclick(115, 150)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => window.pending), false, 'opening an unchanged cell is not pending')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('香蕉（UI编辑）')
    assert.equal(await page.evaluate(() => window.pending), true, 'actual pending input protects the model before journal commit')
    assert.deepEqual(await page.evaluate(() => window.props.edits), [], 'uncommitted cell is not yet journalled')
    await page.evaluate(() => window.editor.commitEditing())
    assert.equal(await page.evaluate(() => window.pending), false)
    assert.equal(await page.evaluate(() => window.pendingStates.at(-1).edits[0].value), '香蕉（UI编辑）', 'journal settles before pending clears')
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-edited.png`, import.meta.url).pathname })
    await page.waitForFunction(() => window.changes.flat().some((edit) => edit.row === 2 && edit.column === 0 && edit.value === '香蕉（UI编辑）'))
    assert.deepEqual(await page.evaluate(() => window.props.edits), [
      { sheetId: 'sheet-1', row: 2, column: 0, kind: 'string', value: '香蕉（UI编辑）' },
    ])
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.waitForFunction(() => window.props.edits.length === 0)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await page.waitForFunction(() => window.props.edits.length === 1)
    await nameBox.fill('D20')
    await nameBox.press('Enter')
    await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.type('7')
    await page.evaluate(() => window.editor.commitEditing())
    await page.waitForFunction(() => window.props.edits.some((e) => e.row === 19 && e.column === 3 && e.value === 7))
    const draft = await page.evaluate(() => window.props.edits)
    await page.evaluate(() => { window.props = {...window.props,readOnly:true};window.editor.update(window.props) })
    assert.deepEqual(await page.evaluate(() => window.props.edits), draft, 'freeze retains committed cell input')
    const saved = await edit(original, draft)
    const fresh = await inspect(saved)
    assert.equal(fresh.ranges['sheet-1'].cells.find((c) => c.row === 2 && c.column === 0).value, '香蕉（UI编辑）')
    assert.equal(fresh.ranges['sheet-1'].cells.find((c) => c.row === 19 && c.column === 3).value, 7)
    const count = await page.evaluate(() => window.changes.length)
    await page.keyboard.type('拒绝修改')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.changes.length), count)
    await page.evaluate((fresh) => {
      window.props={...window.props,model:fresh,edits:[],readOnly:false};window.editor.update(window.props)
    }, fresh)
    await page.evaluate(() => window.editor.ready)
    assert.deepEqual(await page.evaluate(() => window.props.edits), [])
    const currentNameBox = page.locator('input').filter({ visible: true }).first()
    await currentNameBox.fill('D22')
    await currentNameBox.press('Enter')
    await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.type('cancelled')
    assert.equal(await page.evaluate(() => window.pending), true)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.pending)
    assert.deepEqual(await page.evaluate(() => window.props.edits), [], 'Escape cancels pending cell without a draft')
    await page.keyboard.press('F2')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.type('TRUE')
    assert.equal(await page.evaluate(() => window.pending), true)
    assert.match(await page.evaluate(async () => { try { await window.editor.commitEditing(); return 'incorrectly committed' } catch (error) { return error.message } }), /布尔文本/)
    assert.equal(await page.evaluate(() => window.pending), true, 'refused input stays pending')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.pending)
    await page.setViewportSize({ width: 560, height: 520 })
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-narrow.png`, import.meta.url).pathname })
    // A real candidate extends the source to AA101; inspect still loads A1:Z100.
    const partial = await inspect(await edit(await readFile(new URL('./fixtures/complex.original.xlsx', import.meta.url)), [
      { sheetId: 'sheet-1', row: 100, column: 26, kind: 'number', value: 7 },
    ]))
    await page.evaluate((model) => { window.props={...window.props,model,edits:[]};window.editor.update(window.props) }, partial)
    await page.evaluate(() => window.editor.ready)
    await page.getByRole('note').waitFor()
    assert.match(await page.getByRole('note').textContent(), /A1–Z100；其余区域保留/)
    assert.match(await page.getByRole('note').textContent(), /图表、图片暂未预览，原件内容仍保留/)
    await page.screenshot({ path: new URL(`./output/xlsx-${name.toLowerCase()}-scope.png`, import.meta.url).pathname })
    await page.getByText('说明', { exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role=note]').textContent.includes('A1–Z100'))
    assert.deepEqual(errors, [])
    await page.evaluate(() => window.editor.dispose())
    assert.equal(await page.locator('canvas').count(), 0)
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)) }
})

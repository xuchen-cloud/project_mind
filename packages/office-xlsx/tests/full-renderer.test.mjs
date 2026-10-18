import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium,expect} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

test('complete Sheets ribbon edits a workbook and preserves original XLSX objects',async()=>{
 const source=await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)),model=await inspect(source)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh;--color-bg:#faf9f6;--color-bg-subtle:#f3f2ef;--color-border:#d6d4cf;--color-text-primary:#292d2c;--color-accent:#197a70;--font-ui:sans-serif}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onPendingChange(p){window.pending=p},onChange(edits){window.props={...window.props,edits};window.editor.update(window.props)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script></html>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log('renderer error:',m.text().slice(0,300))})
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 page.setDefaultTimeout(10000)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]')
 await frame.getByRole('button',{name:'插入',exact:true}).waitFor({timeout:15000})
 await page.waitForFunction(()=>window.ready,{timeout:20000})
 await mkdir(new URL('./output/',import.meta.url),{recursive:true})
 const checkToolbar=async(width)=>{
  await page.setViewportSize({width,height:800})
  assert.equal(await frame.locator('body').evaluate(node=>Math.round(node.getBoundingClientRect().width)),width)
  for(const label of ['开始','插入','页面布局','视图']){
   const button=frame.locator('.ribbon-tabs').getByRole('button',{name:label,exact:true});await button.scrollIntoViewIfNeeded()
   assert.equal(await button.evaluate(node=>node.scrollWidth<=node.clientWidth),true,`${label} label fits its hit area at ${width}px`)
  }
  assert.equal(await frame.locator('.ai-entry,.ai-chat-panel,.ai-panel,.copilot-panel').count(),0)
  assert.equal(await frame.getByText('Genspark AI',{exact:true}).count(),0)
  assert.equal(await frame.locator('.ribbon-tabs').getByRole('button',{name:'导出 CSV',exact:true}).count(),0)
  assert.equal(await frame.getByRole('button',{name:'文件',exact:true}).count(),0)
  assert.equal(await frame.locator('.autosave-toggle,button[data-tip="保存 (⌘S)"]').count(),0)
  await frame.getByRole('button',{name:'插入',exact:true}).click()
  await frame.getByRole('button',{name:'开始',exact:true}).click()
  await expect(frame.getByRole('button',{name:'开始',exact:true})).toHaveClass(/active/)
  await page.screenshot({path:new URL(`./output/full-renderer-${width}.png`,import.meta.url).pathname})
 }
 await checkToolbar(1200);await checkToolbar(640);await checkToolbar(490);await checkToolbar(360);await page.setViewportSize({width:1200,height:800})
 await page.screenshot({path:new URL('./output/full-renderer.png',import.meta.url).pathname})
 await writeFile(new URL('./output/full-renderer-dom.html',import.meta.url),await frame.locator('body').evaluate(node=>{const root=node.cloneNode(true);root.querySelectorAll('script,style').forEach(n=>n.remove());return root.innerHTML}))
 const nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.type('完整上游工具栏')
 await page.evaluate(()=>window.editor.commitEditing())
 await nameBox.fill('D20');await nameBox.press('Enter');await frame.locator('button[data-tip="加粗"]').click();await page.evaluate(()=>window.editor.commitEditing())
 await nameBox.fill('A2:B4');await nameBox.press('Enter');await frame.getByRole('button',{name:'插入',exact:true}).click()
 await frame.getByRole('button',{name:'柱形图 — 基于当前选区',exact:true}).click();await page.evaluate(()=>window.editor.commitEditing())
 await nameBox.fill('A2:B4');await nameBox.press('Enter')
 const createTable=frame.locator('button[data-tip="表格"]');if(!await createTable.isVisible())await frame.getByRole('button',{name:'插入',exact:true}).click();await createTable.click()
 await page.evaluate(()=>window.editor.commitEditing())
 const draft=await page.evaluate(()=>window.props.edits);await writeFile(new URL('./output/full-renderer-draft.json',import.meta.url),JSON.stringify(draft,null,2))
 assert.ok(draft[0]?.changes.edits.some(e=>e.row===19&&e.column===3&&e.value==='完整上游工具栏'))
 const fresh=await inspect(await edit(source,draft));assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===19&&c.column===3)?.value,'完整上游工具栏');assert.equal(fresh.styles[fresh.ranges['sheet-1'].cells.find(c=>c.row===19&&c.column===3).styleIndex].bold,true);assert.equal(fresh.visuals.length,model.visuals.length+1);assert.ok(draft[0].changes.visualAdditions.some(v=>!!v.chart));assert.equal(fresh.sheets[0].tables.length,model.sheets[0].tables.length+1)
 assert.deepEqual(errors,[])
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

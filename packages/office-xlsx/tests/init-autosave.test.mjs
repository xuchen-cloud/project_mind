import {withRendererResources} from './renderer-server.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium,webkit,expect} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

// Run against the built production iframe; no mocked journal or App callbacks.
for(const [name,browserType]of[['chromium',chromium],['webkit',webkit]])test(`${name}: opening and entering edit does not change or autosave a complex workbook`,{timeout:90000},async()=>{
 const source=await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)),model=await inspect(source)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.events=[];window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,presentationMode:'preview',onChange(edits){window.props.edits=edits;window.events.push({type:'change',edits});window.editor.update(window.props)},onPendingChange(value){window.events.push({type:'pending',value})},onSaveRequest:async()=>{window.events.push({type:'saveRequest'});await window.saveOriginalFile(window.props.edits)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer(withRendererResources((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':req.url==='/browser.css'?'text/css':'text/html');res.end(req.url==='/browser.mjs'?bundle:req.url==='/browser.css'?css:html)}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await browserType.launch({headless:true})
 const evidence=process.env.XLSX_EVIDENCE_DIR
 try{
  const page=await browser.newPage({viewport:{width:640,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000)
  // Observe the actual adapter context without adding a production debug API.
  await page.addInitScript(()=>Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,set(host){const render=host.render;host.render=function(context){window.testContext=context;return render(context)};Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,writable:true,value:host})}}))
  let written,saveCount=0;await page.exposeFunction('saveOriginalFile',async changes=>{written=await edit(source,changes);saveCount++})
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
  const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]')
  await frame.locator('.xlsx-print-visual img').first().waitFor();await frame.locator('svg.chart-svg').first().waitFor()
  const idle=async phase=>{
   // Covers the host's 1200ms debounce plus a subsequent upstream blur save tick.
   await page.waitForTimeout(1600);await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('blur')));await page.waitForTimeout(200)
   const events=await page.evaluate(()=>window.events)
   const journal=await frame.locator('body').evaluate(()=>{const journal=window.testContext.lazyWorkbookRef.current.editJournal;return Object.fromEntries(Object.entries(journal).map(([key,value])=>[key,value instanceof Map?[...value]:value instanceof Set?[...value]:value]))})
   if(evidence){await mkdir(evidence,{recursive:true});await writeFile(`${evidence}/xlsx-init-${name}-${phase}.json`,JSON.stringify({phase,events,journal,errors},null,2))}
   assert.deepEqual(events.filter(event=>event.type==='change'||event.type==='saveRequest'),[],`${phase}: no data/version writes without user edits`)
   assert.equal(events.some(event=>event.type==='pending'&&event.value===true),false,`${phase}: initialization is clean`)
  }
  await idle('preview')
  await page.evaluate(()=>{window.props={...window.props,presentationMode:'edit'};window.editor.update(window.props)})
  await expect(frame.locator('html')).toHaveAttribute('data-presentation-mode','edit');await idle('enter-edit')
  await page.evaluate(()=>window.editor.commitEditing());await idle('clean-commit')
  await frame.locator('body').click({position:{x:4,y:4}});await page.keyboard.press('ControlOrMeta+s');await idle('clean-save-shortcut')
  // Real user input still crosses the same save callback and gateway byte path.
  const nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.type('初始化后真实编辑')
  await page.evaluate(()=>window.editor.commitEditing());await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('blur')));await page.waitForTimeout(1600)
  assert.equal(saveCount,0,'the upstream blur/interval autosave does not compete with the host')
  assert.ok((await page.evaluate(()=>window.events)).some(event=>event.type==='change'&&event.edits.length>0),'real input still emits changes')
  await frame.getByRole('button',{name:'撤销',exact:true}).click();await page.evaluate(()=>window.editor.commitEditing())
  assert.deepEqual(await page.evaluate(()=>window.props.edits),[],'undo back to the source must still emit the empty draft')
  await frame.getByRole('button',{name:'重做',exact:true}).click();await page.evaluate(()=>window.editor.commitEditing())
  assert.ok((await page.evaluate(()=>window.props.edits)).length>0)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(()=>saveCount,{timeout:15000}).toBeGreaterThan(0)
  const reopened=await inspect(written)
  assert.equal(reopened.ranges['sheet-1'].cells.find(cell=>cell.row===19&&cell.column===3)?.value,'初始化后真实编辑')
  assert.equal(reopened.visuals.length,model.visuals.length)
  assert.equal(reopened.ranges['sheet-1'].cells.find(cell=>cell.row===4&&cell.column===1)?.formula,model.ranges['sheet-1'].cells.find(cell=>cell.row===4&&cell.column===1)?.formula)
  assert.deepEqual(errors,[])
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})

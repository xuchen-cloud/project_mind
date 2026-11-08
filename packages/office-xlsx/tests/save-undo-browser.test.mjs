import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'
import {withRendererResources} from './renderer-server.mjs'

test('explicit native save acknowledgements preserve selection and AI/manual undo across autosave', {timeout:60000},async()=>{
 let bytes=await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url));const base=bytes,model=await inspect(bytes),saved=[];let releaseSave,saveGate
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<link rel="stylesheet" href="/browser.css"><div id="editor" style="height:100vh"></div><script type="module">import{mount}from'/browser.mjs';window.saves=0;let timer;window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits,snapshot){window.props.edits=edits;window.revision=snapshot?.editRevision;clearTimeout(timer);if(window.autosave!==false)timer=setTimeout(()=>window.saveNow(),1200)}};window.saveNow=async()=>{clearTimeout(timer);try{await window.editor.commitEditing();const revision=window.revision;if(!Number.isInteger(revision))throw Error('missing snapshot revision');const edits=window.props.edits;await window.nativeSave(edits);window.props={...window.props,savedEditRevision:revision};window.editor.update(window.props);window.saves++;}catch(error){window.failure=String(error)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer(withRendererResources((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':req.url==='/browser.css'?'text/css':'text/html');res.end(req.url==='/browser.mjs'?bundle:req.url==='/browser.css'?css:html)}))
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{
 const page=await browser.newPage({viewport:{width:1200,height:800}});await page.exposeFunction('nativeSave',async edits=>{if(saveGate)await saveGate;bytes=await edit(base,edits);const model=await inspect(bytes);saved.push(model);return model})
 await page.addInitScript(() => Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,set(host){const render=host.render;host.render=function(context){window.testContext=context;return render(context)};Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,writable:true,value:host})}}));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 await page.evaluate(()=>{window.originalFrame=document.querySelector('iframe');window.originalReady=window.editor.ready;window.originalUnit=window.originalFrame.contentWindow.testContext.univerRef.current.univerAPI.getActiveWorkbook().getWorkbook()})
 const renderer=page.frames()[1];await renderer.evaluate(()=>{window.originalWorkbook=window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getWorkbook();});
 const frame=page.frameLocator('iframe'),name=frame.locator('input[type="text"]:visible').last(),select=async range=>{await name.fill(range);await name.press('Enter')}
 const savedCount=async count=>{await page.waitForFunction(count=>window.saves>=count||window.failure,count);assert.equal(await page.evaluate(()=>window.failure),undefined);assert.equal(await page.evaluate(()=>window.originalFrame===document.querySelector('iframe')),true);assert.equal(await page.evaluate(()=>window.originalReady===window.editor.ready),true);assert.equal(await renderer.evaluate(()=>window.originalWorkbook===window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getWorkbook()),true)}
 await select('B3:B4');await page.evaluate(async()=>{const selection=await window.editor.captureSelection();await window.editor.applySelection({selectionId:selection.selectionId,change:{cells:[{row:2,column:1,kind:'number',value:15},{row:3,column:1,kind:'formula',formula:'=B3*2'}]}})})
 await savedCount(1)
 assert.deepEqual(JSON.parse((await page.evaluate(()=>window.editor.captureSelection())).text).range,{startRow:2,endRow:3,startColumn:1,endColumn:1})
 await frame.getByRole('button',{name:'撤销',exact:true}).click();await savedCount(2)
 const cell=(model,row)=>model.ranges['sheet-1'].cells.find(c=>c.row===row&&c.column===1)
 assert.equal(cell(saved[0],2).value,15);assert.equal(cell(saved[0],3).formula,'=B3*2');assert.equal(cell(saved[1],2).value,10);assert.equal(cell(saved[1],3).value,20);assert.equal(cell(saved[1],3).formula,undefined)
 await select('B3');await page.keyboard.press('F2');await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('25');await page.evaluate(()=>window.editor.commitEditing());await savedCount(3)
 await frame.getByRole('button',{name:'撤销',exact:true}).click();await savedCount(4);assert.equal(cell(saved[2],2).value,25);assert.equal(cell(saved[3],2).value,10)
 // Delay the real byte writer, then continue typing before its old receipt arrives.
 await page.evaluate(()=>{window.autosave=false});await select('B3');await page.keyboard.press('F2');await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('30');await page.evaluate(()=>window.editor.commitEditing())
 saveGate=new Promise(resolve=>{releaseSave=resolve});await page.evaluate(()=>{window.inFlight=window.saveNow()});await page.waitForTimeout(50)
 await select('B3');await page.keyboard.press('F2');await renderer.waitForFunction(()=>window.testContext.isCellEditing());await renderer.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('40')
 const typing=await renderer.evaluate(()=>{window.typingNode=document.activeElement;return {text:document.activeElement?.textContent,editing:window.testContext.isCellEditing(),html:document.activeElement?.outerHTML}})
 const beforeReceipt=await renderer.evaluate(()=>window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState());releaseSave();await page.evaluate(()=>window.inFlight);saveGate=undefined;await savedCount(5)
 assert.equal(await renderer.evaluate(()=>window.typingNode===document.activeElement),true)
 assert.equal(await renderer.evaluate(()=>document.activeElement?.textContent),typing.text)
 assert.equal(cell(saved[4],2).value,30);assert.deepEqual(await renderer.evaluate(()=>window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState()),beforeReceipt)
 await page.evaluate(()=>window.editor.commitEditing());await page.evaluate(()=>window.saveNow());await savedCount(6);assert.equal(cell(saved[5],2).value,40)
 await frame.getByRole('button',{name:'撤销',exact:true}).click();await page.evaluate(()=>window.saveNow());await savedCount(7);assert.equal(cell(saved[6],2).value,30)
 await select('B3');const oldSelection=await page.evaluate(()=>window.editor.captureSelection())
 // Structural changes use the same original XML source and cumulative journal.
 await renderer.evaluate(()=>window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().insertRowsBefore(2,10))
 await page.evaluate(()=>window.saveNow());await savedCount(8);assert.equal(cell(saved[7],12).value,30)
 await renderer.evaluate(()=>window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().getRange(12,1).setValue(50))
 await page.evaluate(()=>window.saveNow());await savedCount(9);assert.equal(cell(saved[8],12).value,50)
 await page.setViewportSize({width:1200,height:600});await renderer.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await renderer.evaluate(()=>{const sheet=window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet();sheet.setActiveRange(sheet.getRange('B19'));sheet.scrollToCell(18,1,0)});await renderer.waitForFunction(()=>window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState().sheetViewStartRow>0)
 const scrolled=await renderer.evaluate(()=>window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState());await page.evaluate(()=>window.saveNow());await savedCount(10);assert.deepEqual(await renderer.evaluate(()=>window.testContext.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState()),scrolled)
 await page.evaluate(async()=>{window.props={...window.props,model:structuredClone(window.props.model),savedModelUpdate:undefined};window.editor.update(window.props);await window.editor.ready})
 assert.equal(await page.evaluate(()=>window.originalFrame===document.querySelector('iframe')),false)
 await assert.rejects(page.evaluate(selectionId=>window.editor.applySelection({selectionId,change:{cells:[{row:2,column:1,kind:'blank'}]}}),oldSelection.selectionId),/失效|变化/)
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

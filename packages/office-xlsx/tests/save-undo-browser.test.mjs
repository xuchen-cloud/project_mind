import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'
import {withRendererResources} from './renderer-server.mjs'

test('explicit native save acknowledgements preserve selection and AI/manual undo across autosave', {timeout:60000},async()=>{
 let bytes=await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url));const model=await inspect(bytes),saved=[]
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url))
 const html=`<div id="editor" style="height:100vh"></div><script type="module">import{mount}from'/browser.mjs';window.saves=0;let timer;window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits;clearTimeout(timer);if(edits.length)timer=setTimeout(async()=>{try{await window.editor.commitEditing();window.props.readOnly=true;window.editor.update(window.props);const previous=window.props.model,model=await window.nativeSave(window.props.edits);window.props={...window.props,model,edits:[],readOnly:false,savedModelUpdate:{previous,current:model}};window.editor.update(window.props);await window.editor.ready;window.saves++;}catch(error){window.failure=String(error)}},1200)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer(withRendererResources((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':'text/html');res.end(req.url==='/browser.mjs'?bundle:html)}))
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{
 const page=await browser.newPage({viewport:{width:1200,height:800}});await page.exposeFunction('nativeSave',async edits=>{bytes=await edit(bytes,edits);const model=await inspect(bytes);saved.push(model);return model})
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 await page.evaluate(()=>{window.originalFrame=document.querySelector('iframe')})
 const frame=page.frameLocator('iframe'),name=frame.locator('input[type="text"]:visible').last(),select=async range=>{await name.fill(range);await name.press('Enter')}
 const savedCount=async count=>{await page.waitForFunction(count=>window.saves>=count||window.failure,count);assert.equal(await page.evaluate(()=>window.failure),undefined);assert.equal(await page.evaluate(()=>window.originalFrame===document.querySelector('iframe')),true)}
 await select('B3:B4');await page.evaluate(async()=>{const selection=await window.editor.captureSelection();await window.editor.applySelection({selectionId:selection.selectionId,change:{cells:[{row:2,column:1,kind:'number',value:15},{row:3,column:1,kind:'formula',formula:'=B3*2'}]}})})
 await savedCount(1)
 assert.deepEqual(JSON.parse((await page.evaluate(()=>window.editor.captureSelection())).text).range,{startRow:2,endRow:3,startColumn:1,endColumn:1})
 await frame.getByRole('button',{name:'撤销',exact:true}).click();await savedCount(2)
 const cell=(model,row)=>model.ranges['sheet-1'].cells.find(c=>c.row===row&&c.column===1)
 assert.equal(cell(saved[0],2).value,15);assert.equal(cell(saved[0],3).formula,'=B3*2');assert.equal(cell(saved[1],2).value,10);assert.equal(cell(saved[1],3).value,20);assert.equal(cell(saved[1],3).formula,undefined)
 await select('B3');await page.keyboard.press('F2');await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('25');await page.evaluate(()=>window.editor.commitEditing());await savedCount(3)
 await frame.getByRole('button',{name:'撤销',exact:true}).click();await savedCount(4);assert.equal(cell(saved[2],2).value,25);assert.equal(cell(saved[3],2).value,10)
 const oldSelection=await page.evaluate(()=>window.editor.captureSelection())
 await page.evaluate(async()=>{window.props={...window.props,model:structuredClone(window.props.model),savedModelUpdate:undefined};window.editor.update(window.props);await window.editor.ready})
 assert.equal(await page.evaluate(()=>window.originalFrame===document.querySelector('iframe')),false)
 await assert.rejects(page.evaluate(selectionId=>window.editor.applySelection({selectionId,change:{cells:[{row:2,column:1,kind:'blank'}]}}),oldSelection.selectionId),/失效|变化/)
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

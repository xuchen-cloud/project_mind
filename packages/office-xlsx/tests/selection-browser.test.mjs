import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'
import {withRendererResources} from './renderer-server.mjs'

test('public selection bridge freezes target, preserves undo, rejects stale and persists through native save', {timeout:120000},async()=>{
 const source=await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url)),model=await inspect(source)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url))
 const html=`<div id="editor" style="height:100vh"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer(withRendererResources((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':'text/html');res.end(req.url==='/browser.mjs'?bundle:html)}))
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{
 const page=await browser.newPage({viewport:{width:1200,height:800}});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe'),name=frame.locator('input[type="text"]:visible').last()
 const select=async range=>{await name.fill(range);await name.press('Enter')}
 await page.frames()[1].evaluate(()=>window.dispatchEvent(new CompositionEvent('compositionstart')));await assert.rejects(page.evaluate(()=>window.editor.captureSelection()),/编辑/);await page.frames()[1].evaluate(()=>window.dispatchEvent(new CompositionEvent('compositionend')))
 await select('B3:B4');const captured=await page.evaluate(()=>window.editor.captureSelection());assert.deepEqual(JSON.parse(captured.text).range,{startRow:2,endRow:3,startColumn:1,endColumn:1})
 await select('D2')
 const apply=change=>page.evaluate(({selectionId,change})=>window.editor.applySelection({selectionId,change}),{selectionId:captured.selectionId,change})
 await assert.rejects(apply({cells:[{row:0,column:0,kind:'string',value:'outside'}]}),/选区/)
 await assert.rejects(apply({cells:[{row:2,column:1,kind:'number',value:1},{row:2,column:1,kind:'blank'}]}),/重复/)
 await apply({cells:[{row:2,column:1,kind:'number',value:15},{row:3,column:1,kind:'formula',formula:'=B3*2'}]})
 const draft=await page.evaluate(()=>window.props.edits),saved=await inspect(await edit(source,draft)),cells=saved.ranges['sheet-1'].cells
 assert.equal(cells.find(c=>c.row===2&&c.column===1).value,15);assert.equal(cells.find(c=>c.row===3&&c.column===1).formula,'=B3*2')
 await assert.rejects(apply({cells:[{row:2,column:1,kind:'number',value:99}]}),/失效|变化/)
 await page.keyboard.press('ControlOrMeta+z');await page.evaluate(()=>window.editor.commitEditing())
 const undone=await inspect(await edit(source,await page.evaluate(()=>window.props.edits)))
 assert.equal(undone.ranges['sheet-1'].cells.find(c=>c.row===2&&c.column===1).value,model.ranges['sheet-1'].cells.find(c=>c.row===2&&c.column===1).value)
 await select('A1:Q17');await assert.rejects(page.evaluate(()=>window.editor.captureSelection()),/256/)
 await select('B3');const stale=await page.evaluate(()=>window.editor.captureSelection())
 await page.keyboard.press('F2');await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('27');await page.evaluate(()=>window.editor.commitEditing())
 await assert.rejects(page.evaluate(selectionId=>window.editor.applySelection({selectionId,change:{cells:[{row:2,column:1,kind:'blank'}]}}),stale.selectionId),/失效|变化/)
 const fresh=await page.evaluate(()=>window.editor.captureSelection())
 await page.evaluate(()=>{window.props.readOnly=true;window.editor.update(window.props)})
 await assert.rejects(page.evaluate(selectionId=>window.editor.applySelection({selectionId,change:{cells:[{row:2,column:1,kind:'blank'}]}}),fresh.selectionId),/只读/)

 await assert.rejects(page.evaluate(()=>window.editor.captureSelection()),/只读/)
 await page.evaluate(()=>{window.props.readOnly=false;window.editor.update(window.props)})
 await select('B3');const literal=await page.evaluate(()=>window.editor.captureSelection())
 await page.evaluate(selectionId=>window.editor.applySelection({selectionId,change:{cells:[{row:2,column:1,kind:'string',value:'=1+1'}]}}),literal.selectionId)
 const literalSaved=await inspect(await edit(source,await page.evaluate(()=>window.props.edits))),literalCell=literalSaved.ranges['sheet-1'].cells.find(c=>c.row===2&&c.column===1)
 assert.equal(literalCell.value,'=1+1');assert.equal(literalCell.formula,undefined)
 await page.evaluate(()=>window.editor.dispose());await assert.rejects(page.evaluate(()=>window.editor.captureSelection()),/关闭/)

 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

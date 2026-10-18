import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import JSZip from 'jszip'
import {inspect,edit,recalculate} from '../dist/engine.mjs'

test('streamed workbook uses real readonly native calculation after an input and saves the original XLSX', {timeout:120000},async()=>{
 // Actual stored cells exceed formula mode; the large SUM exceeds the closure budget.
 const zip=await JSZip.loadAsync(await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url)))
 let xml=await zip.file('xl/worksheets/sheet1.xml').async('string')
 const rows=Array.from({length:50100-20+1},(_,i)=>`<row r="${i+20}"><c r="C${i+20}"><v>1</v></c></row>`).join('')
 xml=xml.replace(/<dimension\b[^>]*\/>/,'<dimension ref="A1:C50100"/>').replace('</sheetData>',`<row r="8"><c r="B8"><f>SUM(C20:C50100)</f><v>50081</v></c></row>${rows}</sheetData>`)
 zip.file('xl/worksheets/sheet1.xml',xml);const source=await zip.generateAsync({type:'nodebuffer'}),model=await inspect(source)
 assert.ok(model.sheets[0].storedCellCount>50000)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.requests=[];window.results=[];window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits},onRecalculate:async request=>{window.requests.push(request);const result=await window.nativeCalculate(request);window.results.push(result);return result}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.exposeFunction('nativeCalculate',request=>recalculate(source,request));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('B3');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('15');await page.evaluate(()=>window.editor.commitEditing())
 await page.waitForFunction(()=>window.requests.some(r=>r.edits.some(e=>e.row===2&&e.column===1&&e.input==='15')),undefined,{timeout:30000})
 await page.waitForFunction(()=>window.results.some(r=>r.cells.some(c=>c.row===4&&c.column===1&&c.number===35)),undefined,{timeout:30000})
 const draft=await page.evaluate(()=>window.props.edits),fresh=await inspect(await edit(source,draft));assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===4&&c.column===1)?.value,35);assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===6&&c.column===1)?.value,30);assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===50099&&c.column===2)?.value,1);assert.deepEqual(errors,[])
 await mkdir(new URL('./output/',import.meta.url),{recursive:true});await writeFile(new URL('./output/recalculate-ui.json',import.meta.url),JSON.stringify(await page.evaluate(()=>({requests:window.requests,results:window.results})),null,2));await page.screenshot({path:new URL('./output/recalculate-ui.png',import.meta.url).pathname})
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

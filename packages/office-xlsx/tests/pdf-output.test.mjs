import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect} from '../dist/engine.mjs'

test('PDF export awaits paginated HTML rendering then exports exact PDF bytes and respects cancellation',async()=>{
 const model=await inspect(await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)))
 const pdf=await readFile(new URL('./fixtures/host-output.pdf',import.meta.url))
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.renders=[];window.exports=[];window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits},onRenderPdf:async document=>{window.renders.push(document);return new Promise(resolve=>window.finishPdf=()=>resolve(new Uint8Array(${JSON.stringify([...pdf])})))},onExport:async file=>{window.exports.push({name:file.name,mime:file.mime,bytes:[...file.bytes]});return new Promise(resolve=>window.finishExport=resolve)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:850}}),downloads=[];page.on('download',d=>downloads.push(d.suggestedFilename()));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),dialog=frame.getByRole('dialog',{name:'打印',exact:true})
 const run=async()=>{await frame.getByRole('button',{name:'打印',exact:true}).click();await dialog.getByRole('button',{name:'打印为 PDF',exact:true}).click()}
 await run();await page.waitForFunction(()=>window.renders.length===1)
 const output=await page.evaluate(()=>window.renders[0]);assert.ok(output.title);assert.deepEqual(output.pageSize,{widthPt:595.44,heightPt:841.68});assert.match(output.html,/中文销售统计/);assert.match(output.html,/class="page /);assert.match(output.html,/data:font\//);assert.match(output.html,/<img[^>]+src="data:image\//);assert.doesNotMatch(output.html,/<(?:script|iframe|button|input)\b/i)
 assert.equal(await page.evaluate(()=>window.exports.length),0,'no export until native PDF bytes exist');assert.equal(await dialog.getByRole('button',{name:'打印为 PDF',exact:true}).isDisabled(),true)
 await page.evaluate(()=>window.finishPdf());await page.waitForFunction(()=>window.exports.length===1)
 const exported=await page.evaluate(()=>window.exports[0]);assert.equal(exported.mime,'application/pdf');assert.ok(exported.name.endsWith('.pdf'));assert.deepEqual(Buffer.from(exported.bytes),pdf)
 await page.evaluate(()=>window.finishExport(false));await dialog.waitFor({state:'hidden'});await frame.locator('.workbook-status').filter({hasText:'PDF 导出已取消'}).waitFor()
 await run();await page.waitForFunction(()=>window.renders.length===2);await page.evaluate(()=>window.finishPdf());await page.waitForFunction(()=>window.exports.length===2);await page.evaluate(()=>window.finishExport(true));await dialog.waitFor({state:'hidden'});assert.deepEqual(downloads,[])
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

test('whole-workbook PDF keeps official mixed paper sizes and sheet order',async()=>{
 const {default:JSZip}=await import('jszip'),{PDFDocument}=await import('pdf-lib')
 const zip=await JSZip.loadAsync(await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)))
 for(const [sheet,paper,orientation]of [[1,5,'landscape'],[2,11,'portrait']]){const path=`xl/worksheets/sheet${sheet}.xml`;let xml=await zip.file(path).async('string');xml=xml.replace(/<pageSetup\b[^>]*\/>/g,'').replace('</worksheet>',`<pageSetup paperSize="${paper}" orientation="${orientation}"/></worksheet>`);zip.file(path,xml)}
 const model=await inspect(await zip.generateAsync({type:'nodebuffer'})),bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.jobs=[];window.exports=[];window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(){},onRenderPdf:async document=>{window.jobs.push(document);return new Uint8Array(await window.nativeFixture(document.pageSize))},onExport:async file=>{window.exports.push([...file.bytes]);return true}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:850}});await page.exposeFunction('nativeFixture',async size=>{const pdf=await PDFDocument.create();pdf.addPage([size.widthPt,size.heightPt]);return [...await pdf.save()]});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]');await frame.getByRole('button',{name:'打印',exact:true}).click();const dialog=frame.getByRole('dialog',{name:'打印',exact:true});await dialog.locator('select:has(option[value=workbook])').selectOption('workbook');await dialog.getByRole('button',{name:'打印为 PDF',exact:true}).click();await page.waitForFunction(()=>window.exports.length===1)
 assert.deepEqual(await page.evaluate(()=>window.jobs.map(j=>j.pageSize)),[{widthPt:1008,heightPt:612},{widthPt:419.76,heightPt:595.44}]);const jobs=await page.evaluate(()=>window.jobs.map(j=>j.html));assert.match(jobs[0],/中文销售统计/);assert.doesNotMatch(jobs[1],/中文销售统计/)
 const pdf=await PDFDocument.load(new Uint8Array(await page.evaluate(()=>window.exports[0])));assert.deepEqual(pdf.getPages().map(p=>p.getSize()),[{width:1008,height:612},{width:419.76,height:595.44}])
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

// Native permission and actual screen collection are owned by the platform agent.
// This fixture exercises the public host callbacks, upstream picker and real PNG save.
test('screenshot picker awaits the chosen host PNG and saves a real image in XLSX',async()=>{
 const original=await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)),model=await inspect(original),media=model.rendererData.media['visual-2']
 const png=Buffer.from(media.base64,'base64'),capture={mediaType:'image/png',base64:media.base64,width:png.readUInt32BE(16),height:png.readUInt32BE(20)}
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.captures=[];window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits},async onCaptureScreenSources(){return{status:'ok',sources:[{id:'fixture-window',name:'合同测试窗口',kind:'window',thumbnail:'data:image/png;base64,${media.base64}'}]}},async onCaptureScreenSource(request){window.captures.push(request);return new Promise(resolve=>window.finishCapture=()=>resolve(${JSON.stringify(capture)}))}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]');await frame.getByRole('button',{name:'插入',exact:true}).click();await frame.getByRole('button',{name:'屏幕截图',exact:true}).click()
 const dialog=frame.getByRole('dialog',{name:'屏幕截图',exact:true});await dialog.getByRole('button',{name:'合同测试窗口',exact:true}).click();await page.waitForFunction(()=>window.captures.length===1)
 assert.deepEqual(await page.evaluate(()=>window.captures[0]),{id:'fixture-window'});assert.deepEqual(await page.evaluate(()=>window.props.edits),[],'no image before PNG capture resolves')
 await page.evaluate(()=>window.finishCapture());await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>window.props.edits[0]?.changes.visualAdditions.some(v=>!!v.image));await page.evaluate(()=>window.editor.commitEditing())
 const saved=await edit(original,await page.evaluate(()=>window.props.edits)),fresh=await inspect(saved);assert.equal(fresh.visuals.filter(v=>v.kind==='image').length,2)
 const image=fresh.visuals.filter(v=>v.kind==='image').at(-1),written=fresh.rendererData.media[image.id];assert.deepEqual(Buffer.from(written.base64,'base64'),png);assert.deepEqual(errors,[])
 await mkdir(new URL('./output/',import.meta.url),{recursive:true});await writeFile(new URL('./output/captured-image.xlsx',import.meta.url),saved);await page.screenshot({path:new URL('./output/captured-image.png',import.meta.url).pathname})
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

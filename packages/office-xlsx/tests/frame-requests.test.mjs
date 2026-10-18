import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect} from '../dist/engine.mjs'

test('accepted frame requests and beforeSave commits become inert when the workbook is replaced or disposed',async()=>{
 const model=await inspect(await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url))),bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.invoked=[];window.makeProps=(owner,model)=>({model,edits:[],readOnly:false,onChange(){},...Object.fromEntries(['onSaveRequest','onRecalculate','onInspectImportedWorkbook','onCaptureScreenSources','onCaptureScreenSource','onExport','onRenderPdf','onPrint'].map(name=>[name,async()=>{window.invoked.push(owner+':'+name)}]))});window.props=window.makeProps('old',${JSON.stringify(model)});window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage();await page.addInitScript(()=>{const NativeChannel=window.MessageChannel;window.channels=[];window.MessageChannel=class extends NativeChannel{constructor(){super();window.channels.push(this)}}});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 // Deliver requests on the actual dedicated MessagePort, then change File
 // synchronously before the Promise callbacks can start host IO.
 for(const action of ['replace','dispose']){
  const count=await page.evaluate(action=>{
   window.commitState='waiting';void window.editor.commitEditing().then(()=>window.commitState='resolved',()=>window.commitState='rejected');window.outputState='waiting';void window.editor.output('csv').then(()=>window.outputState='resolved',()=>window.outputState='rejected')
   const channel=window.channels.at(-1),requests=[['saveRequest'],['calculateRequest',{edits:[],reads:[]}],['inspectImportedRequest',new Uint8Array([1])],['captureSourcesRequest'],['captureSourceRequest',{id:'selected-source'}],['exportRequest',{name:'book.csv',mime:'text/csv',bytes:new Uint8Array([1])}],['renderPdfRequest',{html:'<html></html>'}],['printRequest',{html:'<html></html>'}]]
   requests.forEach(([type,value],id)=>channel.port1.dispatchEvent(new MessageEvent('message',{data:{officeXlsx:true,type,value,id:100+id}})))
   if(action==='replace'){window.props=window.makeProps('new',structuredClone(window.props.model));window.editor.update(window.props)}else window.editor.dispose()
   return window.channels.length
  },action)
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));assert.deepEqual(await page.evaluate(()=>window.invoked),[],`${action} must cancel every queued host action`);assert.equal(await page.evaluate(()=>window.commitState),'rejected',`${action} must reject a commit that crossed the ready await`);assert.equal(await page.evaluate(()=>window.outputState),'rejected',`${action} must reject output across ready await`)
  if(action==='replace'){await page.evaluate(()=>window.editor.ready);assert.equal(await page.evaluate(()=>window.channels.length),count+1,'replacement owns a new channel')}
 }
 // A fresh mount accepts exactly one bootstrap for its current iframe.
 await page.evaluate(async()=>{const{mount}=await import('/browser.mjs');window.props=window.makeProps('fresh',structuredClone(window.props.model));window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready})
 const counts=await page.evaluate(()=>{const before=window.channels.length,source=document.querySelector('iframe').contentWindow;window.dispatchEvent(new MessageEvent('message',{source,data:{officeXlsx:true,type:'bootstrap'}}));return{before,after:window.channels.length}});assert.equal(counts.after,counts.before,'duplicate bootstrap must not replace or leak a port')
 await page.evaluate(()=>{window.channels.at(-1).port1.dispatchEvent(new MessageEvent('message',{data:{officeXlsx:true,type:'saveRequest',id:999}}));window.props=window.makeProps('later-callback',window.props.model);window.editor.update(window.props)});await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));assert.deepEqual(await page.evaluate(()=>window.invoked),['fresh:onSaveRequest'],'same File callback refresh keeps the accepted request callback snapshot')
 await page.evaluate(()=>window.editor.dispose());await mkdir(new URL('./output/',import.meta.url),{recursive:true});await writeFile(new URL('./output/frame-requests-evidence.json',import.meta.url),JSON.stringify({invoked:await page.evaluate(()=>window.invoked),bootstrap:counts},null,2))
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

test('beforeSave and the original ready reject when replaced or disposed before the first iframe is ready',async()=>{
 const model=await inspect(await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url))),bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><link rel="stylesheet" href="/browser.css"><div id="editor" style="height:100vh"></div><script type="module">import{mount}from'/browser.mjs';window.mountEditor=mount;window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(){}};window.loaded=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.loaded)
 for(const action of ['replace','dispose']){
  const states=await page.evaluate(async action=>{
   const editor=window.mountEditor(document.getElementById('editor'),window.props),states={ready:'waiting',commit:'waiting',output:'waiting'}
   void editor.ready.then(()=>states.ready='resolved',()=>states.ready='rejected')
   void editor.commitEditing().then(()=>states.commit='resolved',()=>states.commit='rejected');void editor.output('csv').then(()=>states.output='resolved',()=>states.output='rejected')
   // No await: the first renderer has not bootstrapped, let alone sent ready.
   if(action==='replace')editor.update({...window.props,model:structuredClone(window.props.model)});else editor.dispose()
   await new Promise(resolve=>setTimeout(resolve,100));window.editor=editor;return states
  },action)
  assert.deepEqual(states,{ready:'rejected',commit:'rejected',output:'rejected'},`${action} must settle the original pre-ready promises`)
  if(action==='replace')await page.evaluate(()=>window.editor.ready)
  await page.evaluate(()=>window.editor.dispose())
 }
 // A host may close an unused editor without ever observing its ready promise.
 await page.evaluate(()=>{const editor=window.mountEditor(document.getElementById('editor'),window.props);editor.update({...window.props,model:structuredClone(window.props.model)});editor.dispose()})
 await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));assert.deepEqual(errors,[],'invalidated ready must not create an unhandled rejection')
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

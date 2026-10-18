import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

test('explicit save and the sole host autosave commit cells through the original File callback',async()=>{
 const source=await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url)),model=await inspect(source)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits;if(window.hostAutosave){clearTimeout(window.hostSaveTimer);window.hostSaveTimer=setTimeout(async()=>{await window.editor.commitEditing();await window.props.onSaveRequest()},1200)}},onSaveRequest:async()=>{await window.saveOriginalFile(window.props.edits)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:800}});let written,saveCount=0;await page.exposeFunction('saveOriginalFile',async changes=>{written=await edit(source,changes);saveCount++})
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.type('快捷键保存')
 await page.keyboard.press('ControlOrMeta+s');await new Promise((resolve,reject)=>{const until=Date.now()+15000;const timer=setInterval(()=>{if(written){clearInterval(timer);resolve()}else if(Date.now()>until){clearInterval(timer);reject(Error('Save shortcut did not reach the File callback'))}},50)})
 assert.equal((await inspect(written)).ranges['sheet-1'].cells.find(c=>c.row===19&&c.column===3)?.value,'快捷键保存')
 assert.equal(await frame.locator('.autosave-toggle').count(),0,'autosave is always on without a duplicate switch')
 await page.evaluate(()=>window.hostAutosave=true)
 await nameBox.fill('D21');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.type('默认自动保存');await page.evaluate(()=>window.editor.commitEditing())
 const previousSaves=saveCount;await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('blur')))
 await new Promise((resolve,reject)=>{const until=Date.now()+15000,timer=setInterval(()=>{if(saveCount>previousSaves&&written){clearInterval(timer);resolve()}else if(Date.now()>until){clearInterval(timer);reject(Error('Host AutoSave did not reach the File callback'))}},50)})
 assert.equal((await inspect(written)).ranges['sheet-1'].cells.find(c=>c.row===20&&c.column===3)?.value,'默认自动保存')
 await page.waitForTimeout(1600);assert.equal(saveCount,previousSaves+1,'one host autosave and no competing upstream blur save')
 await page.evaluate(()=>{window.props={...window.props,readOnly:true};window.editor.update(window.props)})
 await frame.locator('html').waitFor();await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.documentElement.dataset.hostReadonly==='true')
 const beforeReadonly=saveCount;await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('blur')));await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,100)))
 assert.equal(saveCount,beforeReadonly,'readonly does not trigger automatic writes')

 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

test('save shortcut commits active cell and awaits the original File save callback',async()=>{
 const source=await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url)),model=await inspect(source)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits},onSaveRequest:async()=>{await window.saveOriginalFile(window.props.edits)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:800}});let written;await page.exposeFunction('saveOriginalFile',async changes=>{written=await edit(source,changes)})
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.type('快捷键保存')
 await page.keyboard.press('ControlOrMeta+s');await new Promise((resolve,reject)=>{const until=Date.now()+15000;const timer=setInterval(()=>{if(written){clearInterval(timer);resolve()}else if(Date.now()>until){clearInterval(timer);reject(Error('Save shortcut did not reach the File callback'))}},50)})
 assert.equal((await inspect(written)).ranges['sheet-1'].cells.find(c=>c.row===19&&c.column===3)?.value,'快捷键保存')
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

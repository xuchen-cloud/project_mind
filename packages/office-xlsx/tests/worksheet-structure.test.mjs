import {withRendererResources} from './renderer-server.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

test('plain sheet copy, rename, order, visibility and cell structure UI save to the original XLSX',async()=>{
 const original=await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)),model=await inspect(original),bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer(withRendererResources((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}}))
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});let page
 await mkdir(new URL('./output/',import.meta.url),{recursive:true})
 try{page=await browser.newPage({viewport:{width:1300,height:900}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),tabs=frame.locator('[data-u-comp="slide-tab-item"]')
 const menu=async(name)=>{await tabs.filter({hasText:name}).click({button:'right'});return frame.locator('.sheet-tab-menu')}
 await (await menu('说明')).getByRole('menuitem',{name:'移动或复制…',exact:true}).click();let dialog=frame.getByRole('dialog',{name:'移动或复制工作表',exact:true});await dialog.getByLabel('建立副本',{exact:true}).check();await dialog.getByRole('button',{name:'确定',exact:true}).click();await page.waitForFunction(()=>window.props.edits[0]?.changes.sheetOps.some(op=>op.kind==='duplicate-sheet'))
 const copied=await tabs.allTextContents(),cloneName=copied.find(name=>name.includes('说明')&&name!=='说明');assert.ok(cloneName,'actual copied tab is visible')
 await (await menu(cloneName)).getByRole('menuitem',{name:'重命名',exact:true}).click();const rename=frame.locator('[data-u-comp="slide-tab-item"] [contenteditable="true"]');await rename.fill('交付副本');await rename.press('Enter');await tabs.filter({hasText:'交付副本'}).waitFor()
 await (await menu('交付副本')).getByRole('menuitem',{name:'移动或复制…',exact:true}).click();dialog=frame.getByRole('dialog',{name:'移动或复制工作表',exact:true});await dialog.locator('select').selectOption('__move-to-end__');await dialog.getByRole('button',{name:'确定',exact:true}).click()
 await (await menu('说明')).getByRole('menuitem',{name:'隐藏',exact:true}).click();await (await menu('交付副本')).getByRole('menuitem',{name:'取消隐藏…',exact:true}).click();dialog=frame.getByRole('dialog',{name:'取消隐藏',exact:true});await dialog.locator('select').selectOption({label:'隐藏数据'});await dialog.getByRole('button',{name:'确定',exact:true}).click()
 await tabs.filter({hasText:'交付副本'}).click();const nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('A3');await nameBox.press('Enter');await frame.getByRole('button',{name:'插入行',exact:true}).click();await page.evaluate(()=>window.editor.commitEditing())
 const draft=await page.evaluate(()=>window.props.edits);await writeFile(new URL('./output/worksheet-structure-draft.json',import.meta.url),JSON.stringify(draft,null,2));const saved=await edit(original,draft),fresh=await inspect(saved),clone=fresh.sheets.find(s=>s.name==='交付副本'),source=fresh.sheets.find(s=>s.name==='明细')
 assert.deepEqual(fresh.sheets.map(s=>s.name),['明细','说明','隐藏数据','交付副本']);assert.equal(fresh.sheets.find(s=>s.name==='说明').hidden,true);assert.equal(fresh.sheets.find(s=>s.name==='隐藏数据').hidden,false);assert.equal(fresh.ranges[source.id].cells.find(c=>c.row===2&&c.column===0).value,'苹果');assert.equal(fresh.ranges[clone.id].cells.find(c=>c.row===3&&c.column===0).value,'跨表合计');assert.equal(fresh.ranges[clone.id].cells.find(c=>c.row===3&&c.column===1).formula,"='明细'!B5");assert.equal(fresh.visuals.length,model.visuals.length,'original visual objects survive the sheet operations');assert.deepEqual(errors,[])
 await writeFile(new URL('./output/worksheet-structure.xlsx',import.meta.url),saved);await page.screenshot({path:new URL('./output/worksheet-structure.png',import.meta.url).pathname})
 }catch(error){if(page){await page.screenshot({path:new URL('./output/worksheet-structure-failure.png',import.meta.url).pathname});await writeFile(new URL('./output/worksheet-structure-failure.txt',import.meta.url),await page.frameLocator('iframe').locator('body').innerText())}throw error}finally{await browser.close();await new Promise(r=>server.close(r))}
})

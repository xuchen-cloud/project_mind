import {withRendererResources} from './renderer-server.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import JSZip from 'jszip'
import {inspect,edit} from '../dist/engine.mjs'

test('defined name, note and validation UI save while existing conditional rules survive',async()=>{
 const original=await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)),model=await inspect(original),bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer(withRendererResources((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}}))
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});let page;await mkdir(new URL('./output/',import.meta.url),{recursive:true})
 try{page=await browser.newPage({viewport:{width:1300,height:900}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),nameBox=frame.locator('[data-u-comp="defined-name"] input')
 await frame.getByRole('button',{name:'公式',exact:true}).click();await frame.getByRole('button',{name:'名称管理器',exact:true}).click();const dialog=frame.getByRole('dialog',{name:'名称管理器',exact:true});await dialog.getByLabel('名称',{exact:true}).fill('ContractTotal');await dialog.getByLabel('引用位置',{exact:true}).fill('=明细!$B$3:$B$4');await dialog.getByRole('button',{name:'添加',exact:true}).click();await dialog.getByRole('button',{name:'关闭',exact:true}).click()
 await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('Shift+F2');const note=frame.locator('[data-u-comp="note-textarea"]');await note.fill('合同审阅注释');await nameBox.click();await page.evaluate(()=>window.editor.commitEditing())
 await nameBox.fill('E20');await nameBox.press('Enter');await frame.getByRole('button',{name:'插入',exact:true}).click();await frame.getByRole('button',{name:'复选框',exact:true}).click();await page.evaluate(()=>window.editor.commitEditing())
 const draft=await page.evaluate(()=>window.props.edits);await writeFile(new URL('./output/rules-and-notes-draft.json',import.meta.url),JSON.stringify(draft,null,2));const saved=await edit(original,draft),fresh=await inspect(saved),zip=await JSZip.loadAsync(saved)
 assert.equal(fresh.definedNames.find(n=>n.name==='ContractTotal').formula,'明细!$B$3:$B$4');assert.deepEqual(fresh.ranges['sheet-1'].conditionalRules,model.ranges['sheet-1'].conditionalRules);assert.ok(fresh.ranges['sheet-1'].dataValidations.some(r=>r.ranges.some(a=>a.startColumn===4&&a.startRow===19)),'new checkbox validation is native OOXML');assert.ok(fresh.ranges['sheet-1'].dataValidations.some(r=>r.ruleType==='list'&&r.ranges.some(a=>a.startColumn===2)),'original list validation survives');const commentPaths=Object.keys(zip.files).filter(p=>/xl\/comments\d*\.xml$/.test(p));assert.ok(commentPaths.length);assert.ok((await Promise.all(commentPaths.map(p=>zip.file(p).async('string')))).some(xml=>xml.includes('合同审阅注释')&&xml.includes('ref="D20"')));assert.deepEqual(errors,[])
 await writeFile(new URL('./output/rules-and-notes.xlsx',import.meta.url),saved);await page.screenshot({path:new URL('./output/rules-and-notes.png',import.meta.url).pathname})
 }catch(error){if(page){await page.screenshot({path:new URL('./output/rules-and-notes-failure.png',import.meta.url).pathname});await writeFile(new URL('./output/rules-and-notes-failure.txt',import.meta.url),await page.frameLocator('iframe').locator('body').innerText());await writeFile(new URL('./output/rules-and-notes-draft.json',import.meta.url),JSON.stringify(await page.evaluate(()=>window.props.edits),null,2))}throw error}finally{await browser.close();await new Promise(r=>server.close(r))}
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

test('source picture drag and resize, image file insertion and shape gallery save into the original XLSX',async()=>{
 const source=await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)),model=await inspect(source)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1300,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),nameBox=frame.locator('input[type="text"]:visible').last(),picture=frame.locator('[data-print-visual="visual-2"] .shape-editable')
 await picture.click();const before=await picture.boundingBox();await page.mouse.move(before.x+30,before.y+20);await page.mouse.down();await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.mouse.move(before.x+70,before.y+70,{steps:8});await page.mouse.up();await page.waitForFunction(()=>window.props.edits[0]?.changes.visualEdits.length>0);await page.evaluate(()=>window.editor.commitEditing())
 await picture.click();const handle=picture.locator('[data-corner="se"]'),box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.mouse.move(box.x+box.width/2+45,box.y+box.height/2+30,{steps:8});await page.mouse.up();await page.evaluate(()=>window.editor.commitEditing())
 const moved=await inspect(await edit(source,await page.evaluate(()=>window.props.edits))),movedPicture=moved.visuals.find(v=>v.kind==='image');assert.notDeepEqual(movedPicture.anchor,model.visuals.find(v=>v.kind==='image').anchor)
 const after=await picture.boundingBox();assert.ok(after.width>before.width+20);assert.ok(after.height>before.height+10)
 await nameBox.fill('B12');await nameBox.press('Enter');await frame.getByRole('button',{name:'插入',exact:true}).click()
 const chooser=page.waitForEvent('filechooser');await frame.locator('button[data-tip="图片"]').click();const fileChooser=await chooser
 const media=model.rendererData.media['visual-2'];await fileChooser.setFiles({name:'source-copy.png',mimeType:'image/png',buffer:Buffer.from(media.base64,'base64')})
 await frame.locator('[data-print-visual]').nth(2).waitFor();await page.evaluate(()=>window.editor.commitEditing())
 await nameBox.fill('A20');await nameBox.press('Enter');const shapes=frame.getByRole('button',{name:'Shapes',exact:true});if(!await shapes.isVisible())await frame.getByRole('button',{name:'插入',exact:true}).click();await shapes.click();await frame.getByRole('listbox',{name:'Shapes',exact:true}).getByRole('button',{name:'矩形',exact:true}).click()
 await frame.locator('#univer-container.sheet-shape-drawing').waitFor()
 const canvas=await frame.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox();await page.mouse.move(canvas.x+250,canvas.y+260);await page.mouse.down();await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.mouse.move(canvas.x+400,canvas.y+340,{steps:8});await page.mouse.up()
 await page.evaluate(()=>window.editor.commitEditing())
 await mkdir(new URL('./output/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('./output/visuals-debug.png',import.meta.url).pathname});await writeFile(new URL('./output/visuals-debug-draft.json',import.meta.url),JSON.stringify(await page.evaluate(()=>window.props.edits),null,2));
 await page.waitForFunction(()=>window.props.edits[0]?.changes.visualAdditions.some(v=>!!v.shape));await mkdir(new URL('./output/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('./output/visuals-created.png',import.meta.url).pathname});await writeFile(new URL('./output/visuals-created-draft.json',import.meta.url),JSON.stringify(await page.evaluate(()=>window.props.edits),null,2));await page.evaluate(()=>window.editor.commitEditing())
 const draft=await page.evaluate(()=>window.props.edits),fresh=await inspect(await edit(source,draft));assert.equal(fresh.visuals.length,model.visuals.length+2);assert.equal(fresh.visuals.filter(v=>v.kind==='image').length,2);assert.equal(fresh.visuals.filter(v=>v.kind==='shape').length,1)
 assert.ok(draft[0].changes.visualEdits.length);assert.ok(draft[0].changes.visualAdditions.some(v=>!!v.image));assert.ok(draft[0].changes.visualAdditions.some(v=>!!v.shape));assert.deepEqual(errors,[])
 await mkdir(new URL('./output/',import.meta.url),{recursive:true});await writeFile(new URL('./output/visuals-draft.json',import.meta.url),JSON.stringify(draft,null,2));await page.screenshot({path:new URL('./output/visuals.png',import.meta.url).pathname})
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

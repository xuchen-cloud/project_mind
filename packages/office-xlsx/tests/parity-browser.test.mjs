import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {inspect,edit} from '../dist/engine.mjs'

test('native toolbar formats a real selection and the XLSX saves and reopens',async()=>{
 const source=await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url))
 const model=await inspect(source)
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const appCss=await readFile(new URL('../../../src/styles/app.css',import.meta.url),'utf8')
 const tokens=appCss.match(/:root\s*\{[\s\S]*?\n\}/)[0]
 const html=`<!doctype html><html><head><meta charset="utf-8"><style>${tokens} body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"></head><body><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onPendingChange(p){window.pending=p},onChange(edits){window.props={...window.props,edits};window.editor.update(window.props)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script></body></html>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const browser=await chromium.launch({headless:true})
 try{
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],viewport:{width:1100,height:760}})
  const page=await context.newPage()
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(()=>window.ready)
  await mkdir(new URL('./output/',import.meta.url),{recursive:true})
  await writeFile(new URL('./output/parity-browser.html',import.meta.url),await page.evaluate(()=>{const root=document.documentElement.cloneNode(true);root.querySelectorAll('script,style').forEach(n=>n.remove());root.querySelectorAll('iframe').forEach(n=>n.removeAttribute('srcdoc'));return root.outerHTML}))
  await page.screenshot({path:new URL('./output/parity-browser.png',import.meta.url).pathname})
  const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]')
  const nameBox=frame.locator('input[type="text"]:visible').last()
  await nameBox.fill('D20');await nameBox.press('Enter')
  await page.keyboard.press('F2');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.keyboard.type('editable');
  await page.waitForFunction(()=>window.pending)
  assert.equal(await page.evaluate(()=>window.pending),true)
  await page.evaluate(()=>window.editor.commitEditing())
  await nameBox.fill('D20');await nameBox.press('Enter');await frame.locator('button[data-tip="加粗"]').click()
  await page.evaluate(()=>window.editor.commitEditing())
  await nameBox.fill('E20');await nameBox.press('Enter')
  await page.evaluate(()=>navigator.clipboard.writeText('paste\t42\nnext\t43'))
  await page.keyboard.press('ControlOrMeta+v')
  await page.waitForFunction(()=>window.props.edits[0]?.changes.edits.some(e=>e.row===20&&e.column===5&&e.value===43))
  await page.evaluate(()=>window.editor.commitEditing())
  await nameBox.fill('F20:F21');await nameBox.press('Enter')
  // Read the visible green selection pixels, then drag its real bottom-right handle.
  const canvas=frame.locator('canvas[id^="univer-sheet-main-canvas"]'),bounds=await canvas.boundingBox()
  const handle=await canvas.evaluate(node=>{
   const {data,width,height}=node.getContext('2d').getImageData(0,0,node.width,node.height)
   let x=-1,y=-1
   for(let py=24;py<height;py++)for(let px=48;px<width;px++){const i=(py*width+px)*4;if(data[i+3]>200&&data[i+1]>70&&data[i+1]>data[i]*1.4&&data[i+1]>data[i+2]*1.2){if(py>y){y=py;x=px}else if(py===y)x=Math.max(x,px)}}
   if(x<0)throw Error('No visible range handle');return{x:x*node.clientWidth/width,y:y*node.clientHeight/height}
  })
  await page.mouse.move(bounds.x+handle.x,bounds.y+handle.y);await page.mouse.down();await page.mouse.move(bounds.x+handle.x,bounds.y+handle.y+40,{steps:10});await page.mouse.up()
  await page.screenshot({path:new URL('./output/fill-after.png',import.meta.url).pathname})
  await page.evaluate(()=>window.editor.commitEditing())
  await nameBox.fill('D990');await nameBox.press('Enter')
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  await nameBox.fill('D1100');await nameBox.press('Enter');await page.keyboard.press('F2')
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  await page.keyboard.type('beyond initial grid');await page.evaluate(()=>window.editor.commitEditing())
  const draft=await page.evaluate(()=>window.props.edits)
  await writeFile(new URL('./output/parity-draft.json',import.meta.url),JSON.stringify(draft,null,2));
  // Native worksheet controls must produce actual OOXML sheet operations.
  await frame.locator('[data-u-comp="sheet-bar-append-button"]').first().click()
  const newNameBox=frame.locator('input[type="text"]:visible').last()
  await newNameBox.fill('A1');await newNameBox.press('Enter');await page.keyboard.press('F2')
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  await page.keyboard.type('新表内容');await page.evaluate(()=>window.editor.commitEditing())
  const withSheet=await page.evaluate(()=>window.props.edits)
  const created=await inspect(await edit(source,withSheet))
  assert.equal(created.sheets.length,model.sheets.length+1)
  assert.ok(created.sheets.some(s=>created.ranges[s.id].cells.some(c=>c.row===0&&c.column===0&&c.value==='新表内容')))
  const saved=await edit(source,draft),fresh=await inspect(saved)
  const cell=fresh.ranges['sheet-1'].cells.find(c=>c.row===19&&c.column===3)
  assert.equal(cell.value,'editable')
  assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===19&&c.column===4)?.value,'paste')
  assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===20&&c.column===5)?.value,43)
  assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===21&&c.column===5)?.value,44)
  assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===22&&c.column===5)?.value,45)
  assert.equal(fresh.ranges['sheet-1'].cells.find(c=>c.row===1099&&c.column===3)?.value,'beyond initial grid')
  assert.equal(fresh.styles[cell.styleIndex].bold,true)
  assert.deepEqual(errors,[])
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

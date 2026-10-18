import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium,webkit,expect} from '@playwright/test'
import {inspect} from '../dist/engine.mjs'

for(const[name,engine]of[['Chromium',chromium],['WebKit',webkit]])test(`${name}: real print preview sends complete paginated visuals and embedded fonts to the awaited host`,async()=>{
 const model=await inspect(await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)))
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.prints=[];window.props={model:${JSON.stringify(model)},edits:[],readOnly:true,presentationMode:'preview',onChange(edits){window.props.edits=edits},onPrint:async output=>{window.prints.push(output);return new Promise(resolve=>window.finishPrint=resolve)}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await engine.launch({headless:true,...(name==='WebKit'&&process.env.OFFICE_WEBKIT_EXECUTABLE?{executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE}:{})})
 try{const page=await browser.newPage({viewport:{width:1200,height:850}});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]');await page.evaluate(()=>window.editor.output('print'))
 const dialog=frame.getByRole('dialog',{name:'打印',exact:true}),print=dialog.getByRole('button',{name:'打印',exact:true});await dialog.locator('select:has(option[value=landscape])').selectOption('landscape');await dialog.locator('select:has(option[value="5"])').selectOption('5');await print.click()
 await page.waitForFunction(()=>window.prints.length===1)
 assert.equal(await print.isDisabled(),true,'print awaits the actual host dialog')
 const output=await page.evaluate(()=>window.prints[0]);assert.ok(output.title);assert.deepEqual(output.pageSize,{widthPt:1008,heightPt:612});assert.match(output.html,/中文销售统计/);assert.match(output.html,/class="page /);assert.match(output.html,/@font-face/);assert.match(output.html,/data:font\//);assert.match(output.html,/<img[^>]+src="data:image\//);assert.doesNotMatch(output.html,/<(?:script|iframe|button|input)\b/i)
 await mkdir(new URL('./output/',import.meta.url),{recursive:true});await writeFile(new URL('./output/print-document.html',import.meta.url),output.html)
 // Observe the actual print DOM, not just the presence of an image callback.
 // The source has no Print_Area. Column-based pagination may split a visual,
 // but its complete area must survive across the emitted page clips.
 const paper=await browser.newPage({viewport:{width:1344,height:816}});await paper.setContent(output.html);await paper.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()))})
 const clips=await paper.locator('.pv').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect(),clip=node.parentElement.getBoundingClientRect();return{id:node.querySelector('[data-print-visual]').getAttribute('data-print-visual'),area:box.width*box.height,visibleArea:Math.max(0,Math.min(box.right,clip.right)-Math.max(box.left,clip.left))*Math.max(0,Math.min(box.bottom,clip.bottom)-Math.max(box.top,clip.top))}}))
 await writeFile(new URL(`./output/print-visual-geometry-${name.toLowerCase()}.json`,import.meta.url),JSON.stringify(clips,null,2));await paper.screenshot({path:new URL(`./output/print-document-${name.toLowerCase()}.png`,import.meta.url).pathname,fullPage:true})
 const ids=new Set(clips.map(box=>box.id));assert.equal(ids.size,2);for(const id of ids){const slices=clips.filter(box=>box.id===id);assert.ok(slices.reduce((sum,box)=>sum+box.visibleArea,0)>=slices[0].area*.999,'default used area must retain the complete chart/image across pages')}
 await paper.close()
 await page.evaluate(()=>window.finishPrint());await dialog.waitFor({state:'hidden'});await page.evaluate(()=>window.editor.commitEditing());assert.deepEqual(await page.evaluate(()=>window.props.edits),[],'readonly print settings never journal source changes')
 if(name==='Chromium'){
  await page.evaluate(()=>window.editor.output('print'));await dialog.locator('select:has(option[value=landscape])').selectOption('landscape');await dialog.locator('select:has(option[value="5"])').selectOption('5');await dialog.locator('select:has(option[value=columns])').selectOption('columns');await print.click();await page.waitForFunction(()=>window.prints.length===2)
  const fitted=await page.evaluate(()=>window.prints[1].html);await writeFile(new URL('./output/print-fit-columns.html',import.meta.url),fitted);const fittedPaper=await browser.newPage();await fittedPaper.setContent(fitted);assert.equal(await fittedPaper.locator('.page').count(),1,'real Fit Columns setting keeps the complete drawing on one page');assert.ok(await fittedPaper.locator('.pv').first().evaluate(node=>node.getBoundingClientRect().right<=node.parentElement.getBoundingClientRect().right+1));await fittedPaper.close();await page.evaluate(()=>window.finishPrint());await dialog.waitFor({state:'hidden'});await page.evaluate(()=>window.editor.commitEditing());assert.deepEqual(await page.evaluate(()=>window.props.edits),[],'readonly print settings never journal source changes')
  const{default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)));zip.file('xl/workbook.xml',(await zip.file('xl/workbook.xml').async('string')).replace('<definedNames/>',`<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'明细'!$A$1:$E$18</definedName></definedNames>`))
  const restricted=await inspect(await zip.generateAsync({type:'nodebuffer'}));await page.evaluate(async model=>{window.props={...window.props,model};window.editor.update(window.props);await window.editor.ready},restricted)
  await page.evaluate(()=>window.editor.output('print'));await dialog.locator('select:has(option[value=landscape])').selectOption('landscape');await dialog.locator('select:has(option[value="5"])').selectOption('5');await print.click();await page.waitForFunction(()=>window.prints.length===3)
  const clipped=await page.evaluate(()=>window.prints[2].html);await writeFile(new URL('./output/print-explicit-area.html',import.meta.url),clipped)
  const restrictedPaper=await browser.newPage();await restrictedPaper.setContent(clipped);assert.equal(await restrictedPaper.locator('.page').count(),1);assert.equal(await restrictedPaper.locator('.ov').evaluate(node=>node.style.width),'500pt','explicit source Print_Area keeps its deliberate crop');assert.ok(await restrictedPaper.locator('.pv').first().evaluate(node=>node.getBoundingClientRect().right>node.parentElement.getBoundingClientRect().right));await restrictedPaper.close();await page.evaluate(()=>window.finishPrint());await dialog.waitFor({state:'hidden'});await page.evaluate(()=>window.editor.commitEditing());assert.deepEqual(await page.evaluate(()=>window.props.edits),[],'readonly print settings never journal source changes')
 }

 await page.evaluate(()=>{window.props={...window.props,onPrint:async()=>{throw Error('原生打印失败')}};window.editor.update(window.props)})
 await page.evaluate(()=>window.editor.output('print'));await print.click();await expect(dialog.locator('[role="alert"]')).toHaveText('原生打印失败');await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'})

 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

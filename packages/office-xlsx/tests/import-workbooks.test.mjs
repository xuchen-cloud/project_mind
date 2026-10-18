import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium,webkit} from '@playwright/test'
import JSZip from 'jszip'
import {inspect,edit} from '../dist/engine.mjs'

for(const [engineName,engine]of [['Chromium',chromium],['WebKit',webkit]])test(`${engineName}: real workbook picker imports independent source values and styles then saves the target once`, {timeout:60000}, async()=>{
 const original=await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)),model=await inspect(original)
 const imported=await edit(original,[{kind:'string',sheetId:'sheet-1',row:2,column:0,value:'外部源专属值'},{kind:'number',sheetId:'sheet-1',row:2,column:1,value:25}])
 const sourceModel=await inspect(imported),bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}#editor{height:100vh}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.imports=[];window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(edits){window.props.edits=edits;window.editor.update(window.props)},async onInspectImportedWorkbook(bytes){window.imports.push([...bytes]);return await window.nativeInspect([...bytes])}};window.editor=mount(document.getElementById('editor'),window.props);await window.editor.ready;window.ready=true</script>`
 const server=createServer((req,res)=>{if(req.url==='/browser.mjs'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(css)}else{res.setHeader('Content-Type','text/html');res.end(html)}})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await engine.launch({headless:true})
 try{const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.exposeFunction('nativeInspect',async bytes=>inspect(new Uint8Array(bytes)));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready)
 const frame=page.frameLocator('iframe[title="Excel 完整编辑器"]'),nameBox=frame.locator('input[type="text"]:visible').last()
 await nameBox.fill('D20');await nameBox.press('Enter');await page.keyboard.press('F2');await page.keyboard.type('目标草稿保留');await page.evaluate(()=>window.editor.commitEditing())
 await frame.getByRole('button',{name:'数据',exact:true}).click()
 const canceled=page.waitForEvent('filechooser');await frame.getByRole('button',{name:'合并工作簿',exact:true}).click();await(await canceled).setFiles([]);await frame.locator('.workbook-status').filter({hasText:'已取消选择工作簿'}).waitFor();assert.deepEqual(await page.evaluate(()=>window.imports),[],'cancel never sends bytes to native inspect')
 const chooserPromise=page.waitForEvent('filechooser');await frame.getByRole('button',{name:'合并工作簿',exact:true}).click();const chooser=await chooserPromise
 await chooser.setFiles({name:'selected-source.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(imported)})
 try{await frame.locator('.workbook-status').filter({hasText:'已合并 1 个文件的 3 张工作表'}).waitFor()}catch(error){console.error('import status',await frame.locator('.workbook-status').allTextContents());throw error}
 await page.evaluate(()=>window.editor.commitEditing());assert.deepEqual(Buffer.from(await page.evaluate(()=>window.imports[0])),Buffer.from(imported))
 const draft=await page.evaluate(()=>window.props.edits),saved=await edit(original,draft),fresh=await inspect(saved)
 await mkdir(new URL('./output/',import.meta.url),{recursive:true});await writeFile(new URL('./output/imported-workbook-draft.json',import.meta.url),JSON.stringify(draft,null,2));await writeFile(new URL('./output/imported-workbook-model.json',import.meta.url),JSON.stringify(fresh,null,2));const sourceSheet=sourceModel.sheets[0],destination=fresh.sheets.find(s=>s.name==='明细 (2)'),at=(sheet,row,column)=>fresh.ranges[sheet.id].cells.find(c=>c.row===row&&c.column===column)
 assert.equal(fresh.sheets.length,6);assert.ok(destination);assert.equal(at(destination,2,0).value,'外部源专属值');assert.equal(at(destination,2,1).value,25)
 assert.equal(at(destination,4,1).value,45);assert.equal(at(destination,4,1).formula,undefined,'official merge imports formulas as cached values')
 assert.equal(at(fresh.sheets[0],2,1).value,10,'source reads cannot accidentally use the target session');assert.equal(at(fresh.sheets[0],19,3).value,'目标草稿保留')
 // The upstream import resolves source theme colors to absolute colors in the target theme.
 for(const [row,column]of [[0,0],[1,0],[2,0],[2,1]]){const originalCell=sourceModel.ranges[sourceSheet.id].cells.find(c=>c.row===row&&c.column===column),actual=fresh.styles[at(destination,row,column).styleIndex],expected=sourceModel.styles[originalCell.styleIndex];for(const property of ['fontFamily','fontSize','bold','italic','fontColor','fillColor','numberFormat','horizontalAlignment','verticalAlignment','borderBottom'])assert.deepEqual(actual[property],expected[property],`${row}:${column} ${property}`)}
 assert.deepEqual(fresh.ranges[destination.id].merges,sourceModel.ranges[sourceSheet.id].merges)
 assert.equal(fresh.ranges[destination.id].rows.find(r=>r.row===8).height,32);assert.ok(Math.abs(destination.columnWidths.find(c=>c.startColumn===0).width-28)<0.5)
 assert.equal(fresh.visuals.length,model.visuals.length,'official merge does not import source visual objects');assert.equal(destination.tables.length,0)
 const before=await JSZip.loadAsync(original),after=await JSZip.loadAsync(saved);for(const path of Object.keys(before.files).filter(p=>/^xl\/(?:media|drawings|charts)\//.test(p)&&!before.files[p].dir))assert.deepEqual(await after.file(path).async('uint8array'),await before.file(path).async('uint8array'),path)
 assert.equal((await inspect(imported)).ranges['sheet-1'].cells.find(c=>c.row===2&&c.column===1).value,25,'selected source remains unchanged')
 assert.deepEqual(errors,[]);await mkdir(new URL('./output/',import.meta.url),{recursive:true});await writeFile(new URL('./output/imported-workbook.xlsx',import.meta.url),saved);await writeFile(new URL('./output/imported-workbook-draft.json',import.meta.url),JSON.stringify(draft,null,2));await page.screenshot({path:new URL(`./output/imported-workbook-${engineName.toLowerCase()}.png`,import.meta.url).pathname})
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})

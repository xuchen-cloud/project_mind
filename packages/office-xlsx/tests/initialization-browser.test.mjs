import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import JSZip from 'jszip'
import {chromium,expect} from '@playwright/test'
import {inspect} from '../dist/engine.mjs'
import {withRendererResources} from './renderer-server.mjs'

test('under-build functional: no-formula ready, automatic resultApplied, manual edit and model reset', {timeout:90000},async()=>{
 const complex=await inspect(await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url)))
 const archive=await JSZip.loadAsync(await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url)))
 let styleIndex
 archive.file('xl/styles.xml',(await archive.file('xl/styles.xml').async('string')).replace(/<cellXfs\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/,(_,count,styles)=>{
  styleIndex=Number(count)
  return `<cellXfs count="${styleIndex+1}">${styles}<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs>`
 }))
 assert.ok(Number.isInteger(styleIndex))
 for(const name of Object.keys(archive.files).filter(name=>/^xl\/worksheets\/sheet\d+\.xml$/.test(name))){
  archive.file(name,(await archive.file(name).async('string')).replace(/<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/g,''))
 }
 const wrappedText='首次字体度量与自动换行应在真实内容就绪前完成。'.repeat(8)
 archive.file('xl/worksheets/sheet1.xml',(await archive.file('xl/worksheets/sheet1.xml').async('string'))
  .replace(/<c\b(?=[^>]*\br="B3")[^>]*>[\s\S]*?<\/c>/,`<c r="B3" s="${styleIndex}" t="inlineStr"><is><t>${wrappedText}</t></is></c>`)
  .replace(/<row\b(?=[^>]*\br="3")[^>]*>/,tag=>tag.replace(/\s(?:ht|customHeight)="[^"]*"/g,'')))
 const noFormula=await inspect(await archive.generateAsync({type:'nodebuffer'}))
 assert.ok(Object.values(noFormula.ranges).every(range=>range.cells.every(cell=>!cell.formula)))
 const bundle=await readFile(new URL('../dist/browser.mjs',import.meta.url)),css=await readFile(new URL('../dist/browser.css',import.meta.url))
 const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/browser.css"><style>body{margin:0}#editor{height:100vh}</style><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.models=${JSON.stringify([noFormula,complex])};window.openModel=async index=>{const props={model:structuredClone(window.models[index]),edits:[],readOnly:false,presentationMode:'edit',onChange(edits){window.props.edits=edits}};window.props=props;if(window.handle)window.handle.update(props);else window.handle=mount(document.getElementById('editor'),props);await window.handle.ready};window.loaded=true</script>`
 const server=createServer(withRendererResources((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':req.url==='/browser.css'?'text/css':'text/html');res.end(req.url==='/browser.mjs'?bundle:req.url==='/browser.css'?css:html)}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[]
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,set(host){
   const render=host.render,attach=host.attach
   host.render=function(context){window.testContext=context;return render.call(this,context)}
   host.attach=function(runtime){window.testRuntime=runtime;window.calcStarts=0;runtime.univerAPI.getFormula().calculationStart(()=>window.calcStarts++);return attach.call(this,runtime)}
   Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,writable:true,value:host})
  }}))
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.loaded)
  await page.evaluate(()=>window.openModel(0))
  const frame=page.frameLocator('iframe'),body=frame.locator('body')
  await frame.locator('canvas[id^="univer-sheet-main-canvas"]:visible').waitFor()
  const noFormulaEvidence=await body.evaluate(async()=>{
   const sheet=window.testRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getSheet(),height=sheet.getRowHeight(2),defaultHeight=sheet.getRowHeight(1)
   await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)
   return {preload:window.testContext.lazyWorkbookRef.current.flags.preloadComplete,marks:performance.getEntriesByType('mark').map(m=>m.name),height,afterHeight:sheet.getRowHeight(2),defaultHeight}
  })
  assert.equal(noFormulaEvidence.preload,true);assert.ok(noFormulaEvidence.marks.includes('office-xlsx:ready'))
  assert.ok(noFormulaEvidence.height>noFormulaEvidence.defaultHeight*1.5,'wrapped row is actually fitted by ready')
  assert.equal(noFormulaEvidence.afterHeight,noFormulaEvidence.height,'initial wrapped row metrics remain stable after ready')
  const previousFrame=await page.locator('iframe').getAttribute('src')
  await page.evaluate(()=>window.openModel(1))
  assert.equal(await page.locator('iframe').getAttribute('src'),previousFrame)
  const marks=await body.evaluate(()=>performance.getEntriesByType('mark').map(m=>m.name))
  assert.ok(marks.indexOf('office-xlsx:initial-calculation-starting')<marks.indexOf('office-xlsx:initial-calculation-applied'))
  assert.ok(marks.indexOf('office-xlsx:initial-calculation-applied')<marks.indexOf('office-xlsx:ready'))
  await frame.locator('.xlsx-print-visual img').first().waitFor();await frame.locator('svg.chart-svg').first().waitFor()
  await frame.getByRole('button',{name:'公式',exact:true}).click()
  await frame.getByRole('button',{name:'计算选项',exact:true}).click()
  await frame.getByRole('option',{name:'手动',exact:true}).click()
  await expect.poll(()=>body.evaluate(()=>window.testContext.calcManual)).toBe(true)
  const starts=await body.evaluate(()=>window.calcStarts)
  const nameBox=frame.locator('input[type="text"]:visible').last();await nameBox.fill('B3');await nameBox.press('Enter')
  await page.keyboard.press('F2');await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('15')
  await page.evaluate(()=>window.handle.commitEditing())
  await page.waitForTimeout(1300) // Covers the existing stream/debounce guard; not a timing assertion.
  assert.equal(await body.evaluate(()=>window.calcStarts),starts,'manual edit/commit must not force calculation')
  await page.evaluate(()=>window.openModel(1))
  assert.equal(await body.evaluate(()=>window.testContext.calcManual),false,'a replacement workbook starts automatic')
  await page.evaluate(()=>window.handle.dispose());assert.equal(await page.locator('iframe').count(),0)
  assert.deepEqual(errors,[])
  await mkdir(new URL('./output/',import.meta.url),{recursive:true})
  await writeFile(new URL('./output/initialization-functional.json',import.meta.url),JSON.stringify({qualification:'under-build-functional',noFormulaEvidence,complexMarks:marks,manualNoExtraCalculation:true,resetAutomatic:true,errors},null,2))
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
})

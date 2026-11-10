/** Real fixed renderer + persistent native reader; opt-in, headless, serial only.
 * Run with the shared build lock and Node --test --test-concurrency=1.
 * Browser host saves are engine B+E acceptance, not File working/native IPC.
 */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdir, writeFile, readFile} from 'node:fs/promises'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import JSZip from 'jszip'
import {startHarness, ROWS, WITNESS, rendererDist} from './progressive-browser-server.mjs'

const pw = process.env.OFFICE_PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href) : await import('@playwright/test')
const out = new URL(process.env.XLSX_ACCEPTANCE_OUTPUT ?? 'output/progressive-browser/', import.meta.url)
await mkdir(out, {recursive:true})
const results = []
const provenance = {sourceHashMeaning:'Source hashes are read at test start; compiled renderer hashes identify the actual loaded build. See the separate build-state evidence for build-time source hashes.',rendererDist:rendererDist.href,...Object.fromEntries(await Promise.all([
  ['engine',new URL('../dist/engine.mjs',import.meta.url)],['browser',new URL('browser.mjs',rendererDist)],['renderer.html',new URL('renderer.html',rendererDist)],['renderer/host.css',new URL('renderer/host.css',rendererDist)],
  ...['scripts/progressive-adapter.mjs','scripts/patch-univer.mjs','scripts/calculation-projection-adapter.mjs','formula-closure-edits.ts','renderer-host.ts','renderer.css','view-source.ts','input-style-journal.ts','cell-comparison.ts','streamed-cell-writes.ts'].map(path=>[path,new URL('../'+path,import.meta.url)]),
  ...['browser-progressive.mjs','progressive-browser-server.mjs','progressive-browser-host.mjs'].map(path=>[path,new URL(path,import.meta.url)]),
].map(async ([name,url]) => [name,createHash('sha256').update(await readFile(url)).digest('hex')])))}
await writeFile(new URL('provenance.json',out),JSON.stringify(provenance,null,2)+'\n')

async function finalizeAcceptance({browser,server,pendingResult,failure,publish,reportCleanupFailure}) {
  const cleanup=await Promise.allSettled([Promise.resolve().then(()=>browser?.close()),Promise.resolve().then(()=>server.close())])
  const cleanupErrors=cleanup.filter(result=>result.status==='rejected').map(result=>result.reason)
  const completed=!failure&&cleanupErrors.length===0&&pendingResult?{...pendingResult,status:'passed'}:undefined
  await publish(completed)
  if(cleanupErrors.length){
    await reportCleanupFailure(cleanupErrors)
    if(!failure)throw new AggregateError(cleanupErrors,'Browser/native reader cleanup failed')
  }
  return completed
}

// Zoom is persisted as a sheet view preference. Every other journal field,
// including content, styles, structure and protection, must remain identical.
function contentJournal(snapshot) {
  const copy=structuredClone(snapshot)
  copy.pageSetup=copy.pageSetup.map(([id,{zoomScale,...settings}])=>[id,settings]).filter(([,settings])=>Object.keys(settings).length)
  return copy
}

test('acceptance evidence is published only after integrity and successful cleanup',async()=>{
  for(const failedAt of [null,'integrity','browser','native']) {
    const events=[],published=[],cleanupFailures=[]
    const close=owner=>async()=>{events.push(owner);if(failedAt===owner)throw Error(owner)}
    const finish=finalizeAcceptance({browser:{close:close('browser')},server:{close:close('native')},pendingResult:{browser:'probe'},failure:failedAt==='integrity'?Error('integrity'):undefined,
      publish:async value=>{assert.deepEqual(events,['browser','native']);published.push(value)},reportCleanupFailure:async errors=>cleanupFailures.push(...errors)})
    if(failedAt==='browser'||failedAt==='native')await assert.rejects(finish,/cleanup failed/)
    else await finish
    assert.equal(published.length,1)
    assert.equal(published[0]?.status,failedAt===null?'passed':undefined)
    assert.equal(cleanupFailures.length,failedAt==='browser'||failedAt==='native'?1:0)
  }
})

// Observe the installed product host and canvas. No alternative renderer,
// parser, zoom algorithm, cell mutation or range loader is installed here.
function observeRenderer() {
  window.__xlsxKeys=[]
  window.__xlsxBeforeInputs=[]
  window.__xlsxJournal=()=>JSON.parse(JSON.stringify(window.__xlsxContext.lazyWorkbookRef.current.editJournal,(_,value)=>value instanceof Map?[...value]:value instanceof Set?[...value]:value))
  document.addEventListener('keydown',event=>{const observation={key:event.key,ctrl:event.ctrlKey,meta:event.metaKey,target:event.target?.outerHTML?.slice(0,350),readonly:document.documentElement.dataset.hostReadonly,at:performance.now()};window.__xlsxKeys.push(observation);window.__xlsxKeys=window.__xlsxKeys.slice(-30);queueMicrotask(()=>observation.defaultPrevented=event.defaultPrevented)},true)
  document.addEventListener('beforeinput',event=>{const observation={inputType:event.inputType,data:event.data,target:event.target?.outerHTML?.slice(0,350),readonly:document.documentElement.dataset.hostReadonly,at:performance.now()};window.__xlsxBeforeInputs.push(observation);window.__xlsxBeforeInputs=window.__xlsxBeforeInputs.slice(-20);queueMicrotask(()=>observation.defaultPrevented=event.defaultPrevented)},true)
  const originalConsoleError=console.error
  console.error=function(...args){
    if(String(args[0]).includes('The column width is less than 0'))(window.__xlsxConsoleStacks??=[]).push({stack:new Error().stack,active:document.activeElement?.outerHTML,layout:window.__xlsxCurrentLayout,editors:[...document.querySelectorAll('[data-u-comp="editor"],[data-u-comp="formula-bar"]')].map(node=>({id:node.id,component:node.dataset.uComp,rect:node.getBoundingClientRect().toJSON(),display:getComputedStyle(node).display,parent:node.parentElement?.getBoundingClientRect().toJSON()})),at:performance.now()})
    return originalConsoleError.apply(this,args)
  }
  let host
  Object.defineProperty(window, '__projectMindSheetsHost', {configurable:true, get:() => host, set(value) {
    host = value
    const writeStreamed=value.writeStreamedCells
    if(writeStreamed)value.writeStreamedCells=function(...args){
      window.__xlsxProjectionDepth=(window.__xlsxProjectionDepth??0)+1
      const [sheet,range,matrix,pinned]=args
      let sample
      for(let row=0;row<matrix.length&&!sample;row++)for(let column=0;column<matrix[row].length;column++)if(Object.keys(matrix[row][column]).length&&!pinned?.has(`${range.startRow+row}:${range.startColumn+column}`)){sample={row:range.startRow+row,column:range.startColumn+column,expected:{value:matrix[row][column].v??null,formula:matrix[row][column].f??null}};break}
      const entry={sheet:sheet.getSheetId(),range,sample,readonly:document.documentElement.dataset.hostReadonly,stack:new Error().stack,at:performance.now()}
      ;(window.__xlsxProjections??=[]).push(entry);window.__xlsxProjections=window.__xlsxProjections.slice(-20)
      try{const result=writeStreamed.apply(this,args);if(sample){const actual=sheet.getRange(sample.row,sample.column).getCellDatas()[0]?.[0];sample.actual={value:actual?.v??null,formula:actual?.f??null}}return result}catch(error){entry.error=String(error);throw error}finally{window.__xlsxProjectionDepth--}
    }
    const attach = value.attach, render = value.render
    value.attach = function(runtime) {
      window.__xlsxRuntime = runtime
      window.__xlsxCellCommands=[]
      window.__xlsxCommands=[]
      window.__xlsxReadonlyObservers=[]
      window.__xlsxBeforeCommands=[]
      window.__xlsxCommandAttempts=[]
      const commandService=runtime.univerAPI._commandService
      for(const method of ['executeCommand','syncExecuteCommand']){
        const execute=commandService[method]
        commandService[method]=function(id,params,options){
          const readonly=document.documentElement.dataset.hostReadonly
          const entry={method,id,params:/insert|ime|edit-visible|set-range-values/i.test(id)?JSON.parse(JSON.stringify(params??null)):undefined,readonly,projection:window.__xlsxProjectionDepth>0,stack:readonly==='true'?new Error().stack:undefined,at:performance.now()}
          window.__xlsxCommandAttempts.push(entry);window.__xlsxCommandAttempts=window.__xlsxCommandAttempts.slice(-100)
          try{const result=execute.apply(this,arguments);entry.result=typeof result==='boolean'?result:undefined;return result}catch(error){entry.error=String(error);throw error}
        }
      }
      runtime.univerAPI.addEvent(runtime.univerAPI.Event.BeforeCommandExecute,event=>{
        const observation={id:event.id,type:event.type,params:/insert|ime|edit-visible|set-range-values/i.test(event.id)?JSON.parse(JSON.stringify(event.params??null)):undefined,projection:window.__xlsxProjectionDepth>0,readonly:document.documentElement.dataset.hostReadonly,stack:document.documentElement.dataset.hostReadonly==='true'?new Error().stack:undefined,at:performance.now()}
        window.__xlsxBeforeCommands.push(observation);window.__xlsxBeforeCommands=window.__xlsxBeforeCommands.slice(-80)
        queueMicrotask(()=>observation.cancel=event.cancel??false)
      })
      window.__xlsxEditStarts=[]
      runtime.univerAPI.addEvent(runtime.univerAPI.Event.BeforeSheetEditStart,event=>{
        const observation={sheet:event.worksheet.getSheetName(),row:event.row,column:event.column,activeElement:document.activeElement?.outerHTML}
        queueMicrotask(()=>window.__xlsxEditStarts.push({...observation,cancel:event.cancel??false}))
      })
      runtime.univerAPI.onCommandExecuted((command,options)=>{
        window.__xlsxCommands.push({id:command.id,visible:command.params?.visible,params:command.id.includes('set-range-values')?JSON.parse(JSON.stringify(command.params)):undefined,options,readonly:document.documentElement.dataset.hostReadonly,at:performance.now()});window.__xlsxCommands=window.__xlsxCommands.slice(-40)
        if(document.documentElement.dataset.hostReadonly==='true'&&options?.onlyLocal===true)window.__xlsxReadonlyObservers.push({id:command.id,options,projectionAtCompletion:window.__xlsxProjectionDepth>0,params:JSON.parse(JSON.stringify(command.params??null)),at:performance.now()})
        const data=command.params?.cellValue?.[6]?.[2]
        if(data!==undefined)window.__xlsxCellCommands.push({id:command.id,stack:data?.f===null?new Error().stack:undefined,data:JSON.parse(JSON.stringify(data)),journal:window.__xlsxContext?.lazyWorkbookRef.current?.editJournal.cells.get('sheet-1')?.get('6:2'),at:performance.now()})
      })
      return attach.apply(this, arguments)
    }
    value.render = function(context) {window.__xlsxContext = context; return render.apply(this, arguments)}
  }})
  const fillText = CanvasRenderingContext2D.prototype.fillText
  const buffers = new WeakMap()
  CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
    const result = fillText.call(this, text, ...args)
    const buffer = ((buffers.get(this.canvas) ?? '') + String(text)).slice(-2000)
    buffers.set(this.canvas, buffer)
    if (buffer.includes('XLSX303')) {
      const rect = this.canvas.getBoundingClientRect()
      if (rect.width && rect.height && rect.left < innerWidth && rect.top < innerHeight && getComputedStyle(this.canvas).visibility !== 'hidden') {
        window.__xlsxPaint ??= {text:'XLSX303', at:performance.timeOrigin+performance.now(), rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}
      }
    }
    return result
  }
  // Univer can rasterize cell text on an internal cache canvas. The actual
  // source-backed chart has a visible SVG label too; observe its real DOM
  // paint and retain a screenshot of the grid witness beside it.
  let scheduled=false
  const check=()=>{
    scheduled=false
    for(const node of document.querySelectorAll('svg text')) {
      if(node.textContent!=='XLSX303')continue
      const rect=node.getBoundingClientRect()
      if(rect.width&&rect.height&&rect.bottom>0&&rect.right>0&&rect.left<innerWidth&&rect.top<innerHeight&&getComputedStyle(node).visibility!=='hidden')
        window.__xlsxPaint??={text:'XLSX303',source:'visible source-chart SVG label',at:performance.timeOrigin+performance.now(),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}
    }
  }
  new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>requestAnimationFrame(check))}}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true})
}

for (const kind of process.env.OFFICE_BROWSERS?.split(',') ?? ['chromium','webkit']) test(`${kind}: progressive real XLSX renderer, cumulative saves, formulas and zoom`, {timeout:180000}, async () => {
  const server = await startHarness()
  let browser, page, pendingResult, failure
  const errors = [], consoleErrors = [], responses = [], consoleDiagnostics=[]
  let phase="opening"
  try {
    browser = await pw[kind].launch({headless:true, ...(kind==='chromium'?{channel:'chrome'}:process.env.OFFICE_WEBKIT_EXECUTABLE?{executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE}:{})})
    page = await browser.newPage({viewport:{width:1440,height:1000}})
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(String(error)))
    page.on('console', message => {if(message.type()==='error'){consoleErrors.push(message.text());consoleDiagnostics.push({phase,text:message.text(),location:message.location()})}})
    page.on('response', response => {if(response.status()>=400) responses.push({url:response.url(),status:response.status()})})
    await page.addInitScript(observeRenderer)
    const started = Date.now()
    await page.goto(server.url)
    await page.waitForFunction(() => window.xlsxAcceptance?.readyAt)
    let frame = page.frames().find(frame => frame.parentFrame())
    async function verifyReadonlyUserEdit() {
      await page.evaluate(()=>window.xlsxAcceptance.preview(true))
      await frame.waitForFunction(()=>document.documentElement.dataset.hostReadonly==='true'&&document.querySelector('[data-u-comp="formula-bar"]').getBoundingClientRect().height===0)
      const journal=contentJournal(await frame.evaluate(()=>window.__xlsxJournal()))
      const canvas=frame.locator('#univer-container canvas[id^="univer-sheet-main-canvas_"]:visible')
      await canvas.click({position:{x:200,y:150}});await page.keyboard.press('F2')
      await frame.waitForFunction(()=>window.__xlsxCommandAttempts.some(entry=>entry.readonly==='true'&&entry.id==='sheet.operation.set-cell-edit-visible'&&entry.params?.visible===true&&entry.result===false))
      const blocked=await frame.evaluate(()=>({readonly:document.documentElement.dataset.hostReadonly,editing:window.__xlsxRuntime.univerAPI.getActiveWorkbook().isCellEditing(),attempts:window.__xlsxCommandAttempts.filter(entry=>entry.readonly==='true'&&entry.id.includes('set-cell-edit-visible')),journal:window.__xlsxJournal()}))
      assert.equal(blocked.readonly,'true');assert.equal(blocked.editing,false);assert.deepEqual(contentJournal(blocked.journal),journal)
      return blocked
    }
    if(process.env.XLSX_LAYOUT_DIAGNOSTIC==='1') {
      await frame.waitForFunction(()=>window.__xlsxContext?.lazyWorkbookRef.current?.loadedRanges.size)
      const manifest=JSON.parse(await readFile(new URL('renderer-resources.json',rendererDist)))
      let layoutChunk
      for(const path of manifest.files.filter(path=>path.endsWith('.mjs')))if((await readFile(new URL(path,rendererDist),'utf8')).includes('The column width is less than 0')){layoutChunk='/'+path;break}
      assert(layoutChunk)
      await frame.evaluate(async path=>{
        const module=await import(path),skeleton=Object.values(module).find(value=>typeof value==='function'&&value.prototype?._createSkeleton&&value.prototype?.calculate)
        if(!skeleton)throw Error('Actual exported DocumentSkeleton not found')
        const calculate=skeleton.prototype.calculate
        skeleton.prototype.calculate=function(...args){const previous=window.__xlsxCurrentLayout,snapshot=this.getViewModel().getDataModel().getSnapshot();window.__xlsxCurrentLayout={id:snapshot.id,documentStyle:JSON.parse(JSON.stringify(snapshot.documentStyle)),text:snapshot.body?.dataStream,args};if(snapshot.id==='__INTERNAL_EDITOR__DOCS_FORMULA_BAR')window.__xlsxFormulaLayout=window.__xlsxCurrentLayout;try{return calculate.apply(this,args)}finally{window.__xlsxCurrentLayout=previous}}
      },layoutChunk)
      await frame.getByText('说明',{exact:true}).first().click()
      const slider=frame.getByRole('slider',{name:'缩放比例'})
      const checkpoints=[]
      const checkpoint=async label=>{await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));checkpoints.push(await frame.evaluate(label=>({label,at:performance.now(),zoom:window.__projectMindOfficePreview.capture().zoom,readonly:document.documentElement.dataset.hostReadonly,protectedDialog:document.body.innerText.includes('该范围已被保护'),active:document.activeElement?.outerHTML,journal:window.__xlsxJournal(),keys:window.__xlsxKeys.slice(-4),beforeInputs:window.__xlsxBeforeInputs.slice(-6),projections:window.__xlsxProjections,commandAttempts:window.__xlsxCommandAttempts,beforeCommands:window.__xlsxBeforeCommands,commands:window.__xlsxCommands.slice(-12)}),label));await writeFile(new URL(`${kind}-checkpoints.json`,out),JSON.stringify(checkpoints,null,2)+'\n')}
      await frame.locator('[data-u-comp="defined-name"] input').fill('B3');await frame.locator('[data-u-comp="defined-name"] input').press('Enter')
      const canvas=frame.locator('#univer-container canvas[id^="univer-sheet-main-canvas_"]:visible')
      await canvas.click({position:{x:450,y:400}});await page.keyboard.press('Escape')
      await checkpoint('before-shortcut')
      for(let press=1;press<=3;press++){await page.keyboard.press('ControlOrMeta+=');await checkpoint(`shortcut-${press}`);assert.deepEqual(contentJournal(checkpoints.at(-1).journal),contentJournal(checkpoints[0].journal),'zoom shortcut preserves the content journal')}
      await slider.press('End')
      const previewBefore=await frame.evaluate(()=>window.__projectMindOfficePreview.capture())
      await checkpoint('before-preview')
      await page.evaluate(()=>window.xlsxAcceptance.preview(true))
      await frame.waitForFunction(()=>document.documentElement.dataset.hostReadonly==='true')
      await frame.waitForFunction(()=>document.querySelector('[data-u-comp="formula-bar"]').getBoundingClientRect().height===0)
      await checkpoint('preview-entered')
      await slider.press('Home');await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      await checkpoint('preview-slider-home')
      const previewLayout=await frame.evaluate(()=>{const bar=document.querySelector('[data-u-comp="formula-bar"]'),style=getComputedStyle(bar);return {formulaDocument:window.__xlsxFormulaLayout,bar:{rect:bar.getBoundingClientRect().toJSON(),visibility:style.visibility,pointerEvents:style.pointerEvents},grid:[...document.querySelectorAll('#univer-container canvas')].some(node=>node.getBoundingClientRect().width>100&&node.getBoundingClientRect().height>100),status:document.querySelector('.pm-status-zoom').getBoundingClientRect().toJSON()}})
      await frame.evaluate(view=>window.__projectMindOfficePreview.restore(view),previewBefore)
      await checkpoint('preview-restored')
      await page.evaluate(()=>window.xlsxAcceptance.preview(false))
      await frame.waitForFunction(()=>document.documentElement.dataset.hostReadonly==='false')
      await checkpoint('edit-restored')
      await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      await page.setViewportSize({width:560,height:520})
      await writeFile(new URL(`${kind}-layout.json`,out),JSON.stringify({...await frame.evaluate(()=>({consoleStacks:window.__xlsxConsoleStacks,keys:window.__xlsxKeys,commands:window.__xlsxCommands,active:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(node=>node.textContent)})),previewLayout},null,2)+'\n')
      assert.deepEqual(consoleErrors,[])
      assert(previewLayout.formulaDocument.documentStyle.pageSize.width>0)
      assert(previewLayout.bar.rect.width>0);assert.equal(previewLayout.bar.rect.height,0);assert.equal(previewLayout.bar.visibility,'hidden');assert.equal(previewLayout.bar.pointerEvents,'none')
      assert(previewLayout.grid);assert(previewLayout.status.width>0&&previewLayout.status.height>0)
      assert.deepEqual(errors,[]);assert.deepEqual(responses,[])
      await slider.waitFor({state:'visible'})
      assert(checkpoints.every(point=>!point.protectedDialog),'preview/zoom/restore must not open a permission dialog')
      const readonlyProjection=await frame.evaluate(()=>({writes:window.__xlsxProjections.filter(entry=>entry.readonly==='true'),mutations:window.__xlsxCommandAttempts.filter(entry=>entry.readonly==='true'&&entry.projection&&entry.id==='sheet.mutation.set-range-values')}))
      assert(readonlyProjection.writes.length>0);assert(readonlyProjection.mutations.some(entry=>entry.result===true),'trusted readonly viewport projection reaches the real mutation')
      for(const write of readonlyProjection.writes){assert.equal(write.error,undefined);if(write.sample)assert.deepEqual(write.sample.actual,write.sample.expected)}
      assert.deepEqual(contentJournal(checkpoints.at(-1).journal),contentJournal(checkpoints[0].journal),'preview projection preserves the content journal')
      // Deliberate negative UI probe runs after the clean zoom/modal gates.
      // Leave any expected permission dialog intact until renderer disposal.
      const blockedUserEdit=await verifyReadonlyUserEdit()
      await writeFile(new URL(`${kind}-readonly-projection.json`,out),JSON.stringify({readonlyProjection,blockedUserEdit},null,2)+'\n')
      pendingResult={browser:kind,layoutDiagnostic:true,previewLayout,readonlyProjectionApplied:true,contentJournalUnchanged:true,explicitUserEditBlocked:true,consoleErrors,errors,responses}
      return
    }
    if(process.env.XLSX_FORMULA_REGRESSION_ONLY==='1') {
      await frame.waitForFunction(()=>window.__xlsxContext?.lazyWorkbookRef.current?.closure.status==='active')
      assert.equal(await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(9999,0).getCellDatas()[0]?.[0]?.v??null),null)
      const nameBox=frame.locator('input[type="text"]:visible').last()
      await nameBox.fill('C7'); await nameBox.press('Enter'); await page.keyboard.press('F2')
      await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('=A10000+1')
      await page.waitForFunction(()=>window.xlsxAcceptance.pending)
      await page.evaluate(()=>window.xlsxAcceptance.editor.commitEditing())
      await frame.waitForFunction(()=>{const cell=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0];return cell?.f==='=A10000+1'&&(cell.v===1||cell.v===8)})
      const actual=await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0])
      assert.equal(actual.v,8,'manual tail formula must resolve A10000=7, not an implicit empty cell')
      pendingResult={browser:kind,newManualFormula:actual,onlyFormulaRegression:true}
      return
    }
    await frame.waitForFunction(() => window.__xlsxPaint && window.__xlsxContext?.lazyWorkbookRef.current?.loadedRanges.size)
    const coverage = async () => frame.evaluate(() => {
      const state = window.__xlsxContext.lazyWorkbookRef.current
      return {loadedRanges:[...state.loadedRanges],preloadComplete:state.flags.preloadComplete,closure:state.closure.status,formulaMode:state.formulaMode}
    })
    const initial = await page.evaluate(() => ({model:window.xlsxAcceptance.model,readyAt:window.xlsxAcceptance.readyAt}))
    assert.equal(initial.model.coverage.kind, 'partial')
    assert.equal(initial.model.coverage.sourceHash, createHash('sha256').update(server.original).digest('hex'))
    assert.deepEqual(Object.keys(initial.model.ranges), [initial.model.activeSheetId])
    assert.deepEqual(initial.model.ranges[initial.model.activeSheetId].area,{startRow:0,endRow:99,startColumn:0,endColumn:25})
    assert(initial.model.ranges[initial.model.activeSheetId].cells.every(cell => cell.row<100))
    const firstCoverage = await coverage()
    assert.equal(firstCoverage.formulaMode, false)
    const noTail = state => assert(!state.loadedRanges.some(([sheet, area]) => sheet===initial.model.activeSheetId && area.endRow>=ROWS-1), 'unvisited tail must remain absent from renderer')
    noTail(firstCoverage)
    const firstPaint = await frame.evaluate(() => window.__xlsxPaint)
    assert(firstPaint.text.includes(WITNESS))
    await page.screenshot({path:fileURLToPath(new URL(`${kind}-first-viewport.png`,out))})
    console.log(`${kind}: real first viewport witness and partial source confirmed`)
    const nameBox = () => frame.locator('[data-u-comp="defined-name"] input')
    const cell = (row,column) => frame.evaluate(({row,column}) => window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(row,column).getCellDatas()[0]?.[0],{row,column})
    assert.equal((await cell(2,0)).v,WITNESS,'actual first-viewport grid content matches the visible source witness')
    if(process.env.XLSX_READONLY_JOURNAL_ONLY!=='1')assert.equal((await cell(2,5)).v, 20037, 'cached formula precedes its missing dependencies')
    async function input(address, text) {
      await nameBox().fill(address)
      await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      assert.equal(await nameBox().inputValue(),address,'name-box input is stable after the active sheet finishes loading')
      await nameBox().press('Enter')
      await frame.evaluate(address=>{const book=window.__xlsxRuntime.univerAPI.getActiveWorkbook(),sheet=book.getActiveSheet();(window.__xlsxInputObservations??=[]).push({address,step:'navigation',sheet:sheet.getSheetName(),gridRows:sheet.getMaxRows(),selection:book.getActiveRange()?.getRange()})},address)
      const row=Number(address.match(/\d+$/)[0])-1,column=address.charCodeAt(0)-65
      await frame.waitForFunction(({row,column})=>{
        const state=window.__xlsxContext.lazyWorkbookRef.current,book=window.__xlsxRuntime.univerAPI.getActiveWorkbook(),sheet=book.getActiveSheet()
        const selection=book.getActiveRange()?.getRange(),sheetId=sheet.getSheetId()
        // Native EOF may precede declared dimensions: blank cells beyond
        // indexed content are editable without becoming resident source rows.
        return selection?.startRow===row&&selection?.startColumn===column&&
          state.loadedRanges.has(sheetId)&&!state.loadingKeys.has(sheetId)
      },{row,column})
      await frame.waitForFunction(()=>!window.__xlsxRuntime.univerAPI.getActiveWorkbook().isCellEditing())
      await page.keyboard.press('F2')
      await frame.evaluate(address=>window.__xlsxInputObservations.push({address,step:'after-F2',activeElement:document.activeElement?.outerHTML,editing:window.__xlsxRuntime.univerAPI.getActiveWorkbook().isCellEditing()}),address)
      await frame.waitForFunction(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().isCellEditing())
      await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text)
      await frame.waitForFunction(text=>window.__xlsxRuntime.univerAPI.getActiveDocument()?.getSnapshot().body?.dataStream?.replace(/\r\n$/,'')===text,text)
      await frame.evaluate(({address,text})=>window.__xlsxInputObservations.push({address,step:'typed',text,documentText:window.__xlsxRuntime.univerAPI.getActiveDocument().getSnapshot().body.dataStream}),{address,text})
      await page.waitForFunction(() => window.xlsxAcceptance.pending)
      await page.evaluate(() => window.xlsxAcceptance.editor.commitEditing())
      await frame.waitForFunction(()=>!window.__xlsxRuntime.univerAPI.getActiveWorkbook().isCellEditing())
    }
    if(process.env.XLSX_READONLY_JOURNAL_ONLY==='1') {
      const readonlyJournal=await readonlyJournalRegression()
      assert(!await frame.locator('body').innerText().then(text=>text.includes('该范围已被保护')))
      const blockedUserEdit=await verifyReadonlyUserEdit()
      await writeFile(new URL(`${kind}-blocked-user-edit.json`,out),JSON.stringify(blockedUserEdit,null,2)+'\n')
      assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);assert.deepEqual(responses,[]);assert.deepEqual(server.failures,[])
      pendingResult={browser:kind,version:browser.version(),readonlyJournal,explicitUserEditBlocked:true,errors,consoleErrors,responses}
      return
    }
    const editStarted = Date.now()
    await input('B3','40')
    const editConfirmedMs = Date.now()-started, editResponseMs = Date.now()-editStarted
    assert.equal((await cell(2,1)).v, 40)
    const numericEdit=await frame.evaluate(()=>{
      const range=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(2,1)
      const raw=range.getCellDatas()[0][0],view=range.getCellData()
      return {rawValue:raw.v,rawType:typeof raw.v,viewValue:view.v,viewType:typeof view.v}
    })
    assert.equal(numericEdit.rawType,'number'); assert.equal(numericEdit.rawValue,40)
    const numericJournal=await page.evaluate(()=>window.xlsxAcceptance.edits[0].changes.edits.find(edit=>edit.row===2&&edit.column===1))
    assert.equal(numericJournal.value,40); assert.equal(typeof numericJournal.value,'number'); assert.equal(numericJournal.writeValue,true)
    noTail(await coverage())
    assert.equal((await cell(18999,0))?.v??null,null,'unvisited tail witness is absent from the actual cell matrix')
    const readsAtFirstEdit = structuredClone(server.reads)
    assert(readsAtFirstEdit.some(read => read.request.kind==='range'))
    assert(!readsAtFirstEdit.some(read => read.request.kind==='range' && read.request.sheetId===initial.model.activeSheetId && read.request.range.startRow<=18999 && read.request.range.endRow>=18999))
    const owner = await server.ownership()
    assert.equal(owner.opens,1); assert.deepEqual(owner.owners,owner.originalOwners)
    console.log(`${kind}: first keyboard edit confirmed before unvisited tail; ${editResponseMs} ms`)
    await page.evaluate(() => window.xlsxAcceptance.save())
    await input('D3','60')
    await page.evaluate(() => window.xlsxAcceptance.save())
    assert.equal(server.saves.length,2)
    const savedCell = (save,row,column) => save.cells.find(cell => cell.row===row && cell.column===column)
    assert.equal(savedCell(server.saves[0],2,1).value,40)
    assert.equal(savedCell(server.saves[0],4,1).value,60,'SUM references must see a numeric B3, not text coerced by +')
    assert.equal(savedCell(server.saves[0],2,5).value,20067)
    assert.equal(savedCell(server.saves[1],2,1).value,40)
    assert.equal(savedCell(server.saves[1],2,3).value,60)
    assert.equal(savedCell(server.saves[1],4,1).value,60)
    assert.equal(savedCell(server.saves[1],2,5).value,20107)
    const secondEdits = server.saves[1].edits[0].changes.edits
    assert(secondEdits.some(edit => edit.row===2&&edit.column===1&&edit.value===40))
    assert(secondEdits.some(edit => edit.row===2&&edit.column===3&&edit.value===60))
    assert.equal(await page.evaluate(()=>window.xlsxAcceptance.model.coverage.sourceHash),initial.model.coverage.sourceHash,'receipts retain immutable renderer source identity')
    noTail(await coverage())
    const recalculation = await (await page.request.post(server.url+'/calculate',{data:{
      edits:[{sheetId:initial.model.activeSheetId,row:ROWS-1,column:0,input:'30000'},{sheetId:'sheet-2',row:0,column:25,input:'9'}],
      reads:[{sheetId:initial.model.activeSheetId,range:{startRow:2,endRow:2,startColumn:5,endColumn:5}}],
    }})).json()
    assert.equal(recalculation.cells[0].number,30109,'complete native calculation resolves both the tail and other-sheet precedent')
    const currentView = await (await page.request.get(server.url+'/inspect-view')).json()
    assert.equal(currentView.coverage.kind,'partial')
    assert.equal(currentView.ranges[currentView.activeSheetId].cells.find(cell=>cell.row===2&&cell.column===5).value,20107,'read-only recalculation must not change saved bytes')
    const before = await JSZip.loadAsync(server.original), saved = new Uint8Array(await (await page.request.get(server.url+'/bytes')).body()), after = await JSZip.loadAsync(saved)
    await writeFile(new URL(`${kind}-original.xlsx`,out),server.original)
    await writeFile(new URL(`${kind}-saved.xlsx`,out),saved)
    await writeFile(new URL(`${kind}-saves.json`,out),JSON.stringify(server.saves,null,2)+'\n')
    await writeFile(new URL(`${kind}-styles-before.xml`,out),await before.file('xl/styles.xml').async('string'))
    await writeFile(new URL(`${kind}-styles-after.xml`,out),await after.file('xl/styles.xml').async('string'))
    const savedSheetXml=await after.file('xl/worksheets/sheet1.xml').async('string')
    for(const [address,value] of [['B3',40],['D3',60]]) {
      const fragment=savedSheetXml.match(new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>[\\s\\S]*?</c>`))?.[0]
      assert(fragment,`${address} exists in the actual candidate XML`)
      const type=fragment.match(/\bt="([^"]*)"/)?.[1]
      assert(type===undefined||type==='n',`${address} must be a numeric OOXML cell, got ${type}`)
      assert.match(fragment,new RegExp(`<v>${value}(?:\\.0+)?</v>`))
    }
    assert.deepEqual(Object.keys(after.files).sort(),Object.keys(before.files).sort())
    const changedParts = [], unchangedParts = []
    for (const [path, entry] of Object.entries(before.files)) {
      if(entry.dir) continue
      const a = await entry.async('nodebuffer'), b = await after.file(path).async('nodebuffer')
      if(a.equals(b)) unchangedParts.push(path); else changedParts.push(path)
    }
    assert(unchangedParts.includes('xl/worksheets/never-opened.xml'))
    assert(unchangedParts.some(path => path.startsWith('xl/media/')))
    console.log(`${kind}: candidate changed parts ${JSON.stringify(changedParts)}`)
    if(process.env.XLSX_REQUIRE_STYLES_UNCHANGED==='1'||process.env.XLSX_STYLE_FORMAT_ONLY==='1')
      assert.equal(await before.file('xl/styles.xml').async('string'),await after.file('xl/styles.xml').async('string'),'scalar-only input must preserve styles.xml bytes')
    if(process.env.XLSX_STYLE_REGRESSION_ONLY==='1') {
      assert(changedParts.every(path => ['xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml'].includes(path)),JSON.stringify(changedParts))
      return
    }
    const tail = await (await page.request.post(server.url+'/read',{data:{kind:'range',sheetId:initial.model.activeSheetId,range:{startRow:ROWS-1,endRow:ROWS-1,startColumn:0,endColumn:0}}})).json()
    assert.equal(tail.cells[0].value,ROWS)
    assert.deepEqual((await server.ownership()).owners,owner.owners)
    await page.evaluate(() => window.xlsxAcceptance.reopen())
    frame = page.frames().find(frame => frame.parentFrame())
    const reopenedOwner=await server.ownership(),savedHash=createHash('sha256').update(saved).digest('hex')
    assert.equal(reopenedOwner.opens,2); assert.equal(reopenedOwner.owners.length,1)
    assert.equal(await page.evaluate(()=>window.xlsxAcceptance.model.coverage.sourceHash),savedHash)
    await frame.waitForFunction(() => window.__xlsxContext?.lazyWorkbookRef.current?.loadedRanges.size)
    assert.equal((await cell(2,1)).v,40); assert.equal((await cell(2,3)).v,60); assert.equal((await cell(2,5)).v,20107)
    assert.equal((await cell(4,1)).v,60,'actual reopened renderer SUM retains numeric-reference semantics')
    noTail(await coverage())
    const reopenedTail=await (await page.request.post(server.url+'/read',{data:{kind:'range',sheetId:initial.model.activeSheetId,range:{startRow:ROWS-1,endRow:ROWS-1,startColumn:0,endColumn:0}}})).json()
    assert.equal(reopenedTail.cells[0].value,ROWS,'unvisited tail survives candidate save and native close/reopen')
    console.log(`${kind}: two cumulative saves, numeric OOXML, native dependencies and actual reopen confirmed`)

    if(process.env.XLSX_STYLE_FORMAT_ONLY==='1') {
      await nameBox().fill('B3'); await nameBox().press('Enter')
      await frame.locator('.inline-tools button:has(> b)').click()
      await page.evaluate(()=>window.xlsxAcceptance.editor.commitEditing())
      const formatEdit=await page.evaluate(()=>window.xlsxAcceptance.edits[0].changes.edits.find(edit=>edit.row===2&&edit.column===1))
      assert.equal(formatEdit.style.bold,true,'explicit toolbar formatting remains journaled')
      await page.evaluate(()=>window.xlsxAcceptance.save())
      const formattedView=await(await page.request.get(server.url+'/inspect-view')).json()
      const formattedCell=formattedView.ranges[formattedView.activeSheetId].cells.find(cell=>cell.row===2&&cell.column===1)
      assert.equal(formattedView.rendererData.file.styles[formattedCell.styleIndex].bold,true,'actual native candidate retains explicit bold')
      const formattedBytes=await(await page.request.get(server.url+'/bytes')).body()
      await writeFile(new URL(`${kind}-explicit-bold.xlsx`,out),formattedBytes)
      await page.evaluate(()=>window.xlsxAcceptance.reopen())
      frame=page.frames().find(frame=>frame.parentFrame())
      await frame.waitForFunction(()=>window.__xlsxRuntime?.univerAPI.getActiveWorkbook().getActiveSheet().getRange(2,1).getCellStyleData()?.bl===1)
      assert.equal((await cell(2,1)).v,40)
      assert.deepEqual(errors,[]); assert.deepEqual(consoleErrors,[]); assert.deepEqual(server.failures,[])
      pendingResult={browser:kind,version:browser.version(),mode:'scalar style byte preservation plus explicit toolbar format save/reopen',scalarStylesByteIdentical:true,explicitBoldJournal:true,explicitBoldNativeCandidate:true,explicitBoldReopened:true,errors,consoleErrors}
      console.log(`${kind}: scalar styles byte-identical; explicit bold retained through actual save/reopen`)
      return
    }

    // P1 regression: an active closure describes source formulas only. A
    // keyboard edit introducing a new tail reference must fetch dependencies
    // or use complete-source native calculation before showing its result.
    async function newFormulaRegression() {
      await nameBox().fill('C7'); await nameBox().press('Enter')
      await frame.waitForFunction(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0]?.v===41)
      await frame.waitForFunction(() => window.__xlsxContext.lazyWorkbookRef.current.closure.status==='active')
      assert.equal((await cell(9999,0))?.v??null,null,'new formula precedent is genuinely absent before editing')
      await frame.waitForFunction(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0]?.v===41)
      assert.equal((await cell(6,2)).v,41)
      await frame.evaluate(() => {
        window.__xlsxFormulaObservations=[]
        window.__xlsxObserveFormula=true
        const sample=()=>{
          const cell=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0]
          if(cell?.f==='=A10000+1')window.__xlsxFormulaObservations.push(cell.v??null)
          if(window.__xlsxObserveFormula)requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      const calculationCount=server.calculations.length
      await input('C7','=A10000+1')
      await frame.waitForFunction(() => window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0]?.v===8)
      const formulaObservations=await frame.evaluate(() => {window.__xlsxObserveFormula=false; return window.__xlsxFormulaObservations})
      assert(!formulaObservations.includes(1),'new formula must never publish the incomplete-grid result 1')
      const newFormula={formula:'=A10000+1',expected:8,oldClosure:'active',precedentInitiallyAbsent:true,observations:formulaObservations,nativeCalculations:server.calculations.length-calculationCount,precedentAfter:(await cell(9999,0))?.v??null}
      assert.equal((await cell(6,2)).f,'=A10000+1')
      await page.screenshot({path:fileURLToPath(new URL(`${kind}-new-formula.png`,out))})
      return newFormula
    }

    async function journalDependencyRegressions() {
      const go=async address=>{
        await nameBox().fill(address); await nameBox().press('Enter')
        await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      }
      const waitCell=(row,column,expected)=>frame.waitForFunction(({row,column,expected})=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(row,column).getCellDatas()[0]?.[0]?.v===expected,{row,column,expected})
      const waitViewport=row=>frame.waitForFunction(row=>{
        const state=window.__xlsxContext.lazyWorkbookRef.current,sheet=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet()
        const area=state.loadedRanges.get(sheet.getSheetId())
        return area&&area.startRow<=row&&area.endRow>=row
      },row)
      phase='formula-explicit-style'
      await go('C7'); await waitViewport(6)
      await frame.locator('.inline-tools button:has(> b)').click()
      await page.evaluate(()=>window.xlsxAcceptance.editor.commitEditing())
      const formulaFormatEdit=await page.evaluate(()=>window.xlsxAcceptance.edits[0].changes.edits.find(edit=>edit.row===6&&edit.column===2&&edit.sheetId==='sheet-1'))
      assert.equal(formulaFormatEdit.formula,'=A10000+1'); assert.equal(formulaFormatEdit.style.bold,true)
      console.log(`${kind}: actual explicit formula bold journal captured; checking closure/viewport replay`)
      await frame.waitForFunction(()=>window.__xlsxContext.lazyWorkbookRef.current.closure.status==='active')
      await go('A8000'); await waitViewport(7999)
      await go('C7'); await waitViewport(6); await waitCell(6,2,8)
      assert.equal((await cell(6,2)).f,'=A10000+1','explicit formula formatting must retain formula text after replay')
      assert.equal(await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellStyleData()?.bl),1)
      const formulaStyle={formula:'=A10000+1',bold:true,viewportReplay:true,result:8}
      phase='journal-only-dependency'
      await go('B5000'); await waitViewport(4999)
      assert.equal((await cell(4999,1))?.v??null,null,'journal-only precedent is absent in immutable source')
      await input('B5000','7'); await waitCell(4999,1,7)
      await go('C7'); await waitViewport(6)
      assert.equal((await cell(4999,1))?.v??null,null,'journal-only value has actually left the resident matrix')
      await input('C7','=B5000+1'); await waitCell(6,2,8)
      await go('A8000'); await waitViewport(7999)
      await go('C7'); await waitViewport(6); await waitCell(6,2,8)
      assert.equal((await cell(6,2)).f,'=B5000+1','eviction must retain the actual formula, not only its stale cached value')
      assert.equal((await cell(4999,1)).v,7,'the required journal-only dependency remains pinned after eviction')
      await input('B5000','9'); await waitCell(4999,1,9)
      await go('C7'); await waitViewport(6); await waitCell(6,2,10)
      const journalOnly={sourceCell:'B5000',baselineBlank:true,observedEviction:true,firstResult:8,constantEditResult:10}

      // Hold one actual native result at the transport boundary, after the
      // earlier journal-only dependency installed. Real viewport eviction
      // must respect pins while the closure is still pending.
      await input('B5000','7'); await waitCell(4999,1,7)
      await go('C7'); await waitViewport(6)
      await frame.waitForFunction(()=>window.__xlsxContext.lazyWorkbookRef.current.closure.status==='active')
      const held=server.holdNextRange(initial.model.activeSheetId,11999)
      try {
        await input('C7','=B5000+A12000+1')
        let timer
        await Promise.race([held.pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Expected actual A12000 native range to reach the barrier')),15000)})]).finally(()=>clearTimeout(timer))
        assert.equal((await coverage()).closure,'pending')
        assert.equal((await cell(4999,1)).v,7,'earlier required journal value installed before the held response')
        await go('B5000'); await waitViewport(4999)
        await go('C7'); await waitViewport(6)
        assert.equal((await cell(4999,1))?.v,7,'pending closure publishes its earlier pin before the next await')
      } finally {held.release()}
      await frame.waitForFunction(()=>window.__xlsxContext.lazyWorkbookRef.current.closure.status==='active')
      await waitCell(6,2,18)
      assert.equal((await cell(6,2)).f,'=B5000+A12000+1')
      const pendingClosureEviction={formula:'=B5000+A12000+1',journalValue:7,sourceValue:10,heldRealRangeRow:12000,result:18}

      // The second source sheet has <100 used rows, while its real grid
      // contains 1000. Editing B500 exercises row-extent expansion through
      // actual UI input without fabricating extra rows in the source model.
      await frame.getByText('说明',{exact:true}).first().click()
      await frame.waitForFunction(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getSheetName()==='说明')
      const originalRows=await frame.evaluate(()=>{const sheet=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet();return window.__xlsxContext.lazyWorkbookRef.current.file.sheets.find(source=>source.id===sheet.getSheetId()).rowCount})
      phase='outside-used-dimensions'
      await frame.waitForFunction(()=>{const state=window.__xlsxContext.lazyWorkbookRef.current,sheet=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet();return state.loadedRanges.has(sheet.getSheetId())})
      await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      const gridRows=await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getMaxRows())
      assert(originalRows<500); assert(gridRows>=500,'B500 lies within the actual renderer grid')
      console.log(`${kind}: outside extent source rows=${originalRows}, actual grid rows=${gridRows}`)
      await input('B500','7'); await waitCell(499,1,7)
      await go('C7')
      await frame.waitForFunction(()=>{const state=window.__xlsxContext.lazyWorkbookRef.current,sheet=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet();return !state.loadingKeys.has(sheet.getSheetId())})
      const blankC7Coverage=await frame.evaluate(()=>{const state=window.__xlsxContext.lazyWorkbookRef.current,sheet=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet();return state.loadedRanges.get(sheet.getSheetId())})
      assert.equal((await cell(6,2))?.v??null,null,'C7 is an actual blank before its new formula')
      assert(blankC7Coverage.startRow<=6&&blankC7Coverage.endRow>=6,'a ready native read acknowledges the requested blank C7 as resident')
      const blankC7Read=server.reads.findLast(read=>read.request.kind==='range'&&read.request.sheetId==='sheet-2'&&read.request.range.startRow<=6&&read.request.range.endRow>=6)
      assert(blankC7Read); assert.equal(blankC7Read.rangeReady,true)
      assert.equal(blankC7Read.indexingComplete,true)
      assert.equal(blankC7Read.indexedThroughRow,2,'native EOF progress remains row three; mapped known-blank coverage does not rewrite it')
      await input('C7','=B500+1'); await waitCell(6,2,8)
      await frame.waitForFunction(()=>window.__xlsxContext.lazyWorkbookRef.current.closure.status==='active')
      assert.equal((await cell(499,1)).v,7)
      assert.equal((await cell(6,2)).f,'=B500+1')
      await go('A800')
      await frame.waitForFunction(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState().sheetViewStartRow>700)
      await go('C7'); await waitCell(6,2,8)
      assert.equal((await cell(6,2)).f,'=B500+1','outside-used-dimensions formula survives viewport departure/reentry')
      await input('B500','9'); await waitCell(499,1,9)
      await go('C7'); await waitCell(6,2,10)
      assert.equal((await cell(6,2)).f,'=B500+1','the retained formula recalculates after its new constant changes')
      const outsideUsedRows={sourceSheet:'说明',originalRows,gridRows,blankC7Coverage,blankC7Read,valueCell:'B500',formulaCell:'C7',formula:'=B500+1',firstResult:8,constantEditResult:10,viewportReentry:true,formulaRetained:true}
      await page.screenshot({path:fileURLToPath(new URL(`${kind}-journal-dependencies.png`,out))})
      return {formulaStyle,journalOnly,pendingClosureEviction,outsideUsedRows}
    }

    async function readonlyJournalRegression() {
      phase='readonly-journal-prepare'
      await frame.getByText('明细',{exact:true}).first().click()
      await frame.waitForFunction(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getSheetId()==='sheet-1')
      await input('D8','23')
      await nameBox().fill('D8');await nameBox().press('Enter')
      await frame.waitForFunction(()=>{const range=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveRange()?.getRange();return range?.startRow===7&&range.startColumn===3})
      await frame.locator('.inline-tools button:has(> b)').click()
      await page.evaluate(()=>window.xlsxAcceptance.editor.commitEditing())
      assert.equal((await cell(7,3)).v,23)
      await frame.waitForFunction(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(7,3).getCellStyleData()?.bl===1)
      assert.equal(await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(7,3).getCellStyleData()?.bl),1)
      const styledJournal=await frame.evaluate(()=>window.__xlsxContext.lazyWorkbookRef.current.editJournal.cells.get('sheet-1')?.get('7:3'))
      assert.equal(styledJournal.value,23);assert.equal(styledJournal.style?.bold,true,'D8 content and explicit bold share the actual unsaved journal entry before preview')
      const held=server.holdNextRange('sheet-1',13999)
      const formula='=B5000+A14000+1'
      let result
      try {
        await input('C7',formula)
        let timer
        await Promise.race([held.pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Expected actual A14000 native dependency at the preview barrier')),15000)})]).finally(()=>clearTimeout(timer))
        assert.equal((await coverage()).closure,'pending')
        const journal=contentJournal(await frame.evaluate(()=>window.__xlsxJournal()))
        const readsBefore=server.reads.length
        await page.evaluate(()=>window.xlsxAcceptance.preview(true))
        await frame.waitForFunction(()=>document.documentElement.dataset.hostReadonly==='true'&&document.querySelector('[data-u-comp="formula-bar"]').getBoundingClientRect().height===0)
        const observerStart=await frame.evaluate(()=>window.__xlsxReadonlyObservers.length)
        const restoreRow=async row=>frame.evaluate(row=>{const preview=window.__projectMindOfficePreview,view=preview.capture();return preview.restore({...view,sheetScroll:{...view.sheetScroll,sheetViewStartRow:row,offsetY:0}})},row)
        phase='readonly-journal-eviction'
        await restoreRow(16000)
        await frame.waitForFunction(()=>{const state=window.__xlsxContext.lazyWorkbookRef.current,area=state.loadedRanges.get('sheet-1');return area?.startRow>15000&&!state.loadingKeys.has('sheet-1')})
        assert.equal((await cell(7,3))?.v??null,null,'unsaved D8 actually leaves the resident matrix in readonly preview')
        assert(server.reads.slice(readsBefore).some(read=>read.request.kind==='range'&&read.request.sheetId==='sheet-1'&&read.request.range.startRow>15000),'preview eviction causes a new actual native viewport read')
        await restoreRow(0)
        await frame.waitForFunction(()=>{const state=window.__xlsxContext.lazyWorkbookRef.current,area=state.loadedRanges.get('sheet-1');return area?.startRow===0&&area.endRow>=7&&!state.loadingKeys.has('sheet-1')})
        assert.equal((await cell(7,3)).v,23,'readonly journal replay restores the unsaved scalar')
        assert.equal(await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(7,3).getCellStyleData()?.bl),1,'readonly journal replay restores explicit formatting')
        assert.equal((await cell(6,2)).f,formula,'readonly replay retains the unsaved formula')
        assert.deepEqual(contentJournal(await frame.evaluate(()=>window.__xlsxJournal())),journal)
        assert(!await frame.locator('body').innerText().then(text=>text.includes('该范围已被保护')),'source/journal projection must not open a permission dialog')
        assert.equal((await coverage()).closure,'pending')
        phase='readonly-pending-closure-release'
        held.release()
        await frame.waitForFunction(()=>window.__xlsxContext.lazyWorkbookRef.current.closure.status==='active')
        await frame.waitForFunction(formula=>{const book=window.__xlsxRuntime.univerAPI.getActiveWorkbook(),value=book.getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0];return value?.f===formula&&value.v===14008},formula)
        const children=await frame.evaluate(start=>window.__xlsxReadonlyObservers.slice(start),observerStart)
        assert(children.some(command=>command.id==='formula.mutation.set-formula-data'||command.id==='formula.mutation.set-array-formula-data'||command.id==='sheet.mutation.set-range-values'&&command.options.fromFormula===true),'actual formula-observer child mutations execute during readonly projection')
        assert.equal((await cell(4999,1)).v,7)
        assert.equal((await cell(7,3)).v,23)
        assert.deepEqual(contentJournal(await frame.evaluate(()=>window.__xlsxJournal())),journal)
        assert(!await frame.locator('body').innerText().then(text=>text.includes('该范围已被保护')))
        await writeFile(new URL(`${kind}-readonly-journal.json`,out),JSON.stringify({formula,result:14008,journal,observerChildren:children,reads:server.reads.slice(readsBefore)},null,2)+'\n')
        await page.screenshot({path:fileURLToPath(new URL(`${kind}-readonly-journal.png`,out))})
        await page.evaluate(()=>window.xlsxAcceptance.preview(false))
        await frame.waitForFunction(()=>document.documentElement.dataset.hostReadonly==='false')
        assert.equal((await cell(6,2)).f,formula);assert.equal((await cell(6,2)).v,14008)
        result={unsavedCell:'D8',value:23,bold:true,formula,readonlyResult:14008,newNativeViewportRead:true,actualEviction:true,journalReplay:true,pendingClosureCompletedInPreview:true,observerChildren:children.map(command=>command.id),contentJournalUnchanged:true,permissionDialogs:0}
      } finally {held.release()}
      // Keep the existing separate formula-save oracle's result 18, and
      // include the newly verified unsaved scalar/format in that save.
      await input('C7','=B5000+A12000+1')
      await frame.waitForFunction(()=>{const cell=window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0];return cell?.f==='=B5000+A12000+1'&&cell.v===18})
      return result
    }

    phase="new-tail-formula"
    const newFormula=await newFormulaRegression()
    console.log(`${kind}: new tail formula resolves 8 without publishing 1`)
    phase="journal-dependencies"
    const journalDependencies=await journalDependencyRegressions()
    console.log(`${kind}: formula bold, journal eviction, held-range race and expanded-extent constant edit confirmed`)
    const readonlyJournal=await readonlyJournalRegression()
    console.log(`${kind}: readonly unsaved scalar/formula/bold replay and pending closure result 14008 confirmed`)
    assert.deepEqual((await server.ownership()).owners,reopenedOwner.owners,'all journal/eviction scrolls reuse the same reopened native reader')
    assert.equal((await server.ownership()).opens,2)
    assert.equal(await page.evaluate(()=>window.xlsxAcceptance.model.coverage.sourceHash),savedHash,'journal edits and scrolls retain the immutable source')
    phase='additional-formula-save-reopen'
    await page.evaluate(()=>window.xlsxAcceptance.save())
    assert.equal(server.saves.length,3,'one additional formula save is separate from the original two cumulative scalar saves')
    assert.equal(savedCell(server.saves[2],6,2).value,18)
    assert.equal(savedCell(server.saves[2],7,3).value,23)
    const formulaBytes=await(await page.request.get(server.url+'/bytes')).body()
    await writeFile(new URL(`${kind}-formula-saved.xlsx`,out),formulaBytes)
    const formulaZip=await JSZip.loadAsync(formulaBytes),formulaSheetXml=await formulaZip.file('xl/worksheets/sheet2.xml').async('string')
    const formulaFragment=formulaSheetXml.match(/<c\b[^>]*\br="C7"[^>]*>[\s\S]*?<\/c>/)?.[0]
    assert.match(formulaFragment,/<f[^>]*>B500\+1<\/f>/); assert.match(formulaFragment,/<v>10(?:\.0+)?<\/v>/)
    await page.evaluate(()=>window.xlsxAcceptance.reopen())
    frame=page.frames().find(frame=>frame.parentFrame())
    await frame.waitForFunction(()=>{const cell=window.__xlsxRuntime?.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0];return cell?.f==='=B5000+A12000+1'&&cell.v===18})
    assert.equal(await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(6,2).getCellStyleData()?.bl),1,'formula bold persists in the candidate and actual reopened renderer')
    assert.equal((await cell(7,3)).v,23)
    assert.equal(await frame.evaluate(()=>window.__xlsxRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getRange(7,3).getCellStyleData()?.bl),1,'readonly-replayed scalar formatting survives actual save/reopen')
    await frame.getByText('说明',{exact:true}).first().click()
    await frame.waitForFunction(()=>{const book=window.__xlsxRuntime.univerAPI.getActiveWorkbook(),cell=book.getActiveSheet().getRange(6,2).getCellDatas()[0]?.[0];return book.getActiveSheet().getSheetName()==='说明'&&cell?.f==='=B500+1'&&cell.v===10})
    const formulaOwner=await server.ownership(),formulaSavedHash=createHash('sha256').update(formulaBytes).digest('hex')
    assert.equal(formulaOwner.opens,3)
    assert.equal(await page.evaluate(()=>window.xlsxAcceptance.model.coverage.sourceHash),formulaSavedHash)
    const formulaSaveReopen={additionalSaveCount:1,sourceNativeC7:18,otherSheetNativeXmlC7:10,reopenedResults:[18,10],formulaTextRetained:true,formulaBoldRetained:true}
    console.log(`${kind}: additional formula candidate save and actual reopen confirmed (18 and 10)`)
    phase="zoom-controls"
    const journalBeforeZoom=contentJournal(await frame.evaluate(()=>window.__xlsxJournal()))
    const assertZoomJournal=async()=>assert.deepEqual(contentJournal(await frame.evaluate(()=>window.__xlsxJournal())),journalBeforeZoom,'zoom/view controls preserve content, styles, structure and protection')
    const zoom = () => frame.evaluate(() => window.__projectMindOfficePreview.capture().zoom)
    const waitZoom = value => frame.waitForFunction(value => Math.abs(window.__projectMindOfficePreview.capture().zoom-value)<.001,value)
    const slider = frame.getByRole('slider',{name:'缩放比例'})
    assert.equal(await slider.getAttribute('min'),'50'); assert.equal(await slider.getAttribute('max'),'150')
    const status = frame.locator('.pm-status-zoom')
    await slider.press('Home'); await waitZoom(.5)
    assert(await status.getByRole('button',{name:'缩小',exact:true}).isDisabled())
    await status.getByRole('button',{name:'放大',exact:true}).click(); await waitZoom(.6)
    await slider.press('End'); await waitZoom(1.5)
    assert(await status.getByRole('button',{name:'放大',exact:true}).isDisabled())
    await status.getByRole('button',{name:'缩小',exact:true}).click(); await waitZoom(1.4)
    const dialog = frame.locator('.zoom-dialog')
    const openDialog = async () => {await status.getByRole('button',{name:'缩放百分比'}).click(); await dialog.waitFor()}
    phase='zoom-numeric'
    await openDialog()
    assert.equal(await dialog.getByRole('spinbutton').getAttribute('min'),'50')
    assert.equal(await dialog.getByRole('spinbutton').getAttribute('max'),'150')
    for (const invalid of ['49','151','-10','500','']) {
      await dialog.getByRole('spinbutton').fill(invalid)
      await dialog.locator('.primary-action').click()
      await dialog.getByRole('alert').waitFor()
      assert.equal(await zoom(),1.4)
    }
    await dialog.getByRole('spinbutton').fill('125'); await dialog.locator('.primary-action').click(); await waitZoom(1.25)
    phase='zoom-presets'
    for (const preset of [50,75,100,150]) {
      await openDialog(); await dialog.getByRole('radio',{name:`${preset}%`,exact:true}).check(); await dialog.locator('.primary-action').click(); await waitZoom(preset/100)
    }
    phase='zoom-fit'
    await nameBox().fill('A1:D100'); await nameBox().press('Enter')
    await openDialog(); await dialog.getByRole('radio').nth(4).check(); await dialog.locator('.primary-action').click()
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const fitZoom = await zoom(); assert.equal(fitZoom,.5,'100 selected rows exceed the real viewport, so fit reaches the 50% lower bound')
    await nameBox().fill('B3'); await nameBox().press('Enter')
    // Commands from the product's preview facade, including bounds and scroll.
    const restore = async value => {await frame.evaluate(value => {const preview = window.__projectMindOfficePreview; return preview.restore({...preview.capture(),zoom:value})},value); await waitZoom(Math.max(.5,Math.min(1.5,value)))}
    phase='zoom-facade'
    await restore(.1); await restore(4); await restore(1)
    // Actual installed Ctrl/Cmd wheel handlers; synthetic DOM wheel/pinch is
    // deliberately not described as physical OS trackpad acceptance.
    const gridCanvas=async()=>{
      const canvases=frame.locator('#univer-container canvas:visible')
      const index=await canvases.evaluateAll(nodes=>nodes.map((node,index)=>({index,area:node.getBoundingClientRect().width*node.getBoundingClientRect().height})).sort((a,b)=>b.area-a.area)[0].index)
      return canvases.nth(index)
    }
    await (await gridCanvas()).click({position:{x:150,y:100}})
    const wheel = async (deltaY,deltaMode) => {
      await (await gridCanvas()).evaluate((node,{deltaY,deltaMode}) => {
        const rect=node.getBoundingClientRect()
        node.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY,deltaMode,clientX:rect.left+150,clientY:rect.top+100}))
      },{deltaY,deltaMode})
    }
    phase='zoom-wheel'
    await wheel(-3,1); await waitZoom(1.1)
    await wheel(3,1); await waitZoom(1)
    await restore(1.5); await wheel(-1.5,0); await waitZoom(1.5)
    await restore(.5); await wheel(1.5,0); await waitZoom(.5)
    await restore(1); await wheel(-1.5,0)
    await frame.waitForFunction(() => window.__projectMindOfficePreview.capture().zoom>1)
    const pinchZoom = await zoom(); assert(pinchZoom<=1.5)
    phase='zoom-shortcut'
    // Plain Ctrl/Cmd+= is Univer's zoom shortcut; Ctrl+- is Excel delete cells.
    await restore(1)
    await nameBox().fill('B3'); await nameBox().press('Enter')
    await (await gridCanvas()).click({position:{x:450,y:400}})
    await page.keyboard.press('Escape')
    await frame.waitForFunction(()=>!window.__xlsxContext.isCellEditing())
    await page.keyboard.press('ControlOrMeta+='); await waitZoom(1.2);await assertZoomJournal()
    await page.keyboard.press('ControlOrMeta+='); await waitZoom(1.4);await assertZoomJournal()
    await page.keyboard.press('ControlOrMeta+='); await waitZoom(1.5);await assertZoomJournal()
    phase='zoom-preview'
    const previewBefore = await frame.evaluate(() => window.__projectMindOfficePreview.capture())
    await page.evaluate(() => window.xlsxAcceptance.preview(true))
    await frame.waitForFunction(() => document.documentElement.dataset.hostReadonly==='true')
    await frame.waitForFunction(()=>document.querySelector('[data-u-comp="formula-bar"]').getBoundingClientRect().height===0)
    const previewBar=await frame.evaluate(()=>{const node=document.querySelector('[data-u-comp="formula-bar"]'),style=getComputedStyle(node),rect=node.getBoundingClientRect();return {width:rect.width,height:rect.height,visibility:style.visibility,pointerEvents:style.pointerEvents}})
    assert(previewBar.width>0);assert.equal(previewBar.height,0);assert.equal(previewBar.visibility,'hidden');assert.equal(previewBar.pointerEvents,'none')
    assert.equal(await zoom(),previewBefore.zoom)
    await slider.press('Home'); await waitZoom(.5)
    await frame.evaluate(view => window.__projectMindOfficePreview.restore(view),previewBefore)
    await page.evaluate(() => window.xlsxAcceptance.preview(false))
    await frame.waitForFunction(() => document.documentElement.dataset.hostReadonly==='false')
    assert.deepEqual(await frame.evaluate(() => window.__projectMindOfficePreview.capture()),previewBefore)
    phase="narrow-viewport"
    await page.setViewportSize({width:560,height:520})
    assert(await slider.isVisible())
    await slider.press('End'); await waitZoom(1.5)
    await page.screenshot({path:fileURLToPath(new URL(`${kind}-narrow.png`,out))})
    await page.setViewportSize({width:1440,height:1000})
    await page.screenshot({path:fileURLToPath(new URL(`${kind}-saved.png`,out))})
    await assertZoomJournal()
    console.log(`${kind}: actual zoom controls, dialog, shortcut, wheel, fit and preview restore confirmed`)
    assert.deepEqual((await server.ownership()).owners,formulaOwner.owners,'all actual zoom/view changes reuse the retained reopened native reader')
    assert.equal((await server.ownership()).opens,3)
    assert.equal(await page.evaluate(()=>window.xlsxAcceptance.model.coverage.sourceHash),formulaSavedHash,'zoom and view changes retain source identity')
    assert.deepEqual(await page.evaluate(() => window.xlsxAcceptance.errors),[])
    assert.deepEqual(server.failures,[]); assert.deepEqual(errors,[]); assert.deepEqual(consoleErrors,[]); assert.deepEqual(responses,[])
    await page.evaluate(() => window.xlsxAcceptance.editor.dispose())
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    assert.equal(await page.locator('iframe').count(),0)
    assert.deepEqual(errors,[]); assert.deepEqual(consoleErrors,[])
    const result = {browser:kind,version:browser.version(),node:process.version,fixtureBytes:server.original.byteLength,rows:ROWS,
      firstContentMs:firstPaint.at-started,firstReadyMs:initial.readyAt-started,editConfirmedMs,editResponseMs,paint:firstPaint,
      firstCoverage,readsAtFirstEdit,initialNativeOpenMs:owner.initialOpenMs,ownerReused:true,cumulativeSaveCount:2,formulaSaveReopen,numericEditing:{...numericEdit,journalType:'number',savedXmlNumbers:[40,60],savedAndReopenedSum:60},formulaCaches:[20037,20067,20107],
      closeReopen:true,changedParts,unchangedParts:unchangedParts.length,nativeTailAndCrossSheetResult:30109,newFormula,journalDependencies,readonlyJournal,zoom:{range:[50,150],slider:true,stepButtons:true,invalidInputs:5,presets:[50,75,100,150],fitZoom,pinchZoom,shortcut:true,wheel:true,previewRestore:true,previewBar,narrow:true,contentJournalUnchanged:true},errors,consoleErrors,responses,
      mode:'headless real renderer + native reader/engine bytes; no Tauri IPC or File working claim'}
    await writeFile(new URL(`${kind}-reads.json`,out),JSON.stringify(server.reads,null,2)+'\n')
    assert(changedParts.every(path => ['xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml'].includes(path)),JSON.stringify(changedParts))
    pendingResult=result
  } catch(error) {
    failure=error
    if(page) {
      await page.screenshot({path:fileURLToPath(new URL(`${kind}-failure.png`,out))}).catch(()=>{})
      const failedFrame=page.frames().find(frame=>frame.parentFrame())
      const coverage=await failedFrame?.evaluate(()=>{
        const state=window.__xlsxContext?.lazyWorkbookRef.current,book=window.__xlsxRuntime?.univerAPI.getActiveWorkbook(),active=book?.getActiveSheet()
        const safe=read=>{try{return read()??null}catch(error){return {probeError:String(error)}}}
        const cell=(sheet,row,column)=>safe(()=>sheet?.getRange(row,column).getCellDatas()[0]?.[0])
        return {keys:window.__xlsxKeys,beforeInputs:window.__xlsxBeforeInputs,projections:window.__xlsxProjections,readonlyObservers:window.__xlsxReadonlyObservers,commandAttempts:window.__xlsxCommandAttempts,beforeCommands:window.__xlsxBeforeCommands,commands:window.__xlsxCommands,inputObservations:window.__xlsxInputObservations,editStarts:window.__xlsxEditStarts,activeElement:document.activeElement?.outerHTML,hasFocus:document.hasFocus(),cellCommands:window.__xlsxCellCommands,
          journal:safe(()=>[...state.editJournal.cells].map(([id,cells])=>[id,[...cells]])),consoleStacks:window.__xlsxConsoleStacks,
          loadedRanges:safe(()=>[...state.loadedRanges]),closure:state?.closure.status,paint:window.__xlsxPaint,formulaObservations:window.__xlsxFormulaObservations,
          activeSheet:active?.getSheetName(),gridRows:safe(()=>active.getMaxRows()),gridColumns:safe(()=>active.getMaxColumns()),selection:safe(()=>book.getActiveRange()?.getRange()),
          outsideCellMerges:safe(()=>active.getMergeData().filter(area=>area.startRow<=6&&area.endRow>=6&&area.startColumn<=2&&area.endColumn>=2)),outsideCellStyle:safe(()=>active.getRange(6,2).getCellStyleData()),
          sourceSheets:safe(()=>state.file.sheets.map(({id,name,rowCount,columnCount})=>({id,name,rowCount,columnCount}))),
          formula:cell(book?.getSheetBySheetId('sheet-1'),6,2),precedent:cell(book?.getSheetBySheetId('sheet-1'),9999,0),journalOnly:cell(book?.getSheetBySheetId('sheet-1'),4999,1),
          readonlyValue:cell(book?.getSheetBySheetId('sheet-1'),7,3),readonlyValueStyle:safe(()=>book?.getSheetBySheetId('sheet-1').getRange(7,3).getCellStyleData()),
          outsideFormula:cell(book?.getSheetBySheetId('sheet-2'),6,2),outsidePrecedent:cell(book?.getSheetBySheetId('sheet-2'),499,1)}
      }).catch(error=>({probeError:String(error)}))
      await writeFile(new URL(`${kind}-failure.json`,out),JSON.stringify({phase,error:String(error),stack:error.stack,errors,consoleErrors,consoleDiagnostics,responses,reads:server.reads,calculations:server.calculations,failures:server.failures,dom:await page.locator('body').innerText().catch(()=>''),frameDom:await failedFrame?.locator('body').innerText().catch(()=>''),coverage},null,2)+'\n')
    }
    throw error
  } finally {
    const completed=await finalizeAcceptance({browser,server,pendingResult,failure,
      publish:completed=>writeFile(new URL('results.json',out),JSON.stringify(completed?[...results,completed]:results,null,2)+'\n'),
      reportCleanupFailure:errors=>writeFile(new URL(`${kind}-cleanup-failure.json`,out),JSON.stringify({status:'failed',errors:errors.map(String)},null,2)+'\n')})
    if(completed){results.push(completed);console.log(JSON.stringify(completed))}
  }
})

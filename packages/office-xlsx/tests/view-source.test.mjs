import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {runInNewContext} from 'node:vm'
import {adaptFormulaStreamHold} from '../scripts/initialization-adapter.mjs'
import {adaptProgressiveApp,adaptProgressiveSync,adaptProgressiveHold} from '../scripts/progressive-adapter.mjs'
const exports={}
runInNewContext(ts.transpileModule(readFileSync(new URL('../view-source.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Map,WeakMap,Promise,Error,JSON})
const {snapshotRange,createViewReader}=exports
const inputStyles={}
runInNewContext(ts.transpileModule(readFileSync(new URL('../input-style-journal.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:inputStyles})
const closureEdits={}
runInNewContext(ts.transpileModule(readFileSync(new URL('../formula-closure-edits.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:closureEdits,Map,WeakMap,clearTimeout})
const area={startRow:3,endRow:3,startColumn:2,endColumn:3}
test('immutable complete snapshot is indexed once; subsequent viewports never walk source cells/rows',()=>{
  const range={area,cells:Array.from({length:20000},(_,row)=>({row,column:2,value:row})),rows:Array.from({length:20000},(_,row)=>({row,hidden:false})),merges:[],indexingComplete:true}
  const model={ranges:{sheet:range}}
  assert.equal(snapshotRange(model,'sheet',area).cells[0].value,3)
  range.cells[Symbol.iterator]=()=>{throw Error('full cells rescanned')}
  range.rows[Symbol.iterator]=()=>{throw Error('full rows rescanned')}
  assert.equal(snapshotRange(model,'sheet',{...area,startRow:19999,endRow:19999}).cells[0].value,19999)
  assert.throws(()=>snapshotRange({...model,coverage:{kind:'partial'}},'sheet',area),/live workbook/)
})
test('native range cache is bounded, coalesces reads, and does not freeze incomplete inventories or failures',async()=>{
  const calls=[]
  const reader=createViewReader(async request=>{calls.push(request);return {rangeReady:true}})
  const request=row=>({kind:'range',sheetId:'sheet',range:{...area,startRow:row,endRow:row}})
  await Promise.all([reader(request(0)),reader(request(0))])
  assert.equal(calls.length,1)
  for(let row=1;row<=8;row++)await reader(request(row))
  await reader(request(0));assert.equal(calls.length,10)
  await reader({kind:'formulas',sheetId:'sheet'});await reader({kind:'formulas',sheetId:'sheet'})
  assert.equal(calls.length,12)
  let ready=false,n=0
  const pending=createViewReader(async()=>{n++;return {rangeReady:ready,indexingComplete:false}})
  await pending(request(0));ready=true;await pending(request(0));await pending(request(0));assert.equal(n,2)
  const failed=createViewReader(async()=>{throw Error('tail failed')})
  await assert.rejects(failed(request(0)),/tail failed/)
  await assert.rejects(failed(request(0)),/tail failed/)
})
test('fixed-source adapters select cached-first GUI mode, install metadata before complete indexing, and gate calculation until closure ready',()=>{
  const read=name=>readFileSync(new URL('../vendor/apps/sheets/src/renderer/'+name,import.meta.url),'utf8')
  assert.match(adaptProgressiveApp(read('App.tsx')),/formulaMode: !window\.__projectMindSheetsHost\.isPartialView\(\)/)
  const sync=adaptProgressiveSync(read('univer-sync.ts'))
  assert.match(sync,/result\.indexingComplete \|\| result\.metadataReady/)
  assert.match(sync,/result\.metadataReady && result\.rangeReady/)
  assert.match(adaptProgressiveHold(read('formula-stream-hold.ts')),/!window\.__projectMindSheetsHost\.canCalculate\(\)/)
})

test('new formula references replace original closure inputs and retire stale asynchronous calculations',()=>{
  const state={closure:{status:'active',pinned:new Map([['sheet',new Map([['0:0',{v:1}]])]])},
    recalc:{generation:3,timer:null,running:true,overlay:new Map([['sheet',new Map()]]),follow:new Map([['sheet',{}]])},
    editJournal:{bulkConstantFills:new Map(),cells:new Map([['sheet',new Map([
      ['0:1',{row:0,column:1,formula:'=A10000+1',hasValue:false}],
      ['0:2',{row:0,column:2,value:9,hasValue:true}],
      ['0:3',{row:0,column:3,style:{bold:true},hasValue:false}],
    ])]])}}
  const original=[{row:0,column:1,formula:'=A1+1'},{row:0,column:2,formula:'=B1+1'},{row:0,column:3,formula:'=C1+1'}]
  assert.deepEqual(JSON.parse(JSON.stringify(closureEdits.formulasWithEdits(state,'sheet',original))),[
    {row:0,column:1,formula:'=A10000+1'},{row:0,column:3,formula:'=C1+1'},
  ])
  const previous=closureEdits.formulaClosureRevision(state)
  closureEdits.invalidateFormulaClosure(state)
  assert.notEqual(closureEdits.formulaClosureRevision(state),previous)
  assert.equal(state.closure.status,'idle')
  assert.equal(state.closure.pinned.size,0)
  assert.equal(state.recalc.generation,4)
  assert.equal(state.recalc.running,false)
  assert.equal(state.recalc.overlay.size,0)
  state.editJournal.cells.get('sheet').set('499:0',{row:499,column:0,value:7,hasValue:true})
  assert.deepEqual(JSON.parse(JSON.stringify(closureEdits.formulaSheetExtent(state,{id:'sheet',rowCount:100,columnCount:10}))),{rowCount:500,columnCount:10})
  const sync=adaptProgressiveSync(readFileSync(new URL('../vendor/apps/sheets/src/renderer/univer-sync.ts',import.meta.url),'utf8'))
  assert.match(sync,/journalCellContentAt\(state.editJournal, sheetId, row, column\)/)
})

test('forced calculation cannot bypass missing-dependency protection on a partial view',()=>{
  const source=adaptFormulaStreamHold(adaptProgressiveHold(readFileSync(new URL('../vendor/apps/sheets/src/renderer/formula-stream-hold.ts',import.meta.url),'utf8')))
  let before,dispose,allowed=false
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const api={},commandService={beforeCommandExecuted(callback){before=callback},onCommandExecuted(){},_commandExecutionStack:[]}
  runInNewContext(code,{exports:api,Date,WeakMap,setTimeout,clearTimeout,window:{__projectMindSheetsHost:{canCalculate:()=>allowed}},require(){return {CustomCommandExecutionError:Error,LifecycleStages:{Rendered:3},ICommandService:Symbol('commands')}}})
  api.installFormulaStreamHold({univer:{__getInjector:()=>({get:()=>commandService}),onDispose:callback=>{dispose=callback}},univerAPI:{addEvent:()=>({dispose(){}}),Event:{LifeCycleChanged:'lifecycle'}}})
  try {
    assert.throws(()=>before({id:'formula.mutation.set-formula-calculation-start',params:{forceCalculation:true}}),/held while file data streams/)
    allowed=true
    assert.doesNotThrow(()=>before({id:'formula.mutation.set-formula-calculation-start',params:{forceCalculation:true}}))
  }finally{dispose()}
})

test('closure precedents survive eviction while a later range read is suspended',async()=>{
  const source=adaptProgressiveSync(readFileSync(new URL('../vendor/apps/sheets/src/renderer/univer-sync.ts',import.meta.url),'utf8'))
  const start=source.indexOf('export async function activateFormulaClosure(')
  const end=source.indexOf('\n/// On-demand precedent pinning',start)
  const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const sheet={id:'sheet',name:'Sheet1',rowCount:10000,columnCount:2}
  const state={file:{sheets:[sheet],styles:[]},formulaMode:false,closure:{status:'idle',pinned:new Map()},
    editJournal:{structuralOps:new Map(),cells:new Map(),bulkConstantFills:new Map()},recalc:{}}
  const grid=new Map([['4999:0',7]])
  let release,secondRead
  const suspended=new Promise(resolve=>{secondRead=resolve})
  const exports={}
  runInNewContext(code,{exports,Map,Set,Date,Promise,CLOSURE_MAX_CELLS:100,
    window:{__projectMindSheetsHost:{...closureEdits},desktopApi:{
      readWorkbookFormulas:async()=>({cells:[],indexingComplete:true}),
      readWorkbookRange:async({range})=>{
        if(range.startRow===9999){secondRead();await new Promise(resolve=>{release=resolve})}
        return {cells:range.startRow===9999?[{row:9999,column:0,value:10}]:[],rows:[]}
      },
    }},
    indexedFormulas:()=>[{row:0,column:1,formula:'=A5000+A10000+1'}],
    storeFormulaText(){},storeSharedFormulaGroups:()=>({followerCount:0}),recordCachedFormulaValues(){},
    computeFormulaClosure:()=>({ok:true,cellsBySheet:new Map([['sheet',new Set([4999,9999])]]),formulaCount:1}),
    closureFetchRanges:()=>[4999,9999].map(row=>({startRow:row,endRow:row,startColumn:0,endColumn:0})),
    cellKey:row=>row,keyRow:key=>key,keyColumn:()=>0,
    journalCellContentAt:(_journal,_sheet,row)=>row===4999?{found:true,value:7}:{found:false},
    degradeCostlyFormulas:(_state,_name,cells)=>cells,recordRowStyleKeys(){},recordHiddenFileRows(){},
    patchWorksheetRange:(_worksheet,_previous,_range,cells)=>{for(const cell of cells)grid.set(`${cell.row}:${cell.column}`,cell.value)},
    sheetRowColStyleKeys(){},inheritedWrapLookup(){},hiddenRowsInfo(){},t:()=>'',queueFormulaRecalc(){},
  })
  const loading=exports.activateFormulaClosure({univerAPI:{getActiveWorkbook:()=>({getSheetBySheetId:()=>({})})}},{current:state},()=>{})
  await suspended
  // A cached viewport eviction runs while the second native range is pending.
  if(!state.closure.pinned.get('sheet')?.has('4999:0'))grid.delete('4999:0')
  release()
  await loading
  assert.equal(state.closure.status,'active')
  assert.equal((grid.get('4999:0')??0)+(grid.get('9999:0')??0)+1,18)
  assert.equal(state.closure.pinned.get('sheet').get('4999:0').v,7)
})

test('content input journals style changes independently while keeping explicit formatting and resets',()=>{
  const old={ff:'Calibri',fs:11,cl:{rgb:'#000000'},bl:0}
  const content=Object.freeze({v:40,s:Object.freeze({ff:'Calibri',fs:11,cl:{rgb:'#000000'},bl:1})})
  const explicit=Object.freeze({s:{cl:{rgb:'#000000'}}})
  const reset=Object.freeze({v:null,s:null})
  const values=Object.freeze({2:Object.freeze({1:content,2:explicit,3:reset})})
  const result=inputStyles.withoutUnchangedInputStyles(values,()=>old,style=>style)
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{2:{1:{v:40,s:{bl:1}},2:{s:{cl:{rgb:'#000000'}}},3:{v:null,s:null}}})
  assert.equal(result[2][2],explicit)
  assert.equal(result[2][3],reset)
  assert.equal(content.s.ff,'Calibri')
  const plain=inputStyles.withoutUnchangedInputStyles({2:{1:{f:'=A1+1',s:old}}},()=>old,style=>style)
  assert.deepEqual(JSON.parse(JSON.stringify(plain)),{2:{1:{f:'=A1+1'}}})
})

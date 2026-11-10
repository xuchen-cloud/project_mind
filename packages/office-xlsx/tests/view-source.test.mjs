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

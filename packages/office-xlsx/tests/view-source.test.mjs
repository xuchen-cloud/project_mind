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

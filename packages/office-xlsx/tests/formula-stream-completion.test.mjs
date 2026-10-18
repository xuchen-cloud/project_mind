import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {adaptFormulaStreamHold,adaptPreloadCompletion} from '../scripts/initialization-adapter.mjs'

const upstream=await readFile(new URL('../vendor/apps/sheets/src/renderer/formula-stream-hold.ts',import.meta.url),'utf8')
const code=ts.transpileModule(adaptFormulaStreamHold(upstream),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const START='formula.mutation.set-formula-calculation-start',NOTIFY='formula.mutation.set-formula-calculation-notification'

function fixture(stage=2){
 const timers=new Map(),commands=[],before=[],after=[],starts=[],microtasks=[],disposing=[],marks=[];let time=10000,id=0,lifecycle
 const controller={_executingDirtyData:{dirtyRanges:[{sheet:'a'}]}}
 const service={beforeCommandExecuted:callback=>before.push(callback),onCommandExecuted:callback=>after.push(callback),executeCommand(command,params,options){for(const check of before)check({id:command,params});commands.push({command,params,options});return Promise.resolve(true)}}
 const api={Event:{LifeCycleChanged:'lifecycle'},getCurrentLifecycleStage:()=>stage,addEvent(event,callback){lifecycle=callback;return {dispose(){lifecycle=undefined}}}}
 const runtime={univer:{onDispose:callback=>disposing.push(callback),__getInjector:()=>({get:token=>token==='command'?service:controller})},univerAPI:api}
 const exports={};runInNewContext(code,{exports,queueMicrotask:callback=>microtasks.push(callback),performance:{mark:name=>marks.push(name)},window:{__projectMindSheetsHost:{initialCalculationStarting:value=>{assert.equal(value,runtime);starts.push(commands.length)}}},require:name=>name==='@univerjs/core'?{CustomCommandExecutionError:Error,ICommandService:'command',LifecycleStages:{Rendered:2}}:{TriggerCalculationController:'trigger'},Date:{now:()=>time},setTimeout(callback,delay){timers.set(++id,{callback,delay});return id},clearTimeout:timer=>timers.delete(timer)})
 exports.installFormulaStreamHold(runtime)
 const fire=delay=>{const match=[...timers].find(([,timer])=>timer.delay===delay);assert.ok(match,'timer '+delay);timers.delete(match[0]);match[1].callback()}
 const notify=params=>{for(const callback of after)callback({id:NOTIFY,params})}
 return {exports,timers,commands,starts,controller,fire,notify,before,microtasks,marks,drain(){const batch=microtasks.splice(0);for(const callback of batch)callback()},dispose(){for(const callback of disposing)callback()},advance:ms=>time+=ms,render(){stage=2;lifecycle({stage})}}
}

test('incomplete chunks retain quiet debounce and veto; complete preload releases the existing full batch immediately',()=>{
 const f=fixture();f.exports.noteFormulaStreamChunk()
 assert.throws(()=>f.before[0]({id:START,params:{}}),/held while file data streams/)
 assert.deepEqual([...f.timers.values()].map(t=>t.delay),[1020])
 f.exports.requestFullRecalcAfterStream();assert.equal(f.timers.size,0);assert.equal(f.microtasks.length,1)
 f.drain();assert.equal(f.commands.length,1);assert.equal(f.commands[0].params.forceCalculation,true)
 assert.deepEqual(f.starts,[0],'arm the session floor at the actual batch start, before executing the existing command')
 assert.equal(f.commands[0].params.dirtyRanges.length,1);assert.equal(f.controller._restartCalculation,false)
 assert.equal(f.timers.size,0,'no extra quiet timer or calculation is added')
})

test('complete preload waits for actual Rendered controllers before releasing calculation',()=>{
 const f=fixture(1);f.exports.noteFormulaStreamChunk();f.exports.requestFullRecalcAfterStream();f.drain()
 assert.equal(f.commands.length,0)
 f.render();f.drain();assert.equal(f.commands.length,1)
})

test('existing in-progress calculation finishes before the collected full batch starts',()=>{
 const f=fixture();f.notify({stageInfo:{stage:'running'}});f.exports.requestFullRecalcAfterStream();f.drain()
 assert.equal(f.commands.length,0)
 f.notify({functionsExecutedState:3});f.drain()
 assert.equal(f.commands.length,1);assert.equal(f.timers.size,0)
})

test('without complete preload a later chunk retains debounce and does not force a full calculation',()=>{
 const f=fixture();f.exports.noteFormulaStreamChunk();assert.throws(()=>f.before[0]({id:START,params:{}}))
 f.fire(1020);assert.equal(f.commands.length,0,'still inside quiet interval')
 f.advance(1020);f.fire(1020);assert.equal(f.commands.length,1)
 assert.equal(f.commands[0].params.forceCalculation,undefined)
})

test('preload adapter arms the host gate before the existing automatic full request, preserving manual mode',async()=>{
 const source=adaptPreloadCompletion(await readFile(new URL('../vendor/apps/sheets/src/renderer/univer-sync.ts',import.meta.url),'utf8'))
 const line=source.split('\n').find(line=>line.includes('initialCalculationRequested(state,runtime)'))
 assert.ok(line)
 for(const manual of [false,true]){
  const calls=[],state={formulaMode:true},runtime={}
  runInNewContext(line,{state,runtime,isManualCalculation:()=>manual,window:{__projectMindSheetsHost:{initialCalculationRequested:()=>calls.push('arm')}},requestFullRecalcAfterStream:()=>calls.push('existing-full-request')})
  assert.deepEqual(calls,manual?[]:['arm','existing-full-request'])
 }
})


test('complete batch microtask follows all synchronous Rendered hooks and coalesces repeated releases',()=>{
 const f=fixture(1);f.exports.requestFullRecalcAfterStream();f.drain()
 assert.equal(f.commands.length,0)
 f.render();f.exports.requestFullRecalcAfterStream();f.exports.requestFullRecalcAfterStream()
 assert.equal(f.commands.length,0,'never calculate inside lifecycle dispatch')
 assert.equal(f.microtasks.length,1)
 assert.equal(f.timers.size,0,'no timer task remains ahead of the complete batch')
 f.drain();assert.equal(f.commands.length,1);assert.equal(f.microtasks.length,0)
})

test('dispose cancels a queued full batch before microtask execution',()=>{
 const f=fixture();f.exports.requestFullRecalcAfterStream();f.dispose();f.drain()
 assert.equal(f.commands.length,0);assert.equal(f.starts.length,0);assert.equal(f.timers.size,0)
 f.exports.requestFullRecalcAfterStream();assert.equal(f.microtasks.length,0)
})

test('dispose cancels a partial-stream quiet timer',()=>{
 const f=fixture();f.exports.noteFormulaStreamChunk();assert.throws(()=>f.before[0]({id:START,params:{}}))
 assert.equal(f.timers.size,1);f.dispose();assert.equal(f.timers.size,0)
})

test('a partial veto cannot replace a queued complete batch with a quiet timer',()=>{
 const f=fixture();f.exports.noteFormulaStreamChunk();f.exports.requestFullRecalcAfterStream()
 assert.throws(()=>f.before[0]({id:START,params:{}}))
 assert.equal(f.timers.size,0);assert.equal(f.microtasks.length,1)
 f.drain();assert.equal(f.commands.length,1);assert.equal(f.commands[0].params.forceCalculation,true)
})

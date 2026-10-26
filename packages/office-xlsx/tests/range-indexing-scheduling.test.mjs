import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

// Execute the production range reader with a deterministic indexing clock.
const source=readFileSync(new URL('../engine.ts',import.meta.url),'utf8')
const ast=ts.createSourceFile('engine.ts',source,ts.ScriptTarget.Latest,true)
const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='loadedRange')
const code=ts.transpileModule(fn.getFullText(ast)+'\nexports.loadedRange=loadedRange',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
function fixture(readyAt){
 let now=0,calls=0;const waits=[],exports={}
 runInNewContext(code,{exports,Date:{now:()=>now},rangeSchema:{parse:value=>value},setTimeout:(resolve,delay)=>{waits.push(delay);now+=delay;resolve()}})
 const client={async readRange(request){calls++;return{indexingComplete:now>=readyAt,cells:[{row:0,column:0,value:7},{row:9,column:9,value:8}],rows:[{row:0},{row:9}],request}}}
 const metadata={sessionId:'session',sheets:[{id:'sheet',rowCount:10,columnCount:10}]}
 const area={startRow:0,endRow:1,startColumn:0,endColumn:1}
 return{read:()=>exports.loadedRange(client,metadata,'sheet',area),client,waits,get calls(){return calls},get now(){return now}}
}

test('one second of indexing uses bounded backoff instead of 100 repeated range reads',async t=>{
 const f=fixture(1000),range=await f.read()
 assert.ok(f.calls<=10,`range reads: ${f.calls}`)
 assert.deepEqual(Array.from(range.cells,cell=>cell.value),[7])
 assert.ok(Math.max(...f.waits)<=250);assert.ok(f.now<=1250)
 t.diagnostic(`index ready after 1000ms: ${f.calls} reads, ${f.now}ms simulated wait`)
})
test('indexing timeout keeps the five-second deadline with bounded read count',async t=>{
 const f=fixture(Infinity);await assert.rejects(f.read(),/indexing incomplete/)
 assert.equal(f.now,5000);assert.ok(f.calls<=26,`range reads: ${f.calls}`)
 t.diagnostic(`index timeout: ${f.calls} reads, ${f.now}ms simulated wait`)
})
test('ready ranges read once and transport errors propagate immediately',async()=>{
 const f=fixture(0);await f.read();assert.equal(f.calls,1);assert.deepEqual(f.waits,[])
 const error=Error('sidecar failed');f.client.readRange=async()=>{throw error}
 await assert.rejects(f.read(),value=>value===error)
})

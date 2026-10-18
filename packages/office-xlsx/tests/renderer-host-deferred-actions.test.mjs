import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const source=readFileSync(new URL('../renderer-host.ts',import.meta.url),'utf8')
const savePath='./vendor/apps/sheets/src/renderer/save-actions'
const outputPath='./renderer-output'
function host({output={},save,failure,journalCount=1}={}){
 const loads=[],messages=[],exports={}
 const schema={parse:value=>value}
 const code=ts.transpileModule(source+`\nexport {api,flush};
 export function fixture(){options={model:{rendererData:{file:{sessionId:'current'}}},edits:[]};ready=true;context={calcManual:true,commitActiveEditor:async()=>true,lazyWorkbookRef:{current:{editJournal:{structuralOps:new Map(),sheets:{added:new Map(),removed:new Set()},cells:new Map()}}},univerRef:{current:{univerAPI:{getActiveWorkbook:()=>({})}}},saveContext:()=>({})} as any}
 export function capturedFixture(){captured=[]}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 runInNewContext(code,{exports,queueMicrotask,TextEncoder,URL,Map,Set,Promise,require(path){
  loads.push(path)
  if(path===outputPath||path===savePath){if(failure)throw failure;return path===outputPath?output:{handleSave:save??(async()=>{exports.capturedFixture();return {ok:true}})}}
  if(path==='./renderer-channel')return {sendHostMessage:message=>messages.push(message)}
  if(path==='./initial-calculation')return {InitialCalculationGate:class{}}
  if(path.endsWith('/edit-journal'))return {journalSize:()=>journalCount}
  if(path.endsWith('/desktop-api'))return new Proxy({},{get:()=>schema})
  return {}
 }})
 exports.fixture()
 return {...exports,loads,messages}
}

test('host has no static save/output dependency and module evaluation loads neither',()=>{
 const ast=ts.createSourceFile('renderer-host.ts',source,ts.ScriptTarget.Latest,true)
 const paths=ast.statements.filter(ts.isImportDeclaration).map(node=>node.moduleSpecifier.text)
 assert.equal(paths.includes(savePath),false);assert.equal(paths.includes(outputPath),false)
 const h=host();assert.equal(h.loads.includes(savePath),false);assert.equal(h.loads.includes(outputPath),false)
})

test('CSV validates authority before loading output and preserves cancel/write results',async()=>{
 const writes=[];let accepted=false
 const h=host({output:{confirmCsvExport:async()=>accepted,exportFile:async value=>{writes.push(value);return true}}})
 await assert.rejects(h.api.exportCsv({targetPath:'/outside'}),/任意路径/)
 assert.equal(h.loads.includes(outputPath),false)
 assert.equal((await h.api.exportCsv({fileName:'book.csv',content:'A,1'})).canceled,true)
 assert.equal(writes.length,0)
 accepted=true
 assert.equal((await h.api.exportCsv({fileName:'book.csv',content:'A,1'})).path,'book.csv')
 assert.equal(new TextDecoder('utf-8',{ignoreBOM:true}).decode(writes[0].bytes),'\uFEFFA,1')
})

test('output import failures reject the existing action promise',async()=>{
 const error=Error('output chunk unavailable'),h=host({failure:error})
 await assert.rejects(h.api.captureScreenSources(),value=>value===error)
})

test('save import stays inside serialization lock; concurrent flushes invoke save once',async()=>{
 let release,started,calls=0,h
 const held=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve})
 h=host({save:async()=>{calls++;started();await held;h.capturedFixture();return {ok:true}}})
 const a=h.flush(),b=h.flush()
 await entered
 assert.equal(calls,1)
 release();await Promise.all([a,b]);assert.equal(calls,1)
 assert.equal(h.loads.filter(path=>path===savePath).length,1)
})

test('empty journal skips save import; failed save import releases serialization lock',async()=>{
 const empty=host({journalCount:0});await empty.flush();assert.equal(empty.loads.includes(savePath),false)
 const error=Error('save chunk unavailable'),failed=host({failure:error})
 await assert.rejects(failed.flush(),value=>value===error)
 await assert.rejects(failed.flush(),value=>value===error)
 assert.equal(failed.loads.filter(path=>path===savePath).length,2)
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {adaptLoadedVisualScroll} from '../scripts/initialization-adapter.mjs'

const source=adaptLoadedVisualScroll(await readFile(new URL('../vendor/apps/sheets/src/renderer/App.tsx',import.meta.url),'utf8'))
const start=source.indexOf('    const scrollDisposable = runtime.univerAPI.addEvent(')
const end=source.indexOf('    const zoomDisposable =',start)
assert.ok(start>=0&&end>start)
for(const complete of [false,true])test(`scroll keeps lazy range loading, ${complete?'retains loaded floats':'reinstalls streaming visuals'}`,()=>{
 const calls=[],visualViewportKeyRef={current:null};let scroll
 const env={runtime:{univerAPI:{Event:{Scroll:'scroll'},addEvent(event,callback){scroll=callback}}},setAiSelectionAskAnchor(){},loadVisibleRange(){calls.push('range')},lazyWorkbookRef:{current:{flags:{preloadComplete:complete}}},setMessage(){},visualViewportKeyRef,queueVisualInstall(){calls.push('visuals')},queueSparklineInstall(){calls.push('sparklines')},visualDisposablesRef:{},visualInstallTimerRef:{},chartEditRef:{},chartVectorRef:{},shapeEditRef:{},sparklineDisposablesRef:{},sparklineTimerRef:{}}
 runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,env)
 scroll({worksheet:{getVisibleRange:()=>({startRow:0,endRow:10,startColumn:0,endColumn:5}),getSheetId:()=>'sheet-1'},sheetViewStartRow:0,sheetViewStartColumn:0})
 assert.deepEqual(calls,complete?['range']:['range','visuals','sparklines'])
 assert.equal(visualViewportKeyRef.current,'sheet-1:0:10:0:5')
})

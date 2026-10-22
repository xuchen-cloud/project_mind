import {createSelectionController} from './selection'
import {connectHostChannel,onHostMessage,sendHostMessage} from './renderer-channel'
import { CellValueType, CommandType, LifecycleStages } from '@univerjs/core'
import { ErrorType } from '@univerjs/engine-formula'
import { FormulaCalculationSessionService } from '@univerjs/sheets-formula'
import { InitialCalculationGate } from './initial-calculation'
import { defaultAiSettings } from './vendor/packages/ai-provider/src/providers'
import { DEFAULT_AI_PANEL_PREFS } from './vendor/packages/ui/src/ai-panel-prefs'
import { toNeutralStyle,journalSize } from './vendor/apps/sheets/src/renderer/edit-journal'
import { journalSuppression } from './vendor/apps/sheets/src/renderer/univer-state'
import { gatewayChangesSchema } from './gateway-contract'
import { installScrollMasks } from './scroll-masks'
import {screenSourcesResultSchema,screenCaptureRequestSchema,screenCaptureResultSchema,workbookFileSchema,workbookExportCsvRequestSchema,workbookExportPdfRequestSchema,workbookRecalcRequestSchema,workbookRecalcResultSchema} from './vendor/apps/sheets/src/shared/desktop-api'
import type { Edit, Model } from './types'

// Only data and explicit replies cross this frame boundary. No native/path relay is installed.
type Options = { model: Model; edits: Edit[]; readOnly: boolean; presentationMode: 'preview' | 'edit'; appearance: Record<string,string> }
type AppContext = { univerRef: {current:any}; lazyWorkbookRef:{current:any}; commitActiveEditor:()=>Promise<boolean>; saveContext:()=>any; openingWorkbook:boolean; isCellEditing:()=>boolean; calcManual:boolean; output:(action:string)=>Promise<void> }
let options:Options,context:AppContext|undefined,loaded=false,ready=false,serializing:Promise<void>|undefined,stopped=false,rangeReadyMarked=false
let selectionRevision=0,composing=false,selectionBusy=false
const selection=createSelectionController({
 assertAvailable(){if(stopped||!ready||!context||context.openingWorkbook)throw Error('Excel 编辑器尚未就绪或已关闭');if(options.readOnly||options.presentationMode==='preview')throw Error('Excel 当前只读');if(composing||selectionBusy||serializing||outputBusy||context.isCellEditing()||inputPending)throw Error('Excel 正在编辑或处理其他操作')},
 runtime:()=>context!.univerRef.current,state:()=>context!.lazyWorkbookRef.current,revision:()=>selectionRevision,flush,
})
const initialCalculation=new InitialCalculationGate()
let initialCalculationTarget:object
let calculationReadyMarked=false
const baseline=new Map<string,string>();let baselineCaptured=false
let outputBusy=false,outputFailure:Error|undefined
let inputPending=false,pending=false,lastSignature='[]',captured:Edit[]|undefined,restoreStarted=false
const listeners=new Map<string,Set<Function>>()
// Streaming workbooks become interactive after their first viewport; only formula mode preloads all cells.
const initialRangeLoaded=(state:any)=>state&&(state.flags.preloadComplete||(!state.formulaMode&&state.loadedRanges.size>0))
const send=(type:string,value?:unknown,id?:number)=>sendHostMessage({officeXlsx:true,type,value,id})
const subscribe=(event:string,callback:Function)=>{const set=listeners.get(event)??new Set();listeners.set(event,set);set.add(callback);return()=>set.delete(callback)}
const emit=(event:string,value?:unknown)=>listeners.get(event)?.forEach(fn=>fn(value))
const source=()=>{if(!options.model.rendererData)throw Error('完整 Excel 编辑器需要重新 inspect 当前 XLSX');return options.model.rendererData}
const file=()=>({...source().file,readOnly:options.readOnly})
const assertSession=(id:string)=>{if(id!==source().file.sessionId)throw Error('Unknown workbook snapshot')}
// These are immutable data snapshots, not native sessions or paths. The target alone is writable.
const importedSources=new Map<string,Model>()
const snapshot=(id:string)=>{if(id===source().file.sessionId)return options.model;const model=importedSources.get(id);if(!model)throw Error('Unknown workbook snapshot');return model}
const sourceRange=(request:any)=>{const range=snapshot(request.sessionId).ranges[request.sheetId];if(!range)throw Error('Unknown worksheet');const a=request.range
 if(a.startRow<0||a.startColumn<0||a.endRow<a.startRow||a.endColumn<a.startColumn||(a.endRow-a.startRow+1)*(a.endColumn-a.startColumn+1)>100000)throw Error('Range exceeds 100000 cells')
 const within=(c:any)=>c.row>=a.startRow&&c.row<=a.endRow&&c.column>=a.startColumn&&c.column<=a.endColumn
 const {area,...result}=range;return{...result,cells:range.cells.filter(within),rows:range.rows.filter(r=>r.row>=a.startRow&&r.row<=a.endRow),indexingComplete:true}}
function encode(value:any):any {if(value instanceof Map)return{__xlsxMap:[...value].map(([k,v])=>[encode(k),encode(v)])};if(value instanceof Set)return{__xlsxSet:[...value].map(encode)};if(Array.isArray(value))return value.map(encode);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]));return value}
function decode(value:any):any {if(value?.__xlsxMap)return new Map(value.__xlsxMap.map(([k,v]:any[])=>[decode(k),decode(v)]));if(value?.__xlsxSet)return new Set(value.__xlsxSet.map(decode));if(Array.isArray(value))return value.map(decode);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decode(v)]));return value}
function comparableCell(cell:any,workbook:any){
 const style=typeof cell?.s==='string'?workbook.getWorkbook().getStyles().get(cell.s):cell?.s
 const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):v
 return JSON.stringify(stable({v:cell?.f?null:cell?.v??null,f:cell?.f??null,p:cell?.p??null,s:style?toNeutralStyle(style):null,t:cell?.f?null:cell?.t??null}))
}
function pruneRestoredCells(){const state=context!.lazyWorkbookRef.current,journal=state.editJournal;if(journal.structuralOps.size||journal.sheets.added.size||journal.sheets.removed.size)return
 const workbook=context!.univerRef.current.univerAPI.getActiveWorkbook()
 let removed=false;for(const [sheetId,entries]of journal.cells){const sheet=workbook.getSheetBySheetId(sheetId);if(!sheet)continue;for(const [key,entry]of entries){const before=baseline.get(`${sheetId}:${key}`)??comparableCell(null,workbook);if(comparableCell(sheet.getRange(entry.row,entry.column).getCellData(),workbook)===before){entries.delete(key);removed=true}}if(!entries.size)journal.cells.delete(sheetId)}if(removed)context!.saveContext().setPendingEdits?.(journalSize(journal))
}
function formulaValues(){const result:any[]=[];const workbook=context?.univerRef.current?.univerAPI.getActiveWorkbook();if(!workbook)return result
 for(const sheet of workbook.getSheets())sheet.getSheet().getCellMatrix().forValue((row:number,column:number,cell:any)=>{if(!cell?.f&&!cell?.si)return;const value=cell.v;if(value===undefined||value===null)throw Error(`公式尚未得到计算结果：${sheet.getSheetName()}!${row+1}:${column+1}`);result.push({sheetId:sheet.getSheetId(),row,column,value:typeof value==='string'&&Object.values(ErrorType).includes(value as ErrorType)?{error:value}:cell.t===CellValueType.BOOLEAN?!!value:value})});return result}
function capture(request:any){assertSession(request.sessionId);const {sessionId,mode,editsTransferId,...raw}=request
 if(editsTransferId){raw.edits=transfers.get(editsTransferId);transfers.delete(editsTransferId)}
 const changes=gatewayChangesSchema.parse(raw);changes.formulaValues=formulaValues()
 const state=context!.lazyWorkbookRef.current,workbook=context!.univerRef.current.univerAPI.getActiveWorkbook()
 captured=[{kind:'gateway',changes,snapshot:{workbook:workbook.getSnapshot(),journal:encode(state.editJournal)}}]
}
function applyAppearance(){for(const [key,value]of Object.entries(options.appearance))document.documentElement.style.setProperty(key,value)}
function syncLock(){document.documentElement.dataset.presentationMode=options.presentationMode;document.documentElement.dataset.hostReadonly=String(options.readOnly);const workbook=context?.univerRef.current?.univerAPI.getActiveWorkbook();if(!workbook||!ready)return;workbook.setEditable(!options.readOnly)
 for(const node of document.querySelectorAll<HTMLElement>('.ribbon,.dialog-backdrop'))node.inert=options.readOnly&&!node.querySelector('.print-dialog')
 document.documentElement.dataset.hostReadonly=String(options.readOnly)}
// Save serialization and native output stay off the initialize bridge's static graph.
// Await imports inside the existing action promises so failures keep their normal reply path.
async function flush(){if(serializing)return serializing;serializing=(async()=>{if(!context||!ready)throw Error('Excel 编辑器尚未就绪');if(!(await context.commitActiveEditor()))throw Error('单元格输入提交失败')
 const runtime=context.univerRef.current;if(!context.calcManual){const calculated=runtime.univerAPI.getFormula().onCalculationResultApplied(10000);runtime.univerAPI.getFormula().executeCalculation();await calculated}
 captured=undefined;pruneRestoredCells()
 if(journalSize(context.lazyWorkbookRef.current.editJournal)>0){const {handleSave}=await import('./vendor/apps/sheets/src/renderer/save-actions');const result=await handleSave(context.saveContext(),'recovery',true);if(!result.ok||!captured)throw Error('Excel 编辑日志整理失败')}
 const edits=captured??[],signature=JSON.stringify(edits)
 if(signature!==lastSignature){lastSignature=signature;send('change',edits)}
 pending=inputPending;send('pending',pending)
 })().finally(()=>{serializing=undefined});return serializing}
async function runOutput(command:unknown){
 const action=command==='pdf'?'export-pdf':command==='csv'?'export-csv':command==='print'?'print':null
 if(!action)throw Error('未知 Excel 输出命令')
 if(!ready||!context)throw Error('Excel 编辑器尚未就绪')
 if(outputBusy)throw Error('Excel 输出正在进行')
 outputBusy=true;outputFailure=undefined
 try{if(!await context.commitActiveEditor())throw Error('单元格输入提交失败');await context.output(action);if(outputFailure)throw outputFailure}
 finally{outputBusy=false;outputFailure=undefined}
}
const transfers=new Map<string,any[]>()
let nextSave=0;const saveReplies=new Map<number,{resolve:()=>void,reject:(error:Error)=>void}>()
const api:Record<string,any>={
 signalMcpReady:()=>{},
 captureScreenSources:async()=>{const {captureScreenSources}=await import('./renderer-output');return screenSourcesResultSchema.parse(await captureScreenSources())},
 captureScreenSource:async(input:unknown)=>{const request=screenCaptureRequestSchema.parse(input);const {captureScreenSource}=await import('./renderer-output');const result=await captureScreenSource(request);return result===null?null:screenCaptureResultSchema.parse(result)},
 exportPdf:async(input:unknown)=>{const request=workbookExportPdfRequestSchema.parse(input);if(request.outPath)throw Error('PDF 导出不接受任意路径');const {embeddedPrintDocuments,renderPdfDocuments,exportFile}=await import('./renderer-output');const documents=await embeddedPrintDocuments(request.html,request.fileName.replace(/\.pdf$/i,''));const bytes=await renderPdfDocuments(documents);const written=await exportFile({name:request.fileName,mime:'application/pdf',bytes});return written?{canceled:false,path:request.fileName}:{canceled:true}},
 exportCsv:async(input:unknown)=>{const request=workbookExportCsvRequestSchema.parse(input);if(request.targetPath)throw Error('当前 File 导出不接受任意路径');const {confirmCsvExport,exportFile}=await import('./renderer-output');if(!await confirmCsvExport(request.hasFormulas,request.activeSheetName))return{canceled:true};const written=await exportFile({name:request.fileName,mime:'text/csv;charset=utf-8',bytes:new TextEncoder().encode('\uFEFF'+request.content)});return written?{canceled:false,path:request.fileName}:{canceled:true}},
 printWorkbook:async(input:unknown)=>{const request=workbookExportPdfRequestSchema.parse(input);if(request.outPath||request.deviceName)throw Error('打印机与路径由原生打印对话框选择');const {embeddedPrintDocuments,printDocument}=await import('./renderer-output');const documents=await embeddedPrintDocuments(request.html,request.fileName.replace(/\.pdf$/i,''),request.copies,request.collate);for(const document of documents)await printDocument(document);return{ok:true}},
 getLanguage:async()=>'zh',getTheme:async()=>'light',getDocumentTheme:async()=>'light',getAutoSaveDefault:async()=>false,getAiPanelPrefs:async()=>({...DEFAULT_AI_PANEL_PREFS,openInNewDocs:false}),getAiSettings:async()=>defaultAiSettings(),getUserDisplayName:async()=>'Project Mind',
 hasQueuedWorkbook:async()=>!loaded,consumeNewBlankWorkbook:async()=>false,consumeHeadlessExport:async()=>null,
 selectWorkbook:async()=>{loaded=true;return file()},reopenWorkbook:async()=>file(),closeWorkbook:async(id:string)=>{importedSources.delete(id)},
 selectWorkbooksForMerge:async()=>{
  if(options.readOnly)throw Error('当前工作簿只读')
  const selected=await pickWorkbooks(),opened:string[]=[],files=[]
  try{for(const selectedFile of selected){
   if(!/\.xlsx$/i.test(selectedFile.name))throw Error('请选择 XLSX 工作簿')
   if(!selectedFile.size||selectedFile.size>64*1024*1024)throw Error('导入 XLSX 超出 64 MiB 字节预算')
   const {inspectImportedWorkbook}=await import('./renderer-output');const model=await inspectImportedWorkbook(new Uint8Array(await selectedFile.arrayBuffer()))
   if(options.readOnly)throw Error('当前工作簿已变为只读')
   if(model.format!=='xlsx'||!model.rendererData)throw Error('导入宿主未返回完整 XLSX 快照')
   const sessionId=crypto.randomUUID()
   const importedFile=workbookFileSchema.parse({...model.rendererData.file,sessionId,name:selectedFile.name,readOnly:true})
   delete importedFile.path
   importedSources.set(sessionId,{...model,name:selectedFile.name,rendererData:{...model.rendererData,file:importedFile}})
   opened.push(sessionId);files.push(importedFile)
  }return files}catch(error){for(const id of opened)importedSources.delete(id);throw error}
 },
 readWorkbookRange:async(request:any)=>sourceRange(request),readWorkbookFormulas:async(request:any)=>snapshot(request.sessionId).rendererData!.formulas[request.sheetId],readWorkbookRowOutline:async(request:any)=>snapshot(request.sessionId).rendererData!.outlines[request.sheetId],
 readWorkbookMedia:async(request:any)=>{const result=snapshot(request.sessionId).rendererData!.media[request.visualId];if(!result)throw Error('Unknown workbook image');return result},
 readPivotDefinition:async(request:any)=>{const result=snapshot(request.sessionId).rendererData!.pivots[request.path];if(!result)throw Error('Unknown pivot definition');return result},
 recalcWorkbook:async(input:unknown)=>{const{sessionId,...request}=workbookRecalcRequestSchema.parse(input);assertSession(sessionId);const {recalculateWorkbook}=await import('./renderer-output');return workbookRecalcResultSchema.parse(await recalculateWorkbook(request))},
 beginSaveEditsTransfer:async(request:any)=>{assertSession(request.sessionId);transfers.set(request.transferId,[])},sendSaveEditsChunk:async(request:any)=>{assertSession(request.sessionId);const items=transfers.get(request.transferId);if(!items)throw Error('Unknown edit transfer');items.push(...JSON.parse(request.editsJson))},abortSaveEditsTransfer:async(request:any)=>{transfers.delete(request.transferId)},
 writeWorkbookRecovery:async(request:any)=>{capture(request);return{ok:true}},
 saveWorkbookEdits:async()=>{throw Error('保存必须通过当前 File 的原生版本校验')},
 notifyPendingEdits:(_count:number)=>{if(!ready)return;pending=inputPending||journalSize(context!.lazyWorkbookRef.current.editJournal)>0;send('pending',pending);if((pending||(lastSignature!==''&&lastSignature!=='[]'))&&!options.readOnly&&!context?.isCellEditing())queueMicrotask(()=>{void flush().catch(error=>send('error',String(error.message??error)))})},
 openExternal:async(url:string)=>{const parsed=new URL(url);if(!['https:','http:','mailto:'].includes(parsed.protocol))throw Error('Unsupported external link');window.open(url,'_blank','noopener')},
 setAiPanelPrefs:async()=>({...DEFAULT_AI_PANEL_PREFS,openInNewDocs:false}),
 findWorkbookCells:async(request:any)=>{assertSession(request.sessionId);const matches:any[]=[];let pattern=request.query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');if(request.wildcards)pattern=pattern.replace(/\\\*/g,'.*').replace(/\\\?/g,'.');if(request.matchEntireCell)pattern='^'+pattern+'$';const re=new RegExp(pattern,request.matchCase?'':'i')
  for(const sheet of options.model.sheets){if(request.sheetId&&request.sheetId!==sheet.id)continue;for(const cell of options.model.ranges[sheet.id].cells){const fields=request.lookIn==='formulas_only'?[cell.formula]:request.lookIn==='formulas'?[cell.formula??String(cell.value??'')]:request.lookIn==='both'?[String(cell.value??''),cell.formula]:[String(cell.value??'')];if(fields.some(value=>value!==undefined&&re.test(value)))matches.push({sheetId:sheet.id,row:cell.row,column:cell.column,value:cell.value,valueText:String(cell.value??''),...(cell.formula?{formulaText:cell.formula}:{})})}}
  const start=request.resumeAt?matches.findIndex(c=>c.sheetId===request.resumeAt.sheetId&&c.row===request.resumeAt.row&&c.column===request.resumeAt.column):0;const page=matches.slice(Math.max(start,0),Math.max(start,0)+request.limit),next=matches[Math.max(start,0)+request.limit];return{matches:page,complete:!next,...(next?{nextCursor:{sheetId:next.sheetId,row:next.row,column:next.column}}:{}),indexingComplete:true}},
}
export async function initialize(){options=await new Promise<Options>(resolve=>{const init=(event:MessageEvent)=>{if(event.source!==parent||event.data?.officeXlsx!==true||event.data.type!=='init')return;window.removeEventListener('message',init);if(!event.ports[0])throw Error('Excel 宿主缺少专属通信端口');connectHostChannel(event.ports[0]);resolve(event.data.value)};window.addEventListener('message',init);parent.postMessage({officeXlsx:true,type:'bootstrap'},'*')})
 // A clean mount (or restored host draft) is the comparison baseline, not an edit.
 lastSignature=JSON.stringify(options.edits)
 applyAppearance();syncLock()
 ;(window as any).desktopApi=new Proxy(api,{get(target,key:string){if(key in target)return target[key];if(key.startsWith('on'))return(callback:Function)=>subscribe(key,callback);return async()=>{throw Error(`当前 File 宿主尚未连接 ${key}`)}}})
 ;(window as any).__projectMindSheetsHost={
  initialCalculationRequested(state:object){initialCalculationTarget=state;initialCalculation.expect(state);performance.mark('office-xlsx:initial-calculation-requested')},
  initialCalculationStarting(runtime:any){initialCalculation.begin(initialCalculationTarget,runtime.univer.__getInjector().get(FormulaCalculationSessionService).state.id);performance.mark('office-xlsx:initial-calculation-starting')},
  isReadOnly:()=>options.readOnly,
  outputFailed:(error:unknown)=>{if(outputBusy)outputFailure=error instanceof Error?error:Error(String(error))},
  edited:()=>api.notifyPendingEdits(0),
  menu:(action:string)=>emit('onMenuAction',action),
  render(next:AppContext){if(!context)performance.mark('office-xlsx:first-app-context');context=next;syncLock();if(!ready&&!next.openingWorkbook&&initialRangeLoaded(next.lazyWorkbookRef.current)){queueMicrotask(()=>void finishReady())}},
  attach(runtime:any){performance.mark('office-xlsx:runtime-attached');performance.mark('office-xlsx:lifecycle-'+runtime.univerAPI.getCurrentLifecycleStage());runtime.univerAPI.addEvent(runtime.univerAPI.Event.LifeCycleChanged,({stage}:any)=>performance.mark('office-xlsx:lifecycle-'+stage));
   runtime.univerAPI.onCommandExecuted((command:any)=>{if(ready&&command.type===CommandType.MUTATION&&!journalSuppression.active&&command.params?.unitId===runtime.univerAPI.getActiveWorkbook()?.getId())selectionRevision++})
   runtime.univerAPI.addEvent(runtime.univerAPI.Event.SheetEditChanging,({worksheet,row,column,value}:any)=>{if(!ready||options.readOnly)return;const cell=worksheet.getRange(row,column).getCellData(),current=cell?.f??cell?.p?.body?.dataStream?.replace(/\r\n$/,'')??String(cell?.v??''),input=value.getData().body?.dataStream?.replace(/\r\n$/,'')??'';if(input!==current){inputPending=true;send('pending',true)}})
   runtime.univerAPI.addEvent(runtime.univerAPI.Event.SheetEditEnded,()=>{inputPending=false;api.notifyPendingEdits(0)})
   runtime.univerAPI.addEvent(runtime.univerAPI.Event.BeforeSheetEditStart,(event:any)=>{if(ready&&options.readOnly)event.cancel=true})
   runtime.univerAPI.addEvent(runtime.univerAPI.Event.BeforeCommandExecute,(event:any)=>{if(ready&&options.readOnly&&event.type===CommandType.MUTATION)event.cancel=true})},
  requestSave:async()=>{await flush();if(lastSignature==='[]')return{ok:true};const id=++nextSave;await new Promise<void>((resolve,reject)=>{saveReplies.set(id,{resolve,reject});send('saveRequest',undefined,id)});return{ok:true}},
 }
 onHostMessage(data=>{const{type,value,id}=data;if(type==='captureSelection'||type==='applySelection'){if(selectionBusy){send('reply',{error:'Excel 正在处理选区操作'},id);return}const action=type==='captureSelection'?selection.captureSelection():selection.applySelection(value);selectionBusy=true;void action.then(result=>send('reply',{result},id),error=>send('reply',{error:String(error.message??error)},id)).finally(()=>{selectionBusy=false})}if(type==='saveReply'){const reply=saveReplies.get(id);saveReplies.delete(id);if(value?.error)reply?.reject(Error(value.error));else reply?.resolve()}if(type==='update'){options={...options,...value};applyAppearance();syncLock()}if(type==='commit'||type==='output')void (type==='commit'?flush():runOutput(value)).then(()=>send('reply',null,id),error=>send('reply',{error:String(error.message??error)},id))})
 const tick=()=>{if(!ready&&initialRangeLoaded(context?.lazyWorkbookRef.current)&&!context.openingWorkbook)void finishReady();if(!stopped)requestAnimationFrame(tick)};requestAnimationFrame(tick)
 window.addEventListener('keydown',event=>{if(!(event.metaKey||event.ctrlKey)||event.altKey)return;const key=event.key.toLowerCase();if(key==='s'&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();void (window as any).__projectMindSheetsHost.requestSave().catch((error:any)=>send('error',String(error.message??error)))}else if(key==='p'&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();emit('onMenuAction','print')}},true)
 window.addEventListener('compositionstart',()=>{composing=true},true)
 window.addEventListener('compositionend',()=>{composing=false},true)
 installScrollMasks(document.body)
 window.addEventListener('pagehide',()=>{stopped=true;initialCalculation.dispose()},{once:true})
}
async function finishReady(){if(ready||stopped||!context)return;const state=context.lazyWorkbookRef.current;if(context.openingWorkbook||!initialRangeLoaded(state))return;if(!rangeReadyMarked){rangeReadyMarked=true;performance.mark('office-xlsx:initial-content-loaded')}const runtime=context.univerRef.current;if(!runtime)return;if(runtime.univerAPI.getCurrentLifecycleStage()<LifecycleStages.Steady)return
 if(!initialCalculation.ready(state,context.calcManual,runtime.univer.__getInjector().get(FormulaCalculationSessionService).state))return
 if(state?.formulaMode&&!context.calcManual){
  if(!calculationReadyMarked){calculationReadyMarked=true;performance.mark('office-xlsx:initial-calculation-applied')}
 }
 const workbook=runtime.univerAPI.getActiveWorkbook();if(!baselineCaptured){baselineCaptured=true;for(const sheet of workbook.getSheets())sheet.getSheet().getCellMatrix().forValue((row:number,column:number,cell:any)=>{if(cell)baseline.set(`${sheet.getSheetId()}:${row}:${column}`,comparableCell(cell,workbook))})}
 const draft=options.edits.find(edit=>edit.kind==='gateway')
 if(draft?.kind==='gateway'&&draft.snapshot&&!restoreStarted){restoreStarted=true;const saved=draft.snapshot as any;if(saved.workbook&&saved.journal){const state=context.lazyWorkbookRef.current,active=runtime.univerAPI.getActiveWorkbook();journalSuppression.active=true;try{runtime.univerAPI.disposeUnit(active.getId());runtime.univerAPI.createWorkbook(saved.workbook);Object.assign(state.editJournal,decode(saved.journal))}finally{journalSuppression.active=false}}}
 performance.mark('office-xlsx:ready');ready=true;syncLock();send('ready');if(options.edits.length){lastSignature=JSON.stringify(options.edits);pending=true;send('pending',true)}
}

/** Native file chooser ownership stays with the browser; only selected bytes leave the frame. */
function pickWorkbooks():Promise<File[]>{return new Promise(resolve=>{
 const input=document.createElement('input');input.type='file';input.accept='.xlsx';input.multiple=true;input.hidden=true
 const finish=(files:File[])=>{input.remove();resolve(files)}
 input.onchange=()=>finish([...input.files??[]]);input.oncancel=()=>finish([]);document.body.append(input);input.click()
})}

import './browser-node-shims';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {openPptx} from '@genoffice/pptx-engine';
import {createParitySession} from './parity-session';
import {candidateEdit} from './parity-candidate';
import {samePackage} from './parity-history';
import {createApi} from './parity-api.mjs';
import {App} from './vendor/apps/slides/src/renderer/App';
import {LocaleProvider} from './vendor/apps/slides/src/renderer/i18n/locale';
import {installScreenTips} from '@genoffice/ui';
import {markClipboard,readClipboard,nativeClipboard} from './browser-clipboard';
import {fontsReady,waitForFonts,browserFontMetrics,fontCatalog,privateFontFaces,privateFontData,installLocalFonts} from './browser-fonts';
import {deliver,pickModel,setExportSink,setPrintSink,setRenderPdfSink} from './browser-delivery';
import {pickImageFile,imageNaturalSize,pickMediaFile} from './fork-picker.mjs';
import '@genoffice/ui/tokens.css';
import '@genoffice/ui/screentip.css';
import '@genoffice/ui/color-picker.css';
import '@genoffice/ui/dropdown.css';
import '@genoffice/ui/ribbon-collapse.css';
import './vendor/apps/slides/src/renderer/styles.css';
import './parity-frame.css';
import type {PptxCommand} from './types';
import {checkpointTextEdit,settleTextEditSave,setTextEditReadOnly,setTextEditComposing,abandonTextEdit,cancelTextEditResume,noteTextEditPointer} from './parity-text-edit';
import {runPptxOutput} from './parity-output';
import {livePptxSelection,selectionContext,selectionOps} from './parity-selection';
import {setPptxEpoch} from './parity-protocol';
import {setPptxPresentationMode} from './parity-presentation';

const listeners = new Map<string,Set<(...args:any[])=>void>>();
const emit=(name:string,payload:any)=>listeners.get(name)?.forEach(f=>f({},payload));
let hostChannel:MessagePort|undefined;
let epoch=0;
const post=(type:string,payload:object={},context=epoch)=>{if(context!==epoch)return;const message={source:'project-mind-pptx',epoch:context,type,...payload};if(hostChannel)hostChannel.postMessage(message);else parent.postMessage(message,'*')};
const checkContext=(context:number)=>{if(context!==epoch)throw new Error('PPTX 编辑内容已替换')};
let session:ReturnType<typeof createParitySession>;
let baseline:Awaited<ReturnType<typeof openPptx>>;
let initializing=false,dirtyVersion=0,snapshotVersion=0;
let snapshotTimer:ReturnType<typeof setTimeout>|undefined;
let composing=false,activeInput=false,readOnly=false;
let queue:Promise<unknown>=Promise.resolve();
let busy=0;
let pointerDown=false;
let capturedSelection:{selectionId:string;epoch:number;version:number;slideIndex:number;ids:string[]}|undefined;
const assertSelectionReady=()=>{if(initializing||!session)throw Error('PPTX 编辑器尚未就绪');if(readOnly)throw Error('PPTX 当前为只读预览');if(composing||activeInput||pointerDown||session.state.transformPreview||session.state.masterEdit)throw Error('请先结束当前 PPTX 编辑');if(error)throw error};
document.addEventListener('pointerdown',()=>{pointerDown=true},true);
document.addEventListener('pointerup',()=>{pointerDown=false},true);
document.addEventListener('pointercancel',()=>{pointerDown=false},true);
let error:Error|null=null;
const pending=()=>post('pending',{pending:composing||activeInput||busy>0||dirtyVersion!==snapshotVersion});
let generation=0;
const printRequests=new Map<number,{resolve:()=>void;reject:(error:Error)=>void}>();
const renderPdfRequests=new Map<number,{resolve:(bytes:Uint8Array)=>void;reject:(error:Error)=>void}>();
let exportSequence=0;const exportRequests=new Map<number,{resolve:(ok:boolean)=>void;reject:(error:Error)=>void}>();
let saveSequence=0;const saveRequests=new Map<number,(result:any)=>void>();
const root=createRoot(document.getElementById('root')!);
function reportError(value:unknown,context=epoch){if(context!==epoch)return;error=value instanceof Error?value:new Error(String(value));post('error',{message:error.message},context)}
function snapshotNow():Promise<void>{
 if(snapshotTimer)clearTimeout(snapshotTimer);snapshotTimer=undefined;
 const version=dirtyVersion;
 const context=epoch,target=session,source=baseline;
 const next=queue.then(async()=>{
  checkContext(context);
  if(version===snapshotVersion)return;
  const bytes=await target.save();checkContext(context);
  const candidate=await candidateEdit(source,bytes);checkContext(context);
  snapshotVersion=version;post('change',{edits:candidate.changedParts.length?[candidate]:[]},context);pending();
 });
 queue=next.catch(e=>reportError(e,context));return next;
}
function scheduleSnapshot(){if(snapshotTimer)clearTimeout(snapshotTimer);snapshotTimer=setTimeout(()=>{void snapshotNow().catch(()=>{})},160)}
const ipcRenderer={
 on(name:string,listener:(...args:any[])=>void){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(listener)},
 removeListener(name:string,listener:(...args:any[])=>void){listeners.get(name)?.delete(listener)},
 send(name:string,...args:any[]){if(name==='slides:editing-active')return;},
 invoke(name:string,...args:any[]):Promise<any>{
  const context=epoch,target=session;
  const metadata:Record<string,any>={
   'app:get-language':'zh','app:get-theme':document.documentElement.dataset.theme??'light','app:get-auto-save-default':{on:false,updatedAt:0},'app:get-ai-panel-prefs':{},
   'slides:font-missing':[],
   'slides:consume-headless-export':null,'slides:recent':[], 'slides:cloud-gen-status':{enabled:false},
   'slides:get-ai-settings':{},'ai:settings':{},'ai:get-settings':{},
  };
  if(name==='slides:font-catalog')return fontCatalog();
  if(name==='slides:private-font-faces')return privateFontFaces();
  if(name==='slides:private-font-data')return privateFontData(args[0]);
  if(Object.hasOwn(metadata,name))return Promise.resolve(metadata[name]);
  if(['app:set-auto-save-pref','app:set-ai-panel-prefs','slides:set-auto-save-pref','slides:autosave','slides:editing-active'].includes(name))return Promise.resolve();
  if(name==='slides:consume-pending-open')return Promise.resolve(session.openResult(args[0]));
  if(name==='slides:save'||name==='slides:save-as')return new Promise(resolve=>{const requestId=++saveSequence;saveRequests.set(requestId,resolve);post('save-request',{requestId})});
  if(name==='slides:export-pdf'||name==='slides:print')return queue.then(async()=>{
   await waitForFonts();checkContext(context);
   const {cx,cy}=target.state.opened.deck.size;
   return deliver(name,args,{widthPt:cx/12700,heightPt:cy/12700});
  });
  if(/^slides:(?:pick-export-dir|pick-export-pdf-path|save-picture|export-images)$/.test(name))return deliver(name,args);
  if(name==='slides:show-fullscreen')return (args[0]?document.documentElement.requestFullscreen():document.fullscreenElement?document.exitFullscreen():Promise.resolve()).then(()=>true);
  if(name==='slides:presenter-start')return Promise.resolve({audience:false});
  if(name==='slides:presenter-end')return Promise.resolve();
  if(readOnly&&!/^slides:(?:get-|media-data|is-dirty|clipboard-probe|clipboard-external|has-slide-clipboard)/.test(name))return Promise.reject(new Error('PPTX session is read only'));
  if(name==='slides:font-install-local')return installLocalFonts().then(async result=>{
   checkContext(context);const slides=await queue.then(()=>target.invoke('slides:get-render-slides'));checkContext(context);
   emit('slides:deck-changed',{slides});emit('slides:fonts-changed',undefined);return result;
  }).catch(e=>{reportError(e,context);throw e});
  if(name==='slides:native-clipboard')return nativeClipboard(args[0],()=>checkContext(context)).catch(e=>{reportError(e,context);throw e});
  if(name==='slides:copy-elements-image')return markClipboard('internal',args[1]);
  if(name==='slides:clipboard-probe')return queue.then(async()=>{checkContext(context);const result=await target.invoke(name,args);checkContext(context);return result||!!navigator.clipboard?.read});
  if(name==='slides:clipboard-external')return queue.then(async()=>{checkContext(context);const result=await readClipboard(await target.invoke(name,args));checkContext(context);return result}).catch(e=>{reportError(e,context);throw e});
  // Browser file picks produce byte payloads before entering the replayable command journal.
  if(name==='slides:pick-picture-file')return pickImageFile().then(async (f:any)=>{checkContext(context);if(!f)return null;const naturalPx=await imageNaturalSize(f.bytes);checkContext(context);return {base64:Buffer.from(f.bytes).toString('base64'),ext:f.ext,naturalPx}});
  if(name==='slides:insert-media')return pickMediaFile(args[1]).then((f:any)=>{checkContext(context);return f?ipcRenderer.invoke('slides:add-media-bytes',{slideIndex:args[0],kind:args[1],fitWidthPx:args[2],base64:Buffer.from(f.bytes).toString('base64'),ext:f.ext,name:f.name}):null});
  if(name==='slides:insert-model3d'&&!args[2]?.source)return pickModel().then(f=>{checkContext(context);return f?ipcRenderer.invoke(name,...args,{source:{base64:Buffer.from(f.bytes).toString('base64'),ext:f.ext,name:f.name}}):null});
  if(name==='slides:insert-image')return pickImageFile().then(async(f:any)=>{checkContext(context);if(!f)return null;const naturalPx=await imageNaturalSize(f.bytes);checkContext(context);return ipcRenderer.invoke('slides:add-image-bytes',{slideIndex:args[0],fitWidthPx:args[1],base64:Buffer.from(f.bytes).toString('base64'),ext:f.ext,naturalPx})});
  if((name==='slides:edit-image-fill'||name==='slides:edit-background')&&!args[0].source&&(name==='slides:edit-image-fill'&&!args[0].mediaPath||args[0].kind==='image'&&args[0].pick!==false))return pickImageFile().then((f:any)=>{checkContext(context);return f?ipcRenderer.invoke(name,{...args[0],source:{base64:Buffer.from(f.bytes).toString('base64'),ext:f.ext}}):null});
  busy++;pending();
  const next=queue.then(async()=>{await waitForFonts();checkContext(context);const result=await target.invoke(name,args);checkContext(context);if(name==='slides:copy-elements'&&result)await markClipboard('internal');if(name==='slides:copy-slides'&&result)await markClipboard('slide',args[0].pngs?.[0]);checkContext(context);return result});
  next.then(()=>{if(context===epoch){error=null;post('error',{message:''},context)}},()=>{});
  queue=next.catch((e:unknown)=>reportError(e,context)).finally(()=>{if(context===epoch){busy--;pending()}});
  return next;
 }
};
(window as any).slidesApi=createApi(ipcRenderer);
(window as any).projectApi={};
// Host takes responsibility for saving; standalone app management/AI chat are omitted.
localStorage.setItem('ai-slides-show-ai','0');
localStorage.setItem('ai-slides-auto-save','0');
installScreenTips();
document.addEventListener('compositionstart',()=>{composing=true;setTextEditComposing(true);pending()},true);
document.addEventListener('compositionend',()=>{composing=false;setTextEditComposing(false);pending()},true);
document.addEventListener('input',e=>{if((e.target as HTMLElement).closest('.slide-text-editor,textarea')){activeInput=true;pending()}},true);
document.addEventListener('focusout',()=>queueMicrotask(()=>{if(!document.querySelector('.slide-text-editor')){activeInput=false;pending()}}),true);
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopImmediatePropagation();post('save-request')}},true);
document.addEventListener('pointerdown',noteTextEditPointer,true);
document.addEventListener('keydown',cancelTextEditResume,true);
document.addEventListener('contextmenu',event=>{if(document.body.dataset.presentationMode==='preview'){event.preventDefault();event.stopImmediatePropagation()}},true);
const syncReadOnly=()=>{
 document.body.dataset.readOnly=String(readOnly);
 session?.setReadOnly(readOnly);
 document.querySelectorAll<HTMLElement>('.ribbon-body,.qa-btn,.file-menu>button:nth-child(2),.notes-pane,.slide-text-editor,.stage-rel,.format-pane,.bg-format-pane,.anim-pane,.comments-pane').forEach(e=>{e.inert=readOnly});
};
const scrollRegions=new Set<HTMLElement>();
const ribbonFades=new WeakMap<HTMLElement,HTMLElement>();
const fadeResize=new ResizeObserver(()=>measureFades());
let scanFrame=0;
function scanScrollRegions(){scanFrame=0;for(const el of document.querySelectorAll<HTMLElement>('#root *')){const style=getComputedStyle(el);if(/auto|scroll/.test(style.overflowY+' '+style.overflowX)&&!scrollRegions.has(el)){scrollRegions.add(el);fadeResize.observe(el)}}measureFades()}
function measureFades(){for(const el of scrollRegions){
 if(!el.isConnected){scrollRegions.delete(el);fadeResize.unobserve(el);continue}
 const y=Math.max(0,el.scrollHeight-el.clientHeight),x=Math.max(0,el.scrollWidth-el.clientWidth);
 const fade=(d:number,max:number)=>max?Math.min(1,Math.max(0,d)/Math.min(64,max/2)):0;
 const top=fade(el.scrollTop,y),bottom=fade(y-el.scrollTop,y),left=fade(el.scrollLeft,x),right=fade(x-el.scrollLeft,x);
 el.dataset.fadeTop=String(top);el.dataset.fadeBottom=String(bottom);el.dataset.fadeLeft=String(left);el.dataset.fadeRight=String(right);
 // A mask on the ribbon scrollport clips its fixed, anchored dropdowns. Keep
 // its continuous fades in a sibling overlay, below menus and outside the clip.
 if(el.classList.contains('ribbon-body')){
  let overlay=ribbonFades.get(el);
  if(!overlay){overlay=document.createElement('div');overlay.className='pm-ribbon-fades';overlay.setAttribute('aria-hidden','true');el.parentElement!.append(overlay);ribbonFades.set(el,overlay)}
  Object.assign(overlay.style,{left:`${el.offsetLeft}px`,top:`${el.offsetTop}px`,width:`${el.clientWidth}px`,height:`${el.clientHeight}px`});
  overlay.style.setProperty('--fade-left',String(left));overlay.style.setProperty('--fade-right',String(right));
  continue;
 }
 el.style.maskImage=`linear-gradient(to bottom,rgba(0,0,0,${1-top}),#000 min(24px,35%),#000 calc(100% - min(24px,35%)),rgba(0,0,0,${1-bottom})),linear-gradient(to right,rgba(0,0,0,${1-left}),#000 min(16px,35%),#000 calc(100% - min(16px,35%)),rgba(0,0,0,${1-right}))`;
 el.style.maskComposite='intersect';
 }}
new MutationObserver(()=>{syncReadOnly();if(!scanFrame)scanFrame=requestAnimationFrame(scanScrollRegions)}).observe(document.getElementById('root')!,{childList:true,subtree:true});
document.addEventListener('scroll',measureFades,true);new ResizeObserver(measureFades).observe(document.body);
document.addEventListener('keydown',e=>{if(readOnly&&(e.key==='Delete'||e.key==='Backspace'||((e.metaKey||e.ctrlKey)&&/^[zxyvd]$/i.test(e.key)))){e.preventDefault();e.stopImmediatePropagation()}},true);
async function receiveHost(m:any){
 if(m?.source!=='project-mind-pptx-host')return;
 let previousQueue:Promise<unknown>=queue;
 let previousSaves:Array<(result:any)=>void>=[];
 if(m.type==='init'){
  if(!Number.isSafeInteger(m.epoch)||m.epoch<=epoch)return;
  epoch=m.epoch;setPptxEpoch(epoch);initializing=true;capturedSelection=undefined;
  setPptxPresentationMode(m.presentationMode??'edit');
  // Capture initial permissions before I/O; newer readonly messages may arrive
  // while fonts/archive parsing is pending and must win at completion.
  readOnly=m.presentationMode==='preview'||m.readOnly;
  previousQueue=queue;queue=Promise.resolve();busy=0;
  if(snapshotTimer)clearTimeout(snapshotTimer);snapshotTimer=undefined;
  const replaced=new Error('PPTX 编辑内容已替换');
  for(const requests of [exportRequests,printRequests,renderPdfRequests]){requests.forEach(r=>r.reject(replaced));requests.clear()}
  previousSaves=[...saveRequests.values()];saveRequests.clear();
 }else if(m.epoch!==epoch)return;
 const context=epoch;
 if(m.type==='capabilities'){setRenderPdfSink(m.renderPdf?document=>new Promise((resolve,reject)=>{const requestId=++exportSequence;renderPdfRequests.set(requestId,{resolve,reject});post('render-pdf-request',{requestId,document})}):undefined);setPrintSink(m.print?document=>new Promise((resolve,reject)=>{const requestId=++exportSequence;printRequests.set(requestId,{resolve,reject});post('print-request',{requestId,document})}):undefined);setExportSink(m.export?file=>new Promise((resolve,reject)=>{const requestId=++exportSequence;exportRequests.set(requestId,{resolve,reject});post('export-request',{requestId,file})}):undefined)}
 else if(m.type==='render-pdf-finished'){const request=renderPdfRequests.get(m.requestId);renderPdfRequests.delete(m.requestId);if(m.error)request?.reject(new Error(m.error));else request?.resolve(m.bytes)}
 else if(m.type==='print-finished'){const request=printRequests.get(m.requestId);printRequests.delete(m.requestId);if(m.error)request?.reject(new Error(m.error));else request?.resolve()}
 else if(m.type==='export-finished'){const request=exportRequests.get(m.requestId);exportRequests.delete(m.requestId);if(m.error)request?.reject(new Error(m.error));else request?.resolve(m.ok)}
 else if(m.type==='save-finished'){settleTextEditSave();saveRequests.get(m.requestId)?.(m.error?{ok:false,error:m.error}:{ok:true});saveRequests.delete(m.requestId)}
 else if(m.type==='cancel-save-focus')cancelTextEditResume();
 else if(m.type==='theme'){
  document.documentElement.dataset.theme=m.theme;
  for(const [name,value] of Object.entries(m.tokens as Record<string,string>))document.documentElement.style.setProperty(name,value);
  emit('app:theme-changed',m.theme);
 }else if(m.type==='init'){
  try{
   await previousQueue;checkContext(context);await fontsReady;checkContext(context);
   const currentSession=session;
   const same=currentSession&&m.edits.length===0&&await samePackage(await currentSession.save(),m.model.sourceBase64);
   checkContext(context);
   const nextBaseline=await openPptx(new Uint8Array(Buffer.from(m.model.sourceBase64,'base64')));checkContext(context);
   if(same){
    // Native acknowledgment keeps App, selection and the bounded upstream undo/redo snapshots.
    baseline=nextBaseline;initializing=false;
    snapshotVersion=dirtyVersion;error=null;if(readOnly)setTextEditReadOnly(true);syncReadOnly();if(!readOnly)setTextEditReadOnly(false);settleTextEditSave();post('initialized',{},context);pending();
    previousSaves.forEach(resolve=>resolve({ok:true}));return;
   }
   const candidate=m.edits[0]?.kind==='candidate'?m.edits[0]:null;
   // Structural upstream ops mutate the session archive (including undo/redo).
   // Keep the native baseline independent so candidate manifests compare with
   // the original File even before the first native save acknowledgment.
   const opened=await openPptx(new Uint8Array(Buffer.from(candidate?.base64??m.model.sourceBase64,'base64')));checkContext(context);
   previousSaves.forEach(resolve=>resolve({ok:false,error:'PPTX 编辑内容已替换'}));previousSaves=[];
   abandonTextEdit();root.render(null);
   dirtyVersion=0;snapshotVersion=0;error=null;activeInput=false;composing=false;
   setTextEditReadOnly(readOnly);setTextEditComposing(false);baseline=nextBaseline;
   const created=createParitySession(opened,{metrics:browserFontMetrics,emit:(name,payload)=>{if(session===created&&!initializing)emit(name,payload)},onCommand:()=>{if(session===created&&!initializing){dirtyVersion++;activeInput=false;pending();scheduleSnapshot()}},confirmChart:async message=>confirm(message)});
   session=created;
   for(const e of m.edits){if(e.kind==='candidate')continue;if(e.kind!=='command')throw new Error('PPTX 编辑会话必须以新基线打开');await created.invoke(e.name,e.args);checkContext(context)}
   initializing=false;
   session.setReadOnly(readOnly);
   root.render(<LocaleProvider key={++generation} initial="zh"><App/></LocaleProvider>);
   syncReadOnly();post('initialized',{},context);pending();
  }catch(e){previousSaves.forEach(resolve=>resolve({ok:false,error:'PPTX 编辑内容已替换'}));if(context===epoch){initializing=false;post('error',{message:e instanceof Error?e.message:String(e)},context)}}
 }else if(m.type==='readonly'){setPptxPresentationMode(m.presentationMode??'edit');readOnly=m.presentationMode==='preview'||m.readOnly;if(readOnly)setTextEditReadOnly(true);syncReadOnly();if(!readOnly)setTextEditReadOnly(false)}
 else if(m.type==='capture-selection'||m.type==='apply-selection'){
  try{
   assertSelectionReady();if(busy)throw Error('PPTX 编辑器忙，请稍后重试');
   if(m.type==='capture-selection'){
    const selected=livePptxSelection(),slide=session.state.opened.deck.slides[selected.slideIndex];
    const elements=selected.ids.map(id=>slide?.elements.find(e=>e.id===id));
    if(elements.some(e=>!e)||elements.length>256)throw Error('PPTX 选区不可用或超过 256 个元素');
    const selectionId=crypto.randomUUID();
    capturedSelection={selectionId,epoch,version:dirtyVersion,...selected};
    post('selection-done',{requestId:m.requestId,result:{selectionId,text:selectionContext(selected.slideIndex,slide.path,elements as any)}},context);
   }else{
    const captured=capturedSelection;
    if(!captured||m.selectionId!==captured.selectionId||captured.epoch!==epoch||captured.version!==dirtyVersion)throw Error('PPTX 选区已过期，请重新获取');
    // Freeze the document target before awaiting the serialized native operation queue.
    const target=session;
    busy++;pending();
    const operation=queue.then(async()=>{
     checkContext(context);assertSelectionReady();
     if(captured.version!==dirtyVersion)throw Error('PPTX 选区已过期，请重新获取');
     const slide=target.state.opened.deck.slides[captured.slideIndex];
     const elements=captured.ids.map(id=>slide.elements.find(e=>e.id===id)!);
     const ops=selectionOps(m.change,captured.slideIndex,elements);
     if(ops.length)await target.invoke('slides:apply-txn',[{ops,isolation:'atomic'}]);
     checkContext(context);capturedSelection=undefined;
     emit('slides:deck-changed',{slides:await target.invoke('slides:get-render-slides')});
    });
    queue=operation.catch(()=>{}).finally(()=>{if(context===epoch){busy--;pending()}});
    await operation;checkContext(context);await snapshotNow();checkContext(context);
    post('selection-done',{requestId:m.requestId,result:{text:'已更新捕获的幻灯片元素；可撤销并通过 File 保存。'}},context);
   }
  }catch(e){post('selection-done',{requestId:m.requestId,error:e instanceof Error?e.message:String(e)},context)}
 }
 else if(m.type==='flush'||m.type==='output'){
  const reply=m.type==='output'?'output-done':'flushed';
  try{
   if(composing)throw new Error('请先完成中文输入，再保存演示文稿');
   // Shape text uses the original extraction/editText without disposing its live DOM.
   // Other upstream inputs keep their existing commit-and-exit behavior.
   if(!await checkpointTextEdit()){
    checkContext(context);
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
   }
   checkContext(context);await queue;checkContext(context);
   if(error)throw error;
   await snapshotNow();checkContext(context);
   activeInput=false;pending();
   if(m.type==='output'){
    if(!['pdf','images','print'].includes(m.command))throw new Error('未知 PPTX 输出命令');
    await runPptxOutput(m.command);checkContext(context);
   }
   post(reply,{requestId:m.requestId},context);
  }catch(e){post(reply,{requestId:m.requestId,error:e instanceof Error?e.message:String(e)},context)}
 }
}
window.addEventListener('message',event=>{
 if(event.source!==parent||event.data?.source!=='project-mind-pptx-host')return;
 // A ready query must answer over the window: an earlier host effect may
 // already have closed its end of the previous channel.
 if(event.data.type==='ready-request'){parent.postMessage({source:'project-mind-pptx',type:'ready',epoch},'*');return}
 if(event.data.type==='connect'&&event.ports[0]){
  hostChannel?.close();const connection=event.ports[0];hostChannel=connection;
  connection.onmessage=event=>{if(hostChannel===connection)void receiveHost(event.data)};connection.start();
 }
 else if(!hostChannel)void receiveHost(event.data);
});
post('ready');

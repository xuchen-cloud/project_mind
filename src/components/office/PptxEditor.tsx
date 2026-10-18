import {useEffect,useRef,useState} from 'react';
import {parityHtml} from '../../../packages/office-pptx/dist/browser.mjs';
import type {PptxEdit,PptxModel,PptxOutputDocument} from '../../../packages/office-pptx/types';
import './PptxEditor.css';
export type {PptxEdit,PptxModel,PptxOutputDocument} from '../../../packages/office-pptx/types';
export interface PptxEditorProps {
 model:PptxModel; edits:PptxEdit[]; onChange:(edits:PptxEdit[])=>void; readOnly:boolean;
 registerBeforeSave?:(callback:()=>Promise<void>)=>()=>void;
 onPendingChange?:(pending:boolean)=>void;
 onSaveRequest?:()=>void|Promise<void>;
 onPrint?:(document:PptxOutputDocument)=>Promise<void>;
 onRenderPdf?:(document:PptxOutputDocument)=>Promise<Uint8Array>;
 onExport?:(file:{name:string;mime:string;bytes:Uint8Array})=>Promise<boolean>;
}
/** The upstream renderer runs in its own document: scoped CSS, keyboard and clipboard state. */
export function PptxEditor(props:PptxEditorProps){
 const frame=useRef<HTMLIFrameElement>(null);const latest=useRef(props);latest.current=props;
 const channel=useRef<MessagePort|null>(null);
 const ready=useRef(false);const initialized=useRef(false);
 const initialization=useRef(new Set<{resolve:()=>void;reject:(error:Error)=>void}>());const lastEdits=useRef(props.edits);
 const requests=useRef(new Map<number,{resolve:()=>void;reject:(e:Error)=>void}>());const seq=useRef(0);
 const [error,setError]=useState('');
 const saveFocusPending=useRef(false);
 const epoch=useRef(1),sentEpoch=useRef(0),contextModel=useRef(props.model),mounted=useRef(true);
 // Invalidate synchronously with new props, before an old port callback or Promise
 // microtask can observe the new File's callbacks. Local journal echoes keep context.
 if(contextModel.current!==props.model||props.edits!==lastEdits.current){
  contextModel.current=props.model;lastEdits.current=props.edits;epoch.current++;
  initialized.current=false;saveFocusPending.current=false;
  const reason=new Error('PPTX 编辑内容已替换');
  requests.current.forEach(r=>r.reject(reason));requests.current.clear();
  initialization.current.forEach(r=>r.reject(reason));initialization.current.clear();
 }
 const post=(payload:object)=>{const message={source:'project-mind-pptx-host',epoch:epoch.current,...payload};if(channel.current)channel.current.postMessage(message);else frame.current?.contentWindow?.postMessage(message,'*')};
 const init=()=>{initialized.current=false;if(ready.current){sentEpoch.current=epoch.current;latest.current.onPendingChange?.(true);post({type:'init',model:latest.current.model,edits:latest.current.edits,readOnly:latest.current.readOnly})}};
 const syncTheme=()=>{
  const root=document.documentElement,style=getComputedStyle(root),body=getComputedStyle(document.body);
  const theme=root.dataset.theme??(root.classList.contains('dark')?'dark':style.colorScheme==='dark'?'dark':'light');
  const map:Record<string,string>={'--pm-surface':'--color-bg','--pm-subtle':'--color-bg-subtle','--pm-canvas':'--color-canvas','--pm-text':'--color-text-primary','--pm-muted':'--color-text-secondary','--pm-border':'--color-border','--pm-accent':'--color-accent','--pm-hover':'--color-bg-hover'};
  const tokens:Record<string,string>={'--pm-font':body.fontFamily};
  for(const [target,source] of Object.entries(map)){const value=style.getPropertyValue(source).trim();if(value)tokens[target]=value}
  post({type:'theme',theme,tokens});
 };
 useEffect(()=>{const observer=new MutationObserver(syncTheme);observer.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});observer.observe(document.body,{attributes:true,attributeFilter:['class','style']});return()=>observer.disconnect()},[]);
 useEffect(()=>{
  mounted.current=true;
  const receive=(e:MessageEvent)=>{
   if(e.source!==frame.current?.contentWindow||e.data?.source!=='project-mind-pptx')return;
   const m=e.data;
   if(m.type!=='ready'&&m.epoch!==epoch.current)return;
   const requestEpoch=m.epoch,port=channel.current,origin=frame.current?.contentWindow;
   const valid=()=>mounted.current&&epoch.current===requestEpoch&&channel.current===port&&frame.current?.contentWindow===origin;
   const reply=(payload:object)=>{if(!valid())return;const data={source:'project-mind-pptx-host',epoch:requestEpoch,...payload};if(port)port.postMessage(data);else origin?.postMessage(data,'*')};
   if(m.type==='ready'){ready.current=true;if(window.MessageChannel&&!channel.current){const connection=new window.MessageChannel();channel.current=connection.port1;connection.port1.onmessage=event=>receive({source:frame.current?.contentWindow,data:event.data} as MessageEvent);connection.port1.start();frame.current?.contentWindow?.postMessage({source:'project-mind-pptx-host',type:'connect'},'*',[connection.port2])}init();syncTheme();post({type:'capabilities',export:!!latest.current.onExport,print:!!latest.current.onPrint,renderPdf:!!latest.current.onRenderPdf})}
   else if(m.type==='change'){lastEdits.current=m.edits;latest.current.onChange(m.edits)}
   else if(m.type==='pending')latest.current.onPendingChange?.(m.pending);
   else if(m.type==='error'){setError(m.message);if(m.message){initialization.current.forEach(r=>r.reject(new Error(m.message)));initialization.current.clear()}}
   else if(m.type==='initialized'){saveFocusPending.current=false;initialized.current=true;initialization.current.forEach(r=>r.resolve());initialization.current.clear();setError('')}
   else if(m.type==='render-pdf-request'){
    const handler=latest.current.onRenderPdf;
    if(!handler){post({type:'render-pdf-finished',requestId:m.requestId,error:'PPTX PDF 渲染尚未接入宿主'});return}
    void Promise.resolve().then(()=>valid()?handler(m.document):undefined).then(bytes=>reply({type:'render-pdf-finished',requestId:m.requestId,bytes}),e=>reply({type:'render-pdf-finished',requestId:m.requestId,error:e instanceof Error?e.message:String(e)}));
   }
   else if(m.type==='print-request'){
    const handler=latest.current.onPrint;
    if(!handler){post({type:'print-finished',requestId:m.requestId,error:'PPTX 打印尚未接入宿主'});return}
    void Promise.resolve().then(()=>valid()?handler(m.document):undefined).then(()=>reply({type:'print-finished',requestId:m.requestId}),e=>reply({type:'print-finished',requestId:m.requestId,error:e instanceof Error?e.message:String(e)}));
   }
   else if(m.type==='export-request'){
    const handler=latest.current.onExport;
    if(!handler){post({type:'export-finished',requestId:m.requestId,error:'PPTX 导出尚未接入宿主'});return}
    void Promise.resolve().then(()=>valid()?handler(m.file):undefined).then(ok=>reply({type:'export-finished',requestId:m.requestId,ok}),e=>reply({type:'export-finished',requestId:m.requestId,error:e instanceof Error?e.message:String(e)}));
   }
   else if(m.type==='save-request'){
    if(latest.current.onSaveRequest){try{void Promise.resolve(latest.current.onSaveRequest()).then(()=>reply({type:'save-finished',requestId:m.requestId}),e=>reply({type:'save-finished',requestId:m.requestId,error:e instanceof Error?e.message:String(e)}))}catch(e){reply({type:'save-finished',requestId:m.requestId,error:e instanceof Error?e.message:String(e)})}}
    else {const message='PPTX 保存尚未接入宿主';setError(message);post({type:'save-finished',requestId:m.requestId,error:message})}
   }
   else if(m.type==='flushed'){const req=requests.current.get(m.requestId);requests.current.delete(m.requestId);if(m.error)req?.reject(new Error(m.error));else req?.resolve()}
  };
  window.addEventListener('message',receive);
  return()=>{mounted.current=false;epoch.current++;window.removeEventListener('message',receive);channel.current?.close();channel.current=null;requests.current.forEach(r=>r.reject(new Error('PPTX 编辑器已关闭')));requests.current.clear();initialization.current.forEach(r=>r.reject(new Error('PPTX 编辑器已关闭')));initialization.current.clear();latest.current.onPendingChange?.(false)};
 },[]);
 useEffect(()=>{lastEdits.current=props.edits;init()},[props.model]);
 useEffect(()=>{
  const cancel=()=>{if(saveFocusPending.current){saveFocusPending.current=false;post({type:'cancel-save-focus'})}};
  document.addEventListener('pointerdown',cancel,true);document.addEventListener('keydown',cancel,true);
  return()=>{document.removeEventListener('pointerdown',cancel,true);document.removeEventListener('keydown',cancel,true)};
 },[]);
 useEffect(()=>{if(sentEpoch.current!==epoch.current)init()},[props.edits]);
 useEffect(()=>{if(ready.current)post({type:'capabilities',export:!!props.onExport,print:!!props.onPrint,renderPdf:!!props.onRenderPdf})},[props.onExport,props.onPrint,props.onRenderPdf]);
 useEffect(()=>post({type:'readonly',readOnly:props.readOnly}),[props.readOnly]);
 useEffect(()=>props.registerBeforeSave?.(async()=>{
  if(!ready.current)throw new Error('PPTX 编辑器尚未加载');
  if(!initialized.current)await new Promise<void>((resolve,reject)=>initialization.current.add({resolve,reject}));
  saveFocusPending.current=true;
  await new Promise<void>((resolve,reject)=>{const requestId=++seq.current;requests.current.set(requestId,{resolve,reject});post({type:'flush',requestId})});
 }),[props.registerBeforeSave]);
 return <div className="pptx-editor" aria-label="PowerPoint 编辑器">{error&&<div className="pptx-editor__notice" role="alert">{error}</div>}<iframe ref={frame} allow="clipboard-read; clipboard-write" allowFullScreen title="PPTX 幻灯片编辑画布" srcDoc={parityHtml} className="pptx-editor__frame"/></div>;
}

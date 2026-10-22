import type {EditorProps,MountedEditor,ExportFile,PrintDocument,OutputCommand} from './types'
import './browser.css'
export type {Model,Edit,EditorProps,MountedEditor,OutputCommand,ExportFile,PrintDocument,ScreenSourcesResult,ScreenCaptureRequest,ScreenCaptureResult} from './types'
/** Isolated full GenOffice renderer. File identity, CAS and persistence stay in the host.
 * The dynamic default path prevents host bundlers from emitting a second orphan HTML asset. */
export function mount(container:HTMLElement,initial:EditorProps,rendererUrl=new URL(['.','renderer.html'].join('/'),import.meta.url).href):MountedEditor{
 let props=initial,disposed=false,frame:HTMLIFrameElement,resolveReady:()=>void,rejectReady:((cause:Error)=>void)|undefined,ready:Promise<void>,nextId=0,epoch=0,port:MessagePort|undefined
 const calls=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void}>()
 const appearance=()=>Object.fromEntries(['--color-bg','--color-bg-subtle','--color-canvas','--color-border','--color-text-primary','--color-text-secondary','--color-accent','--font-ui'].map(key=>[key,getComputedStyle(container).getPropertyValue(key)]))
 const data=()=>({model:props.model,edits:props.edits,readOnly:props.readOnly||props.presentationMode==='preview',presentationMode:props.presentationMode??'edit',appearance:appearance()})
 const send=(type:string,value?:unknown,id?:number)=>port?.postMessage({officeXlsx:true,type,value,id})
 function start(){rejectReady?.(Error('Excel 工作簿已切换'));epoch++;port?.close();port=undefined;ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});void ready.catch(()=>{});frame=document.createElement('iframe');frame.title='Excel 完整编辑器';frame.className='office-xlsx-frame';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads allow-modals allow-popups');frame.src=rendererUrl;container.replaceChildren(frame)}
 const receive=(event:MessageEvent,respond?:(message:unknown)=>void)=>{if(disposed||event.source!==frame.contentWindow||event.data?.officeXlsx!==true)return;const{type,value,id}=event.data;const reply=respond??((message:unknown)=>(event.source as Window).postMessage(message,'*'))
  if(type==='bootstrap'){
   // One strictly verified window handshake owns one channel per frame.
   if(port||respond){for(const other of event.ports??[])other.close();return}
   const channel=new MessageChannel(),sender=frame.contentWindow!;port=channel.port1;const connection=port
   connection.onmessage=message=>receive({source:sender,data:message.data} as MessageEvent,response=>connection.postMessage(response));connection.start();sender.postMessage({officeXlsx:true,type:'init',value:data()},'*',[channel.port2]);return
  }
  if(type==='ready')resolveReady()
  if(type==='pending')props.onPendingChange?.(value===true)
  if(type==='change')props.onChange(value)
  if(type==='error'){rejectReady?.(new Error(value));container.dispatchEvent(new CustomEvent('office-error',{detail:value}))}
  if(type==='reply'){const call=calls.get(id);if(!call)return;calls.delete(id);value?.error?call.reject(new Error(value.error)):call.resolve(value?.result)}
  // A model replacement/dispose can occur after delivery and before this
  // microtask. Bind both File ownership and callbacks before scheduling IO.
  const request=(replyType:string,action:(callbacks:EditorProps)=>unknown|Promise<unknown>)=>{
   const owner=epoch,callbacks={...props}
   void Promise.resolve().then(()=>{if(disposed||owner!==epoch)throw Error('Excel 工作簿已切换或关闭');return action(callbacks)}).then(
    result=>reply({officeXlsx:true,type:replyType,id,value:{result}}),
    error=>reply({officeXlsx:true,type:replyType,id,value:{error:String(error.message??error)}}))
  }
  if(type==='renderPdfRequest')request('renderPdfReply',callbacks=>{if(!callbacks.onRenderPdf)throw Error('当前 File 宿主尚未连接 PDF 字节生成');if(!value||typeof value.html!=='string'||value.html.length>20_000_000)throw Error('无效的 PDF 打印文档');return callbacks.onRenderPdf(value)})
  if(type==='calculateRequest')request('calculateReply',callbacks=>{if(!callbacks.onRecalculate)throw Error('此工作簿需要当前 File 的原生只读计算桥');return callbacks.onRecalculate(value)})
  if(type==='inspectImportedRequest')request('inspectImportedReply',callbacks=>{
   if(!callbacks.onInspectImportedWorkbook)throw Error('当前 File 宿主尚未连接外部工作簿只读导入')
   if(!(value instanceof Uint8Array)||!value.byteLength||value.byteLength>64*1024*1024)throw Error('导入 XLSX 超出 64 MiB 字节预算')
   return callbacks.onInspectImportedWorkbook(value)
  })
  if(type==='captureSourcesRequest'||type==='captureSourceRequest')request(type==='captureSourcesRequest'?'captureSourcesReply':'captureSourceReply',async callbacks=>{
   if(type==='captureSourcesRequest'){
    if(!callbacks.onCaptureScreenSources)throw Error('当前 File 宿主尚未连接屏幕来源选择')
    return callbacks.onCaptureScreenSources()
   }
   if(!callbacks.onCaptureScreenSource)throw Error('当前 File 宿主尚未连接屏幕截图')
   if(!value||typeof value.id!=='string'||!value.id||value.id.length>256)throw Error('无效的截图来源标识')
   return callbacks.onCaptureScreenSource({id:value.id})
  })
  if(type==='exportRequest'||type==='printRequest')request(type==='exportRequest'?'exportReply':'printReply',async callbacks=>{
   if(type==='exportRequest'){
    const file=value as ExportFile
    if(!file||typeof file.name!=='string'||!file.name||file.name.length>255||/[\\/]/.test(file.name)||typeof file.mime!=='string'||file.mime.length>127||!(file.bytes instanceof Uint8Array)||file.bytes.byteLength>64*1024*1024)throw Error('无效的 Excel 导出文件')
    if(callbacks.onExport)return await callbacks.onExport(file)
    const url=URL.createObjectURL(new Blob([new Uint8Array(file.bytes)],{type:file.mime})),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return true
   }
   const output=value as PrintDocument
   if(!output||typeof output.html!=='string'||!output.html||output.html.length>20_000_000||(output.title!==undefined&&typeof output.title!=='string'))throw Error('无效的 Excel 打印文档')
   if(callbacks.onPrint){await callbacks.onPrint(output);return}
   await standalonePrint(output)
  })
  if(type==='saveRequest')request('saveReply',callbacks=>{if(!callbacks.onSaveRequest)throw Error('当前 File 宿主尚未连接 Excel 保存回执');return callbacks.onSaveRequest()})

 }
 const receiveWindow=(event:MessageEvent)=>{if(event.data?.type==='bootstrap'||(!port&&event.data?.type==='error'))receive(event)};window.addEventListener('message',receiveWindow);start()
 async function call(type:'commit'|'output'|'captureSelection'|'applySelection',value?:unknown){const owner=epoch;await ready;if(disposed||owner!==epoch)throw Error('Excel 工作簿已切换或关闭');const id=++nextId;return new Promise<any>((resolve,reject)=>{calls.set(id,{resolve,reject});send(type,value,id)})}
 return{captureSelection:()=>call('captureSelection'),applySelection:input=>call('applySelection',input),get ready(){return ready},commitEditing:()=>call('commit'),output(command){if(!['pdf','csv','print'].includes(command))return Promise.reject(Error('未知 Excel 输出命令'));return call('output',command)},
 update(next){const replaced=props.model!==next.model;props=next;if(replaced){for(const call of calls.values())call.reject(Error('Excel 工作簿已切换'));calls.clear();start()}else send('update',{readOnly:props.readOnly||props.presentationMode==='preview',presentationMode:props.presentationMode??'edit',appearance:appearance()})},
 dispose(){disposed=true;epoch++;rejectReady?.(Error('Excel 编辑器已关闭'));window.removeEventListener('message',receiveWindow);port?.close();for(const call of calls.values())call.reject(Error('Excel 编辑器已关闭'));calls.clear();frame.remove()}}
}
export const mountEditor=mount

/** Standalone browser only. Native hosts supply onPrint and own the real dialog. */
async function standalonePrint(output:PrintDocument){
 const paper=document.createElement('iframe');paper.title=output.title??'Excel 打印';paper.style.cssText='position:fixed;width:1px;height:1px;left:-10000px;border:0';paper.srcdoc=output.html
 try{await new Promise<void>(resolve=>{paper.onload=()=>resolve();document.body.append(paper)});const target=paper.contentWindow!,doc=paper.contentDocument!;await doc.fonts.ready;await Promise.all([...doc.images].map(img=>img.decode()));target.focus();target.print()}
 finally{paper.remove()}
}

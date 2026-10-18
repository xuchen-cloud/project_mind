/** Explicit lifecycle acceptance host; the renderer and DOCX serializer are real. */
import {mountFullEditor} from '../full-editor';
import type {DocxModel} from '../types';
const state=window as any;
let model:DocxModel=state.lifecycleInitial??await(await fetch('/model')).json(),file=0;
const events:{file:number;kind:string;value?:unknown}[]=[];
function options(){
  const identity=file;
  return{model,edits:[],onChange:(value:unknown)=>events.push({file:identity,kind:'change',value}),
    onPendingChange:(value:boolean)=>events.push({file:identity,kind:'pending',value}),
    onError:(value:string)=>events.push({file:identity,kind:'error',value}),
    onSaveRequest:async()=>{events.push({file:identity,kind:'save'});},
    onFetchImage:state.lifecycleFetchImage?(url:string)=>state.lifecycleFetchImage(url,identity):undefined,
    onConvertAltChunkHtml:state.lifecycleConvert?(html:string)=>state.lifecycleConvert(html,identity):undefined};
}
const controller=mountFullEditor(document.querySelector('#root')!,options(),'/word-renderer/renderer.html');
state.lifecycle={events,flush:()=>controller.beforeSave?.(),
  replace(next:DocxModel){model=next;file++;controller.update(options());},dispose:()=>controller.destroy()};

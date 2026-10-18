/** Direct full-renderer contract: independent of the app wrapper under integration. */
import {mountFullEditor} from '../full-editor';
import type {DocxModel,Edit} from '../types';
const model:DocxModel=await(await fetch('/model')).json();
let edits:Edit[]=[],mode:'preview'|'edit'='preview',readOnly=false;
const state=window as any;
const errors:string[]=[],pending:boolean[]=[];
const options=()=>({model,edits,presentationMode:mode,readOnly,onChange:(next:Edit[])=>{edits=next;},onExport:state.presentationExport?(file:any)=>state.presentationExport(file):undefined,onError:(value:string)=>errors.push(value),onPendingChange:(value:boolean)=>pending.push(value)});
const host=document.querySelector<HTMLElement>('#root')!;
host.className='office-docx';host.innerHTML='<div class="office-docx__embed"></div>';
const controller=mountFullEditor(host.firstElementChild as HTMLElement,options(),'/word-renderer/renderer.html');
state.presentation={
 set(next:'preview'|'edit',locked=false){mode=next;readOnly=locked;controller.update(options());},
 output:(command:any)=>controller.output(command),
 flush:()=>controller.beforeSave?.(),undo:()=>controller.undo(),redo:()=>controller.redo(),
 edits:()=>edits,errors,pending,dispose:()=>controller.destroy(),
};

if(new URLSearchParams(location.search).has('earlyOutput'))state.firstOutput=controller.output('preview');

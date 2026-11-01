import {mountFullEditor} from '../full-editor';
import type {DocxModel,Edit} from '../types';
const state=window as any,model:DocxModel=await(await fetch('/model')).json();
let edits:Edit[]=[],editRevision=0,savedEditRevision=0;
const errors:string[]=[];
const options=()=>({model,edits,savedEditRevision,presentationMode:'edit' as const,readOnly:false,
 onChange(next:Edit[],snapshot?:{editRevision:number}){edits=next;editRevision=snapshot!.editRevision;controller.update(options());},onError:(message:string)=>errors.push(message)});
const controller=mountFullEditor(document.querySelector<HTMLElement>('#root')!,options(),'/word-renderer/renderer.html');
state.continuous={ready:()=>controller.ready,errors,state:()=>({editRevision,savedEditRevision,dirty:editRevision!==savedEditRevision}),flush:()=>controller.beforeSave?.(),undo:()=>controller.undo(),
 async save(){await controller.beforeSave?.();const captured=editRevision;await state.persistCandidate(edits);savedEditRevision=captured;controller.update(options());}};

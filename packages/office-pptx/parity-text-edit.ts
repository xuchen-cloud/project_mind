/** Save checkpoints keep the upstream contentEditable and its native selection alive. */
import type {RenderSlide,ShapeRenderNode} from '@genoffice/pptx-render';
type Edit={root:HTMLElement;checkpoint:()=>Promise<void>;abandon:()=>void};
type SelectionSnapshot={anchor:Node;anchorOffset:number;focus:Node;focusOffset:number};
let active:Edit|undefined,readOnly=false,composing=false;
let selection:SelectionSnapshot|undefined;
let pointerInside=false;
let saving:{edit:Edit;selection?:SelectionSnapshot;settled:boolean;resume:boolean}|undefined;
const ownText=new WeakMap<object,HTMLElement>();
function currentSelection(root:HTMLElement):SelectionSnapshot|undefined{
 const s=window.getSelection();
 if(s?.anchorNode&&s.focusNode&&root.contains(s.anchorNode)&&root.contains(s.focusNode))return {anchor:s.anchorNode,anchorOffset:s.anchorOffset,focus:s.focusNode,focusOffset:s.focusOffset};
}
export function registerTextEdit(edit:Edit){
 active=edit;selection=currentSelection(edit.root);
 const remember=()=>{const next=currentSelection(edit.root);if(next)selection=next};
 document.addEventListener('selectionchange',remember);
 return ()=>{document.removeEventListener('selectionchange',remember);if(active===edit){active=undefined;selection=undefined}if(saving?.edit===edit)saving=undefined};
}
export function setTextEditComposing(value:boolean){composing=value}
export async function checkpointTextEdit():Promise<boolean>{
 if(!active)return false;
 if(composing)throw new Error('请先完成中文输入，再保存演示文稿');
 if(readOnly)throw new Error('PPTX session is read only');
 if(saving?.edit!==active)saving={edit:active,selection:currentSelection(active.root)??selection,settled:false,resume:true};
 await active.checkpoint();return true;
}
/** Tag only the exact render result of this overlay's own original editText operation. */
export function markTextEditCheckpoint(slide:RenderSlide,sourceId:string){
 const root=active?.root;if(!root)return;
 const visit=(nodes:RenderSlide['nodes'])=>{for(const n of nodes){if(n.sourceId===sourceId&&'text' in n&&n.text)ownText.set(n.text,root);if(n.type==='group')visit(n.children)}};
 visit(slide.nodes);
}
export function consumeTextEditCheckpoint(node:ShapeRenderNode,root:HTMLElement){
 if(!node.text||ownText.get(node.text)!==root)return false;
 ownText.delete(node.text);return true;
}
export function noteTextEditPointer(){pointerInside=true;setTimeout(()=>{pointerInside=false},0);cancelTextEditResume()}
export function keepTextEditOnBlur(to:EventTarget|null){return readOnly||!!saving||(!to&&!pointerInside)}
export function cancelTextEditResume(){if(saving)saving.resume=false}
function finishSave(){
 if(!saving?.settled||readOnly)return;
 const saved=saving;saving=undefined;
 const {root}=saved.edit,s=saved.selection;
 // The receipt must belong to this still-mounted editor. Never recreate an overlay.
 if(!saved.resume||active!==saved.edit||!root.isConnected||root.inert||!s||!root.contains(s.anchor)||!root.contains(s.focus))return;
 root.focus({preventScroll:true});window.getSelection()?.setBaseAndExtent(s.anchor,s.anchorOffset,s.focus,s.focusOffset);
}
export function settleTextEditSave(){if(saving){saving.settled=true;finishSave()}}
export function setTextEditReadOnly(value:boolean){
 const wasReadOnly=readOnly;readOnly=value;
 if(value&&active&&saving?.edit!==active)active.abandon();
 if(!value){if(wasReadOnly&&saving)saving.settled=true;finishSave()}
}
export function abandonTextEdit(){saving=undefined;active?.abandon()}

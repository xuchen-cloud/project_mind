/** Live App selection; registration follows the mounted editor, never DOM hit-testing. */
import {useLayoutEffect,useRef} from 'react';
import type {SlideElement,Paragraph} from './vendor/packages/pptx-engine/src/types';
type Selection={current:number;selectedIds:string[];editing:unknown;editingCell:unknown;enteredGroupId:string|null};
let current:(()=>Selection)|undefined;
export function usePptxSelection(selection:Selection){
 const latest=useRef(selection);latest.current=selection;
 useLayoutEffect(()=>{const get=()=>latest.current;current=get;return()=>{if(current===get)current=undefined}},[]);
}
export function livePptxSelection(){
 if(!current)throw Error('PPTX 编辑器尚未就绪');
 const selection=current();
 if(selection.editing||selection.editingCell||selection.enteredGroupId)throw Error('请先结束文字或组合内部编辑');
 if(!selection.selectedIds.length)throw Error('请先选择幻灯片元素');
 return {slideIndex:selection.current,ids:[...selection.selectedIds]};
}
export function selectionContext(slideIndex:number,slidePath:string,elements:SlideElement[]){
 return JSON.stringify({format:'pptx',slideIndex,slidePath,geometryUnits:'EMU (914400 per inch), slide coordinates',changeSchema:'{elements:[{id,text?,x?,y?,width?,height?}]} — only captured ids; maximum 256 elements / 50 native operations (text and geometry each count as one)',elements:elements.map(e=>({id:e.id,type:e.type,...(('text'in e&&e.text)?{text:e.text.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n')} : {}),x:e.transform.offset.x,y:e.transform.offset.y,width:e.transform.offset.cx,height:e.transform.offset.cy}))});
}
/** Trace retained prefix/suffix runs through native setText so emphasis is not flattened. */
function replacementParagraphs(text:string,old:Paragraph[]){
 return text.split('\n').map((value,pi)=>{
  const paragraph=old[pi];
  if(!paragraph)return {runs:[{text:value}]};
  const previous=paragraph.runs.map(r=>r.text).join('');
  let prefix=0,suffix=0;
  while(prefix<previous.length&&prefix<value.length&&previous[prefix]===value[prefix])prefix++;
  while(suffix<previous.length-prefix&&suffix<value.length-prefix&&previous[previous.length-1-suffix]===value[value.length-1-suffix])suffix++;
  const runs:Array<{text:string;srcRun:number}>=[];
  const append=(text:string,srcRun:number)=>{if(!text)return;const last=runs.at(-1);if(last?.srcRun===srcRun)last.text+=text;else runs.push({text,srcRun})};
  const retain=(start:number,end:number)=>{let offset=0;paragraph.runs.forEach((run,ri)=>{append(run.text.slice(Math.max(0,start-offset),Math.max(0,Math.min(run.text.length,end-offset))),ri);offset+=run.text.length})};
  retain(0,prefix);
  let offset=0,template=Math.max(0,paragraph.runs.length-1);
  for(let ri=0;ri<paragraph.runs.length;ri++){offset+=paragraph.runs[ri].text.length;if(prefix<offset){template=ri;break}}
  append(value.slice(prefix,value.length-suffix),template);
  retain(previous.length-suffix,previous.length);
  return {srcPara:pi,runs:runs.length?runs:[{text:'',srcRun:0}]};
 });
}
export function selectionOps(change:unknown,slideIndex:number,elements:SlideElement[]){
 if(!change||typeof change!=='object'||Array.isArray(change)||Object.keys(change).some(k=>k!=='elements'))throw Error('PPTX 修改必须包含 elements 数组');
 const edits=(change as {elements?:unknown}).elements;
 if(!Array.isArray(edits)||!edits.length||edits.length>256)throw Error('PPTX 修改需要 1–256 个元素');
 const seen=new Set<string>(),ops:any[]=[];
 for(const edit of edits){
  if(!edit||typeof edit!=='object'||Array.isArray(edit)||Object.keys(edit).some(k=>!['id','text','x','y','width','height'].includes(k)))throw Error('PPTX 元素修改字段无效');
  const el=elements.find(e=>e.id===edit.id);
  if(!el||seen.has(edit.id))throw Error('PPTX 修改超出捕获选区或包含重复元素');
  seen.add(edit.id);
  const target={slide:slideIndex,el:el.id};
  if('text'in edit){
   if(typeof edit.text!=='string'||edit.text.length>100000||!('text'in el)||!el.text||!['shape','text'].includes(el.type))throw Error('PPTX 元素不支持此文字修改');
   // Original setText mapping carries paragraph/run formatting; unchanged rich text is untouched.
   const old=el.text.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n');
   if(edit.text!==old)ops.push({op:'setText',target,paragraphs:replacementParagraphs(edit.text,el.text.paragraphs)});
  }
  const keys=['x','y','width','height'] as const;
  if(keys.some(k=>k in edit)){
   for(const k of keys)if(k in edit&&(!Number.isSafeInteger(edit[k])||Math.abs(edit[k])>2147483647||((k==='width'||k==='height')&&edit[k]<=0)))throw Error('PPTX 位置和尺寸必须为有效整数 EMU');
   const o=el.transform.offset;
   ops.push({op:'setTransform',target,box:{x:edit.x??o.x,y:edit.y??o.y,cx:edit.width??o.cx,cy:edit.height??o.cy},rotDeg:(el.transform.rot??0)/60000,flipH:el.transform.flipH,flipV:el.transform.flipV});
  }
  if(!('text'in edit)&&!keys.some(k=>k in edit))throw Error('PPTX 元素没有修改内容');
 }
 if(ops.length>50)throw Error('PPTX 单次修改最多 50 个原生操作，请缩小选区');
 return ops;
}

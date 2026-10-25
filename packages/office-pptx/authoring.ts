/** Semantic, targetable native-op context; no archive XML, renderer nodes or media bytes. */
import {elementDurableId,elementSpid,getSlideNotes,getSlideTransition,type OpenedPptx,type Paragraph,type SlideElement} from '@genoffice/pptx-engine';
import {slideDurableId} from './vendor/packages/pptx-ops/src/ops';

function paragraphs(source:Paragraph[]=[]){
 return source.map(p=>({
  runs:p.runs.map(r=>({text:r.text,...(r.fontSize!==undefined?{fontSize:r.fontSize}:{}),...(r.fontFamily?{fontFamily:r.fontFamily}:{}),...(r.color?{color:r.color}:{}),...(r.bold?{bold:true}:{}),...(r.italic?{italic:true}:{}),...(r.underline?{underline:true}:{}),...(r.strike?{strike:true}:{})})),
  ...(p.align?{align:p.align}:{}),...(p.level!==undefined?{level:p.level}:{}),...(p.lineHeight!==undefined?{lineSpacingPct:p.lineHeight}:{}),...(p.spaceBefore!==undefined?{spaceBeforePt:p.spaceBefore}:{}),...(p.spaceAfter!==undefined?{spaceAfterPt:p.spaceAfter}:{}),
 }));
}
const text=(source:Paragraph[]=[])=>(source.map(p=>p.runs.map(r=>r.text).join('')).join('\n'));
export function authoringSummary(opened:OpenedPptx){
 return {size:{...opened.deck.size,unit:'emu' as const},slides:opened.deck.slides.map((slide,slideIndex)=>{
  const visit=(el:SlideElement,group?:string):Record<string,unknown>=>{
   const sourceId=elementDurableId(el)??(elementSpid(el)===null?null:`e_${elementSpid(el)}`);
   const common={type:el.type,...(sourceId?{sourceId,target:{slide:slideIndex,el:sourceId},...(group?{group}:{} )}:{readOnly:true}),...(el.name?{name:el.name}:{}),box:{...el.transform.offset,rotDeg:el.transform.rot/60000,unit:'emu',coordinateSpace:group?'group-local':'slide'}};
   if(el.type==='text'||el.type==='shape')return {...common,text:text(el.text?.paragraphs),paragraphs:paragraphs(el.text?.paragraphs)};
   if(el.type==='table')return {...common,table:{rows:el.rows.map(row=>row.map(cell=>({text:text(cell.text?.paragraphs),paragraphs:paragraphs(cell.text?.paragraphs),...(cell.gridSpan?{gridSpan:cell.gridSpan}:{}),...(cell.rowSpan?{rowSpan:cell.rowSpan}:{}),...(cell.merged?{merged:true}:{})}))),colWidthsEmu:el.colWidths,rowHeightsEmu:el.rowHeights,...(el.styleId?{styleId:el.styleId}:{}),...(el.styleFlags?{styleFlags:{...el.styleFlags}}:{})}};
   if(el.type==='chart')return {...common,chart:{kind:el.chart.kind,...(el.chart.title?{title:el.chart.title}:{}),categories:el.chart.categories,series:el.chart.series.map(s=>({name:s.name??'',values:s.values,...(s.xValues?{xValues:s.xValues}:{}),...(s.plotKind?{plotKind:s.plotKind}:{})})),...(el.chart.barDir?{barDir:el.chart.barDir}:{}),...(el.chart.grouping?{grouping:el.chart.grouping}:{})}};
   if(el.type==='group')return {...common,children:el.children.map(child=>visit(child,sourceId??undefined))};
   if(el.type==='passthrough')return {...common,kind:el.kind,readOnly:true};
   return common;
  };
  return {slideIndex,slideId:slideDurableId(slide),target:{slide:slideIndex},notes:getSlideNotes(opened.archive,slide.path)??'',transition:getSlideTransition(slide),elements:slide.elements.map(el=>visit(el))};
 })};
}

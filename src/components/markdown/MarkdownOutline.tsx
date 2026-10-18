import { useMemo, useRef } from 'react';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { HomeSidebarList } from '../home/HomeSidebarList';
import { parseDocText } from '../../../packages/markdown-editor/src/genoffice/markdown/docText';
import { normalizedSource } from '../../../packages/markdown-editor/src/source';

const clampWidth=(width:number)=>Math.max(160,Math.min(480,Math.round(width)));
function headingText(node:Nodes):string {
  if(node.type==='text'||node.type==='inlineCode')return node.value;
  return 'children' in node?node.children.map(child=>headingText(child)).join(''):'';
}
export function MarkdownOutline({value,width,onResize,onJump}:{value:string;width:number;onResize:(width:number)=>void;onJump:(line:number)=>void}) {
  const drag=useRef<{x:number;width:number}|null>(null);
  const headings=useMemo(()=>{
    const envelope=parseDocText(normalizedSource(value));const offset=envelope.frontmatter.split('\n').length-1;
    const items:{level:number;text:string;line:number}[]=[];
    const visit=(node:Nodes)=>{
      if(node.type==='heading'){
        const text=headingText(node).replace(/\s+/gu,' ').trim();
        if(text)items.push({level:node.depth,text,line:(node.position?.start.line??1)+offset});
      }else if('children' in node)node.children.forEach(child=>visit(child));
    };
    visit(fromMarkdown(envelope.body));return items;
  },[value]);
  return <>
    <aside className="mind-markdown__outline" aria-label="文档大纲" style={{width:clampWidth(width)}}>
      <h3>文档大纲</h3>
      <HomeSidebarList label="Markdown 大纲">{headings.length?headings.map(item=><button key={item.line} type="button" style={{paddingInlineStart:8+(item.level-1)*12}} onClick={()=>onJump(item.line)}>{item.text}</button>):<p>还没有标题</p>}</HomeSidebarList>
    </aside>
    <div className="mind-markdown__outline-resizer" role="separator" tabIndex={0} aria-label="调整大纲宽度" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={480} aria-valuenow={clampWidth(width)}
      onPointerDown={event=>{if(event.button!==0)return;drag.current={x:event.clientX,width:clampWidth(width)};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();}}
      onPointerMove={event=>{if(drag.current)onResize(clampWidth(drag.current.width+event.clientX-drag.current.x));}}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
      onKeyDown={event=>{
        const next=event.key==='ArrowRight'?width+16:event.key==='ArrowLeft'?width-16:event.key==='Home'?160:event.key==='End'?480:undefined;
        if(next!==undefined){event.preventDefault();onResize(clampWidth(next));}
      }}/>
  </>;
}

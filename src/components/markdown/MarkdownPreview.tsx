import { useEffect, useMemo, useRef } from 'react';
import { SafeMarkdownPreview } from '../../../packages/markdown-editor/src/adapters/SafeMarkdownPreview';
import { safeImage } from '../../../packages/markdown-editor/src/adapters/localImage';
import { withResolvedMarkdownImages, markdownImageReferences } from '../../../packages/dsh-ui/preview/resources.mjs';
import { watchEdges } from './scrollEdges';
import { parseDocText } from '../../../packages/markdown-editor/src/genoffice/markdown/docText';
export function MarkdownPreview({value,resources,documentKey,zoom,scrollTop,onScroll}:{value:string;resources:Record<string,string>;documentKey?:string|number;zoom:number;scrollTop?:number;onScroll:(top:number)=>void}) {
  const frame=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null);
  const prepared=useMemo(()=>{const resolved={...resources};for(const reference of markdownImageReferences(value)){if(safeImage(reference))resolved[reference]=reference;}return {text:withResolvedMarkdownImages(parseDocText(value).body,resolved),resources:resolved};},[value,resources]);
  useEffect(()=>{if(!viewport.current||!frame.current)return;if(scrollTop!==undefined)viewport.current.scrollTop=scrollTop;return watchEdges(viewport.current,frame.current);},[]);
  return <div ref={frame} className="mind-markdown__preview-frame mind-markdown__edges"><div ref={viewport} className="mind-markdown__preview" onScroll={event=>onScroll(event.currentTarget.scrollTop)}><article style={{fontSize:`${16*zoom/100}px`}}><SafeMarkdownPreview key={documentKey} text={prepared.text} resources={Object.fromEntries(Object.values(prepared.resources).map(value=>[value,value]))}/></article></div></div>;
}

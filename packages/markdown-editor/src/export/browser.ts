import { toCanvas } from 'html-to-image';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import DOMPurify from 'dompurify';
import { exportDocxBytes } from './upstream-docx.mjs';
import { decodeImageDataUrl, toDocxImage } from '../genoffice/export/exportImage';
import { diagramSvgToPng, renderDiagram } from '../genoffice/editor/diagrams';
import type { ExportDocument } from './document';
import { embedPrintDocument, type MarkdownPrintHandler, type MarkdownPdfRenderer } from './document';

export type MarkdownExportFormat='docx'|'docs'|'pdf'|'png'|'print';
export interface MarkdownExportFile {name:string;mime:string;bytes:Uint8Array}
export type MarkdownExportWriter=(file:MarkdownExportFile)=>Promise<boolean>;
const A4_WIDTH=794,A4_HEIGHT=1123,MARGIN=48,CONTENT_HEIGHT=A4_HEIGHT-2*MARGIN;
export function downloadMarkdownExport(bytes:Uint8Array,name:string,mime:string){
  const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:mime}));const anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.append(anchor);
  try{anchor.click();}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
export async function preparePrintFrame(html:string):Promise<HTMLIFrameElement>{
  const frame=document.createElement('iframe');frame.title='Markdown 打印准备';frame.dataset.markdownPrint='preparing';frame.style.cssText=`position:fixed;left:-100000px;top:0;width:${A4_WIDTH}px;height:${A4_HEIGHT}px;border:0;pointer-events:none`;
  // The document contains sanitized editor output and resolved image bytes, never source HTML scripts.
  frame.srcdoc=html.replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src 'self' data: blob:; style-src 'unsafe-inline'; base-uri 'self'">`);
  try{
    await new Promise<void>((resolve,reject)=>{frame.onload=()=>resolve();frame.onerror=()=>reject(Error('打印文档加载失败。'));document.body.append(frame);});
    const doc=frame.contentDocument;if(!doc)throw Error('打印文档无法访问。');
    await doc.fonts?.ready;
    await Promise.all(Array.from(doc.images).map(image=>image.decode()));
    frame.dataset.markdownPrint='ready';return frame;
  }catch(error){frame.remove();throw error;}
}
async function printDocument(frame:HTMLIFrameElement,signal:AbortSignal){
  const win=frame.contentWindow;if(!win)throw Error('打印窗口无法访问。');
  await new Promise<void>((resolve,reject)=>{
    const finish=()=>{signal.removeEventListener('abort',cancel);resolve();};
    const cancel=()=>{win.removeEventListener('afterprint',finish);reject(new DOMException('已取消','AbortError'));};
    win.addEventListener('afterprint',finish,{once:true});signal.addEventListener('abort',cancel,{once:true});
    try{win.focus();win.print();}catch(error){win.removeEventListener('afterprint',finish);signal.removeEventListener('abort',cancel);reject(error);}
  });
}
function lineIntervals(content:HTMLElement):{top:number;bottom:number}[]{
  const origin=content.getBoundingClientRect().top;const intervals:{top:number;bottom:number}[]=[];
  const walker=content.ownerDocument.createTreeWalker(content,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
    if(!walker.currentNode.textContent?.trim())continue;
    const range=content.ownerDocument.createRange();range.selectNodeContents(walker.currentNode);
    for(const rect of Array.from(range.getClientRects()))if(rect.height)intervals.push({top:rect.top-origin,bottom:rect.bottom-origin});
  }
  for(const block of content.querySelectorAll('img,svg,tr,.katex-display')){const rect=block.getBoundingClientRect();if(rect.height<=CONTENT_HEIGHT)intervals.push({top:rect.top-origin,bottom:rect.bottom-origin});}
  return intervals;
}
async function rasterPages(frame:HTMLIFrameElement,signal:AbortSignal,onProgress:(message:string)=>void):Promise<Uint8Array[]>{
  const doc=frame.contentDocument!;const page=doc.createElement('div');const crop=doc.createElement('div');const content=doc.createElement('div');
  while(doc.body.firstChild)content.append(doc.body.firstChild);
  doc.body.style.cssText='margin:0;width:794px';page.style.cssText=`width:${A4_WIDTH}px;height:${A4_HEIGHT}px;padding:${MARGIN}px;background:white;overflow:hidden`;
  crop.style.cssText=`height:${CONTENT_HEIGHT}px;overflow:hidden`;crop.append(content);page.append(crop);doc.body.append(page);
  const sizeRules=doc.createElement('style');sizeRules.textContent=`img, .md-diagram-preview svg {max-height:${CONTENT_HEIGHT-16}px;object-fit:contain} p:first-child, h1:first-child, h2:first-child {margin-top:0}`;doc.head.append(sizeRules);
  const height=Math.max(content.scrollHeight,content.getBoundingClientRect().height);const lines=lineIntervals(content);const pngs:Uint8Array[]=[];
  const fontEmbedCSS=await (await import('html-to-image')).getFontEmbedCSS(page);
  let offset=0;
  do{
    signal.throwIfAborted();let end=Math.min(height,offset+CONTENT_HEIGHT);
    // Keep a line, table row, formula or picture intact where it fits on one page.
    if(end<height){let previous;do{previous=end;for(const line of lines)if(line.top<end&&line.bottom>end&&line.top>offset+1)end=Math.min(end,line.top);}while(end!==previous);}
    content.style.transform=`translateY(-${offset}px)`;crop.style.height=`${Math.max(1,end-offset)}px`;
    onProgress(`正在生成第 ${pngs.length+1} 页…`);
    const canvas=await toCanvas(page,{pixelRatio:2,width:A4_WIDTH,height:A4_HEIGHT,fontEmbedCSS,backgroundColor:'#ffffff',skipAutoScale:false});
    try{
      const data=canvas.toDataURL('image/png');const binary=atob(data.slice(data.indexOf(',')+1));pngs.push(Uint8Array.from(binary,char=>char.charCodeAt(0)));
    }finally{canvas.width=canvas.height=0;}
    offset=end;
  }while(offset<height);
  return pngs;
}
export async function deliverMarkdownExport(document:ExportDocument,format:MarkdownExportFormat,signal:AbortSignal,onProgress:(message:string)=>void,onExport?:MarkdownExportWriter,onPrint?:MarkdownPrintHandler,onRenderPdf?:MarkdownPdfRenderer):Promise<string>{
  signal.throwIfAborted();
  async function save(bytes:Uint8Array,name:string,mime:string){signal.throwIfAborted();if(onExport)return onExport({bytes,name,mime});downloadMarkdownExport(bytes,name,mime);return true;}
  if(format==='docx'||format==='docs'){
    const bytes=await exportDocxBytes(document.json,async source=>{const data=decodeImageDataUrl(document.images[source]??'');return data?toDocxImage(data,620):null;},async(source,language)=>{const diagram=await renderDiagram(language,source);const image=diagram.ok?await diagramSvgToPng(DOMPurify.sanitize(diagram.svg,{USE_PROFILES:{svg:true,svgFilters:true}}),620):null;return image?{...image,mime:'image/png'}:null;});
    if(!await save(bytes,`${document.title}.docx`,'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))return '已取消导出。';
    return format==='docs'?'已导出转换后的 Word 文档，可在 Word 编辑器打开。':'已导出 Word 文档。';
  }
  if(format==='print'&&onPrint){const prepared=await embedPrintDocument(document);signal.throwIfAborted();await onPrint(prepared);return '已提交系统打印。';}
  if(format==='pdf'&&onRenderPdf){
    const prepared=await embedPrintDocument(document);signal.throwIfAborted();
    const bytes=await onRenderPdf(prepared);signal.throwIfAborted();
    if(!await save(bytes,`${document.title}.pdf`,'application/pdf'))return '已取消导出。';
    return '已导出 PDF 文档。';
  }
  const frame=await preparePrintFrame(document.html);
  try{
    signal.throwIfAborted();
    if(format==='print'){await printDocument(frame,signal);return '打印已结束。';}
    const pages=await rasterPages(frame,signal,onProgress);signal.throwIfAborted();
    if(format==='pdf'){
      const pdf=await PDFDocument.create();pdf.setTitle(document.title);
      for(const bytes of pages){const image=await pdf.embedPng(bytes);const page=pdf.addPage([595.28,841.89]);page.drawImage(image,{x:0,y:0,width:595.28,height:841.89});}
      const bytes=await pdf.save();if(!await save(bytes,`${document.title}.pdf`,'application/pdf'))return '已取消导出。';
    }else if(pages.length===1){if(!await save(pages[0],`${document.title}.png`,'image/png'))return '已取消导出。';}
    else{const zip=new JSZip();pages.forEach((bytes,index)=>zip.file(`${document.title}-${String(index+1).padStart(3,'0')}.png`,bytes));const bytes=await zip.generateAsync({type:'uint8array'});if(!await save(bytes,`${document.title}-图片.zip`,'application/zip'))return '已取消导出。';}
    return `已导出 ${pages.length} 页${format==='pdf'?' PDF':'图片'}。`;
  }finally{frame.remove();}
}

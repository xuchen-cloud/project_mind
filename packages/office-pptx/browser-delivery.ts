import JSZip from 'jszip';
import {PDFDocument,PDFName,PDFString,PDFArray} from 'pdf-lib';
import {buildPrintDocumentHtml} from './vendor/apps/slides/src/shared/print-html';
import {buildPdfExportHtml} from './parity-pdf.mjs';
import type {PptxOutputDocument,PptxPageSize} from './types';
type ExportFile={name:string;mime:string;bytes:Uint8Array};
let printSink:((document:PptxOutputDocument)=>Promise<void>)|undefined;
export function setPrintSink(sink:typeof printSink){printSink=sink}
let renderPdfSink:((document:PptxOutputDocument)=>Promise<Uint8Array>)|undefined;
export function setRenderPdfSink(sink:typeof renderPdfSink){renderPdfSink=sink}
let exportSink:((file:ExportFile)=>Promise<boolean>)|undefined;
export function setExportSink(sink:typeof exportSink){exportSink=sink}
async function download(bytes:BlobPart|Uint8Array,name:string,type:string):Promise<boolean>{
 const data=bytes instanceof Uint8Array?new Uint8Array(bytes):new Uint8Array(await new Blob([bytes]).arrayBuffer());
 if(exportSink)return exportSink({name,mime:type,bytes:data});
 const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;
}
async function pngOf(page:{svg?:string;png?:string},width:number,height:number,fontCss=''):Promise<Uint8Array>{
 if(page.png)return new Uint8Array(Buffer.from(page.png,'base64'));
 const svg=page.svg!.replace(/<svg([^>]*)>/,`<svg$1><style>${fontCss}</style>`),url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
 try{const img=new Image();await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('SVG export rendering failed'));img.src=url});const canvas=document.createElement('canvas');canvas.width=Math.round(width*2);canvas.height=Math.round(height*2);const ctx=canvas.getContext('2d')!;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);return new Uint8Array(Buffer.from(canvas.toDataURL('image/png').split(',')[1],'base64'))}finally{URL.revokeObjectURL(url)}
}
export async function deliver(name:string,args:any[],slidePageSize?:PptxPageSize):Promise<any>{
 if(name==='slides:pick-export-dir')return '下载';
 if(name==='slides:pick-export-pdf-path')return args[0]??'presentation.pdf';
 if(name==='slides:save-picture'){const op=args[0];const path=`${op.defaultName||'picture'}.png`;const ok=await download(Buffer.from(op.pngBase64,'base64'),path,'image/png');return {ok,path,...(!ok?{canceled:true}:{})}}
 if(name==='slides:export-images'){const op=args[0],zip=new JSZip(),paths=op.pngsBase64.map((b64:string,i:number)=>{const path=`${op.baseName}-${String(i+1).padStart(2,'0')}.png`;zip.file(path,b64,{base64:true});return path});const ok=await download(await zip.generateAsync({type:'uint8array'}),`${op.baseName}-slides.zip`,'application/zip');return {ok,paths,...(!ok?{canceled:true}:{})}}
 if(name==='slides:export-pdf'){
  const op=args[0];
  const pageSize=slidePageSize??{widthPt:op.widthPx*.75,heightPt:op.heightPx*.75};
  if(renderPdfSink){
   const html=buildPdfExportHtml(op.pages,pageSize.widthPt/72,pageSize.heightPt/72,op.links,op.fontCss);
   const bytes=await renderPdfSink({html,title:op.filePath,pageSize});
   const ok=await download(bytes,op.filePath,'application/pdf');return {ok,path:op.filePath,...(!ok?{canceled:true}:{})};
  }
  const doc=await PDFDocument.create(),width=pageSize.widthPt,height=pageSize.heightPt;
  for(const page of op.pages){const pdfPage=doc.addPage([width,height]);const png=await doc.embedPng(await pngOf(page,op.widthPx,op.heightPx,op.fontCss));pdfPage.drawImage(png,{x:0,y:0,width,height})}
  op.links?.forEach((links:any[],i:number)=>{const page=doc.getPage(i);for(const link of links){const dest=/^#pg(\d+)$/.exec(link.href);const annotation=doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[link.x*width,(1-link.y-link.h)*height,(link.x+link.w)*width,(1-link.y)*height],Border:[0,0,0],...(dest?{Dest:[doc.getPage(Number(dest[1])-1).ref,PDFName.of('Fit')]}:{A:{Type:'Action',S:'URI',URI:PDFString.of(link.href)}})});let annots=page.node.lookup(PDFName.of('Annots'),PDFArray);if(!annots){annots=doc.context.obj([]);page.node.set(PDFName.of('Annots'),annots)}annots.push(doc.context.register(annotation))}});
  const ok=await download(await doc.save(),op.filePath,'application/pdf');return {ok,path:op.filePath,...(!ok?{canceled:true}:{})};
 }
 if(name==='slides:print'){
  const op=args[0],layout=op.layout??'full';
  // Handouts/notes use the pinned template's 8.27 × 11.69in A4 paper;
  // full pages use the physical deck size, never the fitted Canvas viewport.
  const pageSize=layout==='full'?(slidePageSize??{widthPt:op.widthPx*.75,heightPt:op.heightPx*.75}):op.orientation==='landscape'?{widthPt:841.68,heightPt:595.44}:{widthPt:595.44,heightPt:841.68};
  const html=buildPrintDocumentHtml({srcs:op.pngsBase64.map((s:string)=>`data:image/png;base64,${s}`),ratio:op.widthPx/op.heightPx,layout,notes:op.notes,orientation:op.orientation,frame:op.frame}).replace('</style>',`\n@page { size: ${pageSize.widthPt}pt ${pageSize.heightPt}pt; margin: 0; }\n.page { width: ${pageSize.widthPt}pt; height: ${pageSize.heightPt}pt; }\n</style>`);
  // Upstream print pages contain only inline CSS and data-PNGs; all slide fonts are already rasterized.
  if(printSink){await printSink({html,title:'演示文稿',pageSize});return {ok:true}}
  const frame=document.createElement('iframe');frame.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';frame.srcdoc=html;
  await new Promise<void>(resolve=>{frame.onload=()=>resolve();document.body.append(frame)});await Promise.all([...frame.contentDocument!.images].map(img=>img.decode()));frame.contentWindow!.addEventListener('afterprint',()=>frame.remove(),{once:true});frame.contentWindow!.focus();frame.contentWindow!.print();return {ok:true};
 }
 throw new Error(`Unknown browser delivery: ${name}`);
}
export function pickModel():Promise<{bytes:Uint8Array;ext:string;name:string}|null>{return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept='.glb,.gltf';input.onchange=async()=>{const file=input.files?.[0];resolve(file?{bytes:new Uint8Array(await file.arrayBuffer()),ext:file.name.split('.').pop()!.toLowerCase(),name:file.name}:null);input.remove()};input.oncancel=()=>{resolve(null);input.remove()};input.click()})}

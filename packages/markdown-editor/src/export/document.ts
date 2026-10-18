import { Editor, type JSONContent } from '@tiptap/core';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { buildExtensions } from '../genoffice/editor/extensions';
import { LocalImage, safeImage } from '../adapters/localImage';
import { parseDocText } from '../genoffice/markdown/docText';
import { diagramLanguage } from '../genoffice/editor/diagrams';
import { renderSafeDiagram as renderDiagram } from '../adapters/diagramPreviewSafety';
import { buildPrintHtml } from '../genoffice/export/printHtml';
import { decodeImageDataUrl } from '../genoffice/export/exportImage';
import { paginateMarkdownPrint } from './paginatePrint';
import { canResolveMarkdownImage } from '../adapters/imageInput';

export interface ExportDocument {title:string;html:string;json:JSONContent;images:Record<string,string>;warnings:string[]}
export interface MarkdownPrintDocument {html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}}
export type MarkdownPrintHandler=(document:MarkdownPrintDocument)=>Promise<void>;
export type MarkdownPdfRenderer=(document:MarkdownPrintDocument)=>Promise<Uint8Array>;
function dataUrl(bytes:Uint8Array,mime:string):string {let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return `data:${mime};base64,${btoa(binary)}`;}
function assertEmbeddedSvg(doc:Document){
  for(const node of doc.querySelectorAll('image, use')){
    const href=node.getAttribute('href')??node.getAttribute('xlink:href')??'';
    if(href&&!/^(?:data:image\/|#)/iu.test(href))throw Error(`打印图表包含不能内嵌的资源：${href}`);
  }
  for(const style of doc.querySelectorAll('style,[style]'))for(const url of (style.getAttribute('style')??style.textContent??'').matchAll(/url\(\s*["']?([^\s"')]+)/gu))if(!/^(?:data:|#)/u.test(url[1]))throw Error(`打印图表包含不能内嵌的资源：${url[1]}`);
}
/** The pinned WaveDrom skin instances local <g>/<path> definitions. WK's
 * sandboxed srcdoc print loses those instances, even with SVG2 href. Inline
 * the same vector geometry; keep text, classes and instance transforms. */
function expandWaveformUses(svg:Element){
  const targets=new Map(Array.from(svg.querySelectorAll('[id]'),node=>[node.id,node]));
  function expand(use:Element,ancestors:Set<Element>):Element{
    const href=use.getAttribute('href')??use.getAttribute('xlink:href')??'';
    const target=href.startsWith('#')?targets.get(href.slice(1)):undefined;
    if(!target)throw Error(`打印波形引用不存在：${href||'空引用'}`);
    if(ancestors.has(target))throw Error(`打印波形包含循环引用：${href}`);
    if(target.localName!=='g'&&target.localName!=='path')throw Error(`打印波形不支持引用元素：${target.localName}`);
    const instance=svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg','g');
    for(const attribute of Array.from(use.attributes))if(!['href','xlink:href','x','y','width','height','id'].includes(attribute.name))instance.setAttribute(attribute.name,attribute.value);
    const clone=target.cloneNode(true) as Element;
    clone.removeAttribute('id');for(const node of clone.querySelectorAll('[id]'))node.removeAttribute('id');
    const next=new Set(ancestors);next.add(target);
    for(const nested of clone.querySelectorAll('use'))nested.replaceWith(expand(nested,next));
    const x=use.getAttribute('x'),y=use.getAttribute('y');
    if(x||y){const offset=svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg','g');offset.setAttribute('transform',`translate(${x??0} ${y??0})`);offset.append(clone);instance.append(offset);}
    else instance.append(clone);
    return instance;
  }
  for(const use of svg.querySelectorAll('use'))use.replaceWith(expand(use,new Set()));
}
/** Native print WebViews allow inline CSS and data resources, with no app asset/network access. */
export async function embedPrintDocument(exported:ExportDocument):Promise<MarkdownPrintDocument>{
  const doc=new DOMParser().parseFromString(exported.html,'text/html');doc.querySelector('base')?.remove();
  // The upstream template leaves paper selection to Electron. Give the native
  // host the same explicit physical A4 dimensions as this standalone document.
  const paper={widthMm:210,heightMm:297};
  const pageStyle=doc.createElement('style');pageStyle.textContent=`@page { size: ${paper.widthMm}mm ${paper.heightMm}mm; }`;doc.head.append(pageStyle);
  if(exported.warnings.some(warning=>warning.startsWith('图片')))throw Error(exported.warnings.filter(warning=>warning.startsWith('图片')).join(' '));
  for(const image of doc.querySelectorAll('img')){
    const src=image.getAttribute('src')??'';if(!/^data:image\//iu.test(src))throw Error(`打印图片不能内嵌：${image.alt||src||'未知图片'}`);
    const data=decodeImageDataUrl(src);
    if(data?.mime==='image/svg+xml'){const svg=new TextDecoder().decode(Uint8Array.from(atob(data.base64),char=>char.charCodeAt(0)));assertEmbeddedSvg(new DOMParser().parseFromString(svg,'image/svg+xml'));}
  }
  for(const svg of doc.querySelectorAll('svg')){
    assertEmbeddedSvg(new DOMParser().parseFromString(svg.outerHTML,'image/svg+xml'));
    if(svg.classList.contains('WaveDrom'))expandWaveformUses(svg);
  }
  const embedded=new Map<string,string>();
  for(const style of doc.querySelectorAll('style')){
    let css=style.textContent??'';
    if(css.includes('KaTeX')&&!doc.querySelector('.katex')){style.remove();continue;}
    const faces=Array.from(css.matchAll(/@font-face\s*\{[^}]*\}/gu));
    for(const face of faces){
      const source=/src\s*:\s*([^;}]*)/u.exec(face[0]);if(!source)continue;
      // WKWebView supports WOFF2; avoid embedding unused TTF/WOFF alternatives as well.
      const url=/url\((?:"([^"]+)"|'([^']+)'|([^\s)]+))\)\s*format\(["']woff2["']\)/u.exec(source[1]);
      if(!url)throw Error('打印字体缺少可内嵌的 WOFF2 字体。');
      const authored=url[1]??url[2]??url[3];let data=embedded.get(authored);
      if(!data){
        if(/^data:font\//u.test(authored))data=authored;
        else{
          const resolved=new URL(authored,document.baseURI);if(resolved.origin!==location.origin)throw Error(`打印字体不能内嵌：${authored}`);
          try{const response=await fetch(resolved.href);if(!response.ok)throw Error(`HTTP ${response.status}`);data=dataUrl(new Uint8Array(await response.arrayBuffer()),'font/woff2');}
          catch(error){throw Error(`打印字体不能内嵌：${authored}（${error instanceof Error?error.message:String(error)}）`);}
        }
        embedded.set(authored,data);
      }
      css=css.replace(face[0],face[0].replace(source[0],`src:url("${data}") format("woff2")`));
    }
    // Fragment references belong to inline SVG definitions, not external resources.
    for(const url of css.matchAll(/url\(\s*["']?([^\s"')]+)/gu))if(!/^(?:data:|#)/u.test(url[1]))throw Error(`打印样式包含不能内嵌的资源：${url[1]}`);
    style.textContent=css;
  }
  return {title:exported.title,pageSize:{widthPt:paper.widthMm*72/25.4,heightPt:paper.heightMm*72/25.4},html:await paginateMarkdownPrint('<!doctype html>\n'+doc.documentElement.outerHTML,paper)};
}
export async function prepareExportDocument(value:string,resources:Record<string,string>,resolveResource?:((source:string)=>Promise<string|undefined>)):Promise<ExportDocument>{
  const warnings:string[]=[];const images:Record<string,string>={};
  const editor=new Editor({element:null,editable:false,extensions:buildExtensions({slashController:{onOpen(){},onUpdate(){},onClose(){},onKeyDown:()=>false},slashItems:()=>[]}).map(extension=>extension.name==='image'?LocalImage.configure({resolve:()=>''}):extension),content:parseDocText(value).body,contentType:'markdown'});
  try {
    const json=editor.getJSON();const root=document.createElement('article');root.innerHTML=editor.getHTML();
    const references=new Set<string>();
    function visit(node:JSONContent){
      if(node.type==='image'&&node.attrs?.src)references.add(String(node.attrs.src));
      node.marks=node.marks?.filter(mark=>mark.type!=='link'||!/^\s*(?:javascript|vbscript|data):/iu.test(String(mark.attrs?.href??'')));
      node.content?.forEach(visit);
    }
    visit(json);
    for(const reference of references){
      let url:string|undefined=resources[reference]??(safeImage(reference)?reference:undefined);
      if(!url&&resolveResource&&canResolveMarkdownImage(reference))url=await resolveResource(reference);
      if(url){
        // Only host-authorized bytes or safe raster data can enter a standalone export.
        if(/^data:image\//iu.test(url))images[reference]=url;
        else if(/^blob:/u.test(url)){
          const response=await fetch(url);if(!response.ok)throw Error('无法读取已授权图片。');
          const blob=await response.blob();images[reference]=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('无法读取已授权图片。'));reader.readAsDataURL(blob);});
        }
      }
      if(!images[reference])warnings.push(`图片“${reference.slice(0,80)}”未读取，保留替代文字。`);
    }
    for(const image of root.querySelectorAll<HTMLImageElement>('img')){
      const reference=image.dataset.markdownSrc??image.getAttribute('src')??'';const url=images[reference];
      if(url)image.src=url;else image.replaceWith(document.createTextNode(`[${image.alt||'图片未读取'}]`));
    }
    for(const math of root.querySelectorAll<HTMLElement>('[data-type="inline-math"], [data-type="block-math"]'))math.innerHTML=katex.renderToString(math.dataset.latex??'',{displayMode:math.dataset.type==='block-math',throwOnError:false});
    for(const code of root.querySelectorAll<HTMLElement>('pre > code')){
      const language=diagramLanguage(Array.from(code.classList).find(name=>name.startsWith('language-'))?.slice(9));
      if(!language||!code.textContent?.trim())continue;
      const rendered=await renderDiagram(language,code.textContent);
      if(rendered.ok){const figure=document.createElement('div');figure.className='md-diagram-preview';figure.innerHTML=rendered.svg;code.parentElement!.replaceWith(figure);}
      else warnings.push(`${language} 未渲染，保留代码：${rendered.error}`);
    }
    root.innerHTML=DOMPurify.sanitize(root.innerHTML,{USE_PROFILES:{html:true,svg:true,svgFilters:true,mathMl:true},ADD_TAGS:['use']});
    const heading=root.querySelector('h1,h2,h3,h4,h5,h6')?.textContent??'未命名';
    const title=heading.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,'-').trim().slice(0,100)||'未命名';
    return {title,html:buildPrintHtml(root,title),json,images,warnings};
  } finally {editor.destroy();}
}

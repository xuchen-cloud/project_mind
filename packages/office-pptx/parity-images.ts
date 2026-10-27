import type {RenderSlide,RenderNode,RenderFill} from '@genoffice/pptx-render';
import {createImageLoader} from './vendor/apps/slides/src/renderer/image-loader';

/** Collect only requested layouts; the preview caller supplies visible pages. */
export function slideImageUrls(slides:RenderSlide[]):Set<string>{
 const urls=new Set<string>();
 const fill=(value:RenderFill|undefined)=>{if(value?.kind==='image'&&value.dataUrl)urls.add(value.dataUrl)};
 const text=(value:{lines:{runs:{image?:string}[]}[]}|undefined)=>{for(const line of value?.lines??[])for(const run of line.runs)if(run.image)urls.add(run.image)};
 const walk=(nodes:RenderNode[])=>{for(const node of nodes){
  if(node.type==='picture'&&node.dataUrl)urls.add(node.dataUrl);
  if(node.type==='shape'||node.type==='text'){fill(node.fill);text(node.text)}
  if(node.type==='chart'){fill(node.bgFill);for(const bar of node.bars)fill(bar.fill)}
  if(node.type==='group')walk(node.children);
  if(node.type==='table')for(const cell of node.cells){fill(cell.fill);text(cell.text)}
 }};
 for(const slide of slides){fill(slide.background);walk(slide.nodes)}
 return urls;
}

/** Output consumes every requested page, including media never shown on screen. */
export async function prepareSlideImages(slides:RenderSlide[],current:Map<string,HTMLImageElement>):Promise<Map<string,HTMLImageElement>>{
 const images=new Map(current),urls=slideImageUrls(slides);
 const missing=[...urls].filter(url=>!images.has(url));
 if(!missing.length)return images;
 // Reuse pinned metafile conversion, font synchronization and raster budgets.
 const loader=createImageLoader(entries=>{for(const [url,image] of entries)images.set(url,image)});
 try{
  loader.load(missing);
  while(loader.pending())await new Promise(resolve=>setTimeout(resolve,16));
  if(missing.some(url=>!images.has(url)))throw new Error('PPTX 页面图片无法解码');
  return images;
 }finally{loader.dispose()}
}

/** #212 native PPT driver for packages/genoffice-pptx-validation/complex.original.pptx.
 * Reads upstream layout only; selection is performed through the actual canvas event path.
 */
interface RenderNode {sourceId:string;box:{x:number;y:number;w:number;h:number}}
interface SlidesApi {getRenderSlides():Promise<Array<{widthPx:number;nodes:RenderNode[]}>>}
function rendererDocument(doc:Document):{doc:Document;api:SlidesApi}{
 const api=(doc.defaultView as (Window&{slidesApi?:SlidesApi})|null)?.slidesApi;
 if(api&&doc.querySelector('.stage-rel'))return {doc,api};
 for(const frame of doc.querySelectorAll('iframe')){
  const child=frame.contentDocument;
  const childApi=(child?.defaultView as (Window&{slidesApi?:SlidesApi})|null)?.slidesApi;
  if(child&&childApi&&child.querySelector('.stage-rel'))return {doc:child,api:childApi};
 }
 throw Error('PPTX live iframe/canvas is not ready');
}
export async function selectPptxElement(document:Document):Promise<void>{
 const {doc,api}=rendererDocument(document),win=doc.defaultView!;
 const painted=()=>new Promise<void>(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(()=>resolve())));
 await painted();
 const slides=await api.getRenderSlides(),slide=slides[0],node=slide?.nodes.find(n=>n.sourceId==='e_5');
 if(!node||!(slide.widthPx>0))throw Error('PPTX fixture first-slide text element e_5 is missing');
 const stage=doc.querySelector<HTMLElement>('.stage-rel')!,rect=stage.getBoundingClientRect();
 if(!(rect.width>0&&rect.height>0))throw Error('PPTX canvas has no visible layout');
 // The right/bottom interior avoids opening the native text editor on a glyph.
 // .stage-rel is the actual slide rectangle, excluding Konva canvas bleed.
 const scale=rect.width/slide.widthPx;
 const clientX=rect.left+(node.box.x+node.box.w*.95)*scale;
 const clientY=rect.top+(node.box.y+node.box.h*.9)*scale;
 const target=doc.elementFromPoint(clientX,clientY);
 if(!target||!stage.contains(target)||!target.closest('.konvajs-content'))throw Error('PPTX e_5 canvas target is occluded or not on the active first slide');
 const native=win as unknown as typeof globalThis;
 const mouse=(type:string,buttons:number)=>target.dispatchEvent(new native.MouseEvent(type,{bubbles:true,cancelable:true,view:win,clientX,clientY,button:0,buttons,detail:type==='click'?1:0}));
 const pointer=(type:string,buttons:number)=>target.dispatchEvent(new native.PointerEvent(type,{bubbles:true,cancelable:true,view:win,clientX,clientY,button:0,buttons,pointerId:1,pointerType:'mouse',isPrimary:true}));
 mouse('mousemove',0);pointer('pointerdown',1);mouse('mousedown',1);
 pointer('pointerup',0);mouse('mouseup',0);mouse('click',0);
 await painted();
 if(doc.querySelector('.slide-text-editor'))throw Error('PPTX click entered text editing; selection quote would be unsafe');
 // The caller must click the real quote toolbar; capture there proves the actual selection.
}
export function assertPptxSaved(model:any,marker:string):void{
 if(model?.format!=='pptx'||!Array.isArray(model.textElements))throw Error('Expected native PPTX inspect result');
 const text=(id:string)=>model.textElements.find((element:any)=>element.slideIndex===0&&String(element.cNvPrId)===id)?.text;
 if(!marker||text('5')!==marker)throw Error('Native PPTX e_5 did not persist the exact replacement');
 const witnesses:Record<string,string>={'4':'第一页：项目概况','6':'固定页序标识：PAGE-1','8':'未编辑图片说明：黄方块与白圆。'};
 for(const [id,expected] of Object.entries(witnesses))if(text(id)!==expected)throw Error(`Native PPTX unrelated text witness ${id} changed`);
 const picture=model.pictureElements?.find((element:any)=>element.slideIndex===0&&String(element.cNvPrId)==='7');
 const offset=picture?.transform?.offset;
 if(!offset||offset.x!==731520||offset.y!==2560320||offset.cx!==2926080||offset.cy!==1645920)throw Error('Native PPTX unrelated picture geometry changed');
}

import {useLayoutEffect,useRef} from 'react';
/** Only view coordinates cross a clean-preview eviction, never editor state. */
export interface OfficePreviewView {zoom:number;page?:number;sheetId?:string;scroll:{top:number;left:number}[];sheetScroll?:{sheetViewStartRow:number;sheetViewStartColumn:number;offsetX:number;offsetY:number}}
export interface OfficePreviewAccess {capture():OfficePreviewView;restore(view:OfficePreviewView):Promise<void>}
export type RegisterOfficePreview = (access:OfficePreviewAccess)=>()=>void;
export async function previewAccess(frame:HTMLIFrameElement|null):Promise<OfficePreviewAccess> {
  // Wait for the iframe's useLayoutEffect to set __projectMindOfficePreview.
  // This can take a few frames after the iframe loads, especially on slow machines.
  for (let attempt = 0; attempt < 50; attempt++) {
    const access = (frame?.contentWindow as (Window & {__projectMindOfficePreview?:OfficePreviewAccess})|null)?.__projectMindOfficePreview;
    if (access) return access;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Office 预览视图尚未就绪');
}
export const nextPreviewFrame = () => new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
export function usePreviewView(input:{zoom:number;setZoom:(zoom:number)=>void;page?:number;setPage?:(page:number)=>void;scrollers:()=>Array<HTMLElement|null>}) {
  const latest=useRef(input);latest.current=input;
  useLayoutEffect(()=>{
    const owner=window as Window & {__projectMindOfficePreview?:OfficePreviewAccess};
    const access:OfficePreviewAccess={
      capture(){const value=latest.current;return {zoom:value.zoom,page:value.page,scroll:value.scrollers().map(node=>({top:node?.scrollTop??0,left:node?.scrollLeft??0}))};},
      async restore(view){
        if(view.page!==undefined)latest.current.setPage?.(view.page);
        // Slide navigation can auto-fit. Restore zoom after navigation commits.
        await nextPreviewFrame();if(owner.__projectMindOfficePreview!==access)throw Error('Office 预览已关闭');
        latest.current.setZoom(view.zoom);await nextPreviewFrame();
        if(owner.__projectMindOfficePreview!==access)throw Error('Office 预览已关闭');
        latest.current.scrollers().forEach((node,i)=>{const scroll=view.scroll[i];if(node&&scroll){node.scrollTop=scroll.top;node.scrollLeft=scroll.left;}});
      },
    };
    owner.__projectMindOfficePreview=access;
    return()=>{if(owner.__projectMindOfficePreview===access)delete owner.__projectMindOfficePreview;};
  },[]);
}

import {useEffect,useRef} from 'react';
import {previewAccess,type OfficePreviewView,type RegisterOfficePreview} from '../../../packages/editor-chrome/preview-view';
export interface OfficePreviewProps {initialPreviewView?:OfficePreviewView;registerPreview?:RegisterOfficePreview}
/** Register only after layout and restoration, so a hidden loading frame is not
 * destroyed before its original view has been restored. */
export function useOfficePreview(ready:boolean,frame:()=>HTMLIFrameElement|null,props:OfficePreviewProps,onError:(message:string)=>void) {
  const latest=useRef({frame,props,onError});latest.current={frame,props,onError};
  useEffect(()=>{
    if(!ready||(!props.registerPreview&&!props.initialPreviewView))return;
    let active=true,unregister:(()=>void)|undefined;
    void (async()=>{
      const access=previewAccess(latest.current.frame());
      if(latest.current.props.initialPreviewView)await access.restore(latest.current.props.initialPreviewView);
      if(active)unregister=latest.current.props.registerPreview?.(access);
    })().catch(reason=>{if(active)latest.current.onError(reason instanceof Error?reason.message:String(reason));});
    return()=>{active=false;unregister?.();};
  },[ready,props.registerPreview,props.initialPreviewView]);
}

import { useEffect, useMemo, useState } from 'react';
import { markdownImageReferences } from '../../../packages/dsh-ui/preview/resources.mjs';
import { canResolveMarkdownImage } from '../../../packages/markdown-editor/src/adapters/imageInput';
import { getErrorMessage } from '../../lib/errors';

/** Relative resources require a host grant; the editor never opens file paths or remote URLs. */
export function useDraftResources(value:string,resources:Record<string,string>,documentKey:string|number|undefined,resolveResource:((reference:string)=>Promise<string|undefined>)|undefined,onError:(message:string)=>void) {
  const requests=useMemo(()=>new Map<string,Promise<string|undefined>>(),[documentKey,resolveResource]);
  const [resolved,setResolved]=useState<{requests:typeof requests;urls:Record<string,string>}>({requests,urls:{}});
  useEffect(()=>{
    if(!resolveResource)return;
    let active=true;
    const references=markdownImageReferences(value).filter(reference=>!resources[reference]&&canResolveMarkdownImage(reference));
    references.forEach(reference=>{
      void (async()=>{
        let request=requests.get(reference);
        if(!request){request=Promise.resolve().then(()=>resolveResource(reference));requests.set(reference,request);}
        try{
          const url=await request;
          if(!url&&requests.get(reference)===request)requests.delete(reference);
          if(active&&url)setResolved(previous=>({requests,urls:{...(previous.requests===requests?previous.urls:{}),[reference]:url}}));
        }catch(reason){
          if(requests.get(reference)===request)requests.delete(reference);
          if(active)onError(`无法读取图片资源：${getErrorMessage(reason)}`);
        }
      })();
    });
    return()=>{active=false;};
  },[value,resources,requests,resolveResource,onError]);
  return useMemo(()=>({...resources,...(resolved.requests===requests?resolved.urls:{})}),[resources,resolved,requests]);
}

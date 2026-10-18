import {useEffect,useSyncExternalStore,type Dispatch,type SetStateAction} from 'react';

let preview=false;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}};
const getSnapshot=()=>preview;
export function setPptxPresentationMode(mode:'preview'|'edit') {
 const next=mode==='preview';
 document.body.dataset.presentationMode=next?'preview':'edit';
 if(preview===next)return;
 preview=next;listeners.forEach(listener=>listener());
}

/** Presentation is a live App prop adapter, independent of document/session epochs. */
export function usePptxPreview(setCurrent:Dispatch<SetStateAction<number>>,total:number) {
 const value=useSyncExternalStore(subscribe,getSnapshot);
 useEffect(()=>{
  if(!value)return;
  const navigate=(event:KeyboardEvent)=>{
   if(event.metaKey||event.ctrlKey||event.altKey||(event.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]'))return;
   const forward=['ArrowRight','ArrowDown','PageDown',' '].includes(event.key);
   const backward=['ArrowLeft','ArrowUp','PageUp'].includes(event.key);
   if(!forward&&!backward&&event.key!=='Home'&&event.key!=='End')return;
   event.preventDefault();event.stopImmediatePropagation();
   setCurrent(current=>Math.max(0,Math.min(total-1,event.key==='Home'?0:event.key==='End'?total-1:current+(forward?1:-1))));
  };
  window.addEventListener('keydown',navigate,true);
  return ()=>window.removeEventListener('keydown',navigate,true);
 },[value,setCurrent,total]);
 return value;
}

import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PptxEditor} from '../../../../src/components/office/PptxEditor';
import type {PptxEdit,PptxModel} from '../../types';
import '../../../../src/styles/app.css';
const model:PptxModel=await(await fetch('/model')).json(),state=window as any;
function Harness(){
 const [edits,setEdits]=useState<PptxEdit[]>([]),[savedEditRevision,setSaved]=useState(0);
 const live=useRef({edits:[] as PptxEdit[],editRevision:0,savedEditRevision:0});live.current.savedEditRevision=savedEditRevision;
 const flush=useRef<()=>Promise<void>>(async()=>{});
 state.continuous={state:()=>({...live.current,dirty:live.current.editRevision!==live.current.savedEditRevision}),flush:()=>flush.current(),
 async save(){await flush.current();const snapshot={...live.current};await state.persistCandidate(snapshot.edits);setSaved(snapshot.editRevision);}};
 return <PptxEditor model={model} edits={edits} savedEditRevision={savedEditRevision} onChange={(next,snapshot)=>{live.current.edits=next;live.current.editRevision=snapshot!.editRevision;setEdits(next)}} readOnly={false} presentationMode="edit" registerBeforeSave={callback=>{flush.current=callback;return()=>{flush.current=async()=>{}}}}/>;
}
document.body.style.margin='0';document.getElementById('root')!.style.height='100dvh';createRoot(document.getElementById('root')!).render(<Harness/>);

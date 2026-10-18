import { useState,useRef,useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { DocxEditor } from '../../../src/components/office/DocxEditor';
import type { DocxModel, Edit } from '../types';

const initial = await (await fetch('/model')).json() as DocxModel;
function Harness() {
  const [model, setModel] = useState(initial);
  const [edits, setEdits] = useState<Edit[]>([]);
  const editsRef=useRef<Edit[]>([]), beforeSave=useRef<null|(()=>Promise<void>)>(null);
  const [pending,setPending]=useState(false);
  const changed=useCallback((next:Edit[])=>{editsRef.current=next;setEdits(next);},[]);
  const registerBeforeSave=useCallback((callback:()=>Promise<void>)=>{beforeSave.current=callback;return()=>{if(beforeSave.current===callback)beforeSave.current=null;};},[]);
  const [readOnly, setReadOnly] = useState(new URLSearchParams(location.search).has('readOnly'));
  (window as any).officeDocxHarness = {
    edits: () => edits,
    setReadOnly,pending:()=>pending,flush:()=>beforeSave.current?.(),
    async export(file:{name:string;mime:string;bytes:Uint8Array}){
      const response=await fetch('/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...file,bytes:Array.from(file.bytes)})});
      if(!response.ok)throw Error(await response.text());return true;
    },
    async print(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}}){
      const response=await fetch('/print',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(document)});
      if(!response.ok)throw Error(await response.text());
    },
    async save() {
      await beforeSave.current?.();
      const response = await fetch('/save', { method: 'POST', body: JSON.stringify({ edits:editsRef.current }), headers: { 'content-type': 'application/json' } });
      if (!response.ok) throw Error(await response.text());
      const result = await response.json();
      setModel(result.model); changed([]);
      return result.model;
    },
    rebase: () => { setModel(initial); changed([]); },
  };
  return <DocxEditor model={model} edits={edits} onChange={changed} readOnly={readOnly} registerBeforeSave={registerBeforeSave} onPendingChange={setPending} onSaveRequest={async()=>{await (window as any).officeDocxHarness.save();}} onFetchImage={new URLSearchParams(location.search).has('nativeImage')?url=>(window as any).fetchRemoteImage(url):undefined} onExport={new URLSearchParams(location.search).has('nativeExport')?file=>(window as any).officeDocxHarness.export(file):undefined} onPrint={new URLSearchParams(location.search).has('nativePrint')?document=>(window as any).officeDocxHarness.print(document):undefined} onRenderPdf={new URLSearchParams(location.search).has('nativePdf')?document=>(window as any).renderPdf(document):undefined} onGetSystemFonts={new URLSearchParams(location.search).has('nativeFonts')?()=>(window as any).getSystemFonts():undefined} onConvertAltChunkHtml={new URLSearchParams(location.search).has('nativeAltChunk')?html=>(window as any).convertAltChunk(html):undefined} onFontMetrics={new URLSearchParams(location.search).has('nativeFonts')?family=>(window as any).fontMetrics(family):undefined} />;
}
createRoot(document.querySelector('#root')!).render(<Harness />);

import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../src/styles/app.css';
import { PptxEditor, type PptxEdit, type PptxModel, type PptxOutputDocument } from '../../../../src/components/office/PptxEditor';

const initial: PptxModel = await (await fetch('/model')).json();
function Harness() {
  const beforeSave = useRef<() => Promise<void>>(async () => {});
  const [model, setModel] = useState(initial);
  const [edits, setEdits] = useState<PptxEdit[]>([]);
  const editRef=useRef(edits);const pending=useRef(false);
  const onChange=(value:PptxEdit[])=>{editRef.current=value;setEdits(value)};
  const failSave=useRef(false);
  const prints=useRef<PptxOutputDocument[]>([]);
  const pdfRequests=useRef<PptxOutputDocument[]>([]);const [pdfFixture,setPdfFixture]=useState<number[]|null>(null);const [pdfFailure,setPdfFailure]=useState(false);
  const pdfGate=useRef<Promise<void>|undefined>(undefined),releasePdf=useRef<()=>void>(()=>{});
  const saveCompletion=useRef<Promise<void>|undefined>(undefined),releaseSaveCompletion=useRef<()=>void>(()=>{});
  const [exportMode,setExportMode]=useState('standalone');const exports=useRef<Array<{name:string;mime:string;bytes:Uint8Array}>>([]);
  const [readOnly, setReadOnly] = useState(false);
  (window as any).officePptxHarness = {
    prints:()=>prints.current,
    pdfRequests:()=>pdfRequests.current,setPdfFixture,setPdfFailure,
    holdPdf:()=>{pdfGate.current=new Promise(resolve=>{releasePdf.current=resolve})},releasePdf:()=>{releasePdf.current();pdfGate.current=undefined},
    holdSaveCompletion:()=>{saveCompletion.current=new Promise(resolve=>{releaseSaveCompletion.current=resolve})},releaseSaveCompletion:()=>{releaseSaveCompletion.current();saveCompletion.current=undefined},
    replaceModel:(replacement:PptxModel)=>{setModel(replacement);onChange([])},
    exports:()=>exports.current,setExportMode,
    failNextSave:()=>{failSave.current=true},external:async()=>{const model=await(await fetch('/reset')).json();setModel(model);onChange([])},edits: () => editRef.current, pending:()=>pending.current,setReadOnly, flush:()=>beforeSave.current(),
    async save() {
      await beforeSave.current();
      setReadOnly(true);
      try {
        if(failSave.current){failSave.current=false;throw new Error('Test native CAS conflict')}
        const response = await fetch('/save', { method: 'POST', body: JSON.stringify({ edits:editRef.current }) });
        if (!response.ok) throw Error(await response.text());
        const committed = await response.json(); setModel(committed); onChange([]); return committed;
      } finally {setReadOnly(false)}
    },
  };
  return <><button type="button" aria-label="主 File 保存" style={{position:'fixed',right:8,top:8,zIndex:999}} onClick={()=>void (window as any).officePptxHarness.save()}>File 保存</button><input aria-label="宿主其他输入" style={{position:'fixed',right:100,top:8,width:100,zIndex:999}}/><PptxEditor onRenderPdf={pdfFixture?async document=>{pdfRequests.current.push(document);await pdfGate.current;if(pdfFailure)throw new Error('Native render PDF failed');return new Uint8Array(pdfFixture)}:undefined} onPrint={async document=>{prints.current.push(document)}} onExport={exportMode==='standalone'?undefined:async file=>{if(exportMode==='fail')throw new Error('Native export write failed');if(exportMode==='cancel')return false;exports.current.push(file);return true}} onSaveRequest={async()=>{await (window as any).officePptxHarness.save();await saveCompletion.current}} onPendingChange={value=>{pending.current=value}} registerBeforeSave={callback => {beforeSave.current = callback; return () => {beforeSave.current=async()=>{}}}} model={model} edits={edits} onChange={onChange} readOnly={readOnly} /></>;
}
document.body.style.margin = '0';
document.getElementById('root')!.style.height = '100dvh';
createRoot(document.getElementById('root')!).render(<Harness />);

import { Activity, StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeEditSession } from '../../../../src/lib/office-edit-session';
import '../../../../src/styles/app.css';
import { PptxEditor, type PptxEdit, type PptxModel, type PptxOutputDocument } from '../../../../src/components/office/PptxEditor';

const initial: PptxModel = await (await fetch('/model')).json();
function Harness() {
  const makeSession=(model:PptxModel)=>new OfficeEditSession<PptxModel,PptxEdit>(
    {object:{workspaceId:'fixture',scope:{kind:'project',projectId:1},kind:'file',id:'42'},versionNumber:1,expectedContentHash:model.originalHash},model,
    async input=>{
      const response=await fetch('/save',{method:'POST',body:JSON.stringify({edits:input.edits})});
      if(!response.ok)throw Error(await response.text());
      const committed=await response.json();
      return {model:committed,commit:{receipt:{documentId:42,versionNumber:input.versionNumber+1,contentHash:committed.originalHash,noChange:false},versionPath:null}};
    });
  const output = useRef<(command: 'pdf'|'images'|'print') => Promise<void>>(async()=>{throw new Error('Output not registered')});
  const beforeSave = useRef<() => Promise<void>>(async () => {});
  const [model, setModel] = useState(initial);
  const session=useRef<OfficeEditSession<PptxModel,PptxEdit>|null>(null);
  if(!session.current)session.current=makeSession(initial);
  const [edits, setEdits] = useState<PptxEdit[]>([]);
  const editRef=useRef(edits);const pending=useRef(false);
  const echoes=useRef(0),clonedEcho=useRef(false);
  const onChange=(value:PptxEdit[])=>{session.current!.replaceEdits(value);editRef.current=session.current!.snapshot.edits;clonedEcho.current=editRef.current!==value;echoes.current++;setEdits(editRef.current)};
  const replaceModel=(model:PptxModel)=>{session.current=makeSession(model);setModel(model);editRef.current=session.current.snapshot.edits;setEdits(editRef.current)};
  const failSave=useRef(false);
  const prints=useRef<PptxOutputDocument[]>([]);
  const pdfRequests=useRef<PptxOutputDocument[]>([]);const [pdfFixture,setPdfFixture]=useState<number[]|null>(null);const [pdfFailure,setPdfFailure]=useState(false);
  const pdfGate=useRef<Promise<void>|undefined>(undefined),releasePdf=useRef<()=>void>(()=>{});
  const saveCompletion=useRef<Promise<void>|undefined>(undefined),releaseSaveCompletion=useRef<()=>void>(()=>{});
  const [exportMode,setExportMode]=useState('standalone');const exports=useRef<Array<{name:string;mime:string;bytes:Uint8Array}>>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [suspended,setSuspended]=useState(false);
  const [presentationMode,setPresentationMode]=useState<'edit'|'preview'>(new URLSearchParams(location.search).get('presentation')==='preview'?'preview':'edit');
  (window as any).officePptxHarness = {
    output:(command:'pdf'|'images'|'print')=>output.current(command),
    echoCount:()=>echoes.current,clonedEcho:()=>clonedEcho.current,
    model:()=>session.current!.snapshot.model,
    setPresentationMode,setSuspended,
    prints:()=>prints.current,
    pdfRequests:()=>pdfRequests.current,setPdfFixture,setPdfFailure,
    holdPdf:()=>{pdfGate.current=new Promise(resolve=>{releasePdf.current=resolve})},releasePdf:()=>{releasePdf.current();pdfGate.current=undefined},
    holdSaveCompletion:()=>{saveCompletion.current=new Promise(resolve=>{releaseSaveCompletion.current=resolve})},releaseSaveCompletion:()=>{releaseSaveCompletion.current();saveCompletion.current=undefined},
    replaceModel,
    exports:()=>exports.current,setExportMode,
    failNextSave:()=>{failSave.current=true},external:async()=>{const model=await(await fetch('/reset')).json();replaceModel(model)},edits: () => editRef.current, pending:()=>pending.current,setReadOnly, flush:()=>beforeSave.current(),
    async save() {
      await beforeSave.current();
      setReadOnly(true);
      try {
        if(failSave.current){failSave.current=false;throw new Error('Test native CAS conflict')}
        const saved=await session.current!.save();
        const snapshot=session.current!.snapshot;
        setModel(snapshot.model);editRef.current=snapshot.edits;setEdits(snapshot.edits);return saved?.model??snapshot.model;
      } finally {setReadOnly(false)}
    },
  };
  return <><button type="button" aria-label="主 File 保存" style={{position:'fixed',right:8,top:8,zIndex:999}} onClick={()=>void (window as any).officePptxHarness.save()}>File 保存</button><input aria-label="宿主其他输入" style={{position:'fixed',right:100,top:8,width:100,zIndex:999}}/><Activity mode={suspended?'hidden':'visible'}><PptxEditor registerOutput={callback=>{output.current=callback;return()=>{output.current=async()=>{throw new Error('Output not registered')}}}} onRenderPdf={pdfFixture?async document=>{pdfRequests.current.push(document);await pdfGate.current;if(pdfFailure)throw new Error('Native render PDF failed');return new Uint8Array(pdfFixture)}:undefined} onPrint={async document=>{prints.current.push(document)}} onExport={exportMode==='standalone'?undefined:async file=>{if(exportMode==='fail')throw new Error('Native export write failed');if(exportMode==='cancel')return false;exports.current.push(file);return true}} onSaveRequest={async()=>{await (window as any).officePptxHarness.save();await saveCompletion.current}} onPendingChange={value=>{pending.current=value}} registerBeforeSave={callback => {beforeSave.current = callback; return () => {beforeSave.current=async()=>{}}}} model={model} edits={edits} onChange={onChange} presentationMode={presentationMode} readOnly={readOnly} /></Activity></>;
}
document.body.style.margin = '0';
document.getElementById('root')!.style.height = '100dvh';
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);

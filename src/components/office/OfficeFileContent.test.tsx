import {officePreviewCache} from '../../lib/office-preview-cache';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {OfficeFileContent} from './OfficeFileContent';
import {fileWorkingApi,type FileWorkingOpen,type FileWorkingSaved} from '../../services/fileWorkingApi';
import {officeFileApi} from '../../services/officeFileApi';
import {inspectImportedWorkbook} from '../../services/editorWorkbookImport';
import {convertAltChunkHtml} from '../../../packages/office-html2docx/dist/index.mjs';
import {desktopApi} from '../../services/desktopApi';
import type {Model as XlsxModel,OfficeViewRead,RecalculateRequest,RecalculateResult,ScreenSourcesResult,ScreenCaptureResult} from '../../../packages/office-xlsx/types';
vi.mock('../../services/officeFileApi',()=>({officeFileApi:{inspectView:vi.fn(),readView:vi.fn(),save:vi.fn(),recalculate:vi.fn()}}));
vi.mock('../../services/fileWorkingApi',()=>({fileWorkingApi:{saveOffice:vi.fn(),recalculate:vi.fn(),readView:vi.fn(),activity:vi.fn()}}));
vi.mock('../../services/editorWorkbookImport',()=>({inspectImportedWorkbook:vi.fn()}));
vi.mock('../../../packages/office-html2docx/dist/index.mjs',()=>({convertAltChunkHtml:vi.fn()}));
vi.mock('../../services/desktopApi',()=>({desktopApi:{listSystemFontFamilies:vi.fn(),editorFontMetrics:vi.fn(),editorCaptureSources:vi.fn(),editorCaptureSource:vi.fn(),fetchEditorRemoteImage:vi.fn()}}));
const spreadsheet = vi.hoisted(()=>({model:undefined as XlsxModel|undefined,readView:undefined as undefined|((read:OfficeViewRead)=>Promise<unknown>),savedEditRevision:undefined as number|undefined,save:undefined as undefined|(()=>Promise<void>),recalculate:undefined as undefined|((input:RecalculateRequest)=>Promise<RecalculateResult>),importWorkbook:undefined as undefined|((bytes:Uint8Array)=>Promise<XlsxModel>),captureSources:undefined as undefined|(()=>Promise<ScreenSourcesResult>),captureSource:undefined as undefined|((input:{id:string})=>Promise<ScreenCaptureResult|null>)}));
const preview = vi.hoisted(()=>({capture:vi.fn(()=>({zoom:135,scroll:[{top:640,left:12}]})),restored:vi.fn()}));
const wordFlush = vi.hoisted(()=>({output:vi.fn(async(_command:string)=>{}),fetchImage:undefined as undefined|((url:string)=>Promise<{mime:'image/png'|'image/jpeg'|'image/gif';base64:string}>),wait:undefined as undefined|(()=>Promise<void>),convert:undefined as undefined|((html:string)=>Promise<Uint8Array|null>)}));
vi.mock('./DocxEditor',async()=>{
 const {useEffect,useRef,useState}=await import('react');
 return{DocxEditor:(props:{model:{nodes:{text:string}[]};edits:{text:string}[];onChange:(edits:unknown[])=>void;readOnly:boolean;registerOutput?:(handler:(command:string)=>Promise<void>)=>()=>void;registerBeforeSave?:(flush:()=>Promise<void>)=>()=>void;onPendingChange?:(value:boolean)=>void;onSaveRequest?:()=>Promise<void>;onConvertAltChunkHtml?:(html:string)=>Promise<Uint8Array|null>;registerPreview?:(access:{capture:()=>unknown})=>()=>void;initialPreviewView?:unknown;onFetchImage?:(url:string)=>Promise<{mime:'image/png'|'image/jpeg'|'image/gif';base64:string}>})=>{
  useEffect(()=>props.registerPreview?.({capture:preview.capture}),[props.registerPreview]);
  useEffect(()=>{if(props.initialPreviewView)preview.restored(props.initialPreviewView);},[]);
  wordFlush.convert=props.onConvertAltChunkHtml;wordFlush.fetchImage=props.onFetchImage;
  useEffect(()=>props.registerOutput?.(async command=>wordFlush.output(command)),[props.registerOutput]);
  const draft=useRef<string|null>(null),latest=useRef(props);latest.current=props;
  const [receipt,setReceipt]=useState('');
  useEffect(()=>props.registerBeforeSave?.(async()=>{await wordFlush.wait?.();if(draft.current!==null){latest.current.onChange([{type:'text',nodeId:'p0',text:draft.current}]);draft.current=null;latest.current.onPendingChange?.(false);}}),[props.registerBeforeSave]);
  return <div><p>{props.edits[0]?.text??props.model.nodes[0].text}</p><button disabled={props.readOnly} onClick={()=>props.onChange([{type:'text',nodeId:'p0',text:'已修改'}])}>修改正文</button><input aria-label="未提交的 Word 输入" readOnly={props.readOnly} onChange={event=>{draft.current=event.target.value;props.onPendingChange?.(true);}}/><button onClick={()=>{setReceipt('等待保存');void props.onSaveRequest?.().then(()=>setReceipt('保存回执成功'),()=>setReceipt('保存回执失败'));}}>Word 内保存</button><span>{receipt}</span></div>;
 }};
});
it('converts Word HTML chunks on demand through the lazy browser converter without writing a File',async()=>{
 const bytes=new Uint8Array([80,75,3,4]);vi.mocked(convertAltChunkHtml).mockResolvedValue(bytes);
 const view=await mount();await screen.findByText('原文');
 expect(convertAltChunkHtml).not.toHaveBeenCalled();
 await expect(wordFlush.convert!('<p>导入中文</p>')).resolves.toBe(bytes);
 expect(convertAltChunkHtml).toHaveBeenCalledExactlyOnceWith('<p>导入中文</p>');
 vi.mocked(convertAltChunkHtml).mockRejectedValue(new Error('图片转换失败'));
 await expect(wordFlush.convert!('<p>失败</p>')).rejects.toThrow('图片转换失败');
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 view.cleanup();
});
vi.mock('./PptxEditor',async()=>{
 const {useEffect,useRef,useState}=await import('react');
 return{PptxEditor:(props:{registerPreview?:(access:{capture:()=>unknown})=>()=>void;registerBeforeSave?:(flush:()=>Promise<void>)=>()=>void;onPendingChange?:(value:boolean)=>void;onChange:(edits:unknown[])=>void;onSaveRequest?:()=>Promise<void>})=>{
  useEffect(()=>props.registerPreview?.({capture:preview.capture}),[props.registerPreview]);
  const text=useRef<string|null>(null),latest=useRef(props);latest.current=props;
  const [receipt,setReceipt]=useState('');
  useEffect(()=>props.registerBeforeSave?.(async()=>{if(text.current!==null){latest.current.onChange([{kind:'command',name:'slides:set-text',args:[text.current]}]);text.current=null;latest.current.onPendingChange?.(false);}}),[props.registerBeforeSave]);
  return <><input aria-label="未提交的 PPT 输入" onChange={event=>{text.current=event.target.value;props.onPendingChange?.(true);}}/><button onClick={()=>{setReceipt('等待保存');void props.onSaveRequest?.().then(()=>setReceipt('保存回执成功'),()=>setReceipt('保存回执失败'));}}>PPT 内保存</button><span>{receipt}</span></>;
 }};
});
vi.mock('./XlsxEditor',async()=>{
  const {useEffect,useRef}=await import('react');
  return{XlsxEditor:(props:{registerPreview?:(access:{capture:()=>unknown})=>()=>void;model:XlsxModel;readOnly:boolean;savedEditRevision?:number;onSaveRequest?:()=>Promise<void>;registerBeforeSave:(flush:()=>Promise<void>)=>()=>void;onPendingChange:(pending:boolean)=>void;onChange:(edits:unknown[],snapshot?:{editRevision:number})=>void;onReadView?:(read:OfficeViewRead)=>Promise<unknown>;onRecalculate?:(input:RecalculateRequest)=>Promise<RecalculateResult>;onInspectImportedWorkbook?:(bytes:Uint8Array)=>Promise<XlsxModel>;onCaptureScreenSources?:()=>Promise<ScreenSourcesResult>;onCaptureScreenSource?:(input:{id:string})=>Promise<ScreenCaptureResult|null>})=>{
    useEffect(()=>props.registerPreview?.({capture:preview.capture}),[props.registerPreview]);
    spreadsheet.save=props.onSaveRequest;spreadsheet.model=props.model;spreadsheet.savedEditRevision=props.savedEditRevision;
    spreadsheet.recalculate=props.onRecalculate;spreadsheet.readView=props.onReadView;
    spreadsheet.importWorkbook=props.onInspectImportedWorkbook;
    spreadsheet.captureSources=props.onCaptureScreenSources;spreadsheet.captureSource=props.onCaptureScreenSource;
    const text=useRef<string|null>(null),revision=useRef(0);const latest=useRef(props);latest.current=props;
    useEffect(()=>props.registerBeforeSave(async()=>{
      if(text.current===null)return;
      latest.current.onChange([{sheetId:'sheet-1',row:0,column:0,kind:'string',value:text.current}],{editRevision:++revision.current});
      text.current=null;latest.current.onPendingChange(false);
    }),[props.registerBeforeSave]);
    return <input aria-label="正在编辑的单元格" readOnly={props.readOnly} onKeyDown={event=>{if(event.key==='Enter'&&text.current!==null){props.onChange([{sheetId:'sheet-1',row:0,column:0,kind:'string',value:text.current}],{editRevision:++revision.current});text.current=null;props.onPendingChange(false);}}} onChange={event=>{text.current=event.target.value;props.onPendingChange(true);}}/>;
  }};
});
it('connects Excel screenshot actions without capturing on load or writing a File',async()=>{
 setInspection({model:{format:'xlsx'}} as never);
 const sources:ScreenSourcesResult={status:'denied',sources:[]};
 const image:ScreenCaptureResult={mediaType:'image/png',base64:'iVBORw==',width:320,height:180};
 vi.mocked(desktopApi.editorCaptureSources).mockResolvedValue(sources);
 vi.mocked(desktopApi.editorCaptureSource).mockResolvedValue(image);
 const view=await mount();await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 expect(desktopApi.editorCaptureSources).not.toHaveBeenCalled();expect(desktopApi.editorCaptureSource).not.toHaveBeenCalled();
 await expect(spreadsheet.captureSources!()).resolves.toBe(sources);
 await expect(spreadsheet.captureSource!({id:'selected-opaque-id'})).resolves.toBe(image);
 expect(desktopApi.editorCaptureSource).toHaveBeenCalledExactlyOnceWith({id:'selected-opaque-id'});
 vi.mocked(desktopApi.editorCaptureSource).mockRejectedValue(new Error('截图来源已失效'));
 await expect(spreadsheet.captureSource!({id:'expired'})).rejects.toThrow('截图来源已失效');
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 view.cleanup();
});
it('connects selected workbook imports to the read-only byte service without saving a File',async()=>{
 setInspection({model:{format:'xlsx'}} as never);
 const source={format:'xlsx',name:'source.xlsx'};
 vi.mocked(inspectImportedWorkbook).mockResolvedValue(source as never);
 const view=await mount();await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const bytes=new Uint8Array([80,75,3,4]);
 await expect(spreadsheet.importWorkbook!(bytes)).resolves.toBe(source);
 expect(inspectImportedWorkbook).toHaveBeenCalledExactlyOnceWith(bytes);
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 view.cleanup();
});
it('calculates against the current File baseline without creating a version, including after saving',async()=>{
 const xlsx={format:'xlsx'};
 setInspection({model:xlsx} as never);
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
 const result={cells:[]};vi.mocked(fileWorkingApi.recalculate).mockResolvedValue(result);
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const request={edits:[],reads:[]};
 await expect(spreadsheet.recalculate!(request)).resolves.toBe(result);
 expect(fileWorkingApi.recalculate).toHaveBeenLastCalledWith(binding,{object:baseline.object,sessionId:'working-session',recalculation:request});
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 fireEvent.change(input,{target:{value:'新值'}});await act(()=>view.flush());
 await spreadsheet.recalculate!(request);
 expect(fileWorkingApi.recalculate).toHaveBeenLastCalledWith(binding,{object:baseline.object,sessionId:'working-session',recalculation:request});
 view.cleanup();
});
it('coalesces identical in-flight recalculations and preserves each distinct edit result',async()=>{
 setInspection({model:{format:'xlsx'}} as never);
 const finishes:((value:RecalculateResult)=>void)[]=[];
 vi.mocked(fileWorkingApi.recalculate).mockImplementation(()=>new Promise(resolve=>{finishes.push(resolve);}));
 const view=await mount();await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const request={edits:[{sheetId:'sheet-1',row:0,column:0,input:'1'}],reads:[]};
 const first=spreadsheet.recalculate!(request),duplicates=Array.from({length:49},()=>spreadsheet.recalculate!(structuredClone(request)));
 const newer=spreadsheet.recalculate!({...request,edits:[{...request.edits[0],input:'2'}]});
 expect(fileWorkingApi.recalculate).toHaveBeenCalledTimes(2);
 const a={cells:[]},b={cells:[]};finishes[1](b);finishes[0](a);
 await expect(first).resolves.toBe(a);for(const same of duplicates)await expect(same).resolves.toBe(a);await expect(newer).resolves.toBe(b);
 // No result cache: a later request must validate/recompute against native state.
 const again=spreadsheet.recalculate!(request);expect(fileWorkingApi.recalculate).toHaveBeenCalledTimes(3);
 finishes[2](a);await again;view.cleanup();
});
it('shares a failed identical calculation then permits an explicit retry',async()=>{
 setInspection({model:{format:'xlsx'}} as never);
 let reject!:(reason:Error)=>void;
 vi.mocked(fileWorkingApi.recalculate).mockImplementation(()=>new Promise((_resolve,fail)=>{reject=fail;}));
 const view=await mount();await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const first=spreadsheet.recalculate!({edits:[],reads:[]}),second=spreadsheet.recalculate!({edits:[],reads:[]});
 const rejected=Promise.all([expect(first).rejects.toThrow('native failed'),expect(second).rejects.toThrow('native failed')]);
 expect(fileWorkingApi.recalculate).toHaveBeenCalledTimes(1);reject(Error('native failed'));await rejected;
 vi.mocked(fileWorkingApi.recalculate).mockResolvedValue({cells:[]});
 await spreadsheet.recalculate!({edits:[],reads:[]});expect(fileWorkingApi.recalculate).toHaveBeenCalledTimes(2);view.cleanup();
});
it.each(['close','save'] as const)('invalidates calculations only when %s ends the editing session',async change=>{
 const xlsx={format:'xlsx'};
 setInspection({model:xlsx} as never);
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
 let finish!:(result:RecalculateResult)=>void;
 vi.mocked(fileWorkingApi.recalculate).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const calculation=spreadsheet.recalculate!({edits:[],reads:[]}),same=spreadsheet.recalculate!({edits:[],reads:[]});
 expect(fileWorkingApi.recalculate).toHaveBeenCalledTimes(1);
 const checked=Promise.all([calculation,same].map(result=>change==='close'?expect(result).rejects.toThrow('文件已关闭或切换'):expect(result).resolves.toEqual({cells:[]})));
 if(change==='close')view.cleanup();
 else{fireEvent.change(input,{target:{value:'新值'}});await act(()=>view.flush());}
 finish({cells:[]});await checked;
 if(change!=='close')view.cleanup();
});
const binding={workspaceId:'workspace',generation:'generation'};
const baseline={object:{workspaceId:'workspace',scope:{kind:'project' as const,projectId:7},kind:'file' as const,id:'42'},versionNumber:2,expectedContentHash:'sha256:old'};
const model={format:'docx',nodes:[{id:'p0',text:'原文'}]};
let inspectedModel:unknown=model;
function setInspection(result:{model:unknown}){inspectedModel=result.model;vi.mocked(officeFileApi.inspectView).mockResolvedValue(result as never);}
const workingStatus={object:baseline.object,revision:2,contentHash:'sha256:old',archivedVersionNumber:2,pendingArchive:false,lastActivityAtMs:null,archiveDueAtMs:null};
function savedStatus(hash='sha256:new'):FileWorkingSaved{return {...workingStatus,revision:3,contentHash:hash,pendingArchive:true,noChange:false};}
function working():FileWorkingOpen{return {...workingStatus,sessionId:'working-session',name:'document',base64:'',format:(inspectedModel as {format:string}).format,model:inspectedModel as FileWorkingOpen['model']};}
beforeEach(()=>{officePreviewCache.clear();vi.clearAllMocks();preview.capture.mockImplementation(()=>({zoom:135,scroll:[{top:640,left:12}]}));wordFlush.wait=undefined;vi.mocked(fileWorkingApi.activity).mockResolvedValue(workingStatus);setInspection({model} as never);});
async function mount(readOnly=false, preview=false){
  const toolbar=document.createElement('div'),menuToolbar=document.createElement('span');document.body.append(menuToolbar,toolbar);
  let guard:(()=>Promise<void>)|undefined;
  const saved=vi.fn();const dirty=vi.fn();
  const content=(visible=true)=><div hidden={!visible}><OfficeFileContent visible={visible} toolbar={toolbar} menuToolbar={menuToolbar} binding={binding} baseline={baseline} working={readOnly?undefined:working()} readOnly={readOnly} registerFlush={flush=>{guard=flush;return()=>{guard=undefined;};}} onDirtyChange={dirty} onSaved={saved}/></div>;
  const result=render(content());
  if(!preview) {const edit=await screen.findByRole('button',{name:readOnly?'完整视图':'编辑'});await waitFor(()=>expect(edit).not.toBeDisabled());fireEvent.click(edit);}
  return{...result,setVisible:(visible:boolean)=>result.rerender(content(visible)),saved,dirty,menuToolbar,toolbar,flush:()=>guard!(),cleanup:()=>{result.unmount();toolbar.remove();menuToolbar.remove();}};
}
it('loads the working model and advances native revision while retaining the original editor baseline',async()=>{
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
  const view=await mount();await screen.findByText('原文');
  expect(officeFileApi.inspectView).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  expect(screen.getByText('已修改')).toBeVisible();
  fireEvent.keyDown(screen.getByText('已修改'),{key:'s',metaKey:true});
  await waitFor(()=>expect(view.saved).toHaveBeenCalledWith(2,'sha256:new',savedStatus()));
  expect(screen.getByRole('status')).toHaveTextContent('已保存');
  fireEvent.change(screen.getByRole('textbox',{name:'未提交的 Word 输入'}),{target:{value:'第二次修改'}});await act(()=>view.flush());
  expect(fileWorkingApi.saveOffice).toHaveBeenLastCalledWith(binding,expect.objectContaining({expectedRevision:3,expectedContentHash:'sha256:new'}),expect.any(String));
  view.cleanup();
});
it('a failed close/save keeps the edited contents and rejects closing',async()=>{
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new Error('文件版本冲突'));
  const view=await mount();await screen.findByText('原文');
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  await act(async()=>{await expect(view.flush()).rejects.toThrow('文件版本冲突');});
  expect(screen.getByText('已修改')).toBeVisible();expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');expect(view.saved).not.toHaveBeenCalled();
  view.cleanup();
});
it('shares concurrent save requests while pending editor input is being committed',async()=>{
 let release!:()=>void;
 const committed=new Promise<void>(resolve=>{release=resolve;});
 wordFlush.wait=vi.fn(()=>committed);
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
 const view=await mount();fireEvent.change(await screen.findByRole('textbox',{name:'未提交的 Word 输入'}),{target:{value:'快速保存'}});
 let first!:Promise<void>,second!:Promise<void>;
 act(()=>{first=view.flush();second=view.flush();});
 const calls=vi.mocked(wordFlush.wait).mock.calls.length;
 await act(async()=>{release();await Promise.all([first,second]);});
 expect(calls).toBe(1);expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();expect(view.saved).toHaveBeenCalledOnce();
 view.cleanup();
});
it('a fixed historical Office version is read only and closing creates no version',async()=>{
  const view=await mount(true);await screen.findByText('原文');
  expect(screen.getByRole('button',{name:'修改正文'})).toBeDisabled();expect(screen.queryByRole('button',{name:'保存'})).toBeNull();
  await view.flush();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();view.cleanup();
});
it('closing commits pending spreadsheet input before taking the native save snapshot',async()=>{
  const xlsx={format:'xlsx'};
  setInspection({model:xlsx} as never);
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
  const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
  fireEvent.change(input,{target:{value:'未按 Enter 的中文'}});
  expect(view.dirty).toHaveBeenLastCalledWith(true);expect(screen.getByRole('status')).toHaveTextContent('未保存');
  await act(()=>view.flush());
  expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({edits:[{sheetId:'sheet-1',row:0,column:0,kind:'string',value:'未按 Enter 的中文'}]}),expect.any(String));
  expect(view.dirty).toHaveBeenLastCalledWith(false);expect(screen.getByRole('status')).toHaveTextContent('已保存');view.cleanup();
});

it.each(['docx','pptx'] as const)('flushes pending %s input before creating the File save snapshot',async format=>{
 const inspected=format==='docx'?model:{format:'pptx'};
 setInspection({model:inspected} as never);
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
 const view=await mount();const input=await screen.findByRole('textbox',{name:format==='docx'?'未提交的 Word 输入':'未提交的 PPT 输入'});
 fireEvent.change(input,{target:{value:'未提交中文'}});expect(view.dirty).toHaveBeenLastCalledWith(true);
 if(format==='docx')fireEvent.click(screen.getByRole('button',{name:'Word 内保存'}));else await act(()=>view.flush());
 await waitFor(()=>expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({edits:format==='docx'?[{type:'text',nodeId:'p0',text:'未提交中文'}]:[{kind:'command',name:'slides:set-text',args:['未提交中文']}]}),expect.any(String)));
 expect(view.dirty).toHaveBeenLastCalledWith(false);view.cleanup();
});

it.each([{format:'docx',success:true},{format:'docx',success:false},{format:'pptx',success:true},{format:'pptx',success:false}])('returns the $format internal save receipt only after native completion (success=$success)',async({format,success})=>{
 const inspected=format==='docx'?model:{format};
 setInspection({model:inspected} as never);
 let resolveSave!:(result:never)=>void;let rejectSave!:(error:Error)=>void;
 vi.mocked(fileWorkingApi.saveOffice).mockImplementation(()=>new Promise((resolve,reject)=>{resolveSave=resolve;rejectSave=reject;}));
 const view=await mount();const input=await screen.findByRole('textbox',{name:format==='docx'?'未提交的 Word 输入':'未提交的 PPT 输入'});
 fireEvent.change(input,{target:{value:'内部保存中文'}});
 fireEvent.click(screen.getByRole('button',{name:format==='docx'?'Word 内保存':'PPT 内保存'}));
 await waitFor(()=>expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce());
 expect(screen.getByText('等待保存')).toBeVisible();expect(view.saved).not.toHaveBeenCalled();
 await act(async()=>{
  if(success)resolveSave(savedStatus('sha256:new') as never);
  else rejectSave(new Error('原件已变更'));
 });
 expect(await screen.findByText(success?'保存回执成功':'保存回执失败')).toBeVisible();
 if(!success){expect(screen.getByRole('alert')).toHaveTextContent('原件已变更');expect(view.dirty).toHaveBeenLastCalledWith(true);}
 view.cleanup();
});


it('binds Word remote image requests to the current File baseline and rejects late receipts',async()=>{
  const image={mime:'image/png' as const,base64:'aW1hZ2U='};
  vi.mocked(desktopApi.fetchEditorRemoteImage).mockResolvedValue(image);
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
  const view=await mount();await screen.findByText('原文');
  expect(desktopApi.fetchEditorRemoteImage).not.toHaveBeenCalled();
  await expect(wordFlush.fetchImage!('https://images.example.test/a.png')).resolves.toBe(image);
  expect(desktopApi.fetchEditorRemoteImage).toHaveBeenLastCalledWith({binding,document:baseline,workingSessionId:'working-session',url:'https://images.example.test/a.png'});
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));await act(()=>view.flush());
  await wordFlush.fetchImage!('https://images.example.test/b.png');
  expect(desktopApi.fetchEditorRemoteImage).toHaveBeenLastCalledWith({binding,document:baseline,workingSessionId:'working-session',url:'https://images.example.test/b.png'});
  let finish!:(value:typeof image)=>void;
  vi.mocked(desktopApi.fetchEditorRemoteImage).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const callback=wordFlush.fetchImage!;
  const reading=callback('https://images.example.test/late.png');
  const rejected=expect(reading).rejects.toThrow('文件已关闭或切换');
  view.cleanup();finish(image);await rejected;
  vi.mocked(desktopApi.fetchEditorRemoteImage).mockClear();
  await expect(callback('https://images.example.test/old.png')).rejects.toThrow('文件已关闭或切换');
  expect(desktopApi.fetchEditorRemoteImage).not.toHaveBeenCalled();
});
it('does not start Word remote image reads for a historical File',async()=>{
  const view=await mount(true);await screen.findByText('原文');
  await expect(wordFlush.fetchImage!('https://images.example.test/a.png')).rejects.toThrow('只读');
  expect(desktopApi.fetchEditorRemoteImage).not.toHaveBeenCalled();view.cleanup();
});

it('allows a Word remote image receipt after saving the same live session',async()=>{
  const image={mime:'image/png' as const,base64:'aW1hZ2U='};
  let finish!:(value:typeof image)=>void;
  vi.mocked(desktopApi.fetchEditorRemoteImage).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
  const view=await mount();await screen.findByText('原文');
  const reading=wordFlush.fetchImage!('https://images.example.test/stale.png');
  const checked=expect(reading).resolves.toBe(image);
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));await act(()=>view.flush());
  finish(image);await checked;view.cleanup();
});

it('uses the same mounted Word renderer read-only until Edit, without creating a File version',async()=>{
 const view=await mount(false,true);
 const input=await screen.findByRole('textbox',{name:'未提交的 Word 输入'});
 expect(input).toHaveAttribute('readonly');
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'编辑'}));
 expect(screen.getByRole('textbox',{name:'未提交的 Word 输入'})).toBe(input);
 expect(input).not.toHaveAttribute('readonly');
 view.cleanup();
});
it('does not leave the editor when save-and-preview fails',async()=>{
 vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new Error('磁盘写入失败'));
 const view=await mount();
 fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
 fireEvent.click(screen.getByRole('button',{name:'保存并预览'}));
 await screen.findByRole('alert');
 expect(screen.getByText('已修改')).toBeVisible();
 expect(screen.getByRole('textbox',{name:'未提交的 Word 输入'})).not.toHaveAttribute('readonly');
 view.cleanup();
});
it('keeps editing when queued input is delivered while save-and-preview awaits its receipt',async()=>{
 let finish!:(result:unknown)=>void;
 vi.mocked(fileWorkingApi.saveOffice).mockImplementation(()=>new Promise(resolve=>{finish=resolve as typeof finish;}) as never);
 const view=await mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
 fireEvent.click(screen.getByRole('button',{name:'保存并预览'}));
 await waitFor(()=>expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce());
 // A queued editor/composition callback can arrive after the UI has frozen.
 fireEvent.change(screen.getByRole('textbox',{name:'未提交的 Word 输入'}),{target:{value:'排队的新输入'}});
 await act(async()=>finish(savedStatus('sha256:new')));
 expect(screen.getByRole('button',{name:'保存并预览'})).toBeVisible();
 expect(screen.getByRole('status')).toHaveTextContent('未保存');
 expect(screen.getByRole('textbox',{name:'未提交的 Word 输入'})).toHaveValue('排队的新输入');
 view.cleanup();
});

it('automatically saves settled edits and cancels the old timer when closing',async()=>{
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:auto') as never);
 const view=await mount();await screen.findByText('原文');vi.useFakeTimers();
 try {
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  await act(()=>vi.advanceTimersByTimeAsync(1199));expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  await act(()=>vi.advanceTimersByTimeAsync(1));expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();
  expect(view.saved).toHaveBeenCalledWith(2,'sha256:auto',savedStatus('sha256:auto'));
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));view.cleanup();
  await act(()=>vi.advanceTimersByTimeAsync(2000));expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();
 } finally {vi.useRealTimers();}
});
it('waits for pending input and does not loop after an automatic save fails',async()=>{
 vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new Error('自动保存冲突'));
 const view=await mount();await screen.findByText('原文');vi.useFakeTimers();
 try {
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  fireEvent.change(screen.getByRole('textbox',{name:'未提交的 Word 输入'}),{target:{value:'组合输入'}});
  await act(()=>vi.advanceTimersByTimeAsync(2000));expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  // Explicit save flushes the active input; a failure leaves its draft available.
  await act(async()=>{await expect(view.flush()).rejects.toThrow('自动保存冲突');});
  await act(()=>vi.advanceTimersByTimeAsync(5000));expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');view.cleanup();
 } finally {vi.useRealTimers();}
});

it('routes the first-line File menu to the current renderer even in historical preview',async()=>{
 const view=await mount(true,true);await screen.findByText('原文');
 const trigger=screen.getByRole('button',{name:'文件菜单'});
 expect(view.menuToolbar).toContainElement(trigger);expect(view.toolbar).not.toContainElement(trigger);
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('menuitem',{name:'导出 HTML'}));
 await waitFor(()=>expect(wordFlush.output).toHaveBeenCalledWith('html'));
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();view.cleanup();
});

it('rejects a save that becomes read-only while beforeSave is pending',async()=>{
 let release!:()=>void;
 wordFlush.wait=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
 const view=await mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'修改正文'}));expect(view.dirty).toHaveBeenLastCalledWith(true);
 let pending!:Promise<void>;act(()=>{pending=view.flush();});
 const result=pending.then(()=>null,reason=>reason);
 await waitFor(()=>expect(wordFlush.wait).toHaveBeenCalledOnce());expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
 const nextSaved=vi.fn();
 view.rerender(<div><OfficeFileContent toolbar={view.toolbar} menuToolbar={view.menuToolbar} binding={binding} baseline={baseline} working={working()} readOnly registerFlush={()=>()=>{}} onDirtyChange={view.dirty} onSaved={nextSaved}/></div>);
 let failure:unknown;await act(async()=>{release();failure=await result;});
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain('只读');
 expect(screen.getByText('已修改')).toBeVisible();expect(screen.getByRole('button',{name:'修改正文'})).toBeDisabled();
 expect(screen.getByRole('status')).toHaveTextContent('历史版本 · 只读');expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');
 expect(view.saved).not.toHaveBeenCalled();expect(nextSaved).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(true);
 view.cleanup();
});

it('confirms Excel captured edit revision while retaining the original model',async()=>{
 const previous={format:'xlsx'};
 setInspection({model:previous} as never);
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 expect(spreadsheet.savedEditRevision).toBe(0);fireEvent.change(input,{target:{value:'已修改'}});await act(()=>view.flush());
 expect(spreadsheet.model).toBe(previous);expect(spreadsheet.savedEditRevision).toBe(1);
 view.cleanup();
});

it('keeps the clean preview alive when hidden and avoids re-inspecting on re-visibility',async()=>{
 const view=await mount(false,true);await screen.findByText('原文');
 view.setVisible(false);
  expect(screen.getByText('原文')).toBeInTheDocument();
 expect(preview.capture).toHaveBeenCalledOnce();
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  view.setVisible(true);expect(screen.getByText('原文')).toBeInTheDocument();
 expect(officeFileApi.inspectView).not.toHaveBeenCalled();
 view.cleanup();
});
it('pins hidden editing, pending input and failed CAS while keeping the close guard live',async()=>{
 const view=await mount();const input=await screen.findByRole('textbox',{name:'未提交的 Word 输入'});
 fireEvent.change(input,{target:{value:'隐藏草稿'}});view.setVisible(false);
 expect(input).toBeInTheDocument();expect(preview.capture).not.toHaveBeenCalled();
 vi.mocked(fileWorkingApi.saveOffice).mockRejectedValueOnce(Error('CAS 冲突'));
 await act(async()=>{await expect(view.flush()).rejects.toThrow('CAS 冲突');});
 expect(screen.getByText('隐藏草稿')).toBeInTheDocument();
 expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({object:baseline.object,sessionId:'working-session',expectedRevision:2,expectedContentHash:'sha256:old'}),expect.any(String));
 view.setVisible(true);expect(screen.getByText('隐藏草稿')).toBeVisible();view.cleanup();
});
it('does not evict a saved editing session until the user finishes editing',async()=>{
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus('sha256:new') as never);
 const view=await mount();await screen.findByText('原文');fireEvent.click(screen.getByRole('button',{name:'修改正文'}));await act(()=>view.flush());
 view.setVisible(false);expect(screen.getByText('已修改')).toBeInTheDocument();expect(preview.capture).not.toHaveBeenCalled();view.cleanup();
});
it('keeps a preview mounted through an in-flight output before releasing it',async()=>{
 let finish!:()=>void;wordFlush.output.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const view=await mount(false,true);await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'文件菜单'}));fireEvent.click(screen.getByRole('menuitem',{name:/导出.*PDF/}));
 await waitFor(()=>expect(wordFlush.output).toHaveBeenCalled());view.setVisible(false);
 expect(screen.getByText('原文')).toBeInTheDocument();
  await act(async()=>finish());expect(screen.getByText('原文')).toBeInTheDocument();view.cleanup();
});

it('captures preview coordinates before the containing File becomes hidden',async()=>{
 const view=await mount(false,true);await screen.findByText('原文');
 preview.capture.mockImplementation(()=>{expect(screen.getByText('原文').closest('[hidden]')).toBeNull();return{zoom:135,scroll:[{top:640,left:12}]};});
 view.setVisible(false);expect(screen.getByText('原文')).toBeInTheDocument();expect(preview.capture).toHaveBeenCalledOnce();view.cleanup();
});
it('repeated clean-preview switches keep the editor alive and avoid re-inspecting',async()=>{
 const view=await mount(false,true);await screen.findByText('原文');
 for(let i=0;i<10;i++){
   view.setVisible(false);expect(screen.getByText('原文')).toBeInTheDocument();
    view.setVisible(true);expect(screen.getByText('原文')).toBeInTheDocument();
 }
 expect(preview.capture).toHaveBeenCalledTimes(10);expect(officeFileApi.inspectView).not.toHaveBeenCalled();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();view.cleanup();
});

it.each(['xlsx','pptx'] as const)('keeps a clean hidden %s preview mounted as well as Word',async format=>{
 setInspection({model:{format}} as never);
 const view=await mount(false,true);const label=format==='xlsx'?'正在编辑的单元格':'未提交的 PPT 输入';await screen.findByRole('textbox',{name:label});
 view.setVisible(false);expect(screen.queryByRole('textbox',{name:label,hidden:true})).toBeInTheDocument();expect(preview.capture).toHaveBeenCalledOnce();view.cleanup();
});
it('keeps the clean preview mounted when view capture fails',async()=>{
 const view=await mount(false,true);await screen.findByText('原文');preview.capture.mockImplementation(()=>{throw Error('视图捕获失败');});
 view.setVisible(false);expect(screen.getByText('原文')).toBeInTheDocument();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();view.cleanup();
});
it('does not restore an old workspace generation view after a hidden switch',async()=>{
 const view=await mount(false,true);await screen.findByText('原文');view.setVisible(false);expect(screen.getByText('原文')).toBeInTheDocument();
 const next={...binding,generation:'new-generation'};
 const content=(visible:boolean)=><div hidden={!visible}><OfficeFileContent visible={visible} toolbar={view.toolbar} binding={next} baseline={baseline} working={working()} readOnly={false} registerFlush={()=>()=>{}} onDirtyChange={view.dirty} onSaved={view.saved}/></div>;
 view.rerender(content(false));view.rerender(content(true));await screen.findByText('原文');
 expect(officeFileApi.inspectView).not.toHaveBeenCalled();expect(preview.restored).not.toHaveBeenCalled();view.cleanup();
});

it('accepts committed Excel input while saving and confirms only the captured revision',async()=>{
 const original={format:'xlsx'};setInspection({model:original});
 let finish!:(value:FileWorkingSaved)=>void;
 vi.mocked(fileWorkingApi.saveOffice).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({...savedStatus(),revision:4,contentHash:'sha256:next'});
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 fireEvent.change(input,{target:{value:'first'}});fireEvent.keyDown(input,{key:'Enter'});
 let saving!:Promise<void>;act(()=>{saving=spreadsheet.save!();});await waitFor(()=>expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce());
 expect(input).not.toHaveAttribute('readonly');
 fireEvent.change(input,{target:{value:'second'}});fireEvent.keyDown(input,{key:'Enter'});
 await act(async()=>{finish(savedStatus());await saving;});
 expect(spreadsheet.model).toBe(original);expect(spreadsheet.savedEditRevision).toBe(1);expect(view.dirty).toHaveBeenLastCalledWith(true);
 await act(()=>spreadsheet.save!());
 expect(fileWorkingApi.saveOffice).toHaveBeenLastCalledWith(binding,expect.objectContaining({expectedRevision:3,expectedContentHash:'sha256:new',edits:[{sheetId:'sheet-1',row:0,column:0,kind:'string',value:'second'}]}),expect.any(String));
 expect(spreadsheet.model).toBe(original);expect(spreadsheet.savedEditRevision).toBe(2);expect(view.dirty).toHaveBeenLastCalledWith(false);view.cleanup();
});
it('retries a failed persistence request with its exact identity before newer edits',async()=>{
 setInspection({model:{format:'xlsx'}});
 vi.mocked(fileWorkingApi.saveOffice).mockRejectedValueOnce(Error('receipt lost')).mockResolvedValue(savedStatus());
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 fireEvent.change(input,{target:{value:'first'}});fireEvent.keyDown(input,{key:'Enter'});
 await act(async()=>{await expect(view.flush()).rejects.toThrow('receipt lost');});
 const attempt=vi.mocked(fileWorkingApi.saveOffice).mock.calls[0];
 fireEvent.change(input,{target:{value:'second'}});fireEvent.keyDown(input,{key:'Enter'});
 await act(()=>spreadsheet.save!());
 expect(vi.mocked(fileWorkingApi.saveOffice).mock.calls[1]).toEqual(attempt);expect(view.dirty).toHaveBeenLastCalledWith(true);expect(spreadsheet.savedEditRevision).toBe(1);
 await act(()=>spreadsheet.save!());
 expect(fileWorkingApi.saveOffice).toHaveBeenLastCalledWith(binding,expect.objectContaining({expectedRevision:3,edits:[{sheetId:'sheet-1',row:0,column:0,kind:'string',value:'second'}]}),expect.any(String));
 expect(vi.mocked(fileWorkingApi.saveOffice).mock.calls[2][2]).not.toBe(attempt[2]);expect(view.dirty).toHaveBeenLastCalledWith(false);view.cleanup();
});
it('autosaves a settled journal without calling the active-input commit hook',async()=>{
 const view=await mount();await screen.findByText('原文');wordFlush.wait=vi.fn(async()=>{});vi.useFakeTimers();
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue(savedStatus());
 try{fireEvent.click(screen.getByRole('button',{name:'修改正文'}));await act(()=>vi.advanceTimersByTimeAsync(1200));expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();expect(wordFlush.wait).not.toHaveBeenCalled();view.cleanup();}finally{vi.useRealTimers();}
});

it('reads XLSX ranges from the fixed working session and rejects results after unmount',async()=>{
 setInspection({model:{format:'xlsx'}} as never);
 const view=await mount();await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const read:OfficeViewRead={kind:'range',sheetId:'sheet-1',range:{startRow:0,endRow:9,startColumn:0,endColumn:3}};
 let finish!:(value:unknown)=>void;
 vi.mocked(fileWorkingApi.readView).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=spreadsheet.readView!(read);const rejected=expect(pending).rejects.toThrow('Excel 文件已关闭或切换');
 expect(fileWorkingApi.readView).toHaveBeenCalledWith(binding,{object:baseline.object,sessionId:'working-session',read});
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
 view.cleanup();finish({cells:[]});await rejected;
});

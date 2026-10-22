import {officePreviewCache} from '../../lib/office-preview-cache';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {OfficeFileContent} from './OfficeFileContent';
import {officeFileApi} from '../../services/officeFileApi';
import {inspectImportedWorkbook} from '../../services/editorWorkbookImport';
import {convertAltChunkHtml} from '../../../packages/office-html2docx/dist/index.mjs';
import {desktopApi} from '../../services/desktopApi';
import type {Model as XlsxModel,RecalculateRequest,RecalculateResult,ScreenSourcesResult,ScreenCaptureResult} from '../../../packages/office-xlsx/types';
vi.mock('../../services/officeFileApi',()=>({officeFileApi:{inspect:vi.fn(),save:vi.fn(),recalculate:vi.fn()}}));
vi.mock('../../services/editorWorkbookImport',()=>({inspectImportedWorkbook:vi.fn()}));
vi.mock('../../../packages/office-html2docx/dist/index.mjs',()=>({convertAltChunkHtml:vi.fn()}));
vi.mock('../../services/desktopApi',()=>({desktopApi:{listSystemFontFamilies:vi.fn(),editorFontMetrics:vi.fn(),editorCaptureSources:vi.fn(),editorCaptureSource:vi.fn(),fetchEditorRemoteImage:vi.fn()}}));
const spreadsheet = vi.hoisted(()=>({savedModelUpdate:undefined as undefined|{previous:XlsxModel;current:XlsxModel},recalculate:undefined as undefined|((input:RecalculateRequest)=>Promise<RecalculateResult>),importWorkbook:undefined as undefined|((bytes:Uint8Array)=>Promise<XlsxModel>),captureSources:undefined as undefined|(()=>Promise<ScreenSourcesResult>),captureSource:undefined as undefined|((input:{id:string})=>Promise<ScreenCaptureResult|null>)}));
const wordFlush = vi.hoisted(()=>({output:vi.fn(async(_command:string)=>{}),fetchImage:undefined as undefined|((url:string)=>Promise<{mime:'image/png'|'image/jpeg'|'image/gif';base64:string}>),wait:undefined as undefined|(()=>Promise<void>),convert:undefined as undefined|((html:string)=>Promise<Uint8Array|null>)}));
vi.mock('./DocxEditor',async()=>{
 const {useEffect,useRef,useState}=await import('react');
 return{DocxEditor:(props:{model:{nodes:{text:string}[]};edits:{text:string}[];onChange:(edits:unknown[])=>void;readOnly:boolean;registerOutput?:(handler:(command:string)=>Promise<void>)=>()=>void;registerBeforeSave?:(flush:()=>Promise<void>)=>()=>void;onPendingChange?:(value:boolean)=>void;onSaveRequest?:()=>Promise<void>;onConvertAltChunkHtml?:(html:string)=>Promise<Uint8Array|null>;onFetchImage?:(url:string)=>Promise<{mime:'image/png'|'image/jpeg'|'image/gif';base64:string}>})=>{
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
 expect(officeFileApi.save).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 view.cleanup();
});
vi.mock('./PptxEditor',async()=>{
 const {useEffect,useRef,useState}=await import('react');
 return{PptxEditor:(props:{registerBeforeSave?:(flush:()=>Promise<void>)=>()=>void;onPendingChange?:(value:boolean)=>void;onChange:(edits:unknown[])=>void;onSaveRequest?:()=>Promise<void>})=>{
  const text=useRef<string|null>(null),latest=useRef(props);latest.current=props;
  const [receipt,setReceipt]=useState('');
  useEffect(()=>props.registerBeforeSave?.(async()=>{if(text.current!==null){latest.current.onChange([{kind:'command',name:'slides:set-text',args:[text.current]}]);text.current=null;latest.current.onPendingChange?.(false);}}),[props.registerBeforeSave]);
  return <><input aria-label="未提交的 PPT 输入" onChange={event=>{text.current=event.target.value;props.onPendingChange?.(true);}}/><button onClick={()=>{setReceipt('等待保存');void props.onSaveRequest?.().then(()=>setReceipt('保存回执成功'),()=>setReceipt('保存回执失败'));}}>PPT 内保存</button><span>{receipt}</span></>;
 }};
});
vi.mock('./XlsxEditor',async()=>{
  const {useEffect,useRef}=await import('react');
  return{XlsxEditor:(props:{savedModelUpdate?:{previous:XlsxModel;current:XlsxModel};registerBeforeSave:(flush:()=>Promise<void>)=>()=>void;onPendingChange:(pending:boolean)=>void;onChange:(edits:unknown[])=>void;onRecalculate?:(input:RecalculateRequest)=>Promise<RecalculateResult>;onInspectImportedWorkbook?:(bytes:Uint8Array)=>Promise<XlsxModel>;onCaptureScreenSources?:()=>Promise<ScreenSourcesResult>;onCaptureScreenSource?:(input:{id:string})=>Promise<ScreenCaptureResult|null>})=>{
    spreadsheet.savedModelUpdate=props.savedModelUpdate;
    spreadsheet.recalculate=props.onRecalculate;
    spreadsheet.importWorkbook=props.onInspectImportedWorkbook;
    spreadsheet.captureSources=props.onCaptureScreenSources;spreadsheet.captureSource=props.onCaptureScreenSource;
    const text=useRef<string|null>(null);const latest=useRef(props);latest.current=props;
    useEffect(()=>props.registerBeforeSave(async()=>{
      if(text.current===null)return;
      latest.current.onChange([{sheetId:'sheet-1',row:0,column:0,kind:'string',value:text.current}]);
      text.current=null;latest.current.onPendingChange(false);
    }),[props.registerBeforeSave]);
    return <input aria-label="正在编辑的单元格" onChange={event=>{text.current=event.target.value;props.onPendingChange(true);}}/>;
  }};
});
it('connects Excel screenshot actions without capturing on load or writing a File',async()=>{
 vi.mocked(officeFileApi.inspect).mockResolvedValue({model:{format:'xlsx'}} as never);
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
 expect(officeFileApi.save).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 view.cleanup();
});
it('connects selected workbook imports to the read-only byte service without saving a File',async()=>{
 vi.mocked(officeFileApi.inspect).mockResolvedValue({model:{format:'xlsx'}} as never);
 const source={format:'xlsx',name:'source.xlsx'};
 vi.mocked(inspectImportedWorkbook).mockResolvedValue(source as never);
 const view=await mount();await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const bytes=new Uint8Array([80,75,3,4]);
 await expect(spreadsheet.importWorkbook!(bytes)).resolves.toBe(source);
 expect(inspectImportedWorkbook).toHaveBeenCalledExactlyOnceWith(bytes);
 expect(officeFileApi.save).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 view.cleanup();
});
it('calculates against the current File baseline without creating a version, including after saving',async()=>{
 const xlsx={format:'xlsx'};
 vi.mocked(officeFileApi.inspect).mockResolvedValue({model:xlsx} as never);
 vi.mocked(officeFileApi.save).mockResolvedValue({model:xlsx,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
 const result={cells:[]};vi.mocked(officeFileApi.recalculate).mockResolvedValue(result);
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const request={edits:[],reads:[]};
 await expect(spreadsheet.recalculate!(request)).resolves.toBe(result);
 expect(officeFileApi.recalculate).toHaveBeenLastCalledWith(binding,{...baseline,recalculation:request});
 expect(officeFileApi.save).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(false);
 fireEvent.change(input,{target:{value:'新值'}});await act(()=>view.flush());
 await spreadsheet.recalculate!(request);
 expect(officeFileApi.recalculate).toHaveBeenLastCalledWith(binding,{...baseline,versionNumber:3,expectedContentHash:'sha256:new',recalculation:request});
 view.cleanup();
});
it.each(['close','save'] as const)('rejects a calculation completed after %s changes its source context',async change=>{
 const xlsx={format:'xlsx'};
 vi.mocked(officeFileApi.inspect).mockResolvedValue({model:xlsx} as never);
 vi.mocked(officeFileApi.save).mockResolvedValue({model:xlsx,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
 let finish!:(result:RecalculateResult)=>void;
 vi.mocked(officeFileApi.recalculate).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 const calculation=spreadsheet.recalculate!({edits:[],reads:[]});
 const rejected=expect(calculation).rejects.toThrow(change==='close'?'文件已关闭或切换':'文件版本已变更');
 if(change==='close')view.cleanup();
 else{fireEvent.change(input,{target:{value:'新值'}});await act(()=>view.flush());}
 finish({cells:[]});await rejected;
 if(change!=='close')view.cleanup();
});
const binding={workspaceId:'workspace',generation:'generation'};
const baseline={object:{workspaceId:'workspace',scope:{kind:'project' as const,projectId:7},kind:'file' as const,id:'42'},versionNumber:2,expectedContentHash:'sha256:old'};
const model={format:'docx',nodes:[{id:'p0',text:'原文'}]};
beforeEach(()=>{officePreviewCache.clear();vi.clearAllMocks();wordFlush.wait=undefined;vi.mocked(officeFileApi.inspect).mockResolvedValue({model} as never);});
async function mount(readOnly=false, preview=false){
  const toolbar=document.createElement('div'),menuToolbar=document.createElement('span');document.body.append(menuToolbar,toolbar);
  let guard:(()=>Promise<void>)|undefined;
  const saved=vi.fn();const dirty=vi.fn();
  const result=render(<OfficeFileContent toolbar={toolbar} menuToolbar={menuToolbar} binding={binding} baseline={baseline} readOnly={readOnly} registerFlush={flush=>{guard=flush;return()=>{guard=undefined;};}} onDirtyChange={dirty} onSaved={saved}/>);
  if(!preview) {const edit=await screen.findByRole('button',{name:readOnly?'完整视图':'编辑'});await waitFor(()=>expect(edit).not.toBeDisabled());fireEvent.click(edit);}
  return{...result,saved,dirty,menuToolbar,toolbar,flush:()=>guard!(),cleanup:()=>{result.unmount();toolbar.remove();menuToolbar.remove();}};
}
it('loads the fixed File version, saves edits, and keeps the committed model for the next edit',async()=>{
  vi.mocked(officeFileApi.save).mockResolvedValue({model:{...model,nodes:[{id:'p0',text:'已修改'}]},commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
  const view=await mount();await screen.findByText('原文');
  expect(officeFileApi.inspect).toHaveBeenCalledWith(binding,baseline);
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  expect(screen.getByText('已修改')).toBeVisible();
  fireEvent.keyDown(screen.getByText('已修改'),{key:'s',metaKey:true});
  await waitFor(()=>expect(view.saved).toHaveBeenCalledWith(3,'sha256:new'));
  expect(screen.getByRole('status')).toHaveTextContent('已保存');
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));await act(()=>view.flush());
  expect(officeFileApi.save).toHaveBeenLastCalledWith(binding,expect.objectContaining({versionNumber:3,expectedContentHash:'sha256:new'}),expect.any(String));
  view.cleanup();
});
it('a failed close/save keeps the edited contents and rejects closing',async()=>{
  vi.mocked(officeFileApi.save).mockRejectedValue(new Error('文件版本冲突'));
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
 vi.mocked(officeFileApi.save).mockResolvedValue({model,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
 const view=await mount();fireEvent.change(await screen.findByRole('textbox',{name:'未提交的 Word 输入'}),{target:{value:'快速保存'}});
 let first!:Promise<void>,second!:Promise<void>;
 act(()=>{first=view.flush();second=view.flush();});
 const calls=vi.mocked(wordFlush.wait).mock.calls.length;
 await act(async()=>{release();await Promise.all([first,second]);});
 expect(calls).toBe(1);expect(officeFileApi.save).toHaveBeenCalledOnce();expect(view.saved).toHaveBeenCalledOnce();
 view.cleanup();
});
it('a fixed historical Office version is read only and closing creates no version',async()=>{
  const view=await mount(true);await screen.findByText('原文');
  expect(screen.getByRole('button',{name:'修改正文'})).toBeDisabled();expect(screen.queryByRole('button',{name:'保存'})).toBeNull();
  await view.flush();expect(officeFileApi.save).not.toHaveBeenCalled();view.cleanup();
});
it('closing commits pending spreadsheet input before taking the native save snapshot',async()=>{
  const xlsx={format:'xlsx'};
  vi.mocked(officeFileApi.inspect).mockResolvedValue({model:xlsx} as never);
  vi.mocked(officeFileApi.save).mockResolvedValue({model:xlsx,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
  const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
  fireEvent.change(input,{target:{value:'未按 Enter 的中文'}});
  expect(view.dirty).toHaveBeenLastCalledWith(true);expect(screen.getByRole('status')).toHaveTextContent('未保存');
  await act(()=>view.flush());
  expect(officeFileApi.save).toHaveBeenCalledWith(binding,expect.objectContaining({edits:[{sheetId:'sheet-1',row:0,column:0,kind:'string',value:'未按 Enter 的中文'}]}),expect.any(String));
  expect(view.dirty).toHaveBeenLastCalledWith(false);expect(screen.getByRole('status')).toHaveTextContent('已保存');view.cleanup();
});

it.each(['docx','pptx'] as const)('flushes pending %s input before creating the File save snapshot',async format=>{
 const inspected=format==='docx'?model:{format:'pptx'};
 vi.mocked(officeFileApi.inspect).mockResolvedValue({model:inspected} as never);
 vi.mocked(officeFileApi.save).mockResolvedValue({model:inspected,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
 const view=await mount();const input=await screen.findByRole('textbox',{name:format==='docx'?'未提交的 Word 输入':'未提交的 PPT 输入'});
 fireEvent.change(input,{target:{value:'未提交中文'}});expect(view.dirty).toHaveBeenLastCalledWith(true);
 if(format==='docx')fireEvent.click(screen.getByRole('button',{name:'Word 内保存'}));else await act(()=>view.flush());
 await waitFor(()=>expect(officeFileApi.save).toHaveBeenCalledWith(binding,expect.objectContaining({edits:format==='docx'?[{type:'text',nodeId:'p0',text:'未提交中文'}]:[{kind:'command',name:'slides:set-text',args:['未提交中文']}]}),expect.any(String)));
 expect(view.dirty).toHaveBeenLastCalledWith(false);view.cleanup();
});

it.each([{format:'docx',success:true},{format:'docx',success:false},{format:'pptx',success:true},{format:'pptx',success:false}])('returns the $format internal save receipt only after native completion (success=$success)',async({format,success})=>{
 const inspected=format==='docx'?model:{format};
 vi.mocked(officeFileApi.inspect).mockResolvedValue({model:inspected} as never);
 let resolveSave!:(result:never)=>void;let rejectSave!:(error:Error)=>void;
 vi.mocked(officeFileApi.save).mockImplementation(()=>new Promise((resolve,reject)=>{resolveSave=resolve;rejectSave=reject;}));
 const view=await mount();const input=await screen.findByRole('textbox',{name:format==='docx'?'未提交的 Word 输入':'未提交的 PPT 输入'});
 fireEvent.change(input,{target:{value:'内部保存中文'}});
 fireEvent.click(screen.getByRole('button',{name:format==='docx'?'Word 内保存':'PPT 内保存'}));
 await waitFor(()=>expect(officeFileApi.save).toHaveBeenCalledOnce());
 expect(screen.getByText('等待保存')).toBeVisible();expect(view.saved).not.toHaveBeenCalled();
 await act(async()=>{
  if(success)resolveSave({model:inspected,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
  else rejectSave(new Error('原件已变更'));
 });
 expect(await screen.findByText(success?'保存回执成功':'保存回执失败')).toBeVisible();
 if(!success){expect(screen.getByRole('alert')).toHaveTextContent('原件已变更');expect(view.dirty).toHaveBeenLastCalledWith(true);}
 view.cleanup();
});


it('binds Word remote image requests to the current File baseline and rejects late receipts',async()=>{
  const image={mime:'image/png' as const,base64:'aW1hZ2U='};
  vi.mocked(desktopApi.fetchEditorRemoteImage).mockResolvedValue(image);
  vi.mocked(officeFileApi.save).mockResolvedValue({model,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
  const view=await mount();await screen.findByText('原文');
  expect(desktopApi.fetchEditorRemoteImage).not.toHaveBeenCalled();
  await expect(wordFlush.fetchImage!('https://images.example.test/a.png')).resolves.toBe(image);
  expect(desktopApi.fetchEditorRemoteImage).toHaveBeenLastCalledWith({binding,document:baseline,url:'https://images.example.test/a.png'});
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));await act(()=>view.flush());
  await wordFlush.fetchImage!('https://images.example.test/b.png');
  expect(desktopApi.fetchEditorRemoteImage).toHaveBeenLastCalledWith({binding,document:{...baseline,versionNumber:3,expectedContentHash:'sha256:new'},url:'https://images.example.test/b.png'});
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

it('rejects a Word remote image receipt after a save changes the baseline',async()=>{
  const image={mime:'image/png' as const,base64:'aW1hZ2U='};
  let finish!:(value:typeof image)=>void;
  vi.mocked(desktopApi.fetchEditorRemoteImage).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  vi.mocked(officeFileApi.save).mockResolvedValue({model,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
  const view=await mount();await screen.findByText('原文');
  const reading=wordFlush.fetchImage!('https://images.example.test/stale.png');
  const rejected=expect(reading).rejects.toThrow('文件版本已变更');
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));await act(()=>view.flush());
  finish(image);await rejected;view.cleanup();
});

it('uses the same mounted Word renderer read-only until Edit, without creating a File version',async()=>{
 const view=await mount(false,true);
 const input=await screen.findByRole('textbox',{name:'未提交的 Word 输入'});
 expect(input).toHaveAttribute('readonly');
 expect(officeFileApi.save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'编辑'}));
 expect(screen.getByRole('textbox',{name:'未提交的 Word 输入'})).toBe(input);
 expect(input).not.toHaveAttribute('readonly');
 view.cleanup();
});
it('does not leave the editor when save-and-preview fails',async()=>{
 vi.mocked(officeFileApi.save).mockRejectedValue(new Error('磁盘写入失败'));
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
 vi.mocked(officeFileApi.save).mockImplementation(()=>new Promise(resolve=>{finish=resolve as typeof finish;}) as never);
 const view=await mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
 fireEvent.click(screen.getByRole('button',{name:'保存并预览'}));
 await waitFor(()=>expect(officeFileApi.save).toHaveBeenCalledOnce());
 // A queued editor/composition callback can arrive after the UI has frozen.
 fireEvent.change(screen.getByRole('textbox',{name:'未提交的 Word 输入'}),{target:{value:'排队的新输入'}});
 await act(async()=>finish({model:{...model,nodes:[{id:'p0',text:'已修改'}]},commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}}));
 expect(screen.getByRole('button',{name:'保存并预览'})).toBeVisible();
 expect(screen.getByRole('status')).toHaveTextContent('未保存');
 expect(screen.getByRole('textbox',{name:'未提交的 Word 输入'})).toHaveValue('排队的新输入');
 view.cleanup();
});

it('automatically saves settled edits and cancels the old timer when closing',async()=>{
 vi.mocked(officeFileApi.save).mockResolvedValue({model,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:auto',noChange:false},versionPath:null}} as never);
 const view=await mount();await screen.findByText('原文');vi.useFakeTimers();
 try {
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  await act(()=>vi.advanceTimersByTimeAsync(1199));expect(officeFileApi.save).not.toHaveBeenCalled();
  await act(()=>vi.advanceTimersByTimeAsync(1));expect(officeFileApi.save).toHaveBeenCalledOnce();
  expect(view.saved).toHaveBeenCalledWith(3,'sha256:auto');
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));view.cleanup();
  await act(()=>vi.advanceTimersByTimeAsync(2000));expect(officeFileApi.save).toHaveBeenCalledOnce();
 } finally {vi.useRealTimers();}
});
it('waits for pending input and does not loop after an automatic save fails',async()=>{
 vi.mocked(officeFileApi.save).mockRejectedValue(new Error('自动保存冲突'));
 const view=await mount();await screen.findByText('原文');vi.useFakeTimers();
 try {
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  fireEvent.change(screen.getByRole('textbox',{name:'未提交的 Word 输入'}),{target:{value:'组合输入'}});
  await act(()=>vi.advanceTimersByTimeAsync(2000));expect(officeFileApi.save).not.toHaveBeenCalled();
  // Explicit save flushes the active input; a failure leaves its draft available.
  await act(async()=>{await expect(view.flush()).rejects.toThrow('自动保存冲突');});
  await act(()=>vi.advanceTimersByTimeAsync(5000));expect(officeFileApi.save).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');view.cleanup();
 } finally {vi.useRealTimers();}
});

it('routes the first-line File menu to the current renderer even in historical preview',async()=>{
 const view=await mount(true,true);await screen.findByText('原文');
 const trigger=screen.getByRole('button',{name:'文件菜单'});
 expect(view.menuToolbar).toContainElement(trigger);expect(view.toolbar).not.toContainElement(trigger);
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('menuitem',{name:'导出 HTML'}));
 await waitFor(()=>expect(wordFlush.output).toHaveBeenCalledWith('html'));
 expect(officeFileApi.save).not.toHaveBeenCalled();view.cleanup();
});

it('rejects a save that becomes read-only while beforeSave is pending',async()=>{
 let release!:()=>void;
 wordFlush.wait=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
 vi.mocked(officeFileApi.save).mockResolvedValue({model,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
 const view=await mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'修改正文'}));expect(view.dirty).toHaveBeenLastCalledWith(true);
 let pending!:Promise<void>;act(()=>{pending=view.flush();});
 const result=pending.then(()=>null,reason=>reason);
 await waitFor(()=>expect(wordFlush.wait).toHaveBeenCalledOnce());expect(officeFileApi.save).not.toHaveBeenCalled();
 const nextSaved=vi.fn();
 view.rerender(<OfficeFileContent toolbar={view.toolbar} menuToolbar={view.menuToolbar} binding={binding} baseline={baseline} readOnly registerFlush={()=>()=>{}} onDirtyChange={view.dirty} onSaved={nextSaved}/>);
 let failure:unknown;await act(async()=>{release();failure=await result;});
 expect(officeFileApi.save).not.toHaveBeenCalled();expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain('只读');
 expect(screen.getByText('已修改')).toBeVisible();expect(screen.getByRole('button',{name:'修改正文'})).toBeDisabled();
 expect(screen.getByRole('status')).toHaveTextContent('历史版本 · 只读');expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');
 expect(view.saved).not.toHaveBeenCalled();expect(nextSaved).not.toHaveBeenCalled();expect(view.dirty).toHaveBeenLastCalledWith(true);
 view.cleanup();
});

it('sends Excel an explicit matching model receipt only after native persistence succeeds',async()=>{
 const previous={format:'xlsx'},current={format:'xlsx',name:'saved.xlsx'};
 vi.mocked(officeFileApi.inspect).mockResolvedValue({model:previous} as never);
 vi.mocked(officeFileApi.save).mockResolvedValue({model:current,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
 const view=await mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
 expect(spreadsheet.savedModelUpdate).toBeUndefined();fireEvent.change(input,{target:{value:'已修改'}});await act(()=>view.flush());
 expect(spreadsheet.savedModelUpdate?.previous).toBe(previous);expect(spreadsheet.savedModelUpdate?.current).toBe(current);
 view.cleanup();
});

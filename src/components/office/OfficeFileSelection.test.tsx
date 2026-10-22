import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {beforeEach, expect, it, vi} from 'vitest';
import {OfficeFileContent} from './OfficeFileContent';
import {officePreviewCache} from '../../lib/office-preview-cache';
import {useProjectContentStore} from '../../state/project-content-store';
import {useDshFileReferences} from '../../lib/dsh-host-events';
import type {OfficeSelectionRequest} from '../../services/officeSelectionApi';
const mocks = vi.hoisted(() => ({register:vi.fn(),bind:vi.fn(),unregister:vi.fn(),claim:vi.fn(),reply:vi.fn(),listen:vi.fn(),stop:vi.fn(),capture:vi.fn(),apply:vi.fn(),save:vi.fn(),inspect:vi.fn(),start:vi.fn(),sessions:vi.fn(),select:vi.fn(),binding:vi.fn(),open:vi.fn(),request:vi.fn(),editBeforeResolve:false,receive:undefined as ((request:OfficeSelectionRequest)=>void)|undefined}));
vi.mock('../../services/officeSelectionApi',()=>({officeSelectionApi:{register:mocks.register,bind:mocks.bind,unregister:mocks.unregister,claim:mocks.claim,reply:mocks.reply,listen:mocks.listen}}));
vi.mock('../../services/officeFileApi',()=>({officeFileApi:{inspect:mocks.inspect,save:mocks.save}}));
vi.mock('../../services/dshAssistantApi',()=>({dshAssistantApi:{start:mocks.start,sessions:mocks.sessions,selectSession:mocks.select}}));
vi.mock('../../services/recordDocumentApi',()=>({recordDocumentApi:{bindingGet:mocks.binding}}));
vi.mock('../../services/projectContentApi',()=>({openProjectContent:mocks.open}));
vi.mock('../../lib/dsh-host-events',async()=>({...await vi.importActual('../../lib/dsh-host-events'),requestDshOfficeSelection:mocks.request}));
vi.mock('./office-component-loader',async()=>{
 const {useEffect,useRef}=await import('react');
 const Editor=(props:any)=>{
  const latest=useRef(props);latest.current=props;
  useEffect(()=>props.registerSelection?.({captureSelection:mocks.capture,applySelection:async(input:unknown)=>{const pending=mocks.apply(input);if(mocks.editBeforeResolve)latest.current.onChange([{type:'text',nodeId:'p0',text:'AI 修改'}]);const value=await pending;if(!mocks.editBeforeResolve)latest.current.onChange([{type:'text',nodeId:'p0',text:'AI 修改'}]);return value;}}),[props.registerSelection]);
  useEffect(()=>props.registerBeforeSave(async()=>{}),[props.registerBeforeSave]);
  return <button disabled={props.readOnly} onClick={()=>props.onChange([{type:'text',nodeId:'p0',text:'手工修改'}])}>手工修改</button>;
 };return {loadDocxEditor:async()=>({DocxEditor:Editor}),loadXlsxEditor:async()=>({XlsxEditor:Editor}),loadPptxEditor:async()=>({PptxEditor:Editor})};
});
const binding={workspaceId:'workspace',generation:'generation'},object={workspaceId:'workspace',scope:{kind:'project' as const,projectId:7},kind:'file' as const,id:'42'};
const baseline={object,versionNumber:2,expectedContentHash:'sha256:old'},model={format:'docx',nodes:[{id:'p0',text:'原文'}]};
const scope={workspaceId:'workspace',projectId:7};
beforeEach(()=>{
 vi.clearAllMocks();mocks.editBeforeResolve=false;officePreviewCache.clear();useProjectContentStore.setState({layouts:{}});useDshFileReferences.setState({workspaceRoot:'/workspace',pending:[]});
 const store=useProjectContentStore.getState();store.open(scope,{kind:'session',id:'session-a',title:'会话'});store.open(scope,{kind:'file',id:42,title:'报告.docx'});
 mocks.inspect.mockResolvedValue({model});mocks.save.mockResolvedValue({model:{...model},commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}});
 mocks.listen.mockImplementation(async(callback)=>{mocks.receive=callback;return mocks.stop;});mocks.capture.mockResolvedValue({selectionId:'selection-a',text:'选中的正文'});mocks.apply.mockResolvedValue({text:'AI 修改'});
 mocks.binding.mockResolvedValue(binding);mocks.sessions.mockResolvedValue([{id:'session-a',title:'会话',running:false}]);mocks.start.mockResolvedValue(undefined);mocks.select.mockResolvedValue('session-new');
 mocks.register.mockResolvedValue(undefined);mocks.bind.mockResolvedValue(undefined);mocks.unregister.mockResolvedValue(undefined);mocks.claim.mockResolvedValue(undefined);mocks.reply.mockResolvedValue(undefined);
 mocks.open.mockImplementation(async(input)=>{input.beforeOpen();return {};});
});
async function mount(){const toolbar=document.createElement('div');document.body.append(toolbar);let flush=async()=>{};const view=render(<OfficeFileContent fileName="报告.docx" toolbar={toolbar} binding={binding} baseline={baseline} readOnly={false} registerFlush={fn=>{flush=fn;return()=>{};}} onDirtyChange={()=>{}} onSaved={()=>{}}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'编辑'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'编辑'}));return{...view,flush:()=>flush(),close(){view.unmount();toolbar.remove();}};}
it('quotes through the public toolbar, binds an existing session, handles native draft edit and saves normally',async()=>{
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.open).toHaveBeenCalled());
 expect(mocks.register).toHaveBeenCalledWith(binding,expect.objectContaining({object,selectionId:'selection-a',format:'docx',text:'选中的正文'}));
 expect(mocks.bind).toHaveBeenCalledWith(binding,{selectionId:'selection-a',sessionId:'session-a'});expect(mocks.register.mock.invocationCallOrder[0]).toBeLessThan(mocks.bind.mock.invocationCallOrder[0]);
 expect(mocks.request).toHaveBeenCalledWith(7,'报告.docx','session-a',{selectionId:'selection-a',format:'docx'});expect(mocks.select).not.toHaveBeenCalled();
 const editorId=mocks.register.mock.calls[0][1].editorId;
 await act(async()=>mocks.receive!({binding,editorId,selectionId:'selection-a',requestId:'edit-a',change:{text:'AI 修改'}}));
 await waitFor(()=>expect(mocks.reply).toHaveBeenCalledWith(binding,{editorId,selectionId:'selection-a',requestId:'edit-a',text:'AI 修改'}));
 expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.apply.mock.invocationCallOrder[0]);expect(mocks.save).not.toHaveBeenCalled();
 await act(()=>view.flush());expect(mocks.save).toHaveBeenCalledWith(binding,expect.objectContaining({edits:[{type:'text',nodeId:'p0',text:'AI 修改'}]}),expect.any(String));view.close();
});
it('saves pending manual edits and requires reselection instead of capturing a replacement renderer',async()=>{
 const view=await mount();fireEvent.click(screen.getByRole('button',{name:'手工修改'}));fireEvent.click(screen.getByRole('button',{name:'引用选区'}));
 await screen.findByText('文件已保存，请重新选择内容后再次引用选区');expect(mocks.save).toHaveBeenCalled();expect(mocks.capture).not.toHaveBeenCalled();expect(mocks.register).not.toHaveBeenCalled();expect(screen.queryByText('保存失败')).not.toBeInTheDocument();view.close();
});
it('unregisters on close and ignores late native requests',async()=>{
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.bind).toHaveBeenCalled());const editorId=mocks.register.mock.calls[0][1].editorId;view.close();
 await waitFor(()=>expect(mocks.unregister).toHaveBeenCalledWith(binding,editorId));await act(async()=>mocks.receive!({binding,editorId,selectionId:'selection-a',requestId:'late',change:{text:'late'}}));expect(mocks.apply).not.toHaveBeenCalled();
});
it('creates a session when no opened session is available',async()=>{
 useProjectContentStore.setState({layouts:{}});useProjectContentStore.getState().open(scope,{kind:'file',id:42,title:'报告.docx'});
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.open).toHaveBeenCalled());
 expect(mocks.select).toHaveBeenCalledExactlyOnceWith(null,7);expect(mocks.bind).toHaveBeenCalledWith(binding,{selectionId:'selection-a',sessionId:'session-new'});view.close();
});
it('reports renderer rejection through the native receipt and leaves File saving untouched',async()=>{
 mocks.apply.mockRejectedValue(new Error('选区已失效'));
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.bind).toHaveBeenCalled());const editorId=mocks.register.mock.calls[0][1].editorId;
 await act(async()=>mocks.receive!({binding,editorId,selectionId:'selection-a',requestId:'bad',change:{text:'bad'}}));
 await screen.findByText('选区已失效');expect(mocks.reply).toHaveBeenCalledWith(binding,{editorId,selectionId:'selection-a',requestId:'bad',error:'选区已失效'});expect(mocks.save).not.toHaveBeenCalled();view.close();
});
it('invalidates the reference when leaving edit mode and rejects late events before claiming',async()=>{
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.bind).toHaveBeenCalled());const editorId=mocks.register.mock.calls[0][1].editorId;
 fireEvent.click(screen.getByRole('button',{name:'保存并预览'}));await waitFor(()=>expect(mocks.unregister).toHaveBeenCalledWith(binding,editorId));
 await act(async()=>mocks.receive!({binding,editorId,selectionId:'selection-a',requestId:'late',change:{text:'late'}}));expect(mocks.claim).not.toHaveBeenCalled();expect(mocks.apply).not.toHaveBeenCalled();view.close();
});
it('does not create or bind a session after the workspace changes during capture registration',async()=>{
 let complete!:()=>void;mocks.register.mockImplementation(()=>new Promise<void>(resolve=>{complete=resolve;}));
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.register).toHaveBeenCalled());
 await act(async()=>{useDshFileReferences.setState({workspaceRoot:'/other'});complete();});
 await waitFor(()=>expect(mocks.unregister).toHaveBeenCalled());expect(mocks.start).not.toHaveBeenCalled();expect(mocks.bind).not.toHaveBeenCalled();expect(mocks.open).not.toHaveBeenCalled();view.close();
});

it('prefers the selected session in the neighboring pane and leaves the document visible',async()=>{
 const store=useProjectContentStore.getState();store.split(scope);store.open(scope,{kind:'session',id:'session-b',title:'另一会话'},{paneId:'left'});
 mocks.sessions.mockResolvedValue([{id:'session-a',title:'会话',running:false},{id:'session-b',title:'另一会话',running:false}]);
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.open).toHaveBeenCalled());
 expect(mocks.bind).toHaveBeenCalledWith(binding,{selectionId:'selection-a',sessionId:'session-b'});
 const layout=Object.values(useProjectContentStore.getState().layouts)[0],file=layout.tabs.find(tab=>tab.object.kind==='file')!;
 expect(layout.panes.find(pane=>pane.id==='right')?.selectedTabId).toBe(file.id);expect(mocks.open.mock.calls[0][0].paneId).toBe('left');view.close();
});
it('does not expose selection quoting for a read-only historical File',async()=>{
 const toolbar=document.createElement('div');document.body.append(toolbar);
 const view=render(<OfficeFileContent fileName="报告.docx" toolbar={toolbar} binding={binding} baseline={baseline} readOnly={true} registerFlush={()=>()=>{}} onDirtyChange={()=>{}} onSaved={()=>{}}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'完整视图'})).not.toBeDisabled());fireEvent.click(screen.getByRole('button',{name:'完整视图'}));
 expect(screen.queryByRole('button',{name:'引用选区'})).not.toBeInTheDocument();expect(mocks.listen).not.toHaveBeenCalled();view.unmount();toolbar.remove();
});

it('keeps iframe selection focus on pointer and mouse down before quoting',async()=>{
 const view=await mount(),button=await screen.findByRole('button',{name:'引用选区'});
 expect(fireEvent.pointerDown(button)).toBe(false);expect(fireEvent.mouseDown(button)).toBe(false);
 expect(mocks.capture).not.toHaveBeenCalled();fireEvent.click(button);await waitFor(()=>expect(mocks.capture).toHaveBeenCalled());view.close();
});
it('acknowledges an applied draft while an overlapping save temporarily locks the editor',async()=>{
 mocks.editBeforeResolve=true;let finishEdit!:(result:{text:string})=>void,finishSave!:(result:unknown)=>void;
 mocks.apply.mockImplementation(()=>new Promise(resolve=>{finishEdit=resolve;}));
 mocks.save.mockImplementation(()=>new Promise(resolve=>{finishSave=resolve;}));
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.bind).toHaveBeenCalled());const editorId=mocks.register.mock.calls[0][1].editorId;
 await act(async()=>mocks.receive!({binding,editorId,selectionId:'selection-a',requestId:'overlap',change:{text:'AI 修改'}}));await waitFor(()=>expect(mocks.apply).toHaveBeenCalled());
 let saving!:Promise<void>;await act(async()=>{saving=view.flush();});await screen.findByText('正在保存…');
 await act(async()=>finishEdit({text:'AI 修改'}));await waitFor(()=>expect(mocks.reply).toHaveBeenCalledWith(binding,{editorId,selectionId:'selection-a',requestId:'overlap',text:'AI 修改'}));
 await act(async()=>{finishSave({model:{...model},commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}});await saving;});view.close();
});

it('claims a live reference during a temporary save lock and replies with an error without applying',async()=>{
 let finishSave!:(result:unknown)=>void;
 mocks.save.mockImplementation(()=>new Promise(resolve=>{finishSave=resolve;}));
 const view=await mount();fireEvent.click(await screen.findByRole('button',{name:'引用选区'}));await waitFor(()=>expect(mocks.bind).toHaveBeenCalled());const editorId=mocks.register.mock.calls[0][1].editorId;
 fireEvent.click(screen.getByRole('button',{name:'手工修改'}));let saving!:Promise<void>;await act(async()=>{saving=view.flush();});await screen.findByText('正在保存…');
 await act(async()=>mocks.receive!({binding,editorId,selectionId:'selection-a',requestId:'locked',change:{text:'不应修改'}}));
 await waitFor(()=>expect(mocks.reply).toHaveBeenCalledWith(binding,{editorId,selectionId:'selection-a',requestId:'locked',error:'Office 文件只读或正在保存，请稍后重新引用'}));
 expect(mocks.claim).toHaveBeenCalledWith(binding,{editorId,selectionId:'selection-a',requestId:'locked'});expect(mocks.apply).not.toHaveBeenCalled();
 await act(async()=>{finishSave({model:{...model},commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}});await saving;});view.close();
});

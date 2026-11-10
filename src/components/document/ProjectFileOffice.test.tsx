import {officePreviewCache} from '../../lib/office-preview-cache';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {ProjectFileContent} from './ProjectFileContent';
import {projectFileApi} from '../../services/projectFileApi';
import {fileDocumentApi} from '../../services/fileDocumentApi';
import {recordDocumentApi} from '../../services/recordDocumentApi';
import {fileWorkingApi} from '../../services/fileWorkingApi';
import {queryKeys} from '../../lib/queryKeys';
vi.mock('../../services/fileDocumentApi',()=>({fileDocumentApi:{versionsList:vi.fn()}}));
vi.mock('../../services/recordDocumentApi',()=>({recordDocumentApi:{bindingGet:vi.fn()}}));
vi.mock('../../services/projectFileApi',()=>({projectFileApi:{resolve:vi.fn(),readBytes:vi.fn(),applications:vi.fn(),openWith:vi.fn(),openLocal:vi.fn()},fileBytes:()=>new Uint8Array([80,75])}));
vi.mock('../../services/officeFileApi',()=>({officeFileApi:{inspectView:vi.fn()}}));
vi.mock('../../services/fileWorkingApi',()=>({fileWorkingApi:{open:vi.fn(),saveOffice:vi.fn(),activity:vi.fn(),close:vi.fn(),tick:vi.fn()}}));
vi.mock('../office/DocxEditor',()=>({DocxEditor:(props:{model:{nodes:{text:string}[]};edits:{text:string}[];readOnly:boolean;onChange:(edits:unknown[])=>void})=><div>
  <p>{props.edits[0]?.text??props.model.nodes[0].text}</p><button disabled={props.readOnly} onClick={()=>props.onChange([{type:'text',nodeId:'p0',text:'保留草稿'}])}>编辑文档</button>
</div>}));
const binding={workspaceId:'w',generation:'g'};
const object={workspaceId:'w',scope:{kind:'project' as const,projectId:2},kind:'file' as const,id:'7'};
let current:number;
function status(){return{object,revision:current,contentHash:`hash${current}`,archivedVersionNumber:2,pendingArchive:current>2,lastActivityAtMs:0,archiveDueAtMs:900000,noChange:false};}
function opened(){return{...status(),sessionId:`session${current}`,name:'sample.docx',base64:'UEs=',format:'docx',model:{format:'docx',nodes:[{id:'p0',text:current===2?'原文':'保留草稿'}]}};}

function resolved(){return{object,relativePath:'sample.docx',name:'sample.docx',versionNumber:current,contentHash:`hash${current}`,state:'ready' as const,reason:null};}
beforeEach(()=>{officePreviewCache.clear();
  vi.resetAllMocks();current=2;
  vi.mocked(fileWorkingApi.close).mockResolvedValue();
  vi.mocked(fileWorkingApi.activity).mockImplementation(async()=>status());
  vi.mocked(fileWorkingApi.tick).mockImplementation(async()=>status());
  vi.mocked(projectFileApi.applications).mockResolvedValue([]);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.resolve).mockImplementation(async()=>resolved());
  vi.mocked(fileDocumentApi.versionsList).mockImplementation(async()=>({object,currentVersionNumber:current,currentContentHash:`hash${current}`,versions:[{id:String(current),versionNumber:current,name:'sample.docx',createdAt:'2026-10-13',contentHash:`hash${current}`,isCurrent:true}],nextCursor:null}));
  vi.mocked(projectFileApi.readBytes).mockImplementation(async(_,input)=>({object,versionNumber:input.versionNumber,contentHash:`hash${input.versionNumber}`,name:'sample.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byteLength:2,base64:'UEs='}));
  vi.mocked(fileWorkingApi.open).mockImplementation(async()=>opened() as never);
  vi.mocked(fileWorkingApi.saveOffice).mockImplementation(async()=>{current=3;return status();});
});
async function mount(){
 const client=new QueryClient();let close:()=>Promise<void>=async()=>{};
 const wrap=(visible=true)=><QueryClientProvider client={client}><ProjectFileContent workspaceRoot="/workspace" projectId={2} fileId={7} visible={visible} focused registerCloseGuard={guard=>{close=guard;return()=>{};}}/></QueryClientProvider>;
 const view=render(wrap());{const edit=await screen.findByRole('button',{name:'编辑',exact:true});await waitFor(()=>expect(edit).not.toBeDisabled());fireEvent.click(edit);}return{...view,client,wrap,close:()=>close()};
}
it('revalidates a clean Office tab against an externally registered version',async()=>{
 const view=await mount();await screen.findByText('原文');
 current=3;
 vi.mocked(fileWorkingApi.open).mockResolvedValueOnce({...opened(),model:{format:'docx',nodes:[{id:'p0',text:'外部保存的内容'}]}} as never);
 fireEvent.click(screen.getByRole('button',{name:'刷新',exact:true}));
 await screen.findByText('外部保存的内容');
 expect(screen.getByRole('button',{name:'文件查看版本'})).toHaveTextContent('当前内容');
 expect(fileWorkingApi.open).toHaveBeenLastCalledWith(binding,object);
 expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();view.unmount();
});
it('keeps an unsaved Office draft and its baseline when an external version arrives',async()=>{
 const view=await mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));
 current=3;
 // The native change notification invalidates this cache entry after resolve.
 view.client.setQueryData(queryKeys.documentVersions(7),[]);
 await act(async()=>{await view.client.invalidateQueries({queryKey:queryKeys.documentVersions(7)});});
 expect(screen.getByText('保留草稿')).toBeVisible();
 expect(fileWorkingApi.open).toHaveBeenCalledOnce();
 vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new Error('文件已在外部修改，请处理保存冲突'));
 fireEvent.click(screen.getByRole('button',{name:'刷新',exact:true}));
 await waitFor(()=>expect(screen.getAllByRole('alert').some(alert=>alert.textContent?.includes('文件已在外部修改'))).toBe(true));
 expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({object,sessionId:'session2',expectedRevision:2,expectedContentHash:'hash2',edits:[{type:'text',nodeId:'p0',text:'保留草稿'}]}),expect.any(String));
 expect(screen.getByText('保留草稿')).toBeVisible();
 expect(screen.getByRole('button',{name:'文件查看版本'})).toHaveTextContent('当前内容');
 expect(fileWorkingApi.open).toHaveBeenCalledOnce();view.unmount();
});
it('closing a hidden edited Office tab commits its fixed baseline; reopening reads the new File version',async()=>{
 const view=await mount();await screen.findByText('原文');fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));
 expect(projectFileApi.readBytes).not.toHaveBeenCalled();
 view.rerender(view.wrap(false));expect(screen.getByText('保留草稿')).toBeInTheDocument();
 await act(()=>view.close());
 expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({object,sessionId:'session2',expectedRevision:2,expectedContentHash:'hash2'}),expect.any(String));
 view.unmount();const reopened=await mount();await screen.findByText('保留草稿');
 expect(fileWorkingApi.open).toHaveBeenCalledTimes(2);
 expect(screen.getByRole('button',{name:'文件查看版本'})).toHaveTextContent('当前内容');reopened.unmount();
});
it('keeps the working session across hiding and showing an edited tab',async()=>{
 const view=await mount();await screen.findByText('原文');fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));view.rerender(view.wrap(false));view.rerender(view.wrap());
 expect(screen.getByText('保留草稿')).toBeVisible();expect(fileWorkingApi.open).toHaveBeenCalledOnce();
 expect(fileWorkingApi.close).not.toHaveBeenCalled();
 await act(()=>view.close());expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();view.unmount();
 await waitFor(()=>expect(fileWorkingApi.close).toHaveBeenCalledOnce());
});
it.each(['default','selected'])('flushes Office edits before %s external open',async mode=>{
 vi.mocked(projectFileApi.applications).mockResolvedValue([{id:'viewer',name:'Viewer',icon:null,isDefault:true}]);
 const view=await mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));
 let finish!:()=>void;
 vi.mocked(fileWorkingApi.saveOffice).mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>{current=3;resolve(status());};}));
 if(mode==='default')fireEvent.click(screen.getByRole('button',{name:'在外部应用打开当前原件'}));
 else{
  fireEvent.click(screen.getByRole('button',{name:'选择其他应用打开当前原件'}));
  fireEvent.click(await screen.findByRole('button',{name:'Viewer（默认）'}));
 }
 await waitFor(()=>expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce());
 expect(projectFileApi.openLocal).not.toHaveBeenCalled();expect(projectFileApi.openWith).not.toHaveBeenCalled();
 await act(async()=>finish());
 if(mode==='default')await waitFor(()=>expect(projectFileApi.openLocal).toHaveBeenCalledWith(binding,object));
 else await waitFor(()=>expect(projectFileApi.openWith).toHaveBeenCalledWith(binding,object,'viewer'));
 view.unmount();
});
it('keeps the latest Office draft when saving before a version switch fails',async()=>{
 vi.mocked(fileDocumentApi.versionsList).mockResolvedValueOnce({object,currentVersionNumber:2,currentContentHash:'hash2',versions:[{id:'2',versionNumber:2,name:'sample.docx',createdAt:'2026-10-13',contentHash:'hash2',isCurrent:true},{id:'1',versionNumber:1,name:'sample.docx',createdAt:'2026-10-12',contentHash:'hash1',isCurrent:false}],nextCursor:null});
 const view=await mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));
 vi.mocked(fileWorkingApi.saveOffice).mockRejectedValueOnce(new Error('保存冲突'));
 fireEvent.click(screen.getByRole('button',{name:'文件查看版本'}));
 fireEvent.click(await screen.findByRole('menuitemradio',{name:'v1',exact:true}));
 await waitFor(()=>expect(screen.getAllByRole('alert').some(alert=>alert.textContent==='保存冲突')).toBe(true));
 expect(screen.getByRole('button',{name:'文件查看版本'})).toHaveTextContent('当前内容');
 expect(screen.getByText('保留草稿')).toBeVisible();
 expect(fileWorkingApi.open).toHaveBeenCalledOnce();view.unmount();
});

it('reads current working bytes independently of archived hash and keeps its session for own save invalidation',async()=>{
 const onSourceReady=vi.fn();
 vi.mocked(fileWorkingApi.open).mockResolvedValueOnce({...opened(),revision:9,contentHash:'working9',pendingArchive:true} as never);
 vi.mocked(fileWorkingApi.saveOffice).mockResolvedValueOnce({...status(),revision:10,contentHash:'working10',pendingArchive:true});
 vi.mocked(fileWorkingApi.tick).mockResolvedValue({...status(),revision:10,contentHash:'working10',pendingArchive:true});
 const client=new QueryClient();let close!:()=>Promise<void>;
 const view=render(<QueryClientProvider client={client}><ProjectFileContent workspaceRoot="/workspace" projectId={2} fileId={7} visible focused onSourceReady={onSourceReady} registerCloseGuard={guard=>{close=guard;return()=>{}}}/></QueryClientProvider>);
 const edit=await screen.findByRole('button',{name:'编辑',exact:true});await waitFor(()=>expect(edit).not.toBeDisabled());fireEvent.click(edit);
 expect(await screen.findByText('原文')).toBeVisible();expect(onSourceReady).toHaveBeenLastCalledWith(null);
 fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));await act(()=>close());
 expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({sessionId:'session2',expectedRevision:9,expectedContentHash:'working9'}),expect.any(String));
 client.setQueryData(queryKeys.documentVersions(7),[]);
 await act(()=>client.invalidateQueries({queryKey:queryKeys.documentVersions(7)}));
 expect(fileWorkingApi.open).toHaveBeenCalledOnce();expect(fileWorkingApi.close).not.toHaveBeenCalled();
 expect(screen.getByRole('button',{name:'文件查看版本'})).toHaveTextContent('当前内容');view.unmount();
});

it('updates archived history metadata without reopening the live working editor',async()=>{
 const view=await mount();await screen.findByText('原文');
 const before=vi.mocked(fileDocumentApi.versionsList).mock.calls.length;
 vi.mocked(fileWorkingApi.tick).mockResolvedValueOnce({...status(),archivedVersionNumber:3,pendingArchive:false});
 vi.mocked(fileDocumentApi.versionsList).mockResolvedValueOnce({object,currentVersionNumber:3,currentContentHash:'hash2',versions:[{id:'3',versionNumber:3,name:'sample.docx',createdAt:'2026-11-01',contentHash:'hash2',isCurrent:true}],nextCursor:null});
 view.client.setQueryData(queryKeys.documentVersions(7),[]);
 await act(()=>view.client.invalidateQueries({queryKey:queryKeys.documentVersions(7)}));
 await waitFor(()=>expect(fileDocumentApi.versionsList).toHaveBeenCalledTimes(before+1));
 fireEvent.click(screen.getByRole('button',{name:'文件查看版本'}));
 expect(await screen.findByRole('menuitemradio',{name:'v3',exact:true})).toBeVisible();
 expect(screen.getByRole('menuitemradio',{name:'当前内容',exact:true})).toHaveAttribute('aria-checked','true');
 expect(fileWorkingApi.open).toHaveBeenCalledOnce();expect(fileWorkingApi.close).not.toHaveBeenCalled();view.unmount();
});

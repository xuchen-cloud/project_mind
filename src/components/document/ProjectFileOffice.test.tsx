import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {ProjectFileContent} from './ProjectFileContent';
import {projectFileApi} from '../../services/projectFileApi';
import {fileDocumentApi} from '../../services/fileDocumentApi';
import {recordDocumentApi} from '../../services/recordDocumentApi';
import {officeFileApi} from '../../services/officeFileApi';
vi.mock('../../services/fileDocumentApi',()=>({fileDocumentApi:{versionsList:vi.fn()}}));
vi.mock('../../services/recordDocumentApi',()=>({recordDocumentApi:{bindingGet:vi.fn()}}));
vi.mock('../../services/projectFileApi',()=>({projectFileApi:{resolve:vi.fn(),readBytes:vi.fn(),applications:vi.fn(),openWith:vi.fn(),openLocal:vi.fn()},fileBytes:()=>new Uint8Array([80,75])}));
vi.mock('../../services/officeFileApi',()=>({officeFileApi:{inspect:vi.fn(),save:vi.fn()}}));
vi.mock('../office/DocxEditor',()=>({DocxEditor:(props:{model:{nodes:{text:string}[]};edits:{text:string}[];readOnly:boolean;onChange:(edits:unknown[])=>void})=><div>
  <p>{props.edits[0]?.text??props.model.nodes[0].text}</p><button disabled={props.readOnly} onClick={()=>props.onChange([{type:'text',nodeId:'p0',text:'保留草稿'}])}>编辑文档</button>
</div>}));
const binding={workspaceId:'w',generation:'g'};
const object={workspaceId:'w',scope:{kind:'project' as const,projectId:2},kind:'file' as const,id:'7'};
let current:number;
function resolved(){return{object,relativePath:'sample.docx',name:'sample.docx',versionNumber:current,contentHash:`hash${current}`,state:'ready' as const,reason:null};}
beforeEach(()=>{
  vi.resetAllMocks();current=2;
  vi.mocked(projectFileApi.applications).mockResolvedValue([]);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.resolve).mockImplementation(async()=>resolved());
  vi.mocked(fileDocumentApi.versionsList).mockImplementation(async()=>({object,currentVersionNumber:current,currentContentHash:`hash${current}`,versions:[{id:String(current),versionNumber:current,name:'sample.docx',createdAt:'2026-10-13',contentHash:`hash${current}`,isCurrent:true}],nextCursor:null}));
  vi.mocked(projectFileApi.readBytes).mockImplementation(async(_,input)=>({object,versionNumber:input.versionNumber,contentHash:`hash${input.versionNumber}`,name:'sample.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byteLength:2,base64:'UEs='}));
  vi.mocked(officeFileApi.inspect).mockImplementation(async(_,input)=>({model:{format:'docx',nodes:[{id:'p0',text:input.versionNumber===2?'原文':'保留草稿'}]}} as never));
  vi.mocked(officeFileApi.save).mockImplementation(async()=>{current=3;return{model:{format:'docx',nodes:[{id:'p0',text:'保留草稿'}]},commit:{receipt:{documentId:7,versionNumber:3,contentHash:'hash3',noChange:false},versionPath:null}} as never;});
});
function mount(){
 const client=new QueryClient();let close:()=>Promise<void>=async()=>{};
 const wrap=(visible=true)=><QueryClientProvider client={client}><ProjectFileContent workspaceRoot="/workspace" projectId={2} fileId={7} visible={visible} focused registerCloseGuard={guard=>{close=guard;return()=>{};}}/></QueryClientProvider>;
 const view=render(wrap());return{...view,wrap,close:()=>close()};
}
it('closing a hidden edited Office tab commits its fixed baseline; reopening reads the new File version',async()=>{
 const view=mount();await screen.findByText('原文');fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));
 expect(projectFileApi.readBytes).not.toHaveBeenCalled();
 view.rerender(view.wrap(false));expect(screen.getByText('保留草稿')).toBeInTheDocument();
 await act(()=>view.close());
 expect(officeFileApi.save).toHaveBeenCalledWith(binding,expect.objectContaining({object,versionNumber:2,expectedContentHash:'hash2'}),expect.any(String));
 view.unmount();const reopened=mount();await screen.findByText('保留草稿');
 expect(officeFileApi.inspect).toHaveBeenLastCalledWith(binding,{object,versionNumber:3,expectedContentHash:'hash3'});reopened.unmount();
});
it('a draft created during asynchronous tab revalidation survives the incoming clean baseline',async()=>{
 const view=mount();await screen.findByText('原文');view.rerender(view.wrap(false));
 let finish!:(value:ReturnType<typeof resolved>)=>void;
 vi.mocked(projectFileApi.resolve).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 view.rerender(view.wrap());await waitFor(()=>expect(finish).toBeTypeOf('function'));
 fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));await act(async()=>finish(resolved()));
 await waitFor(()=>expect(screen.queryByText('正在读取固定版本…')).not.toBeInTheDocument());
 expect(screen.getByText('保留草稿')).toBeVisible();expect(officeFileApi.inspect).toHaveBeenCalledOnce();
 await act(()=>view.close());expect(officeFileApi.save).toHaveBeenCalledOnce();view.unmount();
});
it.each(['default','selected'])('flushes Office edits before %s external open',async mode=>{
 vi.mocked(projectFileApi.applications).mockResolvedValue([{id:'viewer',name:'Viewer',icon:null,isDefault:true}]);
 const view=mount();await screen.findByText('原文');
 fireEvent.click(screen.getByRole('button',{name:'编辑文档'}));
 let finish!:()=>void;
 vi.mocked(officeFileApi.save).mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>{current=3;resolve({model:{format:'docx',nodes:[{id:'p0',text:'保留草稿'}]},commit:{receipt:{documentId:7,versionNumber:3,contentHash:'hash3',noChange:false},versionPath:null}} as never);};}));
 if(mode==='default')fireEvent.click(screen.getByRole('button',{name:'在外部应用打开当前原件'}));
 else{
  fireEvent.click(screen.getByRole('button',{name:'选择其他应用打开当前原件'}));
  fireEvent.click(await screen.findByRole('button',{name:'Viewer（默认）'}));
 }
 await waitFor(()=>expect(officeFileApi.save).toHaveBeenCalledOnce());
 expect(projectFileApi.openLocal).not.toHaveBeenCalled();expect(projectFileApi.openWith).not.toHaveBeenCalled();
 await act(async()=>finish());
 if(mode==='default')await waitFor(()=>expect(projectFileApi.openLocal).toHaveBeenCalledWith(binding,object));
 else await waitFor(()=>expect(projectFileApi.openWith).toHaveBeenCalledWith(binding,object,'viewer'));
 view.unmount();
});

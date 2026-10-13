import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {OfficeFileContent} from './OfficeFileContent';
import {officeFileApi} from '../../services/officeFileApi';
vi.mock('../../services/officeFileApi',()=>({officeFileApi:{inspect:vi.fn(),save:vi.fn()}}));
vi.mock('./DocxEditor',()=>({DocxEditor:(props:{model:{nodes:{text:string}[]};edits:{text:string}[];onChange:(edits:unknown[])=>void;readOnly:boolean})=><div>
  <p>{props.edits[0]?.text??props.model.nodes[0].text}</p><button disabled={props.readOnly} onClick={()=>props.onChange([{type:'text',nodeId:'p0',text:'已修改'}])}>修改正文</button>
</div>}));
vi.mock('./XlsxEditor',async()=>{
  const {useEffect,useRef}=await import('react');
  return{XlsxEditor:(props:{registerBeforeSave:(flush:()=>Promise<void>)=>()=>void;onPendingChange:(pending:boolean)=>void;onChange:(edits:unknown[])=>void})=>{
    const text=useRef<string|null>(null);const latest=useRef(props);latest.current=props;
    useEffect(()=>props.registerBeforeSave(async()=>{
      if(text.current===null)return;
      latest.current.onChange([{sheetId:'sheet-1',row:0,column:0,kind:'string',value:text.current}]);
      text.current=null;latest.current.onPendingChange(false);
    }),[props.registerBeforeSave]);
    return <input aria-label="正在编辑的单元格" onChange={event=>{text.current=event.target.value;props.onPendingChange(true);}}/>;
  }};
});
const binding={workspaceId:'workspace',generation:'generation'};
const baseline={object:{workspaceId:'workspace',scope:{kind:'project' as const,projectId:7},kind:'file' as const,id:'42'},versionNumber:2,expectedContentHash:'sha256:old'};
const model={format:'docx',nodes:[{id:'p0',text:'原文'}]};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(officeFileApi.inspect).mockResolvedValue({model} as never);});
function mount(readOnly=false){
  const toolbar=document.createElement('div');document.body.append(toolbar);
  let guard:(()=>Promise<void>)|undefined;
  const saved=vi.fn();const dirty=vi.fn();
  const result=render(<OfficeFileContent toolbar={toolbar} binding={binding} baseline={baseline} readOnly={readOnly} registerFlush={flush=>{guard=flush;return()=>{guard=undefined;};}} onDirtyChange={dirty} onSaved={saved}/>);
  return{...result,saved,dirty,flush:()=>guard!(),cleanup:()=>{result.unmount();toolbar.remove();}};
}
it('loads the fixed File version, saves edits, and keeps the committed model for the next edit',async()=>{
  vi.mocked(officeFileApi.save).mockResolvedValue({model:{...model,nodes:[{id:'p0',text:'已修改'}]},commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
  const view=mount();await screen.findByText('原文');
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
  const view=mount();await screen.findByText('原文');
  fireEvent.click(screen.getByRole('button',{name:'修改正文'}));
  await act(async()=>{await expect(view.flush()).rejects.toThrow('文件版本冲突');});
  expect(screen.getByText('已修改')).toBeVisible();expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');expect(view.saved).not.toHaveBeenCalled();
  view.cleanup();
});
it('a fixed historical Office version is read only and closing creates no version',async()=>{
  const view=mount(true);await screen.findByText('原文');
  expect(screen.getByRole('button',{name:'修改正文'})).toBeDisabled();expect(screen.queryByRole('button',{name:'保存'})).toBeNull();
  await view.flush();expect(officeFileApi.save).not.toHaveBeenCalled();view.cleanup();
});
it('closing commits pending spreadsheet input before taking the native save snapshot',async()=>{
  const xlsx={format:'xlsx'};
  vi.mocked(officeFileApi.inspect).mockResolvedValue({model:xlsx} as never);
  vi.mocked(officeFileApi.save).mockResolvedValue({model:xlsx,commit:{receipt:{documentId:42,versionNumber:3,contentHash:'sha256:new',noChange:false},versionPath:null}} as never);
  const view=mount();const input=await screen.findByRole('textbox',{name:'正在编辑的单元格'});
  fireEvent.change(input,{target:{value:'未按 Enter 的中文'}});
  expect(view.dirty).toHaveBeenLastCalledWith(true);expect(screen.getByRole('status')).toHaveTextContent('未保存');
  await act(()=>view.flush());
  expect(officeFileApi.save).toHaveBeenCalledWith(binding,expect.objectContaining({edits:[{sheetId:'sheet-1',row:0,column:0,kind:'string',value:'未按 Enter 的中文'}]}),expect.any(String));
  expect(view.dirty).toHaveBeenLastCalledWith(false);expect(screen.getByRole('status')).toHaveTextContent('已保存');view.cleanup();
});

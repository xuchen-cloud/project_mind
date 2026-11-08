import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MarkdownFileContent } from './MarkdownFileContent';
import {fileWorkingApi} from '../../services/fileWorkingApi';
vi.mock('../../services/fileWorkingApi',()=>({fileWorkingApi:{saveText:vi.fn(),activity:vi.fn()}}));
const markdownFlush=vi.hoisted(()=>({wait:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../markdown/MarkdownEditor', async () => {
 const {useEffect}=await import('react');
 return { MarkdownEditor: (props: {
        value: string;
        onChange: (text: string) => void;
        readOnly?: boolean;
        registerBeforeSave?:(flush:()=>Promise<void>)=>()=>void;
    }) => {
      useEffect(()=>props.registerBeforeSave?.(async()=>{await markdownFlush.wait?.();}),[props.registerBeforeSave]);
      return <><textarea aria-label="Markdown 内容" value={props.value} readOnly={props.readOnly} onChange={event => props.onChange(event.target.value)}/><button onClick={() => props.onChange("\ufeff# 新内容\r\n\r\n**中文**\r\n")}>原样修改</button><button onClick={()=>props.onChange(original)}>还原原文</button></>;
    } };
});
const binding = { workspaceId: 'w', generation: 'g' };
const baseline = { object: { workspaceId: 'w', scope: { kind: 'project' as const, projectId: 2 }, kind: 'file' as const, id: '7' }, versionNumber: 1, expectedContentHash: 'hash1' };
const original = '\ufeff# 原文\r\n';
const working={...baseline,object:baseline.object,sessionId:'session',revision:1,contentHash:'hash1',archivedVersionNumber:1,pendingArchive:false,lastActivityAtMs:null,archiveDueAtMs:null,name:'sample.md',base64:'',format:null,model:null};
const saved=(revision=2,contentHash='hash2')=>({object:baseline.object,revision,contentHash,archivedVersionNumber:1,pendingArchive:true,lastActivityAtMs:1,archiveDueAtMs:900001,noChange:false});
const workingInput={object:baseline.object,sessionId:'session',expectedRevision:1,expectedContentHash:'hash1'};

beforeEach(() => { vi.resetAllMocks(); vi.mocked(fileWorkingApi.activity).mockResolvedValue(saved());markdownFlush.wait=undefined; vi.mocked(fileWorkingApi.saveText).mockResolvedValue(saved()); });
async function mount(readOnly = false) {
    let flush = async () => { };
    const onSaved = vi.fn(), onDirty = vi.fn();
    const toolbar = document.createElement('span');
    document.body.append(toolbar);
    const props = { toolbar, binding, baseline, working:readOnly?undefined:working, text: original, readOnly, registerFlush: (fn: () => Promise<void>) => { flush = fn; return () => { }; }, onDirtyChange: onDirty, onSaved };
    const view = render(<MarkdownFileContent {...props}/>);
    return { ...view, props, onSaved, onDirty, flush: () => flush(), cleanup: () => { view.unmount(); toolbar.remove(); } };
}
it('saves the exact source under the fixed baseline and publishes the new version', async () => {
    const view = await mount();
    await screen.findByRole('textbox', { name: 'Markdown 内容' });
    const draft = '\ufeff# 新内容\r\n\r\n**中文**\r\n';
    fireEvent.click(screen.getByRole('button', { name: '原样修改' }));
    await act(() => view.flush());
    expect(fileWorkingApi.saveText).toHaveBeenCalledWith(binding, { ...workingInput, text: draft }, expect.any(String));
    expect(view.onSaved).toHaveBeenCalledWith(1, 'hash2', saved(), draft);
    expect(view.onDirty).toHaveBeenLastCalledWith(false);
    view.cleanup();
});
it('keeps a failed draft and retries with the same request identity', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '' } });
    vi.mocked(fileWorkingApi.saveText).mockRejectedValueOnce(new Error('保存冲突'));
    await act(async () => { await expect(view.flush()).rejects.toThrow('保存冲突'); });
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');
    const id = vi.mocked(fileWorkingApi.saveText).mock.calls[0][2];
    await act(() => view.flush());
    expect(vi.mocked(fileWorkingApi.saveText).mock.calls[1][2]).toBe(id);
    expect(view.onSaved).toHaveBeenCalledWith(1, 'hash2', saved(), '');
    view.cleanup();
});
it('commits pending input once and publishes one receipt for concurrent save requests',async()=>{
 let release!:()=>void;
 const committed=new Promise<void>(resolve=>{release=resolve;});
 markdownFlush.wait=vi.fn(()=>committed);
 const view=await mount();fireEvent.change(await screen.findByRole('textbox'),{target:{value:'连续保存'}});
 let first!:Promise<void>,second!:Promise<void>;
 act(()=>{first=view.flush();second=view.flush();});
 const calls=vi.mocked(markdownFlush.wait).mock.calls.length;
 await act(async()=>{release();await Promise.all([first,second]);});
 expect(calls).toBe(1);expect(fileWorkingApi.saveText).toHaveBeenCalledOnce();expect(view.onSaved).toHaveBeenCalledOnce();
 view.cleanup();
});
it('allows editing during save and allows historical text viewing without writes', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '草稿' } });
    let finish!: (value: Awaited<ReturnType<typeof fileWorkingApi.saveText>>) => void;
    vi.mocked(fileWorkingApi.saveText).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = view.flush(); });
    await waitFor(() => expect(fileWorkingApi.saveText).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
    await act(async () => { finish(saved()); await pending; });
    view.cleanup();
    const history = await mount(true);
    expect(await screen.findByRole('textbox')).toHaveAttribute('readonly');
    await act(() => history.flush());
    expect(fileWorkingApi.saveText).toHaveBeenCalledOnce();
    history.cleanup();
});
it('continues saving on the acknowledged version and replaces state on an explicit historical baseline', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '第一次' } });
    await act(() => view.flush());
    const next = { ...baseline, versionNumber: 2, expectedContentHash: 'hash2' };
    view.rerender(<MarkdownFileContent {...view.props} baseline={next} text="第一次"/>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '第二次' } });
    vi.mocked(fileWorkingApi.saveText).mockResolvedValueOnce(saved(3,'hash3'));
    await act(() => view.flush());
    expect(fileWorkingApi.saveText).toHaveBeenLastCalledWith(binding, {...workingInput,expectedRevision:2,expectedContentHash:'hash2',text:'第二次'}, expect.any(String));
    view.rerender(<MarkdownFileContent {...view.props} working={undefined} readOnly/>);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(original.replace(/\r\n/g, '\n')));
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    await act(() => view.flush());
    expect(fileWorkingApi.saveText).toHaveBeenCalledTimes(2);
    view.cleanup();
});

it('ignores a late save receipt after the File editor has been unmounted', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), {target: {value: '离开前的草稿'}});
    let finish!: (value: Awaited<ReturnType<typeof fileWorkingApi.saveText>>) => void;
    vi.mocked(fileWorkingApi.saveText).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    let pending!: Promise<void>;
    act(() => {pending = view.flush();});
    await waitFor(() => expect(fileWorkingApi.saveText).toHaveBeenCalledOnce());
    view.cleanup();
    await act(async () => {
        finish(saved());
        await pending;
    });
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(view.onDirty).toHaveBeenLastCalledWith(false);
});

it('opens Markdown directly for editing without a preview transition or duplicate source button',async()=>{
 const view=await mount();
 const input=await screen.findByRole('textbox',{name:'Markdown 内容'});
 expect(input).not.toHaveAttribute('readonly');
 expect(screen.queryByRole('button',{name:'编辑',exact:true})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'保存并预览'})).not.toBeInTheDocument();
 expect(fileWorkingApi.saveText).not.toHaveBeenCalled();view.cleanup();
});

it('defaults to automatic saving after editing stops and cancels its timer on unmount',async()=>{
 const view=await mount();const input=await screen.findByRole('textbox');vi.useFakeTimers();
 try {
  fireEvent.change(input,{target:{value:'自动保存草稿'}});
  await act(()=>vi.advanceTimersByTimeAsync(1199));expect(fileWorkingApi.saveText).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'最终草稿'}});
  await act(()=>vi.advanceTimersByTimeAsync(1200));expect(fileWorkingApi.saveText).toHaveBeenCalledExactlyOnceWith(binding,{...workingInput,text:'最终草稿'},expect.any(String));
  expect(view.onSaved).toHaveBeenCalledWith(1,'hash2',saved(),'最终草稿');
  fireEvent.change(input,{target:{value:'离开草稿'}});view.cleanup();
  await act(()=>vi.advanceTimersByTimeAsync(2000));expect(fileWorkingApi.saveText).toHaveBeenCalledOnce();
 } finally {vi.useRealTimers();}
});

it('rejects a save that becomes read-only while beforeSave is pending',async()=>{
 let release!:()=>void;
 markdownFlush.wait=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
 const view=await mount();fireEvent.change(await screen.findByRole('textbox',{name:'Markdown 内容'}),{target:{value:'保留草稿'}});
 expect(view.onDirty).toHaveBeenLastCalledWith(true);
 let pending!:Promise<void>;act(()=>{pending=view.flush();});
 const result=pending.then(()=>null,reason=>reason);
 await waitFor(()=>expect(markdownFlush.wait).toHaveBeenCalledOnce());expect(fileWorkingApi.saveText).not.toHaveBeenCalled();
 const nextSaved=vi.fn();view.rerender(<MarkdownFileContent {...view.props} readOnly onSaved={nextSaved}/>);
 let failure:unknown;await act(async()=>{release();failure=await result;});
 expect(fileWorkingApi.saveText).not.toHaveBeenCalled();expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain('只读');
 expect(screen.getByRole('textbox',{name:'Markdown 内容'})).toHaveValue('保留草稿');expect(screen.getByRole('textbox',{name:'Markdown 内容'})).toHaveAttribute('readonly');
 expect(screen.getByRole('status')).toHaveTextContent('历史版本 · 只读');expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');
 expect(view.onSaved).not.toHaveBeenCalled();expect(nextSaved).not.toHaveBeenCalled();expect(view.onDirty).toHaveBeenLastCalledWith(true);
 view.cleanup();
});

it('preserves caret and late input through two working saves without changing editor identity',async()=>{
 const view=await mount();const editor=await screen.findByRole('textbox') as HTMLTextAreaElement;
 fireEvent.change(editor,{target:{value:'第一轮'}});
 let finish!:(value:ReturnType<typeof saved>)=>void;
 vi.mocked(fileWorkingApi.saveText).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 fireEvent.keyDown(editor,{key:'s',ctrlKey:true});
 await waitFor(()=>expect(fileWorkingApi.saveText).toHaveBeenCalledOnce());
 expect(editor).not.toHaveAttribute('readonly');
 fireEvent.change(editor,{target:{value:'保存期间继续中文'}});editor.focus();editor.setSelectionRange(3,5);
 await act(async()=>{finish(saved());});
 expect(screen.getByRole('textbox')).toBe(editor);expect(editor).toHaveValue('保存期间继续中文');
 expect(editor.selectionStart).toBe(3);expect(editor.selectionEnd).toBe(5);
 expect(view.onDirty).toHaveBeenLastCalledWith(true);
 expect(view.onSaved).toHaveBeenLastCalledWith(1,'hash2',saved(),'第一轮');
 vi.mocked(fileWorkingApi.saveText).mockResolvedValueOnce(saved(3,'hash3'));
 await act(()=>view.flush());
 expect(fileWorkingApi.saveText).toHaveBeenLastCalledWith(binding,{...workingInput,expectedRevision:2,expectedContentHash:'hash2',text:'保存期间继续中文'},expect.any(String));
 expect(screen.getByRole('textbox')).toBe(editor);expect(view.onDirty).toHaveBeenLastCalledWith(false);
 expect(fileWorkingApi.activity).toHaveBeenCalledWith(binding,{object:baseline.object,sessionId:'session'});
 view.cleanup();
});


it('persists undo back to the original source after an earlier working save',async()=>{
 const view=await mount();await screen.findByRole('textbox');
 fireEvent.click(screen.getByRole('button',{name:'原样修改'}));await act(()=>view.flush());
 fireEvent.click(screen.getByRole('button',{name:'还原原文'}));expect(view.onDirty).toHaveBeenLastCalledWith(true);
 vi.mocked(fileWorkingApi.saveText).mockResolvedValueOnce(saved(3,'hash1'));
 await act(()=>view.flush());
 expect(fileWorkingApi.saveText).toHaveBeenLastCalledWith(binding,{...workingInput,expectedRevision:2,expectedContentHash:'hash2',text:original},expect.any(String));
 expect(view.onDirty).toHaveBeenLastCalledWith(false);view.cleanup();
});

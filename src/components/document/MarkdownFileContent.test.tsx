import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MarkdownFileContent } from './MarkdownFileContent';
import { fileTextApi } from '../../services/fileTextApi';
vi.mock('../../services/fileTextApi', () => ({ fileTextApi: { save: vi.fn() } }));
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
      return <><textarea aria-label="Markdown 内容" value={props.value} readOnly={props.readOnly} onChange={event => props.onChange(event.target.value)}/><button onClick={() => props.onChange("\ufeff# 新内容\r\n\r\n**中文**\r\n")}>原样修改</button></>;
    } };
});
const binding = { workspaceId: 'w', generation: 'g' };
const baseline = { object: { workspaceId: 'w', scope: { kind: 'project' as const, projectId: 2 }, kind: 'file' as const, id: '7' }, versionNumber: 1, expectedContentHash: 'hash1' };
const original = '\ufeff# 原文\r\n';
beforeEach(() => { vi.resetAllMocks(); markdownFlush.wait=undefined; vi.mocked(fileTextApi.save).mockResolvedValue({ receipt: { documentId: 7, versionNumber: 2, contentHash: 'hash2', noChange: false }, versionPath: null }); });
async function mount(readOnly = false) {
    let flush = async () => { };
    const onSaved = vi.fn(), onDirty = vi.fn();
    const toolbar = document.createElement('span');
    document.body.append(toolbar);
    const props = { toolbar, binding, baseline, text: original, readOnly, registerFlush: (fn: () => Promise<void>) => { flush = fn; return () => { }; }, onDirtyChange: onDirty, onSaved };
    const view = render(<MarkdownFileContent {...props}/>);
    return { ...view, props, onSaved, onDirty, flush: () => flush(), cleanup: () => { view.unmount(); toolbar.remove(); } };
}
it('saves the exact source under the fixed baseline and publishes the new version', async () => {
    const view = await mount();
    await screen.findByRole('textbox', { name: 'Markdown 内容' });
    const draft = '\ufeff# 新内容\r\n\r\n**中文**\r\n';
    fireEvent.click(screen.getByRole('button', { name: '原样修改' }));
    await act(() => view.flush());
    expect(fileTextApi.save).toHaveBeenCalledWith(binding, { ...baseline, text: draft }, expect.any(String));
    expect(view.onSaved).toHaveBeenCalledWith(2, 'hash2', draft);
    expect(view.onDirty).toHaveBeenLastCalledWith(false);
    view.cleanup();
});
it('keeps a failed draft and retries with the same request identity', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '' } });
    vi.mocked(fileTextApi.save).mockRejectedValueOnce(new Error('保存冲突'));
    await act(async () => { await expect(view.flush()).rejects.toThrow('保存冲突'); });
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');
    const id = vi.mocked(fileTextApi.save).mock.calls[0][2];
    await act(() => view.flush());
    expect(vi.mocked(fileTextApi.save).mock.calls[1][2]).toBe(id);
    expect(view.onSaved).toHaveBeenCalledWith(2, 'hash2', '');
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
 expect(calls).toBe(1);expect(fileTextApi.save).toHaveBeenCalledOnce();expect(view.onSaved).toHaveBeenCalledOnce();
 view.cleanup();
});
it('freezes editing during save and allows historical text viewing without writes', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '草稿' } });
    let finish!: (value: Awaited<ReturnType<typeof fileTextApi.save>>) => void;
    vi.mocked(fileTextApi.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = view.flush(); });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveAttribute('readonly'));
    await act(async () => { finish({ receipt: { documentId: 7, versionNumber: 2, contentHash: 'hash2', noChange: false }, versionPath: null }); await pending; });
    view.cleanup();
    const history = await mount(true);
    expect(await screen.findByRole('textbox')).toHaveAttribute('readonly');
    await act(() => history.flush());
    expect(fileTextApi.save).toHaveBeenCalledOnce();
    history.cleanup();
});
it('continues saving on the acknowledged version and replaces state on an explicit historical baseline', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '第一次' } });
    await act(() => view.flush());
    const next = { ...baseline, versionNumber: 2, expectedContentHash: 'hash2' };
    view.rerender(<MarkdownFileContent {...view.props} baseline={next} text="第一次"/>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '第二次' } });
    vi.mocked(fileTextApi.save).mockResolvedValueOnce({ receipt: { documentId: 7, versionNumber: 3, contentHash: 'hash3', noChange: false }, versionPath: null });
    await act(() => view.flush());
    expect(fileTextApi.save).toHaveBeenLastCalledWith(binding, { ...next, text: '第二次' }, expect.any(String));
    view.rerender(<MarkdownFileContent {...view.props} readOnly/>);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(original.replace(/\r\n/g, '\n')));
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    await act(() => view.flush());
    expect(fileTextApi.save).toHaveBeenCalledTimes(2);
    view.cleanup();
});

it('ignores a late save receipt after the File editor has been unmounted', async () => {
    const view = await mount();
    fireEvent.change(await screen.findByRole('textbox'), {target: {value: '离开前的草稿'}});
    let finish!: (value: Awaited<ReturnType<typeof fileTextApi.save>>) => void;
    vi.mocked(fileTextApi.save).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    let pending!: Promise<void>;
    act(() => {pending = view.flush();});
    await waitFor(() => expect(fileTextApi.save).toHaveBeenCalledOnce());
    view.cleanup();
    await act(async () => {
        finish({receipt: {documentId: 7, versionNumber: 2, contentHash: 'hash2', noChange: false}, versionPath: null});
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
 expect(fileTextApi.save).not.toHaveBeenCalled();view.cleanup();
});

it('defaults to automatic saving after editing stops and cancels its timer on unmount',async()=>{
 const view=await mount();const input=await screen.findByRole('textbox');vi.useFakeTimers();
 try {
  fireEvent.change(input,{target:{value:'自动保存草稿'}});
  await act(()=>vi.advanceTimersByTimeAsync(1199));expect(fileTextApi.save).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:'最终草稿'}});
  await act(()=>vi.advanceTimersByTimeAsync(1200));expect(fileTextApi.save).toHaveBeenCalledExactlyOnceWith(binding,{...baseline,text:'最终草稿'},expect.any(String));
  expect(view.onSaved).toHaveBeenCalledWith(2,'hash2','最终草稿');
  fireEvent.change(input,{target:{value:'离开草稿'}});view.cleanup();
  await act(()=>vi.advanceTimersByTimeAsync(2000));expect(fileTextApi.save).toHaveBeenCalledOnce();
 } finally {vi.useRealTimers();}
});

it('rejects a save that becomes read-only while beforeSave is pending',async()=>{
 let release!:()=>void;
 markdownFlush.wait=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
 const view=await mount();fireEvent.change(await screen.findByRole('textbox',{name:'Markdown 内容'}),{target:{value:'保留草稿'}});
 expect(view.onDirty).toHaveBeenLastCalledWith(true);
 let pending!:Promise<void>;act(()=>{pending=view.flush();});
 const result=pending.then(()=>null,reason=>reason);
 await waitFor(()=>expect(markdownFlush.wait).toHaveBeenCalledOnce());expect(fileTextApi.save).not.toHaveBeenCalled();
 const nextSaved=vi.fn();view.rerender(<MarkdownFileContent {...view.props} readOnly onSaved={nextSaved}/>);
 let failure:unknown;await act(async()=>{release();failure=await result;});
 expect(fileTextApi.save).not.toHaveBeenCalled();expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain('只读');
 expect(screen.getByRole('textbox',{name:'Markdown 内容'})).toHaveValue('保留草稿');expect(screen.getByRole('textbox',{name:'Markdown 内容'})).toHaveAttribute('readonly');
 expect(screen.getByRole('status')).toHaveTextContent('历史版本 · 只读');expect(screen.getByRole('alert')).toHaveTextContent('修改已保留');
 expect(view.onSaved).not.toHaveBeenCalled();expect(nextSaved).not.toHaveBeenCalled();expect(view.onDirty).toHaveBeenLastCalledWith(true);
 view.cleanup();
});

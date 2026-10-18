import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocxEditorProps } from './DocxEditor';
import type { XlsxEditorProps } from './XlsxEditor';
import type { PptxEditorProps } from './PptxEditor';
import { DocxEditor } from './DocxEditor';
import { XlsxEditor } from './XlsxEditor';
import { PptxEditor } from './PptxEditor';

afterEach(()=>vi.unstubAllGlobals());

const runtime=vi.hoisted(()=>({docxMount:vi.fn(),xlsxMount:vi.fn()}));
vi.mock('../../../packages/office-docx/dist/editor.mjs',()=>({mountFullEditor:runtime.docxMount}));
vi.mock('../../../packages/office-xlsx/dist/browser.mjs',()=>({mount:runtime.xlsxMount}));
vi.mock('../../../packages/office-pptx/dist/browser.mjs',()=>({parityHtml:'<!doctype html><title>Test renderer</title>'}));
function deferred(){let resolve!:()=>void;let reject!:(error:Error)=>void;const promise=new Promise<void>((done,failed)=>{resolve=done;reject=failed;});return {promise,resolve,reject};}
let docxReady:ReturnType<typeof deferred>;let xlsxReady:ReturnType<typeof deferred>;
let docx:{readonly ready:Promise<void>;update:ReturnType<typeof vi.fn>;destroy:ReturnType<typeof vi.fn>;beforeSave:ReturnType<typeof vi.fn>};
let xlsx:{readonly ready:Promise<void>;update:ReturnType<typeof vi.fn>;dispose:ReturnType<typeof vi.fn>;commitEditing:ReturnType<typeof vi.fn>};
beforeEach(()=>{
 vi.clearAllMocks();docxReady=deferred();xlsxReady=deferred();
 docx={get ready(){return docxReady.promise;},update:vi.fn(),destroy:vi.fn(),beforeSave:vi.fn()};
 xlsx={get ready(){return xlsxReady.promise;},update:vi.fn(),dispose:vi.fn(),commitEditing:vi.fn()};
 runtime.docxMount.mockImplementation((host:HTMLElement)=>{host.append(document.createElement('iframe'));return docx;});
 runtime.xlsxMount.mockImplementation((host:HTMLElement)=>{host.replaceChildren(document.createElement('iframe'));return xlsx;});
});
const docxProps=()=>({model:{format:'docx',name:'report.docx'},edits:[],onChange:vi.fn(),onPendingChange:vi.fn()} as unknown as DocxEditorProps);
const xlsxProps=()=>({model:{format:'xlsx',name:'book.xlsx'},edits:[],readOnly:false,onChange:vi.fn(),onPendingChange:vi.fn()} as unknown as XlsxEditorProps);

it('waits for real Word readiness, preserves a ready receipt, and observes only a new ready promise',async()=>{
 const props=docxProps();const view=render(<DocxEditor {...props}/>);
 expect(screen.getAllByRole('status',{name:'文件加载状态'})).toHaveLength(1);
 await waitFor(()=>expect(runtime.docxMount).toHaveBeenCalledOnce());
 expect(screen.getByRole('status')).toHaveTextContent('正在准备文档画布');
 fireEvent.load(view.container.querySelector('iframe')!);expect(screen.getByRole('status')).toBeInTheDocument();
 await act(async()=>docxReady.resolve());expect(screen.queryByRole('status')).not.toBeInTheDocument();
 view.rerender(<DocxEditor {...props} model={{...props.model}}/>);expect(screen.queryByRole('status')).not.toBeInTheDocument();
 docxReady=deferred();view.rerender(<DocxEditor {...props} model={{...props.model}}/>);
 expect(screen.getByRole('status')).toHaveTextContent('正在准备文档画布');
 await act(async()=>docxReady.resolve());expect(screen.queryByRole('status')).not.toBeInTheDocument();
 expect(docx.beforeSave).not.toHaveBeenCalled();expect(props.onPendingChange).not.toHaveBeenCalled();
});
it('keeps Excel React loading and errors outside the imperative replaceChildren host',async()=>{
 const props=xlsxProps();const view=render(<XlsxEditor {...props}/>);
 await waitFor(()=>expect(runtime.xlsxMount).toHaveBeenCalledOnce());
 const host=runtime.xlsxMount.mock.calls[0][0] as HTMLElement;
 expect(host.children).toHaveLength(1);expect(host.firstElementChild?.tagName).toBe('IFRAME');
 expect(screen.getByRole('status')).toBeVisible();expect(host.contains(screen.getByRole('status'))).toBe(false);
 await act(async()=>xlsxReady.resolve());expect(screen.queryByRole('status')).not.toBeInTheDocument();
 expect(host.querySelector('iframe')).toBeInTheDocument();
 act(()=>{host.dispatchEvent(new CustomEvent('office-error',{detail:'真实加载错误'}));});
 expect(screen.getByRole('alert')).toHaveTextContent('真实加载错误');expect(host.contains(screen.getByRole('alert'))).toBe(false);
 act(()=>{host.replaceChildren(document.createElement('iframe'));});
 expect(screen.getByRole('alert')).toHaveTextContent('真实加载错误');expect(()=>view.unmount()).not.toThrow();
 expect(xlsx.commitEditing).not.toHaveBeenCalled();
});
it('does not re-cover ready Excel content on a callback update, but follows an actual remount promise',async()=>{
 const props=xlsxProps();const view=render(<XlsxEditor {...props}/>);await waitFor(()=>expect(runtime.xlsxMount).toHaveBeenCalledOnce());
 await act(async()=>xlsxReady.resolve());view.rerender(<XlsxEditor {...props} presentationMode="edit" onChange={vi.fn()}/>);
 expect(screen.queryByRole('status')).not.toBeInTheDocument();
 xlsxReady=deferred();view.rerender(<XlsxEditor {...props} model={{...props.model}}/>);
 expect(screen.getByRole('status')).toBeInTheDocument();await act(async()=>xlsxReady.resolve());expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('reveals a real readiness failure instead of leaving Word under a loading overlay',async()=>{
 render(<DocxEditor {...docxProps()}/>);await waitFor(()=>expect(runtime.docxMount).toHaveBeenCalledOnce());
 await act(async()=>docxReady.reject(new Error('文档布局失败')));
 expect(screen.getByRole('alert')).toHaveTextContent('文档布局失败');expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('ignores readiness completion after Word unmount',async()=>{
 const view=render(<DocxEditor {...docxProps()}/>);await waitFor(()=>expect(runtime.docxMount).toHaveBeenCalledOnce());view.unmount();
 await act(async()=>docxReady.resolve());expect(screen.queryByRole('status')).not.toBeInTheDocument();expect(docx.destroy).toHaveBeenCalledOnce();
});
it('waits for the current PPT initialized message rather than iframe load, bootstrap or pending false',async()=>{
 vi.stubGlobal('MessageChannel',undefined);
 const props={model:{format:'pptx',name:'deck.pptx'},edits:[],readOnly:true,onChange:vi.fn(),onPendingChange:vi.fn()} as unknown as PptxEditorProps;
 const view=render(<PptxEditor {...props}/>);const frame=view.container.querySelector('iframe')!;
 const post=vi.spyOn(frame.contentWindow!,'postMessage');
 const send=(type:string,epoch?:number,extra={})=>act(()=>{window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{source:'project-mind-pptx',type,epoch,...extra}}));});
 fireEvent.load(frame);send('ready');expect(screen.getByRole('status')).toBeInTheDocument();
 const initial=post.mock.calls.find(([data])=>data?.type==='init')?.[0] as {epoch:number};expect(initial).toBeTruthy();
 send('pending',initial.epoch,{pending:false});send('initialized',initial.epoch-1);expect(screen.getByRole('status')).toBeInTheDocument();
 send('initialized',initial.epoch);expect(screen.queryByRole('status')).not.toBeInTheDocument();
 view.rerender(<PptxEditor {...props} readOnly={false} presentationMode="edit"/>);expect(screen.queryByRole('status')).not.toBeInTheDocument();
 view.rerender(<PptxEditor {...props} model={{...props.model}}/>);expect(screen.getByRole('status')).toBeInTheDocument();
 send('initialized',initial.epoch);expect(screen.getByRole('status')).toBeInTheDocument();
 const latest=post.mock.calls.filter(([data])=>data?.type==='init').at(-1)?.[0] as {epoch:number};send('initialized',latest.epoch);
 expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { RichMarkdownEditor } from './RichMarkdownEditor';
import { desktopApi } from '../../services/desktopApi';

afterEach(()=>vi.unstubAllGlobals());

beforeAll(()=>{
  Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
  Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
});
let read:ReturnType<typeof vi.fn>;let write:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  window.getSelection()?.removeAllRanges();
  read=vi.fn().mockResolvedValue('**pasted**');write=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:read,writeText:write}});
});
async function setup(value='hello world',readOnly=false){
  let instance:Editor|null=null;
  const props={value,readOnly,documentKey:'one',resources:{},zoom:100,spellcheck:false,onChange:vi.fn(),onReady:(editor:Editor|null)=>{instance=editor;},onSelection:vi.fn(),onPending:vi.fn(),onError:vi.fn(),onImage:vi.fn()};
  const view=render(<RichMarkdownEditor {...props}/>);
  await waitFor(()=>expect(instance).not.toBeNull());
  const editor=instance! as Editor;
  const hit=vi.spyOn(editor.view,'posAtCoords').mockReturnValue({pos:3,inside:0});
  const open=(target:Element=editor.view.dom.querySelector('p')!)=>fireEvent.contextMenu(target,{clientX:20,clientY:20});
  return {view,editor,hit,open,props};
}
it('preserves the browser text selection and applies the shared bold command without AI or unsupported marks',async()=>{
  const {editor,open,props}=await setup();
  const text=editor.view.dom.querySelector('p')!.firstChild!;
  const range=document.createRange();range.setStart(text,0);range.setEnd(text,5);window.getSelection()!.addRange(range);
  open();
  const menu=screen.getByRole('menu',{name:'Markdown 右键菜单'});
  expect(editor.state.selection.from).toBe(1);expect(editor.state.selection.to).toBe(6);
  expect(within(menu).queryByText('技能')).not.toBeInTheDocument();
  expect(within(menu).queryByRole('button',{name:'着重'})).not.toBeInTheDocument();
  fireEvent.click(within(menu).getByRole('button',{name:'加粗'}));
  await waitFor(()=>expect(editor.getHTML()).toContain('<strong>hello</strong>'));
  expect(props.onChange).toHaveBeenCalled();expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});
it('positions blank-space insertion at the document end and exposes only real insertions',async()=>{
  const {editor,hit,open,view}=await setup();hit.mockReturnValue(null);
  open(view.container.querySelector('.mind-markdown__rich-scroll')!);
  expect(editor.state.selection.from).toBe(editor.state.doc.content.size-1);
  const menu=screen.getByRole('menu');
  const grid=within(menu).getByRole('group',{name:'新增区块'});
  expect(within(grid).queryByRole('button',{name:'文件'})).not.toBeInTheDocument();
  expect(within(grid).queryByRole('button',{name:'更多'})).not.toBeInTheDocument();
  fireEvent.click(within(grid).getByRole('button',{name:'表格'}));
  await waitFor(()=>expect(editor.view.dom.querySelectorAll('table tr')).toHaveLength(3));
});
it('uses the shared table context menu for row insertion without a floating table toolbar',async()=>{
  const {editor,hit,open}=await setup('| A | B |\n| --- | --- |\n| C | D |');
  const cell=editor.view.dom.querySelector('td,th')!;
  hit.mockReturnValue({pos:4,inside:2});open(cell);
  expect(screen.getByRole('menuitem',{name:'合并单元格'})).toBeDisabled();
  fireEvent.click(screen.getByRole('menuitem',{name:'下方插入行'}));
  await waitFor(()=>expect(editor.view.dom.querySelectorAll('tr')).toHaveLength(3));
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});
it('offers copy only in read-only mode and copies the selected text without changing content',async()=>{
  const {editor,open,props}=await setup('hello world',true);
  act(()=>{editor.commands.setTextSelection({from:1,to:6});});open();
  const menu=screen.getByRole('menu');expect(within(menu).getAllByRole('button')).toHaveLength(1);
  fireEvent.click(within(menu).getByRole('button',{name:'复制'}));
  await waitFor(()=>expect(write).toHaveBeenCalledWith('hello'));
  expect(editor.getText()).toBe('hello world');expect(props.onChange).not.toHaveBeenCalled();
});
it.each(['escape','outside','selection'] as const)('closes and cancels a context menu on %s',async(kind)=>{
  const {editor,open}=await setup();open();expect(screen.getByRole('menu')).toBeInTheDocument();
  if(kind==='escape')fireEvent.keyDown(window,{key:'Escape'});
  if(kind==='outside')fireEvent.pointerDown(document.body);
  if(kind==='selection')act(()=>{editor.commands.setTextSelection(8);});
  await waitFor(()=>expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  expect(read).not.toHaveBeenCalled();
});
it.each(['document','selection','readonly','reopen','unmount'] as const)('discards delayed clipboard paste after %s changes',async(kind)=>{
  let resolve!:(text:string)=>void;read.mockImplementation(()=>new Promise<string>(done=>{resolve=done;}));
  const {editor,open,view,props}=await setup();
  act(()=>{editor.commands.setTextSelection({from:1,to:6});});open();
  fireEvent.click(screen.getByRole('button',{name:'粘贴'}));
  await waitFor(()=>expect(read).toHaveBeenCalledTimes(1));
  if(kind==='document')view.rerender(<RichMarkdownEditor {...props} documentKey="two" value="new document"/>);
  if(kind==='readonly')view.rerender(<RichMarkdownEditor {...props} readOnly/>);
  if(kind==='selection')act(()=>{editor.commands.setTextSelection(8);});
  if(kind==='reopen')open();
  if(kind==='unmount')view.unmount();
  await act(async()=>{resolve('STALE');});
  if(kind!=='unmount')expect(editor.getText()).not.toContain('STALE');
  expect(props.onChange).not.toHaveBeenCalled();
});
it('pastes Markdown into the original selection when the clipboard target remains current',async()=>{
  const {editor,open}=await setup();act(()=>{editor.commands.setTextSelection({from:1,to:6});});open();
  fireEvent.click(screen.getByRole('button',{name:'粘贴'}));
  await waitFor(()=>expect(editor.getHTML()).toContain('<strong>pasted</strong> world'));
});
it('never deletes a newer selection when a cut write finishes late',async()=>{
  let finish!:()=>void;write.mockImplementation(()=>new Promise<void>(done=>{finish=done;}));
  const {editor,open}=await setup();act(()=>{editor.commands.setTextSelection({from:1,to:6});});open();
  fireEvent.click(screen.getByRole('button',{name:'剪切'}));await waitFor(()=>expect(write).toHaveBeenCalled());
  act(()=>{editor.commands.setTextSelection({from:7,to:12});});await act(async()=>{finish();});
  expect(editor.getText()).toBe('hello world');
});
it('keeps LocalImage as the clipboard image handler',async()=>{
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:vi.fn().mockResolvedValue([{types:['image/png'],getType:async()=>new Blob(['png'],{type:'image/png'})}])}});
  const {editor,open,props}=await setup();open();fireEvent.click(screen.getByRole('button',{name:'粘贴'}));
  await waitFor(()=>expect(editor.view.dom.querySelector('img')?.getAttribute('data-markdown-src')).toMatch(/^data:image\/png;base64,/u));
  expect(props.onPending).toHaveBeenCalledWith(true);expect(props.onPending).toHaveBeenLastCalledWith(false);
});

it.each(['current','document','readonly'] as const)('reads native clipboard through the desktop adapter and validates the %s target after await',async(kind)=>{
  let resolve!:(text:string)=>void;
  const nativeRead=vi.spyOn(desktopApi,'readClipboardText').mockImplementation(()=>new Promise<string>(done=>{resolve=done;}));nativeRead.mockClear();
  vi.stubGlobal('__TAURI_INTERNALS__',{});
  const {editor,open,view,props}=await setup();act(()=>{editor.commands.setTextSelection({from:1,to:6});});open();
  fireEvent.click(screen.getByRole('button',{name:'粘贴'}));
  await waitFor(()=>expect(nativeRead).toHaveBeenCalledOnce());expect(read).not.toHaveBeenCalled();
  if(kind==='document')view.rerender(<RichMarkdownEditor {...props} documentKey="two" value="new document"/>);
  if(kind==='readonly')view.rerender(<RichMarkdownEditor {...props} readOnly/>);
  await act(async()=>{resolve('**native**');});
  if(kind==='current')expect(editor.getHTML()).toContain('<strong>native</strong> world');
  else {expect(editor.getText()).not.toContain('native');expect(props.onChange).not.toHaveBeenCalled();}
  nativeRead.mockRestore();
});

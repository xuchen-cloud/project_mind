import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MarkdownEditor } from '../../../src/components/markdown/MarkdownEditor';

afterEach(()=>vi.restoreAllMocks());

function delayImageDelivery(){
  const completed:{reader:FileReader;deliver:()=>void}[]=[];
  const read=FileReader.prototype.readAsDataURL;
  vi.spyOn(FileReader.prototype,'readAsDataURL').mockImplementation(function(this:FileReader,file){
    const reader=this,loaded=reader.onload;
    reader.onload=(event:ProgressEvent<FileReader>)=>completed.push({reader,deliver:()=>loaded?.call(reader,event)});
    read.call(reader,file);
  });
  return completed;
}
const image=()=>new File(['real image bytes'],'current.png',{type:'image/png'});

it.each([
  ['rich','documentKey'],['rich','readonly'],['rich','unmount'],
  ['source','documentKey'],['source','readonly'],['source','unmount'],
] as const)('discards delayed %s paste after %s and releases the save guard',async(mode,transition)=>{
  const delayed=delayImageDelivery(),changed=vi.fn(),pending=vi.fn();let flush:(()=>Promise<void>)|undefined;
  const props={onChange:changed,onPendingChange:pending,initialView:{mode},registerBeforeSave:(callback:()=>Promise<void>)=>{flush=callback;return()=>{};}};
  const result=render(<MarkdownEditor value="# Baseline" documentKey="old" {...props}/>);
  const name=mode==='rich'?'Markdown 块编辑':'Markdown 源码';
  const editor=await screen.findByRole('textbox',{name});
  fireEvent.paste(editor,{clipboardData:{getData:()=>'',files:[image()]}});
  await waitFor(()=>expect(delayed).toHaveLength(1));
  expect(delayed[0].reader.result).toBe('data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw==');
  expect(pending).toHaveBeenLastCalledWith(true);
  if(transition==='documentKey'){
    result.rerender(<MarkdownEditor value="# Baseline" documentKey="new" {...props}/>);
    expect(screen.getByRole('textbox',{name})).toBe(editor);
    expect(pending).toHaveBeenLastCalledWith(false);
  }else if(transition==='readonly')result.rerender(<MarkdownEditor value="# Baseline" documentKey="old" readOnly {...props}/>);
  else result.unmount();
  await act(async()=>{delayed[0].deliver();await flush!();});
  expect(changed).not.toHaveBeenCalled();
  expect(result.container.querySelector('img')).toBeNull();
  expect(pending).toHaveBeenLastCalledWith(false);
});

it.each(['rich','source'] as const)('keeps current %s paste pending until the real reader result is inserted and saved/reopened',async mode=>{
  const delayed=delayImageDelivery(),pending=vi.fn();let text='',flush:(()=>Promise<void>)|undefined;
  const result=render(<MarkdownEditor value="" documentKey="same" initialView={{mode}} onChange={next=>{text=next;}} onPendingChange={pending} registerBeforeSave={callback=>{flush=callback;return()=>{};}}/>);
  const editor=await screen.findByRole('textbox',{name:mode==='rich'?'Markdown 块编辑':'Markdown 源码'});
  fireEvent.paste(editor,{clipboardData:{getData:()=>'',files:[image()]}});
  await waitFor(()=>expect(delayed).toHaveLength(1));
  let saved=false;const saving=flush!().then(()=>{saved=true;});await Promise.resolve();
  expect(saved).toBe(false);
  await act(async()=>{delayed[0].deliver();await saving;});
  expect(text).toContain('![current.png](data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw==)');
  expect(pending).toHaveBeenLastCalledWith(false);
  const directory=await mkdtemp(join(process.cwd(),'output','image-save-'));
  try{
    const file=join(directory,'image.md');await writeFile(file,text);const reopened=await readFile(file,'utf8');expect(reopened).toBe(text);
    result.unmount();render(<MarkdownEditor value={reopened} onChange={()=>{}} readOnly initialView={{mode:'preview'}}/>);
    expect(screen.getByRole('img',{name:'current.png'})).toHaveAttribute('src','data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw==');
  }finally{await rm(directory,{recursive:true,force:true});}
});

it.each(['documentKey','readonly','unmount'] as const)('cancels a delayed image chooser after %s instead of filling another panel',async transition=>{
  const delayed=delayImageDelivery(),changed=vi.fn();
  const result=render(<MarkdownEditor value="" documentKey="old" onChange={changed} initialView={{mode:'source'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'图片'}));
  fireEvent.change(result.container.querySelector('input[type="file"]')!,{target:{files:[image()]}});
  await waitFor(()=>expect(delayed).toHaveLength(1));
  if(transition==='documentKey'){
    result.rerender(<MarkdownEditor value="" documentKey="new" onChange={changed} initialView={{mode:'source'}}/>);
    fireEvent.click(screen.getByRole('button',{name:'图片'}));
  }else if(transition==='readonly'){
    result.rerender(<MarkdownEditor value="" documentKey="old" onChange={changed} readOnly initialView={{mode:'source'}}/>);
    result.rerender(<MarkdownEditor value="" documentKey="old" onChange={changed} initialView={{mode:'source'}}/>);
    fireEvent.click(screen.getByRole('button',{name:'图片'}));
  }else result.unmount();
  await act(async()=>delayed[0].deliver());
  if(transition!=='unmount'){
    expect(screen.getByRole('textbox',{name:'目标地址'})).toHaveValue('');
    expect(screen.getByRole('textbox',{name:'显示文字'})).toHaveValue('');
  }
  expect(delayed[0].reader.onload).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it('fills the current image chooser and commits its actual data URL only on Insert',async()=>{
  const delayed=delayImageDelivery(),changed=vi.fn();
  const result=render(<MarkdownEditor value="" documentKey="same" onChange={changed} initialView={{mode:'source'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'图片'}));
  fireEvent.change(result.container.querySelector('input[type="file"]')!,{target:{files:[image()]}});
  await waitFor(()=>expect(delayed).toHaveLength(1));
  await act(async()=>delayed[0].deliver());
  expect(screen.getByRole('textbox',{name:'目标地址'})).toHaveValue('data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw==');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'插入'}));
  expect(changed).toHaveBeenLastCalledWith('![current.png](data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw==)');
});

it.each(['source','rich'] as const)('inserts a local raster drop as data in %s without a hosting service',async mode=>{
  const changed=vi.fn();render(<MarkdownEditor value="" onChange={changed} initialView={{mode}}/>);
  fireEvent.drop(await screen.findByRole('textbox',{name:mode==='rich'?'Markdown 块编辑':'Markdown 源码'}),{dataTransfer:{files:[image()],getData:()=>''},clientX:0,clientY:0});
  await waitFor(()=>expect(changed).toHaveBeenCalled());
  expect(changed.mock.calls.slice(-1)[0]?.[0]).toContain('![current.png](data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw==)');
});

it.each(['source','rich','chooser'] as const)('retains the actual 4MiB local image limit in %s',async entry=>{
  const changed=vi.fn(),read=vi.spyOn(FileReader.prototype,'readAsDataURL');
  const result=render(<MarkdownEditor value="" onChange={changed} initialView={{mode:entry==='rich'?'rich':'source'}}/>);
  const large=new File([new Uint8Array(4*1024*1024+1)],'large.png',{type:'image/png'});
  if(entry==='chooser'){fireEvent.click(screen.getByRole('button',{name:'图片'}));fireEvent.change(result.container.querySelector('input[type="file"]')!,{target:{files:[large]}});}
  else fireEvent.paste(await screen.findByRole('textbox',{name:entry==='rich'?'Markdown 块编辑':'Markdown 源码'}),{clipboardData:{getData:()=>'',files:[large]}});
  expect(screen.getByRole('alert')).toHaveTextContent('4 MiB');expect(read).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
});

it('keeps BOM and CRLF when the local image chooser inserts at the initial source caret',async()=>{
  const changed=vi.fn(),result=render(<MarkdownEditor value={'\uFEFF# Heading\r\n'} onChange={changed} initialView={{mode:'source'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'图片'}));fireEvent.change(result.container.querySelector('input[type="file"]')!,{target:{files:[image()]}});
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'目标地址'})).toHaveValue('data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw=='));
  fireEvent.click(screen.getByRole('button',{name:'插入'}));
  expect(changed).toHaveBeenLastCalledWith('\uFEFF![current.png](data:image/png;base64,cmVhbCBpbWFnZSBieXRlcw==)# Heading\r\n');
});

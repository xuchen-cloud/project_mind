import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownEditor } from '../../../src/components/markdown/MarkdownEditor';

describe('Markdown editing and original source persistence', () => {
  it('formats the actual source selection, undo/redoes, saves real bytes and reopens', async () => {
    const original = '\uFEFF---\r\ntitle: "原样"\r\n---\r\n\r\n# 标题\n\n正文  \r\n保留\r\n';
    let current = original;
    const onChange = vi.fn((value: string) => { current = value; });
    const result = render(<MarkdownEditor value={original} onChange={onChange} initialView={{mode:'source'}} />);
    expect(onChange).not.toHaveBeenCalled();
    const source = screen.getByRole('textbox', {name:'Markdown 源码'});
    source.focus();
    // A native select-all keyboard command uses the real CodeMirror selection.
    fireEvent.keyDown(source, {key:'a', code:'KeyA', ctrlKey:true});
    fireEvent.click(screen.getByRole('button', {name:'粗体'}));
    expect(current).toContain('**');
    fireEvent.click(screen.getByRole('button', {name:'撤销'}));
    expect(current).toBe(original);
    fireEvent.click(screen.getByRole('button', {name:'重做'}));
    expect(current).toContain('**');
    const directory = await mkdtemp(join(tmpdir(), 'mind-markdown-'));
    try {
      const file = join(directory, 'roundtrip.md');
      await writeFile(file, current, 'utf8');
      const reopened = await readFile(file, 'utf8');
      expect(reopened).toBe(current);
      result.rerender(<MarkdownEditor value={reopened} onChange={onChange} initialView={{mode:'source'}} />);
      expect(screen.getByRole('textbox', {name:'Markdown 源码'}).textContent).toContain('正文');
    } finally { await rm(directory, {recursive:true, force:true}); }
  });

  it('uses latest value/callback/readOnly props without normalizing or emitting loads', async () => {
    const first = vi.fn(); const next = vi.fn();
    const {rerender} = render(<MarkdownEditor value={'one\r\n'} onChange={first} initialView={{mode:'source'}} />);
    rerender(<MarkdownEditor value={'\uFEFFtwo\r\nline\n'} onChange={next} readOnly initialView={{mode:'source'}} />);
    const source = screen.getByRole('textbox', {name:'Markdown 源码'});
    expect(source).toHaveAttribute('contenteditable', 'false');
    expect(source.textContent).toContain('two');
    expect(first).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    expect(screen.getByRole('button', {name:'粗体'})).toBeDisabled();
  });

  it('replaces real source matches in one undo group and keeps literal replacement text', async () => {
    let text = 'cat dog CAT\r\ncat\r\n';
    render(<MarkdownEditor value={text} onChange={value=>{text=value;}} initialView={{mode:'split'}} />);
    fireEvent.click(screen.getByRole('button', {name:'查找替换'}));
    fireEvent.change(screen.getByRole('textbox', {name:'查找'}), {target:{value:'cat'}});
    fireEvent.change(screen.getByRole('textbox', {name:'替换为'}), {target:{value:'$&猫'}});
    fireEvent.click(screen.getByRole('button', {name:'全部替换'}));
    expect(text).toBe('$&猫 dog $&猫\r\n$&猫\r\n');
    fireEvent.click(screen.getByRole('button', {name:'撤销'}));
    expect(text).toBe('cat dog CAT\r\ncat\r\n');
  });

  it('renders safe previews and only host-resolved images without changing stored source', () => {
    const onChange = vi.fn();
    const text = '# Safe\n\n<script>window.bad=1</script>\n\n[bad](javascript:alert(1))\n\n![image](asset.png)';
    const {container} = render(<MarkdownEditor value={text} onChange={onChange} resources={{'asset.png':'data:image/png;base64,aGVsbG8='}} initialView={{mode:'preview'}} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has actual rich editing, source-backed toolbar changes and no-op preservation', async () => {
    let text = '# Title\r\n\r\nOriginal text\r\n\r\n[ref]: /keep "verbatim"\r\n';
    const onChange = vi.fn((value:string)=>{text=value;});
    render(<MarkdownEditor value={text} onChange={onChange} initialView={{mode:'rich'}} />);
    const rich = await screen.findByRole('textbox', {name:'Markdown 块编辑'});
    expect(onChange).not.toHaveBeenCalled();
    rich.focus();
    fireEvent.click(screen.getByRole('button', {name:'分隔线'}));
    await waitFor(()=>expect(text).toContain('---'));
    expect(text).toContain('[ref]: /keep "verbatim"');
    expect(screen.getByRole('button', {name:'撤销'})).toBeEnabled();
  });
});

it('clears source undo on external documentKey changes, preserving normal save acknowledgements',()=>{
  let text='Original\r\n';const change=vi.fn((value:string)=>{text=value;});
  const {rerender}=render(<MarkdownEditor documentKey="1" value={text} onChange={change} initialView={{mode:'source'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'粗体'}));
  expect(screen.getByRole('button',{name:'撤销'})).toBeEnabled();
  rerender(<MarkdownEditor documentKey="1" value={text} onChange={change} initialView={{mode:'source'}}/>);
  expect(screen.getByRole('button',{name:'撤销'})).toBeEnabled();
  rerender(<MarkdownEditor documentKey="2" value={text} onChange={change} initialView={{mode:'source'}}/>);
  expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled();
});

it('clears rich undo for a new external baseline, including same-text historical versions',async()=>{
  let text='# Title\r\n';const change=(value:string)=>{text=value;};
  const {rerender}=render(<MarkdownEditor documentKey="1" value={text} onChange={change} initialView={{mode:'rich'}}/>);
  await screen.findByRole('textbox',{name:'Markdown 块编辑'});
  expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'分隔线'}));
  expect(screen.getByRole('button',{name:'撤销'})).toBeEnabled();
  rerender(<MarkdownEditor documentKey="1" value={text} onChange={change} initialView={{mode:'rich'}}/>);
  expect(screen.getByRole('button',{name:'撤销'})).toBeEnabled();
  rerender(<MarkdownEditor documentKey="2" value={text} onChange={change} initialView={{mode:'rich'}}/>);
  expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled();
});

it('keeps rich mode after the host acknowledges sourceMode=false',async()=>{
  const view=vi.fn();const {rerender}=render(<MarkdownEditor value="text" onChange={()=>{}} sourceMode onViewChange={view}/>);
  fireEvent.click(screen.getByRole('button',{name:'块编辑'}));
  expect(view).toHaveBeenLastCalledWith({mode:'rich',sourceMode:false});
  rerender(<MarkdownEditor value="text" onChange={()=>{}} sourceMode={false} onViewChange={view}/>);
  expect(await screen.findByRole('textbox',{name:'Markdown 块编辑'})).toBeVisible();
});

it('inserts a data image, previews it immediately, writes bytes, and reopens it',async()=>{
  const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEDsAAAAASUVORK5CYII=';
  let text='';const change=(value:string)=>{text=value;};
  const result=render(<MarkdownEditor value={text} onChange={change} initialView={{mode:'source'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'图片'}));
  fireEvent.change(screen.getByRole('textbox',{name:'目标地址'}),{target:{value:data}});
  fireEvent.change(screen.getByRole('textbox',{name:'显示文字'}),{target:{value:'新图片'}});
  fireEvent.click(screen.getByRole('button',{name:'插入'}));
  fireEvent.click(screen.getByRole('button',{name:'预览'}));
  expect(screen.getByRole('img',{name:'新图片'})).toHaveAttribute('src',data);
  const directory=await mkdtemp(join(tmpdir(),'mind-markdown-image-'));
  try{
    const file=join(directory,'image.md');await writeFile(file,text);const reopened=await readFile(file,'utf8');
    expect(reopened).toBe(`![新图片](${data})`);
    result.unmount();render(<MarkdownEditor value={reopened} onChange={()=>{}} initialView={{mode:'preview'}}/>);
    expect(screen.getByRole('img',{name:'新图片'})).toHaveAttribute('src',data);
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('waits for composing input before the host save guard resolves',async()=>{
  let flush:(()=>Promise<void>)|undefined;const pending=vi.fn();
  render(<MarkdownEditor value="" onChange={()=>{}} initialView={{mode:'source'}} registerBeforeSave={callback=>{flush=callback;return()=>{};}} onPendingChange={pending}/>);
  const source=screen.getByRole('textbox',{name:'Markdown 源码'});
  fireEvent.compositionStart(source);
  let saved=false;const saving=flush!().then(()=>{saved=true;});await Promise.resolve();
  expect(saved).toBe(false);expect(pending).toHaveBeenLastCalledWith(true);
  fireEvent.compositionEnd(source);
  await saving;expect(saved).toBe(true);expect(pending).toHaveBeenLastCalledWith(false);
});

it('performs actual rich table row/column commands and disables mutations in read-only mode',async()=>{
  let text='';const change=(value:string)=>{text=value;};
  const {container,rerender}=render(<MarkdownEditor value="" onChange={change} initialView={{mode:'rich'}}/>);
  await screen.findByRole('textbox',{name:'Markdown 块编辑'});
  fireEvent.click(screen.getByRole('button',{name:'表格'}));
  expect(container.querySelectorAll('.tiptap tr')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button',{name:'下方插入行'}));
  expect(container.querySelectorAll('.tiptap tr')).toHaveLength(4);
  expect(text).toContain('|');
  rerender(<MarkdownEditor value={text} onChange={change} readOnly initialView={{mode:'rich'}}/>);
  expect(screen.getByRole('textbox',{name:'Markdown 块编辑'})).toHaveAttribute('contenteditable','false');
  expect(screen.getByRole('button',{name:'表格'})).toBeDisabled();
  expect(screen.queryByRole('button',{name:'下方插入行'})).toBeNull();
});

it('inserts linked text at an empty rich caret and saves the actual Markdown target',async()=>{
  let text='';render(<MarkdownEditor value="" onChange={value=>{text=value;}} initialView={{mode:'rich'}}/>);
  await screen.findByRole('textbox',{name:'Markdown 块编辑'});
  fireEvent.click(screen.getByRole('button',{name:'链接'}));
  fireEvent.change(screen.getByRole('textbox',{name:'目标地址'}),{target:{value:'https://example.com/guide'}});
  fireEvent.change(screen.getByRole('textbox',{name:'显示文字'}),{target:{value:'使用指南'}});
  fireEvent.click(screen.getByRole('button',{name:'插入'}));
  expect(screen.getByRole('link',{name:'使用指南'})).toHaveAttribute('href','https://example.com/guide');
  expect(text).toContain('[使用指南](https://example.com/guide)');
});

it('resolves a newly authored relative image through the bound host without rewriting source',async()=>{
  const data='data:image/png;base64,aGVsbG8=';const resolver=vi.fn(async(reference:string)=>reference==='new.png'?data:undefined);const change=vi.fn();
  const {rerender}=render(<MarkdownEditor documentKey="one" value="" onChange={change} resolveResource={resolver} initialView={{mode:'preview'}}/>);
  rerender(<MarkdownEditor documentKey="one" value="![新增](new.png)\r\n![远程](https://invalid.test/x.png)" onChange={change} resolveResource={resolver} initialView={{mode:'preview'}}/>);
  await waitFor(()=>expect(screen.getByRole('img',{name:'新增'})).toHaveAttribute('src',data));
  expect(resolver).toHaveBeenCalledTimes(1);expect(resolver).toHaveBeenCalledWith('new.png');expect(resolver).not.toHaveBeenCalledWith('https://invalid.test/x.png');
  expect(screen.queryByRole('img',{name:'远程'})).toBeNull();expect(change).not.toHaveBeenCalled();
});

it('keeps frontmatter in source while preview renders only the document body',()=>{
  const change=vi.fn();const {container}=render(<MarkdownEditor value={'\uFEFF---\r\ntitle: 元数据\r\n---\r\n\r\n# 正文标题\r\n'} onChange={change} initialView={{mode:'preview'}}/>);
  const preview=container.querySelector('article')!;
  expect(preview.textContent).toContain('正文标题');expect(preview.textContent).not.toContain('元数据');
  expect(preview.querySelector('hr')).toBeNull();expect(change).not.toHaveBeenCalled();
});

it('dismisses a formula editor when the host switches the document to read-only',async()=>{
  const change=vi.fn();const {rerender}=render(<MarkdownEditor value="" onChange={change} initialView={{mode:'rich'}}/>);
  await screen.findByRole('textbox',{name:'Markdown 块编辑'});
  fireEvent.click(screen.getByRole('button',{name:'公式'}));
  expect(screen.getByPlaceholderText('输入 LaTeX 公式，如 E = mc^2')).toBeInTheDocument();
  rerender(<MarkdownEditor value="" onChange={change} readOnly initialView={{mode:'rich'}}/>);
  expect(screen.queryByPlaceholderText('输入 LaTeX 公式，如 E = mc^2')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

it('flushes a pasted image before save and cancels pending insertion across an external baseline',async()=>{
  let text='';let flush:(()=>Promise<void>)|undefined;const pending=vi.fn();
  const change=(value:string)=>{text=value;};
  const props={onChange:change,initialView:{mode:'rich' as const},registerBeforeSave:(callback:()=>Promise<void>)=>{flush=callback;return()=>{};},onPendingChange:pending};
  const result=render(<MarkdownEditor documentKey="one" value="" {...props}/>);
  const rich=await screen.findByRole('textbox',{name:'Markdown 块编辑'});
  fireEvent.paste(rich,{clipboardData:{getData:()=>'',files:[new File(['image bytes'],'paste.png',{type:'image/png'})]}});
  expect(pending).toHaveBeenLastCalledWith(true);
  await act(async()=>{await flush!();});
  expect(text).toContain('![paste.png](data:image/png;base64,');expect(pending).toHaveBeenLastCalledWith(false);
  fireEvent.paste(rich,{clipboardData:{getData:()=>'',files:[new File(['old image'],'old.png',{type:'image/png'})]}});
  result.rerender(<MarkdownEditor documentKey="two" value="# New baseline" {...props}/>);
  await act(async()=>{await flush!();});
  expect(screen.getByRole('heading',{name:'New baseline'})).toBeVisible();
  expect(screen.queryByRole('img',{name:'old.png'})).toBeNull();
});

it('inserts an image after a task list without lifting or changing its existing items',async()=>{
  const original='\uFEFF- [ ] 第一项\r\n- [x] 替换后的中文\r\n\r\n后文\r\n';let text=original;
  const result=render(<MarkdownEditor value={original} onChange={value=>{text=value;}} initialView={{mode:'rich'}}/>);
  const rich=await screen.findByRole('textbox',{name:'Markdown 块编辑'});rich.focus();
  const range=document.createRange();range.selectNodeContents(within(rich).getByText('替换后的中文'));range.collapse(false);
  window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);fireEvent(document,new Event('selectionchange'));
  fireEvent.click(screen.getByRole('button',{name:'图片'}));
  fireEvent.change(screen.getByRole('textbox',{name:'目标地址'}),{target:{value:'picture.png'}});
  fireEvent.change(screen.getByRole('textbox',{name:'显示文字'}),{target:{value:'插图'}});
  fireEvent.click(screen.getByRole('button',{name:'插入'}));
  expect(rich.querySelectorAll('li[data-checked]')).toHaveLength(2);
  expect(text).toContain('- [ ] 第一项\r\n- [x] 替换后的中文');
  expect(text.indexOf('![插图](picture.png)')).toBeGreaterThan(text.indexOf('- [x] 替换后的中文'));
  const directory=await mkdtemp(join(tmpdir(),'mind-markdown-list-image-'));
  try{
    const file=join(directory,'tasks.md');await writeFile(file,text);const reopened=await readFile(file,'utf8');
    result.unmount();render(<MarkdownEditor value={reopened} onChange={()=>{}} initialView={{mode:'rich'}}/>);
    expect((await screen.findByRole('textbox',{name:'Markdown 块编辑'})).querySelectorAll('li[data-checked]')).toHaveLength(2);
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('inserts a table after an ordered list while retaining its start number and all item text',async()=>{
  let text='3. 起始项\r\n4. 第二项\r\n';
  render(<MarkdownEditor value={text} onChange={value=>{text=value;}} initialView={{mode:'rich'}}/>);
  const rich=await screen.findByRole('textbox',{name:'Markdown 块编辑'});rich.focus();
  fireEvent.click(screen.getByRole('button',{name:'表格'}));
  expect(rich.querySelector('ol')).toHaveAttribute('start','3');
  expect(rich.querySelectorAll('ol>li')).toHaveLength(2);expect(rich.querySelector('table')).not.toBeNull();
  expect(text).toContain('3. 起始项\r\n4. 第二项');expect(text.indexOf('|')).toBeGreaterThan(text.indexOf('4. 第二项'));
});

it('shows parsed headings in the outline, ignores fenced code and supports resizing without source edits',()=>{
  const change=vi.fn();render(<MarkdownEditor value={'---\ntitle: metadata\n---\n\n真实 *标题*\n===\n\n```md\n# 代码里的伪标题\n```\n'} onChange={change} initialView={{mode:'source',outline:true}}/>);
  const outline=screen.getByRole('complementary');
  expect(within(outline).getByRole('button',{name:'真实 标题'})).toBeVisible();
  expect(within(outline).queryByRole('button',{name:'代码里的伪标题'})).toBeNull();
  const separator=screen.getByRole('separator',{name:'调整大纲宽度'});
  fireEvent.keyDown(separator,{key:'ArrowRight'});expect(separator).toHaveAttribute('aria-valuenow','248');
  expect(change).not.toHaveBeenCalled();
});

it('formats source containing backticks with a valid longer code fence while retaining original EOL',()=>{
  const original='a `b` c\r\n';let text=original;
  render(<MarkdownEditor value={original} onChange={value=>{text=value;}} initialView={{mode:'source'}}/>);
  const source=screen.getByRole('textbox',{name:'Markdown 源码'});source.focus();fireEvent.keyDown(source,{key:'a',code:'KeyA',ctrlKey:true});
  fireEvent.click(screen.getByRole('button',{name:'行内代码'}));expect(text).toBe('``a `b` c\r\n``');
  fireEvent.click(screen.getByRole('button',{name:'撤销'}));expect(text).toBe(original);
});

it('removes an emptied frontmatter block while keeping the BOM and body bytes',()=>{
  let text='\uFEFF---\r\ntitle: Original\r\n---\r\n\r\n# 正文\r\n';
  render(<MarkdownEditor value={text} onChange={value=>{text=value;}} initialView={{mode:'source'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'前置信息'}));
  fireEvent.change(screen.getByRole('textbox',{name:'YAML 前置信息'}),{target:{value:''}});
  expect(text).toBe('\uFEFF# 正文\r\n');
});

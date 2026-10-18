import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownEditor } from '../../../src/components/markdown/MarkdownEditor';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('exports the latest source to a real DOCX download, preserving marks/tables/images without modifying Markdown',async()=>{
  const blobs=new Map<string,Blob>();const downloads:{name:string;blob:Blob}[]=[];
  vi.stubGlobal('Image',class {naturalWidth=1;naturalHeight=1;onload:()=>void=()=>{};set src(_value:string){queueMicrotask(()=>this.onload());}});
  vi.stubGlobal('URL',class extends URL {static createObjectURL(blob:Blob){const key=`blob:test-${blobs.size}`;blobs.set(key,blob);return key;}static revokeObjectURL(){}});
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){downloads.push({name:this.download,blob:blobs.get(this.href)!});});
  const onChange=vi.fn();
  const original='\uFEFF# Old\r\n';
  const current='\uFEFF---\r\ntitle: metadata\r\n---\r\n\r\n# 导出验收\r\n\r\n**更新** 与 [链接](https://example.com)\r\n\r\n| 表头 |\r\n| --- |\r\n| 内容 |\r\n\r\n![图](asset.png)\r\n';
  const {rerender}=render(<MarkdownEditor value={original} onChange={onChange}/>);
  rerender(<MarkdownEditor value={current} onChange={onChange} readOnly resources={{'asset.png':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}}/>);
  fireEvent.click(screen.getByText('导出与打印'));
  fireEvent.click(screen.getByRole('button',{name:'导出 Word (.docx)'}));
  await waitFor(()=>expect(downloads).toHaveLength(1),{timeout:10000});
  expect(downloads[0].name).toBe('导出验收.docx');
  const bytes=await new Promise<Uint8Array>((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>resolve(new Uint8Array(reader.result as ArrayBuffer));reader.readAsArrayBuffer(downloads[0].blob);});
  const directory=await mkdtemp(join(tmpdir(),'markdown-export-'));
  try {
    const path=join(directory,downloads[0].name);await writeFile(path,bytes);
    const zip=await JSZip.loadAsync(await readFile(path));
    const xml=await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('导出验收');expect(xml).toContain('更新');expect(xml).toContain('<w:b');expect(xml).toContain('<w:tbl>');expect(xml).not.toContain('metadata');
    expect(Object.keys(zip.files).some(path=>path.startsWith('word/media/')&&!zip.files[path].dir)).toBe(true);
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain('https://example.com');
    expect(onChange).not.toHaveBeenCalled();
  } finally {await rm(directory,{recursive:true,force:true});vi.unstubAllGlobals();}
});

it('prepares a safe print iframe from the current document, calls print and releases it after printing',async()=>{
  let printed:Document|undefined;let ready='';const onChange=vi.fn();
  const resolver=vi.fn(async()=>undefined);
  Object.defineProperty(HTMLImageElement.prototype,'decode',{configurable:true,value:()=>Promise.resolve()});
  const append=document.body.append.bind(document.body);
  vi.spyOn(document.body,'append').mockImplementation((...nodes:(Node|string)[])=>{
    append(...nodes);
    for(const node of nodes)if(node instanceof HTMLIFrameElement){
      const doc=node.contentDocument!;doc.open();doc.write(node.srcdoc);doc.close();
      vi.spyOn(node.contentWindow!,'focus').mockImplementation(()=>{});
      vi.spyOn(node.contentWindow!,'print').mockImplementation(()=>{printed=doc.cloneNode(true) as Document;ready=node.dataset.markdownPrint??'';node.contentWindow!.dispatchEvent(new Event('afterprint'));});
      queueMicrotask(()=>node.dispatchEvent(new Event('load')));
    }
  });
  render(<MarkdownEditor value={'\uFEFF---\r\ntitle: private\r\n---\r\n\r\n# 打印验收\r\n\r\n$x^2$\r\n\r\n- [x] 已完成\r\n\r\n<script>window.stolen=1</script>\r\n\r\n![远程](https://example.com/private.png)\r\n'} onChange={onChange} readOnly resolveResource={resolver} initialView={{mode:'source'}}/>);
  fireEvent.keyDown(screen.getByRole('textbox',{name:'Markdown 源码'}),{key:'p',ctrlKey:true});
  await waitFor(()=>expect(printed).toBeDefined());
  expect(ready).toBe('ready');expect(printed!.querySelector('h1')?.textContent).toBe('打印验收');
  expect(printed!.querySelector('.katex')).not.toBeNull();expect(printed!.querySelector('li[data-checked=true]')).not.toBeNull();
  expect(printed!.querySelector('script')).toBeNull();expect(printed!.querySelector('img')).toBeNull();expect(printed!.body.textContent).not.toContain('title: private');
  expect(printed!.querySelector('[contenteditable],.md-codeblock-bar,.md-block-gutter')).toBeNull();
  expect(printed!.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull();
  await waitFor(()=>expect(document.querySelector('iframe[data-markdown-print]')).toBeNull());expect(onChange).not.toHaveBeenCalled();expect(resolver).not.toHaveBeenCalled();
});

it('cancels an in-flight export when the external document baseline changes',async()=>{
  let resolve!: (value:string)=>void;const resource=vi.fn(()=>new Promise<string>(done=>{resolve=done;}));
  const {rerender}=render(<MarkdownEditor documentKey="old" value={'# 旧文件\n\n![图片](new.png)'} onChange={()=>{}} resolveResource={resource} initialView={{mode:'source'}}/>);
  fireEvent.click(screen.getByText('导出与打印'));fireEvent.click(screen.getByRole('button',{name:'导出 Word (.docx)'}));
  await waitFor(()=>expect(resource).toHaveBeenCalledTimes(2));
  rerender(<MarkdownEditor documentKey="new" value="# 新文件" onChange={()=>{}} initialView={{mode:'source'}}/>);
  const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  resolve('data:image/png;base64,aGVsbG8=');await waitFor(()=>expect(screen.queryByText('正在准备导出…')).toBeNull());
  expect(click).not.toHaveBeenCalled();expect(screen.getByRole('textbox',{name:'Markdown 源码'})).toHaveTextContent('新文件');
});

it('awaits the latest host export callback and writes real bytes without using browser download',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'markdown-host-export-'));const anchor=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  let acknowledge!:()=>void;const pending=new Promise<void>(resolve=>{acknowledge=resolve;});const previous=vi.fn();
  const write=vi.fn(async(file:{name:string;mime:string;bytes:Uint8Array})=>{await pending;await writeFile(join(directory,file.name),file.bytes);return true;});
  const {rerender}=render(<MarkdownEditor value="# 宿主导出" onChange={()=>{}} onExport={previous}/>);
  rerender(<MarkdownEditor value="# 宿主导出" onChange={()=>{}} onExport={write} readOnly/>);
  try{
    fireEvent.click(screen.getByText('导出与打印'));fireEvent.click(screen.getByRole('button',{name:'导出 Word (.docx)'}));
    await waitFor(()=>expect(write).toHaveBeenCalledTimes(1));expect(screen.queryByText('已导出 Word 文档。')).toBeNull();
    expect(write.mock.calls[0][0].mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(write.mock.calls[0][0].bytes).toBeInstanceOf(Uint8Array);acknowledge();
    await waitFor(()=>expect(screen.getByText('已导出 Word 文档。')).toBeInTheDocument());
    const zip=await JSZip.loadAsync(await readFile(join(directory,'宿主导出.docx')));expect(await zip.file('word/document.xml')!.async('string')).toContain('宿主导出');
    expect(previous).not.toHaveBeenCalled();expect(anchor).not.toHaveBeenCalled();
  }finally{await rm(directory,{recursive:true,force:true});}
});

it.each(['cancel','fail'] as const)('reports host %s and never falls back to an anchor',async outcome=>{
  const anchor=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  render(<MarkdownEditor value="# 导出" onChange={()=>{}} onExport={async()=>{if(outcome==='fail')throw Error('磁盘已满');return false;}}/>);
  fireEvent.click(screen.getByText('导出与打印'));fireEvent.click(screen.getByRole('button',{name:'导出 Word (.docx)'}));
  await screen.findByText(outcome==='cancel'?'已取消导出。':'磁盘已满');expect(anchor).not.toHaveBeenCalled();
});

it('sends self-contained print HTML with real embedded fonts/images to the latest host callback',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'markdown-native-print-'));const previous=vi.fn();const fetchFont=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
    const url=new URL(String(input));expect(url.origin).toBe(location.origin);
    const bytes=await readFile(join(process.cwd(),'../../node_modules/katex/dist/fonts',url.pathname.split('/').pop()!));
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'font/woff2'}});
  });
  const printed=vi.fn(async(document:{html:string;title?:string})=>{await writeFile(join(directory,'print.html'),document.html);});
  const value='# 原生打印\r\n\r\n$x^2$\r\n\r\n![图片](pixel.png)';const resources={'pixel.png':'data:image/png;base64,aGVsbG8='};
  const {rerender}=render(<MarkdownEditor value={value} onChange={()=>{}} resources={resources} onPrint={previous}/>);
  rerender(<MarkdownEditor value={value} onChange={()=>{}} resources={resources} readOnly onPrint={printed}/>);
  try{
    fireEvent.click(screen.getByText('导出与打印'));fireEvent.click(screen.getByRole('button',{name:'打印…'}));
    await waitFor(()=>expect(printed).toHaveBeenCalledTimes(1));await screen.findByText('已提交系统打印。');
    const html=await readFile(join(directory,'print.html'),'utf8');expect(html).toContain('data:font/woff2;base64,');expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('<base');expect(html).not.toContain('url(/');expect(html).not.toContain('url(fonts/');expect(html).not.toContain('contenteditable=');
    expect(printed.mock.calls[0][0].title).toBe('原生打印');expect(fetchFont).toHaveBeenCalled();expect(previous).not.toHaveBeenCalled();
    expect(document.querySelector('iframe[data-markdown-print]')).toBeNull();
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('reports the exact font that cannot be embedded and does not fall back to browser printing',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('字体资源不可达'));const printed=vi.fn();
  render(<MarkdownEditor value={'# 打印\n\n$x^2$'} onChange={()=>{}} onPrint={printed}/>);
  fireEvent.click(screen.getByText('导出与打印'));fireEvent.click(screen.getByRole('button',{name:'打印…'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(/打印字体不能内嵌：.*\.woff2.*字体资源不可达/u);
  expect(printed).not.toHaveBeenCalled();expect(document.querySelector('iframe[data-markdown-print]')).toBeNull();
});

it('reports an external reference hidden in an SVG image before handing HTML to native print',async()=>{
  const printed=vi.fn();const fetchResource=vi.spyOn(globalThis,'fetch');
  const svg='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/private.png"/></svg>');
  render(<MarkdownEditor value={'# 打印\n\n![矢量图](vector.svg)'} onChange={()=>{}} resources={{'vector.svg':svg}} onPrint={printed}/>);
  fireEvent.click(screen.getByText('导出与打印'));fireEvent.click(screen.getByRole('button',{name:'打印…'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('打印图表包含不能内嵌的资源：https://example.com/private.png');
  expect(printed).not.toHaveBeenCalled();expect(fetchResource).not.toHaveBeenCalled();
});

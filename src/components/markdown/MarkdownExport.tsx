import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Download, Printer } from 'lucide-react';
import { ScrollMenu } from '../../../packages/markdown-editor/src/adapters/ui';
import type { MarkdownExportFormat, MarkdownExportWriter } from '../../../packages/markdown-editor/src/export/browser';
import type { MarkdownPrintHandler, MarkdownPdfRenderer } from '../../../packages/markdown-editor/src/export/document';
import { getErrorMessage } from '../../lib/errors';

export interface MarkdownExportHandle {print:()=>void}
export function MarkdownExport({value,resources,documentKey,resolveResource,waitForInput,onExport,onPrint,onRenderPdf,ref}:{value:string;resources:Record<string,string>;documentKey?:string|number;resolveResource?:(reference:string)=>Promise<string|undefined>;waitForInput:()=>Promise<void>;onExport?:MarkdownExportWriter;onPrint?:MarkdownPrintHandler;onRenderPdf?:MarkdownPdfRenderer;ref?:Ref<MarkdownExportHandle>}){
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
  const menu=useRef<HTMLDetailsElement>(null);const running=useRef<AbortController|null>(null);
  const latest=useRef({value,resources,resolveResource,waitForInput,onExport,onPrint,onRenderPdf});latest.current={value,resources,resolveResource,waitForInput,onExport,onPrint,onRenderPdf};
  useEffect(()=>{running.current?.abort();setBusy(false);setStatus('');setError('');return()=>running.current?.abort();},[documentKey]);
  async function run(format:MarkdownExportFormat){
    if(running.current&&!running.current.signal.aborted)return;
    const controller=new AbortController();running.current=controller;setBusy(true);setError('');setStatus('正在准备导出…');if(menu.current)menu.current.open=false;
    try{
      await latest.current.waitForInput();controller.signal.throwIfAborted();
      const [{prepareExportDocument},{deliverMarkdownExport}]=await Promise.all([import('../../../packages/markdown-editor/src/export/document'),import('../../../packages/markdown-editor/src/export/browser')]);controller.signal.throwIfAborted();
      const draft=latest.current;const document=await prepareExportDocument(draft.value,draft.resources,draft.resolveResource);controller.signal.throwIfAborted();
      const result=await deliverMarkdownExport(document,format,controller.signal,setStatus,draft.onExport,draft.onPrint,draft.onRenderPdf);controller.signal.throwIfAborted();
      setStatus([result,...document.warnings].join(' '));
    }catch(error){if(!controller.signal.aborted){setError(getErrorMessage(error));setStatus('');}}
    finally{if(running.current===controller){running.current=null;setBusy(false);}}
  }
  useImperativeHandle(ref,()=>({print:()=>void run('print')}));
  return <div className="mind-markdown__export">
    <details ref={menu} onKeyDown={event=>{if(event.key==='Escape'&&menu.current)menu.current.open=false;}}>
      <summary><Download size={14} aria-hidden="true"/>导出与打印</summary>
      <div className="mind-markdown__export-menu context-menu__panel"><ScrollMenu label="导出与打印">
        {([['docx','导出 Word (.docx)'],['pdf','导出 PDF (.pdf)'],['png','导出 PNG 图片'],['docs','转换为 Word（下载）'],['print','打印…']] as const).map(([format,label])=><button type="button" className="context-menu__item" disabled={busy} key={format} onClick={()=>void run(format)}>{format==='print'?<Printer size={14} aria-hidden="true"/>:<Download size={14} aria-hidden="true"/>}{label}</button>)}
        <p>{onRenderPdf?'PDF 保留文字排版。':'PDF 为分页图像。'}PNG 为分页图像，多页时导出 ZIP。</p>
      </ScrollMenu></div>
    </details>
    {busy?<span role="status">{status}</span>:error?<span role="alert">{error}</span>:status?<span role="status">{status}</span>:null}
  </div>;
}

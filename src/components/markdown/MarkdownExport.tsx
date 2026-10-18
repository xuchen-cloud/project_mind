import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {createPortal} from 'react-dom';
import {EditorFileMenu} from '../document/EditorFileMenu';
import type { MarkdownExportFormat, MarkdownExportWriter } from '../../../packages/markdown-editor/src/export/browser';
import type { MarkdownPrintHandler, MarkdownPdfRenderer } from '../../../packages/markdown-editor/src/export/document';
import { getErrorMessage } from '../../lib/errors';

export interface MarkdownExportHandle {print:()=>void}
export function MarkdownExport({menuToolbar,value,resources,documentKey,resolveResource,waitForInput,onExport,onPrint,onRenderPdf,ref}:{menuToolbar?:HTMLElement|null;value:string;resources:Record<string,string>;documentKey?:string|number;resolveResource?:(reference:string)=>Promise<string|undefined>;waitForInput:()=>Promise<void>;onExport?:MarkdownExportWriter;onPrint?:MarkdownPrintHandler;onRenderPdf?:MarkdownPdfRenderer;ref?:Ref<MarkdownExportHandle>}){
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
  const running=useRef<AbortController|null>(null);
  const latest=useRef({value,resources,resolveResource,waitForInput,onExport,onPrint,onRenderPdf});latest.current={value,resources,resolveResource,waitForInput,onExport,onPrint,onRenderPdf};
  useEffect(()=>{running.current?.abort();setBusy(false);setStatus('');setError('');return()=>running.current?.abort();},[documentKey]);
  async function run(format:MarkdownExportFormat){
    if(running.current&&!running.current.signal.aborted)return;
    const controller=new AbortController();running.current=controller;setBusy(true);setError('');setStatus('正在准备导出…');
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
  const menu=<EditorFileMenu format="markdown" documentKey={documentKey} disabled={busy} onSelect={command=>void run(command==='images'?'png':command as MarkdownExportFormat)}/>;
  return <>
    {menuToolbar?createPortal(menu,menuToolbar):menuToolbar===undefined?menu:null}
    {(busy||status||error)?<div className="mind-markdown__export"><span role={error?'alert':'status'} title={error||status}>{error||status}</span></div>:null}
  </>;
}

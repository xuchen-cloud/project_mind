import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Activity, ArrowDown, ArrowUp, CaseSensitive, FileCode2, ImagePlus, LayoutList, ListTree, Redo2, Search, Settings2, Sigma, SpellCheck, Table2, Undo2, WholeWord, Workflow, X } from 'lucide-react';
import { Button } from '../../ui/components/Button';
import { IconButton } from '../../ui/components/IconButton';
import { PopoverPanel } from '../../ui/components/PopoverPanel';
import { EditorLoading } from '../document/EditorLoading';
import { MarkdownOutline } from './MarkdownOutline';
import type { SourceController } from './SourceEditor';
const SourceEditor=lazy(()=>import('./SourceEditor').then(module=>({default:module.SourceEditor})));
import { RichMarkdownEditor } from './RichMarkdownEditor';
import { MarkdownExport, type MarkdownExportHandle } from './MarkdownExport';
import type { MarkdownExportWriter } from '../../../packages/markdown-editor/src/export/browser';
export type { MarkdownExportFile } from '../../../packages/markdown-editor/src/export/browser';
import type { MarkdownPrintHandler, MarkdownPdfRenderer } from '../../../packages/markdown-editor/src/export/document';
export type { MarkdownPrintDocument, MarkdownPdfRenderer } from '../../../packages/markdown-editor/src/export/document';
import { uiOp } from '../../../packages/markdown-editor/src/genoffice/editor/ops';
import { openMathCreate } from '../../../packages/markdown-editor/src/genoffice/editor/mathEdit';
import { MERMAID_TEMPLATE } from '../../../packages/markdown-editor/src/genoffice/editor/mermaid';
import { WAVEDROM_TEMPLATE } from '../../../packages/markdown-editor/src/genoffice/editor/wavedrom';
import type { FindTarget } from '../../../packages/markdown-editor/src/adapters/ui';
import { watchEdges } from './scrollEdges';
import { useDraftResources } from './useDraftResources';
import { MARKDOWN_IMAGE_LIMIT, firstImage } from '../../../packages/markdown-editor/src/adapters/imageInput';
import { StatusZoom } from '../../../packages/editor-chrome/StatusZoom';
import './markdown-editor.css';
import '../../../packages/editor-chrome/status-bar.css';
import '../../../packages/editor-chrome/editor-chrome.css';

export interface MarkdownEditorView {mode?:'source'|'split'|'preview'|'rich';zoom?:number;scrollTop?:number;previewScrollTop?:number;outline?:boolean;outlineWidth?:number;sourceMode?:boolean}
export interface MarkdownEditorProps {
  menuToolbar?:HTMLElement|null;
  value:string;onChange:(value:string)=>void;readOnly?:boolean;presentationMode?:'preview'|'edit';resources?:Record<string,string>;line?:number;
  initialView?:MarkdownEditorView;sourceMode?:boolean;documentKey?:string|number;onViewChange?:(view:MarkdownEditorView)=>void;
  resolveResource?:(reference:string)=>Promise<string|undefined>;
  registerBeforeSave?:(flush:()=>Promise<void>)=>()=>void;onPendingChange?:(pending:boolean)=>void;
  onExport?:MarkdownExportWriter;
  onPrint?:MarkdownPrintHandler;
  onRenderPdf?:MarkdownPdfRenderer;
}
const emptyResources:Record<string,string>={};
type EditorMode='source'|'rich';
function initialMode(view:MarkdownEditorView|undefined,sourceMode:boolean|undefined,line:number|undefined):EditorMode {
  if(line!==undefined&&Number.isFinite(line)&&line>0)return 'source';
  if(sourceMode!==undefined)return sourceMode?'source':'rich';
  if(view?.sourceMode!==undefined)return view.sourceMode?'source':'rich';
  return view?.mode==='source'?'source':'rich';
}
export function MarkdownEditor({menuToolbar,value,onChange,readOnly=false,resources=emptyResources,line,initialView,sourceMode,documentKey,onViewChange,registerBeforeSave,onPendingChange,resolveResource,onExport,onPrint,onRenderPdf}:MarkdownEditorProps) {
  const [text,setText]=useState(value),[mode,setMode]=useState<EditorMode>(()=>initialMode(initialView,sourceMode,line));
  const [zoom,setZoom]=useState(initialView?.zoom&&initialView.zoom>0?Math.max(50,Math.min(200,initialView.zoom)):100),[outline,setOutline]=useState(initialView?.outline??false),[spellcheck,setSpellcheck]=useState(false);
  const [outlineWidth,setOutlineWidth]=useState(initialView?.outlineWidth??232);
  const [richUsed,setRichUsed]=useState(mode==='rich');
  const [sourceUsed,setSourceUsed]=useState(mode==='source');
  const [revision,setRevision]=useState(0);void revision;
  const sourceRef=useRef<SourceController|null>(null),richRef=useRef<Editor|null>(null),richFind=useRef<FindTarget|null>(null);
  const sourceJump=useRef<{key:typeof documentKey;line:number}|null>(null);
  const [findOpen,setFindOpen]=useState(false),[query,setQuery]=useState(''),[replacement,setReplacement]=useState(''),[matchCase,setMatchCase]=useState(false),[wholeWord,setWholeWord]=useState(false),[count,setCount]=useState(0),[active,setActive]=useState(0);
  const [properties,setProperties]=useState(false),[insertPanel,setInsertPanel]=useState<'image'|null>(null),[destination,setDestination]=useState(''),[caption,setCaption]=useState(''),[error,setError]=useState('');
  const draftResources=useDraftResources(text,resources,documentKey,resolveResource,setError);
  const findInput=useRef<HTMLInputElement>(null),fileInput=useRef<HTMLInputElement>(null),toolbar=useRef<HTMLDivElement>(null),toolbarFrame=useRef<HTMLDivElement>(null);
  const imageReader=useRef<FileReader|null>(null);
  const latest=useRef({onChange,onViewChange,onPendingChange,readOnly,documentKey});latest.current={onChange,onViewChange,onPendingChange,readOnly,documentKey};
  const pending=useRef(false),waiters=useRef(new Set<()=>void>());
  const exportRef=useRef<MarkdownExportHandle>(null);
  const waitForInput=useCallback(async()=>{if(pending.current)await new Promise<void>(resolve=>waiters.current.add(resolve));},[]);
  const pendingInputs=useRef({source:false,rich:false,chooser:false});
  const selectionChanged=useCallback(()=>setRevision(value=>value+1),[]);
  const changed=useCallback((next:string)=>{if(latest.current.readOnly)return;setText(next);latest.current.onChange(next);},[]);
  const ready=useCallback((controller:SourceController|null)=>{sourceRef.current=controller;const jump=sourceJump.current;if(controller&&jump){sourceJump.current=null;if(jump.key===latest.current.documentKey)controller.goto(jump.line);}setRevision(value=>value+1);},[]);
  const richReady=useCallback((editor:Editor|null,target:FindTarget|null)=>{richRef.current=editor;richFind.current=target;setRevision(value=>value+1);},[]);
  const pendingChanged=useCallback((next:boolean)=>{pending.current=next;setRevision(value=>value+1);latest.current.onPendingChange?.(next);if(!next){waiters.current.forEach(resolve=>resolve());waiters.current.clear();}},[]);
  const inputPending=useCallback((kind:keyof typeof pendingInputs.current,next:boolean)=>{pendingInputs.current[kind]=next;pendingChanged(Object.values(pendingInputs.current).some(Boolean));},[pendingChanged]);
  const sourcePending=useCallback((next:boolean)=>inputPending('source',next),[inputPending]);
  const richPending=useCallback((next:boolean)=>inputPending('rich',next),[inputPending]);
  const cancelImageRead=useCallback(()=>{const reader=imageReader.current;imageReader.current=null;if(reader){reader.onload=null;reader.onerror=null;reader.onabort=null;reader.abort();}inputPending('chooser',false);},[inputPending]);
  useEffect(()=>setText(value),[value]);
  useEffect(()=>{setInsertPanel(null);setDestination('');setCaption('');return cancelImageRead;},[documentKey,readOnly,cancelImageRead]);
  useEffect(()=>{if(sourceMode!==undefined)setMode(sourceMode?'source':'rich');},[sourceMode]);
  useEffect(()=>{
    if(line===undefined||!Number.isFinite(line)||line<=0)return;
    setMode('source');setSourceUsed(true);
    latest.current.onViewChange?.({mode:'source',sourceMode:true});
    if(!sourceRef.current){sourceJump.current={key:documentKey,line};return;}
    const frame=requestAnimationFrame(()=>sourceRef.current?.goto(line));
    return()=>cancelAnimationFrame(frame);
  },[line,documentKey]);
  useEffect(()=>{if(mode==='rich')setRichUsed(true);if(mode==='source')setSourceUsed(true);},[mode]);
  useEffect(()=>registerBeforeSave?.(async()=>{if(pending.current)await new Promise<void>(resolve=>waiters.current.add(resolve));}),[registerBeforeSave]);
  useEffect(()=>()=>{latest.current.onPendingChange?.(false);waiters.current.forEach(resolve=>resolve());waiters.current.clear();},[]);
  useEffect(()=>{if(toolbar.current&&toolbarFrame.current)return watchEdges(toolbar.current,toolbarFrame.current);},[]);
  const target=mode==='rich'?richFind.current:sourceRef.current?.find;
  useEffect(()=>{
    if(!target)return;
    if(!findOpen){target.clear();setCount(0);return;}
    const total=target.search(query,{matchCase,wholeWord},active);setCount(total);
    if(active>=total&&active!==0)setActive(Math.max(0,total-1));
  },[target,findOpen,query,matchCase,wholeWord,text,active]);
  function view(next:MarkdownEditorView){latest.current.onViewChange?.(next);}
  function chooseMode(next:EditorMode){setMode(next);if(next==='rich')setRichUsed(true);view({mode:next,sourceMode:next==='source'});}
  function jumpToSource(line:number){chooseMode('source');if(sourceRef.current)requestAnimationFrame(()=>sourceRef.current?.goto(line));else sourceJump.current={key:documentKey,line};}
  function zoomTo(next:number){const clamped=Math.max(50,Math.min(200,next));setZoom(clamped);view({zoom:clamped});}
  function search(){cancelImageRead();setInsertPanel(null);setProperties(false);setFindOpen(true);requestAnimationFrame(()=>findInput.current?.focus());}
  function navigate(delta:number){if(!target||!count)return;const next=(active+delta+count)%count;setActive(next);target.activate(next);}
  function insert(markdown:string){if(readOnly)return;if(mode==='rich'&&richRef.current)uiOp(richRef.current,{op:'insertContent',after:'selection',markdown});else {sourceRef.current?.insert(markdown);}}
  function undo(){if(readOnly)return;if(mode==='rich')richRef.current?.chain().focus().undo().run();else sourceRef.current?.undo();}
  function redo(){if(readOnly)return;if(mode==='rich')richRef.current?.chain().focus().redo().run();else sourceRef.current?.redo();}
  const canUndo=!readOnly&&(mode==='rich'?richRef.current?.can().undo():sourceRef.current?.canUndo());
  const canRedo=!readOnly&&(mode==='rich'?richRef.current?.can().redo():sourceRef.current?.canRedo());
  function openInsert(kind:'image'){cancelImageRead();setFindOpen(false);setProperties(false);setInsertPanel(kind);setDestination('');setCaption('');}
  function commitInsert(){
    if(readOnly||!destination.trim())return;
    const url=destination.trim();
    if(/^(?:javascript|vbscript):/iu.test(url)){setError('此链接协议无法使用。');return;}
    const label=caption.replace(/[\\[\]]/gu,'\\$&');const dest=/[\s()<>]/u.test(url)?`<${url.replace(/[<>]/gu,'')}>`:url;
    if(mode==='rich'&&richRef.current)uiOp(richRef.current,{op:'insertImage',after:'selection',src:url,alt:caption});
    else insert(`![${label}](${dest})`);
    setInsertPanel(null);setError('');
  }
  const fm=/^(\uFEFF?---(?:\r\n|\n|\r))([\s\S]*?)((?:\r\n|\n|\r)---(?=\r\n|\n|\r|$))/u.exec(text);
  return <section className="mind-markdown" aria-label="Markdown 编辑器" data-mode={mode} data-readonly={readOnly||undefined}
    onKeyDown={event=>{
      if(event.key==='Escape'){setFindOpen(false);setProperties(false);cancelImageRead();setInsertPanel(null);return;}
      if(!(event.metaKey||event.ctrlKey))return;
      if(event.key.toLowerCase()==='f'||event.key.toLowerCase()==='h'){event.preventDefault();event.stopPropagation();search();}
      else if(event.key==='='||event.key==='+'){event.preventDefault();zoomTo(zoom+10);}
      else if(event.key==='-'){event.preventDefault();zoomTo(zoom-10);}
      else if(event.key==='0'){event.preventDefault();zoomTo(100);}
      else if(event.key.toLowerCase()==='e'){event.preventDefault();chooseMode(mode==='source'?'rich':'source');}
      else if(event.key.toLowerCase()==='p'){event.preventDefault();event.stopPropagation();exportRef.current?.print();}
    }}>
    <MarkdownExport menuToolbar={menuToolbar} ref={exportRef} value={text} resources={draftResources} documentKey={documentKey} resolveResource={resolveResource} waitForInput={waitForInput} onExport={onExport} onPrint={onPrint} onRenderPdf={onRenderPdf}/>
    <div ref={toolbarFrame} className="mind-markdown__toolbar-frame mind-markdown__edges"><div ref={toolbar} className="mind-markdown__toolbar pm-editor-toolbar" role="toolbar" aria-label="Markdown 工具">
      <div role="group" aria-label="编辑模式" className="mind-markdown__mode">
        <Tool modeControl label="块编辑" pressed={mode==='rich'} onClick={()=>chooseMode('rich')}><LayoutList/></Tool>
        <Tool modeControl label="源码" pressed={mode==='source'} onClick={()=>chooseMode('source')}><FileCode2/></Tool>
      </div>
      <span className="mind-markdown__separator pm-editor-separator"/>
      <Tool label="撤销" disabled={!canUndo} onClick={undo}><Undo2/></Tool><Tool label="重做" disabled={!canRedo} onClick={redo}><Redo2/></Tool>
      <span className="mind-markdown__separator pm-editor-separator"/>
      <Tool label="表格" disabled={readOnly} onClick={()=>mode==='rich'&&richRef.current?uiOp(richRef.current,{op:'insertTable',after:'selection'}):insert('\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n')}><Table2/></Tool>
      <Tool label="图片" disabled={readOnly} pressed={insertPanel==='image'} onClick={()=>openInsert('image')}><ImagePlus/></Tool>
      <Tool label="公式" disabled={readOnly} onClick={()=>mode==='rich'&&richRef.current?openMathCreate(richRef.current):insert('\n$$\nx^2\n$$\n')}><Sigma/></Tool>
      <Tool label="Mermaid 图表" disabled={readOnly} onClick={()=>insert(MERMAID_TEMPLATE)}><Workflow/></Tool>
      <Tool label="WaveDrom 波形" disabled={readOnly} onClick={()=>insert(WAVEDROM_TEMPLATE)}><Activity/></Tool>
      <Tool label="查找替换" pressed={findOpen} onClick={search}><Search/></Tool>
      <Tool label="大纲" pressed={outline} onClick={()=>{setOutline(!outline);view({outline:!outline});}}><ListTree/></Tool>
      <Tool label="前置信息" pressed={properties} onClick={()=>{cancelImageRead();setInsertPanel(null);setFindOpen(false);setProperties(!properties);}}><Settings2/></Tool>
      <Tool label="拼写检查" pressed={spellcheck} onClick={()=>setSpellcheck(!spellcheck)}><SpellCheck/></Tool>
    </div></div>
    {pending.current?<div className="mind-markdown__input-status" role="status">正在处理输入或图片，保存会等待完成…</div>:null}
    {findOpen?<Panel title="查找替换" onClose={()=>setFindOpen(false)}>
      <div className="mind-markdown__find" role="search" aria-label="文档查找替换">
        <div className="mind-markdown__panel-row">
          <input ref={findInput} aria-label="查找" placeholder="查找" value={query} onChange={event=>{setQuery(event.target.value);setActive(0);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();navigate(event.shiftKey?-1:1);}}}/>
          <Tool label="区分大小写" pressed={matchCase} onClick={()=>setMatchCase(!matchCase)}><CaseSensitive/></Tool>
          <Tool label="整词" pressed={wholeWord} onClick={()=>setWholeWord(!wholeWord)}><WholeWord/></Tool>
        </div>
        <div className="mind-markdown__panel-row">
          <input aria-label="替换为" placeholder="替换为" value={replacement} disabled={readOnly} onChange={event=>setReplacement(event.target.value)}/>
          <Tool label="上一处" disabled={!count} onClick={()=>navigate(-1)}><ArrowUp/></Tool><Tool label="下一处" disabled={!count} onClick={()=>navigate(1)}><ArrowDown/></Tool>
        </div>
        <div className="mind-markdown__panel-actions"><span role="status">{count?`${active+1} / ${count}`:'0 项'}</span>
          <Button type="button" size="sm" variant="ghost" disabled={readOnly||!count} onClick={()=>target?.replaceOne(active,replacement)}>替换</Button>
          <Button type="button" size="sm" disabled={readOnly||!count} onClick={()=>target?.replaceAll(replacement)}>全部替换</Button>
        </div>
      </div>
    </Panel>:null}
    {insertPanel?<Panel title="插入图片" onClose={()=>{cancelImageRead();setInsertPanel(null);}}>
      <form className="mind-markdown__insert" onSubmit={event=>{event.preventDefault();commitInsert();}}>
        <label>图片路径 / URL<input autoFocus aria-label="目标地址" placeholder="资源路径或图片地址" value={destination} disabled={pendingInputs.current.chooser} onChange={event=>setDestination(event.target.value)}/></label>
        <label>替代文字<input aria-label="显示文字" value={caption} disabled={pendingInputs.current.chooser} onChange={event=>setCaption(event.target.value)}/></label>
        <div className="mind-markdown__panel-actions">
          <Button type="button" size="sm" variant="ghost" disabled={readOnly} onClick={()=>fileInput.current?.click()}>选择图片</Button>
          <Button type="button" size="sm" variant="ghost" onClick={()=>{cancelImageRead();setInsertPanel(null);}}>取消</Button>
          <Button type="submit" size="sm" variant="primary" disabled={readOnly||pendingInputs.current.chooser||!destination.trim()}>插入</Button>
        </div>
      </form>
    </Panel>:null}
    <input hidden ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" onChange={event=>{
      const file=firstImage(event.target.files);event.target.value='';if(!file||readOnly)return;
      if(file.size>MARKDOWN_IMAGE_LIMIT){setError('图片超过 4 MiB，请使用已纳管资源的路径。');return;}
      cancelImageRead();setDestination('');const reader=new FileReader();imageReader.current=reader;inputPending('chooser',true);setRevision(value=>value+1);
      reader.onerror=()=>{if(imageReader.current!==reader||latest.current.documentKey!==documentKey)return;cancelImageRead();setError('读取图片失败。');};
      reader.onload=()=>{
        const isCurrent=()=>imageReader.current===reader&&latest.current.documentKey===documentKey&&!latest.current.readOnly;
        if(isCurrent()){setDestination(String(reader.result));setCaption(file.name);}
        if(imageReader.current===reader){cancelImageRead();setRevision(value=>value+1);}
      };reader.readAsDataURL(file);
    }}/>
    {properties?<Panel title="前置信息" onClose={()=>setProperties(false)}><label className="mind-markdown__properties">YAML 前置信息<textarea aria-label="YAML 前置信息" readOnly={readOnly} spellCheck={false} value={fm?.[2]??''} onChange={event=>{
      if(readOnly)return;const eol=text.match(/\r\n|\r|\n/u)?.[0]??'\n';const yaml=event.target.value.replace(/\r\n|\r|\n/gu,eol);
      if(!yaml.trim()){if(fm)changed((text.startsWith('\uFEFF')?'\uFEFF':'')+text.slice(fm[0].length).replace(/^(?:\r\n|\r|\n)*/u,''));return;}
      changed(fm?text.slice(0,fm[1].length)+yaml+text.slice(fm[1].length+fm[2].length):`${text.startsWith('\uFEFF')?'\uFEFF':''}---${eol}${yaml}${eol}---${eol}${eol}${text.replace(/^\uFEFF/u,'')}`);
    }}/></label></Panel>:null}
    {error?<div role="alert" className="mind-markdown__error">{error}<button type="button" aria-label="关闭错误" onClick={()=>setError('')}>×</button></div>:null}
    <div className="mind-markdown__workspace">
      {outline?<MarkdownOutline value={text} width={outlineWidth} onResize={width=>{setOutlineWidth(width);view({outlineWidth:width});}} onJump={jumpToSource}/>:null}
      <div className="mind-markdown__panes">
        <div className="mind-markdown__source-pane" hidden={mode!=='source'}>{sourceUsed?<Suspense fallback={<EditorLoading format="markdown" stage="runtime"/>}><SourceEditor documentKey={documentKey} value={text} readOnly={readOnly} zoom={zoom} spellcheck={spellcheck} onChange={changed} onReady={ready} onSelection={selectionChanged} onPending={sourcePending} onError={setError} line={line} scrollTop={initialView?.scrollTop} onScroll={top=>view({scrollTop:top})}/></Suspense>:null}</div>
        {richUsed?<div className="mind-markdown__rich-pane" hidden={mode!=='rich'}><RichMarkdownEditor documentKey={documentKey} value={text} readOnly={readOnly} resources={draftResources} zoom={zoom} spellcheck={spellcheck} onChange={changed} onReady={richReady} onSelection={selectionChanged} onPending={richPending} onError={setError} onImage={()=>openInsert('image')}/></div>:null}
      </div>
    </div>
    <footer className="mind-markdown__status pm-editor-status">
      <span className="mind-markdown__document-status">Markdown · {text.split(/\r\n|\r|\n/u).length} 行{readOnly?<span className="mind-markdown__readonly">只读</span>:null}</span>
      <StatusZoom value={zoom} min={50} max={200} step={10} onChange={zoomTo} onValueClick={()=>zoomTo(100)}/>
    </footer>
  </section>;
}
function Tool({label,onClick,disabled,pressed,modeControl,children}:{label:string;onClick:()=>void;disabled?:boolean;pressed?:boolean;modeControl?:boolean;children:React.ReactNode}){return <IconButton size="sm" className={`mind-markdown__tool pm-editor-tool${modeControl?' pm-editor-mode':''}`} type="button" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={onClick}>{children}</IconButton>;}

function Panel({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}) {
  const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    (ref.current?.querySelector<HTMLElement>('input:not([disabled]),textarea')??ref.current?.querySelector('button'))?.focus();
    const dismiss=(event:PointerEvent)=>{if(event.target instanceof Node&&!ref.current?.contains(event.target))close.current();};
    document.addEventListener('pointerdown',dismiss);
    return()=>document.removeEventListener('pointerdown',dismiss);
  },[]);
  return <PopoverPanel ref={ref} className="mind-markdown__panel" role="dialog" aria-label={title}><div className="mind-markdown__panel-header"><span>{title}</span><Tool label={`关闭${title==='查找替换'?'查找':title}`} onClick={onClose}><X/></Tool></div>{children}</PopoverPanel>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { ListTodo } from 'lucide-react';
import { MarkdownOutline } from './MarkdownOutline';
import { SourceEditor, type SourceController } from './SourceEditor';
import { RichMarkdownEditor } from './RichMarkdownEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { MarkdownExport, type MarkdownExportHandle } from './MarkdownExport';
import type { MarkdownExportWriter } from '../../../packages/markdown-editor/src/export/browser';
export type { MarkdownExportFile } from '../../../packages/markdown-editor/src/export/browser';
import type { MarkdownPrintHandler, MarkdownPdfRenderer } from '../../../packages/markdown-editor/src/export/document';
export type { MarkdownPrintDocument, MarkdownPdfRenderer } from '../../../packages/markdown-editor/src/export/document';
import { uiOp, moveSelectedBlocks } from '../../../packages/markdown-editor/src/genoffice/editor/ops';
import { openMathCreate } from '../../../packages/markdown-editor/src/genoffice/editor/mathEdit';
import { MERMAID_TEMPLATE } from '../../../packages/markdown-editor/src/genoffice/editor/mermaid';
import { WAVEDROM_TEMPLATE } from '../../../packages/markdown-editor/src/genoffice/editor/wavedrom';
import type { FindTarget } from '../../../packages/markdown-editor/src/adapters/ui';
import { watchEdges } from './scrollEdges';
import { useDraftResources } from './useDraftResources';
import { MARKDOWN_IMAGE_LIMIT, firstImage } from '../../../packages/markdown-editor/src/adapters/imageInput';
import './markdown-editor.css';

export interface MarkdownEditorView {mode?:'source'|'split'|'preview'|'rich';zoom?:number;scrollTop?:number;previewScrollTop?:number;outline?:boolean;outlineWidth?:number;sourceMode?:boolean}
export interface MarkdownEditorProps {
  value:string;onChange:(value:string)=>void;readOnly?:boolean;resources?:Record<string,string>;line?:number;
  initialView?:MarkdownEditorView;sourceMode?:boolean;documentKey?:string|number;onViewChange?:(view:MarkdownEditorView)=>void;
  resolveResource?:(reference:string)=>Promise<string|undefined>;
  registerBeforeSave?:(flush:()=>Promise<void>)=>()=>void;onPendingChange?:(pending:boolean)=>void;
  onExport?:MarkdownExportWriter;
  onPrint?:MarkdownPrintHandler;
  onRenderPdf?:MarkdownPdfRenderer;
}
const emptyResources:Record<string,string>={};
export function MarkdownEditor({value,onChange,readOnly=false,resources=emptyResources,line,initialView,sourceMode,documentKey,onViewChange,registerBeforeSave,onPendingChange,resolveResource,onExport,onPrint,onRenderPdf}:MarkdownEditorProps) {
  const [text,setText]=useState(value),[mode,setMode]=useState<NonNullable<MarkdownEditorView['mode']>>(sourceMode===true?'source':initialView?.mode??'split');
  const [zoom,setZoom]=useState(initialView?.zoom&&initialView.zoom>0?initialView.zoom:100),[outline,setOutline]=useState(initialView?.outline??false),[spellcheck,setSpellcheck]=useState(false);
  const [outlineWidth,setOutlineWidth]=useState(initialView?.outlineWidth??232);
  const [richUsed,setRichUsed]=useState(mode==='rich');
  const [revision,setRevision]=useState(0);void revision;
  const sourceRef=useRef<SourceController|null>(null),richRef=useRef<Editor|null>(null),richFind=useRef<FindTarget|null>(null);
  const [findOpen,setFindOpen]=useState(false),[query,setQuery]=useState(''),[replacement,setReplacement]=useState(''),[matchCase,setMatchCase]=useState(false),[wholeWord,setWholeWord]=useState(false),[count,setCount]=useState(0),[active,setActive]=useState(0);
  const [goto,setGoto]=useState(''),[properties,setProperties]=useState(false),[insertPanel,setInsertPanel]=useState<'link'|'image'|null>(null),[destination,setDestination]=useState(''),[caption,setCaption]=useState(''),[error,setError]=useState('');
  const draftResources=useDraftResources(text,resources,documentKey,resolveResource,setError);
  const findInput=useRef<HTMLInputElement>(null),fileInput=useRef<HTMLInputElement>(null),toolbar=useRef<HTMLDivElement>(null),toolbarFrame=useRef<HTMLDivElement>(null);
  const imageReader=useRef<FileReader|null>(null);
  const latest=useRef({onChange,onViewChange,onPendingChange,readOnly,documentKey});latest.current={onChange,onViewChange,onPendingChange,readOnly,documentKey};
  const pending=useRef(false),waiters=useRef(new Set<()=>void>());
  const exportRef=useRef<MarkdownExportHandle>(null);
  const waitForInput=useCallback(async()=>{if(pending.current)await new Promise<void>(resolve=>waiters.current.add(resolve));},[]);
  const previousModeProp=useRef(sourceMode);
  const pendingInputs=useRef({source:false,rich:false,chooser:false});
  const selectionChanged=useCallback(()=>setRevision(value=>value+1),[]);
  const changed=useCallback((next:string)=>{if(latest.current.readOnly)return;setText(next);latest.current.onChange(next);},[]);
  const ready=useCallback((controller:SourceController|null)=>{sourceRef.current=controller;setRevision(value=>value+1);},[]);
  const richReady=useCallback((editor:Editor|null,target:FindTarget|null)=>{richRef.current=editor;richFind.current=target;setRevision(value=>value+1);},[]);
  const pendingChanged=useCallback((next:boolean)=>{pending.current=next;setRevision(value=>value+1);latest.current.onPendingChange?.(next);if(!next){waiters.current.forEach(resolve=>resolve());waiters.current.clear();}},[]);
  const inputPending=useCallback((kind:keyof typeof pendingInputs.current,next:boolean)=>{pendingInputs.current[kind]=next;pendingChanged(Object.values(pendingInputs.current).some(Boolean));},[pendingChanged]);
  const sourcePending=useCallback((next:boolean)=>inputPending('source',next),[inputPending]);
  const richPending=useCallback((next:boolean)=>inputPending('rich',next),[inputPending]);
  const cancelImageRead=useCallback(()=>{const reader=imageReader.current;imageReader.current=null;if(reader){reader.onload=null;reader.onerror=null;reader.onabort=null;reader.abort();}inputPending('chooser',false);},[inputPending]);
  useEffect(()=>setText(value),[value]);
  useEffect(()=>{setInsertPanel(null);setDestination('');setCaption('');return cancelImageRead;},[documentKey,readOnly,cancelImageRead]);
  useEffect(()=>{if(sourceMode!==previousModeProp.current){previousModeProp.current=sourceMode;if(sourceMode!==undefined)setMode(sourceMode?'source':'split');}},[sourceMode]);
  useEffect(()=>{if(mode==='rich')setRichUsed(true);},[mode]);
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
  function chooseMode(next:NonNullable<MarkdownEditorView['mode']>){previousModeProp.current=next==='source';setMode(next);if(next==='rich')setRichUsed(true);view({mode:next,sourceMode:next==='source'});}
  function zoomTo(next:number){const clamped=Math.max(50,Math.min(200,next));setZoom(clamped);view({zoom:clamped});}
  function search(){setFindOpen(true);requestAnimationFrame(()=>findInput.current?.focus());}
  function navigate(delta:number){if(!target||!count)return;const next=(active+delta+count)%count;setActive(next);if(mode==='preview')chooseMode('split');target.activate(next);}
  function insert(markdown:string){if(readOnly)return;if(mode==='rich'&&richRef.current)uiOp(richRef.current,{op:'insertContent',after:'selection',markdown});else {if(mode==='preview')chooseMode('split');sourceRef.current?.insert(markdown);}}
  function format(kind:string){
    if(readOnly)return;
    const editor=richRef.current;
    if(mode!=='rich'||!editor){if(mode==='preview')chooseMode('split');sourceRef.current?.format(kind);return;}
    if(['bold','italic','strike','code'].includes(kind))uiOp(editor,{op:'setStyle',target:'selection',style:kind as 'bold'|'italic'|'strike'|'code',mode:'toggle'});
    else if(['bullet','ordered','task'].includes(kind))uiOp(editor,{op:'toggleList',target:'selection',list:kind as 'bullet'|'ordered'|'task'});
    else if(kind.startsWith('h'))uiOp(editor,{op:'setBlockType',target:'selection',type:'heading',level:Number(kind.slice(1))});
    else uiOp(editor,{op:'setBlockType',target:'selection',type:kind==='quote'?'blockquote':'paragraph'});
  }
  function undo(){if(readOnly)return;if(mode==='rich')richRef.current?.chain().focus().undo().run();else sourceRef.current?.undo();}
  function redo(){if(readOnly)return;if(mode==='rich')richRef.current?.chain().focus().redo().run();else sourceRef.current?.redo();}
  const canUndo=!readOnly&&(mode==='rich'?richRef.current?.can().undo():sourceRef.current?.canUndo());
  const canRedo=!readOnly&&(mode==='rich'?richRef.current?.can().redo():sourceRef.current?.canRedo());
  function openInsert(kind:'link'|'image'){cancelImageRead();setInsertPanel(kind);setDestination('');setCaption('');}
  function commitInsert(){
    if(readOnly||!destination.trim())return;
    const url=destination.trim();
    if(/^(?:javascript|vbscript):/iu.test(url)){setError('此链接协议无法使用。');return;}
    const label=caption.replace(/[\\[\]]/gu,'\\$&');const dest=/[\s()<>]/u.test(url)?`<${url.replace(/[<>]/gu,'')}>`:url;
    if(mode==='rich'&&richRef.current){
      if(insertPanel==='link'){
        const editor=richRef.current;
        if(editor.state.selection.empty)editor.chain().focus().insertContent({type:'text',text:caption||url,marks:[{type:'link',attrs:{href:url}}]}).run();
        else uiOp(editor,{op:'setLink',target:'selection',href:url});
      }
      else uiOp(richRef.current,{op:'insertImage',after:'selection',src:url,alt:caption});
    }else insert(`${insertPanel==='image'?'!':''}[${label}](${dest})`);
    setInsertPanel(null);setError('');
  }
  const fm=/^(\uFEFF?---(?:\r\n|\n|\r))([\s\S]*?)((?:\r\n|\n|\r)---(?=\r\n|\n|\r|$))/u.exec(text);
  return <section className="mind-markdown" aria-label="Markdown 编辑器" data-mode={mode} data-readonly={readOnly||undefined}
    onKeyDown={event=>{
      if(!(event.metaKey||event.ctrlKey))return;
      if(event.key.toLowerCase()==='f'||event.key.toLowerCase()==='h'){event.preventDefault();event.stopPropagation();search();}
      else if(event.key==='='||event.key==='+'){event.preventDefault();zoomTo(zoom+10);}
      else if(event.key==='-'){event.preventDefault();zoomTo(zoom-10);}
      else if(event.key==='0'){event.preventDefault();zoomTo(100);}
      else if(event.key.toLowerCase()==='e'){event.preventDefault();chooseMode(mode==='preview'?'split':'preview');}
      else if(event.key.toLowerCase()==='p'){event.preventDefault();event.stopPropagation();exportRef.current?.print();}
    }}>
    <div ref={toolbarFrame} className="mind-markdown__toolbar-frame mind-markdown__edges"><div ref={toolbar} className="mind-markdown__toolbar" role="toolbar" aria-label="Markdown 格式">
      <Tool label="撤销" disabled={!canUndo} onClick={undo}>↶</Tool><Tool label="重做" disabled={!canRedo} onClick={redo}>↷</Tool>
      <select aria-label="段落格式" disabled={readOnly} value="" onChange={event=>format(event.target.value)}><option value="" disabled>段落格式</option><option value="paragraph">正文</option>{[1,2,3,4,5,6].map(level=><option value={`h${level}`} key={level}>标题 {level}</option>)}<option value="quote">引用</option></select>
      <Tool label="粗体" disabled={readOnly} pressed={mode==='rich'?richRef.current?.isActive('bold'):undefined} onClick={()=>format('bold')}><strong>B</strong></Tool>
      <Tool label="斜体" disabled={readOnly} onClick={()=>format('italic')}><em>I</em></Tool>
      <Tool label="删除线" disabled={readOnly} onClick={()=>format('strike')}><s>S</s></Tool>
      <Tool label="行内代码" disabled={readOnly} onClick={()=>format('code')}>`</Tool>
      <Tool label="链接" disabled={readOnly} onClick={()=>openInsert('link')}>链接</Tool>
      <Tool label="无序列表" disabled={readOnly} onClick={()=>format('bullet')}>• 列表</Tool>
      <Tool label="有序列表" disabled={readOnly} onClick={()=>format('ordered')}>1. 列表</Tool>
      <Tool label="任务列表" disabled={readOnly} onClick={()=>format('task')}><ListTodo size={14} aria-hidden="true"/></Tool>
      <Tool label="代码块" disabled={readOnly} onClick={()=>mode==='rich'&&richRef.current?uiOp(richRef.current,{op:'setBlockType',target:'selection',type:'codeBlock'}):insert('\n```\n代码\n```\n')}>代码</Tool>
      <Tool label="表格" disabled={readOnly} onClick={()=>mode==='rich'&&richRef.current?uiOp(richRef.current,{op:'insertTable',after:'selection'}):insert('\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n')}>表格</Tool>
      <Tool label="图片" disabled={readOnly} onClick={()=>openInsert('image')}>图片</Tool>
      <Tool label="分隔线" disabled={readOnly} onClick={()=>mode==='rich'&&richRef.current?uiOp(richRef.current,{op:'insertHorizontalRule',after:'selection'}):insert('\n\n---\n\n')}>―</Tool>
      <Tool label="公式" disabled={readOnly} onClick={()=>mode==='rich'&&richRef.current?openMathCreate(richRef.current):insert('\n$$\nx^2\n$$\n')}>公式</Tool>
      <Tool label="Mermaid 图表" disabled={readOnly} onClick={()=>insert(MERMAID_TEMPLATE)}>图表</Tool>
      <Tool label="WaveDrom 波形" disabled={readOnly} onClick={()=>insert(WAVEDROM_TEMPLATE)}>波形</Tool>
      <Tool label="查找替换" onClick={search}>查找</Tool>
      <Tool label="大纲" pressed={outline} onClick={()=>{setOutline(!outline);view({outline:!outline});}}>大纲</Tool>
      <Tool label="前置信息" pressed={properties} onClick={()=>setProperties(!properties)}>属性</Tool>
      <Tool label="拼写检查" pressed={spellcheck} onClick={()=>setSpellcheck(!spellcheck)}>拼写</Tool>
      {mode==='rich'?<><Tool label="上移块" disabled={readOnly} onClick={()=>richRef.current&&moveSelectedBlocks(richRef.current,-1)}>↑ 块</Tool><Tool label="下移块" disabled={readOnly} onClick={()=>richRef.current&&moveSelectedBlocks(richRef.current,1)}>↓ 块</Tool></>:null}
    </div></div>
    <div className="mind-markdown__viewbar"><div role="group" aria-label="编辑模式">{([['source','源码'],['split','分屏'],['preview','预览'],['rich','块编辑']] as const).map(([key,label])=><Tool key={key} label={label} pressed={mode===key} onClick={()=>chooseMode(key)}>{label}</Tool>)}</div>
      <form onSubmit={event=>{event.preventDefault();const number=Number(goto);if(Number.isInteger(number)&&number>0){chooseMode('source');requestAnimationFrame(()=>sourceRef.current?.goto(number));}}}><label>行 <input aria-label="定位行号" inputMode="numeric" value={goto} onChange={event=>setGoto(event.target.value)}/></label><button type="submit" disabled={!/^\d+$/u.test(goto)||Number(goto)<1}>前往</button></form>
      <span className="mind-markdown__zoom"><Tool label="缩小" disabled={zoom<=50} onClick={()=>zoomTo(zoom-10)}>−</Tool><button type="button" aria-label="重置缩放" onClick={()=>zoomTo(100)}>{zoom}%</button><Tool label="放大" disabled={zoom>=200} onClick={()=>zoomTo(zoom+10)}>+</Tool></span>{readOnly?<span>只读</span>:null}
    </div>
    {pending.current?<div className="mind-markdown__input-status" role="status">正在处理输入或图片，保存会等待完成…</div>:null}
    <MarkdownExport ref={exportRef} value={text} resources={draftResources} documentKey={documentKey} resolveResource={resolveResource} waitForInput={waitForInput} onExport={onExport} onPrint={onPrint} onRenderPdf={onRenderPdf}/>
    {findOpen?<div className="mind-markdown__find" role="search" aria-label="文档查找替换">
      <input ref={findInput} aria-label="查找" placeholder="查找" value={query} onChange={event=>{setQuery(event.target.value);setActive(0);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();navigate(event.shiftKey?-1:1);}if(event.key==='Escape')setFindOpen(false);}}/>
      <input aria-label="替换为" placeholder="替换为" value={replacement} disabled={readOnly} onChange={event=>setReplacement(event.target.value)}/>
      <label><input type="checkbox" checked={matchCase} onChange={event=>setMatchCase(event.target.checked)}/>区分大小写</label><label><input type="checkbox" checked={wholeWord} onChange={event=>setWholeWord(event.target.checked)}/>整词</label>
      <span role="status">{count?`${active+1} / ${count}`:'0 项'}</span>
      <button type="button" disabled={!count} onClick={()=>navigate(-1)} aria-label="上一处">↑</button><button type="button" disabled={!count} onClick={()=>navigate(1)} aria-label="下一处">↓</button>
      <button type="button" disabled={readOnly||!count} onClick={()=>target?.replaceOne(active,replacement)}>替换</button><button type="button" disabled={readOnly||!count} onClick={()=>target?.replaceAll(replacement)}>全部替换</button><button type="button" aria-label="关闭查找" onClick={()=>setFindOpen(false)}>×</button>
    </div>:null}
    {insertPanel?<form className="mind-markdown__insert" onSubmit={event=>{event.preventDefault();commitInsert();}}>
      <label>{insertPanel==='image'?'图片路径 / URL':'链接地址'}<input autoFocus aria-label="目标地址" value={destination} disabled={pendingInputs.current.chooser} onChange={event=>setDestination(event.target.value)}/></label><label>{insertPanel==='image'?'替代文字':'链接文字'}<input aria-label="显示文字" value={caption} disabled={pendingInputs.current.chooser} onChange={event=>setCaption(event.target.value)}/></label>
      <button type="submit" disabled={readOnly||pendingInputs.current.chooser||!destination.trim()}>插入</button>{insertPanel==='image'?<button type="button" disabled={readOnly} onClick={()=>fileInput.current?.click()}>选择图片</button>:null}<button type="button" onClick={()=>{cancelImageRead();setInsertPanel(null);}}>取消</button>
    </form>:null}
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
    {properties?<label className="mind-markdown__properties">YAML 前置信息<textarea aria-label="YAML 前置信息" readOnly={readOnly} spellCheck={false} value={fm?.[2]??''} onChange={event=>{
      if(readOnly)return;const eol=text.match(/\r\n|\r|\n/u)?.[0]??'\n';const yaml=event.target.value.replace(/\r\n|\r|\n/gu,eol);
      if(!yaml.trim()){if(fm)changed((text.startsWith('\uFEFF')?'\uFEFF':'')+text.slice(fm[0].length).replace(/^(?:\r\n|\r|\n)*/u,''));return;}
      changed(fm?text.slice(0,fm[1].length)+yaml+text.slice(fm[1].length+fm[2].length):`${text.startsWith('\uFEFF')?'\uFEFF':''}---${eol}${yaml}${eol}---${eol}${eol}${text.replace(/^\uFEFF/u,'')}`);
    }}/></label>:null}
    {error?<div role="alert" className="mind-markdown__error">{error}<button type="button" aria-label="关闭错误" onClick={()=>setError('')}>×</button></div>:null}
    <div className="mind-markdown__workspace">
      {outline?<MarkdownOutline value={text} width={outlineWidth} onResize={width=>{setOutlineWidth(width);view({outlineWidth:width});}} onJump={line=>{chooseMode('source');requestAnimationFrame(()=>sourceRef.current?.goto(line));}}/>:null}
      <div className="mind-markdown__panes">
        <div className="mind-markdown__source-pane" hidden={mode==='preview'||mode==='rich'}><SourceEditor documentKey={documentKey} value={text} readOnly={readOnly} zoom={zoom} spellcheck={spellcheck} onChange={changed} onReady={ready} onSelection={selectionChanged} onPending={sourcePending} onError={setError} line={line} scrollTop={initialView?.scrollTop} onScroll={top=>view({scrollTop:top})}/></div>
        {mode==='preview'||mode==='split'?<MarkdownPreview value={text} documentKey={documentKey} resources={draftResources} zoom={zoom} scrollTop={initialView?.previewScrollTop} onScroll={top=>view({previewScrollTop:top})}/>:null}
        {richUsed?<div className="mind-markdown__rich-pane" hidden={mode!=='rich'}><RichMarkdownEditor documentKey={documentKey} value={text} readOnly={readOnly} resources={draftResources} zoom={zoom} spellcheck={spellcheck} onChange={changed} onReady={richReady} onSelection={selectionChanged} onPending={richPending} onError={setError} onImage={()=>openInsert('image')}/></div>:null}
      </div>
    </div>
  </section>;
}
function Tool({label,onClick,disabled,pressed,children}:{label:string;onClick:()=>void;disabled?:boolean;pressed?:boolean;children:React.ReactNode}){return <button type="button" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={onClick}>{children}</button>;}

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { EditorState, TextSelection, type Selection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { DOMSerializer, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { desktopApi } from '../../services/desktopApi';
import { ActionContextMenu, type ContextMenuAction } from '../../ui/components/ActionContextMenu';
import { buildEditorTextContextMenuActions, buildTableContextMenuActions, buildTableToolbarGroups } from '../rich-editor/editorContextMenu';
import { shouldIgnoreContextMenuTarget } from '../../lib/context-menu';
import { createPortal } from 'react-dom';
import { buildExtensions } from '../../../packages/markdown-editor/src/genoffice/editor/extensions';
import { buildSlashItems, type SlashMenuState } from '../../../packages/markdown-editor/src/genoffice/editor/slashCommand';
import { SlashMenu, type SlashMenuHandle } from '../../../packages/markdown-editor/src/genoffice/components/SlashMenu';
import { buildSourceMap, spliceMarkdown } from '../../../packages/markdown-editor/src/genoffice/markdown/sourceSplice';
import { parseDocText } from '../../../packages/markdown-editor/src/genoffice/markdown/docText';
import { captureMarkdownSource, serializeMarkdown } from '../../../packages/markdown-editor/src/genoffice/markdown/roundtripSerializer';
import { LocalImage, safeImage } from '../../../packages/markdown-editor/src/adapters/localImage';
import { mergeRenderedSource } from '../../../packages/markdown-editor/src/source';
import { tiptapFindTarget } from '../../../packages/markdown-editor/src/genoffice/editor/findTarget';
import type { FindTarget } from '../../../packages/markdown-editor/src/adapters/ui';
import { watchEdges } from './scrollEdges';
import { closeMathEditor } from '../../../packages/markdown-editor/src/genoffice/editor/mathEdit';

export function RichMarkdownEditor({value,documentKey,readOnly,resources,zoom,spellcheck,onChange,onReady,onSelection,onPending,onError,onImage}:{
  value:string;documentKey?:string|number;readOnly:boolean;resources:Record<string,string>;zoom:number;spellcheck:boolean;
  onChange:(value:string)=>void;onReady:(editor:Editor|null,target:FindTarget|null)=>void;onSelection:()=>void;onPending:(pending:boolean)=>void;onError:(message:string)=>void;onImage:()=>void;
}) {
  const latest=useRef({value,documentKey,readOnly,resources,onChange,onReady,onSelection,onPending,onError,onImage});latest.current={value,documentKey,readOnly,resources,onChange,onReady,onSelection,onPending,onError,onImage};
  const [contextMenu,setContextMenu]=useState<{x:number;y:number;actions:ContextMenuAction[]}|null>(null);
  const context=useRef<{editor:Editor;doc:ProseMirrorNode;selection:Selection;documentKey:typeof documentKey;claimed:boolean;canceled:boolean}|null>(null);
  const cancelContext=()=>{if(context.current)context.current.canceled=true;context.current=null;setContextMenu(null);};
  const scroller=useRef<HTMLDivElement>(null);const frame=useRef<HTMLDivElement>(null);
  const inputs=useRef({composition:false,image:false});
  const pending=(kind:'composition'|'image',value:boolean)=>{inputs.current[kind]=value;latest.current.onPending(inputs.current.composition||inputs.current.image);};
  const source=useRef(value);const key=useRef(documentKey);const loaded=useRef(false);
  const baseline=useRef<{envelope:ReturnType<typeof parseDocText>;map:ReturnType<typeof buildSourceMap>;snapshot:ReturnType<typeof captureMarkdownSource>}|null>(null);
  const [slash,setSlash]=useState<SlashMenuState|null>(null);const menu=useRef<SlashMenuHandle>(null);
  const extensions=useMemo(()=>buildExtensions({slashController:{onOpen:setSlash,onUpdate:setSlash,onClose:()=>setSlash(null),onKeyDown:event=>menu.current?.handleKey(event)??false},slashItems:()=>buildSlashItems({insertImage:()=>latest.current.onImage()})}).filter(extension=>extension.name!=='blockDragHandle').map(extension=>extension.name==='image'?LocalImage.configure({resolve:src=>latest.current.resources[src]??(safeImage(src)?src:''),onError:message=>latest.current.onError(message),onPending:value=>pending('image',value)}):extension),[]);
  const editor=useEditor({immediatelyRender:false,extensions,content:'',editable:!readOnly,
    editorProps:{attributes:{role:'textbox','aria-label':'Markdown 块编辑','aria-multiline':'true',spellcheck:String(spellcheck)},
      handleDOMEvents:{compositionstart:()=>{pending('composition',true);return false;},compositionend:()=>{setTimeout(()=>pending('composition',false),0);return false;}}},
    onUpdate:({editor})=>{
      if(!loaded.current||!baseline.current)return;
      const {envelope,map,snapshot}=baseline.current;
      const serialized=serializeMarkdown(envelope,editor.state.doc,()=>map?spliceMarkdown(editor,editor.state.doc,map):editor.getMarkdown(),snapshot);
      const next=mergeRenderedSource(snapshot.source,serialized);
      if(next!==source.current){source.current=next;latest.current.onChange(next);}
      latest.current.onSelection();
    },
    onSelectionUpdate:()=>latest.current.onSelection(),
    onTransaction:({editor})=>{
      const session=context.current;
      if(session&&(session.doc!==editor.state.doc||!session.selection.eq(editor.state.selection)))cancelContext();
      latest.current.onSelection();
    },
  },[]);
  useEffect(()=>{
    if(!editor)return;
    const load=(raw:string)=>{
      cancelContext();
      closeMathEditor(editor);pending('composition',false);loaded.current=false;const envelope=parseDocText(raw);
      editor.commands.setContent(envelope.body,{contentType:'markdown',emitUpdate:false});
      baseline.current={envelope,map:buildSourceMap(editor,editor.state.doc,envelope.body),snapshot:captureMarkdownSource(raw,envelope,editor.state.doc)};
      editor.view.updateState(EditorState.create({schema:editor.schema,doc:editor.state.doc,plugins:editor.state.plugins}));
      source.current=raw;loaded.current=true;
    };
    load(latest.current.value);
    // Only the initial editor load is allowed to reset its model.
    latest.current.onReady(editor,tiptapFindTarget(editor));
    return()=>{
      cancelContext();
      // Tiptap delays destruction; cancel completed-but-queued image delivery
      // through the same guard used by external setContent before that window.
      if(!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta('preventUpdate',true));
      latest.current.onReady(null,null);
    };
  },[editor]);
  useEffect(()=>{
    if(!editor||(value===source.current&&key.current===documentKey))return;
    cancelContext();key.current=documentKey;
    closeMathEditor(editor);pending('composition',false);loaded.current=false;const envelope=parseDocText(value);
    editor.commands.setContent(envelope.body,{contentType:'markdown',emitUpdate:false});
    baseline.current={envelope,map:buildSourceMap(editor,editor.state.doc,envelope.body),snapshot:captureMarkdownSource(value,envelope,editor.state.doc)};
    editor.view.updateState(EditorState.create({schema:editor.schema,doc:editor.state.doc,plugins:editor.state.plugins}));
    source.current=value;loaded.current=true;
  },[editor,value,documentKey]);
  useEffect(()=>{cancelContext();if(editor){editor.setEditable(!readOnly);editor.view.dom.setAttribute('aria-readonly',String(readOnly));if(readOnly){editor.view.dispatch(editor.state.tr.setMeta('preventUpdate',true));setSlash(null);closeMathEditor(editor);}}},[editor,readOnly]);
  useEffect(()=>{editor?.view.dom.setAttribute('spellcheck',String(spellcheck));},[editor,spellcheck]);
  useEffect(()=>{
    if(!editor)return;
    editor.view.dom.querySelectorAll<HTMLImageElement>('img[data-markdown-src]').forEach(image=>{
      const src=image.dataset.markdownSrc??'';const resolved=resources[src]??(safeImage(src)?src:'');
      if(resolved)image.src=resolved;else image.removeAttribute('src');
    });
  },[editor,resources]);
  useEffect(()=>{if(scroller.current&&frame.current)return watchEdges(scroller.current,frame.current);},[editor]);
  const openContextMenu=(event:React.MouseEvent<HTMLDivElement>)=>{
    if(!editor||(shouldIgnoreContextMenuTarget(event.target)&&!editor.view.dom.contains(event.target as Node)))return;
    if(event.target instanceof Element&&event.target.closest('input,textarea,select,button'))return;
    event.preventDefault();cancelContext();setSlash(null);
    const target=event.target instanceof Element?event.target:null;
    const view=editor.view;
    const hit=view.posAtCoords({left:event.clientX,top:event.clientY});
    let anchor=hit?.pos;
    if(anchor===undefined){
      if(target&&view.dom.contains(target))anchor=view.posAtDOM(target,0);
      else anchor=editor.state.doc.content.size;
    }
    anchor=Math.max(0,Math.min(anchor,editor.state.doc.content.size));
    // Native DOM selection may have changed before ProseMirror receives selectionchange.
    const domSelection=window.getSelection();
    if(domSelection?.rangeCount&&!domSelection.isCollapsed&&view.dom.contains(domSelection.anchorNode)&&view.dom.contains(domSelection.focusNode)){
      const from=view.posAtDOM(domSelection.anchorNode!,domSelection.anchorOffset);
      const to=view.posAtDOM(domSelection.focusNode!,domSelection.focusOffset);
      if(anchor>=Math.min(from,to)&&anchor<=Math.max(from,to))view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,from,to)).setMeta('addToHistory',false));
    }
    const selection=editor.state.selection;
    const selectedText=!selection.empty&&selection instanceof TextSelection&&anchor>=selection.from&&anchor<=selection.to;
    const selectedCells=selection instanceof CellSelection&&anchor>=selection.from&&anchor<=selection.to;
    if(!selectedText&&!selectedCells)view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(anchor))).setMeta('addToHistory',false));
    const session={editor,doc:editor.state.doc,selection:editor.state.selection,documentKey:latest.current.documentKey,claimed:false,canceled:false};
    context.current=session;
    const current=(mutating=false)=>!session.canceled&&!editor.isDestroyed&&context.current===session&&session.documentKey===latest.current.documentKey&&session.doc===editor.state.doc&&session.selection.eq(editor.state.selection)&&(!mutating||(!latest.current.readOnly&&editor.isEditable));
    const invoke=(operation:()=>unknown)=>()=>{
      if(!current())return;
      session.claimed=true;
      void Promise.resolve().then(()=>current()?operation():undefined).catch(reason=>{
        if(current())latest.current.onError(`剪贴板操作失败：${reason instanceof Error?reason.message:String(reason)}`);
      });
    };
    const copy=async(cut:boolean)=>{
      if(!current(cut)||session.selection.empty)return;
      const content=session.selection.content();
      const container=document.createElement('div');container.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(content.content));
      const text=content.content.textBetween(0,content.content.size,'\n\n');
      if(navigator.clipboard.write&&typeof ClipboardItem!=='undefined')await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'}),'text/html':new Blob([container.innerHTML],{type:'text/html'})})]);
      else await navigator.clipboard.writeText(text);
      if(cut&&current(true))editor.chain().focus().deleteSelection().run();
    };
    const paste=async()=>{
      if(!current(true))return;
      let text='';
      if('__TAURI_INTERNALS__' in window)text=(await desktopApi.readClipboardText())??'';
      else if(navigator.clipboard.read){
        const items=await navigator.clipboard.read();
        if(!current(true))return;
        const image=items.find(item=>item.types.some(type=>/^image\/(png|jpeg|gif|webp|bmp)$/u.test(type)));
        if(image){
          const type=image.types.find(type=>/^image\/(png|jpeg|gif|webp|bmp)$/u.test(type))!;
          const blob=await image.getType(type);
          if(!current(true))return;
          // Keep image validation, cancellation and data URL serialization in LocalImage.
          const files=[new File([blob],'clipboard-image',{type})];
          const pasteEvent={clipboardData:{files}} as unknown as ClipboardEvent;
          view.someProp('handlePaste',handler=>handler(view,pasteEvent,Slice.empty));
          return;
        }
        const plain=items.find(item=>item.types.includes('text/plain'));
        if(plain)text=await (await plain.getType('text/plain')).text();
      }else text=await navigator.clipboard.readText();
      if(text&&current(true)){
        const doc=editor.schema.nodeFromJSON(editor.markdown!.parse(text));
        editor.chain().focus().command(({tr})=>{tr.replaceSelection(Slice.maxOpen(doc.content));return true;}).run();
      }
    };
    let actions:ContextMenuAction[];
    if(!latest.current.readOnly&&!selectedText&&target?.closest('td,th')&&editor.isActive('table')){
      actions=buildTableContextMenuActions(buildTableToolbarGroups(editor,false));
      actions=actions.map(action=>('onSelect' in action?{...action,onSelect:invoke(action.onSelect)}:action));
    }else{
      actions=buildEditorTextContextMenuActions({editor,readOnly:latest.current.readOnly,hasTextSelection:selectedText,
        onCopy:invoke(()=>copy(false)),onCut:invoke(()=>copy(true)),onPaste:invoke(paste),
        insertTable:()=>{if(current(true))editor.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run();},
        onInsertImage:()=>{if(current(true))latest.current.onImage();},canInsertImage:true,
      });
      // Also claim synchronous schema actions before ActionContextMenu's deferred dismissal.
      const claim=(items:ContextMenuAction[]):ContextMenuAction[]=>items.map(action=>{
        if('actions' in action){
          if(action.type==='submenu')return {...action,actions:claim(action.actions)};
          if(action.type==='scroll-actions')return {...action,actions:action.actions.map(item=>({...item,onSelect:invoke(item.onSelect)}))};
          return {...action,actions:action.actions.map(item=>({...item,onSelect:invoke(item.onSelect)}))};
        }
        return 'onSelect' in action?{...action,onSelect:invoke(action.onSelect)}:action;
      });
      actions=claim(actions);
    }
    setContextMenu({x:event.clientX,y:event.clientY,actions});
  };
  return <div ref={frame} onContextMenu={openContextMenu} className="mind-markdown__rich-frame mind-markdown__edges">
    <div className="mind-markdown__rich-scroll" ref={scroller}>
      <div className="mind-markdown__rich-page" style={{'--md-zoom':zoom/100} as CSSProperties}><EditorContent editor={editor}/></div>
    </div>
    {contextMenu?createPortal(<ActionContextMenu {...contextMenu} ariaLabel="Markdown 右键菜单" autoFocus={false} onClose={()=>{
      setContextMenu(null);
      const session=context.current;
      // ActionContextMenu closes synchronously before invoking a selected action.
      queueMicrotask(()=>{if(session&&!session.claimed&&context.current===session)cancelContext();});
    }}/>,document.body):null}
    {slash&&!readOnly?createPortal(<SlashMenu ref={menu} state={slash} onDismiss={()=>setSlash(null)}/>,document.body):null}
  </div>;
}

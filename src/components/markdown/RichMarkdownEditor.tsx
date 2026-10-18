import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { createPortal } from 'react-dom';
import { buildExtensions } from '../../../packages/markdown-editor/src/genoffice/editor/extensions';
import { buildSlashItems, type SlashMenuState } from '../../../packages/markdown-editor/src/genoffice/editor/slashCommand';
import { SlashMenu, type SlashMenuHandle } from '../../../packages/markdown-editor/src/genoffice/components/SlashMenu';
import { TableMenu } from '../../../packages/markdown-editor/src/genoffice/components/TableMenu';
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
  const latest=useRef({value,resources,onChange,onReady,onSelection,onPending,onError,onImage});latest.current={value,resources,onChange,onReady,onSelection,onPending,onError,onImage};
  const scroller=useRef<HTMLDivElement>(null);const frame=useRef<HTMLDivElement>(null);
  const inputs=useRef({composition:false,image:false});
  const pending=(kind:'composition'|'image',value:boolean)=>{inputs.current[kind]=value;latest.current.onPending(inputs.current.composition||inputs.current.image);};
  const source=useRef(value);const key=useRef(documentKey);const loaded=useRef(false);
  const baseline=useRef<{envelope:ReturnType<typeof parseDocText>;map:ReturnType<typeof buildSourceMap>;snapshot:ReturnType<typeof captureMarkdownSource>}|null>(null);
  const [slash,setSlash]=useState<SlashMenuState|null>(null);const menu=useRef<SlashMenuHandle>(null);
  const extensions=useMemo(()=>buildExtensions({slashController:{onOpen:setSlash,onUpdate:setSlash,onClose:()=>setSlash(null),onKeyDown:event=>menu.current?.handleKey(event)??false},slashItems:()=>buildSlashItems({insertImage:()=>latest.current.onImage()})}).map(extension=>extension.name==='image'?LocalImage.configure({resolve:src=>latest.current.resources[src]??(safeImage(src)?src:''),onError:message=>latest.current.onError(message),onPending:value=>pending('image',value)}):extension),[]);
  const editor=useEditor({extensions,content:'',editable:!readOnly,
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
    onTransaction:()=>latest.current.onSelection(),
  },[]);
  useEffect(()=>{
    if(!editor)return;
    const load=(raw:string)=>{
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
      // Tiptap delays destruction; cancel completed-but-queued image delivery
      // through the same guard used by external setContent before that window.
      if(!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta('preventUpdate',true));
      latest.current.onReady(null,null);
    };
  },[editor]);
  useEffect(()=>{
    if(!editor||(value===source.current&&key.current===documentKey))return;
    key.current=documentKey;
    closeMathEditor(editor);pending('composition',false);loaded.current=false;const envelope=parseDocText(value);
    editor.commands.setContent(envelope.body,{contentType:'markdown',emitUpdate:false});
    baseline.current={envelope,map:buildSourceMap(editor,editor.state.doc,envelope.body),snapshot:captureMarkdownSource(value,envelope,editor.state.doc)};
    editor.view.updateState(EditorState.create({schema:editor.schema,doc:editor.state.doc,plugins:editor.state.plugins}));
    source.current=value;loaded.current=true;
  },[editor,value,documentKey]);
  useEffect(()=>{if(editor){editor.setEditable(!readOnly);editor.view.dom.setAttribute('aria-readonly',String(readOnly));if(readOnly){editor.view.dispatch(editor.state.tr.setMeta('preventUpdate',true));setSlash(null);closeMathEditor(editor);}}},[editor,readOnly]);
  useEffect(()=>{editor?.view.dom.setAttribute('spellcheck',String(spellcheck));},[editor,spellcheck]);
  useEffect(()=>{
    if(!editor)return;
    editor.view.dom.querySelectorAll<HTMLImageElement>('img[data-markdown-src]').forEach(image=>{
      const src=image.dataset.markdownSrc??'';const resolved=resources[src]??(safeImage(src)?src:'');
      if(resolved)image.src=resolved;else image.removeAttribute('src');
    });
  },[editor,resources]);
  useEffect(()=>{if(scroller.current&&frame.current)return watchEdges(scroller.current,frame.current);},[editor]);
  return <div ref={frame} className="mind-markdown__rich-frame mind-markdown__edges">
    <div className="mind-markdown__rich-scroll" ref={scroller}>
      <div className="mind-markdown__rich-page" style={{fontSize:`${16*zoom/100}px`}}><EditorContent editor={editor}/></div>
    </div>
    {!readOnly&&editor?<TableMenu editor={editor} scrollRef={scroller} zoom={zoom}/>:null}
    {slash&&!readOnly?createPortal(<SlashMenu ref={menu} state={slash} onDismiss={()=>setSlash(null)}/>,document.body):null}
  </div>;
}

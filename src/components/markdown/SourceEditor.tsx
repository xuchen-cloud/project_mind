import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { buildFindTarget, findHighlight } from '../../../packages/markdown-editor/src/genoffice/source/plain-find';
import type { FindTarget } from '../../../packages/markdown-editor/src/adapters/ui';
import { applySourceEdits, normalizedSource } from '../../../packages/markdown-editor/src/source';
import { watchEdges } from './scrollEdges';
import { fenceCodeSpan } from '../../../packages/markdown-editor/src/genoffice/editor/markdownEscape';
import { firstImage, imageMarkdown, MARKDOWN_IMAGE_LIMIT } from '../../../packages/markdown-editor/src/adapters/imageInput';
import { getErrorMessage } from '../../lib/errors';

export interface SourceController {
  view:EditorView; find:FindTarget;
  format(kind:string):void;
  insert(text:string):void;
  goto(line:number):void;
  undo():void;redo():void;canUndo():boolean;canRedo():boolean;
}
export function SourceEditor({value,documentKey,readOnly,zoom,spellcheck,onChange,onReady,onSelection,onPending,line,scrollTop,onScroll,onError}:{
  value:string;documentKey?:string|number;readOnly:boolean;zoom:number;spellcheck:boolean;onChange:(source:string)=>void;
  onReady:(controller:SourceController|null)=>void;onSelection:()=>void;onPending:(pending:boolean)=>void;
  line?:number;scrollTop?:number;onScroll:(top:number)=>void;
  onError:(message:string)=>void;
}) {
  const host=useRef<HTMLDivElement>(null);const viewRef=useRef<EditorView|null>(null);
  const latest=useRef({value,onChange,onReady,onSelection,onPending,onScroll,onError});latest.current={value,onChange,onReady,onSelection,onPending,onScroll,onError};
  const images=useRef(new Set<{reader:FileReader;from:number;to:number;cancel:()=>void}>());
  const inputs=useRef({composition:false,image:false});
  const pending=(kind:'composition'|'image',value:boolean)=>{inputs.current[kind]=value;latest.current.onPending(inputs.current.composition||inputs.current.image);};
  const cancelImages=()=>{for(const job of images.current)job.cancel();};
  const raw=useRef(value);const key=useRef(documentKey);const compartments=useRef({edit:new Compartment(),style:new Compartment(),spell:new Compartment(),history:new Compartment()});
  useEffect(()=>{
    if(!host.current)return;
    raw.current=latest.current.value;
    const listeners=new Set<()=>void>();
    const edit=compartments.current.edit;
    const view=new EditorView({parent:host.current,state:EditorState.create({doc:normalizedSource(raw.current),extensions:[
      lineNumbers(),drawSelection(),dropCursor(),rectangularSelection(),highlightActiveLine(),highlightActiveLineGutter(),compartments.current.history.of(history()),markdown(),bracketMatching(),closeBrackets(),syntaxHighlighting(defaultHighlightStyle),findHighlight,EditorView.lineWrapping,
      keymap.of([...closeBracketsKeymap,{key:'Mod-b',run:()=>{formatSource(view,'bold');return true;}},{key:'Mod-i',run:()=>{formatSource(view,'italic');return true;}},...defaultKeymap,...historyKeymap,indentWithTab]),
      edit.of([EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly)]),
      compartments.current.style.of(theme(zoom)),
      compartments.current.spell.of(EditorView.contentAttributes.of({spellcheck:String(spellcheck)})),
      EditorView.contentAttributes.of({'aria-label':'Markdown 源码',role:'textbox','aria-multiline':'true'}),
      EditorView.domEventHandlers({compositionstart(){pending('composition',true);},compositionend(){setTimeout(()=>pending('composition',false),0);},paste(event,view){return insertImage(event.clipboardData?.files,view,view.state.selection.main.from,view.state.selection.main.to);},drop(event,view){const pos=view.posAtCoords({x:event.clientX,y:event.clientY})??view.state.selection.main.from;return insertImage(event.dataTransfer?.files,view,pos,pos);}}),
      EditorView.updateListener.of(update=>{
        if(update.docChanged)for(const job of images.current){job.from=update.changes.mapPos(job.from);job.to=update.changes.mapPos(job.to);}
        if(update.docChanged&&!update.transactions.some(tr=>tr.annotation(externalLoad))){
          const edits:{from:number;to:number;insert:string}[]=[];
          update.changes.iterChanges((from,to,_fromB,_toB,insert)=>edits.push({from,to,insert:insert.toString()}));
          raw.current=applySourceEdits(raw.current,edits); latest.current.onChange(raw.current);
          listeners.forEach(listener=>listener());
        }
        if(update.docChanged||update.selectionSet)latest.current.onSelection();
      }),
    ]})});
    viewRef.current=view;
    const find=buildFindTarget(view,listener=>{listeners.add(listener);return()=>listeners.delete(listener);});
    const controller:SourceController={view,find,format:kind=>formatSource(view,kind),insert:text=>insertSource(view,text),goto:line=>gotoLine(view,line),undo:()=>{if(!view.state.readOnly)undo(view);},redo:()=>{if(!view.state.readOnly)redo(view);},canUndo:()=>undoDepth(view.state)>0,canRedo:()=>redoDepth(view.state)>0};
    latest.current.onReady(controller);
    const stop=watchEdges(view.scrollDOM,host.current);
    const scroll=()=>latest.current.onScroll(view.scrollDOM.scrollTop);
    view.scrollDOM.addEventListener('scroll',scroll,{passive:true});
    if(scrollTop!==undefined)view.scrollDOM.scrollTop=scrollTop;
    if(line)gotoLine(view,line);
    return()=>{cancelImages();stop();view.scrollDOM.removeEventListener('scroll',scroll);view.destroy();viewRef.current=null;latest.current.onReady(null);};
  },[]);
  function insertImage(files:FileList|null|undefined,view:EditorView,from:number,to:number){
    const file=firstImage(files);if(!file||view.state.readOnly)return false;
    if(file.size>MARKDOWN_IMAGE_LIMIT){latest.current.onError('图片超过 4 MiB，请使用已纳管资源的路径。');return true;}
    if(from===0&&raw.current.startsWith('\uFEFF')){from=1;to=Math.max(1,to);}
    let active=true;const reader=new FileReader();
    const finish=()=>{if(!active)return;active=false;images.current.delete(job);pending('image',images.current.size>0);};
    const job={reader,from,to,cancel:()=>{reader.onload=null;reader.onerror=null;reader.onabort=null;reader.abort();finish();}};
    images.current.add(job);pending('image',true);
    reader.onload=()=>{
      try{
        if(active&&!view.state.readOnly){const markdown=imageMarkdown(String(reader.result),file.name);view.dispatch({changes:{from:job.from,to:job.to,insert:markdown},selection:{anchor:job.from+markdown.length},userEvent:'input.paste'});}
      }catch(reason){if(active)latest.current.onError(`图片未插入：${getErrorMessage(reason)}`);}finally{finish();}
    };
    reader.onerror=()=>{if(active)latest.current.onError('读取图片失败。');finish();};reader.onabort=finish;reader.readAsDataURL(file);return true;
  }
  useEffect(()=>{
    const view=viewRef.current;if(!view||(value===raw.current&&key.current===documentKey))return;
    cancelImages();pending('composition',false);
    key.current=documentKey;
    raw.current=value;
    // A host replacement is a new baseline: history must not restore another file/version.
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:normalizedSource(value)},effects:compartments.current.history.reconfigure([]),annotations:[externalLoad.of(true),Transaction.addToHistory.of(false)]});
    view.dispatch({effects:compartments.current.history.reconfigure(history())});
  },[value,documentKey]);
  useEffect(()=>{if(readOnly)cancelImages();viewRef.current?.dispatch({effects:compartments.current.edit.reconfigure([EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly)])});},[readOnly]);
  useEffect(()=>{viewRef.current?.dispatch({effects:compartments.current.style.reconfigure(theme(zoom))});},[zoom]);
  useEffect(()=>{viewRef.current?.dispatch({effects:compartments.current.spell.reconfigure(EditorView.contentAttributes.of({spellcheck:String(spellcheck)}))});},[spellcheck]);
  useEffect(()=>{if(line&&viewRef.current)gotoLine(viewRef.current,line);},[line]);
  return <div className="mind-markdown__source mind-markdown__edges" ref={host}/>;
}
import { Annotation } from '@codemirror/state';
const externalLoad=Annotation.define<boolean>();
function theme(zoom:number):Extension{return EditorView.theme({
  '&':{height:'100%',color:'var(--color-text-primary)',backgroundColor:'var(--md-paper, var(--color-bg))'},
  '.cm-scroller':{fontFamily:'var(--font-mono, ui-monospace, monospace)',fontSize:`${14*zoom/100}px`,lineHeight:'1.65',overflow:'auto'},
  '.cm-content':{padding:'20px 24px',minHeight:'100%',backgroundColor:'var(--md-paper, var(--color-bg))'},'.cm-gutters':{backgroundColor:'var(--md-paper, var(--color-bg))',color:'var(--color-text-tertiary)',borderRight:'1px solid var(--color-border)'},
  '.cm-activeLine':{backgroundColor:'transparent'},
  '.cm-activeLineGutter':{backgroundColor:'transparent',color:'var(--color-text-primary)'},
  '.cm-cursor':{borderLeftColor:'var(--color-text-primary)'},
  '&.cm-focused .cm-selectionBackground,.cm-selectionBackground':{backgroundColor:'var(--color-accent-ring)'},
  '&.cm-focused':{outline:'none'},
});}
function gotoLine(view:EditorView,line:number){const target=view.state.doc.line(Math.max(1,Math.min(view.state.doc.lines,Math.trunc(line))));view.dispatch({selection:{anchor:target.from},effects:EditorView.scrollIntoView(target.from,{y:'center'})});view.focus();}
function insertSource(view:EditorView,text:string){if(view.state.readOnly)return;let {from,to}=view.state.selection.main;if(from===0&&view.state.doc.sliceString(0,1)==='\uFEFF'){from=1;to=Math.max(to,1);}view.dispatch({changes:{from,to,insert:text},selection:{anchor:from+text.length},userEvent:'input.toolbar'});view.focus();}
function formatSource(view:EditorView,kind:string){
  if(view.state.readOnly)return;const {from,to}=view.state.selection.main;
  const selected=view.state.sliceDoc(from,to);
  const code=fenceCodeSpan(selected),boundary=(code.length-selected.length)/2;
  const codePair:[string,string]=selected.length>=3&&selected.startsWith('`')&&selected.endsWith('`')&&!selected.slice(1,-1).includes('`')?['`','`']:[code.slice(0,boundary),code.slice(-boundary)];
  const pairs:Record<string,[string,string]>={bold:['**','**'],italic:['_','_'],strike:['~~','~~'],code:codePair,link:['[','](https://)'],image:['![','](image.png)'],math:['$','$']};
  if(pairs[kind]){const [left,right]=pairs[kind];const wrapped=selected.startsWith(left)&&selected.endsWith(right)&&selected.length>=left.length+right.length;
    const insert=wrapped?selected.slice(left.length,-right.length):left+selected+right;
    const changes=wrapped?[{from,to:from+left.length,insert:''},{from:to-right.length,to,insert:''}]:from===to?[{from,insert:left+right}]:[{from,insert:left},{from:to,insert:right}];
    view.dispatch({changes,selection:{anchor:from+(wrapped?0:left.length),head:from+insert.length-(wrapped?0:right.length)},userEvent:'input.toolbar'});
  } else {
    const first=view.state.doc.lineAt(from),last=view.state.doc.lineAt(to>from?to-1:to);
    const prefix=kind==='quote'?'> ':kind==='bullet'?'- ':kind==='ordered'?'1. ':kind==='task'?'- [ ] ':kind.startsWith('h')?'#'.repeat(Number(kind.slice(1)))+' ':'';
    const changes:{from:number;to:number;insert:string}[]=[];
    for(let number=first.number;number<=last.number;number++){
      const line=view.state.doc.line(number);const match=/^(?:#{1,6} |>(?: )?|[-+*] (?:\[[ x]\] )?|\d+\. )/u.exec(line.text);
      changes.push({from:line.from,to:line.from+(match?.[0].length??0),insert:kind==='ordered'?`${number-first.number+1}. `:prefix});
    }
    view.dispatch({changes,userEvent:'input.toolbar'});
  }
  view.focus();
}

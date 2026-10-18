import {EditorLoading} from "../document/EditorLoading";
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import '../../../packages/office-docx/dist/editor-shell.css';
import type {RegisterEditorOutput} from '../../lib/editor-output';
import type {DocxModel,Edit} from '../../../packages/office-docx/types';
import type {EditorController,EditorOptions,FaceVerticalMetrics,EditorRemoteImage} from '../../../packages/office-docx/editor-types';
export type {FaceVerticalMetrics} from '../../../packages/office-docx/editor-types';
export type {DocxModel,DocxModel as Model,Edit,Edit as DocxEdit} from '../../../packages/office-docx/types';
export interface DocxEditorProps{
  model:DocxModel;edits:Edit[];onChange(edits:Edit[]):void;readOnly?:boolean;presentationMode?:'preview'|'edit';
  registerOutput?:RegisterEditorOutput;
  registerBeforeSave?:(callback:()=>Promise<void>)=>()=>void;
  onPendingChange?:(pending:boolean)=>void;
  onSaveRequest?:()=>void|Promise<void>;
  onExport?:(file:{name:string;mime:string;bytes:Uint8Array})=>Promise<boolean>;
  onPrint?:(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}})=>Promise<void>;
  onRenderPdf?:(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}})=>Promise<Uint8Array>;
  onConvertAltChunkHtml?:(html:string)=>Promise<Uint8Array|null>;
  onGetSystemFonts?:()=>Promise<string[]>;
  onFontMetrics?:(family:string)=>Promise<FaceVerticalMetrics|null>;
  onFetchImage?:(url:string)=>Promise<EditorRemoteImage>;
}
/** The full renderer produces drafts; File owns identity, persistence and CAS. */
export function DocxEditor(props:DocxEditorProps){
  const latest=useRef(props);latest.current=props;
  const host=useRef<HTMLDivElement>(null),controller=useRef<EditorController|null>(null);
  const mounting=useRef<Promise<EditorController|null>|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState<'runtime'|'render'|null>('runtime');
  const loadingReady=useRef<Promise<void>|null>(null);
  function observeReady(mounted:EditorController){
    const ready=mounted.ready;
    if(loadingReady.current===ready)return;
    loadingReady.current=ready;setLoading('render');
    const current=()=>controller.current===mounted&&mounted.ready===ready;
    void ready.then(()=>{if(current())setLoading(null);},reason=>{if(current())setError(reason instanceof Error?reason.message:String(reason));});
  }
  function options():EditorOptions{return{...latest.current,onError:setError,onSaveRequest:latest.current.onSaveRequest?()=>latest.current.onSaveRequest?.():undefined,onChange:edits=>{setError(null);latest.current.onChange(edits);}};}
  useEffect(()=>{
    let active=true;
    mounting.current=import('../../../packages/office-docx/dist/editor.mjs').then(runtime=>{
      if(!active||!host.current)return null;
      const mounted=controller.current=runtime.mountFullEditor(host.current,options());
      observeReady(mounted);return mounted;
    });
    void mounting.current.catch(reason=>{if(active)setError(reason instanceof Error?reason.message:String(reason));});
    return()=>{active=false;controller.current?.destroy();controller.current=null;};
  },[]);
  useEffect(()=>props.registerBeforeSave?.(async()=>{
    const mounted=await mounting.current;if(!mounted)throw Error('Word 编辑器尚未加载');await mounted.beforeSave?.();
  }),[props.registerBeforeSave]);
  useEffect(()=>props.registerOutput?.(async command=>{
    if (!['pdf','images','html','print','preview'].includes(command)) throw Error('Word 不支持此输出格式');
    const mounted=await mounting.current;
    if(!mounted)throw Error('Word 编辑器尚未加载');
    await mounted.output(command as 'pdf'|'images'|'html'|'print'|'preview');
  }),[props.registerOutput]);
  useLayoutEffect(()=>{try{controller.current?.update(options());if(controller.current)observeReady(controller.current);}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}},[props.model,props.edits,props.readOnly,props.presentationMode,props.onPendingChange,props.onSaveRequest,props.onExport,props.onPrint,props.onRenderPdf,props.onGetSystemFonts,props.onFontMetrics,props.onConvertAltChunkHtml,props.onFetchImage]);
  return <section className="office-docx editor-loading-boundary" aria-label="Word 文档编辑器">
    {error&&<p className="office-docx__error" role="alert">{error}</p>}
    <div ref={host} className="office-docx__embed" />
    {loading&&!error?<EditorLoading format="docx" stage={loading} overlay/>:null}
  </section>;
}

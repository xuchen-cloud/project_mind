import { rendererHtml } from './dist/renderer-resource.mjs';
import type {EditorController,EditorOptions} from './editor-types';
import type {Edit} from './types';
import {applyEdits} from './model';
/** Complete fixed upstream renderer, isolated from the surrounding app's CSS and Tiptap. */
export function mountFullEditor(element:HTMLElement,initial:EditorOptions):EditorController{
  type Mount={frame:HTMLIFrameElement;active:boolean;ready:Promise<void>;resolveReady:()=>void;rejectReady:(error:Error)=>void;cancelled:Promise<never>;cancel:(error:Error)=>void};
  let options=initial,disposed=false,current:Mount,lastEmitted=initial.edits;
  const api=(mounted=current)=> (mounted.frame.contentWindow as any)?.__projectMindDocxHost;
  const isCurrent=(mounted:Mount)=>!disposed&&mounted.active&&current===mounted;
  const inactiveError=()=>Error(disposed?'Word 编辑器已关闭':'Word 文档已替换，旧编辑器已失效');
  function assertCurrent(mounted:Mount){if(!isCurrent(mounted))throw inactiveError();}
  async function runCurrent<T>(mounted:Mount,operation:()=>T|Promise<T>):Promise<T>{
    assertCurrent(mounted);
    const value=await Promise.race([operation(),mounted.cancelled]);
    assertCurrent(mounted);return value;
  }
  function appearance(){
    const root=element.ownerDocument.documentElement,view=element.ownerDocument.defaultView!;
    const css=view.getComputedStyle(root),font=view.getComputedStyle(element).fontFamily;
    const theme=root.dataset.theme==='dark'||root.classList.contains('dark')?'dark':root.dataset.theme==='light'?'light':css.colorScheme==='dark'?'dark':'light';
    const tokens:Record<string,string>={};
    for(const name of ['--font-ui','--color-bg','--color-bg-subtle','--color-bg-muted','--color-canvas','--color-bg-hover','--color-bg-active','--color-border','--color-border-strong','--color-text-primary','--color-text-secondary','--color-text-tertiary','--color-accent']){const value=css.getPropertyValue(name).trim();if(value)tokens[name]=value;}
    return{theme,font,tokens};
  }
  function settings(mounted:Mount){
    const snapshot=options.edits.length===1&&options.edits[0].type==='snapshot'?options.edits[0]:null;
    return{sourceBase64:snapshot?.base64??options.model.sourceBase64,baselineHash:options.model.baselineHash,
      initialDocument:!snapshot&&options.edits.length?applyEdits(options.model.document,options.edits):undefined,
      readOnly:!!options.readOnly||options.model.readOnly,hasDraft:options.edits.length>0,appearance:appearance(),
      onChange:(edits:Edit[])=>{if(isCurrent(mounted)){lastEmitted=edits;options.onChange(edits);}},
      onPending:(pending:boolean)=>{if(isCurrent(mounted))options.onPendingChange?.(pending);},
      onError:(message:string)=>{if(isCurrent(mounted))options.onError?.(message);},onReady:()=>{if(isCurrent(mounted))mounted.resolveReady();},
      onSaveRequest:()=>runCurrent(mounted,()=>{if(!options.onSaveRequest)throw Error('当前 File 宿主尚未连接 Word 保存回执。');return options.onSaveRequest();}),
      onExport:options.onExport?(file:{name:string;mime:string;bytes:Uint8Array})=>runCurrent(mounted,()=>options.onExport!({...file,bytes:new Uint8Array(file.bytes)})):undefined,
      onPrint:options.onPrint?(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}})=>runCurrent(mounted,()=>options.onPrint!(document)):undefined,
      onRenderPdf:options.onRenderPdf?async(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}})=>new Uint8Array(await runCurrent(mounted,()=>options.onRenderPdf!(document))):undefined,
      onConvertAltChunkHtml:options.onConvertAltChunkHtml?async(html:string)=>{const bytes=await runCurrent(mounted,()=>options.onConvertAltChunkHtml!(html));return bytes?new Uint8Array(bytes):null;}:undefined,
      onGetSystemFonts:options.onGetSystemFonts?()=>runCurrent(mounted,()=>options.onGetSystemFonts!()):undefined,
      onFontMetrics:options.onFontMetrics?(family:string)=>runCurrent(mounted,()=>options.onFontMetrics!(family)):undefined,
      onFetchImage:options.onFetchImage?async(url:string)=>{
        const editable=()=>{if(options.readOnly||options.model.readOnly)throw Error('当前 Word 文档只读，不能粘贴图片。');};
        const result=await runCurrent(mounted,()=>{editable();return options.onFetchImage!(url);});
        editable();return result;
      }:undefined,
    };
  }
  function mount(){
    if(!options.model.sourceBase64)throw Error('完整 Word 编辑器需要重新读取原件字节。');
    const frame=element.ownerDocument.createElement('iframe');frame.title='Word 文档编辑器';
    let resolveReady!:()=>void,rejectReady!:(error:Error)=>void,cancel!:(error:Error)=>void;
    const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const cancelled=new Promise<never>((_resolve,reject)=>{cancel=reject;});
    // A File may be replaced before anyone requests a save. Keep rejection
    // observed while retaining the original promises for waiting callers.
    void ready.catch(()=>{});void cancelled.catch(()=>{});
    const mounted:Mount=current={frame,active:true,ready,resolveReady,rejectReady,cancelled,cancel};
    frame.className='office-docx__renderer';frame.setAttribute('aria-label','Word 文档编辑器');
    (frame as any).__projectMindDocxOptions=settings(mounted);
    frame.srcdoc=rendererHtml;
    frame.addEventListener('error',()=>{if(isCurrent(mounted))mounted.rejectReady(new Error('Word 编辑器加载失败'));},{once:true});
    element.append(frame);
  }
  function invalidate(mounted:Mount){
    if(!mounted.active)return;
    mounted.active=false;const error=inactiveError();mounted.rejectReady(error);mounted.cancel(error);
    api(mounted)?.destroy();mounted.frame.remove();
  }
  function updateSettings(acknowledge=false){const next=settings(current);(current.frame as any).__projectMindDocxOptions=next;const renderer=api();if(acknowledge)renderer?.acknowledge(next);else renderer?.update(next);}
  mount();
  const observer=new MutationObserver(()=>{if(!disposed)updateSettings();});
  observer.observe(element.ownerDocument.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});
  return{
    update(next){
      if(disposed)return;
      const rebase=next.model!==options.model;
      // File re-inspects the exact emitted bytes after its native CAS save. This
      // receipt advances only the external baseline; the live upstream source
      // remains the anchor for cumulative edits and undo history.
      const receipt=rebase&&next.edits.length===0&&(
        next.model.sourceBase64===options.model.sourceBase64||
        (lastEmitted?.length===1&&lastEmitted[0].type==='snapshot'&&next.model.sourceBase64===lastEmitted[0].base64));
      const external=next.edits!==options.edits&&next.edits!==lastEmitted&&JSON.stringify(next.edits)!==JSON.stringify(lastEmitted);
      if(!receipt&&(rebase||external))invalidate(current);
      options=next;
      if(receipt){lastEmitted=[];updateSettings(true);}
      else if(rebase||external){
        if(rebase&&next.edits.length){lastEmitted=[];options={...next,edits:[]};next.onChange([]);}
        mount();options.onPendingChange?.(false);
      }else updateSettings();
    },
    async beforeSave(){const mounted=current;await runCurrent(mounted,()=>mounted.ready);await runCurrent(mounted,()=>api(mounted).flush(true));},
    destroy(){if(disposed)return;disposed=true;observer.disconnect();invalidate(current);options.onPendingChange?.(false);},
    undo(){if(!disposed&&!options.readOnly&&!options.model.readOnly)api()?.undo();},
    redo(){if(!disposed&&!options.readOnly&&!options.model.readOnly)api()?.redo();},
  };
}

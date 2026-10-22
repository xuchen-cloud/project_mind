import {pickImage,copyImageToClipboard,exportHtml,pickViaInput} from './web-helpers.mjs';
import {replaceInlineRange} from './upstream/apps/docs/src/renderer/ai/protocol';
import {flushSync} from 'react-dom';
import {buildPrintDocument} from './renderer-print';
import {createPdfBridge} from './renderer-pdf';
import type {FileActionContext} from './upstream/apps/docs/src/renderer/file-actions';
import type {Edit} from './types';
import type {FaceVerticalMetrics,EditorRemoteImage} from './editor-types';
interface EmbeddedOptions {
  sourceBase64: string; baselineHash: string; readOnly: boolean; presentationMode:'preview'|'edit'; hasDraft:boolean;initialDocument?:unknown;
  appearance:{theme:'light'|'dark';font:string;tokens:Record<string,string>};
  onChange(edits:Edit[]):void; onPending?(value:boolean):void; onError?(message:string):void;
  onReady?():void; onSaveRequest?():void|Promise<void>;
  onExport?(file:{name:string;mime:string;bytes:Uint8Array}):Promise<boolean>;
  onPrint?(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}}):Promise<void>;
  onRenderPdf?(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}}):Promise<Uint8Array>;
  onConvertAltChunkHtml?(html:string):Promise<Uint8Array|null>;
  onGetSystemFonts?():Promise<string[]>;
  onFontMetrics?(family:string):Promise<FaceVerticalMetrics|null>;
  onFetchImage?(url:string):Promise<EditorRemoteImage>;
}
export function initializeHost(deps:{buildDocBytes(ctx:FileActionContext):Promise<Uint8Array|null>;isDocDirty(ctx:FileActionContext):boolean;exportHtml(ctx:FileActionContext):Promise<boolean>;printDoc(ctx:FileActionContext):void;exportPdf(ctx:FileActionContext):Promise<boolean>;exportImages(ctx:FileActionContext):Promise<boolean>}){
  const frame=window.frameElement as HTMLIFrameElement & {__projectMindDocxOptions:EmbeddedOptions};
  if(!frame?.__projectMindDocxOptions) throw Error('Word renderer requires its File host');
  let options=frame.__projectMindDocxOptions;
  let destroyed=false;
  const ensureActive=()=>{if(destroyed)throw Error('Word 编辑器已关闭，旧文档操作已失效');};
  let rejectStopped!:(error:Error)=>void;
  const stopped=new Promise<never>((_resolve,reject)=>{rejectStopped=reject;});void stopped.catch(()=>{});
  const pdf=createPdfBridge(()=>{ensureActive();return options;});
  let context:FileActionContext|null=null;
  let revision=0, savedRevision=0, persistedRevision=options.hasDraft?-1:0, serializing:Promise<Edit[]>|null=null;
  let lastDirty=options.hasDraft;
  let previous:unknown[]=[];
  let last:Edit[]=[];
  let loading=true,composing=false,activeOperations=0,restoringDraft=false,uncommittedInput=false;
  let operationsIdle=Promise.resolve(),resolveOperationsIdle=()=>{};
  let operationFailure:unknown=null;
  let restoredDraft=false;
  let captured:{id:string;editor:NonNullable<FileActionContext['editor']>;doc:unknown;revision:number;from:number;to:number}|null=null;
  function selectionEditor(){
    ensureActive();const editor=context?.editor;
    if(options.readOnly||options.presentationMode==='preview'||!editor?.isEditable)throw Error('当前 Word 文档只读');
    if(loading||composing||editor.view.composing||activeOperations||uncommittedInput||restoringDraft||serializing)throw Error('Word 文档正在处理输入，请稍后重试');
    return editor;
  }

  document.addEventListener('compositionstart',()=>{if(!destroyed){composing=true;pending(true);}},true);
  document.addEventListener('compositionend',()=>{if(!destroyed){composing=false;queueMicrotask(()=>{void flush().catch(()=>{});});}},true);
  document.addEventListener('input',event=>{
    if(destroyed)return;
    const target=event.target as Element,editor=target.closest('.ProseMirror');
    if((editor&&!editor.classList.contains('doc-page'))||target.closest('.ribbon input')){uncommittedInput=true;pending(true);}
  },true);
  const events=new Map<string,Set<Function>>();
  const views=new Map<any,{locked:boolean}>();
  const subscribe=(name:string,fn:Function)=>{let set=events.get(name);if(!set)events.set(name,set=new Set());set.add(fn);return()=>set!.delete(fn);};
  const emit=(name:string,...args:unknown[])=>events.get(name)?.forEach(fn=>fn(...args));
  function applyAppearance(){
    const root=document.documentElement,{theme,font,tokens}=options.appearance;
    root.dataset.presentationMode=options.presentationMode;
    root.dataset.theme=theme;root.dataset.docTheme=theme;root.classList.toggle('dark',theme==='dark');
    for(const [name,value]of Object.entries(tokens))root.style.setProperty(name,value);
    root.style.setProperty('--font-ui',tokens['--font-ui']||font);root.style.setProperty('--gs-font-sans',tokens['--font-ui']||font);
    emit('onThemeChanged',theme);emit('onDocumentThemeChanged',theme);
    window.dispatchEvent(new Event('resize'));
  }
  applyAppearance();
  const blobUrl=(base64:string)=>URL.createObjectURL(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
  const sourceUrl=blobUrl(options.sourceBase64);
  const comparisonUrls=new Set<string>();
  const opened={path:'project-mind.docx',name:'Word.docx',hash:options.baselineHash,dataUrl:sourceUrl};
  const base64=(bytes:Uint8Array)=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
  const pending=(value:boolean)=>{if(destroyed)return;options.onPending?.(value||uncommittedInput||composing||activeOperations>0);const dirty=host.dirty;if(dirty!==lastDirty){lastDirty=dirty;emit('hostDirty',dirty);}};
  // Native rejects structured objects; parent-realm Error is not instanceof
  // this iframe's Error. Keep its actual message at this trust boundary.
  const errorMessage=(error:unknown)=>typeof error==='object'&&error!==null&&'message'in error&&typeof error.message==='string'?error.message:String(error);
  const fail=(error:unknown)=>{if(!destroyed)options.onError?.(errorMessage(error));return error;};
  async function flush(commitActiveInput=false):Promise<Edit[]>{
    ensureActive();return await Promise.race([flushActive(commitActiveInput),stopped]);
  }
  async function flushActive(commitActiveInput:boolean):Promise<Edit[]>{
    ensureActive();
    if(composing||context?.editor?.view.composing)throw Error('请先完成当前输入法组合文字再保存。');
    if(activeOperations){if(!commitActiveInput)return last;await operationsIdle;ensureActive();}
    if(commitActiveInput){
      if(composing||context?.editor?.view.composing)throw Error('请先完成当前输入法组合文字再保存。');
      if(operationFailure){const error=operationFailure;operationFailure=null;throw fail(error);}
      // Nested table/textbox/header editors commit into React state. Commit
      // that state before reading FileActionContext, even under concurrent
      // rendering; a requestAnimationFrame alone can run before React's work.
      flushSync(()=>{
        if(document.activeElement instanceof HTMLInputElement||document.activeElement instanceof HTMLTextAreaElement)document.activeElement.blur();
        window.dispatchEvent(new Event('ai-docs-commit-tables'));
      });
      uncommittedInput=false;
    }
    // React input/format state must reach the shared upstream file context first.
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    ensureActive();
    if(commitActiveInput&&activeOperations)return flush(true);
    if(loading||!context?.doc)throw Error('文档仍在加载，请稍后保存。');
    // Tiptap mutates its live state synchronously, while its React subscription
    // may commit after this frame. Sample that state at the save boundary so
    // a just-finished image paste cannot save the previous document revision.
    if(commitActiveInput)host.render(context,loading);
    if(serializing){await serializing;ensureActive();if(savedRevision===revision)return last;}
    if(savedRevision===revision){pending(false);return last;}
    serializing=(async()=>{
      while(savedRevision!==revision){
        const at=revision;
        const bytes=await deps.buildDocBytes(context!);
        ensureActive();
        if(!bytes)throw Error('无法生成 DOCX 保存字节。');
        if(at!==revision)continue;
        last=[{type:'snapshot',baselineHash:options.baselineHash,base64:base64(bytes)}];
        savedRevision=at;options.onChange(last);
      }
      pending(false);return last;
    })();
    try{return await serializing;}catch(error){fail(error);throw error;}finally{serializing=null;}
  }
  const host={
    reportError:fail,
    startImages:(name:string)=>pdf.startImages(name),finishImages:()=>pdf.finishImages(),cancelImages:()=>pdf.cancelImages(),
    async getSystemFonts(){
      try{
        ensureActive();
        if(options.onGetSystemFonts){const fonts=await options.onGetSystemFonts();ensureActive();return fonts;}
        const query=(window as any).queryLocalFonts;
        if(!query)throw Error('当前宿主尚未连接系统字体枚举。');
        const fonts=await query.call(window);ensureActive();return[...new Set<string>(fonts.map((font:{family:string})=>font.family))].sort((a,b)=>a.localeCompare(b));
      }catch(error){fail(error);throw error;}
    },
    registerEditorView(view:any){if(!destroyed)views.set(view,{locked:options.readOnly});return()=>views.delete(view);},
    beginOperation(){if(destroyed)return;if(!activeOperations){operationFailure=null;operationsIdle=new Promise(resolve=>{resolveOperationsIdle=resolve;});}activeOperations++;pending(true);},
    endOperation(error?:unknown){if(destroyed)return;if(error)operationFailure=error;activeOperations=Math.max(0,activeOperations-1);if(!activeOperations){resolveOperationsIdle();void flush().catch(()=>{});}},
    get readOnly(){return options.readOnly&&!loading&&!restoringDraft;},
    get presentationMode(){return options.presentationMode;},
    get locked(){return destroyed||options.readOnly;},
    get dirty(){return revision!==persistedRevision||uncommittedInput||composing||activeOperations>0;},
    subscribeDirty(fn:Function){return subscribe('hostDirty',fn);},
    subscribeReadOnly(fn:Function){return subscribe('hostReadonly',fn);},
    flush,
    update(next:EmbeddedOptions){if(destroyed)return;if(next.readOnly)captured=null;options=next;emit('hostReadonly',options.readOnly);applyAppearance();if(context)host.render(context,loading);},
    acknowledge(next:EmbeddedOptions){if(destroyed)return;if(next.readOnly)captured=null;options=next;persistedRevision=savedRevision;last=[];pending(false);context?.setStatus('已保存');emit('hostReadonly',options.readOnly);applyAppearance();if(context)host.render(context,loading);},
    captureSelection(){
      const editor=selectionEditor(),{doc,selection}=editor.state,{from,to,$from,$to}=selection;
      const native=window.getSelection();
      const owner=(node:Node|null)=>(node?.nodeType===Node.ELEMENT_NODE?node as Element:node?.parentElement)?.closest('.ProseMirror');
      if(!native||native.isCollapsed||owner(native.anchorNode)!==editor.view.dom||owner(native.focusNode)!==editor.view.dom)throw Error('请选择 Word 正文段落内的文字，不能选择表格或其他编辑区域');
      const anchor=editor.view.posAtDOM(native.anchorNode!,native.anchorOffset),focus=editor.view.posAtDOM(native.focusNode!,native.focusOffset);
      if(Math.min(anchor,focus)!==from||Math.max(anchor,focus)!==to)throw Error('Word 选区正在更新，请重新选择文字');
      if(selection.empty||$from.depth!==1||!$from.sameParent($to)||!['docParagraph','docHeading'].includes($from.parent.type.name))throw Error('请选择同一段落或标题内的文字，不能跨段落或选择表格');
      let blocked=false;
      doc.nodesBetween(from,to,node=>{if(node.isInline&&(!node.isText||node.marks.some(mark=>['ins','del'].includes(mark.type.name))))blocked=true;});
      if(blocked||$from.parent.attrs.blockRevision)throw Error('选区包含受保护内容或已有修订，请先调整选区');
      const text=doc.textBetween(from,to,'','');if(!text.trim())throw Error('请选择非空文字');
      const id=crypto.randomUUID();captured={id,editor,doc,revision,from,to};return{selectionId:id,text};
    },
    replaceSelection(input:{selectionId:string;text:string}){
      const editor=selectionEditor(),selection=captured;
      if(!selection||selection.id!==input.selectionId||selection.editor!==editor||selection.doc!==editor.state.doc||selection.revision!==revision){captured=null;throw Error('Word 选区已失效，请重新选择文字');}
      if(typeof input.text!=='string'||!input.text.trim()||/[\r\n]/.test(input.text))throw Error('替换内容必须是单段非空纯文字');
      const $from=editor.state.doc.resolve(selection.from);
      const inherited=($from.parent.childAfter($from.parentOffset).node?.marks??[]).filter(mark=>!['ins','del'].includes(mark.type.name));
      replaceInlineRange(editor,selection.from,selection.to,[editor.schema.text(input.text,inherited)],{author:'Project Mind AI'});
      captured=null;
      host.render(context!,loading);return{text:input.text};
    },
    async requestSave(){
      ensureActive();
      if(!options.onSaveRequest)throw Error('当前 File 宿主尚未连接 Word 保存回执。');
      await options.onSaveRequest();ensureActive();return true;
    },
    async output(command:'html'|'print'|'pdf'|'images'|'preview'){
      try{await flush(true);if(command==='preview'){context!.setShowPagePreview(true);return true;}if(command==='html')return await deps.exportHtml(context!);if(command==='pdf')return await deps.exportPdf(context!);if(command==='images')return await deps.exportImages(context!);deps.printDoc(context!);return true;}
      catch(error){fail(error);return false;}
    },
    render(ctx:FileActionContext,docLoading:boolean){
      if(destroyed)return;
      context=ctx;loading=docLoading||!ctx.doc;
      syncViews();
      for(const node of document.querySelectorAll<HTMLElement>('.pm-ribbon-edit-tabs,.ribbon-body,.modal-backdrop:not(.pm-output-dialog):not(.pm-view-dialog),.comments-pane'))node.inert=options.readOnly;
      // Lock immediately. App's own readMode/protection/embeddedReadOnly effect
      // owns unlocking; restoring a captured isEditable=false from an initially
      // read-only mount would override that effect and leave it locked forever.
      if(ctx.editor&&options.readOnly&&ctx.editor.isEditable)ctx.editor.setEditable(false,false);
      if(!loading&&ctx.editor&&options.initialDocument&&!restoredDraft){restoredDraft=true;restoringDraft=true;try{ctx.editor.commands.setContent(options.initialDocument as any);}finally{restoringDraft=false;}}
      const signature=[ctx.editor?.state.doc,ctx.doc,ctx.section,ctx.sections,ctx.header,ctx.footer,ctx.sectionHfEdits,ctx.hfLinks,ctx.hfVariants,ctx.comments,ctx.footnotes,ctx.endnotes,ctx.pendingNumbering,ctx.styleUpserts,ctx.defaultFonts,ctx.pageColor,ctx.watermark,ctx.watermarkStyle,ctx.watermarkPicture,ctx.inkAnnotations,ctx.sources,ctx.zoteroDocumentData,ctx.themeColors,ctx.themeFonts,ctx.protection,ctx.writeProtection,ctx.removePersonalInfo,ctx.pgNumEdit,ctx.mirrorMargins,ctx.titlePg,ctx.evenOddHf,ctx.trailingStartType,ctx.sectionsDirty,ctx.pgNumDirtySections,ctx.hfVariantsDirty,ctx.sectionDirty,ctx.pageColorDirty,ctx.headerDirty,ctx.footerDirty,ctx.numberingDirty,ctx.commentsDirty,ctx.protectionDirty,ctx.writeProtectionDirty,ctx.removePersonalInfoDirty,ctx.inksDirty,ctx.watermarkDirty,ctx.notesDirty,ctx.sourcesDirty,ctx.zoteroDocumentDataDirty,ctx.themeFontsDirty,ctx.themeColorsDirty,ctx.titlePgDirty,ctx.evenOddHfDirty,ctx.mirrorMarginsDirty];
      const changed=signature.some((value,i)=>value!==previous[i]);previous=signature;
      if(!loading){options.onReady?.();if(changed&&deps.isDocDirty(ctx)){revision++;pending(true);void flush().catch(()=>{});}}
    },
    destroy(){if(destroyed)return;destroyed=true;captured=null;rejectStopped(Error('Word 编辑器已关闭，旧文档操作已失效'));resolveOperationsIdle();events.clear();views.clear();context=null;pdf.cancelImages();URL.revokeObjectURL(sourceUrl);for(const url of comparisonUrls)URL.revokeObjectURL(url);comparisonUrls.clear();},
    undo(){if(!destroyed)context?.editor?.commands.undo();},redo(){if(!destroyed)context?.editor?.commands.redo();},
  };
  // The boundary plugin contributes its own editable predicate. Never capture
  // or replace view.props.editable: Tiptap reapplies editorProps on renders,
  // and a captured false predicate can permanently override setEditable(true).
  function syncViews(){for(const [view,state]of views)if(state.locked!==options.readOnly){state.locked=options.readOnly;view.updateState(view.state);}}
  (window as any).__projectMindDocxHost=host;
  // Only this renderer's Web bridge is exposed. No filesystem, IPC, or native capability.
  const api:Record<string,any>={
    getLanguage:async()=>'zh',getSystemLocale:async()=>navigator.language,getTheme:async()=>options.appearance.theme,getDocumentTheme:async()=>options.appearance.theme,
    getAutoSaveDefault:async()=>false,getAiPanelPrefs:async()=>({}),getAiSettings:async()=>({provider:'anthropic',providers:{}}),
    getRecentFiles:async()=>[],consumePendingOpenDocx:async()=>opened,consumeNewBlankDoc:async()=>false,consumeAiDocContent:async()=>null,consumeHeadlessExport:async()=>null,
    docPasswordIntentRevision:async()=>0,discardDocPasswordIntents:async()=>{},confirmDocumentReplace:async()=>false,
    writeRecoveryCopy:async()=>{}, // recovery belongs to the enclosing File edit session
    pickImage,copyImageToClipboard,
    fetchImage:async(value:string)=>{
      try{
        ensureActive();
        const editable=()=>{if(options.readOnly)throw Error('当前 Word 文档只读，不能粘贴图片。');};editable();
        if(options.onFetchImage){const image=await options.onFetchImage(value);ensureActive();editable();return image;}
        const url=new URL(value);if(!['http:','https:'].includes(url.protocol))throw Error('粘贴图片只接受 HTTP(S) URL。');
        const response=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30_000)});
        if(!response.ok)throw Error(`图片下载失败 (${response.status})`);
        const mime=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if(!mime||!/^image\/(png|jpeg|gif)$/.test(mime))throw Error(`粘贴图片格式不受上游保存支持：${mime??'未知类型'}`);
        // Standalone browser only. A native rejection must not fall back to
        // this CORS path and lose its File authorization or real error.
        const limit=50*1024*1024,reader=response.body?.getReader();if(!reader)throw Error('图片响应没有字节流。');
        const chunks:Uint8Array[]=[];let size=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('图片超过上游 50 MiB 限制。');}chunks.push(value);}}finally{reader.releaseLock();}
        ensureActive();editable();const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        return{mime,base64:base64(bytes)};
      }catch(error){const visible=new Error(errorMessage(error));fail(visible);throw visible;}
    },
    openDocx:async()=>{
      ensureActive();const file=await pickViaInput('.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document');ensureActive();if(!file)return null;
      const bytes=await file.arrayBuffer();ensureActive();
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
      ensureActive();const url=URL.createObjectURL(new Blob([bytes]));comparisonUrls.add(url);
      return{path:`comparison:${file.name}`,name:file.name,dataUrl:url,hash};
    },
    exportHtml:async(name:string,html:string)=>{
      ensureActive();
      if(!options.onExport)return exportHtml(name,html);
      name=name.replace(/\.docx$/i,'').replace(/\.html$/i,'')+'.html';
      const ok=await options.onExport({name,mime:'text/html',bytes:new TextEncoder().encode(html)});
      return{ok,...(ok?{path:name}:{})};
    },
    convertAltChunkHtml:async(html:string)=>{
      ensureActive();
      if(!options.onConvertAltChunkHtml){fail(Error('altChunk HTML 转换未连接；导入片段无法展开，原始部件仍保留。'));return null;}
      try{const bytes=await options.onConvertAltChunkHtml(html);ensureActive();if(!bytes)fail(Error('altChunk HTML 转换未完成；原始部件仍保留。'));return bytes?new Uint8Array(bytes):null;}
      catch(error){fail(error);throw error;}
    },
    getSystemFonts:()=>host.getSystemFonts(),fontMetrics:async(family:string)=>options.onFontMetrics?await options.onFontMetrics(family):null,
    exportPdf:pdf.exportPdf,printPdfBuffer:pdf.printPdfBuffer,saveMergedPdf:pdf.saveMergedPdf,takeExportPdf:pdf.takeExportPdf,writeExportImage:pdf.writeExportImage,
    // Browser print has no printer/cancel receipt. `ok` acknowledges that the
    // system dialog returned; it does not claim bytes were written or printed.
    print:async()=>{
      try{ensureActive();if(options.onPrint){const document=await buildPrintDocument(context?.doc?.fileName??'Word');ensureActive();await options.onPrint(document);ensureActive();}else window.print();return{ok:true};}
      catch(error){return{ok:false,error:String(error)};}
    },
    saveImageAs:async(src:string)=>{
      try{
        ensureActive();
        const response=await fetch(src);if(!response.ok)throw Error('无法读取原图片字节');
        const blob=await response.blob(),mime=blob.type||'image/png';
        const extension=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg','image/bmp':'bmp','image/tiff':'tiff'} as Record<string,string>)[mime]??'bin';
        const name=`image.${extension}`;
        const bytes=new Uint8Array(await blob.arrayBuffer());ensureActive();
        if(options.onExport)return{ok:await options.onExport({name,mime,bytes})};
        const a=document.createElement('a');a.href=src;a.download=name;a.click();return{ok:true};
      }catch(error){fail(error);return{ok:false,error:String(error)};}
    },
  };
  (window as any).desktop=new Proxy(api,{get(target,key:string){
    if(key in target)return target[key];
    if(key.startsWith('on'))return(fn:Function)=>subscribe(key,fn);
    if(/^(report|signal|arm|claim|spellDiag)/.test(key))return()=>{};
    return async()=>{throw fail(new Error(`嵌入式 Word 尚未接入 ${key}`));};
  }});
  // File relationships are metadata, never privileged renderer navigation.
  document.addEventListener('click',event=>{if((event.target as Element)?.closest?.('a'))event.preventDefault();},true);
  window.addEventListener('error',event=>fail(event.error??event.message));
  window.addEventListener('unhandledrejection',event=>fail(event.reason));
  window.addEventListener('pagehide',()=>host.destroy(),{once:true});
}

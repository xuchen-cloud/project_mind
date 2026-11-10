/** Browser and Node share the same pinned document handlers. No file-system authority. */
import {newPasteCascade,pasteShiftPx,recordPaste,pageKey} from './vendor/apps/slides/src/main/paste-cascade';
import {withReplayContext} from './parity-context';
import * as engine from '@genoffice/pptx-engine';
import { runTxn } from './vendor/packages/pptx-ops/src/ops';
import { buildRenderSlide, makeViewport, HeuristicMetrics, type RenderSlide, type FontMetricsProvider } from '@genoffice/pptx-render';
import { createHandlers } from './parity-handlers.mjs';
import { safeExternalUrl } from './vendor/packages/electron-utils/src/safe-external-url';
import type { PptxCommand } from './types';
import {suppressFilledSlidePrompts} from './placeholder-prompts';
import {isUnloadedSlide,materializeViewSlide,materializeViewDeck} from './progressive-open';
import {synchronizeGeneratedChartWorkbooks} from './chart-workbook';

type State = {
  opened: engine.OpenedPptx; path: string; fitWidthPx: number;
  undoStack: Snapshot[]; redoStack: Snapshot[]; metaDirty?: boolean;
  transformPreview?: boolean; masterEdit?: {partPath: string; slide: engine.Slide} | null;
};
type Snapshot = { slides: engine.Slide[]; entries: Map<string, Uint8Array>; size: {cx:number;cy:number}; metaDirty?:boolean };
const query = /^slides:(?:get-|media-data$|chart-color-schemes$|master-enter$|master-open$|master-close$|is-dirty$|clipboard-probe$|clipboard-external$|has-slide-clipboard$)/;

/** IDs use OOXML cNvPr aliases, including newly inserted/grouped shapes, across reparses. */
export function stableIds(opened: engine.OpenedPptx) {
  const aliases = new Map<string,string>();
  const visit = (el: engine.SlideElement) => {
    const nvId = el.nvId ?? engine.elementSpid(el);
    const id = nvId != null ? `e_${nvId}` : engine.elementDurableId(el);
    if (id) { aliases.set(el.id,id); el.id=id; }
    if (el.type === 'group') el.children.forEach(visit);
  };
  opened.deck.slides.forEach(s=>s.elements.forEach(visit));
  return aliases;
}
function remap(value: any, aliases: Map<string,string>): any {
  if (typeof value === 'string') return aliases.get(value) ?? value;
  if (Array.isArray(value)) return value.map(v=>remap(v,aliases));
  if (value && typeof value === 'object') {
    // Render getters must stay lazy across the in-process IPC adapter.
    const result:Record<string,unknown>={};
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
      Object.defineProperty(result,key,descriptor.get?descriptor:{...descriptor,value:remap(descriptor.value,aliases)});
    }
    return result;
  }
  return value;
}
export function createParitySession(opened: engine.OpenedPptx, options: {
  emit?: (name:string,payload:unknown)=>void;
  onCommand?: (edit:PptxCommand)=>void;
  confirmChart?: (message:string)=>Promise<boolean>;
  metrics?: FontMetricsProvider;
  /** In-process view descriptors stay lazy; explicit global output resolves all slides. */
  lazyInitialLayout?: boolean;
} = {}) {
  const metrics=options.metrics??new HeuristicMetrics();
  const state: State = { opened, path:'document.pptx',fitWidthPx:960,undoStack:[],redoStack:[] };
  const allAliases=new Map<string,string>();
  const normalize=()=>{opened=state.opened;stableIds(opened).forEach((v,k)=>allAliases.set(k,v));if(state.masterEdit){stableIds({...opened,deck:{...opened.deck,slides:[state.masterEdit.slide]}}).forEach((v,k)=>allAliases.set(k,v))}};
  normalize();
  let readOnly=false,commandCount=0;
  const baseSeed=opened.deck.originalHash;
  const chartBaseline=new Map([...opened.archive.entries].filter(([path])=>/^ppt\/charts\/chart\d+\.xml$/.test(path)));
  const snap=(): Snapshot=>({slides:structuredClone(state.opened.deck.slides),entries:new Map(state.opened.archive.entries),size:{...state.opened.deck.size},metaDirty:state.metaDirty});
  const restore=(_s:State,s:Snapshot)=>{opened=state.opened;opened.deck.slides=structuredClone(s.slides);opened.deck.size={...s.size};opened.archive.entries.clear();s.entries.forEach((v,k)=>opened.archive.entries.set(k,v));state.metaDirty=s.metaDirty;normalize()};
  const media=(o:engine.OpenedPptx)=>(part:string)=>{const bytes=o.archive.entries.get(part);if(!bytes)return undefined;const ext=part.split('.').pop();const mime=({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',webp:'image/webp'} as Record<string,string>)[ext??'']??'application/octet-stream';return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`};
  const ensure=(o:engine.OpenedPptx,index:number)=>{
    const slide=materializeViewSlide(o,index);
    if(slide)stableIds({...o,deck:{...o.deck,slides:[slide]}}).forEach((v,k)=>allAliases.set(k,v));
    return slide;
  };
  const buildEager=(o=state.opened,width=state.fitWidthPx)=>{
    materializeViewDeck(o);normalize();
    return o.deck.slides.map((s,i)=>suppressFilledSlidePrompts(buildRenderSlide(s,o.deck.size,{fitWidthPx:width,metrics,media:media(o),slideNo:i+1})));
  };
  const buildInitial=(width:number,o=state.opened):RenderSlide[]=>{
    normalize();
    const vp=makeViewport(o.deck.size,width),resolveMedia=media(o);
    return o.deck.slides.map((entry,index)=>{
      let rendered:RenderSlide|undefined;
      // Resolve by path: a stale render descriptor must not parse the slide now
      // occupying this index after a structural operation or history restore.
      const layout=()=>{
        if(rendered)return rendered;
        const at=o.deck.slides.findIndex(s=>s.path===entry.path);
        const slide=at<0?entry:ensure(o,at)!;
        return rendered=suppressFilledSlidePrompts(buildRenderSlide(slide,o.deck.size,{fitWidthPx:width,metrics,media:resolveMedia,slideNo:index+1}));
      };
      const xml=isUnloadedSlide(entry)?Buffer.from(o.archive.entries.get(entry.path)??[]).toString('utf8'):entry.bodyPrefix;
      const result:RenderSlide={...vp,partPath:entry.path,
        get background(){return layout().background},
        ...(/<p:bg[\s>]/.test(xml)?{bgOwn:true}:{}),
        ...(/<p:sld\b[^>]*\sshowMasterSp=["'](?:0|false)["']/.test(xml)?{bgGraphicsHidden:true}:{}),
        ...(/<p:sld\b[^>]*\sshow=["'](?:0|false)["']/.test(xml)?{hidden:true}:{}),
        get nodes(){return layout().nodes},
      };
      // App's empty-deck check may consult load state without enumerating a
      // diagnostic field into RenderSlide payloads or triggering layout.
      Object.defineProperty(result,'projectMindUnloaded',{get(){const slide=o.deck.slides.find(s=>s.path===entry.path);return !!slide&&isUnloadedSlide(slide)}});
      return result;
    });
  };
  const buildAll=(o=state.opened,width=state.fitWidthPx)=>options.lazyInitialLayout?buildInitial(width,o):buildEager(o,width);
  const rebuild=(_s:State,index:number)=>{normalize();const slide=ensure(state.opened,index);return slide?suppressFilledSlidePrompts(buildRenderSlide(slide,state.opened.deck.size,{fitWidthPx:state.fitWidthPx,metrics,media:media(state.opened),slideNo:index+1})):null};
  const emitHistory=()=>queueMicrotask(()=>options.emit?.('slides:history-changed',{canUndo:state.undoStack.length>0,canRedo:state.redoStack.length>0}));
  const push=()=>{state.undoStack.push(snap());if(state.undoStack.length>100)state.undoStack.shift();state.redoStack=[];emitHistory()};
  let pickedBytes:Uint8Array|null=null,pickedName='';
  const noFile=()=>{throw new Error('PPTX file input must be supplied as bytes by the browser picker')};
  const handlers=createHandlers({sessions:new Map([[1,state]]),pushHistory:push,restoreSnapshot:restore,scheduleHistoryNotify:emitHistory,scheduleDeckBroadcast:()=>{},markMetaDirty:()=>{state.metaDirty=true},journalOps:()=>{},rebuildSlide:rebuild,rebuildSlideWithReparse:(_s:State,i:number)=>{engine.materializeSlide(opened,i);return rebuild(state,i)},buildAllRenderSlides:buildAll,makeMediaResolver:media,getFontMetrics:()=>metrics,nativeImage:{createThumbnailFromPath:()=>{throw new Error('No native thumbnail in browser')}},dialogParent:()=>null,dialog:{showMessageBox:async()=>({response:await options.confirmChart?.('编辑此导入图表会采用上游图表模板，原图中未建模的细节格式可能丢失。是否继续？')?0:1})},tm:(key:string)=>key,commentAuthorName:()=> 'Project Mind',safeExternalUrl,showOpenDialogWithMemory:async()=>pickedBytes?{canceled:false,filePaths:[pickedName]}:noFile(),readFile:async()=>pickedBytes??noFile()});
  let cascade=newPasteCascade(null);
  let elementClipboard: engine.ElementClipboardItem[]=[];
  let slideClipboard: {bundles:engine.SlideBundle[];pngs?:string[]}|null=null;
  let lastPaste: {snapshot:Snapshot;afterIndex:number;undoLen:number}|null=null;
  let batchStart: Snapshot | null=null;
  let batchUndoCount=0;
  const special: Record<string,(...args:any[])=>any>={
    'slides:undo':()=>{if(!state.undoStack.length||state.masterEdit)return null;state.redoStack.push(snap());restore(state,state.undoStack.pop()!);emitHistory();return buildAll()},
    'slides:redo':()=>{if(!state.redoStack.length||state.masterEdit)return null;state.undoStack.push(snap());restore(state,state.redoStack.pop()!);emitHistory();return buildAll()},
    'slides:is-dirty':()=>!!state.metaDirty||opened.deck.slides.some(s=>s.structureDirty||s.elements.some(e=>e.dirty||e.dirtyTransform)),
    'slides:copy-elements':(op:any)=>{slideClipboard=null;cascade=newPasteCascade(op.cut?null:pageKey(1,op.slideIndex));const slide=opened.deck.slides[op.slideIndex];elementClipboard=op.sourceIds.map((id:string)=>slide.elements.find(e=>e.id===id)).filter(Boolean).map((el:engine.SlideElement)=>engine.copyElementData(opened,slide,el));return elementClipboard.length},
    'slides:clipboard-probe':()=>elementClipboard.length>0||slideClipboard!==null,
    'slides:clipboard-external':()=>elementClipboard.length?{kind:'internal'}:slideClipboard?{kind:'slide'}:{kind:'none'},
    'slides:paste-elements':(op:any)=>{if(!elementClipboard.length)return null;push();const key=pageKey(1,op.slideIndex);const shift=Math.round(pasteShiftPx(cascade,key)*opened.deck.size.cx/op.fitWidthPx);const r=runTxn(opened,{ops:[{op:'pasteElements',target:{slide:op.slideIndex},items:elementClipboard,dx:shift,dy:shift}]});if(!r.applied)throw new Error(r.failures?.map(f=>f.error).join('; '));recordPaste(cascade,key);state.fitWidthPx=op.fitWidthPx;return {slide:rebuild(state,op.slideIndex),sourceIds:r.records?.[0].created}},
    'slides:copy-slides':(op:any)=>{const bundles=op.slideIndexes.map((i:number)=>engine.copySlide(opened,i));if(bundles.some((b:any)=>!b))throw new Error('Invalid slide copy');slideClipboard={bundles,pngs:op.pngs};elementClipboard=[];return true},
    'slides:has-slide-clipboard':()=>slideClipboard!==null,
    'slides:paste-slide':(op:any)=>{if(!slideClipboard)return null;const before=snap();push();const picture=op.mode==='picture';const r=runTxn(opened,{ops:slideClipboard.bundles.map((bundle,j)=>({op:'pasteSlide' as const,afterIndex:op.afterIndex+(picture?0:j),mode:op.mode,...(picture?{png:slideClipboard!.pngs?.[j]}:{bundle})}))});if(!r.applied){state.undoStack.pop();throw new Error(r.failures?.map(f=>f.error).join('; '))}lastPaste={snapshot:before,afterIndex:op.afterIndex,undoLen:state.undoStack.length};state.metaDirty=true;state.fitWidthPx=op.fitWidthPx;return {slides:buildAll(),index:(r.records![0].after as {index:number}).index,count:picture?0:slideClipboard.bundles.length,sourceIds:r.records!.flatMap(x=>x.created??[])}},
    'slides:repaste-slide':(op:any)=>{if(!lastPaste||lastPaste.undoLen!==state.undoStack.length)return null;const rec=lastPaste;state.undoStack.pop();restore(state,rec.snapshot);return special['slides:paste-slide']({...op,afterIndex:rec.afterIndex})},
    'slides:history-batch-begin':()=>{batchStart=snap();batchUndoCount=state.undoStack.length;return true},
    'slides:history-batch-end':()=>{if(batchStart&&state.undoStack.length>batchUndoCount){state.undoStack.splice(batchUndoCount);state.undoStack.push(batchStart)}batchStart=null;emitHistory();return true},

    'slides:get-render-slides':(width=state.fitWidthPx)=>{state.fitWidthPx=width;return buildEager()},
  };
  return {
    state, viewCoverage:()=>({loadedSlides:state.opened.deck.slides.flatMap((slide,i)=>isUnloadedSlide(slide)?[]:[i]),totalSlides:state.opened.deck.slides.length}), setReadOnly(value:boolean){readOnly=value},
    openResult:(width=state.fitWidthPx)=>{state.fitWidthPx=width;return {path:state.path,slides:options.lazyInitialLayout?buildInitial(width):buildAll(),size:{...opened.deck.size}}},
    async invoke(name:string,args:any[]=[]) {
      const marker=args.at(-1);const recordedAt=marker?.__projectMindReplayAt;
      if(recordedAt!==undefined){if(!Number.isSafeInteger(recordedAt))throw new Error('Invalid replay timestamp');args=args.slice(0,-1)}
      // Resolve the actual command's slide dependencies before entering upstream ops.
      // Global operations retain their original full-deck semantics.
      const first=args[0];
      if(options.lazyInitialLayout){
        const indexes=typeof first==='number'&&name!=='slides:get-render-slides'?[first]
          :first&&typeof first==='object'&&Number.isInteger(first.slideIndex)?[first.slideIndex]
          :first&&Array.isArray(first.slideIndexes)?first.slideIndexes:[];
        if(indexes.length&&indexes.every((i:number)=>i>=0)&&!first?.all&&!first?.applyToAll)indexes.forEach((i:number)=>ensure(state.opened,i));
        else if(!query.test(name)&&!['slides:undo','slides:redo','slides:history-batch-begin','slides:history-batch-end'].includes(name))materializeViewDeck(state.opened);
        normalize();
      }
      const handler=handlers.get(name);const custom=special[name];
      if(!handler&&!custom)throw new Error(`Unsupported PPTX editing command: ${name}`);
      const isQuery=query.test(name)||name==='slides:get-render-slides'||name==='slides:copy-elements-image';
      if(readOnly&&!isQuery)throw new Error('PPTX session is read only');
      // IDs emitted by an inserted object must remain usable in the next command and save replay.
      // Byte sources are journaled as base64; only this trusted replay boundary supplies a virtual picker.
      const op=name==='slides:insert-model3d'?args[2]:args[0];
      const at=recordedAt??Date.now();
      const context={seed:`${baseSeed}:${commandCount}:${name}:${JSON.stringify(args)}`,at,ordinal:0};
      const result=await withReplayContext(context,async()=>{
      let result;
      if((name==='slides:edit-background'||name==='slides:edit-image-fill'||name==='slides:insert-model3d')&&op?.source?.base64){
        pickedBytes=new Uint8Array(Buffer.from(op.source.base64,'base64'));pickedName=`picked.${op.source.ext}`;
        try{result=await handler!({sender:{id:1}},...args)}finally{pickedBytes=null}
      }else result=custom?await custom(...args):await handler!({sender:{id:1}},...args);
      return result;
      });
      if(result?.error || result?.applied===false && !result?.dryRun)throw new Error(result.error??result.failures?.map((f:any)=>f.error).join('; ')??'PPTX operation rejected');
      normalize();const aliases=allAliases;
      if(result===null&&!isQuery&&!['slides:cancel-transform-preview','slides:undo','slides:redo'].includes(name))throw new Error(`PPTX operation failed: ${name}`);
      if((!isQuery||/^slides:master-(enter|open|close)$/.test(name))&&result!==null){commandCount++;options.onCommand?.({kind:'command',name,args:JSON.parse(JSON.stringify([...args,{__projectMindReplayAt:at}]))})}
      return remap(result,aliases);
    },
    save:()=>withReplayContext({seed:`${baseSeed}:save:${commandCount}`,at:0,ordinal:0},async()=>synchronizeGeneratedChartWorkbooks(await engine.savePptx(state.opened),chartBaseline)),
  };
}

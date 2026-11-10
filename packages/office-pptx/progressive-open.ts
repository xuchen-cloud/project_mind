/** A view cache over a completely validated source package. Unloaded is never empty. */
import * as engine from '@genoffice/pptx-engine';
import {validateArchiveXml} from './archive-validation';
import type {PptxModel} from './types';
type Slide=engine.Slide;
type DeferredSlide=Slide & {projectMindUnloaded?:true};
// Exported only in the build adapter; source-lock still verifies the original parser.
const parseSlide=(engine as typeof engine & {parseSlideFromArchive(archive:engine.PackageArchive,path:string):Slide|null}).parseSlideFromArchive;

export function isUnloadedSlide(slide:Slide):boolean{return !!(slide as DeferredSlide).projectMindUnloaded}

export function materializeViewSlide(opened:engine.OpenedPptx,index:number):Slide|null{
 const current=opened.deck.slides[index];
 if(!current||!isUnloadedSlide(current))return current??null;
 const slide=parseSlide(opened.archive,current.path);
 if(!slide)throw Error(`PPTX slide part missing: ${current.path}`);
 opened.deck.slides[index]=slide;
 return slide;
}
export function materializeViewDeck(opened:engine.OpenedPptx){opened.deck.slides.forEach((_,i)=>materializeViewSlide(opened,i))}

/** First-slide seed belongs to these exact bytes, never to a later candidate or replacement File. */
export async function openViewPptx(bytes:Uint8Array,model?:PptxModel):Promise<engine.OpenedPptx & {viewTimings:{archiveMs:number;xmlValidationMs:number}}>{
 if(!(bytes instanceof Uint8Array)||bytes.length===0)throw Error('Invalid PPTX bytes: expected nonempty Uint8Array');
 const start=performance.now();
 const archive=await engine.PackageArchive.open(bytes);
 const inflated=performance.now();
 validateArchiveXml(archive.entries);
 const viewTimings={archiveMs:inflated-start,xmlValidationMs:performance.now()-inflated};
 const {size,slidePaths}=archive.readPresentation();
 const slides:Slide[]=slidePaths.map(path=>({path,elements:[],originalXml:'',bodyPrefix:'',bodySuffix:'',projectMindUnloaded:true} as DeferredSlide));
 const opened={archive,viewTimings,deck:{size,slides,originalHash:archive.originalHash}};
 const seed=model?.coverage&&model.originalHash===archive.originalHash?model.slides[0]:undefined;
 // The seed crosses only the trusted engine/renderer DTO boundary. Its raw anchors are needed by upstream edits.
 if(seed&&seed.path===slidePaths[0]&&typeof (seed as Slide).originalXml==='string')slides[0]=structuredClone(seed) as Slide;
 else if(slides.length)materializeViewSlide(opened,0);
 return opened;
}

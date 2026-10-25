/** Same local generation stages as the pinned GenOffice CLI. No network or file-system input. */
import {parseDeckSpec,buildDeckPptx} from './vendor/packages/pipelines/src/slides/deck-spec';
import {HeuristicMetrics,imageSizeFromBytes} from '@genoffice/pptx-render';
import {openPptx,savePptx,type OpenedPptx} from '@genoffice/pptx-engine';
import {runTxn,opNames,type Op} from './vendor/packages/pptx-ops/src/ops';
import {stableIds} from './parity-session';
import {assertZipInflatesWithinLimits} from './vendor/packages/zip-gate/src';
import {CANDIDATE_MAX_BYTES,CANDIDATE_ZIP_LIMITS} from './parity-candidate';
import {validateText} from './validate';
import type {PptxCreationContent} from './types';

/** Exact top-level payload names of the pinned op vocabulary (including byte operations). */
export const creationOperationFields:Readonly<Record<string,string>> = {
 addElement:'kind offset paragraphs fill stroke adjustments bodyPr',
 addConnector:'from to kind fromSide toSide arrow line',
 addPicture:'bytes ext offset name descr',replacePicture:'bytes ext keepSrcRect',
 addTable:'rows cols offset colWidthsEmu rowHeightsEmu cellProps',
 addChart:'kind categories series offset title colorScheme holeSizePct barDir',
 addSmartArt:'layout items offset',addMedia:'kind bytes ext offset name poster',addModel3d:'bytes ext offset name poster',
 pasteElements:'items dx dy',
 setText:'paragraphs',setFont:'font',setParagraphFormat:'format',
 insertEquation:'latex position box',
 setTableCell:'row col paragraphs',tableMerge:'kind row col',tableStructure:'kind index before',
 setTableRowHeight:'row hEmu',setTableCellAnchor:'row col anchor',setTableColWidth:'col wEmu',
 setTableStyle:'styleName styleId firstRow lastRow firstCol lastCol bandRow bandCol keepFormatting shadingColor borderColor borderWidthPt borderPreset',setChart:'patch',
 setSlideSize:'cx cy',findReplace:'find replace matchCase firstOnly slideIndex elementId',applyHeaderFooter:'settings',setSections:'sections',
 applyTheme:'name colors majorFont minorFont',addSection:'atSlideIndex name',renameSection:'id name',removeSection:'id',moveSection:'id dir',
 deleteSlide:'',duplicateSlide:'clearText',addBlankSlide:'',addSlideWithLayout:'layout',pasteSlide:'afterIndex bundle png mode',insertSlidePptx:'source at replace',moveSlide:'to',setSlideLayout:'layout layoutPath',
 setBackground:'kind color from to angleDeg radial hidden source tile',setHidden:'hidden',setTransition:'kind',setAdvanceTime:'ms',setAnimations:'items',
 addAnimation:'effect kind trigger duration delay direction paragraph motionPath presetXml after',removeAnimation:'seq',reorderAnimation:'seq to',
 setNotes:'text',addComment:'text author',deleteComment:'authorId idx',deleteElement:'',setFill:'fill',setStroke:'stroke',
 setTransform:'box absBox rotDeg resizeTableGrid',setConnectorEndpoints:'p1 p2 start end',flipElements:'els axis',setPictureSrcRect:'srcRect box',setRedaction:'label',setPictureOpacity:'opacity',
 reorderElement:'dir',groupElements:'els',ungroupElement:'',setShapeGeometry:'prst',setShapeAdjust:'adjust',setShapeCustomGeometry:'path',
 setTextAnchor:'anchor',setTextBodyProps:'props',setEffects:'effects',setLink:'link',alignElements:'els mode to',distributeElements:'els axis to',setImageFill:'source tile',
};
const shapes=new Set('rect roundRect ellipse triangle rightArrow leftArrow upArrow downArrow chevron diamond parallelogram trapezoid hexagon pentagon pie donut star5 heart cloud line lineArrow'.split(' '));
const chartKinds=new Set('bar bar3D barStacked barPercentStacked line area pie pie3D doughnut scatter radar comboBarLine'.split(' '));
const diagramLayouts=new Set('list process cycle hierarchy pyramid matrix venn'.split(' '));
const own=(o:object,k:string)=>Object.prototype.hasOwnProperty.call(o,k);
function object(v:unknown,where:string):Record<string,any>{if(!v||Object.getPrototypeOf(v)!==Object.prototype)throw new Error(`${where}: expected a JSON object`);return v as Record<string,any>}
function keys(o:Record<string,any>,fields:string,where:string){const allowed=new Set(fields.split(' '));for(const k of Object.keys(o))if(!allowed.has(k))throw new Error(`${where}: unsupported field ${k}`)}
function number(v:unknown,min:number,max:number,where:string){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(`${where}: expected number in ${min}..${max}`)}
function color(v:unknown,where:string){if(typeof v!=='string'||!/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/.test(v))throw new Error(`${where}: expected #RRGGBB or #RRGGBBAA`)}
function choice(v:unknown,values:readonly string[],where:string){if(typeof v!=='string'||!values.includes(v))throw new Error(`${where}: unsupported value ${String(v)}`)}
function bool(v:unknown,where:string){if(typeof v!=='boolean')throw new Error(`${where}: expected boolean`)}
function string(v:unknown,max:number,where:string){if(typeof v!=='string'||v.length>max)throw new Error(`${where}: expected text up to ${max} characters`);validateText(v)}

function paragraphs(value:unknown,where:string){
 if(!Array.isArray(value)||!value.length||value.length>256)throw new Error(`${where}: expected 1..256 paragraphs`);
 for(const [i,p] of value.entries()){
  const at=`${where}[${i}]`,r=object(p,at);keys(r,'runs align lineSpacingPct spaceBeforePt spaceAfterPt bullet',at);
  if(!Array.isArray(r.runs)||!r.runs.length||r.runs.length>256)throw new Error(`${at}: expected 1..256 runs`);
  for(const [j,v] of r.runs.entries()){
   const atRun=`${at}.runs[${j}]`,run=object(v,atRun);keys(run,'text sizePt bold italic color font',atRun);string(run.text,4000,`${atRun}.text`);
   if(own(run,'sizePt'))number(run.sizePt,6,160,`${atRun}.sizePt`);
   for(const key of ['bold','italic'])if(own(run,key))bool(run[key],`${atRun}.${key}`);
   if(own(run,'color'))color(run.color,`${atRun}.color`);
   if(own(run,'font')){string(run.font,80,`${atRun}.font`);if(!run.font.trim()||run.font.trim()!==run.font)throw new Error(`${atRun}.font: expected a nonempty trimmed font name`)}
  }
  if(own(r,'align'))choice(r.align,['left','center','right','justify'],`${at}.align`);
  if(own(r,'lineSpacingPct'))number(r.lineSpacingPct,60,300,`${at}.lineSpacingPct`);
  for(const k of ['spaceBeforePt','spaceAfterPt'])if(own(r,k))number(r[k],0,96,`${at}.${k}`);
  if(own(r,'bullet'))bool(r.bullet,`${at}.bullet`);
 }
}

function inlineImage(url:unknown):{bytes:Uint8Array;ext:string}{
 if(typeof url!=='string')throw new Error('PPTX images must use an inline base64 data URL');
 const m=/^data:image\/(png|jpeg|gif|webp|bmp|tiff);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
 if(!m)throw new Error('PPTX images must use a supported inline base64 data URL; paths and remote URLs are unavailable');
 const bytes=new Uint8Array(Buffer.from(m[2],'base64'));
 if(!bytes.length||Buffer.from(bytes).toString('base64')!==m[2])throw new Error('Invalid canonical image base64');
 const dims=imageSizeFromBytes(bytes);
 if(!dims||dims.w<=0||dims.h<=0||dims.w*dims.h>100_000_000)throw new Error('Unsupported image bytes or image pixel budget exceeded');
 return {bytes,ext:({jpeg:'jpg',tiff:'tif'} as Record<string,string>)[m[1]]??m[1]};
}
function boundedJson(value:unknown,budget={nodes:0},depth=0):void{
 if(++budget.nodes>100000||depth>32)throw new Error('PPTX creation JSON budget exceeded');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='string'){validateText(value);return}
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(Array.isArray(value)){value.forEach(v=>boundedJson(v,budget,depth+1));return}
 const obj=object(value,'PPTX creation JSON');for(const [k,v] of Object.entries(obj)){if(['__proto__','constructor','prototype'].includes(k))throw new Error(`Unsupported JSON key ${k}`);boundedJson(v,budget,depth+1)}
}
function validatePages(value:unknown):asserts value is PptxCreationContent{
 const content=object(value,'content');keys(content,'pages operations','content');
 if(!Array.isArray(content.pages)||!content.pages.length||content.pages.length>60)throw new Error('PPTX creation needs 1..60 pages');
 for(const [pi,raw] of content.pages.entries()){
  const at=`pages[${pi}]`,page=object(raw,at);keys(page,'background elements',at);if(own(page,'background'))color(page.background,`${at}.background`);
  if(!Array.isArray(page.elements)||!page.elements.length||page.elements.length>48)throw new Error(`${at}: expected 1..48 elements`);
  let images=0;
  for(const [ei,rawEl] of page.elements.entries()){
   const where=`${at}.elements[${ei}]`,el=object(rawEl,where);
   const extra=el.type==='text'?'paragraphs valign':el.type==='shape'?'shape fill stroke paragraphs valign flipH flipV':el.type==='image'?'url':null;
   if(extra===null)throw new Error(`${where}: unsupported element type ${el.type}`);
   keys(el,`type x y w h ${extra}`,where);
   number(el.x,0,1279,`${where}.x`);number(el.y,0,719,`${where}.y`);number(el.w,1,1280-el.x,`${where}.w`);number(el.h,1,720-el.y,`${where}.h`);
   if(own(el,'valign'))choice(el.valign,['top','middle','bottom'],`${where}.valign`);
   if(el.type==='image'){if(++images>8)throw new Error(`${at}: at most 8 images`);inlineImage(el.url)}
   else {
    if(el.type==='shape'){
     if(!shapes.has(el.shape))throw new Error(`${where}: unsupported shape ${el.shape}`);
     if(own(el,'fill'))color(el.fill,`${where}.fill`);
     if(own(el,'stroke')){const stroke=object(el.stroke,`${where}.stroke`);keys(stroke,'color widthPt',`${where}.stroke`);color(stroke.color,`${where}.stroke.color`);number(stroke.widthPt,0.25,24,`${where}.stroke.widthPt`)}
     for(const k of ['flipH','flipV'])if(own(el,k))bool(el[k],`${where}.${k}`);
     if(!own(el,'fill')&&!own(el,'stroke')&&!['line','lineArrow'].includes(el.shape))throw new Error(`${where}: shape needs a fill or stroke`);
    }
    if(el.type==='text'||own(el,'paragraphs')){paragraphs(el.paragraphs,`${where}.paragraphs`);if(!el.paragraphs.some((p:any)=>p.runs.some((r:any)=>r.text.trim())))throw new Error(`${where}: expected nonempty text`)}
   }
  }
 }
 if(own(content,'operations')&&(!Array.isArray(content.operations)||content.operations.length>1024))throw new Error('Expected at most 1024 creation operations');
}

function resolveRefs(value:any,aliases:Map<string,string>):any{
 if(Array.isArray(value))return value.map(v=>resolveRefs(v,aliases));
 if(value&&typeof value==='object'){
  if(own(value,'$ref')){keys(value,'$ref','creation reference');const id=aliases.get(value.$ref);if(!id)throw new Error(`Unknown PPTX creation reference ${value.$ref}`);return id}
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveRefs(v,aliases)]));
 }
 return value;
}
function validateOpMedia(value:any,key=''){
 if(typeof value==='string'&&key==='bytes'){
  if(value.startsWith('data:')){
   // Ops can also embed audio/video/model bytes; canonical base64 is required for every byte input.
   const m=/^data:[A-Za-z0-9.+/-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
   if(!m||Buffer.from(m[1],'base64').toString('base64')!==m[1])throw new Error('Invalid inline media data URL');
  }else if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||Buffer.from(value,'base64').toString('base64')!==value)throw new Error('PPTX operation bytes must be canonical base64, never a path or URL');
 }
 if(Array.isArray(value))value.forEach(v=>validateOpMedia(v));else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))validateOpMedia(v,k);
}

/** Shared data-op authority for new decks and fixed-baseline existing-file edits. */
export function applyCreationOperations(opened:OpenedPptx,operations:unknown):void{
 boundedJson(operations);
 if(!Array.isArray(operations)||operations.length>1024||Buffer.byteLength(JSON.stringify(operations),'utf8')>2*1024*1024)throw new Error('PPTX operations exceed the 1024-operation / 2 MiB budget');
 stableIds(opened);const aliases=new Map<string,string>();
 const names=new Set(opNames());
 for(const [index,step] of operations.entries()){
  const at=`operations[${index}]`,raw=object(step,at);keys(raw,'op as',at);
  if(own(raw,'as')&&(typeof raw.as!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.as)||aliases.has(raw.as)))throw new Error(`${at}: alias must be unique and use 1..64 ASCII identifier characters`);
  const original=object(raw.op,`${at}.op`),name=original.op;
  if(typeof name!=='string'||!own(creationOperationFields,name)||!names.has(name))throw new Error(`${at}: unsupported native operation ${name}`);
  keys(original,`op target group ${creationOperationFields[name]}`,`${at}.op`);
  if(original.target!==undefined){const target=object(original.target,`${at}.op.target`);keys(target,'slide el part',`${at}.op.target`)}
  validateOpMedia(original);
  const op=resolveRefs(original,aliases) as Op;
  if(op.op==='addChart'){
   if(!chartKinds.has(op.kind as string))throw new Error(`${at}: unsupported chart kind ${op.kind}`);
   const categories=op.categories;
   if(!Array.isArray(categories)||categories.some(c=>typeof c!=='string')||!Array.isArray(op.series)||op.series.some(s=>{const r=object(s,`${at}.series`);keys(r,'name values',`${at}.series`);return typeof r.name!=='string'||!Array.isArray(r.values)||r.values.length!==categories.length||r.values.some((n:unknown)=>typeof n!=='number'||!Number.isFinite(n))}))throw new Error(`${at}: chart series values must be finite and match category count`);
  }
  if(op.op==='addSmartArt'&&!diagramLayouts.has(op.layout as string))throw new Error(`${at}: unsupported SmartArt layout`);
  const transaction=runTxn(opened,{ops:[op],isolation:'atomic'});
  if(!transaction.applied||transaction.failures?.length)throw new Error(`${at}: ${transaction.failures?.map(f=>f.error).join('; ')??'native operation was not applied'}`);
  const remapped=stableIds(opened);
  if(raw.as){const created=transaction.records?.[0]?.created;if(created?.length!==1)throw new Error(`${at}: alias requires an operation that creates exactly one element`);aliases.set(raw.as,remapped.get(created[0])??created[0])}
  if(opened.deck.slides.length<1||opened.deck.slides.length>60||opened.deck.slides.reduce((sum,s)=>sum+s.elements.length,0)>10000)throw new Error('PPTX creation slide/element budget exceeded');
 }
}

/** Public data-only create: original GenOffice spec builder followed by its authoritative native ops. */
export async function create(content:unknown,_context?:unknown):Promise<Uint8Array>{
 boundedJson(content);const serialized=JSON.stringify(content);
 if(Buffer.byteLength(serialized,'utf8')>2*1024*1024)throw new Error('PPTX creation content exceeds 2 MiB');
 validatePages(content);
 const parsed=parseDeckSpec(JSON.stringify({pages:content.pages}),{localImages:true});
 if(!parsed.ok)throw new Error(parsed.error);
 const errors=parsed.issues.filter(i=>i.error);if(errors.length)throw new Error(errors.map(i=>`page ${i.page}: ${i.error}`).join('; '));
 // Strict prevalidation forbids all clamping/truncation; upstream warnings now only advise on duplicate text.
 if(parsed.spec.pages.some((p,i)=>p.elements.length!==content.pages[i].elements.length))throw new Error('PPTX spec would drop an element');
 const result=await buildDeckPptx(parsed.spec,{fetchImage:async url=>inlineImage(url),imageDims:bytes=>{const size=imageSizeFromBytes(bytes);return size?{width:size.w,height:size.h}:null},fontMetrics:new HeuristicMetrics()});
 if(result.imageFailures.length)throw new Error(`PPTX could not embed images on pages ${result.imageFailures.map(x=>x.page).join(', ')}`);
 const opened=await openPptx(result.bytes);
 applyCreationOperations(opened,content.operations??[]);
 const bytes=await savePptx(opened);
 if(!bytes.length||bytes.length>CANDIDATE_MAX_BYTES)throw new Error('PPTX creation candidate exceeds 100 MiB');
 await assertZipInflatesWithinLimits(bytes,CANDIDATE_ZIP_LIMITS);
 return bytes;
}

/** Tool consumers share this exact data contract; no executable-code schema exists. */
const runSchema={type:'object',additionalProperties:false,required:['text'],properties:{
 text:{type:'string',maxLength:4000},sizePt:{type:'number',minimum:6,maximum:160},bold:{type:'boolean'},italic:{type:'boolean'},color:{type:'string',pattern:'^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$'},font:{type:'string',minLength:1,maxLength:80},
}};
const paragraphSchema={type:'object',additionalProperties:false,required:['runs'],properties:{
 runs:{type:'array',minItems:1,maxItems:256,items:runSchema},align:{enum:['left','center','right','justify']},lineSpacingPct:{type:'number',minimum:60,maximum:300},spaceBeforePt:{type:'number',minimum:0,maximum:96},spaceAfterPt:{type:'number',minimum:0,maximum:96},bullet:{type:'boolean'},
}};
const paragraphsSchema={type:'array',minItems:1,maxItems:256,items:paragraphSchema};
const frameSchema={x:{type:'number',minimum:0,maximum:1279},y:{type:'number',minimum:0,maximum:719},w:{type:'number',minimum:1,maximum:1280},h:{type:'number',minimum:1,maximum:720}};
const valign={enum:['top','middle','bottom']};
export const creationSchema={type:'object',additionalProperties:false,required:['pages'],properties:{
 pages:{type:'array',minItems:1,maxItems:60,items:{type:'object',additionalProperties:false,required:['elements'],properties:{background:{type:'string',pattern:'^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$'},elements:{type:'array',minItems:1,maxItems:48,items:{oneOf:[
  {type:'object',additionalProperties:false,required:['type','x','y','w','h','paragraphs'],properties:{type:{const:'text'},...frameSchema,paragraphs:paragraphsSchema,valign}},
  {type:'object',additionalProperties:false,required:['type','shape','x','y','w','h'],properties:{type:{const:'shape'},...frameSchema,shape:{enum:[...shapes]},fill:{type:'string'},stroke:{type:'object',additionalProperties:false,required:['color','widthPt'],properties:{color:{type:'string'},widthPt:{type:'number',minimum:0.25,maximum:24}}},paragraphs:paragraphsSchema,valign,flipH:{type:'boolean'},flipV:{type:'boolean'}}},
  {type:'object',additionalProperties:false,required:['type','x','y','w','h','url'],properties:{type:{const:'image'},...frameSchema,url:{type:'string',description:'Inline data:image/png;base64,... or data:image/jpeg;base64,...; paths and remote URLs are refused.'}}},
 ]}}}}},
 operations:{type:'array',maxItems:1024,description:'Native GenOffice ops run sequentially. All op geometry is document-space EMU, not spec pixels. Each as alias names the one newly created element; {$ref:"alias"} in later ops resolves to its stable ID.',items:{type:'object',additionalProperties:false,required:['op'],properties:{as:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,63}$'},op:{oneOf:Object.entries(creationOperationFields).map(([name,fields])=>({type:'object',additionalProperties:false,required:['op'],properties:{op:{const:name},target:{type:'object',additionalProperties:false,properties:{slide:{description:'Zero-based slide index or stable slide ID'},el:{description:'Stable element ID or {$ref:"alias"}'},part:{type:'string',description:'Existing master/layout part inside this package; never a file-system path'}}},group:{description:'Group ID or {$ref:"alias"}'},...Object.fromEntries(fields.split(' ').filter(Boolean).map(key=>[key,{description:`Pinned GenOffice ${name}.${key}; see the upstream op guide.`}]))}}))}}}},
}} as const;

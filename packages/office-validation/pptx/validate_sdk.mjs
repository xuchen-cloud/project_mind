import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
import {importFile,importFileToSnapshot,exportToBuffer,exportSnapshotToBuffer,ExchangeFormat} from '@univerjs-pro/exchange-node';
import {UniverInstanceType} from '@univerjs/core';
const require=createRequire(import.meta.url); const root=path.dirname(fileURLToPath(import.meta.url));
const options={type:UniverInstanceType.UNIVER_SLIDE,format:ExchangeFormat.PPTX};
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const write=(name,v)=>fs.writeFile(path.join(root,name),JSON.stringify(v,null,2));
const pkgVersion=name=>JSON.parse(require('node:fs').readFileSync(path.join(root,'../node_modules',name,'package.json'))).version;
const report={issue:118,package:'F03',format:'pptx',startedAt:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,arch:process.arch,exchange:pkgVersion('@univerjs-pro/exchange-node'),binding:pkgVersion('@univerjs-pro/exchange-node-binding'),slides:pkgVersion('@univerjs-pro/slides'),core:pkgVersion('@univerjs/core')},license:{injected:false,bypassed:false,credentialOutput:false},samples:{}};
function bodyText(e){return e.shapeData?.shapeText?.dataModel?.doc?.body?.dataStream ?? e.textData?.body?.dataStream ?? e.text ?? '';}
function summary(unit){return {unitId:unit.id,slideOrder:unit.slideOrder,pageSize:unit.defaultPageSize,masterPageOrder:unit.masterPageOrder,layoutPageOrder:unit.layoutPageOrder,resources:(unit.resources??[]).map(r=>({name:r.name,dataBytes:Buffer.byteLength(r.data??'')})),slides:unit.slideOrder.map(sid=>{const s=unit.slides[sid];return {id:sid,layoutPageId:s.layoutPageId,masterPageId:s.masterPageId,speakerNotes:s.speakerNotes??null,elements:s.elementOrder.map(id=>{const e=s.elements[id];return {id,type:e.type,name:e.name,transform:e.transform,text:bodyText(e).replace(/\r\n$/,''),...(e.source?{imageSourceBytes:e.source.length,imageSourceSha256:hash(e.source)}:{}),...(e.tableId?{tableId:e.tableId}:{}),...(e.chartId?{chartId:e.chartId}:{})};})};})};}
for(const kind of ['simple','complex']){
 const r={steps:[],checks:[],candidates:[]};report.samples[kind]=r;
 const src=path.join(root,`${kind}.original.pptx`);r.original={path:`${kind}.original.pptx`,sha256:hash(await fs.readFile(src))};
 const step=async(name,fn)=>{const t=performance.now();try{const v=await fn();r.steps.push({name,status:'passed',elapsedMs:+(performance.now()-t).toFixed(3)});return v;}catch(e){r.steps.push({name,status:'failed',elapsedMs:+(performance.now()-t).toFixed(3),error:{name:e.name,code:e.code??null,message:e.message}});throw e;}};
 try{
  const unit=await step('import_product',()=>importFile(src,options));await write(`${kind}.imported-unit.json`,unit);if(kind==='simple') await write('imported-unit.json',unit);
  r.importedSummary=summary(unit);await write(`${kind}.structure-summary.json`,r.importedSummary);
  const aggregate=await step('import_aggregate',()=>importFileToSnapshot(src,options));await write(`${kind}.aggregate.original.json`,aggregate);
  for(const [family,data,exporter] of [['product',unit,exportToBuffer],['aggregate',aggregate,exportSnapshotToBuffer]]){
   try {const buf=await step(`export_${family}_unchanged`,()=>exporter(data,options));const filename=`${kind}.${family}-unchanged.pptx`;await fs.writeFile(path.join(root,filename),buf);r.candidates.push({mode:`${family}-unchanged`,path:filename,bytes:buf.length,sha256:hash(buf)});const re=await step(`reimport_${family}_unchanged`,()=>importFile(path.join(root,filename),options));await write(`${kind}.${family}-unchanged.reimport.json`,re);}catch{}
  }
  const edited=structuredClone(unit);const sid=edited.slideOrder[0];const s=edited.slides[sid];
  const matches=s.elementOrder.map(id=>s.elements[id]).filter(e=>bodyText(e).includes(manifest.old_text));
  if(matches.length!==1) throw Error(`Expected one text target, found ${matches.length}`);
  const e=matches[0];const t=e.shapeData.shapeText;
  const loc={unitId:unit.id,slideId:sid,textElementId:e.id,textElementType:e.type,textPath:`slides.${sid}.elements.${e.id}.shapeData.shapeText`,dataStreamPath:`slides.${sid}.elements.${e.id}.shapeData.shapeText.dataModel.doc.body.dataStream`,before:bodyText(e),after:bodyText(e).replace(manifest.old_text,manifest.new_text)};
  t.dataModel.doc.body.dataStream=loc.after;
  if(typeof t.text==='string') t.text=t.text.replace(manifest.old_text,manifest.new_text);
  const images=s.elementOrder.map(id=>s.elements[id]).filter(e=>e.type==='image' && e.name==='validation-picture');
  if(images.length!==1) throw Error(`Expected one picture target, found ${images.length}`);
  const pic=images[0]; loc.imageElementId=pic.id;loc.imageTransformBefore=structuredClone(pic.transform);loc.imageDeltaPoints=manifest.picture_delta_emu/12700;pic.transform.left+=loc.imageDeltaPoints;loc.imageTransformAfter=structuredClone(pic.transform);
  r.editLocator=loc;await write(`${kind}.edit-locator.json`,loc);await write(`${kind}.edited-unit.json`,edited);
  const buf=await step('export_product_edited',()=>exportToBuffer(edited,options)); const out=path.join(root,`${kind}.edited.pptx`);await fs.writeFile(out,buf);r.candidates.push({mode:'edited',path:path.basename(out),bytes:buf.length,sha256:hash(buf)});
  const re=await step('reimport_product_edited',()=>importFile(out,options));await write(`${kind}.edited.reimport.json`,re);r.reimportSummary=summary(re);
  const reSlide=re.slides[re.slideOrder[0]];const reTexts=reSlide.elementOrder.map(id=>bodyText(reSlide.elements[id]));
  r.checks.push({name:'reimport_text_edit',passed:reTexts.some(t=>t.includes(manifest.new_text))&&!reTexts.some(t=>t.includes(manifest.old_text))});
  const rePic=reSlide.elementOrder.map(id=>reSlide.elements[id]).find(e=>e.type==='image');
  r.checks.push({name:'reimport_picture_position',passed:Math.abs(rePic.transform.left-pic.transform.left)<1e-7,expected:pic.transform.left,actual:rePic.transform.left});
  r.checks.push({name:'original_checksum_unchanged',passed:hash(await fs.readFile(src))===manifest.samples[kind].sha256});
  r.status=r.steps.every(s=>s.status==='passed')&&r.checks.every(c=>c.passed)?'conversion_passed_content_verification_pending':'failed';
 }catch(e){r.status='failed';r.error={name:e.name,code:e.code??null,message:e.message};}
 await write('sdk-results.json',report);console.log(JSON.stringify({kind,status:r.status,steps:r.steps,checks:r.checks,candidates:r.candidates,editLocator:r.editLocator}));
}
report.finishedAt=new Date().toISOString();await write('sdk-results.json',report);

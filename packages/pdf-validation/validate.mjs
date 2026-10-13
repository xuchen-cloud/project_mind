// Isolated validation only. Uses pinned installed libraries read-only; no app/UI runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(root,'../..');
const bundledModules=process.env.PDF_VALIDATION_BUNDLED_MODULES??'/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const python=process.env.PDF_VALIDATION_PYTHON??'/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const bundled=createRequire(path.join(bundledModules,'pdf-validation-entry.cjs'));
const installed=createRequire(path.join(repo,'package.json'));
const {default:DOMMatrix}=await import(pathToFileURL(installed.resolve('@thednp/dommatrix')).href);
globalThis.DOMMatrix=DOMMatrix;
const pdfjs=await import(pathToFileURL(installed.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const {PDFDocument,rgb,StandardFonts}=bundled('pdf-lib');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(name,value)=>fs.writeFile(path.join(root,name),JSON.stringify(value,null,2));
const report={issue:'#118/F03 PDF extension',node:process.version,node_executable:process.execPath,platform:process.platform,arch:process.arch,versions:{pdfjs:pdfjs.version,pdf_lib:bundled('pdf-lib/package.json').version},started:new Date().toISOString(),runs:[],runtime_warnings:[],gui:false};
const outputLog=console.log.bind(console);
console.log=(...items)=>{const message=items.map(String).join(' ');if(message.startsWith('Warning:'))report.runtime_warnings.push({library:'pdf.js',message});outputLog(...items);};
const readerVersion=spawnSync(python,['-c','import sys,json,pypdf; print(json.dumps({"library":"pypdf","version":pypdf.__version__,"python":sys.version.split()[0]}))'],{encoding:'utf8'});
if(readerVersion.status!==0)throw new Error(readerVersion.stderr);
report.independent_reader=JSON.parse(readerVersion.stdout);
for(const name of ['simple','complex']) {
 const original=path.join(root,`${name}.original.pdf`);const bytes=await fs.readFile(original);
 for(const family of ['pdfjs-form','pdflib-form']){
  const r={name,family,source_sha256:sha(bytes),status:'failed',timing_ms:{}};report.runs.push(r);
  try {
   const start=performance.now();let output;
   if(family==='pdfjs-form') {
    const packageDir=path.dirname(installed.resolve('pdfjs-dist/package.json'));
    const task=pdfjs.getDocument({data:Uint8Array.from(bytes),enableXfa:false,stopAtErrors:true,useSystemFonts:false,useWorkerFetch:false,cMapUrl:path.join(packageDir,'cmaps')+path.sep,cMapPacked:true,standardFontDataUrl:path.join(packageDir,'standard_fonts')+path.sep});
    try {
     const doc=await task.promise;const fields=await doc.getFieldObjects();
     if(!fields?.customer?.length||!fields?.approved?.length)throw new Error('Controlled form fields missing');
     r.field_targets=Object.fromEntries(Object.entries(fields).map(([name,items])=>[name,items.map(item=>({id:item.id,type:item.type,value:item.value,exportValues:item.exportValues}))]));
     for(const item of fields.customer)doc.annotationStorage.setValue(item.id,{value:'Bob'});
     for(const item of fields.approved)doc.annotationStorage.setValue(item.id,{value:true});
     output=await doc.saveDocument();
    }finally{await task.destroy();}
   }else{
    const doc=await PDFDocument.load(bytes,{updateMetadata:false});const form=doc.getForm();
    form.getTextField('customer').setText('Bob');form.getCheckBox('approved').check();
    output=await doc.save({useObjectStreams:false});
   }
   r.timing_ms.edit_save=performance.now()-start;
   r.output=path.join(root,`${name}.${family}.pdf`);await fs.writeFile(r.output,output);r.output_bytes=output.length;r.output_sha256=sha(output);
   const check=path.join(root,`${name}.${family}.checks.json`);const t=performance.now();
   const p=spawnSync(python,[path.join(root,'fixture.py'),'compare',original,r.output,check],{encoding:'utf8'});r.timing_ms.independent_reopen=performance.now()-t;
   if(p.status!==0)throw new Error(p.stderr.slice(0,1000));
   const result=JSON.parse(await fs.readFile(check,'utf8'));r.status=result.status;r.checks=check;r.failures=result.checks.filter(c=>!c.passed).map(c=>c.assertion);
  }catch(e){r.error={name:e.name,message:String(e.message).slice(0,1500)};}
  r.source_unchanged=sha(await fs.readFile(original))===r.source_sha256;
  console.log(JSON.stringify(r));await write('results.json',report);
 }
}
// Reproduce the documented WinAnsi limit; no custom-font workaround or silent field flattening.
try {
 const doc=await PDFDocument.load(await fs.readFile(path.join(root,'complex.original.pdf')),{updateMetadata:false});doc.getForm().getTextField('customer').setText('中文填写');
 const bytes=await doc.save({useObjectStreams:false});await fs.writeFile(path.join(root,'complex.cjk-default-font.pdf'),bytes);
 report.cjk_default_font={status:'exported-unverified',note:'Default-font CJK must be independently verified before claiming support'};
}catch(e){report.cjk_default_font={status:'failed',name:e.name,message:String(e.message),scope:'pdf-lib default appearance font only; custom CJK font embedding not tested'};}
// Controlled coverage counterexample: a painted rectangle is not a deletion of source text.
const overlay=await PDFDocument.load(await fs.readFile(path.join(root,'simple.original.pdf')),{updateMetadata:false});
const page=overlay.getPages()[0];const font=await overlay.embedFont(StandardFonts.Helvetica);
page.drawRectangle({x:48,y:715,width:350,height:20,color:rgb(1,1,1)});
page.drawText('REPLACEMENT VISUAL LAYER',{x:50,y:720,font,size:12,color:rgb(0,0,0)});
const output=await overlay.save({useObjectStreams:false});const overlayPath=path.join(root,'simple.overlay-counterexample.pdf');await fs.writeFile(overlayPath,output);
const p=spawnSync(python,[path.join(root,'fixture.py'),'inspect',overlayPath],{encoding:'utf8'});
if(p.status!==0)throw new Error(p.stderr);
const independent=JSON.parse(p.stdout);await write('overlay.checks.json',independent);
const text=independent.pages.map(p=>p.text).join('\n');report.overlay={status:'limited',output:overlayPath,sha256:sha(output),original_text_still_extractable:text.includes('ORIGINAL BODY MUST REMAIN'),replacement_text_extractable:text.includes('REPLACEMENT VISUAL LAYER'),note:'This is a visual cover/add operation. It does not edit or remove the original page text.'};
report.finished=new Date().toISOString();report.status=report.runs.every(r=>r.status==='passed'&&r.source_unchanged)?'limited':'failed';
report.not_verified=['GenOffice PDFium text editing runtime','PDF.js annotation editor GUI','CJK field appearance with custom font','visual fidelity','Tauri/WebView','File CAS/version integration'];
await write('results.json',report);
console.log(JSON.stringify({status:report.status,cjk_default_font:report.cjk_default_font,overlay:report.overlay}));

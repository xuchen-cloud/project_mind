// Calls the unmodified upstream public core. No Electron, GUI, fake FPDF APIs or font shims.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const scratch=process.env.GENOFFICE_PDF_SCRATCH??'/tmp/project-mind-genoffice-pdf-validation-20261013';
const python=process.env.GENOFFICE_PDF_PYTHON??'/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const req=createRequire(path.join(scratch,'package.json'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const save=()=>fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));
const report={issue:'#118 PDF original text runtime',sha:'d32d1711f1bf985430757b8c6b3fbddd3831d946',node:process.version,node_executable:process.execPath,platform:process.platform,arch:process.arch,gui:false,native_build:false,started:new Date().toISOString(),versions:{},runs:[],warnings:[],not_verified:['Tauri/WebView GUI','File CAS','Complete save-pdf private verifyContentEdits integration','Universal lossless PDF editing']};
const out=console.log.bind(console),warn=console.warn.bind(console);
console.warn=(...args)=>{report.warnings.push(args.map(String).join(' '));warn(...args);};
for(const name of ['@embedpdf/pdfium','harfbuzzjs','pdf-lib','esbuild']){
 const p=path.join(scratch,'node_modules',name,'package.json');report.versions[name]=JSON.parse(await fs.readFile(p,'utf8')).version;
}
const assets=[req.resolve('@embedpdf/pdfium/pdfium.wasm'),req.resolve('harfbuzzjs/hb-subset.wasm')];
report.wasm=await Promise.all(assets.map(async p=>({path:p,bytes:(await fs.stat(p)).size,sha256:hash(await fs.readFile(p))})));
await fs.copyFile(path.join(scratch,'package-lock.json'),path.join(root,'dependency.lock.json'));
await fs.copyFile(path.join(scratch,'generated/metafile.json'),path.join(root,'build-inputs.json'));
const manifest=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8'));
let core;
try{
 const start=performance.now();core=await import(pathToFileURL(path.join(scratch,'generated/core.mjs')).href);const m=await core.loadPdfium();
 report.initialization={status:'passed',timing_ms:performance.now()-start,required_exports:Object.fromEntries(['_FPDFText_SetText','_FPDFPage_RemoveObject','_FPDFPage_InsertObject','_FPDFPage_GenerateContent','_PDFiumExt_SaveAsCopy'].map(k=>[k,typeof m[k]]))};
}catch(e){report.initialization={status:'failed',error:{name:e.name,message:String(e.message),stack:e.stack}};report.status='failed';await save();throw e;}
await save();
for(const [name,fixture] of Object.entries(manifest)){
 const row={name,target:fixture.target,font_override:false,status:'failed',timing_ms:{}};report.runs.push(row);await save();
 const original=path.join(root,`${name}.original.pdf`);const bytes=await fs.readFile(original);row.source_sha256=hash(bytes);
 try{
  let t=performance.now();row.validation=await core.validateTextEdits(Uint8Array.from(bytes),[fixture.target]);row.timing_ms.validate=performance.now()-t;
  t=performance.now();const result=await core.applyTextEdits(Uint8Array.from(bytes),[fixture.target]);row.timing_ms.apply=performance.now()-t;row.skipped=result.skipped;
  row.output=path.join(root,`${name}.core-edited.pdf`);await fs.writeFile(row.output,result.bytes);row.output_bytes=result.bytes.length;row.output_sha256=hash(result.bytes);
  t=performance.now();row.engine_verification=await core.verifyTextEdits(result.bytes,[{pageIndex:fixture.target.pageIndex,newText:fixture.target.newText}]);row.timing_ms.verify=performance.now()-t;
  row.checks=path.join(root,`${name}.core-edited.checks.json`);t=performance.now();const p=spawnSync(python,[path.join(root,'fixture.py'),'compare',name,row.output,row.checks],{encoding:'utf8',timeout:60000});row.timing_ms.independent_pypdf=performance.now()-t;
  row.independent_exit=p.status;if(p.status!==0)throw new Error(p.stderr||String(p.error));
  const independent=JSON.parse(await fs.readFile(row.checks,'utf8'));row.independent_status=independent.status;row.failures=independent.checks.filter(c=>!c.passed).map(c=>c.assertion);
  row.output_fonts=independent.candidate.pages[0].fonts;
  row.status=!result.skipped.length&&!row.engine_verification.length&&independent.status==='passed'&&row.validation.every(v=>!v.reason)?'passed':'failed';
  if(name==='complex'){
   const font=core.fallbackFontFor(fixture.target.newText);row.default_fallback_font={available:!!font,bytes:font?.length,sha256:font?hash(font):null,note:'Actual upstream default fallbackFontFor probe; no override injected. Candidate embedded fonts recorded separately.'};
  }
 }catch(e){row.error={name:e.name,message:String(e.message),stack:e.stack};}
 row.source_unchanged=hash(await fs.readFile(original))===row.source_sha256;
 if(!row.source_unchanged)row.status='failed';
 out(JSON.stringify({name,status:row.status,skipped:row.skipped,error:row.error?.message,failures:row.failures,timing_ms:row.timing_ms,output:row.output,sha256:row.output_sha256}));await save();
}
const bad={...manifest.simple.target,oldText:'CONTROLLED MISSING SOURCE TEXT'};
try{
 const bytes=await fs.readFile(path.join(root,'simple.original.pdf'));const validation=await core.validateTextEdits(Uint8Array.from(bytes),[bad]);const result=await core.applyTextEdits(Uint8Array.from(bytes),[bad]);
 const p=path.join(root,'simple.mismatch-candidate.pdf');await fs.writeFile(p,result.bytes);
 report.controlled_mismatch={status:result.skipped.length===1?'passed':'failed',validation,skipped:result.skipped,output:p,sha256:hash(result.bytes),source_unchanged:hash(await fs.readFile(path.join(root,'simple.original.pdf')))===hash(bytes),note:'Guard check only; skipped replacement is never counted as successful content editing.'};
}catch(e){report.controlled_mismatch={status:'limited',error:String(e.message)};}
report.memory=process.memoryUsage();report.finished=new Date().toISOString();report.status=report.runs.every(r=>r.status==='passed')?'limited':'failed';await save();
out(JSON.stringify({status:report.status,initialization:report.initialization,controlled_mismatch:report.controlled_mismatch}));

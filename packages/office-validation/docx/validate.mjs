import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const python=process.env.OFFICE_VALIDATION_PYTHON || 'python3';
const mode=process.argv.includes('--traditional')?'traditional':process.argv.includes('--modern')?'modern':'default';
const suffix=mode==='default'?'':'.'+mode;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(name,value)=>fs.writeFile(path.join(root,name),JSON.stringify(value,null,2));
const report={issue:'#118/F03',format:'docx',mode,started:new Date().toISOString(),platform:{node:process.version,platform:process.platform,arch:process.arch},versions:{},cases:[],gui:'not-tested',license:'No runtime bypass; no credential provided or printed'};
for(const name of ['@univerjs-pro/exchange-node','@univerjs-pro/exchange-node-binding','@univerjs/core','@univerjs-pro/collaboration']){
 const p=path.resolve(root,'../node_modules',name,'package.json');report.versions[name]=JSON.parse(await fs.readFile(p,'utf8')).version;
}
const start=performance.now();
const exchange=await import('@univerjs-pro/exchange-node');
const {UniverInstanceType}=await import('@univerjs/core');
report.module_import_ms=performance.now()-start;
const fixtures=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8'));
function describe(unit){
 const b=unit.body;
 return {keys:Object.keys(unit),body_keys:Object.keys(b??{}),dataStream_length:b?.dataStream?.length,
  paragraph_count:b?.paragraphs?.length,table_ranges:b?.tables,section_breaks:b?.sectionBreaks,
  table_source_keys:Object.keys(unit.tableSource??{}),header_keys:Object.keys(unit.headers??{}),footer_keys:Object.keys(unit.footers??{}),drawing_keys:Object.keys(unit.drawings??{})};
}
function replaceTarget(unit,target,kind){
 const stream=unit.body.dataStream;const i=stream.indexOf(target.before);
 if(i<0 || stream.indexOf(target.before,i+1)>=0)throw new Error(`Unique ${kind} target missing`);
 if(target.before.length!==target.after.length)throw new Error('Only same UTF-16 length edits are tested');
 const paragraph=unit.body.paragraphs.find(p=>p.startIndex>=i+target.before.length);
 const table=unit.body.tables?.find(t=>i>=t.startIndex&&i<t.endIndex);
 if(kind==='table_cell'&&!table)throw new Error('Cell target is outside a table range');
 unit.body.dataStream=stream.slice(0,i)+target.after+stream.slice(i+target.before.length);
 return {kind,path:'body.dataStream',start_utf16:i,end_utf16:i+target.before.length,before:target.before,after:target.after,
  paragraph_id:paragraph?.paragraphId,paragraph_end:paragraph?.startIndex,table_id:table?.tableId,row:target.row,column:target.column};
}
for(const name of ['simple','complex']){
 const original=path.join(root,`${name}.original.docx`);const input=await fs.readFile(original);
 const opts={type:UniverInstanceType.UNIVER_DOC,format:exchange.ExchangeFormat.DOCX,fileName:path.basename(original)};
 if(mode==='modern')opts.compatibilityMode=exchange.DocxCompatibilityMode.MODERN;
 if(mode==='traditional')opts.compatibilityMode=exchange.DocxCompatibilityMode.TRADITIONAL;
 const exports={type:UniverInstanceType.UNIVER_DOC,format:exchange.ExchangeFormat.DOCX};
 for(const family of ['aggregate-noop','unit-noop','unit-edited']){
  const c={name,family,source_sha256:sha(input),timings_ms:{},status:'failed'};report.cases.push(c);
  try{
   let t=performance.now();
   const value=await (family.startsWith('aggregate')?exchange.importBufferToSnapshot:exchange.importBuffer)(input,opts);
   c.timings_ms.import=performance.now()-t;
   if(family==='unit-noop'){
    c.structure=describe(value);
    await write(`${name}${suffix}.imported-unit.json`,value);
    if(name==='simple'&&mode==='traditional')await write('imported-unit.json',value);
   }
   if(family==='aggregate-noop'){
    c.structure={keys:Object.keys(value),snapshot_keys:Object.keys(value.snapshot),doc_keys:Object.keys(value.snapshot.doc??{}),sheetBlocks_count:value.sheetBlocks.length};
    await write(`${name}${suffix}.imported-aggregate.json`,value);
   }
   if(family==='unit-edited'){
    c.edit_targets=[replaceTarget(value,fixtures.edit_targets.paragraph,'paragraph'),replaceTarget(value,fixtures.edit_targets.table_cell,'table_cell')];
    await write(`${name}${suffix}.edited-unit.json`,value);
   }
   t=performance.now();const output=await (family.startsWith('aggregate')?exchange.exportSnapshotToBuffer:exchange.exportToBuffer)(value,exports);
   c.timings_ms.export=performance.now()-t;
   const file=`${name}${suffix}.${family}.docx`;c.output=file;await fs.writeFile(path.join(root,c.output),output);
   c.output_bytes=output.length;c.output_sha256=sha(output);
   t=performance.now();const reopened=await exchange.importBuffer(output,{...opts,fileName:file});c.timings_ms.reimport=performance.now()-t;
   await write(`${name}${suffix}.${family}.reopened-unit.json`,reopened);
   c.sdk_reopen={passed:!!reopened.body?.dataStream,edited_paragraph:family==='unit-edited'?reopened.body?.dataStream.includes(fixtures.edit_targets.paragraph.after):null,edited_cell:family==='unit-edited'?reopened.body?.dataStream.includes(fixtures.edit_targets.table_cell.after):null};
   const checkFile=path.join(root,`${name}${suffix}.${family}.checks.json`);
   t=performance.now();const check=spawnSync(python,[path.join(root,'fixture.py'),'compare',original,path.join(root,c.output),family==='unit-edited'?'edited':'noop',checkFile],{encoding:'utf8'});
   c.timings_ms.independent_check=performance.now()-t;
   if(check.status!==0)throw new Error(`Independent Python reopen failed: ${check.stderr.slice(0,1000)}`);
   const result=JSON.parse(await fs.readFile(checkFile,'utf8'));
   c.independent_check_file=path.basename(checkFile);c.assertions=result.checks.map(x=>({assertion:x.assertion,passed:x.passed}));
   c.failed_assertions=c.assertions.filter(x=>!x.passed).map(x=>x.assertion);
   c.status=result.status==='passed'&&c.sdk_reopen.passed&&c.sdk_reopen.edited_paragraph!==false&&c.sdk_reopen.edited_cell!==false?'passed':'failed';
  }catch(error){c.error={name:error.name,code:error.code??null,message:String(error.message).slice(0,1500)};}
  await write(`results${suffix}.json`,report);
  console.log(JSON.stringify({name,family,mode,status:c.status,timings_ms:c.timings_ms,failed_assertions:c.failed_assertions,error:c.error,edit_targets:c.edit_targets}));
 }
}
report.finished=new Date().toISOString();report.maxRSS_bytes=process.resourceUsage().maxRSS*1024;
report.total_after_modules_ms=performance.now()-start;report.status=report.cases.every(x=>x.status==='passed')?'passed':'failed';
await write(`results${suffix}.json`,report);

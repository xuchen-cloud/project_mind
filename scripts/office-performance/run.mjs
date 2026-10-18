import {readFile,writeFile,mkdir,open,rm,readdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {generateFixtures} from './fixtures.mjs';
import {startServer} from './server.mjs';
import {installObservers,contentProbe,modeProbe,interactionProbe} from './probes.mjs';
const root=resolve(import.meta.dirname,'../..');
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');if(!a.startsWith('--')||i<0)throw Error('Use --name=value');return [a.slice(2,i),a.slice(i+1)]}));
if(args.mode&&args.mode!=='production')throw Error('Only production dist is supported. Do not label dev results as production.');
const repetitions=Number(args.repetitions??5),timeout=Number(args.timeout??90000);
if(!Number.isInteger(repetitions)||repetitions<1)throw Error('Invalid repetitions');
const output=resolve(args.output??`scripts/office-performance/output/${new Date().toISOString().replaceAll(':','-')}`),artifactRoot=resolve(args['artifact-root']??root);
await mkdir(output,{recursive:true});
const lockPath=resolve(import.meta.dirname,'.measurement.lock');let lock;
try{lock=await open(lockPath,'wx')}catch{throw Error(`Another measurement owns ${lockPath}; remove only after confirming it has stopped`)}
let server;const raw=[];
const metadata={schemaVersion:1,scope:'standalone-headless-browser-office-dist; excludes File/native/Tauri',mode:'production',qualification:args.qualification??'uncontrolled-local',startedAt:new Date().toISOString(),artifactRoot,git:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,viewport:{width:1280,height:900},repetitions,assets:[]};
metadata.harness=[];for(const name of ['run.mjs','server.mjs','fixtures.mjs','harness.mjs','harness.html','probes.mjs']){const bytes=await readFile(resolve(import.meta.dirname,name));metadata.harness.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex')})}
const save=async()=>writeFile(resolve(output,'raw.json'),JSON.stringify({metadata,samples:raw},null,2));
try{
 const samples=await generateFixtures(resolve(output,'fixtures'));
 for(const format of ['docx','xlsx','pptx']){
  const dist=resolve(artifactRoot,`packages/office-${format}/dist`);
  const names=new Set((await readdir(dist)).filter(name=>/\.(mjs|html|css)$/.test(name)));try{for(const name of JSON.parse(await readFile(resolve(dist,'renderer-resources.json'),'utf8')).files)names.add(name)}catch(error){if(error.code!=='ENOENT')throw error}
  for(const name of names){const bytes=await readFile(resolve(dist,name));metadata.assets.push({path:relative(artifactRoot,resolve(dist,name)),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
 }
 const playwright=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE??'packages/office-xlsx/node_modules/@playwright/test/index.mjs')).href);
 const kind=args.browser??'chromium';if(!['chromium','webkit'].includes(kind))throw Error('Use chromium or webkit');
 server=await startServer({samples,artifactRoot});metadata.rendererContracts=server.contracts;
 const formats=(args.formats??'docx,xlsx,pptx').split(','),tiers=(args.tiers??'small,complex,large').split(',');
 for(let repetition=0;repetition<repetitions;repetition++)for(const format of formats)for(const tier of tiers){
  const primary=samples.find(s=>s.format===format&&s.tier===tier&&s.variant==='a');if(!primary)throw Error('Unknown format or tier');
  const sibling=samples.find(s=>s.format===format&&s.tier===tier&&s.variant==='b'),other=samples.find(s=>s.format===formats[(formats.indexOf(format)+1)%formats.length]&&s.tier===tier&&s.variant==='a');
  const browser=await playwright[kind].launch({headless:true,...(args.channel&&kind==='chromium'?{channel:args.channel}:{})});metadata.browser={kind,version:browser.version(),channel:args.channel??'bundled'};
  try{
   const page=await browser.newPage({viewport:metadata.viewport});page.setDefaultTimeout(timeout);await page.addInitScript(installObservers);
   const pageErrors=[],network=[],consoleMessages=[];page.on('console',m=>consoleMessages.push({type:m.type(),text:m.text(),location:m.location()}));page.on('pageerror',e=>pageErrors.push(e.stack??String(e)));page.on('response',r=>network.push({url:r.url(),status:r.status(),headers:r.headers()}));page.on('requestfailed',r=>pageErrors.push(`${r.url()}: ${r.failure()?.errorText}`));
   await page.goto(server.url);await page.waitForFunction(()=>!!window.officePerf);
   const scenarios=args.scenarios==='first'?[['first-format',primary]]:[['first-format',primary],['resources-loaded-different-file',sibling],['close-reopen',sibling],['switch-format',other],['switch-back',primary]];
   for(const [scenario,sample]of scenarios){
    const result={repetition,format:sample.format,tier,scenario,id:sample.id,freshBrowserProcess:scenario==='first-format',status:'running'};raw.push(result);const start=performance.now(),errorOffset=pageErrors.length,netOffset=network.length,consoleOffset=consoleMessages.length;
    try{
     result.open=await page.evaluate(async({sample,timeout})=>{let timer;try{return await Promise.race([window.officePerf.open(sample),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Renderer open timeout')),timeout)})])}finally{clearTimeout(timer)}},{sample,timeout});
     const {frame,calculation,paint}=await contentProbe(page,sample,timeout);result.contentReadyMs=performance.now()-start;result.calculation=calculation;result.paint=paint;
     let t=performance.now();await modeProbe(page,frame,sample.format,'edit',timeout);result.previewToEditMs=performance.now()-t;
     t=performance.now();result.interaction=await interactionProbe(page,frame,sample.format,timeout);await frame.evaluate(()=>new Promise(requestAnimationFrame));result.interactionMs=performance.now()-t;
     t=performance.now();await modeProbe(page,frame,sample.format,'preview',timeout);result.editToPreviewMs=performance.now()-t;result.totalThroughInteractionMs=performance.now()-start;
     result.resources=await page.evaluate(()=>window.officePerf.resources());result.errors=pageErrors.slice(errorOffset).concat(await page.evaluate(()=>window.officePerf.errors));result.status=result.errors.length?'failed':'passed';
    }catch(error){result.status='failed';result.error=error.stack??String(error);result.elapsedMs=performance.now()-start;result.errors=pageErrors.slice(errorOffset);result.diagnostics=await Promise.all(page.frames().filter(f=>f.parentFrame()===page.mainFrame()).map(f=>f.evaluate(()=>{const e=window.__officePerfEvidence,book=e?.runtime?.univerAPI.getActiveWorkbook(),ctx=e?.context,state=ctx?.lazyWorkbookRef.current;return {calculation:e?.calculation,openingWorkbook:ctx?.openingWorkbook,flags:state?.flags,formulaMode:state?.formulaMode,sheets:book?.getSheets().map(s=>({id:s.getSheetId(),name:s.getSheetName(),cells:s.getRange('A1:F10').getValues()})),canvases:[...document.querySelectorAll('canvas')].map(e=>({id:e.id,width:e.clientWidth,height:e.clientHeight})),images:[...document.images].map(i=>({src:i.currentSrc,width:i.naturalWidth,height:i.naturalHeight})),bodyText:document.body.innerText.slice(0,1000)};}).catch(error=>({diagnosticError:String(error)}))));result.resources=await page.evaluate(()=>window.officePerf.resources()).catch(()=>[]) }
    result.network=network.slice(netOffset);result.console=consoleMessages.slice(consoleOffset);const httpFailures=result.network.filter(r=>r.status>=400);if(httpFailures.length){result.status='failed';result.httpFailures=httpFailures}result.screenshot=`${repetition}-${format}-${tier}-${scenario}.png`;
    await page.screenshot({path:resolve(output,result.screenshot)});await save();console.log(JSON.stringify({format:sample.format,tier,scenario,status:result.status,open:result.open,contentReadyMs:result.contentReadyMs,error:result.error?.split('\n')[0]}));
    if(result.status==='failed')break;
    if(scenario==='resources-loaded-different-file')await page.evaluate(()=>window.officePerf.close());
   }
  }finally{await browser.close()}
 }
 const quantile=(values,p)=>{const sorted=values.toSorted((a,b)=>a-b);return p===0.5?(sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.ceil((sorted.length-1)/2)])/2:sorted[Math.ceil(sorted.length*p)-1]};
 const groups={};for(const row of raw){const key=`${row.format}/${row.tier}/${row.scenario}`;(groups[key]??=[]).push(row)}
 const summary=Object.entries(groups).map(([key,rows])=>({key,passed:rows.filter(r=>r.status==='passed').length,failed:rows.filter(r=>r.status!=='passed').length,metrics:Object.fromEntries(['contentReadyMs','previewToEditMs','interactionMs','editToPreviewMs','totalThroughInteractionMs','open.readMs','open.engineImportMs','open.engineMs','open.inspectRoundTripMs','open.rendererImportMs','open.cssMs','open.mountToReadyMs','open.readyMs'].map(metric=>{const values=rows.filter(r=>r.status==='passed').map(r=>metric.split('.').reduce((a,k)=>a?.[k],r)).filter(Number.isFinite);return [metric,values.length?{n:values.length,median:quantile(values,.5),p95:quantile(values,.95),max:Math.max(...values)}:null]}))}));
 metadata.finishedAt=new Date().toISOString();await save();await writeFile(resolve(output,'summary.json'),JSON.stringify({metadata,summary},null,2));console.log(`Artifacts: ${output}`);if(raw.some(r=>r.status!=='passed'))process.exitCode=1;
}finally{if(server)await server.close();await lock.close();await rm(lockPath)}

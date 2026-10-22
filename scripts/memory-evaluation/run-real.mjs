#!/usr/bin/env node
// Explicit credential-file opt-in. No credential discovery or config logging.
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {run,summarize} from './evaluate.mjs';
const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
async function main(){
 const configPath=arg('--config'),fixturesPath=arg('--fixtures'),out=arg('--out');
 if(!configPath||!fixturesPath||!out)throw new Error('--config --fixtures --out required');
 const config=JSON.parse(await readFile(configPath,'utf8'));
 // The child is started with Node's native proxy support before fetch initializes.
 if(!process.env.MEMORY_EVAL_NETWORK_READY){
  const env={...process.env,MEMORY_EVAL_NETWORK_READY:'1'};
  const names=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'];
  const mode=config.network?.mode??'system';
  if(mode==='direct')for(const name of names)delete env[name];
  else if(mode==='custom'){
   if(!config.network?.proxyUrl)throw new Error('Custom network missing proxy URL');
   for(const name of names)delete env[name];
   env.HTTP_PROXY=env.HTTPS_PROXY=config.network.proxyUrl;env.NO_PROXY=env.no_proxy='';
  }else if(mode==='system'){
   if(process.platform==='darwin'&&!names.some(name=>env[name])){
    // Match normal macOS system HTTP(S) proxy selection when no env override exists.
    const state=execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8'});
    const value=name=>state.match(new RegExp(`\\b${name}\\s*:\\s*([^\\n]+)`))?.[1]?.trim();
    for(const kind of ['HTTP','HTTPS'])if(value(`${kind}Enable`)==='1'){
     const host=value(`${kind}Proxy`),port=value(`${kind}Port`);if(!host||!/^\d+$/.test(port))throw new Error('Invalid system proxy');
     env[`${kind}_PROXY`]=`http://${host}:${port}`;
    }
    if(value('ProxyAutoConfigEnable')==='1'||value('SOCKSEnable')==='1')throw new Error('System PAC/SOCKS requires native transport; no direct fallback');
   }
  }else throw new Error('Unsupported configured network mode');
  const child=spawnSync(process.execPath,['--use-env-proxy',fileURLToPath(import.meta.url),...args],{env,stdio:'inherit'});
  process.exitCode=child.status??1;return;
 }
 if(arg('--judge')){const {gradeReport}=await import('./grade.mjs');const endpoint=config.provider.baseUrl.replace(/\/+$/,'')+'/chat/completions';const ratings=await gradeReport({reportPath:arg('--judge'),fixturesPath,out,endpoint,key:config.provider.apiKey,model:config.provider.modelId});const report=JSON.parse(await readFile(arg('--judge'),'utf8'));await writeFile(out+'.summary.json',JSON.stringify(summarize(report,ratings),null,2)+'\n');console.log(JSON.stringify({graded:ratings.length,humanReviewed:false,ratings:out}));return;}
 const allScenarios=JSON.parse(await readFile(new URL('./scenarios.json',import.meta.url),'utf8'));const selectedIds=arg('--ids')?.split(',');const scenarios=selectedIds?allScenarios.filter(s=>selectedIds.includes(s.id)):allScenarios;
 const fixtures=JSON.parse(await readFile(fixturesPath,'utf8'));
 const model=config.provider.modelId,endpoint=config.provider.baseUrl.replace(/\/+$/,'')+'/chat/completions';
 const url=new URL(endpoint);if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Remote Provider must use HTTPS');
 const fingerprint=createHash('sha256').update(JSON.stringify({model,endpoint,scenarios,fixtures,harness:await readFile(new URL('./evaluate.mjs',import.meta.url),'utf8')})).digest('hex');
 await mkdir(resolve(out,'..'),{recursive:true});
 const metadataPath=out+'.metadata.json',partialPath=out+'.partial.jsonl';let cachedRows=[];
 try{const previous=JSON.parse(await readFile(metadataPath,'utf8'));if(previous.fingerprint!==fingerprint)throw new Error('Existing result fingerprint differs; choose a new output path');
  cachedRows=(await readFile(partialPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 }catch(error){if(error.code!=='ENOENT')throw error;await writeFile(metadataPath,JSON.stringify({fingerprint,model,createdAt:new Date().toISOString()}));await writeFile(partialPath,'');}
 const report=await run({scenarios,fixtures,endpoint,key:config.provider.apiKey,model,concurrency:Number(arg('--concurrency')??2),cachedRows,onRow:row=>appendFile(partialPath,JSON.stringify(row)+'\n')});
 await writeFile(out,JSON.stringify(report,null,2)+'\n');
 await writeFile(out+'.summary.json',JSON.stringify(summarize(report),null,2)+'\n');
 await writeFile(out+'.ratings.json',JSON.stringify(report.rows.map(r=>({id:r.id,arm:r.arm,repeat:r.repeat,answer:r.answer,reviewer:'',task:null,preference:null,boundaryPass:null,notes:''})),null,2)+'\n');
 console.log(JSON.stringify({completed:report.rows.length,gate:summarize(report).gate,report:out}));
}
main().catch(()=>{console.error('Real evaluation failed; inspect saved partial results or configuration locally. Credentials and provider error bodies are not logged.');process.exitCode=1;});

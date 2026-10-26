import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { installProcessOwnership } from '../../scripts/process-ownership.mjs';
const input=createInterface({input:process.stdin});
await once(input,'line');
const ctx=new Context();ctx.provide('logger',{warn(){},error(){},info(){},debug(){}});
await installProcessOwnership(ctx);
const provider=new LocalSubprocessRuntime(ctx);
await new Promise(resolve=>setImmediate(resolve));
const handle=provider.spawn({argv:[process.execPath,'-e',`console.log(process.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],cwd:process.cwd(),env:{},stdio:{stdin:'ignore',stdout:'pipe',stderr:'inherit'},graceMs:100});
let pending='';
handle.stdout.on('data',chunk=>{
  pending+=chunk;if(!pending.includes('\n'))return;
  writeFileSync(process.argv[2],JSON.stringify({host:process.pid,tool:Number(pending.trim())}));
  console.log('MIND_DSH_READY '+JSON.stringify({url:'http://127.0.0.1:23456/?token=fixture-token'}));
});
if(process.argv[3]==='normal')input.on('line',async line=>{if(line==='shutdown'){await provider.disposeManagedProcesses();process.exit(0);}});
// Intentionally retain handles and ignore shutdown/EOF in the timeout fixture.
setInterval(()=>{},1000);

import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { processOwnership } from '../../scripts/process-ownership.mjs';
const kind=process.argv[2];
const owner=await processOwnership();
const ctx=new Context();ctx.provide('logger',{warn(){},error(){},info(){},debug(){}});
const provider=new LocalSubprocessRuntime(ctx);
provider.internals.platform='linux';
// Use the real pinned lightweight capability recheck against fixture systemctl.
// The native Linux libc bootstrap itself is unavailable on this macOS host.
provider.linuxDeepProbePassed=true;
const select=provider.selectContainmentMode;
const probes=[];
provider.selectContainmentMode=function(kind){probes.push(kind);return select.call(this,kind);};
owner.protect(provider);
const selected=provider.selectContainmentMode(kind==='ordinary'?'ordinary':'terminal');
assert.equal(selected,kind==='unavailable'?'fallback':'linux-scope');
assert.deepEqual(probes,[kind==='ordinary'?'ordinary':'terminal'],'the real pinned capability probe must run');
if(kind==='unavailable') { console.log('G1 '+JSON.stringify({type:'selected',mode:selected}));process.exit(0); }
owner.pin=()=>{throw new Error('native scope terminal must not request a fallback SID pin');};
const code=`console.log('scope-ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
const spec={argv:[process.execPath,'-e',code],cwd:process.cwd(),env:{},graceMs:20};
const handle=kind==='ordinary'
  ? provider.spawn({...spec,stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}})
  : await provider.spawnTerminal({...spec,terminalType:'xterm-256color',cols:80,rows:24});
const output=kind==='ordinary'?handle.stdout:handle.output;
await new Promise((resolve,reject)=>{let text='';output.on('data',chunk=>{text+=chunk;if(text.includes('scope-ready'))resolve();});handle.done.then(()=>reject(new Error('scope exited before ready')),reject);});
await provider.disposeManagedProcesses();
const directory=process.env.G1_SYSTEMD_FIXTURE;
const calls=readFileSync(path.join(directory,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const launches=calls.filter(call=>call.command==='systemd-run');
assert.equal(launches.length,1);
assert.ok(launches[0].args.includes('--scope'));
assert.ok(calls.some(call=>call.command==='systemctl'&&call.args.includes('kill')&&call.args.includes('--kill-whom=all')&&call.args.includes('--signal=SIGKILL')),'original scope owner must kill every scope member');
assert.ok(calls.some(call=>call.command==='systemctl'&&call.args.includes('show')&&call.args.includes('--property=TasksCurrent')),'original scope owner must await managed-range exit');
const file=readdirSync(directory).find(name=>name.endsWith('.scope.json'));
const state=JSON.parse(readFileSync(path.join(directory,file),'utf8'));
for(const pid of [state.launcher,state.member]){for(let i=0;i<100;i++){let alive=true;try{process.kill(pid,0);}catch{alive=false;}if(!alive)break;if(i===99)assert.fail('scope member survived original disposal');await new Promise(resolve=>setTimeout(resolve,20));}}
console.log('G1 '+JSON.stringify({type:'scope',kind,mode:selected,cleanup:'systemctl-all-and-wait'}));
await ctx.fiber.dispose();
process.exit(0);

import { Context } from '@deepseek-ai/cordis';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { installProcessOwnership } from '../../scripts/process-ownership.mjs';
const mode = process.argv[2];
const emit = value => process.stdout.write(`G1 ${JSON.stringify(value)}\n`);
const ctx = new Context();
ctx.provide('logger', { warn(){}, error(){}, info(){}, debug(){} });
// Exercise Cordis service arrival, not only a direct protect() test call.
const owner = await installProcessOwnership(ctx);
const provider = new LocalSubprocessRuntime(ctx);
await new Promise(resolve => setImmediate(resolve));
if (mode === 'pipes') {
  let extra;
  const original = provider.internals.spawn;
  provider.internals.spawn = (program, args, options) => {
    options.stdio[3] = 'pipe';
    const child = original(program, args, options);
    extra = child.stdio[3]; return child;
  };
  const code = `
    const {Socket}=require('node:net'); const {spawn}=require('node:child_process');
    const background=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log('G1 '+JSON.stringify({type:'ready',pid:process.pid,hostPid:process.env.G1_HOST,background:background.pid}));
    for(const fd of [3,7]){const channel=new Socket({fd,readable:true,writable:true});channel.once('data',data=>{channel.end('ack'+fd+':'+data);});}
    let count=0; const timer=setInterval(()=>{if(++count===3)process.exit(23)},40);
  `;
  const handle = provider.spawn({ argv:[process.execPath,'-e',code], cwd:process.cwd(), env:{G1_HOST:String(process.pid)}, stdio:{stdin:'ignore',stdout:'inherit',stderr:'inherit',control:'pipe'}, graceMs:100 });
  let replies=['','']; extra.on('data',chunk=>replies[0]+=chunk); handle.control.on('data',chunk=>replies[1]+=chunk);
  const closed = Promise.all([once(extra,'close'),once(handle.control,'close')]);
  extra.write('three'); handle.control.write('seven');
  const result = await handle.done;
  await closed;
  emit({ type:'pipes', replies, result });
} else if (['pty','shell','shell-tree','pty-pin-failure'].includes(mode)) {
  const shell = mode.startsWith('shell');
  if(mode==='pty-pin-failure') { const pin=owner.pin; owner.pin=async pid=>{await pin(pid);await new Promise(resolve=>setTimeout(resolve,100));throw new Error('injected terminal pin failure');}; }
  const spec = { argv: shell ? ['/bin/zsh','-i'] : [process.execPath,'-e',`const value={type:'ready',pid:process.pid,hostPid:process.env.G1_HOST};if(process.env.G1_PID_FILE)require('node:fs').writeFileSync(process.env.G1_PID_FILE,JSON.stringify(value));console.log('G1 '+JSON.stringify(value));setInterval(()=>{},1000)`], cwd:process.cwd(), env:{...process.env,G1_HOST:String(process.pid),G1_PID_FILE:process.argv[3]}, terminalType:'xterm-256color', rows:24,cols:80,graceMs:100,shellActivity:shell };
  const handle = await provider.spawnTerminal(spec);
  handle.output.on('data',chunk=>process.stdout.write(chunk));
  if(shell) {
    let idle=false;
    for(let i=0;i<250;i++){if((await handle.inspectActivity()).state==='idle'){idle=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
    if(!idle)throw new Error('shell startup did not reach an idle prompt');
  }
  if(mode==='shell-tree') { await handle.write(`sleep 600 & printf 'G1 {"type":"ready","pid":%s,"hostPid":%s,"background":%s}\\n' "$$" "${process.pid}" $(jobs -p)\n`); }
  if(mode==='shell') {
    await handle.write(`printf 'G1 {"type":"ready","pid":%s,"hostPid":%s}\\n' "$$" "${process.pid}"\n`);
    await new Promise(resolve=>setTimeout(resolve,150));
    emit({type:'activity',activity:await handle.inspectActivity()});
  }
} else {
  let code = `console.log('G1 '+JSON.stringify({type:'ready',pid:process.pid,hostPid:process.env.G1_HOST}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  if(mode==='tree') code = `const {spawn}=require('node:child_process'); const child=spawn('/bin/sh',['-c',\`sleep 600 & printf 'G1 {"type":"tree","background":%s,"shell":%s}\\n' "$!" "$$"; wait\`],{stdio:'inherit'});` + code;
  if(mode==='daemon') code = `const {spawn}=require('node:child_process');const daemon=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log('G1 '+JSON.stringify({type:'escape',pid:daemon.pid}));` + code;
  provider.spawn({argv:[process.execPath,'-e',code],cwd:process.cwd(),env:{G1_HOST:String(process.pid)},stdio:{stdin:'ignore',stdout:'inherit',stderr:'inherit'},graceMs:100});
}
process.stdin.resume();
if (mode !== 'unresponsive') process.stdin.on('data',async()=>{await provider.disposeManagedProcesses();await ctx.fiber.dispose();process.exit(0);});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const unix = process.platform !== 'win32';
const root = fileURLToPath(new URL('../../../',import.meta.url));
const directory=mkdtempSync(path.join(tmpdir(),'mind-dsh-process-test-'));
const helper=path.join(directory,'process-guardian');
const node=path.join(root,'src-tauri/resources/agent-host/node');
const fixture=fileURLToPath(new URL('./fixtures/process-host.mjs',import.meta.url));
before(()=>unix && execFileSync('rustc',['--edition=2021',fileURLToPath(new URL('./fixtures/process-guardian.rs',import.meta.url)),'-o',helper]));
after(()=>rmSync(directory,{recursive:true,force:true}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function alive(pid){try{process.kill(Number(pid),0);return true;}catch{return false;}}
async function gone(pid) { for(let i=0;i<100;i++){if(!alive(pid))return;await sleep(20);}assert.fail(`owned process ${pid} survived cleanup`); }
function launch(mode,...args){
  const outer=spawn(helper,[node,fixture,mode,...args],{stdio:['pipe','pipe','pipe']});
  const messages=[];let text='',error='';
  outer.stdout.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\n'))>=0){const line=text.slice(0,end).trim();text=text.slice(end+1);const start=line.indexOf('G1 {');if(start>=0){try{messages.push(JSON.parse(line.slice(start+3)));}catch{}}}});
  outer.stderr.on('data',chunk=>error+=chunk);
  const exit=once(outer,'exit');
  return{outer,exit,async message(type){for(let i=0;i<250;i++){const message=messages.find(value=>value.type===type);if(message)return message;if(outer.exitCode!==null)assert.fail(`fixture exited ${outer.exitCode}: ${error}`);await sleep(20);}assert.fail(`missing ${type}: ${error}`);},async clean(frame){
    if(frame?.hostPid&&alive(frame.hostPid))process.kill(Number(frame.hostPid),'SIGKILL');
    for(const pid of [frame?.pid,frame?.background])if(pid&&alive(pid)){try{process.kill(Number(pid),'SIGKILL');}catch{}}
    if(outer.exitCode===null){outer.kill('SIGKILL');await exit;}
  }};
}
for(const mode of ['ordinary','pty'])test(`${mode}: actual running detached child is cleaned after Node SIGKILL`,{skip:!unix,timeout:10000},async()=>{
  const f=launch(mode);let frame;
  try{frame=await f.message('ready');assert.ok(alive(frame.pid));process.kill(Number(frame.hostPid),'SIGKILL');await gone(frame.pid);await f.exit;}
  finally{await f.clean(frame);}
});
test('native parent SIGKILL cleans already running Node and detached child',{skip:!unix,timeout:10000},async()=>{
  const f=launch('ordinary');let frame;
  try{frame=await f.message('ready');f.outer.kill('SIGKILL');await f.exit;await gone(frame.hostPid);await gone(frame.pid);}
  finally{await f.clean(frame);}
});
test('normal disposal preserves output, exit code and fd3/fd7 EOF while sentinel remains for background',{skip:!unix,timeout:10000},async()=>{
  const f=launch('pipes');let frame;
  try{frame=await f.message('ready');const result=await f.message('pipes');assert.deepEqual(result.replies,['ack3:three','ack7:seven']);assert.equal(result.result.exitCode,23);assert.ok(alive(frame.background),'background is still owned when both control pipes close');f.outer.stdin.write('shutdown\n');await f.exit;await gone(frame.background);}
  finally{await f.clean(frame);}
});
test('interactive shell remains idle with its native sentinel present',{skip:!unix || !existsSync('/bin/zsh'),timeout:10000},async()=>{
  const f=launch('shell');let frame;
  try{frame=await f.message('ready');const message=await f.message('activity');assert.equal(message.activity.state,'idle');f.outer.stdin.write('shutdown\n');await f.exit;await gone(frame.pid);}
  finally{await f.clean(frame);}
});
test('normal tool shell/background tree is cleaned and another application session survives',{skip:!unix,timeout:10000},async()=>{
  const other=spawn(node,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
  const f=launch('tree');let frame,tree;
  try{frame=await f.message('ready');tree=await f.message('tree');process.kill(Number(frame.hostPid),'SIGKILL');await f.exit;for(const pid of [frame.pid,tree.shell,tree.background])await gone(pid);assert.ok(alive(other.pid),'unrelated application must survive');}
  finally{await f.clean(frame);other.kill('SIGKILL');await once(other,'exit');for(const pid of [tree?.shell,tree?.background])if(pid&&alive(pid))process.kill(pid,'SIGKILL');}
});
test('documented boundary: a tool daemon creating its own SID escapes the provider session',{skip:!unix,timeout:10000},async()=>{
  const f=launch('daemon');let frame,escape;
  try{frame=await f.message('ready');escape=await f.message('escape');process.kill(Number(frame.hostPid),'SIGKILL');await f.exit;await gone(frame.pid);assert.ok(alive(escape.pid),'session lease alone must not be claimed to contain daemon-created sessions');}
  finally{await f.clean(frame);if(escape&&alive(escape.pid))process.kill(escape.pid,'SIGKILL');}
});
test('native protocol rejects an unterminated frame above 512 bytes',{skip:!unix,timeout:5000},async()=>{
  const {createServer}=await import('node:net');const {writeFileSync}=await import('node:fs');
  const {processOwnership}=await import('../scripts/process-ownership.mjs');
  const dir=mkdtempSync(path.join(tmpdir(),'mind-dsh-frame-'));writeFileSync(path.join(dir,'secret'),'fixture');
  const server=createServer(socket=>socket.once('data',()=>socket.write('OK\n'+'x'.repeat(513))));
  server.listen(path.join(dir,'lease'));await once(server,'listening');let owner;
  try{owner=await processOwnership({PROJECT_MIND_DSH_PROCESS_HELPER:helper,PROJECT_MIND_DSH_PROCESS_DIRECTORY:dir});await assert.rejects(owner.pin(123),/frame exceeds budget/);}
  finally{owner?.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
test('PTY job-control background group is cleaned after Node SIGKILL',{skip:!unix || !existsSync('/bin/zsh'),timeout:10000},async()=>{
  const f=launch('shell-tree');let frame;
  try{frame=await f.message('ready');const group=Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(frame.background)],{encoding:'utf8'}).trim());assert.notEqual(group,Number(frame.pid),'fixture must create a separate job-control group');process.kill(Number(frame.hostPid),'SIGKILL');await f.exit;await gone(frame.pid);await gone(frame.background);}
  finally{await f.clean(frame);}
});
test('PTY pin rejection releases a terminal that already executed its target',{skip:!unix,timeout:10000},async()=>{
  const {readFileSync,existsSync}=await import('node:fs');
  const file=path.join(directory,'pin-failure.json');const f=launch('pty-pin-failure',file);let frame;
  try{for(let i=0;i<250&&!existsSync(file);i++)await sleep(20);assert.ok(existsSync(file),'terminal target must execute before pin rejection');frame=JSON.parse(readFileSync(file,'utf8'));await f.exit;await gone(frame.pid);await gone(frame.hostPid);}
  finally{await f.clean(frame);}
});
for(const kind of ['ordinary','terminal','unavailable'])test(`Linux ${kind}: pinned capability selection and native scope disposal stay intact`,{skip:!unix,timeout:10000},async()=>{
  const {writeFileSync,chmodSync,readFileSync,readdirSync}=await import('node:fs');
  const dir=mkdtempSync(path.join(directory,'systemd-'));
  const script=fileURLToPath(new URL('./fixtures/process-linux-systemd.mjs',import.meta.url));
  // Shell wrappers exec the pinned Node so no vendor files or builtin imports
  // need patching to exercise launchLinuxScope/SystemdScopeOwner on macOS.
  for(const command of ['systemd-run','systemctl']){
    const file=path.join(dir,command);
    const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
    writeFileSync(file,`#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`);chmodSync(file,0o700);
  }
  const linuxFixture=fileURLToPath(new URL('./fixtures/process-linux-scope-host.mjs',import.meta.url));
  const outer=spawn(helper,[node,linuxFixture,kind],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,G1_SYSTEMD_FIXTURE:dir,G1_SYSTEMD_UNAVAILABLE:kind==='unavailable'?'1':'0'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';outer.stdout.on('data',chunk=>stdout+=chunk);outer.stderr.on('data',chunk=>stderr+=chunk);
  try{const [code]=await once(outer,'exit');assert.equal(code,0,stderr);assert.ok(stdout.includes(kind==='unavailable'?'"mode":"fallback"':'"cleanup":"systemctl-all-and-wait"'),stdout);}
  finally{
    if(outer.exitCode===null)outer.kill('SIGKILL');
    // Only this fixture's recorded PIDs are eligible for emergency cleanup.
    for(const name of readdirSync(dir).filter(name=>name.endsWith('.scope.json'))){const value=JSON.parse(readFileSync(path.join(dir,name),'utf8'));for(const pid of [value.launcher,value.member]){try{process.kill(pid,'SIGKILL');}catch{}}}
    rmSync(dir,{recursive:true,force:true});
  }
});

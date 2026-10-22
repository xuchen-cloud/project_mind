import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startLocalProvider } from './fixtures/local-provider.mjs';

// Run explicitly: node --test packages/dsh-assistant/test/memory.runtime.integration.mjs
// Real subprocess + rc.2 Web RPC/mux + provider SSE; no SDK, browser, or build.
const root = fileURLToPath(new URL('..', import.meta.url));
const redact = (text) => String(text).replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]').replace(/(?:local-integration-key|alternative-integration-key)/g, '[redacted]');
async function waitFor(read, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

async function launch(data, patch, sharedProvider, project, profileDirectory, sourceHandler, workspace, cli) {
  const child = fork(path.join(root, 'scripts/runtime.mjs'), [...(sharedProvider ? ['--embedded'] : []), '--port', '0', '--no-open'], {
    cwd: root, execArgv: [], silent: true,
    env: { ...process.env, PROJECT_MIND_DSH_USER_DATA: data, PROJECT_MIND_DSH_SKILLS_DATA: path.join(path.dirname(data), 'skill-management'),
      ...((project || workspace) ? { PROJECT_MIND_DSH_PROFILE_DIR: profileDirectory ?? path.join(path.dirname(data), 'shared-profile') } : {}),
      ...(patch ? { PROJECT_MIND_DSH_PATCH: patch } : {}), LOCAL_TEST_KEY: 'local-integration-key' },
  });
  if (sharedProvider) child.stdin.write(JSON.stringify({ type: 'configure', provider: { ...sharedProvider, providers: undefined }, providers: sharedProvider.providers, ...(workspace ? { workspace } : { project }), ...(cli ? { cli } : {}) }) + '\n');
  let output = '';
  let ready;
  let ended;
  let spawnError;
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-64000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-64000); });
  if (sourceHandler) createInterface({ input: child.stdout }).on('line', async line => {
    if (!line.startsWith('MIND_DSH_SOURCE ')) return;
    const frame = JSON.parse(line.slice('MIND_DSH_SOURCE '.length));
    let result;
    try { result = { ok: true, value: await sourceHandler(frame.payload) }; }
    catch (error) { result = { ok: false, error: { message: String(error.message) } }; }
    child.stdin.write(JSON.stringify({ type: 'mind-source-response', id: frame.id, result }) + '\n');
  });
  child.on('message', (message) => { if (message?.type === 'ready') ready = message; });
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { ended = { code, signal }; resolve(ended); }));
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (!ended) {
      if (sharedProvider) child.stdin.end('shutdown\n');
      else child.kill('SIGTERM');
    }
    const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 8000);
    try {
      const result = await exited;
      assert.equal(result.signal, null, 'runtime must shut down without forced termination');
      assert.equal(result.code, 0, `runtime exit: ${redact(output).slice(-4000)}`);
    } finally { clearTimeout(timer); }
  })();
  try {
    await waitFor(() => {
      if (spawnError) throw spawnError;
      if (ended) throw new Error(`Runtime exited before ready (${ended.code}): ${redact(output).slice(-8000)}`);
      return ready && output.match(/http:\/\/[^\s"'<>]+\?token=[^\s"'<>]+/);
    }, 'runtime IPC ready and authenticated URL', 30000);
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    const authUrl = new URL(output.match(/http:\/\/[^\s"'<>]+\?token=[^\s"'<>]+/)[0]);
    assert.equal(Number(authUrl.port), ready.port);
    const origin = authUrl.origin;
    const exchange = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(exchange.status, 303, 'launch token exchange redirects to clean URL');
    const cookie = exchange.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'token exchange must mint cookie');
    await exchange.arrayBuffer();
    const headers = { Origin: origin, Cookie: cookie };
    const rpc = async (method, request, argument = 'request') => {
      const rpcId = randomUUID();
      const response = await fetch(`${origin}/api/${method}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request === undefined ? {} : { [argument]: request } } }),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, `${method} HTTP status`);
      const envelope = await response.json();
      assert.equal(envelope.type, 'server-response');
      assert.equal(envelope.rpcId, rpcId);
      assert.equal(envelope.result.ok, true, `${method}: ${redact(JSON.stringify(envelope.result.error))}`);
      return envelope.result.value;
    };
    return { child, origin, headers, rpc, stop, diagnostics: () => redact(output).slice(-8000) };
  } catch (error) {
    await stop().catch(() => {});
    throw new Error(`${error.message}\n${redact(output).slice(-8000)}`, { cause: error });
  }
}

async function follow(runtime, sessionId) {
  const socket = new WebSocket(`${runtime.origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: runtime.headers });
  const frames = [];
  let failure;
  socket.on('error', (error) => { failure = error; });
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'error') failure = new Error(`session/follow: ${redact(JSON.stringify(message.error))}`);
      else if (message.type === 'item' && message.streamId === 'session-follow') frames.push(message.value);
    } catch (error) { failure = error; }
  });
  const read = (predicate, description) => waitFor(() => {
    if (failure) throw failure;
    assert.equal(socket.readyState, WebSocket.OPEN, 'follow socket closed unexpectedly');
    return frames.find(predicate);
  }, description);
  const close = async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.terminate();
    await closed;
  };
  try {
    await waitFor(() => { if (failure) throw failure; return socket.readyState === WebSocket.OPEN; }, 'mux WebSocket open');
    socket.send(JSON.stringify({ type: 'open', streamId: 'session-follow', endpoint: 'session/follow', payload: {
      args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 100 } },
    } }));
    const snapshot = await read((frame) => frame.type === 'snapshot', 'session follow snapshot');
    return { frames, snapshot, read, close };
  } catch (error) { await close(); throw error; }
}

const events = (stream) => stream.frames.flatMap((frame) => frame.type === 'snapshot' ? frame.records.map((record) => record.event) : frame.type === 'event' ? [frame.event] : []);
const assistantText = (event) => event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');


async function prompt(runtime, stream, sessionId, text, expectedKind = 'completed') {
  const from = stream.frames.length;
  const result = await runtime.rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] });
  assert.deepEqual(result, { accepted: true });
  const end = await stream.read((frame) => stream.frames.indexOf(frame) >= from && frame.type === 'event' && frame.event.type === 'turn/end', `turn completion: ${text}`);
  assert.equal(end.event.data.reason.kind, expectedKind, JSON.stringify(end.event.data.reason));
  return end.event;
}

// Real subprocess/SDK/provider transport; native persistence is a deterministic
// protocol fixture. This is integration evidence, not semantic model evaluation.
test('memory real runtime binds human evidence and refreshes each tool continuation', {timeout:60000}, async t => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-memory-runtime-')));
  const bodies = [], operations = [];
  const provider = await startLocalProvider({onSyntheticRequest: body => bodies.push(body)});
  let runtime, stream, fact;
  t.after(async()=>{await stream?.close();await runtime?.stop();await provider.close();await rm(temp,{recursive:true,force:true});});
  const workspace = {id:randomUUID(),name:'Memory test',directory:temp};
  const native = async payload=>{
    operations.push(payload);
    if(payload.operation==='memoryAdoption')return null;
    assert.equal(payload.operation,'memory');
    const r=payload.request;
    if(r.operation==='context') return {facts:fact?.state==='active'?[fact]:[],suppressed:fact?.state==='forgotten'?[fact]:[],omittedIds:[]};
    if(r.operation==='list') return {facts:fact?[fact]:[],proposals:[],settings:{requireApproval:false}};
    assert.equal(r.operation,'apply');
    assert.ok(payload.userMessage.id);assert.equal(payload.origin,'user');
    assert.match(payload.userMessage.text,/请记住/);
    const change=r.changes[0];
    if(change.action==='add') fact={id:'fact-one',revision:1,state:'active',condition:'工作时',...change};
    else if(change.action==='patch') fact={...fact,...change,revision:2};
    else fact={...fact,state:'forgotten',revision:3};
    return {facts:[fact],receipt:`saved-${fact.revision}`,pending:false,proposalId:null};
  };
  const start=()=>launch(path.join(temp,'history'),undefined,{name:'Memory model',baseUrl:provider.url,modelId:'local-test-model',apiKey:'local-integration-key',supportsImage:false},undefined,undefined,native,workspace);
  runtime=await start();
  const {sessionId}=await runtime.rpc('session/create',{});
  await runtime.rpc('session/rename',{sessionId,title:'Memory integration'});
  stream=await follow(runtime,sessionId);
  const call=(id,change)=>provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id,type:'function',function:{name:'memory_apply',arguments:JSON.stringify({changes:[{scope:{kind:'workspace'},...change}]})}}]});
  call('save',{action:'add',category:'preference',content:'中文答复'});
  call('patch',{action:'patch',id:'fact-one',expectedRevision:1,content:'简短中文答复'});
  call('forget',{action:'forget',id:'fact-one',expectedRevision:2});
  await prompt(runtime,stream,sessionId,'请记住我的工作答复偏好，再修正并忘记这条测试记忆');
  assert.equal(bodies.length,4);
  const memoryText=body=>body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).findLast(s=>s.includes('Current authoritative memory'));
  assert.match(memoryText(bodies[1]),/中文答复/);
  assert.match(memoryText(bodies[2]),/简短中文答复/);
  assert.match(memoryText(bodies[3]),/"facts":\[\]/);
  assert.match(memoryText(bodies[3]),/negativeConstraints/);
  assert.match(JSON.stringify(bodies[1].messages),/saved-1/);
  assert.match(JSON.stringify(bodies[3].messages),/saved-3/);
  const actual=events(stream).find(e=>e.type==='user/message'&&e.data.source.kind==='user');
  assert.ok(operations.every(o=>o.sessionId===sessionId));
  assert.ok(operations.filter(o=>o.request?.operation==='apply').every(o=>o.userMessage.id===actual.data.id));
  const adoptedRequests=operations.filter(o=>o.operation==='memoryAdoption');
  assert.equal(adoptedRequests.length,4);
  const actualSteps=events(stream).filter(e=>e.type==='step/start').map(e=>({turn:e.data.turn,step:e.data.step}));
  assert.deepEqual(adoptedRequests.map(({turn,step})=>({turn,step})),actualSteps);
  assert.equal(new Set(adoptedRequests.map(r=>r.requestId)).size,4);
  const schema=JSON.stringify(bodies[0].tools.find(t=>t.function.name==='memory_apply'));
  assert.match(schema,/expectedRevision/);assert.match(schema,/knowledge_pointer/);
  assert.equal(bodies[0].tools.some(t=>t.function.name==='project_history'),false);
  assert.ok(bodies[0].tools.some(t=>t.function.name==='memory_schedule'));
  await stream.close();stream=undefined;await runtime.stop();
  fact={...fact,state:'active',content:'Restart fresh value',revision:4};
  runtime=await start();stream=await follow(runtime,sessionId);
  await prompt(runtime,stream,sessionId,'Continue after restart');
  assert.match(memoryText(bodies.at(-1)),/Restart fresh value/);
  assert.equal(JSON.stringify(bodies.at(-1).messages).split('Current authoritative memory').length-1,1,'one active snapshot after restore');
  assert.equal(events(stream).filter(e=>e.type==='user/message'&&e.data.source.kind==='user').length,2,'human originals retained');
  const compact = await fetch(`${runtime.origin}/api/commands/execute`, {method:'POST',headers:{...runtime.headers,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'commands/execute',payload:{args:{agentId:sessionId,line:'/compact',submittedAttachments:[]}}})});
  const compactResult=await compact.json();assert.equal(compactResult.result.ok,true,JSON.stringify(compactResult));
  const compactDone=await stream.read(frame=>frame.type==='event'&&frame.event.type==='command/done','compaction completes');
  assert.equal(compactDone.event.data.kind,'success');assert.match(compactDone.event.data.text,/Compacted /);
  fact={...fact,content:'Post-compaction fresh value',revision:5};
  await prompt(runtime,stream,sessionId,'Continue after compaction');
  assert.match(memoryText(bodies.at(-1)),/Post-compaction fresh value/);
  assert.equal(JSON.stringify(bodies.at(-1).messages).split('Current authoritative memory').length-1,1);

});

test('memory real Project runtime enforces read-only and foreign Project isolation', {timeout:60000}, async t=>{
 const temp=await realpath(await mkdtemp(path.join(tmpdir(),'mind-memory-readonly-')));
 const bodies=[],operations=[];
 const provider=await startLocalProvider({onSyntheticRequest:body=>bodies.push(body)});
 let runtime,stream;
 t.after(async()=>{await stream?.close();await runtime?.stop();await provider.close();await rm(temp,{recursive:true,force:true});});
 const patch=path.join(temp,'readonly.yml');await writeFile(patch,'- id: sandbox-policy\n  config:\n    mode: read-only\n');
 runtime=await launch(path.join(temp,'history'),patch,{name:'Local',baseUrl:provider.url,modelId:'local-test-model',apiKey:'local-integration-key',supportsImage:false},{id:7,name:'Current Project',directory:temp},undefined,async payload=>{
  operations.push(payload);
  if(payload.operation==='memoryAdoption')return null;
  assert.equal(payload.mode,'read-only');assert.deepEqual(payload.request.scope,{kind:'project',projectId:7});
  assert.equal(payload.request.operation,'context');
  return {facts:[{id:'workspace',revision:1,scope:{kind:'workspace'},content:'workspace visible',condition:null},{id:'project7',revision:1,scope:{kind:'project',projectId:7},content:'current project visible',condition:null}],omittedIds:[],suppressed:[]};
 });
 const {sessionId}=await runtime.rpc('session/create',{});await runtime.rpc('session/rename',{sessionId,title:'Read-only memory'});stream=await follow(runtime,sessionId);
 for(const [id,scope] of [['foreign',{kind:'project',projectId:8}],['readonly',{kind:'project',projectId:7}]]) provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id,type:'function',function:{name:'memory_apply',arguments:JSON.stringify({changes:[{action:'add',scope,category:'agreement',content:'must not write'}]})}}]});
 provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id:'readonly-schedule',type:'function',function:{name:'memory_schedule',arguments:JSON.stringify({action:'write',input:{enabled:true,intervalHours:24,localTime:'08:00',timezone:'UTC',expectedRevision:0}})}}]});
 await prompt(runtime,stream,sessionId,'Remember this in another Project');
 assert.ok(bodies[0].tools.some(t=>t.function.name==='project_history'));
 const scheduleResult=bodies.at(-1).messages.find(m=>m.tool_call_id==='readonly-schedule');assert.match(JSON.stringify(scheduleResult),/read-only/);
 assert.match(JSON.stringify(bodies.at(-1).messages),/exceeds current scope/);
 assert.match(JSON.stringify(bodies.at(-1).messages),/read-only/);
 assert.ok(operations.every(p=>p.operation==='memoryAdoption'||p.request.operation==='context'));
 assert.match(JSON.stringify(bodies[0].messages),/workspace visible/);assert.match(JSON.stringify(bodies[0].messages),/current project visible/);
});

test('memory runtime preserves fresh reads, pending/failure receipts, PTC evidence and editable behavior', {timeout:60000}, async t=>{
 const temp=await realpath(await mkdtemp(path.join(tmpdir(),'mind-memory-receipts-')));
 const bodies=[],operations=[];
 const provider=await startLocalProvider({onSyntheticRequest:body=>bodies.push(body)});
 let runtime,stream,behavior={path:'memory.md',content:'Original behavior',revision:'r1'};
 t.after(async()=>{await stream?.close();await runtime?.stop();await provider.close();await rm(temp,{recursive:true,force:true});});
 const patch=path.join(temp,'ptc.yml');await writeFile(patch,'- id: tools\n  config:\n    mode: both\n');
 runtime=await launch(path.join(temp,'history'),patch,{name:'Local',baseUrl:provider.url,modelId:'local-test-model',apiKey:'local-integration-key',supportsImage:false},undefined,undefined,async p=>{
  operations.push(p);
  if(p.operation==='memoryAdoption')return null;
  if(p.operation==='memoryBehavior'){assert.equal(p.action,'write');assert.equal(p.expectedRevision,'r1');assert.equal(p.origin,'user');behavior={...behavior,content:p.content,revision:'r2'};return {...behavior,receipt:'behavior saved'};}
  if(p.request.operation==='context')return {facts:[],suppressed:[],omittedIds:['only-on-read'],behavior};
  if(p.request.operation==='list'){assert.equal(p.request.includeInactive,false);return {facts:[{id:'only-on-read',revision:1,condition:null,content:'Read result must reach model'}],settings:{requireApproval:true},proposals:[]};}
  assert.equal(p.request.operation,'apply');
  if(p.origin==='organization')return {facts:[],pending:true,proposalId:'pending-one',receipt:'awaiting approval'};
  assert.deepEqual(p.sourceRefs,[{fixture:'native-delivered-ref'}]);throw new Error('Memory revision conflict');
 },{id:randomUUID(),name:'Memory receipts',directory:temp});
 const {sessionId}=await runtime.rpc('session/create',{});await runtime.rpc('session/rename',{sessionId,title:'Receipts'});stream=await follow(runtime,sessionId);
 const queue=(id,name,args)=>provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 queue('read','memory_read',{});
 queue('organize','memory_organize',{changes:[{action:'add',scope:{kind:'workspace'},category:'preference',content:'machine suggestion'}]});
 queue('ptc','run_code',{description:'Try the requested correction',code:`return await tools.memory_apply({changes:[{action:'patch',scope:{kind:'workspace'},id:'only-on-read',expectedRevision:1,content:'Corrected'}],source_refs:[{fixture:'native-delivered-ref'}]});`});
 queue('behavior','memory_behavior',{action:'write',expected_revision:'r1',content:'Updated behavior in same run'});
 await prompt(runtime,stream,sessionId,'Please correct that memory and edit memory behavior');
 assert.equal(bodies.length,5);
 assert.match(JSON.stringify(bodies[1].messages),/Read result must reach model/,'fresh read result is usable beyond compact snapshot');
 assert.match(JSON.stringify(bodies[2].messages),/awaiting approval/);assert.match(JSON.stringify(bodies[2].messages),/pending-one/);
 assert.match(JSON.stringify(bodies[3].messages.filter(m=>m.role==='tool'||JSON.stringify(m.content).includes('Current authoritative memory'))),/Memory revision conflict/);
 assert.match(JSON.stringify(bodies[4].messages),/Updated behavior in same run/);
 assert.ok(operations.some(p=>p.operation==='memoryBehavior'&&p.userMessage?.id));
 assert.ok(operations.some(p=>p.request?.operation==='apply'&&p.origin==='organization'));
 const adopted=operations.filter(p=>p.operation==='memoryAdoption').length;
 provider.failNext(400);await prompt(runtime,stream,sessionId,'Rejected provider admission','error');
 assert.equal(operations.filter(p=>p.operation==='memoryAdoption').length,adopted,'HTTP failure must not claim adoption');
});

for (const failingTool of ['memory_apply', 'memory_organize']) test(`irrecoverable native ${failingTool} failure pauses only that human request, including PTC repair attempts`, {timeout:60000}, async t=>{
 const temp=await realpath(await mkdtemp(path.join(tmpdir(),'mind-memory-failure-')));
 const bodies=[],operations=[];let runtime,stream,other;
 const provider=await startLocalProvider({onSyntheticRequest:body=>bodies.push(body)});
 t.after(async()=>{await stream?.close();await other?.close();await runtime?.stop();await provider.close();await rm(temp,{recursive:true,force:true});});
 const patch=path.join(temp,'ptc.yml');await writeFile(patch,'- id: tools\n  config:\n    mode: both\n');
 let fail=true;
 runtime=await launch(path.join(temp,'history'),patch,{name:'Local',baseUrl:provider.url,modelId:'local-test-model',apiKey:'local-integration-key',supportsImage:false},undefined,undefined,async p=>{
  operations.push(p);if(p.operation==='memoryAdoption')return null;
  if(p.request.operation==='context')return {facts:[],suppressed:[],omittedIds:[]};
  if(p.request.operation==='apply'){if(fail){fail=false;throw new Error('SQLite write failed: disk full');}return {facts:[],receipt:'saved after new human request',pending:false};}
  throw new Error('Unexpected native operation');
 },{id:randomUUID(),name:'Memory failure',directory:temp});
 const {sessionId}=await runtime.rpc('session/create',{});await runtime.rpc('session/rename',{sessionId,title:'Failure state test'});stream=await follow(runtime,sessionId);
 const change={changes:[{action:'add',scope:{kind:'workspace'},category:'preference',content:'concise responses'}]};
 const queue=(id,name,args)=>provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 provider.enqueueResponse({chunks:[''],toolCalls:[
  [failingTool,change,'failed-save'],
  ['run_code',{description:'Attempt repair',code:'return await tools.bash({command:"touch repair-should-not-run",description:"repair"});'},'ptc-repair'],
  ['memory_apply',change,'repeat-save'],
  ['read',{file_path:'application-source.js'},'read-source'],
  ['bash',{command:'touch repair-should-not-run',description:'repair'},'bash-repair'],
 ].map(([name,args,id],index)=>({index,id,type:'function',function:{name,arguments:JSON.stringify(args)}}))});
 await prompt(runtime,stream,sessionId,'Please remember my response preference.','error');
 assert.equal(bodies.length,1,'native failure closure never requests a model-written final answer');
 assert.equal(operations.filter(p=>p.request?.operation==='apply').length,1,'failed request cannot execute another mutation');
 const failed=events(stream).find(e=>e.type==='tool/result'&&e.data.message.toolCallId==='failed-save');
 assert.equal(failed.data.message.isError,true);
 assert.match(JSON.stringify(failed),/SQLite write failed: disk full/,'original real tool failure remains archived');
 const denied=events(stream).find(e=>e.type==='tool/result'&&e.data.message.toolCallId==='ptc-repair');
 assert.ok(denied, 'actual SDK PTC result exists');
 assert.match(JSON.stringify(denied),/Tool work is paused/,'reserved PTC transport is denied by the actual SDK guard');
 const ended=events(stream).find(e=>e.type==='turn/end');
 assert.equal(ended.data.reason.kind,'error');
 assert.match(ended.data.reason.error.message,/本次记忆未保存。原生错误：SQLite write failed: disk full/);
 assert.match(ended.data.reason.error.message,/请发送新消息后再尝试/);
 assert.ok(ended.seq>failed.seq,'failure is committed before native terminal notification');
 const {access}=await import('node:fs/promises');await assert.rejects(access(path.join(temp,'repair-should-not-run')));
 await stream.close();stream=await follow(runtime,sessionId);
 assert.deepEqual(events(stream).find(e=>e.type==='turn/end').data.reason,ended.data.reason,'native visible notification survives reloading the archive');
 const otherId=(await runtime.rpc('session/create',{})).sessionId;await runtime.rpc('session/rename',{sessionId:otherId,title:'Other failure test'});other=await follow(runtime,otherId);
 queue('other-save','memory_apply',change);await prompt(runtime,other,otherId,'Remember this preference in my other session.');
 assert.equal(operations.filter(p=>p.request?.operation==='apply').length,2,'another Session is unaffected');
 queue('new-human-save','memory_apply',change);await prompt(runtime,stream,sessionId,'Try saving my preference again.');
 assert.equal(operations.filter(p=>p.request?.operation==='apply').length,3,'new real human message restores tool work');
 const calls=operations.filter(p=>p.request?.operation==='apply'&&p.sessionId===sessionId);
 assert.notEqual(calls[0].userMessage.id,calls[1].userMessage.id);
 assert.ok(bodies.at(-2).tools.some(t=>t.function.name==='memory_apply'),'new human request immediately receives restored tool schema');
});

test('native revision conflict requires a successful memory read before retry and read errors do not pause all tools', {timeout:60000}, async t=>{
 const temp=await realpath(await mkdtemp(path.join(tmpdir(),'mind-memory-cas-')));
 const bodies=[],operations=[];let runtime,stream,attempts=0,reads=0;
 const provider=await startLocalProvider({onSyntheticRequest:body=>bodies.push(body)});
 t.after(async()=>{await stream?.close();await runtime?.stop();await provider.close();await rm(temp,{recursive:true,force:true});});
 runtime=await launch(path.join(temp,'history'),undefined,{name:'Local',baseUrl:provider.url,modelId:'local-test-model',apiKey:'local-integration-key',supportsImage:false},undefined,undefined,async p=>{
  operations.push(p);if(p.operation==='memoryAdoption')return null;
  if(p.request.operation==='context')return {facts:[],suppressed:[],omittedIds:[]};
  if(p.request.operation==='list'){if(++reads===1)throw new Error('Read temporarily unavailable');return {facts:[{id:'fact',revision:2,content:'current'}]};}
  if(p.request.operation==='apply'){if(++attempts===1)throw new Error('Memory revision conflict');return {facts:[],receipt:'saved with refreshed revision',pending:false};}
 },{id:randomUUID(),name:'Memory CAS',directory:temp});
 const {sessionId}=await runtime.rpc('session/create',{});await runtime.rpc('session/rename',{sessionId,title:'Failure state test'});stream=await follow(runtime,sessionId);
 const queue=(id,name,args)=>provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const change=revision=>({changes:[{action:'patch',scope:{kind:'workspace'},id:'fact',expectedRevision:revision,content:'corrected'}]});
 queue('conflict','memory_apply',change(1));queue('too-soon','memory_apply',change(1));
 queue('failed-read','memory_read',{});queue('still-too-soon','memory_apply',change(2));
 queue('fresh-read','memory_read',{});queue('fresh-retry','memory_apply',change(2));
 await prompt(runtime,stream,sessionId,'Correct the saved preference.');
 assert.equal(attempts,2);assert.equal(reads,2);
 assert.equal(operations.filter(p=>p.request?.operation==='apply').at(-1).request.changes[0].expectedRevision,2);
 for(const body of bodies)assert.ok(body.tools.some(t=>t.function.name==='memory_read'),'CAS and read failures retain read tools');
 assert.match(JSON.stringify(bodies[2].messages),/call memory_read successfully before retrying/);
 assert.match(JSON.stringify(bodies[4].messages),/call memory_read successfully before retrying/);
 assert.match(JSON.stringify(bodies.at(-1).messages),/saved with refreshed revision/);
 assert.ok(!JSON.stringify(bodies.at(-1).messages.findLast(m=>JSON.stringify(m.content).includes('Current authoritative memory'))).includes('writeFailure'));
});

test('memory_read resolves only a native fact source to the actual bounded historical user message', {timeout:60000}, async t=>{
 const temp=await realpath(await mkdtemp(path.join(tmpdir(),'mind-memory-original-')));
 const bodies=[];let runtime,stream,source;
 const provider=await startLocalProvider({onSyntheticRequest:body=>bodies.push(body)});
 t.after(async()=>{await stream?.close();await runtime?.stop();await provider.close();await rm(temp,{recursive:true,force:true});});
 runtime=await launch(path.join(temp,'history'),undefined,{name:'Local',baseUrl:provider.url,modelId:'local-test-model',apiKey:'local-integration-key',supportsImage:false},undefined,undefined,async p=>{
  if(p.operation==='memoryAdoption')return null;
  if(p.request.operation==='context')return {facts:[],suppressed:[],omittedIds:[]};
  assert.equal(p.request.operation,'list');
  return {facts:[{id:'native-fact',revision:1,content:'saved conclusion',sources:[source]}]};
 },{id:randomUUID(),name:'Original memory source',directory:temp});
 const {sessionId}=await runtime.rpc('session/create',{});await runtime.rpc('session/rename',{sessionId,title:'Original message'});stream=await follow(runtime,sessionId);
 await prompt(runtime,stream,sessionId,'原始消息：甲乙丙丁戊己庚辛。');
 const human=events(stream).find(e=>e.type==='user/message'&&e.data.source.kind==='user');
 source={id:'native-message-anchor',kind:'message',scope:{kind:'workspace'},sessionId,messageId:human.data.id,excerpt:'wrong saved excerpt'};
 const queue=(id,args)=>provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id,type:'function',function:{name:'memory_read',arguments:JSON.stringify(args)}}]});
 queue('original',{id:'native-fact',source_id:source.id,offset:5,limit:4});
 queue('forged',{id:'native-fact',source_id:'model-invented-source',offset:0,limit:10});
 await prompt(runtime,stream,sessionId,'Read the original evidence for this saved conclusion.');
 const result=events(stream).find(e=>e.type==='tool/result'&&e.data.message.toolCallId==='original');
 const encoded=result.data.message.content.find(b=>b.type==='text').text;
 const parsed=JSON.parse(encoded.slice('<mind-memory-result>'.length,-'</mind-memory-result>'.length));
 assert.deepEqual(parsed.original,{availability:'available',historical:true,sessionId,messageId:human.data.id,text:'甲乙丙丁',offset:5,totalChars:14,nextOffset:9});
 assert.notEqual(parsed.original.text,source.excerpt);
 const forged=events(stream).find(e=>e.type==='tool/result'&&e.data.message.toolCallId==='forged');
 assert.equal(forged.data.message.isError,true);assert.match(JSON.stringify(forged),/does not belong/);
});

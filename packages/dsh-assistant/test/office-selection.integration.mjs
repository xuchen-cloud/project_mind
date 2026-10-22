import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {startLocalProvider} from './fixtures/local-provider.mjs';

// Real Node DSH process, authenticated RPC, mux events and provider SSE.
// Only the parent NativeSourceBridge responder is a fixture: this is not native GUI acceptance.
// Run with Node >=22.19: node --test packages/dsh-assistant/test/office-selection.integration.mjs
const root=fileURLToPath(new URL('..',import.meta.url));
const redact=text=>String(text).replace(/([?&]token=)[^\s"'<>]+/g,'$1[redacted]').replaceAll('local-integration-key','[redacted]');
// Explicit sensitivity check; does not modify runtime files or replace any DSH service.
const disableRegistration=process.env.OFFICE_SELECTION_DISABLE_REGISTRATION==='1';
const registrationMutant='data:text/javascript,'+encodeURIComponent(`import {registerHooks} from 'node:module';registerHooks({load(url,context,next){const result=next(url,context);if(url.endsWith('/scripts/runtime.mjs'))return {...result,source:String(result.source).replace('await installOfficeSelectionService(ctx, context, sourceBridge);','')};return result}});`);
async function waitFor(read, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

async function launch(data, patch, sharedProvider, project, sourceHandler, workspace) {
  const child = fork(path.join(root, 'scripts/runtime.mjs'), [...(sharedProvider ? ['--embedded'] : []), '--port', '0', '--no-open'], {
    cwd: root, execArgv: disableRegistration ? ['--import', registrationMutant] : [], silent: true,
    env: { ...process.env, PROJECT_MIND_DSH_USER_DATA: data, PROJECT_MIND_DSH_SKILLS_DATA: path.join(path.dirname(data), 'skill-management'),
      ...((project || workspace) ? { PROJECT_MIND_DSH_PROFILE_DIR: path.join(path.dirname(data), 'shared-profile') } : {}),
      ...(patch ? { PROJECT_MIND_DSH_PATCH: patch } : {}), LOCAL_TEST_KEY: 'local-integration-key' },
  });
  if (sharedProvider) child.stdin.write(JSON.stringify({ type: 'configure', provider: { ...sharedProvider, providers: undefined }, providers: sharedProvider.providers, ...(workspace ? { workspace } : { project }) }) + '\n');
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

async function prompt(runtime, stream, sessionId, text, expectedKind = 'completed') {
  const from = stream.frames.length;
  const result = await runtime.rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] });
  assert.deepEqual(result, { accepted: true });
  const end = await stream.read((frame) => stream.frames.indexOf(frame) >= from && frame.type === 'event' && frame.event.type === 'turn/end', `turn completion: ${text}`);
  assert.equal(end.event.data.reason.kind, expectedKind, JSON.stringify(end.event.data.reason));
  return end.event;
}


function toolReply(bodies,callId){
 const reply=bodies.at(-1)?.messages.find(message=>message.role==='tool'&&message.tool_call_id===callId);
 assert.ok(reply,`provider receives actual DSH tool result ${callId}`);
 return typeof reply.content==='string'?reply.content:reply.content.filter(block=>block.type==='text').map(block=>block.text).join('');
}
function requestEdit(provider,callId){
 provider.enqueueResponse({chunks:[''],toolCalls:[{index:0,id:callId,type:'function',function:{name:'office_selection_edit',arguments:JSON.stringify({selection_id:'bound-selection',change:{text:'Revised draft'}})}}]});
}
for(const mode of ['workspace-write','danger-full-access','read-only'])test(`Office selection real Session resolves ${mode} policy`,{timeout:60000},async t=>{
 const temp=await realpath(await mkdtemp(path.join(tmpdir(),'mind-selection-'))),bodies=[],operations=[];
 const provider=await startLocalProvider({onSyntheticRequest:body=>bodies.push(body)});
 let runtime,stream;
 t.after(async()=>{try{await stream?.close()}finally{try{await runtime?.stop()}finally{await provider.close();await rm(temp,{recursive:true,force:true})}}});
 const patch=path.join(temp,'policy.yml');await writeFile(patch,`- id: sandbox-policy\n  config:\n    mode: ${mode}\n`);
 const project={id:212,name:'Office selection integration',directory:temp};
 const snapshot={selectionId:'bound-selection',format:'docx',fileName:'fixture.docx',text:'Unsaved selected text',saved:false};
 runtime=await launch(path.join(temp,'data'),patch,{name:'Selection fixture',modelId:'local-test-model',baseUrl:provider.url,apiKey:'local-integration-key',supportsImage:false},project,payload=>{
  operations.push(payload);
  if(payload.operation==='officeSelectionRead')return snapshot;
  if(payload.operation==='officeSelectionApply')return {selectionId:payload.selectionId,text:'Revised draft',saved:false};
  throw Error(`Unexpected source operation: ${payload.operation}`);
 });
 const {sessionId}=await runtime.rpc('session/create',{});await runtime.rpc('session/rename',{sessionId,title:'Selection fixture'});
 stream=await follow(runtime,sessionId);assert.equal(stream.snapshot.header.cwd,temp);
 const prepared=await runtime.rpc('mind/office-selection/prepare',{sessionId,selectionId:snapshot.selectionId});
 assert.equal(prepared.projection,`<mind-office-selection>${JSON.stringify(snapshot)}</mind-office-selection>`);
 assert.deepEqual(operations,[{operation:'officeSelectionRead',sessionId,selectionId:'bound-selection'}]);
 requestEdit(provider,'selection-edit');
 await prompt(runtime,stream,sessionId,`Revise the attached selection.\n${prepared.projection}`);
 const names=bodies[0].tools.map(tool=>tool.function.name);
 assert.ok(names.includes('office_selection_read'));assert.ok(names.includes('office_selection_edit'));
 assert.ok(JSON.stringify(bodies[0].messages.filter(message=>message.role==='user')).includes('Unsaved selected text'),'prepared bound snapshot reaches actual model input');
 const result=toolReply(bodies,'selection-edit');
 if(mode==='read-only'){
  assert.match(result,/只读/);
  assert.equal(operations.filter(operation=>operation.operation==='officeSelectionApply').length,0,'readonly never dispatches native Apply');
 }else{
  assert.deepEqual(operations.at(-1),{operation:'officeSelectionApply',sessionId,selectionId:'bound-selection',requestId:'selection-edit',mode,change:{text:'Revised draft'}},result);
  assert.deepEqual(JSON.parse(result),{selectionId:'bound-selection',text:'Revised draft',saved:false});
 }
});

test('Workspace Session exposes neither Office selection tools nor preparation route',{timeout:60000},async t=>{
 const temp=await realpath(await mkdtemp(path.join(tmpdir(),'mind-selection-workspace-'))),bodies=[],operations=[];
 const provider=await startLocalProvider({onSyntheticRequest:body=>bodies.push(body)});let runtime,stream;
 t.after(async()=>{try{await stream?.close()}finally{try{await runtime?.stop()}finally{await provider.close();await rm(temp,{recursive:true,force:true})}}});
 runtime=await launch(path.join(temp,'data'),undefined,{name:'Workspace fixture',modelId:'local-test-model',baseUrl:provider.url,apiKey:'local-integration-key',supportsImage:false},undefined,payload=>{operations.push(payload);throw Error('Workspace must not dispatch Office bridge')},{id:randomUUID(),name:'Workspace fixture',directory:temp});
 const {sessionId}=await runtime.rpc('session/create',{});await runtime.rpc('session/rename',{sessionId,title:'Workspace selection boundary'});stream=await follow(runtime,sessionId);
 await prompt(runtime,stream,sessionId,'List available capabilities');
 assert.deepEqual(bodies[0].tools.filter(tool=>tool.function.name.startsWith('office_selection_')),[]);
 const response=await fetch(`${runtime.origin}/api/mind/office-selection/prepare`,{method:'POST',headers:{...runtime.headers,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'mind/office-selection/prepare',payload:{args:{request:{sessionId,selectionId:'bound-selection'}}}})});
 assert.equal(response.status,404);await response.arrayBuffer();assert.deepEqual(operations,[]);
});

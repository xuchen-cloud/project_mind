import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';
import { createStableSessionFork } from '../scripts/session-fork.mjs';
const childSessionId = 'session-10000000-0000-4000-8000-000000000001';
function fixture() {
  const owner = {kind:'project',id:7,workspaceId:'mapped',directory:'/project'};
  const rows = new Map([['parent',{header:{id:'parent',cwd:'/project'},events:[{type:'turn/end',seq:0,time:1,data:{turnId:'t'}}],projections:{values:{}}}]]);
  const attached = new Set(); let creations=0, flushes=0, attachFailure=false, readFailure=false;
  const ctx = {
    sessionQuery:{async observeSession(id) { if(readFailure) throw new Error('disk unavailable'); const row=rows.get(id); if(!row) throw new SessionQueryError('missing','SESSION_QUERY_SESSION_NOT_FOUND'); return {...row,[Symbol.dispose](){}}; }},
    sessionController:{agents:{presetForObservation:o=>o.projections.values.agentPreset,composeAgent:async()=>({setup(){}})}},
    agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},
    agents:{async create(input){creations++;const session={header:{id:input.sessionId,...input.meta},events:input.seed};rows.set(input.sessionId,{...session,projections:{values:{}}});return{agent:{session}};}},
    sessions:{get:id=>rows.get(id),async flush(){flushes++;}},
    workspaceRegistry:{get:()=>({get sessionIds(){return [...attached];},async attachSession(id){if(attachFailure)throw new Error('attach failed');attached.add(id);}})},
  };
  const registry={select:()=>owner,async forSession(id){const row=rows.get(id);if(!row||row.header.cwd!==owner.directory)throw new Error('scope denied');return owner;}};
  const request={context:owner,sessionId:'parent',childSessionId};
  return {ctx,registry,request,rows,attached,stats:()=>({creations,flushes}),failAttach:value=>{attachFailure=value;},failRead:value=>{readFailure=value;}};
}
test('lost response and runtime restart recover the same durable child without creating again',async()=>{
  const f=fixture();let fork=createStableSessionFork(f.ctx,f.registry);
  const result=await fork(f.request);assert.equal(result.sessionId,childSessionId);
  fork=createStableSessionFork(f.ctx,f.registry);
  assert.deepEqual(await fork(f.request),result);
  assert.equal(f.stats().creations,1);assert.equal(f.rows.get(childSessionId).header.parentSession,'parent');
  assert.equal(f.rows.get(childSessionId).events[1].type,'session/end-seed');assert.ok(f.attached.has(childSessionId));
});
test('attachment failure leaves a durable child and retry only repairs membership',async()=>{
  const f=fixture();const fork=createStableSessionFork(f.ctx,f.registry);f.failAttach(true);
  await assert.rejects(fork(f.request),/attach failed/);assert.ok(f.rows.has(childSessionId));assert.equal(f.stats().flushes,1);
  f.failAttach(false);await fork(f.request);assert.equal(f.stats().creations,1);assert.ok(f.attached.has(childSessionId));
});
test('concurrent retries share one creation; reusing the child with another parent conflicts',async()=>{
  const f=fixture();const fork=createStableSessionFork(f.ctx,f.registry);
  await Promise.all([fork(f.request),fork(f.request)]);assert.equal(f.stats().creations,1);
  f.rows.set('other',{...f.rows.get('parent'),header:{id:'other',cwd:'/project'}});
  await assert.rejects(fork({...f.request,sessionId:'other'}),/another fork/);
  assert.equal(f.stats().creations,1);
});
test('a foreign child, corrupt read or invalid child identity never starts creation',async()=>{
  const f=fixture();const fork=createStableSessionFork(f.ctx,f.registry);
  f.rows.set(childSessionId,{header:{id:childSessionId,cwd:'/foreign',parentSession:'parent'},events:[],projections:{values:{}}});
  await assert.rejects(fork(f.request),/another fork|scope denied/);f.rows.delete(childSessionId);
  f.failRead(true);await assert.rejects(fork(f.request),/disk unavailable/);f.failRead(false);
  await assert.rejects(fork({...f.request,childSessionId:'../unsafe'}),/child identity/);assert.equal(f.stats().creations,0);
});
test('pre-admission cancellation creates nothing; response cancellation after creation does not duplicate',async()=>{
  const f=fixture();const fork=createStableSessionFork(f.ctx,f.registry);const controller=new AbortController();controller.abort();
  await assert.rejects(fork(f.request,controller.signal),/abort/i);assert.equal(f.stats().creations,0);
  const afterCreate=new AbortController();const create=f.ctx.agents.create;
  f.ctx.agents.create=async input=>{const handle=await create(input);afterCreate.abort();return handle;};
  await fork(f.request,afterCreate.signal);await fork(f.request);assert.equal(f.stats().creations,1);assert.ok(f.attached.has(childSessionId));
});
test('a durability failure retries the same child before repairing attachment',async()=>{
  const f=fixture();const fork=createStableSessionFork(f.ctx,f.registry);const flush=f.ctx.sessions.flush;let fail=true;
  f.ctx.sessions.flush=async session=>{if(fail)throw new Error('flush failed');return flush(session);};
  await assert.rejects(fork(f.request),/flush failed/);assert.equal(f.stats().creations,1);assert.equal(f.attached.size,0);
  fail=false;await fork(f.request);assert.equal(f.stats().creations,1);assert.ok(f.attached.has(childSessionId));
});
test('the omitted boundary includes completed-prefix metadata and excludes the new open turn',async()=>{
  const f=fixture();f.rows.get('parent').events.push({type:'session/title',seq:1,time:2,data:{title:'name'}},{type:'turn/start',seq:2,time:3,data:{turnId:'next'}},{type:'user/message',surfaceOp:'append',seq:3,time:4,data:{}});
  await createStableSessionFork(f.ctx,f.registry)(f.request);
  assert.deepEqual(f.rows.get(childSessionId).events.map(event=>event.type),['turn/end','session/title','session/end-seed']);
});

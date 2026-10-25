import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import SessionReferenceResolver,{formatSessionReferenceMention} from '@deepseek-ai/dsh-session-reference';
import {installSessionReferenceScope,searchContextSessions} from '../scripts/context-session-reads.mjs';

test('pinned resolver remote exports and public agent/pre-step URI handling pass through scoped wrappers',async()=>{
 const ctx=new Context();const a={kind:'project',id:1,directory:'/a'},b={kind:'project',id:2,directory:'/b'};
 const agents=[{id:'self-a',session:{header:{cwd:'/a'}}},{id:'self-b',session:{header:{cwd:'/b'}}}];
 const records=[{header:{id:'source-a',cwd:'/a',createdAt:1}},{header:{id:'source-b',cwd:'/b',createdAt:2}}];let reads=0;
 ctx.provide('workspaceRegistry',{archivedSessionIds:[]});
 ctx.provide('sessionQuery',{async listSessions(){return records;},async readSurface(){reads++;throw new Error('Cross-scope history must not be read');}});
 try {
  await ctx.plugin(SessionReferenceResolver);
  const registry={select:context=>context,forAgent:agent=>agent.session.header.cwd==='/a'?a:b,async scopeForSession(id){return id==='source-a'?a:id==='source-b'?b:undefined;},async forSession(id){return this.scopeForSession(id);}};
  installSessionReferenceScope(ctx,registry);
  const signal=new AbortController().signal;
  const [first,second]=await Promise.all(agents.map(agent=>ctx.sessionReferenceResolver.remoteExportCandidates(agent,'',signal)));
  assert.deepEqual(first.map(item=>item.sessionId),['source-a']);assert.deepEqual(second.map(item=>item.sessionId),['source-b']);
  const mention=formatSessionReferenceMention({sessionId:'source-b',label:'forged source'});
  await assert.rejects(ctx.waterfall('agent/pre-step',{agent:agents[0],signal},()=>({kind:'continue',messages:[{id:'message',role:'user',source:{kind:'user'},content:[{type:'text',text:mention}]}]})),/another context/);
  assert.equal(reads,0);
 } finally {await ctx.fiber.dispose();}
});
test('real index-disabled query service supports scoped current-surface literal searches',async()=>{
 const ctx=new Context();const a={kind:'project',id:1,directory:'/a'},b={kind:'project',id:2,directory:'/b'};
 try {
  await ctx.plugin(SessionStore);await ctx.plugin(SqliteSessionQuery,{path:':memory:',openAt:'never'});
  for(const [id,cwd] of [['source-a','/a'],['source-b','/b'],['archived','/a']]) {
   const data=createUserMessage({content:[{type:'text',text:'Shared\n  search phrase'}],source:{kind:'user'}});
   ctx.sessions.create(id,{meta:{cwd},seed:[{type:'turn/start',seq:0,time:1,data:{turn:1}},{type:'step/start',seq:1,time:1,data:{turn:1,step:1}},{type:'user/message',seq:2,time:1,data,surfaceOp:'append'},{type:'step/end',seq:3,time:1,data:{turn:1,step:1}},{type:'turn/end',seq:4,time:1,data:{turn:1,reason:{kind:'interrupted'}}}]});
  }
  ctx.provide('workspaceRegistry',{archivedSessionIds:['archived']});
  const scope=id=>ctx.sessions.get(id)?.header.cwd==='/a'?a:b;
  const registry={select:context=>context,async forSession(id){return scope(id);},async snapshot(context){return {items:[{sessionIds:ctx.sessions.list().filter(session=>session.header.cwd===context.directory).map(session=>session.id)}]};}};
  await assert.rejects(ctx.sessionQuery.searchSessions({query:'search'}),/disabled/);
  const [first,second]=await Promise.all([searchContextSessions(ctx,registry,a,{query:'shared search phrase'}),searchContextSessions(ctx,registry,b,{query:'SHARED   search PHRASE'})]);
  assert.deepEqual(first.items.map(item=>item.sessionId),['source-a']);assert.deepEqual(second.items.map(item=>item.sessionId),['source-b']);
  assert.equal(first.hasMore,false);assert.match(first.items[0].snippet,/Shared/);
 } finally {await ctx.fiber.dispose();}
});

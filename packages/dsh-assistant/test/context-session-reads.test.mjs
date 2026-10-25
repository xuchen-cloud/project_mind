import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchContextSessions,installSessionReferenceScope} from '../scripts/context-session-reads.mjs';
const a={kind:'project',id:1,directory:'/a'},b={kind:'project',id:2,directory:'/b'};
const agentA={id:'self-a',session:{header:{cwd:'/a'}}},agentB={id:'self-b',session:{header:{cwd:'/b'}}};
function fixture(search=async()=>({items:[]})) {
 const owners=new Map([['self-a',a],['self-b',b],['source-a',a],['source-b',b],['archived',a]]),calls=[],prepared=[];
 const registry={select(context){return context;},forAgent(agent){return agent.session.header.cwd==='/a'?a:b;},async scopeForSession(id){return owners.get(id);},async forSession(id){return owners.get(id);},async snapshot(){return {items:[{sessionIds:[...owners.keys()].filter(id=>!id.startsWith('self-'))}]};}};
 const resolver={async listCandidates(){return [{sessionId:'source-a'},{sessionId:'source-b'}];},async remoteExportCandidates(agent,query,signal){return (await this.listCandidates(agent,query,20,signal)).map(item=>({...item,mention:item.sessionId}));},async prepare(agent,content,references){prepared.push({agent,content,references});return {content,additionalContext:{references}};}};
 const ctx={sessionQuery:{async filterEvents(id,filters){calls.push([id,filters]);return search(id,filters,calls.length);}},workspaceRegistry:{archivedSessionIds:['archived']},sessionReferenceResolver:resolver};
 return {ctx,registry,owners,calls,prepared,resolver};
}
const document=(id,text='hello')=>({sessionId:id,type:'user/message',surface:'current',text});
test('search scans public semantic filters only for true scope IDs and excludes archives',async()=>{
 const f=fixture(async id=>[document(id,'😀'.repeat(241))]);
 const result=await searchContextSessions(f.ctx,f.registry,a,{query:' hello '},new AbortController().signal);
 assert.equal(result.items.length,1);assert.equal([...result.items[0].snippet].length,240);assert.equal(result.items[0].sessionId,'source-a');assert.equal(result.hasMore,false);
 assert.deepEqual(f.calls,[[ 'source-a', [{kind:'type',values:['user/message','assistant/message']},{kind:'surface',values:['current']},{kind:'text',text:'hello'}] ]]);
});
test('search preserves scope catalog order, deduplicates and reads only21 matching sessions',async()=>{
 const f=fixture(async id=>[document(id)]);f.owners.clear();
 for(let i=0;i<30;i++)f.owners.set(`a-${i}`,a);
 f.registry.snapshot=async()=>({items:[{sessionIds:['a-0',...f.owners.keys()]}]});
 const result=await searchContextSessions(f.ctx,f.registry,a,{query:'find'});
 assert.deepEqual(result.items.map(item=>item.sessionId),Array.from({length:20},(_,i)=>`a-${i}`));assert.equal(result.hasMore,true);assert.equal(f.calls.length,21);
});
test('search rejects stale ownership after read, invalid queries and real filter failures',async()=>{
 const f=fixture(async id=>{f.owners.set(id,b);return [document(id)];});
 assert.deepEqual(await searchContextSessions(f.ctx,f.registry,a,{query:'find'}),{items:[],hasMore:false});
 await assert.rejects(searchContextSessions(f.ctx,f.registry,a,{query:''}),/nonempty/);
 const failed=fixture(async()=>{throw Error('storage failed');});await assert.rejects(searchContextSessions(failed.ctx,failed.registry,a,{query:'find'}),/storage failed/);
});
test('reference candidates and remote mention exports isolate simultaneous agents',async()=>{
 const f=fixture();installSessionReferenceScope(f.ctx,f.registry);
 const [first,second]=await Promise.all([f.resolver.listCandidates(agentA),f.resolver.remoteExportCandidates(agentB,'',new AbortController().signal)]);
 assert.deepEqual(first,[{sessionId:'source-a'}]);assert.deepEqual(second,[{sessionId:'source-b',mention:'source-b'}]);
});
test('forged references reject before original prepare, while both same-scope agents prepare concurrently',async()=>{
 const f=fixture();installSessionReferenceScope(f.ctx,f.registry);
 await assert.rejects(f.resolver.prepare(agentA,[],[{sessionId:'source-b',cwd:'/a'}]),/another context/);assert.equal(f.prepared.length,0);
 await Promise.all([f.resolver.prepare(agentA,[],[{sessionId:'source-a'}]),f.resolver.prepare(agentB,[],[{sessionId:'source-b'}])]);assert.equal(f.prepared.length,2);
});
test('agent ownership changes across candidate and reference awaits reject stale publication',async()=>{
 const f=fixture();let release;const pending=new Promise(resolve=>{release=resolve;});f.resolver.listCandidates=async()=>{await pending;return [{sessionId:'source-a'}];};installSessionReferenceScope(f.ctx,f.registry);
 const target={...agentA,session:{header:{cwd:'/a'}}};const result=f.resolver.listCandidates(target);target.session.header.cwd='/b';release();await assert.rejects(result,/context.*changed/);
});

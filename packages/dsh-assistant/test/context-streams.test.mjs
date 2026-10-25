import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installContextStreams} from '../scripts/context-streams.mjs';
const workspace={kind:'workspace',id:'w',directory:'/w'},a={kind:'project',id:1,directory:'/a',workspaceId:'project:1'},b={kind:'project',id:2,directory:'/b',workspaceId:'project:2'};
const marker=context=>({kind:context.kind,id:context.id});
function setup(frames) {
 const calls=[],results=[],owners=new Map([['s-a',a],['archived-a',a],['s-b',b]]);
 let finish;
 const gate=new Promise(resolve=>{finish=resolve;});
 const gateway={async openWireStream(...args) {calls.push(args);return (async function*(){yield* (typeof frames==='function'?frames(calls.length):frames);await gate;})();},async dispatchRpc(...args){results.push(args);return {ok:true,value:undefined};}};
 const registry={workspace,select(value){const selected=[workspace,a,b].find(item=>item.kind===value.kind&&item.id===value.id);if(!selected)throw Error('unknown');return selected;},async scopeForSession(id){return owners.get(id);},async snapshot(context){return {items:[{workspaceId:`${context.kind}:${context.id}`}],archivedSessionIds:context===a?['archived-a']:[],pinnedSessionIds:context===a?['s-a']:[]};}};
 installContextStreams({typertGateway:gateway},registry);
 return {gateway,calls,results,finish,owners};
}
const stream=async(f,endpoint,context)=>f.gateway.openWireStream(endpoint,{args:{},mindContext:marker(context)},null,{},new AbortController().signal,new AbortController());
test('event generators filter actual ownership including archived and waterfall, and cancel only forwarded IDs',async()=>{
 const f=setup([{type:'ready',clientId:'client',host:{}},{type:'emit',event:'api-session/added',args:[{sessionId:'s-b'}]},{type:'emit',event:'api-session/added',args:[{sessionId:'s-a'}]},{type:'emit',event:'api-session/removed',args:['archived-a']},{type:'waterfall',event:'permission',eventId:'foreign',agentId:'s-b'},{type:'cancel',eventId:'foreign'},{type:'waterfall',event:'permission',eventId:'own',agentId:'s-a'},{type:'cancel',eventId:'own'},{type:'emit',event:'other',args:[{sessionId:'s-b'}]}]);
 const iterator=await stream(f,'$events',a);const found=[];f.finish();for await(const value of iterator)found.push(value);
 assert.deepEqual(found.map(frame=>frame.event??frame.type),['ready','api-session/added','api-session/removed','permission','cancel']);
 assert.deepEqual(f.calls[0][1],{args:{}});
});
test('workspace follow keeps one baseline then authorized committed deltas for a connected client',async()=>{
 const own={workspaceId:a.workspaceId,sessionIds:['new-a','s-a'],title:'A'},foreign={workspaceId:b.workspaceId,sessionIds:['s-b']};
 const f=setup([{type:'baseline',value:{items:['foreign']}},{type:'upsert',workspace:foreign},{type:'upsert',workspace:own},
  {type:'remove',workspaceId:b.workspaceId},{type:'order',workspaceIds:[b.workspaceId,a.workspaceId]},
  {type:'archived',archivedSessionIds:['s-b','archived-a']},{type:'pinned',pinnedSessionIds:['s-b','s-a']}]);f.finish();
 const found=[];for await(const frame of await stream(f,'workspace/follow',a))found.push(frame);
 assert.deepEqual(found,[{type:'baseline',value:{items:[{workspaceId:'project:1'}],archivedSessionIds:['archived-a'],pinnedSessionIds:['s-a']}},
  {type:'upsert',workspace:own},{type:'order',workspaceIds:[a.workspaceId]},
  {type:'archived',archivedSessionIds:['archived-a']},{type:'pinned',pinnedSessionIds:['s-a']}]);
});
test('event result RPC must match active client scope and a delivered event, cleans mapping on close',async()=>{
 const f=setup([{type:'ready',clientId:'client',host:{}},{type:'waterfall',event:'permission',eventId:'event',agentId:'s-a'}]);
 const iterator=await stream(f,'$events',a);await iterator.next();await iterator.next();
 const payload=context=>({args:{clientId:'client',eventId:'event',outcome:{kind:'next'}},mindContext:marker(context)});
 assert.equal((await f.gateway.dispatchRpc('$events/result',payload(b))).ok,false);
 assert.equal((await f.gateway.dispatchRpc('$events/result',{...payload(a),args:{...payload(a).args,eventId:'undelivered'}})).ok,false);
 assert.equal(f.results.length,0);
 assert.equal((await f.gateway.dispatchRpc('$events/result',payload(a))).ok,true);assert.deepEqual(f.results[0][1],{args:payload(a).args});
 await iterator.return();assert.equal((await f.gateway.dispatchRpc('$events/result',payload(a))).ok,false);
});
test('unrelated streams and RPC retain original payload and transport arguments',async()=>{
 const f=setup([]);f.finish();const payload={args:{x:1}},signal=new AbortController().signal,peer={id:'peer'},control=new AbortController();
 await f.gateway.openWireStream('session/follow',payload,'uplink',peer,signal,control);assert.deepEqual(f.calls[0],['session/follow',payload,'uplink',peer,signal,control]);
 await f.gateway.dispatchRpc('session/get',payload,signal,peer);assert.deepEqual(f.results[0],['session/get',payload,signal,peer]);
});
test('two concurrent event streams correlate results with their own delivered event and client',async()=>{
 const f=setup(index=>[{type:'ready',clientId:`client-${index}`,host:{}},{type:'waterfall',event:'permission',eventId:'a-event',agentId:'s-a'},{type:'waterfall',event:'permission',eventId:'b-event',agentId:'s-b'}]);
 const first=await stream(f,'$events',a);assert.equal((await first.next()).value.clientId,'client-1');assert.equal((await first.next()).value.eventId,'a-event');
 const second=await stream(f,'$events',b);assert.equal((await second.next()).value.clientId,'client-2');assert.equal((await second.next()).value.eventId,'b-event');
 const result=(context,clientId,eventId)=>f.gateway.dispatchRpc('$events/result',{mindContext:marker(context),args:{clientId,eventId,outcome:{kind:'next'}}});
 assert.equal((await result(a,'client-2','b-event')).ok,false);
 assert.equal((await result(a,'client-1','b-event')).ok,false);
 assert.equal((await result(b,'client-2','b-event')).ok,true);
 assert.equal((await result(a,'client-1','a-event')).ok,true);
 await first.return();await second.return();
});

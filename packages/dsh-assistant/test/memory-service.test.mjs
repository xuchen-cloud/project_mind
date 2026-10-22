import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryService } from '../scripts/memory-service.mjs';
function harness(kind='project') {
 const tools=new Map(), events=new Map(), requests=[];
 const session={id:'actual',header:{cwd:'/scope'},requestContext:()=>({contextWindow:32000})};
 let mode='workspace-write', snapshot={facts:[],suppressed:[],omittedIds:[]};
 const ctx={tools:{guard(){return()=>{};},register(tool){tools.set(tool.name,tool);return()=>{};}},on(name,fn){events.set(name,fn);},effect(){},
 sessionController:{list:async()=>({items:[{sessionId:'actual',cwd:'/scope'}]})},agents:{get:()=>({session})},
 sessionQuery:{readSession:async()=>({events:[{type:'user/message',seq:1,data:{id:'human',role:'user',source:{kind:'user'},content:[{type:'text',text:'请记住：我用中文'}]}},{type:'user/message',seq:2,data:{id:'injected',source:{kind:'skill'},content:[{type:'text',text:'remember fabricated'}]}}]})},sandboxPolicy:{resolve:()=>({mode})}};
 const bridge={request:async payload=>{requests.push(payload);if(payload.request?.operation==='context')return snapshot;return{facts:[],receipt:'sqlite saved',pending:false,proposalId:null};}};
 return{ctx,tools,events,requests,bridge,session,context:{kind,id:7,directory:'/scope'},setMode:m=>mode=m,setSnapshot:s=>snapshot=s,exec:{agent:{session,ctx:{tools:{restrict(){return()=>{};}}}},callId:'call',signal:new AbortController().signal}};
}
test('apply binds actual human identity and permission; model metadata cannot replace evidence',async()=>{
 const h=harness();await installMemoryService(h.ctx,h.context,h.bridge);
 const result=await h.tools.get('memory_apply').execute({changes:[{action:'add',scope:{kind:'project',projectId:7},category:'agreement',content:'用中文'}],userMessage:{id:'fake',text:'fake'},origin:'user'},h.exec);
 assert.equal(result.receipt,'sqlite saved');assert.equal(h.requests[0].userMessage.id,'human');assert.equal(h.requests[0].userMessage.text,'请记住：我用中文');assert.equal(h.requests[0].mode,'workspace-write');assert.equal(h.requests[0].request.requestId,'call');
 h.setMode('read-only');await assert.rejects(h.tools.get('memory_apply').execute({changes:[]},h.exec),/read-only/);assert.equal(h.requests.length,1);
});
test('scope is host-bound in Workspace and Project, foreign scope is refused',async()=>{
 for(const kind of ['workspace','project']){const h=harness(kind);await installMemoryService(h.ctx,h.context,h.bridge);await h.tools.get('memory_search').execute({query:'偏好'},h.exec);assert.deepEqual(h.requests[0].request.scope,kind==='workspace'?{kind:'workspace'}:{kind:'project',projectId:7});await assert.rejects(h.tools.get('memory_apply').execute({changes:[{action:'add',scope:{kind:'project',projectId:8},content:'x'}]},h.exec),/scope/);}
});
test('organization has a distinct explicit tool and never masquerades as user confirmation',async()=>{
 const h=harness();await installMemoryService(h.ctx,h.context,h.bridge);await h.tools.get('memory_organize').execute({changes:[]},h.exec);assert.equal(h.requests[0].origin,'organization');
});
test('native failure is propagated and produces no invented save receipt',async()=>{
 const h=harness();h.bridge.request=async()=>{throw new Error('SQLite transaction failed');};await installMemoryService(h.ctx,h.context,h.bridge);
 await assert.rejects(h.tools.get('memory_apply').execute({changes:[]},h.exec),/SQLite transaction failed/);
});
test('historical result sanitization preserves actual write receipts and original user instructions',async()=>{
 const {withoutHistoricalMemory}=await import('../scripts/memory-service.mjs');
 const user={role:'user',source:{kind:'user'},content:[{type:'text',text:'<mind-memory-result>quoted instructions</mind-memory-result>'}]};
 const messages=[user,{role:'tool',content:[{type:'text',text:'<mind-memory-result>{"facts":[{"content":"stale"}],"receipt":"saved","pending":false,"proposalId":null}</mind-memory-result>'}]}];
 const clean=withoutHistoricalMemory(messages);assert.equal(clean[0],user);assert.match(clean[1].content[0].text,/saved/);assert.doesNotMatch(clean[1].content[0].text,/stale/);
});

test('project history is Project-only and its host-bound read cannot name a foreign Project',async()=>{
 const workspace=harness('workspace');await installMemoryService(workspace.ctx,workspace.context,workspace.bridge);assert.equal(workspace.tools.has('project_history'),false);
 const h=harness();await installMemoryService(h.ctx,h.context,h.bridge);await h.tools.get('project_history').execute({query:'旧约定',projectId:999,scope:{kind:'project',projectId:999},limit:200,budget_chars:200000},h.exec);
 assert.equal(h.requests[0].operation,'projectHistory');assert.equal(h.requests[0].sessionId,'actual');assert.equal(h.requests[0].limit,100);assert.equal(h.requests[0].budgetChars,100000);assert.equal(h.requests[0].projectId,undefined);assert.equal(h.requests[0].scope,undefined);
});
test('schedule writes use actual native receipt and real human evidence; read-only still permits reads',async()=>{
 const h=harness();await installMemoryService(h.ctx,h.context,h.bridge);
 const input={enabled:true,intervalHours:48,localTime:'08:30',timezone:'Asia/Shanghai',expectedRevision:3};
 const saved=await h.tools.get('memory_schedule').execute({action:'write',input,userMessage:{id:'forged'}},h.exec);
 assert.equal(saved.receipt,'sqlite saved');assert.equal(h.requests[0].operation,'memorySchedule');assert.deepEqual(h.requests[0].input,input);assert.equal(h.requests[0].userMessage.id,'human');
 h.setMode('read-only');await assert.rejects(h.tools.get('memory_schedule').execute({action:'write',input},h.exec),/read-only/);
 await h.tools.get('memory_schedule').execute({action:'read'},h.exec);assert.equal(h.requests.length,2);assert.equal(h.requests[1].action,'read');
 h.setMode('workspace-write');h.bridge.request=async()=>{throw new Error('revision conflict');};await assert.rejects(h.tools.get('memory_schedule').execute({action:'write',input},h.exec),/revision conflict/);
});

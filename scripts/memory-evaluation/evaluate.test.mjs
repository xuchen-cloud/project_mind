import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {complete,run,summarize,validateFixtures,checkFeatures,messagesForArm} from './evaluate.mjs';
const sharedInstructions={memoryPrelude:'Actual production prelude',behavior:'Actual production Skill',scope:{kind:'workspace'}};
const dataset=JSON.parse(await readFile(new URL('./scenarios.json',import.meta.url)));
test('60 independent Chinese multi-turn cases cover all twelve families',()=>{
 assert.equal(dataset.length,60);assert.equal(new Set(dataset.map(x=>x.request)).size,60);
 assert.equal(new Set(dataset.map(x=>x.family)).size,12);
 for(const s of dataset){assert.ok(s.history.filter(m=>m.role==='user').length>=2);assert.ok(s.setup.requiresNativeExecution);for(const p of [...s.checks.required,...s.checks.forbidden])new RegExp(p,'u');}
});
test('no implicit contexts and local fixtures cannot certify semantic behavior',()=>{
 assert.throws(()=>validateFixtures({},dataset),/provenance/);
 assert.throws(()=>validateFixtures({provenance:{kind:'local-provider-fixture'}},dataset),/semantic/);
});
test('feature screening catches omitted and forbidden facts',()=>{
 assert.equal(checkFeatures(dataset.find(s=>s.id==='isolation-1'),'青鸟').required[0].pass,false);
 assert.equal(checkFeatures(dataset.find(s=>s.id==='isolation-1'),'青鸟').forbidden[0].pass,false);
});
test('local HTTP Provider exercises actual streaming usage and TTFT, not semantics',async()=>{
 const received=[];
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;received.push(JSON.parse(body));res.writeHead(200,{'content-type':'text/event-stream'});
 res.write('data: {"choices":[{"delta":{"content":"测试"}}]}\n\n');
 res.end(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:received.at(-1).messages.length*10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
 const scenario=dataset[0],context={context:'仅测试传输，不代表原生上下文',evidence:{}};
 const report=await run({scenarios:[scenario],fixtures:{provenance:{kind:'local-provider-fixture',revision:'selftest',command:'node --test'},cases:{[scenario.id]:{snapshot:context,layered:context,sharedInstructions}}},endpoint:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,key:'local-test-key',model:'transport-fixture',allowFixture:true});
 assert.equal(report.rows.length,3);assert.equal(report.semanticEligible,false);assert.equal(summarize(report).gate,'not-passed');
 assert.ok(report.rows.every(r=>r.ttftMs>=0&&r.inputTokens>0));assert.equal(report.rows.find(r=>r.arm==='snapshot').marginalMemoryInputTokens,10);
 assert.ok(received.every(r=>r.model==='transport-fixture'&&r.messages.at(-1).content===scenario.request));
 assert.ok(received.every(r=>!r.messages.some(m=>m.content===scenario.history[0].content)));
 const resumed=await run({scenarios:[scenario],fixtures:{provenance:{kind:'local-provider-fixture',revision:'selftest',command:'node --test'},cases:{[scenario.id]:{snapshot:context,layered:context,sharedInstructions}}},endpoint:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,key:'local-test-key',model:'transport-fixture',allowFixture:true,concurrency:2,cachedRows:report.rows});
 assert.equal(received.length,3,'resume must not spend additional Provider calls');assert.equal(resumed.rows.length,3);assert.equal(resumed.rows.find(r=>r.arm==='layered').marginalMemoryInputTokens,10);

 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('missing actual usage and HTTP errors fail closed',async()=>{
 const args={endpoint:'http://localhost',key:'private',model:'fixture',messages:[]};
 await assert.rejects(complete({...args,fetchImpl:async()=>new Response('secret', {status:401})}),/^Error: Provider HTTP 401$/);
 await assert.rejects(complete({...args,fetchImpl:async()=>new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n')}),/missing actual/);
});

test('all arms share captured policy and scope without leaking memory to none',()=>{
 const fixture={sharedInstructions:{...sharedInstructions,scope:{kind:'project',projectId:2,projectName:'项目乙'}},snapshot:{context:'{"facts":["秘密事实"],"negativeConstraints":["忘记内容"]}'},layered:{context:'{"facts":[],"negativeConstraints":["忘记内容"]}'}};
 const messages=['none','snapshot','layered'].map(arm=>messagesForArm(dataset[0],fixture,arm));
 assert.deepEqual(messages[0].slice(0,2),messages[1].slice(0,2));assert.deepEqual(messages[1].slice(0,2),messages[2].slice(0,2));
 assert.ok(!JSON.stringify(messages[0]).includes('秘密事实'));assert.ok(!JSON.stringify(messages[0]).includes('忘记内容'));
 assert.equal(messages[1][2].content,sharedInstructions.memoryPrelude+'\n'+fixture.snapshot.context);
 assert.equal(messages[2][2].content,sharedInstructions.memoryPrelude+'\n'+fixture.layered.context);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { installOfficeService } from '../scripts/office-service.mjs';
function harness() {
  const tools = new Map(); const requests=[];
  const ctx={sessionController:{list:async()=>({items:[{sessionId:'actual',cwd:'/project'}]})},tools:{register(tool){tools.set(tool.name,tool);return()=>{};}},effect(){}};
  const bridge={request:async(payload,signal)=>{requests.push({payload,signal});return{sourceRef:{title:'work.docx',fileVersion:2},model:{format:'docx',nodes:[{id:'p0',text:'原文'}],assets:[{dataUrl:'large image'}],document:{content:[]}}};}};
  return{ctx,tools,requests,bridge};
}
test('DSH Office tools resolve a real Session and expose semantic targets without image bytes',async()=>{
  const h=harness();await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
  const signal=new AbortController().signal;
  const result=await h.tools.get('file_office_inspect').execute({file_path:'work.docx'},{agent:{session:{id:'actual'}},callId:'call-1',signal});
  assert.equal(h.requests[0].payload.operation,'officeInspect');assert.equal(h.requests[0].payload.sessionId,'actual');assert.equal(h.requests[0].signal,signal);
  assert.deepEqual(result.model.nodes,[{id:'p0',text:'原文'}]);assert.equal(result.model.assets,undefined);
});
test('DSH Office edits carry the exact source version and deterministic execution identity',async()=>{
  const h=harness();await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
  const sourceRef={object:{id:'42'},revision:'sha256:base',fileVersion:2};const edits=[{type:'text',nodeId:'p0',text:'修改'}];
  const signal=new AbortController().signal;
  await h.tools.get('file_office_edit').execute({source_ref:sourceRef,edits},{agent:{session:{id:'actual'}},callId:'write-1',signal});
  assert.deepEqual(h.requests[0].payload,{operation:'officeEdit',sessionId:'actual',requestId:'write-1',sourceRef,edits});
});
test('DSH Office tools reject calls from a foreign Project Session before accessing File bytes',async()=>{
  const h=harness();await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
  await assert.rejects(h.tools.get('file_office_inspect').execute({file_path:'work.docx'},{agent:{session:{id:'foreign'}},callId:'read-1',signal:new AbortController().signal}),/another Project/);
  assert.equal(h.requests.length,0);
});

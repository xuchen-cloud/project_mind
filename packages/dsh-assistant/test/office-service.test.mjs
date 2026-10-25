import test from 'node:test';
import assert from 'node:assert/strict';
import { installOfficeService } from '../scripts/office-service.mjs';
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { readFileSync } from 'node:fs';
const officeSourceRef=JSON.parse(readFileSync(new URL('./fixtures/office-source-ref.json',import.meta.url),'utf8'));
function harness() {
  const tools = new Map(); const requests=[];
  const ctx={sessionController:{list:async()=>({items:[{sessionId:'actual',cwd:'/project'}]})},tools:{register(tool){tools.set(tool.name,tool);return()=>{};}},effect(){}};
  const bridge={request:async(payload,signal)=>{requests.push({payload,signal});return{sourceRef:structuredClone(officeSourceRef),model:{format:'docx',nodes:[{id:'p0',text:'原文'}],assets:[{dataUrl:'large image'}],document:{content:[]}}};}};
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
  const sourceRef=structuredClone(officeSourceRef);const edits=[{type:'text',nodeId:'p0',text:'修改'}];
  const signal=new AbortController().signal;
  await h.tools.get('file_office_edit').execute({source_ref:sourceRef,edits},{agent:{session:{id:'actual'}},callId:'write-1',signal});
  assert.deepEqual(h.requests[0].payload,{operation:'officeEdit',sessionId:'actual',requestId:'write-1',sourceRef,edits});
});
test('Office edit schema requires the inspect SourceRef object and rejects observed string encodings before native I/O',async()=>{
  const h=harness();await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
  const tool=h.tools.get('file_office_edit');
  assert.equal(tool.parameters.properties.source_ref.type,'object');
  const exec={agent:{session:{id:'actual'}},callId:'schema-check',signal:new AbortController().signal};
  for(const source_ref of [JSON.stringify(officeSourceRef),JSON.stringify(officeSourceRef).replaceAll('"','\\"'),'work.docx',{},
    {...officeSourceRef,object:{...officeSourceRef.object,id:42}}]) {
    await assert.rejects(tool.execute({source_ref,edits:[]},exec),/source_ref/);
  }
  assert.equal(h.requests.length,0);
  await tool.execute({source_ref:officeSourceRef,edits:[]},exec);
  assert.deepEqual(h.requests[0].payload.sourceRef,officeSourceRef);
});
test('DSH Office tools reject calls from a foreign Project Session before accessing File bytes',async()=>{
  const h=harness();await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
  await assert.rejects(h.tools.get('file_office_inspect').execute({file_path:'work.docx'},{agent:{session:{id:'foreign'}},callId:'read-1',signal:new AbortController().signal}),/another Project/);
  assert.equal(h.requests.length,0);
});
test('XLSX inspect and edit expose lossless JSON when veryHidden is absent',async()=>{
  const h=harness();
  const model={format:'xlsx',sheets:[{id:'sheet-1',name:'明细',hidden:false,rowCount:9,columnCount:3}],
    ranges:{'sheet-1':{area:{startRow:0,endRow:8,startColumn:0,endColumn:2},cells:[
      {row:2,column:1,value:25},{row:4,column:1,value:45,formula:'=SUM(B3:B4)'},
    ]}},definedNames:[],rendererData:{file:{binary:'excluded'}}};
  h.bridge.request=async()=>({sourceRef:{title:'work.xlsx',fileVersion:5},model});
  await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
  for(const name of ['file_office_inspect','file_office_edit']) {
    const args=name==='file_office_inspect'?{file_path:'work.xlsx'}:{source_ref:officeSourceRef,edits:[]};
    const result=await h.tools.get(name).execute(args,
      {agent:{session:{id:'actual'}},callId:'json-check',signal:new AbortController().signal});
    assert.equal(isJsonValue(result),true,'the actual tool runtime rejects undefined object properties');
    assert.equal(Object.hasOwn(result.model.sheets[0],'veryHidden'),false);
    assert.equal(result.model.sheets[0].id,'sheet-1');
    assert.equal(result.model.ranges['sheet-1'].cells[0].value,25);
    assert.equal(result.model.rendererData,undefined);
  }
  model.sheets[0].veryHidden=true;
  const result=await h.tools.get('file_office_inspect').execute({file_path:'work.xlsx'},
    {agent:{session:{id:'actual'}},signal:new AbortController().signal});
  assert.equal(result.model.sheets[0].veryHidden,true);
});
test('Workspace Office tools accept both native File scopes while Project tools keep their owner',async()=>{
 const h=harness();await installOfficeService(h.ctx,{kind:'workspace',directory:'/project'},h.bridge);
 const sourceRef=structuredClone(officeSourceRef);sourceRef.object.scope={kind:'workspace'};
 const tool=h.tools.get('file_office_edit'),exec={agent:{session:{id:'actual'}},callId:'workspace-edit',signal:new AbortController().signal};
 await tool.execute({source_ref:sourceRef,edits:[]},exec);
 assert.deepEqual(h.requests[0].payload.sourceRef.object.scope,{kind:'workspace'});
 await tool.execute({source_ref:officeSourceRef,edits:[]},exec);
 assert.equal(h.requests.length,2);
 const p=harness();await installOfficeService(p.ctx,{kind:'project',directory:'/project'},p.bridge);
 await assert.rejects(p.tools.get('file_office_edit').execute({source_ref:sourceRef,edits:[]},exec),/source_ref/);
 assert.equal(p.requests.length,0);
});

test('shared Office tools dispatch both registered scopes and reject unknown Sessions',async()=>{
 const h=harness();const checked=[];
 const registry={async forSession(id,signal){signal.throwIfAborted();checked.push(id);if(!['workspace-session','project-session'].includes(id))throw new Error('Unknown Session');return {kind:id.startsWith('workspace')?'workspace':'project'};}};
 await installOfficeService(h.ctx,registry,h.bridge);
 for(const id of ['workspace-session','project-session'])await h.tools.get('file_office_inspect').execute({file_path:'work.docx'},{agent:{session:{id}},signal:new AbortController().signal});
 const sourceRef=structuredClone(officeSourceRef);sourceRef.object.scope={kind:'workspace'};
 await h.tools.get('file_office_edit').execute({source_ref:sourceRef,edits:[]},{agent:{session:{id:'workspace-session'}},callId:'workspace-edit',signal:new AbortController().signal});
 await assert.rejects(h.tools.get('file_office_inspect').execute({file_path:'work.docx'},{agent:{session:{id:'foreign'}},signal:new AbortController().signal}),/Unknown Session/);
 assert.deepEqual(h.requests.map(({payload})=>payload.sessionId),['workspace-session','project-session','workspace-session']);
 assert.equal(checked.length,4);
});

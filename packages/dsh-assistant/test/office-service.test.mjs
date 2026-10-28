import test from 'node:test';
import assert from 'node:assert/strict';
import { installOfficeService } from '../scripts/office-service.mjs';
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { readFileSync } from 'node:fs';
const officeSourceRef=JSON.parse(readFileSync(new URL('./fixtures/office-source-ref.json',import.meta.url),'utf8'));
function harness() {
  const tools = new Map(); const requests=[];
  const ctx={get:()=>({resolve:()=>({mode:'workspace-write',workspaceRoot:'/project'})}),sessionController:{list:async()=>({items:[{sessionId:'actual',cwd:'/project'}]})},tools:{register(tool){tools.set(tool.name,tool);return()=>{};}},effect(){}};
  const bridge={request:async(payload,signal)=>{requests.push({payload,signal});return{sourceRef:structuredClone(officeSourceRef),model:{format:'docx',nodes:[{id:'p0',text:'原文'}],assets:[{dataUrl:'large image'}],document:{content:[]}}};}};
  return{ctx,tools,requests,bridge};
}

for (const [kind, canonical, native, foreign] of [
  ['UNC', String.raw`\\server\share\项目`, String.raw`\\?\UNC\server\share\项目`, String.raw`\\server\other\项目`],
  ['drive', String.raw`C:\项目`, String.raw`\\?\C:\项目`, String.raw`D:\项目`],
]) {
  for (const [directory, cwd] of [[native, canonical], [canonical, native]]) {
    for (const shared of [true, false]) {
      test(`Windows ${kind} Office ${shared ? 'registry' : 'legacy'} tools preserve path equivalence and write scope (${directory})`, async () => {
        const h = harness(), context = { kind: 'project', directory };
        let mode = 'workspace-write', workspaceRoot = cwd, sessionCwd = cwd;
        h.ctx.get = () => ({ resolve: () => ({ mode, workspaceRoot }) });
        h.ctx.sessionController.list = async () => ({ items: [{ sessionId: 'actual', cwd: sessionCwd }] });
        const registry = { async forSession(id) { if (id !== 'actual') throw new Error('Unknown Session'); return context; } };
        await installOfficeService(h.ctx, shared ? registry : context, h.bridge);
        const exec = { agent: { session: { id: 'actual' } }, callId: 'windows-edit', signal: new AbortController().signal };
        const edit = () => h.tools.get('file_office_edit').execute({ source_ref: officeSourceRef, edits: [] }, exec);
        const create = () => h.tools.get('file_office_create').execute({ name: 'new.docx', content: '<p>内容</p>', request_id: 'windows-create' }, exec);
        await h.tools.get('file_office_inspect').execute({ file_path: 'work.docx' }, exec);
        await edit(); await create();
        assert.deepEqual(h.requests.map(({ payload }) => payload.operation), ['officeInspect', 'officeEdit', 'officeCreate']);
        for (const root of [foreign, directory + String.raw`\child`, String.raw`UNC\server\share\项目`]) {
          workspaceRoot = root;
          await assert.rejects(edit(), /policy belongs/);
          await assert.rejects(create(), /policy belongs/);
        }
        workspaceRoot = cwd; mode = 'read-only';
        await assert.rejects(edit(), /只读/);
        mode = 'workspace-write'; exec.agent.session.id = 'foreign';
        await assert.rejects(edit(), /Unknown Session|another Project/);
        if (!shared) {
          exec.agent.session.id = 'actual'; sessionCwd = foreign;
          await assert.rejects(edit(), /another Project/);
        }
        assert.equal(h.requests.length, 3, 'denied requests never reach native IO');
      });
    }
  }
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
  assert.deepEqual(h.requests[0].payload,{operation:'officeEdit',sessionId:'actual',mode:'workspace-write',requestId:'write-1',sourceRef,edits});
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
 const registry={async forSession(id,signal){signal.throwIfAborted();checked.push(id);if(!['workspace-session','project-session'].includes(id))throw new Error('Unknown Session');return {kind:id.startsWith('workspace')?'workspace':'project',directory:'/project'};}};
 await installOfficeService(h.ctx,registry,h.bridge);
 for(const id of ['workspace-session','project-session'])await h.tools.get('file_office_inspect').execute({file_path:'work.docx'},{agent:{session:{id}},signal:new AbortController().signal});
 const sourceRef=structuredClone(officeSourceRef);sourceRef.object.scope={kind:'workspace'};
 await h.tools.get('file_office_edit').execute({source_ref:sourceRef,edits:[]},{agent:{session:{id:'workspace-session'}},callId:'workspace-edit',signal:new AbortController().signal});
 await assert.rejects(h.tools.get('file_office_inspect').execute({file_path:'work.docx'},{agent:{session:{id:'foreign'}},signal:new AbortController().signal}),/Unknown Session/);
 assert.deepEqual(h.requests.map(({payload})=>payload.sessionId),['workspace-session','project-session','workspace-session']);
 assert.equal(checked.length,4);
});

test('Office creation uses the real writable Session, stable request and native creation result',async()=>{
 const h=harness();
 h.ctx.get=()=>({resolve:()=>({mode:'workspace-write',workspaceRoot:'/project'})});
 await installOfficeService(h.ctx,{kind:'project',directory:'/project'},h.bridge);
 const exec={agent:{session:{id:'actual'}},callId:'different-execution-id',signal:new AbortController().signal};
 const result=await h.tools.get('file_office_create').execute({name:'中文报告.docx',content:'<h1>报告</h1><p>正文</p>',request_id:'stable-create'},exec);
 assert.deepEqual(h.requests[0].payload,{operation:'officeCreate',sessionId:'actual',requestId:'stable-create',mode:'workspace-write',projectId:null,name:'中文报告.docx',content:'<h1>报告</h1><p>正文</p>'});
 assert.equal(result.model.assets,undefined);
 assert.deepEqual(result.model.nodes,[{id:'p0',text:'原文'}]);
 h.ctx.get=()=>({resolve:()=>({mode:'read-only',workspaceRoot:'/project'})});
 await assert.rejects(h.tools.get('file_office_create').execute({name:'x.docx',content:'<p>x</p>',request_id:'read-only'},exec),/只读/);
 assert.equal(h.requests.length,1);
});

test('Office inspection accepts an exact native source reference and rejects ambiguous input',async()=>{
 const h=harness();await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
 const tool=h.tools.get('file_office_inspect'),exec={agent:{session:{id:'actual'}},callId:'fixed-read',signal:new AbortController().signal};
 await tool.execute({source_ref:officeSourceRef},exec);
 assert.deepEqual(h.requests[0].payload,{operation:'officeInspect',sessionId:'actual',sourceRef:officeSourceRef});
 for(const args of [{},{file_path:'work.docx',source_ref:officeSourceRef}])await assert.rejects(tool.execute(args,exec),/exactly one/);
 assert.equal(h.requests.length,1);
});

test('structured Office edits reject a read-only Session before native IO',async()=>{
 const h=harness();h.ctx.get=()=>({resolve:()=>({mode:'read-only',workspaceRoot:'/project'})});
 await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
 await assert.rejects(h.tools.get('file_office_edit').execute({source_ref:officeSourceRef,edits:[{type:'operations',ops:[{op:'set_page_setup',orientation:'landscape'}]}]},
  {agent:{session:{id:'actual'}},callId:'readonly-complex',signal:new AbortController().signal}),/只读/);
 assert.equal(h.requests.length,0);
});

test('Office inspection retains exact semantic table, chart and style targets for complete editing',async()=>{
 const h=harness();
 const model={format:'xlsx',sheets:[{id:'sheet1',name:'销售',hidden:false,rowCount:2,columnCount:2,freeze:{frozenRows:1,frozenColumns:0},tables:[{name:'Sales',range:'A1:B2'}]}],
  styles:[{bold:true}],visuals:[{id:'chart-1',sheetId:'sheet1',kind:'chart',drawingPath:'xl/drawings/drawing1.xml',drawingIndex:0,chartPath:'xl/charts/chart1.xml'}],
  ranges:{sheet1:{area:'A1:B2',cells:[{row:0,column:0,value:'项目',styleIndex:0}],merges:[]}},definedNames:[],warnings:[{code:'FORMULA_UNCACHED',sheetId:'sheet1',row:1,column:1}],rendererData:{media:'PRIVATE_MEDIA'}};
 h.bridge.request=async()=>({model});await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
 const result=await h.tools.get('file_office_inspect').execute({file_path:'Sales.xlsx'},{agent:{session:{id:'actual'}},signal:new AbortController().signal});
 assert.deepEqual(result.model.visuals,model.visuals);assert.deepEqual(result.model.styles,model.styles);
 assert.deepEqual(result.model.sheets[0].tables,model.sheets[0].tables);assert.deepEqual(result.model.sheets[0].freeze,model.sheets[0].freeze);
 assert.equal(result.model.ranges.sheet1.cells[0].styleIndex,0);assert.deepEqual(result.model.warnings,model.warnings);
 assert.ok(!JSON.stringify(result).includes('PRIVATE_MEDIA'));
});

test('oversized Office creation is rejected before the bounded native source transport',async()=>{
 const h=harness();await installOfficeService(h.ctx,{directory:'/project'},h.bridge);
 const exec={agent:{session:{id:'actual'}},signal:new AbortController().signal};
 await assert.rejects(h.tools.get('file_office_create').execute({name:'large.docx',request_id:'large',content:{html:'中'.repeat(700000)}},exec),/2 MiB/);
 assert.equal(h.requests.length,0);
});

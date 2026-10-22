import test from 'node:test';
import assert from 'node:assert/strict';
import { installOfficeSelectionService } from '../scripts/office-selection-service.mjs';

function harness(mode='workspace-write') {
  const tools=new Map(),requests=[],routes=[];
  const ctx={tools:{register(tool){tools.set(tool.name,tool);return()=>{};}},effect(){},
    sessionController:{list:async()=>({items:[{sessionId:'session',cwd:'/project'}]})},
    get:()=>({resolve:()=>({mode,workspaceRoot:'/project'})}),
    connection:{fetch:{register:route=>routes.push(route)}}};
  const bridge={request:async value=>{requests.push(value);return {selectionId:'selection',format:'docx',text:'原文',saved:false};}};
  const exec={agent:{session:{id:'session'}},callId:'call',signal:new AbortController().signal};
  return {ctx,tools,requests,routes,bridge,exec};
}
test('selected editing uses the real Session, resolved write policy and exact call identity',async()=>{
  const h=harness();await installOfficeSelectionService(h.ctx,{directory:'/project'},h.bridge);
  const value=await h.tools.get('office_selection_edit').execute({selection_id:'selection',change:{text:'润色'}},h.exec);
  assert.deepEqual(h.requests,[{operation:'officeSelectionApply',sessionId:'session',selectionId:'selection',requestId:'call',mode:'workspace-write',change:{text:'润色'}}]);
  assert.equal(value.saved,false);
});
test('read-only and foreign sessions cannot modify an editor',async()=>{
  const h=harness('read-only');await installOfficeSelectionService(h.ctx,{directory:'/project'},h.bridge);
  await assert.rejects(h.tools.get('office_selection_edit').execute({selection_id:'selection',change:{text:'bad'}},h.exec),/只读/);
  h.exec.agent.session.id='foreign';
  await assert.rejects(h.tools.get('office_selection_read').execute({selection_id:'selection'},h.exec),/another Project/);
  assert.equal(h.requests.length,0);
});

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

for (const [kind, canonical, native, foreign] of [
  ['UNC', String.raw`\\server\share\项目`, String.raw`\\?\UNC\server\share\项目`, String.raw`\\server\other\项目`],
  ['drive', String.raw`C:\项目`, String.raw`\\?\C:\项目`, String.raw`D:\项目`],
]) {
  for (const [directory, cwd] of [[native, canonical], [canonical, native]]) {
    for (const shared of [true, false]) {
      test(`Windows ${kind} selection ${shared ? 'registry' : 'legacy'} entry points preserve path equivalence and write scope (${directory})`, async () => {
        const h = harness(), context = { directory };
        let mode = 'workspace-write', workspaceRoot = cwd, sessionCwd = cwd;
        h.ctx.get = () => ({ resolve: () => ({ mode, workspaceRoot }) });
        h.ctx.sessionController.list = async () => ({ items: [{ sessionId: 'session', cwd: sessionCwd }] });
        const registry = { async forSession(id) { if (id !== 'session') throw new Error('Unknown Session'); return context; } };
        await installOfficeSelectionService(h.ctx, shared ? registry : context, h.bridge);
        const prepare = async () => (await h.routes[0].fetch(new Request('http://local/api/mind/office-selection/prepare', {
          method: 'POST', body: JSON.stringify({ type: 'client-request', method: 'mind/office-selection/prepare', rpcId: 'windows',
            payload: { args: { request: { sessionId: h.exec.agent.session.id, selectionId: 'selection' } } } }),
        }))).json();
        const edit = () => h.tools.get('office_selection_edit').execute({ selection_id: 'selection', change: { text: '修改' } }, h.exec);
        assert.equal((await prepare()).result.ok, true);
        await h.tools.get('office_selection_read').execute({ selection_id: 'selection' }, h.exec);
        await edit();
        assert.deepEqual(h.requests.map(item => item.operation), ['officeSelectionRead', 'officeSelectionRead', 'officeSelectionApply']);
        for (const root of [foreign, directory + String.raw`\child`, String.raw`UNC\server\share\项目`]) {
          workspaceRoot = root;
          await assert.rejects(edit(), /policy belongs/);
        }
        workspaceRoot = cwd; mode = 'read-only';
        await assert.rejects(edit(), /只读/);
        mode = 'workspace-write'; h.exec.agent.session.id = 'foreign';
        await assert.rejects(edit(), /Unknown Session|another Project/);
        assert.equal((await prepare()).result.ok, false);
        if (!shared) {
          h.exec.agent.session.id = 'session'; sessionCwd = foreign;
          await assert.rejects(edit(), /another Project/);
          assert.equal((await prepare()).result.ok, false);
        }
        assert.equal(h.requests.length, 3, 'denied requests never reach native IO');
      });
    }
  }
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

test('shared runtime resolves each selection Session scope before policy checks',async()=>{
  const h=harness();
  const scopes={session:{directory:'/project'},second:{directory:'/other'}};
  const registry={async forSession(id,signal){signal?.throwIfAborted();if(!scopes[id])throw new Error('Unknown Session');return scopes[id];}};
  await installOfficeSelectionService(h.ctx,registry,h.bridge);
  h.exec.agent.session.id='second';
  await assert.rejects(h.tools.get('office_selection_edit').execute({selection_id:'selection',change:{text:'bad'}},h.exec),/policy/);
  h.ctx.get=()=>({resolve:()=>({mode:'workspace-write',workspaceRoot:'/other'})});
  await h.tools.get('office_selection_edit').execute({selection_id:'selection',change:{text:'ok'}},h.exec);
  assert.equal(h.requests.at(-1).sessionId,'second');
  h.exec.agent.session.id='unknown';
  await assert.rejects(h.tools.get('office_selection_read').execute({selection_id:'selection'},h.exec),/Unknown Session/);
  assert.equal(h.requests.length,1);
});

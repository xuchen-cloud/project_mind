import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain';
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
import {SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session';
import {migrateSharedRuntime,reconcileContextDirectories} from '../scripts/shared-runtime-migration.mjs';
async function boot(home) {
 const ctx=new Context();
 try {
  await ctx.plugin(Storage);
  await ctx.plugin(JsonStorage,{root:path.join(home,'storages')});
  await ctx.plugin(DomainStorage,{backend:'json'});
  await ctx.plugin(SessionPersistence,{root:path.join(home,'sessions')});
  await ctx.plugin(WorkspaceRegistry);
  return ctx;
 } catch(error) {await ctx.fiber.dispose();throw error;}
}
test('pinned rc.2 storage creates, migrates, reopens and retargets real Zstd histories and registry',async t=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'mind-real-migration-'));
 t.after(()=>rm(temporary,{recursive:true,force:true}));const root=await realpath(temporary);
 const legacyRoot=path.join(root,'projects/native'),home=path.join(root,'shared-runtime');const saved=[];
 for(const [key,id] of [['workspace','s'],['2','q']]) {
  const directory=path.join(root,'directories',key);await mkdir(directory,{recursive:true});
  const ctx=await boot(path.join(legacyRoot,key));
  try {
   const workspace=await ctx.workspaceRegistry.create(directory,key);
   const handle=await ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id,createdAt:Date.now(),cwd:directory,isSeeded:false,delegationDepth:0});
   await handle.append([{type:'turn/start',seq:0,time:Date.now(),data:{turn:1}},{type:'request/header',seq:1,time:Date.now(),data:{reason:'initial',header:{config:{provider:'provider',model:'model-selected'}}}},{type:'turn/end',seq:2,time:Date.now(),data:{turn:1,reason:{kind:'interrupted'}}}]);
   await handle.flush();await handle.close();await workspace.attachSession(id);
   if(key==='workspace') await ctx.workspaceRegistry.pinSession(id);else await ctx.workspaceRegistry.archiveSession(id);
   saved.push({key,id,directory,workspaceId:workspace.id});
  } finally {await ctx.fiber.dispose();}
 }
 const result=await migrateSharedRuntime({legacyRoot,home,workspaceId:'native'});assert.equal(result.contexts.length,2);
 async function verify(expectedDirectory) {
  const ctx=await boot(home);
  try {
   assert.deepEqual(ctx.workspaceRegistry.pinnedSessionIds,['s']);
   assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds,['q']);
   for(const item of saved) {
    const workspace=ctx.workspaceRegistry.get(item.workspaceId);assert.deepEqual(workspace.sessionIds,[item.id]);
    const handle=await ctx.sessionPersistence.open(item.id,'read');
    assert.equal(handle.header.cwd,item.key==='workspace'?expectedDirectory:item.directory);
    const {events}=await handle.read();assert.equal(events[1].data.header.config.model,'model-selected');await handle.close();
   }
  } finally {await ctx.fiber.dispose();}
 }
 await verify(saved[0].directory);
 const moved=path.join(root,'directories/renamed');await rename(saved[0].directory,moved);
 await reconcileContextDirectories({home,contexts:[{kind:'workspace',id:'native',directory:moved}]});
 await verify(moved);
});

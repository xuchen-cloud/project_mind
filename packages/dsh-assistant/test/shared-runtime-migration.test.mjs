import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateSharedRuntime, reconcileContextDirectories } from '../scripts/shared-runtime-migration.mjs';
const json = async file => JSON.parse(await readFile(file,'utf8'));
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'mind-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const legacyRoot=path.join(root,'projects','native');const home=path.join(root,'shared-runtime');
 async function scope(key,workspaceId,sessionId) {
  const dir=path.join(legacyRoot,key);await mkdir(path.join(dir,'storages'),{recursive:true});
  await writeFile(path.join(dir,'storages/workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[workspaceId],pinnedSessionIds:[sessionId],archivedSessionIds:[]},tables:{workspaces:{[workspaceId]:{path:`/real/${key}`,title:key,sessionIds:[sessionId],createdAt:'now',updatedAt:'now'}}}}));
  await mkdir(path.join(dir,'sessions',`--${key}--`,sessionId),{recursive:true});
  await writeFile(path.join(dir,'sessions',`--${key}--`,sessionId,'session.jsonl'),JSON.stringify({type:'session',id:sessionId,cwd:`/real/${key}`})+'\npersisted history');
  await mkdir(path.join(dir,'attachments/v1'),{recursive:true});await writeFile(path.join(dir,'attachments/v1',sessionId),'attachment');
  await writeFile(path.join(dir,'config.json'),'secret');return dir;
 }
 return {legacyRoot,home,workspaceId:'native',scope};
}
test('merges actual histories and stable scope mappings, preserves sources and excludes credentials',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await f.scope('2','p','q');
 const result=await migrateSharedRuntime(f);assert.equal(result.contexts.length,2);
 const registry=await json(path.join(f.home,'storages/workspace.json'));assert.deepEqual(registry.global.pinnedSessionIds,['s','q']);
 assert.deepEqual(Object.keys(registry.tables.workspaces),['w','p']);
 assert.match(await readFile(path.join(f.home,'sessions/--workspace--/s/session.jsonl'),'utf8'),/persisted history/);
 await access(path.join(f.legacyRoot,'workspace/config.json'));await assert.rejects(access(path.join(f.home,'config.json')));
 assert.deepEqual(await migrateSharedRuntime(f),result);
});
test('conflicting session and workspace identities never publish a destination',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','same');await f.scope('2','p','same');
 await assert.rejects(migrateSharedRuntime(f),/session.*conflict/i);await assert.rejects(access(f.home));
});
test('recovers abandoned staging and leaves existing unknown destination untouched',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await mkdir(`${f.home}.migration-staging`,{recursive:true});await writeFile(`${f.home}.migration-staging/incomplete`,'partial');
 await migrateSharedRuntime(f);await assert.rejects(access(path.join(f.home,'incomplete')));
 const other=await fixture(t);await mkdir(other.home,{recursive:true});await writeFile(path.join(other.home,'unknown'),'keep');
 await assert.rejects(migrateSharedRuntime(other),/destination/i);assert.equal(await readFile(path.join(other.home,'unknown'),'utf8'),'keep');
});
test('retains schedule pending message, timestamps and request receipts byte for byte',async t=>{
 const f=await fixture(t);const dir=await f.scope('workspace','w','s');
 const task={id:'task',title:'daily',prompt:'work',sessionId:'s',enabled:true,timeZone:'Asia/Shanghai',rule:{kind:'days',interval:1,startDate:'2026-10-25',time:'09:00'},nextRunAt:'2026-10-26T01:00:00.000Z',lastRunAt:'2026-10-25T01:00:00.000Z',lastError:null,pending:{at:'2026-10-25T01:00:00.000Z',message:{id:'message',role:'user',source:{kind:'schedule'},content:[{type:'text',text:'pending'}]}}};
 const bytes=JSON.stringify({version:1,tasks:[task],requests:{receipt:{hash:'a'.repeat(64),value:task}}});
 await writeFile(path.join(dir,'scheduled-tasks.json'),bytes);await migrateSharedRuntime(f);
 assert.equal(await readFile(path.join(f.home,'scheduled-tasks.json'),'utf8'),bytes);
});
test('workspace ID conflict and foreign history cwd both fail safely',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await f.scope('2','w','q');
 await assert.rejects(migrateSharedRuntime(f),/workspace identity conflict/i);await assert.rejects(access(f.home));
 const other=await fixture(t);const dir=await other.scope('workspace','w','s');
 await writeFile(path.join(dir,'sessions/--workspace--/s/session.jsonl'),JSON.stringify({type:'session',id:'s',cwd:'/other'})+'\n');
 await assert.rejects(migrateSharedRuntime(other),/another directory/);await assert.rejects(access(other.home));
});
test('directory moves preserve stable IDs, events, auxiliary artifacts and recoverable history',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await f.scope('2','p','q');await migrateSharedRuntime(f);
 await writeFile(path.join(f.home,'sessions/--workspace--/s/auxiliary.log'),'aux');await writeFile(path.join(f.home,'native-cli.json'),'credential');
 const result=await reconcileContextDirectories({home:f.home,contexts:[{kind:'workspace',id:'native',directory:'/moved/workspace'}]});
 assert.deepEqual(result.contexts[0],{kind:'workspace',id:'native',workspaceId:'w',directory:'/moved/workspace'});
 assert.equal(result.contexts[1].directory,'/real/2');
 assert.match(await readFile(path.join(f.home,'sessions/--moved-workspace--/s/session.jsonl'),'utf8'),/persisted history/);
 assert.equal(await readFile(path.join(f.home,'sessions/--moved-workspace--/s/auxiliary.log'),'utf8'),'aux');
 const registry=await json(path.join(f.home,'storages/workspace.json'));assert.equal(registry.tables.workspaces.w.path,'/moved/workspace');
 const backups=(await import('node:fs/promises')).readdir;
 const backup=(await backups(path.dirname(f.home))).find(name=>name.startsWith('shared-runtime.directory-backup-'));
 assert.ok(backup);await access(path.join(path.dirname(f.home),backup,'sessions/--workspace--/s/session.jsonl'));
 await assert.rejects(access(path.join(path.dirname(f.home),backup,'native-cli.json')));
 assert.deepEqual(await reconcileContextDirectories({home:f.home,contexts:[]}),result);
});
test('published directory journal resumes after home-to-backup rename',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await migrateSharedRuntime(f);
 const {cp,rename}=await import('node:fs/promises');const staging=`${f.home}.directory-staging`,backup=`${f.home}.directory-backup-interrupted`;
 await cp(f.home,staging,{recursive:true});await writeFile(path.join(staging,'recovered'),'yes');await rename(f.home,backup);
 await writeFile(`${f.home}.directory-move.json`,JSON.stringify({version:1,home:f.home,staging,backup}));
 await reconcileContextDirectories({home:f.home,contexts:[]});assert.equal(await readFile(path.join(f.home,'recovered'),'utf8'),'yes');await access(backup);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCurrentRuntime, reconcileContextDirectories } from '../scripts/current-runtime.mjs';
const json = async file => JSON.parse(await readFile(file,'utf8'));
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'mind-current-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=path.join(root,'shared-runtime');
 const contexts=[];
 const registry={unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[],pinnedSessionIds:[],archivedSessionIds:[]},tables:{workspaces:{}}};
 async function scope(key,workspaceId,sessionId) {
  const directory=`/real/${key}`;
  contexts.push({kind:key==='workspace'?'workspace':'project',id:key==='workspace'?'native':Number(key),directory,workspaceId});
  registry.global.workspaceIds.push(workspaceId);
  registry.tables.workspaces[workspaceId]={path:directory,title:key,sessionIds:[sessionId],createdAt:'now',updatedAt:'now'};
  await mkdir(path.join(home,'storages'),{recursive:true});
  await writeFile(path.join(home,'storages/workspace.json'),JSON.stringify(registry));
  await writeFile(path.join(home,'mind-contexts.json'),JSON.stringify({version:1,contexts}));
  const history=path.join(home,'sessions',`--${key}--`,sessionId);
  await mkdir(history,{recursive:true});
  await writeFile(path.join(history,'session.jsonl'),JSON.stringify({type:'session',id:sessionId,cwd:directory})+'\npersisted history');
 }
 return {root,home,contexts:[],scope};
}

test('fresh current home opens without a legacy tree or migration manifest',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await prepareCurrentRuntime(f),{version:1,contexts:[]});
 assert.deepEqual(await readdir(f.home),[]);
});

test('current mappings open without inspecting legacy files or parsing history',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await f.scope('2','p','q');
 // Invalid old-layout data and a corrupt unrelated cold history must not become
 // a startup preflight; the owning history reader reports errors on access.
 const legacy=path.join(f.root,'workspace');await mkdir(legacy);
 await writeFile(path.join(legacy,'storages'),'not a directory');
 await writeFile(path.join(f.home,'sessions/--2--/q/session.jsonl'),'unreadable history header');
 await writeFile(path.join(f.home,'mind-migration.json'),'obsolete invalid manifest');
 const before=await readFile(path.join(f.home,'mind-contexts.json'));
 const mappings=await prepareCurrentRuntime({...f,contexts:[{kind:'workspace',id:'native',directory:'/real/workspace'}]});
 assert.equal(mappings.contexts.length,2);
 assert.deepEqual(await readFile(path.join(f.home,'mind-contexts.json')),before);
 assert.equal(await readFile(path.join(f.home,'sessions/--2--/q/session.jsonl'),'utf8'),'unreadable history header');
 assert.equal(await readFile(path.join(f.home,'mind-migration.json'),'utf8'),'obsolete invalid manifest');
 assert.deepEqual(await readdir(f.root),['shared-runtime','workspace']);
});

test('directory moves preserve stable IDs, events, auxiliary artifacts and recoverable history',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await f.scope('2','p','q');await prepareCurrentRuntime(f);
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
 const f=await fixture(t);await f.scope('workspace','w','s');await prepareCurrentRuntime(f);
 const {cp,rename}=await import('node:fs/promises');const staging=`${f.home}.directory-staging`,backup=`${f.home}.directory-backup-interrupted`;
 await cp(f.home,staging,{recursive:true});await writeFile(path.join(staging,'recovered'),'yes');await rename(f.home,backup);
 await writeFile(`${f.home}.directory-move.json`,JSON.stringify({version:1,home:f.home,staging,backup}));
 await reconcileContextDirectories({home:f.home,contexts:[]});assert.equal(await readFile(path.join(f.home,'recovered'),'utf8'),'yes');await access(backup);
});

test('current mappings retain workspace identity and reject duplicate scope ownership',async t=>{
 const f=await fixture(t);await f.scope('workspace','w','s');await f.scope('2','p','q');
 await assert.rejects(prepareCurrentRuntime({...f,contexts:[{kind:'workspace',id:'foreign',directory:'/real/workspace'}]}),/identity mismatch/);
 const file=path.join(f.home,'mind-contexts.json');
 const saved=await json(file);
 for(const change of [
  value=>{value.contexts.push({...value.contexts[1]});},
  value=>{value.contexts[1].workspaceId=value.contexts[0].workspaceId;},
  value=>{value.contexts[1].directory=value.contexts[0].directory;},
  value=>{value.contexts[1].directory='relative';},
 ]) {
  const invalid=structuredClone(saved);change(invalid);await writeFile(file,JSON.stringify(invalid));
  await assert.rejects(prepareCurrentRuntime(f),/mapping/i);
 }
 assert.match(await readFile(path.join(f.home,'sessions/--workspace--/s/session.jsonl'),'utf8'),/persisted history/);
});

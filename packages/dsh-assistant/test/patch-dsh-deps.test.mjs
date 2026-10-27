import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {patchDshDependencies} from '../scripts/patch-dsh-deps.mjs';
import {normalizeDirectory} from '../scripts/context-directory.mjs';
import {projectKey} from '../scripts/current-runtime.mjs';
import {writePathDependencyFixture,legacyPathSources,persistenceSource,workspaceSource} from './fixtures/dsh-path-patches.mjs';
const names=['dsh-session-persistence-jsonl/lib/index.js','dsh-workspace/lib/index.js'];
async function fixture(t,sources) {
 const root=await mkdtemp(path.join(os.tmpdir(),'mind-pure-dsh-patch-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writePathDependencyFixture(root,sources);return root;
}
async function verifyPairs(root) {
 const {projectKey:patched}=await import(pathToFileURL(path.join(root,names[0])));
 const {Workspace}=await import(pathToFileURL(path.join(root,names[1])));
 for(const [native,canonical] of [
  [String.raw`\\?\C:\workspace\项目`,String.raw`C:\workspace\项目`],
  [String.raw`\\?\UNC\server\share\项目`,String.raw`\\server\share\项目`],
 ]) {
  assert.equal(patched(native),patched(canonical));
  assert.equal(patched(native),projectKey(normalizeDirectory(native)));
  const workspace=new Workspace({path:native,sessionIds:['own','foreign']},{sessionPath:id=>id==='own'?native:canonical+'-foreign'});
  assert.equal(workspace.record.path,canonical);
  await workspace.attachCheck(canonical);
  await assert.rejects(workspace.attachCheck(canonical+'-foreign'),/foreign/);
  assert.deepEqual(workspace.mutate({path:native,sessionIds:['own','foreign']}),{path:canonical,sessionIds:['own']});
 }
}
for(const legacy of [false,true]) test(`${legacy?'known v1':'fresh'} dependency path patches normalize drive/UNC and are byte-idempotent`,async t=>{
 const root=await fixture(t,legacy?legacyPathSources():undefined);
 assert.equal(patchDshDependencies(root).length,2);
 const once=await Promise.all(names.map(name=>readFile(path.join(root,name),'utf8')));
 assert.deepEqual(patchDshDependencies(root),[]);
 assert.deepEqual(await Promise.all(names.map(name=>readFile(path.join(root,name),'utf8'))),once);
 await verifyPairs(root);
});
test('missing pinned files or late anchors fail before publishing either dependency patch',async t=>{
 const root=await fixture(t);const workspace=path.join(root,names[1]);
 await writeFile(workspace,workspaceSource.replace('this.host.sessionPath(id) === changed.path','upstreamChanged(id)'));
 assert.throws(()=>patchDshDependencies(root),/pinned anchor mismatch/);
 assert.equal(await readFile(path.join(root,names[0]),'utf8'),persistenceSource);
 await rm(workspace);
 assert.throws(()=>patchDshDependencies(root),{code:'ENOENT'});
 assert.equal(await readFile(path.join(root,names[0]),'utf8'),persistenceSource);
});
test('complete installed rc.2 bundle anchors accept the same pure patches without touching local dependencies',async t=>{
 const sources=await Promise.all(names.map(name=>readFile(new URL(`../node_modules/@deepseek-ai/${name}`,import.meta.url),'utf8')));
 const root=await fixture(t,sources);
 patchDshDependencies(root);
 assert.deepEqual(patchDshDependencies(root),[]);
  const patched=await readFile(path.join(root,names[0]),'utf8');
  const start=patched.indexOf('const _mindNormalizeDirectory = ');
  const key=patched.indexOf('function projectKey(cwd) {',start);
  const end=patched.indexOf('\n}',key)+2;
  assert.ok(start>=0&&key>start&&end>key);
  // Evaluate only the copied bundle's pure path helper/key, without loading
  // its native persistence backend or mutating installed dependencies.
  const encode=new Function(`${patched.slice(start,end)}\nreturn projectKey;`)();
  for(const cwd of [String.raw`\\?\C:\workspace\项目`,String.raw`\\?\UNC\server\share\项目`,'/real/workspace']) {
    assert.equal(encode(cwd),projectKey(normalizeDirectory(cwd)));
    assert.equal(encode(cwd),encode(normalizeDirectory(cwd)));
  }
});

test('unknown old helper edits and duplicate pinned anchors fail without a partial rewrite',async t=>{
 const old=legacyPathSources();
 for(const sources of [
  [old[0].replace('cwd.slice(4)','cwd.slice(5)'),old[1]],
  [old[0],old[1].replace('p.slice(_vprefix.length)','p.slice(5)')],
  [persistenceSource+persistenceSource,workspaceSource],
 ]) {
  const root=await fixture(t,sources);
  assert.throws(()=>patchDshDependencies(root),/unknown|anchor mismatch/);
  assert.deepEqual(await Promise.all(names.map(name=>readFile(path.join(root,name),'utf8'))),sources);
 }
});

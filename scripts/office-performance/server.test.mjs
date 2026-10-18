import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {rendererContracts,startServer} from './server.mjs';

test('snapshot-local manifest selects the API; stale worktree/new files never choose baseline full-editor',async()=>{
 const artifactRoot=await mkdtemp(resolve(tmpdir(),'office-perf-contract-'));
 try{
  for(const format of ['docx','xlsx','pptx']){
   const dir=resolve(artifactRoot,`packages/office-${format}/dist`);await mkdir(dir,{recursive:true});await writeFile(resolve(dir,format==='docx'?'editor.mjs':'browser.mjs'),'// baseline');
  }
  const word=resolve(artifactRoot,'packages/office-docx/dist');await writeFile(resolve(word,'full-editor.mjs'),'// stale unselected entry');
  let contracts=await rendererContracts(artifactRoot);
  assert.equal(contracts.docx.apiEntry,'/packages/office-docx/dist/editor.mjs');assert.equal(contracts.docx.externalRenderer,false);assert.equal(contracts.docx.resourceModule,null);
  assert.equal(contracts.pptx.rendererUrl,null);assert.equal(contracts.pptx.externalRenderer,false);
  assert.equal(contracts.pptx.apiEntry,'/packages/office-pptx/dist/browser.mjs');
  const ppt=resolve(artifactRoot,'packages/office-pptx/dist');
  await writeFile(resolve(ppt,'renderer-resources.json'),JSON.stringify({entry:'renderer.html',files:['renderer.html','renderer.mjs','renderer.css']}));
  await writeFile(resolve(ppt,'renderer.html'),'<script type="module" src="./renderer.mjs"></script><link rel="stylesheet" href="./renderer.css">');
  await writeFile(resolve(word,'renderer-resources.json'),JSON.stringify({entry:'renderer.html',files:['renderer.html','main.mjs','main.css']}));
  await writeFile(resolve(word,'renderer.html'),'<script type="module" src="./main.mjs"></script><link rel="stylesheet" href="./main.css">');
  contracts=await rendererContracts(artifactRoot);
  assert.equal(contracts.docx.apiEntry,'/packages/office-docx/dist/full-editor.mjs');assert.equal(contracts.docx.externalRenderer,true);
  assert.deepEqual(contracts.docx.hints,[['./main.mjs','modulepreload','script'],['./main.css','preload','style']]);
  assert.equal(contracts.pptx.apiEntry,null);assert.equal(contracts.pptx.rendererUrl,'/packages/office-pptx/dist/renderer.html');assert.equal(contracts.pptx.externalRenderer,true);
  await rm(resolve(ppt,'browser.mjs')); // External PPT has no host API payload or dependency on the legacy bundle.
  assert.equal((await rendererContracts(artifactRoot)).pptx.apiEntry,null);
  assert.deepEqual(contracts.pptx.hints,[['./renderer.mjs','modulepreload','script'],['./renderer.css','preload','style']]);
  await rm(resolve(word,'full-editor.mjs'));await assert.rejects(rendererContracts(artifactRoot),/ENOENT/);
  await writeFile(resolve(word,'full-editor.mjs'),'// selected after entry');
  const server=await startServer({artifactRoot,samples:[]});
  try{
   assert.deepEqual(await(await fetch(server.url+'/harness-config')).json(),contracts);
   const response=await fetch(server.url+'/renderer-resource/docx.mjs'),source=await response.text();
   assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(source,/modulepreload/);assert.match(source,/links.forEach\(link=>link.remove\(\)\)/);
   assert.doesNotMatch(source,/import\(/,'resource hint module does not execute a renderer');
   assert.equal((await fetch(server.url+'/packages/office-docx/dist/full-editor.mjs')).status,200);
  }finally{await server.close()}
 }finally{await rm(artifactRoot,{recursive:true,force:true})}
});

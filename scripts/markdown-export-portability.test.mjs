import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {portablePath,dependencyPackage} from '../packages/markdown-editor/build-exports.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
test('Windows import specifiers and dependency notices use portable paths',()=>{
  const windows=String.raw`C:\build\markdown\upstream\apps\markdown\src\renderer\export\docxExport.ts`;
  assert.equal(portablePath(windows),'C:/build/markdown/upstream/apps/markdown/src/renderer/export/docxExport.ts');
  for(const separator of ['/','\\']){
    const file=['C:','build','node_modules','outer','node_modules','@scope','inner','index.js'].join(separator);
    assert.deepEqual(dependencyPackage(file),{name:'@scope/inner',directory:'C:/build/node_modules/outer/node_modules/@scope/inner'});
    assert.deepEqual(dependencyPackage(['C:','build','node_modules','jszip','dist','jszip.min.js'].join(separator)),{name:'jszip',directory:'C:/build/node_modules/jszip'});
  }
  assert.equal(dependencyPackage(windows),null);
});

test('autocrlf checkout preserves pinned sources and generated adapters without weakening checks',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'markdown-checkout-'));
  const repository=path.join(temporary,'repository');
  const checkout=path.join(temporary,'checkout');
  const git=(...args)=>execFileSync('git',args,{cwd:repository,stdio:'pipe'});
  try{
    await mkdir(repository);
    const relative='packages/markdown-editor';
    const original=path.join(root,relative);
    const fixture=path.join(repository,relative);
    await mkdir(fixture,{recursive:true});
    for(const file of ['upstream','src','source-lock.json','sync-upstream.mjs','EXPORT-THIRD-PARTY-NOTICES.md'])await cp(path.join(original,file),path.join(fixture,file),{recursive:true});
    const pinnedFiles=[
      'packages/office-docx/vendor-web/LICENSE',
      'packages/office-pptx/vendor/LICENSE',
      'packages/office-xlsx/LICENSE',
      'scripts/dsh-runtime-licenses/SPDX-MIT.txt',
      'scripts/vendor-licenses/pi-0.99.1.LICENSE',
    ];
    for(const file of pinnedFiles){
      await mkdir(path.dirname(path.join(repository,file)),{recursive:true});
      await cp(path.join(root,file),path.join(repository,file));
    }
    git('init','--quiet');
    git('config','core.autocrlf','false');
    git('add','.');
    // Reproduce the original Windows failure before applying the attributes.
    git('-c','core.autocrlf=true','checkout-index','--all',`--prefix=${checkout}${path.sep}`);
    const check=()=>execFileSync(process.execPath,['sync-upstream.mjs','--check'],{cwd:path.join(checkout,relative),stdio:'pipe'});
    assert.throws(check,/Upstream mismatch: LICENSE/);
    await rm(checkout,{recursive:true});
    await cp(path.join(root,'.gitattributes'),path.join(repository,'.gitattributes'));
    git('add','.gitattributes');
    git('-c','core.autocrlf=true','checkout-index','--all',`--prefix=${checkout}${path.sep}`);
    assert.match(check().toString(),/fixed-source files and generated adapters/);
    for(const file of pinnedFiles)assert.deepEqual(await readFile(path.join(checkout,file)),await readFile(path.join(root,file)));
    for(const file of ['src/export/upstream-docx.mjs','EXPORT-THIRD-PARTY-NOTICES.md'])assert.deepEqual(await readFile(path.join(checkout,relative,file)),await readFile(path.join(original,file)));
    const adapter=JSON.parse(await readFile(path.join(original,'source-lock.json'),'utf8')).files.find(file=>file.path.startsWith('packages/agent-core/src/'));
    const adapterFile=path.join(checkout,relative,'src/agent-core',path.basename(adapter.path));
    const adapterBytes=await readFile(adapterFile);
    await writeFile(adapterFile,'tampered');
    assert.throws(check,/Agent core drift/);
    await writeFile(adapterFile,adapterBytes);
    await writeFile(path.join(checkout,relative,'upstream/LICENSE'),'tampered');
    assert.throws(check,/Upstream mismatch: LICENSE/);
  }finally{await rm(temporary,{recursive:true,force:true});}
});

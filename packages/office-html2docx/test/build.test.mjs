import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=new URL('../',import.meta.url);
test('distribution uses the locked unmodified upstream conversion closure and carries licenses',async()=>{
 const lock=JSON.parse(await readFile(new URL('source-lock.json',root),'utf8'));
 assert.equal(lock.commit,'d32d1711f1bf985430757b8c6b3fbddd3831d946');
 const paths=new Set(lock.files.map(row=>row.path));
 for(const row of lock.files){
  const bytes=await readFile(new URL('upstream/'+row.path,root));assert.equal(bytes.length,row.bytes);
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),row.git_blob_sha1,row.path);
 }
 const meta=JSON.parse(await readFile(new URL('dist/index.meta.json',root),'utf8'));let consumed=0;
 for(let input of Object.keys(meta.inputs)){
  input=input.replace('trusted-raw:'+fileURLToPath(root),'');
  if(input.startsWith('upstream/')){assert.ok(paths.has(input.slice('upstream/'.length)),input);consumed++;assert.doesNotMatch(input,/\/drivers\//);}
 }
 assert.ok(consumed>=20,'convert/extract/generate and full browser helper closure must be bundled');
 const entry=await readFile(new URL('dist/index.mjs',root),'utf8');assert.doesNotMatch(entry,/from ["'](?:electron|node:|playwright)/);
 const notice=await readFile(new URL('dist/THIRD-PARTY-NOTICES.txt',root),'utf8');
 for(const name of ['Apache License','Mainfunc','docx@9.7.1','dompurify@3.4.11','html-to-image@1.11.13'])assert.ok(notice.includes(name),name);
 assert.equal(await readFile(new URL('dist/index.d.mts',root),'utf8'),await readFile(new URL('types.ts',root),'utf8'));
});

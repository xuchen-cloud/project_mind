import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
// Captured from the mounted upstream summary before removing preview-only DOM work.
const EXPECTED_HASHES=['d9f2c17333605bd61f0290c7c8e3dd358765aa9c6b07f65622b59ecc824dbaa8','5b8d8364630070c77f0ff81b3d13b8238947cdd26e643978c9ac6c09f334c34e'];

test('cold inspect preserves full authoring summaries without creating a DOM editor',()=>{
 const output=execFileSync(process.execPath,['--input-type=module','-e',`
  import {readFile} from 'node:fs/promises';
  import {createHash} from 'node:crypto';
  import {inspect} from './dist/engine.mjs';
  const hashes=[];
  for(const name of ['simple','complex']){
   const bytes=new Uint8Array(await readFile('test/fixtures/'+name+'.original.docx'));
   const model=await inspect(bytes);
   hashes.push(createHash('sha256').update(JSON.stringify(model.authoring)).digest('hex'));
  }
  console.log(JSON.stringify({dom:typeof globalThis.document,hashes}));
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 const result=JSON.parse(output);
 assert.equal(result.dom,'undefined','Preview summaries must not mount a headless editor');
 assert.deepEqual(result.hashes,EXPECTED_HASHES);
});

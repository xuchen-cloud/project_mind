import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateFixtures} from './fixtures.mjs';
import {inspect} from '../../packages/office-docx/dist/engine.mjs';

test('large Word workload is parsed as body content rather than ignored nested XML',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'office-fixtures-'));
 try{
  const fixtures=await generateFixtures(directory);
  const large=fixtures.find(item=>item.format==='docx'&&item.tier==='large'&&item.variant==='a');
  const model=await inspect(new Uint8Array(await readFile(large.path)));
  const text=model.nodes.map(node=>node.text).join('\n');
  assert.match(text,/Performance paragraph 0:/);
  assert.match(text,/Performance paragraph 499:/);
  assert.equal((text.match(/Performance paragraph \d+:/g)??[]).length,500);
 }finally{await rm(directory,{recursive:true,force:true});}
});

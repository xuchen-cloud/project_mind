import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('private Office baseline keeps distinct request identities and exact independent overlays',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'office-private-baseline-'));
  try {
    await writeFile(join(dir,'worker.mjs'),await readFile(new URL('../../office-runtime/worker.mjs',import.meta.url)));
    await writeFile(join(dir,'xlsx-engine.mjs'),`let opens=0;export async function createRecalculationSession(bytes){
      if(Buffer.from(bytes).toString()!=='abc')throw Error('wrong source');opens++;let closed=false;
      return {recalculate(input){if(closed)throw Error('closed');if(input.edits[0]?.input==='fail')throw Error('independent failure');return{cells:[{formatted:JSON.stringify(input),opens}]}},close(){closed=true}};
    }`);
    const module=await import(pathToFileURL(join(dir,'worker.mjs')).href);
    assert.equal(typeof module.createOfficeRecalculationSession,'function');
    const session=module.createOfficeRecalculationSession();
    try {
      for(let i=0;i<50;i++){
        const input={edits:[{sheetId:'s',row:0,column:0,input:String(i)}],reads:[]};
        const result=await session.handle({requestId:`edit-${i}`,method:'office.recalculate',data:{format:'xlsx',...(i===0?{base64:'YWJj'}:{}),recalculation:input}});
        assert.equal(result.requestId,`edit-${i}`);assert.equal(result.ok,true);assert.equal(result.data.cells[0].opens,1);assert.equal(result.data.cells[0].formatted,JSON.stringify(input));
      }
      const replaced=await session.handle({requestId:'replace',method:'office.recalculate',data:{format:'xlsx',base64:'ZGVm',recalculation:{edits:[],reads:[]}}});
      assert.equal(replaced.error.code,'INVALID_ARGUMENT');
      const failed=await session.handle({requestId:'failed',method:'office.recalculate',data:{format:'xlsx',recalculation:{edits:[{input:'fail'}],reads:[]}}});
      assert.equal(failed.requestId,'failed');assert.equal(failed.ok,false);
      const undo=await session.handle({requestId:'undo',method:'office.recalculate',data:{format:'xlsx',recalculation:{edits:[],reads:[]}}});
      assert.equal(undo.data.cells[0].formatted,'{"edits":[],"reads":[]}');
    } finally {await session.close();}
    assert.equal((await session.handle({requestId:'closed',method:'office.recalculate',data:{format:'xlsx',recalculation:{edits:[],reads:[]}}})).ok,false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, copyFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('a private view pins its source, reuses its reader and closes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-view-protocol-'));
  try {
    await copyFile(new URL('./worker.mjs', import.meta.url), join(directory, 'worker.mjs'));
    await writeFile(join(directory, 'xlsx-engine.mjs'), `
      export async function createViewSession(bytes) {
        let reads = 0, closed = false;
        return {model:{format:'xlsx',source:bytes.toString()},
          async read(request){if(closed)throw Error('closed');return {reads:++reads,request};},
          async close(){closed=true;}};
      }`);
    const {createOfficeViewSession} = await import(pathToFileURL(join(directory, 'worker.mjs')));
    const view = createOfficeViewSession();
    const call = (method, data) => view.handle({requestId:'test',method,data:{format:'xlsx',...data}});
    assert.equal((await call('office.view.open',{base64:Buffer.from('fixed').toString('base64')})).data.model.source, 'fixed');
    const read = {kind:'range',sheetId:'s',range:{startRow:0,endRow:9,startColumn:0,endColumn:3}};
    assert.equal((await call('office.view.read',{read})).data.result.reads, 1);
    assert.equal((await call('office.view.read',{read})).data.result.reads, 2);
    assert.equal((await call('office.view.read',{read,base64:Buffer.from('replacement').toString('base64')})).error.code,'INVALID_ARGUMENT');
    assert.equal((await call('office.edit',{edits:[]})).error.code,'INVALID_ARGUMENT');
    await view.close();
    assert.equal((await call('office.view.read',{read})).error.code,'INVALID_ARGUMENT');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('view reads reject unbounded ranges and unknown payload fields before opening', async () => {
  const {createOfficeViewSession} = await import('./worker.mjs');
  const view = createOfficeViewSession();
  const invalid = [
    {kind:'range',sheetId:'s',range:{startRow:0,endRow:1048575,startColumn:0,endColumn:16383}},
    {kind:'range',sheetId:'s',range:{startRow:-1,endRow:1,startColumn:0,endColumn:1}},
    {kind:'range',sheetId:'s',range:{startRow:0,endRow:1,startColumn:0,endColumn:1},path:'/private'},
    {kind:'media',visualId:''}, {kind:'unknown'},
  ];
  for(const read of invalid) assert.equal((await view.handle({requestId:'invalid',method:'office.view.read',data:{format:'xlsx',base64:'YWJj',read}})).ok,false);
  await view.close();
});

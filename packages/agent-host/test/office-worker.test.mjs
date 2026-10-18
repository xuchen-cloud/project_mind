import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleOfficeRequest } from '../../office-runtime/worker.mjs';
const request = data => ({ requestId: 'office-boundary', method: 'office.inspect', data });
test('Office utility rejects caller paths and external source URLs', async () => {
  const response = await handleOfficeRequest(request({format:'docx', base64:'UEsDBA==', sourcePath:'/private/other-file'}));
  assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
});
test('Office utility rejects non-canonical source bytes and unsupported binary formats', async () => {
  for (const data of [{format:'docx',base64:'UEsD BA=='}, {format:'doc',base64:'UEsDBA=='}]) {
    const response = await handleOfficeRequest(request(data));
    assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
  }
});
test('Office utility never applies changes through inspection', async () => {
  const response = await handleOfficeRequest(request({format:'xlsx',base64:'UEsDBA==',edits:[]}));
  assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
});
test('Office editing requires bounded edits', async () => {
  for (const edits of [undefined, Array.from({length:257}, () => ({}))]) {
    const response = await handleOfficeRequest({...request({format:'pptx',base64:'UEsDBA==',edits}),method:'office.edit'});
    assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
  }
});

test('Office recalculation rejects other formats, operation confusion, paths and noncanonical bytes', async () => {
  const baseline = { format:'xlsx', base64:'UEsDBA==', recalculation:{ edits:[], reads:[] } };
  for (const data of [
    {...baseline,format:'docx'}, {...baseline,format:'pptx'}, {...baseline,edits:[]},
    {...baseline,path:'/private/workbook.xlsx'}, {...baseline,sessionId:'caller-session'},
    {...baseline,base64:'UEsD BA=='}, {...baseline,recalculation:undefined},
  ]) {
    const response = await handleOfficeRequest({...request(data),method:'office.recalculate'});
    assert.equal(response.ok,false); assert.equal(response.error.code,'INVALID_ARGUMENT');
  }
  for (const method of ['office.inspect','office.edit','office.recalc','office.unknown']) {
    const response = await handleOfficeRequest({...request(baseline),method});
    assert.equal(response.ok,false); assert.equal(response.error.code,'INVALID_ARGUMENT');
  }
});

async function withRecalcEngine(source, run) {
  const dir = await mkdtemp(join(tmpdir(),'mind-office-worker-test-'));
  try {
    await writeFile(join(dir,'worker.mjs'),await readFile(new URL('../../office-runtime/worker.mjs',import.meta.url)));
    await writeFile(join(dir,'xlsx-engine.mjs'),source);
    const {handleOfficeRequest:handle} = await import(pathToFileURL(join(dir,'worker.mjs')).href);
    return await run(handle);
  } finally { await rm(dir,{recursive:true,force:true}); }
}
const recalcRequest = recalculation => ({requestId:'read-recalc',method:'office.recalculate',data:{format:'xlsx',base64:'YWJj',recalculation}});

test('Office recalculation sends exact bytes and data to the engine and returns cells without replacement bytes', async () => {
  const recalculation = {edits:[{sheetId:'s1',row:0,column:0,input:'=SUM(A2:A3)'}],reads:[{sheetId:'s1',range:{startRow:0,endRow:0,startColumn:0,endColumn:0}}]};
  await withRecalcEngine(`export async function recalculate(bytes,input,context) {
    if (Buffer.from(bytes).toString()!=='abc' || JSON.stringify(input)!==${JSON.stringify(JSON.stringify(recalculation))} || !context.binaryPath.endsWith(process.platform==='win32'?'xlsx-sidecar.exe':'xlsx-sidecar')) throw Error('wrong route');
    return {cells:[{sheetId:'s1',row:0,column:0,formatted:'30',number:30,isFormula:true}]};
  }
  export function edit(){throw Error('must not edit');}
  export function inspect(){throw Error('must not inspect');}`, async handle => {
    const response = await handle(recalcRequest(recalculation));
    assert.deepEqual(response,{requestId:'read-recalc',ok:true,data:{cells:[{sheetId:'s1',row:0,column:0,formatted:'30',number:30,isFormula:true}]}});
  });
});

test('Office recalculation rejects collection and aggregate read budgets before engine I/O', async () => {
  for (const recalculation of [
    {edits:Array.from({length:10001},()=>({})),reads:[]},
    {edits:[],reads:Array.from({length:201},()=>({}))},
    {edits:[],reads:[{sheetId:'s',range:{startRow:0,endRow:50000,startColumn:0,endColumn:1}}]},
  ]) {
    const response=await handleOfficeRequest(recalcRequest(recalculation));
    assert.equal(response.ok,false); assert.equal(response.error.code,'BUDGET_EXCEEDED');
  }
});

test('Office recalculation accepts its full budget independently of the 256 edit-save limit', async () => {
  const edit={sheetId:'s',row:0,column:0,input:'=1+1'};
  const read={sheetId:'s',range:{startRow:0,endRow:499,startColumn:0,endColumn:0}};
  await withRecalcEngine(`export function recalculate(bytes,input){
    if(input.edits.length!==10000||input.reads.length!==200)throw Error('lost calculation data');
    return {cells:[]};
  }`,async handle=>{
    const response=await handle(recalcRequest({edits:Array.from({length:10000},()=>edit),reads:Array.from({length:200},()=>read)}));
    assert.deepEqual(response,{requestId:'read-recalc',ok:true,data:{cells:[]}});
  });
});

test('Office recalculation preserves engine schema and runtime failures', async () => {
  await withRecalcEngine(`export function recalculate(bytes,input){
    if(input.edits[0]?.path!=='/caller/path')throw Error('Schema fixture was not forwarded');
    const e=Error('Unknown recalculation field');e.name='ZodError';throw e;
  }`,async handle=>{
    const response=await handle(recalcRequest({edits:[{sheetId:'s',row:0,column:0,input:'1',path:'/caller/path'}],reads:[]}));
    assert.equal(response.error.code,'INVALID_ARGUMENT');
    assert.equal(response.error.message,'Unknown recalculation field');
  });
  await withRecalcEngine(`export function recalculate(){const e=Error('Sidecar is unavailable');e.code='RUNTIME_UNAVAILABLE';throw e;}`,async handle=>{
    const response=await handle(recalcRequest({edits:[],reads:[]}));
    assert.equal(response.error.code,'RUNTIME_UNAVAILABLE');
  });
});

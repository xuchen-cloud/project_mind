import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, edit } from '../dist/engine.mjs';
import JSZip from 'jszip';
const fixture = () => readFile(new URL('fixtures/complex.original.docx', import.meta.url));

test('Word document edit saves added paragraphs, paragraph formatting, table structure and image geometry to real DOCX', async () => {
  const bytes = await fixture();
  const before = await inspect(bytes);
  const document = structuredClone(before.document);
  document.content.splice(3, 0, {type:'docParagraph', attrs:{align:'center'}, content:[{type:'text',text:'新增的结构段落',marks:[{type:'bold'}]}]});
  const table = document.content.find(n=>n.type==='docTable');
  const row = structuredClone(table.content[1]);
  row.content[0].content[0].content=[{type:'text',text:'新增行'}];
  table.content.push(row);
  const image = document.content.find(n=>n.type==='docProtected' && n.attrs.blockType==='image');
  image.attrs.imageWidthPx = 240;
  image.attrs.imageHeightPx = 120;
  const output = await edit(bytes,[{type:'document',document}]);
  const reopened = await inspect(output);
  assert.ok(reopened.nodes.some(n=>n.text==='新增的结构段落'));
  const para=reopened.document.content.find(n=>n.content?.some(t=>t.text==='新增的结构段落'));
  assert.equal(para.attrs.align,'center');
  assert.ok(para.content[0].marks.some(m=>m.type==='bold'));
  assert.equal(reopened.document.content.find(n=>n.type==='docTable').content.length, table.content.length);
  const savedImage = reopened.document.content.find(n=>n.type==='docProtected' && n.attrs.blockType==='image');
  assert.equal(savedImage.attrs.imageWidthPx,240);
  assert.equal(savedImage.attrs.imageHeightPx,120);
  const original=await JSZip.loadAsync(bytes), saved=await JSZip.loadAsync(output);
  for(const name of Object.keys(original.files).filter(n=>!['word/document.xml','docProps/core.xml'].includes(n)))
    assert.deepEqual(await saved.file(name)?.async('uint8array'),await original.file(name)?.async('uint8array'),name);
});

test('complete renderer snapshots carry an exact byte source and cannot advance a stale File baseline',async()=>{
  const bytes=await fixture(),model=await inspect(bytes);
  assert.deepEqual(Buffer.from(model.sourceBase64,'base64'),bytes);
  const target=model.nodes.find(n=>n.text.includes('段落'))??model.nodes[0];
  const output=await edit(bytes,[{type:'text',nodeId:target.id,text:'完整 renderer 保存字节'}]);
  const snapshot={type:'snapshot',baselineHash:model.baselineHash,base64:Buffer.from(output).toString('base64')};
  assert.deepEqual(await edit(bytes,[snapshot]),output);
  assert.ok((await inspect(await edit(bytes,[snapshot]))).nodes.some(n=>n.text==='完整 renderer 保存字节'));
  await assert.rejects(edit(output,[snapshot]),/baseline|基线/i);
  await assert.rejects(edit(bytes,[{...snapshot,base64:'%%%'}]),/encoding/i);
  await assert.rejects(edit(bytes,[{...snapshot,base64:Buffer.from('not docx').toString('base64')}]),/ZIP|zip|DOCX/);
  await assert.rejects(edit(bytes,[snapshot,{type:'text',nodeId:target.id,text:'mixed'}]),/sole edit/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as engine from '../dist/engine.mjs';

const content = { html:'<h1>季度报告</h1><p>复杂排版正文</p><table><tr><td>项目</td><td>数据</td></tr></table>', ops:[
  {op:'set_page_setup', orientation:'landscape', margins:{top:'2cm',bottom:'2cm',left:'2cm',right:'2cm'}},
  {op:'set_header_footer',kind:'header',text:'内部报告'},
  {op:'set_header_footer',kind:'footer',text:'第 {PAGE} 页 / 共 {NUMPAGES} 页'},
] };
test('complex authoring creates sections, headers and footers and supports operations on the same document', async()=>{
  const bytes=await engine.create(content);
  const zip=await JSZip.loadAsync(bytes), xml=await zip.file('word/document.xml').async('string');
  assert.match(xml,/landscape/);
  assert.ok(Object.keys(zip.files).some(name=>/^word\/header/.test(name)));
  const model=await engine.inspect(bytes);
  assert.ok(model.authoring?.blocks.length);
  const updated=await engine.edit(bytes,[{type:'operations',ops:[{op:'findReplace',find:'复杂排版正文',replace:'更新后正文'}]}]);
  assert.ok(JSON.stringify((await engine.inspect(updated)).document).includes('更新后正文'));
});
test('authoring exports its upstream catalog and refuses filesystem/network image access',async()=>{
  const c=await engine.catalog(); assert.ok(c);
  for(const url of ['/etc/passwd','https://example.com/a.png','file:///tmp/a.png']){
    await assert.rejects(engine.create({html:'<p>安全边界</p>',ops:[{op:'insert_image',url}]}));
  }
});

test('upstream authoring persists CJK typography, merged native table, image, chart and its workbook',async()=>{
  const {complexAuthoringContent}=await import('./fixtures/authoring.mjs');
  const bytes=await engine.create(await complexAuthoringContent()),zip=await JSZip.loadAsync(bytes);
  const xml=await zip.file('word/document.xml').async('string');
  assert.match(xml,/w:eastAsia="宋体"/);assert.match(xml,/w:sz w:val="52"/);assert.match(xml,/w:gridSpan w:val="2"/);
  assert.ok(Object.keys(zip.files).some(p=>/^word\/media\/.*\.png$/.test(p)));
  assert.ok(Object.keys(zip.files).some(p=>/^word\/charts\/.*\.xml$/.test(p)));
  assert.ok(Object.keys(zip.files).some(p=>/^word\/charts\/embeddings\/.*\.xlsx$/.test(p)));
  const model=await engine.inspect(bytes);
  assert.ok(model.authoring.blocks.some(b=>b.kind==='chart'));
  assert.ok(model.authoring.headersFooters.header.includes('内部经营分析'));
  const updated=await engine.edit(bytes,[{type:'operations',ops:[{op:'findReplace',find:'表后说明',replace:'保存后的说明'}]}]);
  const saved=await JSZip.loadAsync(updated);assert.ok(Object.keys(saved.files).some(p=>/^word\/charts\/.*\.xml$/.test(p)));
  assert.ok((await engine.inspect(updated)).nodes.some(n=>n.text.includes('保存后的说明')));
});

test('structured authoring rejects dropped markup, malformed input and mixed edits',async()=>{
  for(const html of ['<script>alert(1)</script>','<p style="color:red">lost style</p>','<unknown>lost</unknown>','<table><tr><td><strong>lost bold</strong></td></tr></table>'])await assert.rejects(engine.create({html}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(engine.create({html:'<p>x</p>',unknown:true}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(engine.create({ops:[{op:'not_an_op'}]}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(engine.create({ops:[{op:'setFont',target:{nodeType:'docParagraph'},fontSzie:12}]}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(engine.create({ops:[{op:'insert_content',html:'<p style=\"color:red\">lost</p>'}]}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(engine.create({ops:[{op:'set_page_setup',margins:{tp:'2cm'}}]}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(engine.create({ops:[{op:'define_style',styleId:'Body',run:{fontSzie:12}}]}),e=>e.code==='INVALID_ARGUMENT');
  await assert.rejects(engine.create({ops:[{op:'insert_chart',kind:'bar',categories:['A'],series:[{values:[1],naem:'x'}]}]}),e=>e.code==='INVALID_ARGUMENT');
  const bytes=await engine.create('<p>base</p>');
  await assert.rejects(engine.edit(bytes,[{type:'operations',ops:[]},{type:'text',nodeId:'docx:0',text:'mixed'}]),/sole/);
});

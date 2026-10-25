import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as engine from '../dist/engine.mjs';

const html = '<h1>季度工作报告</h1><p>中文段落与<strong>粗体</strong>。</p><ol><li>第一项</li><li>第二项</li></ol><table><tr><th>项目</th><th>进展</th></tr><tr><td>研发</td><td>完成</td></tr></table>';
test('create generates a real DOCX with Chinese headings, marks, numbering and tables that can be inspected and edited', async () => {
  const bytes = await engine.create(html);
  assert.ok(bytes instanceof Uint8Array);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /季度工作报告/);
  assert.match(xml, /<w:tbl[ >]/);
  assert.match(xml, /<w:numPr[ >]/);
  const model = await engine.inspect(bytes);
  assert.equal(model.format, 'docx');
  assert.ok(model.document.content.some(n => n.type === 'docHeading'));
  assert.ok(JSON.stringify(model.document).includes('bold'));
  assert.ok(model.document.content.some(n => n.type === 'docListItem'));
  assert.ok(model.document.content.some(n => n.type === 'docTable'));
  const node = model.nodes.find(n => n.text.includes('中文段落'));
  assert.ok(node);
  const changed = await engine.edit(bytes, [{ type:'text', nodeId:node.id, text:'更新后的中文段落' }]);
  const reopened = await engine.inspect(changed);
  assert.ok(reopened.nodes.some(n => n.text === '更新后的中文段落'));
  assert.ok(reopened.document.content.some(n => n.type === 'docTable'));
});

test('create refuses unsupported content instead of silently dropping it', async () => {
  for (const content of ['', '  ', '<p><br></p>', '<img src="https://example.com/a.png">', '<script>alert(1)</script>',
    '<p style="color:red">text</p>', '<a href="https://example.com">link</a>', '<iframe>text</iframe>',
    '<table><tr><td><strong>bold</strong></td></tr></table>', '<ol start="3"><li>third</li></ol>', '<p>text</p><unknown>lost</unknown>']) {
    await assert.rejects(engine.create(content), error => error.code === 'INVALID_ARGUMENT', content);
  }
});

test('create budgets UTF8 input and HTML complexity before conversion', async () => {
  await assert.rejects(engine.create('中'.repeat(700000)), error => error.code === 'BUDGET_EXCEEDED');
  await assert.rejects(engine.create('<p>' + '<span>'.repeat(100) + 'deep' + '</span>'.repeat(100) + '</p>'), error => error.code === 'INVALID_ARGUMENT' || error.code === 'BUDGET_EXCEEDED');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { inspect, edit } from '../dist/engine.mjs';
import { poisonedHref, poisonedLinksFixture } from './fixtures/poisoned-links.mjs';
import JSZip from 'jszip';

const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', { pretendToBeVisual: true, url: 'https://office.test/' });
// JSDOM has no layout/canvas surface. GenOffice's built-in fallback handles null.
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'DOMParser', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
  Object.defineProperty(globalThis, key, { value: typeof dom.window[key] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key], configurable: true });
const runtime = await import('../dist/editor.mjs');
const fixture = () => readFile(new URL('fixtures/complex.original.docx', import.meta.url));
const delay = () => new Promise(resolve => setTimeout(resolve, 30));

test('readonly original and protected links render inert immediately and survive save/reopen with source attrs intact', async () => {
  let bytes = await poisonedLinksFixture();
  const original = await JSZip.loadAsync(bytes);
  const sourceRels = await original.file('word/_rels/document.xml.rels').async('uint8array');
  const sourceHyperlinks = (await original.file('word/document.xml').async('string')).match(/<w:hyperlink[\s\S]*?<\/w:hyperlink>/g);
  const sourceProtected = (await original.file('word/document.xml').async('string')).match(/<w:p><w:r><w:fldChar[\s\S]*?<\/w:p>/)[0];
  const model = await inspect(bytes);
  const protectedNode = model.document.content.find(n => n.type === 'docProtected' && n.attrs.fieldDisplay?.runs?.some(r => r.link?.href === poisonedHref));
  assert.ok(protectedNode, 'The source fixture must reach the protected-render path');
  const sourceDocument = JSON.stringify(model.document);
  const element = document.querySelector('#editor');
  const drafts = [];
  const controller = runtime.mountEditor(element, { model, edits: [], readOnly: true, onChange: edits => drafts.push(edits) });
  function assertInert() {
    const anchors = [...element.querySelectorAll('a')];
    assert.equal(anchors.length, 2, 'Both LinkMark and protected NodeView links remain visible');
    assert.ok(element.querySelector('.doc-protected a'), 'Protected NodeView retains its link text');
    for (const anchor of anchors) {
      assert.equal(anchor.textContent, '示例链接');
      assert.ok(anchor.classList.contains('doc-link'));
      assert.equal(anchor.getAttribute('role'), 'link');
      assert.equal(anchor.getAttribute('title'), poisonedHref);
      assert.ok(!anchor.hasAttribute('href'), 'File link must have no executable/navigation href before events');
      assert.ok(!anchor.hasAttribute('xlink:href'));
      assert.ok(!anchor.hasAttribute('download'));
      assert.ok(!anchor.hasAttribute('target'));
      assert.ok(!anchor.getAttributeNames().some(name => name.startsWith('on')));
    }
  }
  try {
    assertInert(); // No click interception or MutationObserver wait may be needed.
    assert.equal(JSON.stringify(model.document), sourceDocument, 'DOM policy must not alter original marks/attrs');
    for (const value of ['链接保留第一轮中文。', '链接保留第二轮中文。']) {
      controller.update({ model: await inspect(bytes), edits: [], readOnly: false, onChange: edits => drafts.push(edits) });
      assertInert(); // Re-render remains inert synchronously.
      const paragraph = element.querySelector('p[data-idx="2"]');
      document.createTreeWalker(paragraph, window.NodeFilter.SHOW_TEXT).nextNode().nodeValue = value;
      paragraph.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await delay();
      const draft = drafts.at(-1);
      assert.equal(draft[0].type, 'document');
      assert.deepEqual(draft[0].document.content.find(n => n.attrs?.docxIndex === protectedNode.attrs.docxIndex), protectedNode);
      bytes = await edit(bytes, draft);
      const saved = await JSZip.loadAsync(bytes);
      assert.deepEqual(await saved.file('word/_rels/document.xml.rels').async('uint8array'), sourceRels);
      assert.deepEqual((await saved.file('word/document.xml').async('string')).match(/<w:hyperlink[\s\S]*?<\/w:hyperlink>/g), sourceHyperlinks);
      assert.ok((await saved.file('word/document.xml').async('string')).includes(sourceProtected), 'Entire protected field paragraph remains byte-for-byte intact');
      const reopened = await inspect(bytes);
      assert.ok(JSON.stringify(reopened.document).includes(poisonedHref), 'Original source href must survive in model');
      assert.equal(reopened.nodes.find(n => n.id === 'docx:2').text, value);
      controller.update({ model: reopened, edits: [], readOnly: true, onChange: edits => drafts.push(edits) });
      assertInert();
    }
  } finally { controller.destroy(); }
});

test('independent editors isolate original document styles and remove them on destroy', async () => {
  const model = await inspect(await fixture());
  const first = document.createElement('div'), second = document.createElement('div');
  document.body.append(first, second);
  const options = { model, edits: [], onChange() {} };
  const a = runtime.mountEditor(first, options), b = runtime.mountEditor(second, options);
  try {
    assert.ok(first.dataset.officeDocxScope);
    assert.notEqual(first.dataset.officeDocxScope, second.dataset.officeDocxScope);
    assert.ok(first.querySelector('style').textContent.includes(`[data-office-docx-scope="${first.dataset.officeDocxScope}"]`));
  } finally { a.destroy(); b.destroy(); }
  assert.equal(first.querySelector('style'), null);
  assert.equal(first.dataset.officeDocxScope, undefined);
  first.remove(); second.remove();
});

test('real GenOffice editor renders images/tables and emits only draft edits for Chinese DOM input', async () => {
  const bytes = await fixture();
  const model = await inspect(bytes);
  const element = document.querySelector('#editor');
  const drafts = [], errors = [];
  const options = { model, edits: [], onChange: edits => drafts.push(edits), onError: error => errors.push(error) };
  const controller = runtime.mountEditor(element, options);
  try {
    assert.ok(element.querySelector('[contenteditable="true"]'));
    assert.ok(element.querySelector('table'));
    assert.ok(element.querySelector('img[src^="data:image/png;base64,"]'));
    const paragraph = [...element.querySelectorAll('p')].find(p => p.textContent === '待修改中文段落：春风拂面。');
    assert.ok(paragraph);
    document.createTreeWalker(paragraph, window.NodeFilter.SHOW_TEXT).nextNode().nodeValue = '编辑器输入中文：秋风拂面。';
    paragraph.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '秋风' }));
    await delay();
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(drafts.at(-1)[0].type, 'document');
    const cell = [...element.querySelectorAll('td p')].find(p => p.textContent === '待改单元');
    document.createTreeWalker(cell, window.NodeFilter.SHOW_TEXT).nextNode().nodeValue = '编辑器中文单元';
    cell.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await delay();
    const reopened = await inspect(await edit(bytes, drafts.at(-1)));
    assert.ok(reopened.nodes.some(n => n.text === '编辑器输入中文：秋风拂面。'));
    assert.ok(reopened.nodes.some(n => n.text === '编辑器中文单元'));
    assert.equal(reopened.assets[0].dataUrl, model.assets[0].dataUrl);
  } finally { controller.destroy(); }
});

test('saving makes the editor read-only, retains pending drafts, and model update clears the old baseline/history', async () => {
  const bytes = await fixture();
  const model = await inspect(bytes);
  const element = document.querySelector('#editor');
  const drafts = [];
  let pending = [];
  const options = { model, edits: pending, onChange: edits => drafts.push(edits) };
  const controller = runtime.mountEditor(element, options);
  try {
    const paragraph = [...element.querySelectorAll('p')].find(p => p.textContent === '待修改中文段落：春风拂面。');
    document.createTreeWalker(paragraph, window.NodeFilter.SHOW_TEXT).nextNode().nodeValue = '保存中的中文草稿';
    paragraph.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await delay();
    pending = drafts.at(-1);
    const countBeforeSave = drafts.length;
    controller.update({ ...options, edits: pending, readOnly: true });
    assert.equal(element.querySelector('[role="textbox"]').getAttribute('contenteditable'), 'false');
    controller.undo();
    assert.equal(drafts.length, countBeforeSave);
    assert.ok(element.textContent.includes('保存中的中文草稿'));
    const saved = await inspect(await edit(bytes, pending));
    controller.update({ ...options, edits: pending, model: saved, readOnly: false });
    assert.deepEqual(drafts.at(-1), []);
    const count = drafts.length;
    controller.undo();
    await delay();
    assert.equal(drafts.length, count, 'Old baseline must not survive in undo history');
    assert.ok(element.textContent.includes('保存中的中文草稿'));
    controller.update({ model: saved, edits: [{ type: 'text', nodeId: 'docx:2', text: '下一轮中文草稿' }], onChange: options.onChange });
    assert.ok(element.textContent.includes('下一轮中文草稿'));
    assert.equal(drafts.length, count, 'External controlled edits must not feed back');
  } finally { controller.destroy(); }
});

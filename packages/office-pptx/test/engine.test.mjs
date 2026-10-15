import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { inspect, edit } from '../dist/engine.mjs';
import JSZip from 'jszip';

const fixture = name => readFile(new URL(`./fixtures/${name}.pptx`, import.meta.url));
const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url)));

test('real presentations inspect into stable text targets and rendered slides', async () => {
  for (const name of ['simple', 'complex']) {
    const bytes = await fixture(name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest[name].sha256);
    const model = await inspect(bytes);
    assert.equal(model.format, 'pptx');
    assert.ok(model.slides.length >= 2);
    assert.equal(model.slides.length, model.renderSlides.length);
    assert.ok(Object.values(model.media).some(url => url.startsWith('data:image/png;base64,')));
    const target = model.textElements.find(el => el.text.includes('项目进展正常'));
    assert.equal(target.slideIndex, 0);
    assert.match(target.cNvPrId, /^\d+$/);
    assert.ok(target.originalRichText.paragraphs.length);
    assert.deepEqual((await inspect(bytes)).textElements, model.textElements);
    assert.doesNotMatch(JSON.stringify(model), /"(?:id|sourceId)":"(?:sp|pic|grp)_\d+/);
  }
});

test('rich text edits address individual runs in multiple paragraphs and keep every original property', async () => {
  const zip = await JSZip.loadAsync(await fixture('complex'));
  const path = 'ppt/slides/slide1.xml';
  const rich = '<a:p><a:pPr algn="ctr"><a:defRPr sz="2400"/></a:pPr><a:r><a:rPr b="1" lang="zh-CN"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>第一片段</a:t></a:r><a:r><a:rPr i="1" u="dbl"/><a:t>后半段</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr sz="1800"/><a:t>第二段原文</a:t></a:r></a:p>';
  const sourceXml = await zip.file(path).async('string');
  zip.file(path, sourceXml.replace(/<a:p>(?:(?!<\/a:p>)[\s\S])*项目进展正常[\s\S]*?<\/a:p>/, rich));
  const source = await zip.generateAsync({ type: 'uint8array' });
  const model = await inspect(source);
  const target = model.textElements.find(e => e.text === '第一片段后半段\n第二段原文');
  assert.ok(target);
  const address = { kind: 'text', slideIndex: target.slideIndex, cNvPrId: target.cNvPrId };
  const first = await edit(source, [
    { ...address, paragraphIndex: 0, runIndex: 1, text: '新的斜体' },
    { ...address, paragraphIndex: 1, runIndex: 0, text: '第二段修改' },
    { ...address, paragraphIndex: 0, runIndex: 1, text: '重复目标最终值' },
  ]);
  const reopened = await inspect(first);
  assert.equal(reopened.textElements.find(e => e.cNvPrId === target.cNvPrId && e.slideIndex === 0).text, '第一片段重复目标最终值\n第二段修改');
  const final = await edit(first, [{ ...address, paragraphIndex: 0, runIndex: 0, text: '' }]);
  const twice = await inspect(final);
  assert.equal(twice.textElements.find(e => e.cNvPrId === target.cNvPrId && e.slideIndex === 0).text, '重复目标最终值\n第二段修改');
  const before = await (await JSZip.loadAsync(source)).file(path).async('string');
  const after = await (await JSZip.loadAsync(final)).file(path).async('string');
  const strip = s => s.replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)/g, '$1$2');
  assert.equal(strip(after), strip(before));
});

test('image moves preserve media, size, rotation and other parts over two reopens', async () => {
  const source = await fixture('complex');
  const baseline = await inspect(source);
  const image = baseline.pictureElements.find(e => e.slideIndex === 0);
  const firstEdit = { kind: 'move-image', slideIndex: image.slideIndex, cNvPrId: image.cNvPrId, x: 960120, y: 2788920 };
  const first = await edit(source, [firstEdit]);
  const reopened = await inspect(first);
  const moved = reopened.pictureElements.find(e => e.slideIndex === image.slideIndex && e.cNvPrId === image.cNvPrId);
  assert.deepEqual(moved.transform, { ...image.transform, offset: { ...image.transform.offset, x: 960120, y: 2788920 } });
  const second = await edit(first, [{ ...firstEdit, x: 731520, y: 2560320 }]);
  assert.deepEqual((await inspect(second)).pictureElements, baseline.pictureElements);
  const beforeZip = await JSZip.loadAsync(source);
  const afterZip = await JSZip.loadAsync(second);
  for (const file of Object.values(beforeZip.files).filter(f => !f.dir)) assert.deepEqual(await afterZip.file(file.name).async('nodebuffer'), await file.async('nodebuffer'), file.name);
});

test('fields and structural edits are explicitly rejected without flattening the source', async () => {
  const zip = await JSZip.loadAsync(await fixture('simple'));
  const path = 'ppt/slides/slide1.xml';
  const originalXml = await zip.file(path).async('string');
  zip.file(path, originalXml.replace(/<a:r>((?:(?!<\/a:r>)[\s\S])*?<a:t>项目进展正常<\/a:t>)<\/a:r>/, '<a:fld id="{D77D6133-FFB8-4CA4-976F-547E4F492713}" type="datetime1">$1</a:fld>'));
  const source = await zip.generateAsync({ type: 'uint8array' });
  const model = await inspect(source);
  const field = model.textElements.find(e => e.text.includes('项目进展正常'));
  assert.equal(field.editable, false);
  assert.match(field.unsupportedReason, /动态字段/);
  await assert.rejects(edit(source, [{ kind: 'text', slideIndex: 0, cNvPrId: field.cNvPrId, paragraphIndex: 0, runIndex: 0, text: '静态覆盖' }]), /动态字段/);
  assert.deepEqual(await edit(source, []), source);
  const target = (await inspect(await fixture('simple'))).textElements[0];
  await assert.rejects(edit(await fixture('simple'), [{ kind: 'text', slideIndex: 0, cNvPrId: target.cNvPrId, paragraphIndex: 0, runIndex: 0, text: '新增\n段落' }]), /line breaks/);
});

test('public byte/JSON boundary rejects malformed edits, invalid Unicode and corrupt XML', async () => {
  const source = await fixture('simple');
  const good = { kind: 'text', slideIndex: 0, cNvPrId: '3', paragraphIndex: 0, runIndex: 0, text: '中文' };
  for (const edits of [null, {}, [null], [{ ...good, slideIndex: '0' }], [{ ...good, cNvPrId: 'sp_1' }], [{ ...good, runIndex: -1 }], [{ ...good, text: '\ud800' }], [{ ...good, text: '\u0000' }], [{ ...good, unknown: 1 }], [{ kind: 'move-image', slideIndex: 0, cNvPrId: '5', x: NaN, y: 1 }], [{ ...good, kind: 'unsupported' }]]) {
    await assert.rejects(edit(source, edits), /Invalid|Unsupported|Unicode|XML/);
  }
  await assert.rejects(inspect('not bytes'), /Uint8Array/);
  const zip = await JSZip.loadAsync(source);
  const xml = await zip.file('ppt/slides/slide1.xml').async('nodebuffer');
  zip.file('ppt/slides/slide1.xml', Buffer.concat([xml.subarray(0, 100), Buffer.from([0xc0, 0xaf]), xml.subarray(100)]));
  await assert.rejects(inspect(await zip.generateAsync({ type: 'uint8array' })), /UTF/);
  zip.file('ppt/slides/slide1.xml', xml.toString('utf8').replace('</p:sld>', '</p:broken>'));
  await assert.rejects(inspect(await zip.generateAsync({ type: 'uint8array' })), /XML/);
  for (const invalidText of ['\u0000', '&#0;', '&#xD800;']) {
    zip.file('ppt/slides/slide1.xml', xml.toString('utf8').replace('项目进展正常', invalidText));
    await assert.rejects(inspect(await zip.generateAsync({ type: 'uint8array' })), /XML/);
  }
});

test('engine bundle relocates with no workspace imports or runtime assets', async () => {
  const folder = new URL('../dist/relocation-test/', import.meta.url);
  await mkdir(folder, { recursive: true });
  try {
    await copyFile(new URL('../dist/engine.mjs', import.meta.url), new URL('pptx-engine.mjs', folder));
    const relocated = await import(new URL('pptx-engine.mjs', folder).href);
    const source = await fixture('simple');
    const candidate = await relocated.edit(source, [{ kind: 'text', slideIndex: 0, cNvPrId: '3', paragraphIndex: 0, runIndex: 0, text: '独立运行' }]);
    assert.equal((await relocated.inspect(candidate)).textElements.find(e => e.slideIndex === 0 && e.cNvPrId === '3').text, '独立运行');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('multiple Chinese text targets survive two edits and reopens without losing other parts', async () => {
  for (const name of ['simple', 'complex']) {
    const original = await fixture(name);
    const baseline = await inspect(original);
    const targets = baseline.textElements.filter(e => e.editable && e.originalRichText.paragraphs[0]?.runs[0]?.text);
    assert.ok(targets.some(e => e.slideIndex === 1));
    const edits = targets.map((target, i) => ({ kind: 'text', slideIndex: target.slideIndex, cNvPrId: target.cNvPrId, paragraphIndex: 0, runIndex: 0, text: `第${i}段：中文修改 & <保留> $&` }));
    const first = await edit(original, edits);
    const reopened = await inspect(first);
    for (const e of edits) assert.equal(reopened.textElements.find(t => t.slideIndex === e.slideIndex && t.cNvPrId === e.cNvPrId).originalRichText.paragraphs[0].runs[0].text, e.text);
    const secondEdit = { ...edits[0], text: '第二次保存：中文最终内容' };
    const second = await edit(first, [secondEdit]);
    const twice = await inspect(second);
    for (const e of [secondEdit, ...edits.slice(1)]) assert.equal(twice.textElements.find(t => t.slideIndex === e.slideIndex && t.cNvPrId === e.cNvPrId).originalRichText.paragraphs[0].runs[0].text, e.text);
    const zipBefore = await JSZip.loadAsync(original);
    const zipAfter = await JSZip.loadAsync(second);
    const changedParts = new Set(edits.map(e => baseline.slides[e.slideIndex].path));
    const namesBefore = Object.values(zipBefore.files).filter(f => !f.dir).map(f => f.name).sort();
    assert.deepEqual(Object.values(zipAfter.files).filter(f => !f.dir).map(f => f.name).sort(), namesBefore);
    for (const part of namesBefore) {
      const before = await zipBefore.file(part).async('nodebuffer');
      const after = await zipAfter.file(part).async('nodebuffer');
      if (!changedParts.has(part)) assert.deepEqual(after, before, `Unedited part ${part}`);
      else {
        // Only text payloads change. Run properties, notes/master/theme/chart
        // relationships and unknown extensions must remain exactly as authored.
        const stripText = b => b.toString('utf8').replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)/g, '$1$2');
        assert.equal(stripText(after), stripText(before), `Rich-text XML ${part}`);
      }
    }
    assert.deepEqual(await edit(original, []), original);
  }
});

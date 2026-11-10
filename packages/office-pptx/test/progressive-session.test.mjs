/**
 * Issue #303: real PPTX view/session/save regression.
 * Depends on progressive-open, inspectView, and the pinned parity session adapter.
 * Acceptance: defer untouched slides, retain cumulative edits against the complete
 * original archive, validate candidates, and preserve history/global operations.
 * Browser UI, PDF rasterization, and performance thresholds are outside this file.
 * The parent agent runs this script under the repository build lock: its startup
 * bundles the current source adapters, never a potentially stale dist artifact.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import JSZip from 'jszip';
import {parityPlugins} from '../parity-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(new URL('../output', import.meta.url), {recursive: true});
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export {inspect, inspectView, edit} from './engine';
      export {openViewPptx, materializeViewSlide, isUnloadedSlide} from './progressive-open';
      export {createParitySession} from './parity-session';
      export {candidateEdit, captureCandidateBaseline} from './parity-candidate';
    `,
    resolveDir: root,
    loader: 'ts',
  },
  outfile: 'output/progressive-session-runtime.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2021',
  jsx: 'automatic',
  plugins: parityPlugins(root),
  banner: {js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},
  logLevel: 'silent',
});
const {
  inspect, inspectView, edit, openViewPptx, materializeViewSlide,
  isUnloadedSlide, createParitySession, candidateEdit, captureCandidateBaseline,
} = await import('../output/progressive-session-runtime.mjs');

const source = new Uint8Array(await readFile(new URL('./fixtures/complex.pptx', import.meta.url)));
const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url)));
const sourceBase64 = Buffer.from(source).toString('base64');
const sourceHash = createHash('sha256').update(source).digest('hex');
const slidePaths = [1, 2, 3].map(n => `ppt/slides/slide${n}.xml`);
const originalStatus = '项目进展正常'; // slide 1, cNvPr id 5
const originalCaption = '未编辑图片说明：黄方块与白圆。'; // slide 1, cNvPr id 8
const originalLastText = '未编辑中文：第三页原文。'; // slide 3, cNvPr id 3
const firstText = '渐进会话：首笔状态已保存';
const secondText = '渐进会话：第二笔图片说明已保存';
const lastText = '渐进会话：末张访问后编辑';
const command = (name, ...args) => ({kind: 'command', name: `slides:${name}`, args});
const textArgs = (slideIndex, sourceId, text) => ({slideIndex, sourceId, paragraphs: [{runs: [{text}]}]});

async function archiveParts(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  // Folder records are ZIP metadata; PackageArchive's entries are file parts.
  const files = Object.values(zip.files).filter(file => !file.dir);
  return new Map(await Promise.all(files.map(async file => [file.name, await file.async('nodebuffer')])));
}

function actualChangedParts(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => {
    const a = before.get(path), b = after.get(path);
    return !a || !b || !a.equals(b);
  }).sort();
}

function assertArchiveFidelity(before, after, expectedChanged) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'every original part name survives');
  assert.deepEqual(actualChangedParts(before, after), [...expectedChanged].sort(), 'only the edited parts change');
  for (const [path, bytes] of before) {
    if (!expectedChanged.includes(path)) assert.deepEqual(after.get(path), bytes, `unchanged part: ${path}`);
  }
}

function assertUnloaded(opened, indexes, stage) {
  for (const index of indexes) {
    assert.equal(isUnloadedSlide(opened.deck.slides[index]), true, `${stage}: slide ${index} remains unloaded`);
  }
}

function assertRenderTarget(slide, sourceId, type) {
  const node = slide.nodes.find(node => node.sourceId === sourceId);
  assert.ok(node, `real layout includes ${sourceId}`);
  if (type) assert.equal(node.type, type);
  return node;
}

function assertText(model, slideIndex, cNvPrId, expected) {
  const target = model.textElements.find(el => el.slideIndex === slideIndex && el.cNvPrId === cNvPrId);
  assert.ok(target, `reopened slide ${slideIndex} includes cNvPr ${cNvPrId}`);
  assert.equal(target.text, expected);
}

function assertPageOrder(model, expected) {
  const pages = model.slides.map((_, slideIndex) => {
    const markers = model.textElements.filter(el => el.slideIndex === slideIndex && /^固定页序标识：PAGE-\d+$/.test(el.text));
    assert.equal(markers.length, 1, `slide ${slideIndex} retains exactly one fixture page marker`);
    return markers[0].text.replace('固定页序标识：', '');
  });
  assert.deepEqual(pages, expected);
}

function assertCandidate(candidate, bytes, baselineHash, expectedChanged) {
  assert.equal(candidate.kind, 'candidate');
  assert.equal(candidate.sourceHash, baselineHash);
  assert.equal(candidate.base64, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(candidate.changedParts, [...expectedChanged].sort());
}

test('inspectView keeps raw first-slide anchors, the full catalog, and exact original bytes/hash', async () => {
  assert.equal(sourceHash, manifest.complex.sha256);
  assert.equal(source.length, manifest.complex.bytes);
  const parts = await archiveParts(source);
  const model = await inspectView(source);
  assert.equal(model.sourceBase64, sourceBase64);
  assert.equal(model.originalHash, sourceHash);
  assert.equal(model.coverage.partial,true);
  assert.deepEqual(model.coverage.loadedSlides,[0]);
  assert.equal(model.coverage.totalSlides,3);
  assert.deepEqual(model.slideCatalog, slidePaths.map((path, slideIndex) => ({slideIndex, path})));
  assert.equal(model.slides.length, 1);
  assert.deepEqual(model.renderSlides, []);
  assert.deepEqual(model.media, {});
  assert.equal(model.slides[0].originalXml, parts.get(slidePaths[0]).toString('utf8'));
  const rawTarget = model.slides[0].elements.find(el => el.text?.paragraphs.some(p => p.runs.some(r => r.text === originalStatus)));
  assert.ok(rawTarget, 'inspectView retains the real e_5 text target');
  assert.match(rawTarget.anchor.originalXml, /<p:cNvPr\b[^>]*\bid="5"/);
  assert.equal(typeof model.slides[0].bodyPrefix, 'string');
  assert.equal(typeof model.slides[0].bodySuffix, 'string');
  assertText(model, 0, '5', originalStatus);
  assertText(model, 0, '8', originalCaption);
});

test('opening with or without the first-slide seed materializes only the requested slide', async () => {
  const model = await inspectView(source);
  for (const seed of [undefined, model]) {
    const opened = await openViewPptx(source, seed);
    assert.equal(opened.deck.originalHash, sourceHash);
    assert.deepEqual(opened.deck.slides.map(slide => slide.path), slidePaths);
    assert.equal(isUnloadedSlide(opened.deck.slides[0]), false);
    assertUnloaded(opened, [1, 2], 'open');
    const first = opened.deck.slides[0];
    assert.strictEqual(materializeViewSlide(opened, 0), first);
    const last = materializeViewSlide(opened, 2);
    assert.equal(isUnloadedSlide(last), false);
    assert.equal(last.path, slidePaths[2]);
    assert.ok(last.elements.some(el => el.text?.paragraphs.some(p => p.runs.some(r => r.text === originalLastText))));
    assert.strictEqual(materializeViewSlide(opened, 2), last, 'materializing twice reuses the real parsed slide');
    assert.strictEqual(opened.deck.slides[0], first);
    assertUnloaded(opened, [1], 'materialize last');
    assertArchiveFidelity(await archiveParts(source), new Map([...opened.archive.entries].map(([path, bytes]) => [path, Buffer.from(bytes)])), []);
  }
});

test('two saves accumulate distinct first-slide edits against the full original baseline; the last slide stays editable on demand', async () => {
  const before = await archiveParts(source);
  // These real resources make the all-entry byte comparison non-vacuous.
  for (const path of [
    'ppt/media/image1.png', 'ppt/slides/_rels/slide1.xml.rels',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/notesMasters/notesMaster1.xml',
    'ppt/notesSlides/notesSlide2.xml', 'ppt/charts/chart1.xml',
    'ppt/embeddings/Microsoft_Excel_Sheet1.xlsx',
  ]) assert.ok(before.has(path), `complex fixture contains ${path}`);
  const model = await inspectView(source);
  const opened = await openViewPptx(source, model);
  const baseline = captureCandidateBaseline(opened);
  const session = createParitySession(opened, {lazyInitialLayout: true});
  assertUnloaded(opened, [1, 2], 'session creation');
  const initial = session.openResult();
  assert.equal(initial.slides.length, 3);
  assert.deepEqual(initial.slides.map(slide => slide.partPath), slidePaths);
  assertUnloaded(opened, [1, 2], 'openResult descriptors');
  assertRenderTarget(initial.slides[0], 'e_5');
  assertRenderTarget(initial.slides[0], 'e_8');
  const picture = assertRenderTarget(initial.slides[0], 'e_7', 'picture');
  assert.equal(picture.dataUrl, `data:image/png;base64,${before.get('ppt/media/image1.png').toString('base64')}`);
  assertUnloaded(opened, [1, 2], 'first layout');

  const firstResult = await session.invoke('slides:edit-text', [textArgs(0, 'e_5', firstText)]);
  assertRenderTarget(firstResult, 'e_5');
  assertUnloaded(opened, [1, 2], 'first edit');
  const savedOnce = await session.save();
  assertUnloaded(opened, [1, 2], 'first save');
  assertArchiveFidelity(before, await archiveParts(savedOnce), [slidePaths[0]]);
  const firstCandidate = await candidateEdit(baseline, savedOnce);
  assertCandidate(firstCandidate, savedOnce, sourceHash, [slidePaths[0]]);
  assertUnloaded(opened, [1, 2], 'first candidate');
  const acceptedOnce = await edit(source, [firstCandidate]);
  assert.deepEqual(acceptedOnce, savedOnce);
  const reopenedOnce = await inspect(acceptedOnce);
  assertText(reopenedOnce, 0, '5', firstText);
  assertText(reopenedOnce, 0, '8', originalCaption);
  assertPageOrder(reopenedOnce, ['PAGE-1', 'PAGE-2', 'PAGE-3']);
  await assert.rejects(edit(source, [{...firstCandidate, changedParts: []}]), /manifest/i);
  await assert.rejects(edit(source, [{...firstCandidate, sourceHash: '0'.repeat(64)}]), /baseline/i);

  const secondResult = await session.invoke('slides:edit-text', [textArgs(0, 'e_8', secondText)]);
  assertRenderTarget(secondResult, 'e_8');
  assertUnloaded(opened, [1, 2], 'second edit');
  const savedTwice = await session.save();
  assertUnloaded(opened, [1, 2], 'second save');
  assertArchiveFidelity(before, await archiveParts(savedTwice), [slidePaths[0]]);
  const secondCandidate = await candidateEdit(baseline, savedTwice);
  assertCandidate(secondCandidate, savedTwice, sourceHash, [slidePaths[0]]);
  assertUnloaded(opened, [1, 2], 'second candidate');
  // Native validation always starts from the complete ORIGINAL bytes, not savedOnce.
  const acceptedTwice = await edit(source, [secondCandidate]);
  assert.deepEqual(acceptedTwice, savedTwice);
  const reopenedTwice = await inspect(acceptedTwice);
  assertText(reopenedTwice, 0, '5', firstText);
  assertText(reopenedTwice, 0, '8', secondText);
  assertText(reopenedTwice, 2, '3', originalLastText);
  assertPageOrder(reopenedTwice, ['PAGE-1', 'PAGE-2', 'PAGE-3']);
  assertText(model, 0, '5', originalStatus);
  assertText(model, 0, '8', originalCaption);

  // Reuse the descriptor created before either save, as the scrolling UI does.
  assertRenderTarget(initial.slides[2], 'e_3');
  assertRenderTarget(initial.slides[2], 'e_5', 'chart');
  assert.equal(isUnloadedSlide(opened.deck.slides[2]), false, 'last nodes access parses its real shape graph');
  assertUnloaded(opened, [1], 'last layout');
  const lastResult = await session.invoke('slides:edit-text', [textArgs(2, 'e_3', lastText)]);
  assertRenderTarget(lastResult, 'e_3');
  assertUnloaded(opened, [1], 'last edit');
  const savedLast = await session.save();
  assertUnloaded(opened, [1], 'last save');
  assertArchiveFidelity(before, await archiveParts(savedLast), [slidePaths[0], slidePaths[2]]);
  const lastCandidate = await candidateEdit(baseline, savedLast);
  assertCandidate(lastCandidate, savedLast, sourceHash, [slidePaths[0], slidePaths[2]]);
  assertUnloaded(opened, [1], 'last candidate');
  await assert.rejects(edit(source, [{...lastCandidate, changedParts: [slidePaths[0]]}]), /manifest/i);
  const reopenedLast = await inspect(await edit(source, [lastCandidate]));
  assertText(reopenedLast, 0, '5', firstText);
  assertText(reopenedLast, 0, '8', secondText);
  assertText(reopenedLast, 2, '3', lastText);
  assertText(reopenedLast, 1, '4', '未编辑中文：第二页原文。');
  assertPageOrder(reopenedLast, ['PAGE-1', 'PAGE-2', 'PAGE-3']);
  assert.equal(baseline.deck.originalHash, sourceHash);
  assertArchiveFidelity(before, new Map([...baseline.archive.entries].map(([path, bytes]) => [path, Buffer.from(bytes)])), []);
  assert.equal(Buffer.from(source).toString('base64'), sourceBase64);
});

test('global output layout includes every real slide, table, chart, and image after a lazy opening', async () => {
  const opened = await openViewPptx(source, await inspectView(source));
  const session = createParitySession(opened, {lazyInitialLayout: true});
  assertRenderTarget(session.openResult().slides[0], 'e_5');
  assertUnloaded(opened, [1, 2], 'before global output');
  const slides = await session.invoke('slides:get-render-slides', [720]);
  assert.equal(slides.length, 3);
  assert.deepEqual(slides.map(slide => slide.partPath), slidePaths);
  // Check loading before reading returned nodes: the global query must be eager.
  assert.ok(opened.deck.slides.every(slide => !isUnloadedSlide(slide)));
  for (const slide of slides) assert.equal(slide.widthPx, 720);
  assertRenderTarget(slides[0], 'e_7', 'picture');
  assertRenderTarget(slides[1], 'e_6', 'table');
  assertRenderTarget(slides[2], 'e_5', 'chart');
  assertArchiveFidelity(await archiveParts(source), await archiveParts(await session.save()), []);
});

test('undo and redo retain real edits across saves in one lazy session', async () => {
  const opened = await openViewPptx(source, await inspectView(source));
  const session = createParitySession(opened, {lazyInitialLayout: true});
  assertRenderTarget(session.openResult().slides[0], 'e_5');
  await session.invoke('slides:edit-text', [textArgs(0, 'e_5', firstText)]);
  await session.invoke('slides:edit-text', [textArgs(0, 'e_8', secondText)]);
  const saved = await session.save();
  const both = await inspect(saved);
  assertText(both, 0, '5', firstText);
  assertText(both, 0, '8', secondText);
  assertUnloaded(opened, [1, 2], 'before undo');
  const undone = await session.invoke('slides:undo');
  assert.equal(undone.length, 3);
  const firstOnly = await inspect(await session.save());
  assertText(firstOnly, 0, '5', firstText);
  assertText(firstOnly, 0, '8', originalCaption);
  await session.invoke('slides:undo');
  assertArchiveFidelity(await archiveParts(source), await archiveParts(await session.save()), []);
  await session.invoke('slides:redo');
  await session.invoke('slides:redo');
  const restored = await session.save();
  assertArchiveFidelity(await archiveParts(saved), await archiveParts(restored), []);
  const reopened = await inspect(restored);
  assertText(reopened, 0, '5', firstText);
  assertText(reopened, 0, '8', secondText);
});

for (const scenario of [
  {name: 'duplicate an unseen slide', nameSuffix: 'duplicate-slides', args: [{slideIndexes: [1], fitWidthPx: 960}], pages: ['PAGE-1', 'PAGE-2', 'PAGE-2', 'PAGE-3']},
  {name: 'delete an unseen slide', nameSuffix: 'delete-slide', args: [1], pages: ['PAGE-1', 'PAGE-3']},
  {name: 'move an unseen slide', nameSuffix: 'move-slide', args: [{fromIndex: 2, toIndex: 0}], pages: ['PAGE-3', 'PAGE-1', 'PAGE-2']},
]) {
  test(`structural commands ${scenario.name} without losing other original slides`, async () => {
    const before = await archiveParts(source);
    const opened = await openViewPptx(source, await inspectView(source));
    const baseline = captureCandidateBaseline(opened);
    const session = createParitySession(opened, {lazyInitialLayout: true});
    assertRenderTarget(session.openResult().slides[0], 'e_5');
    assertUnloaded(opened, [1, 2], 'before structural command');
    const result = await session.invoke(`slides:${scenario.nameSuffix}`, scenario.args);
    assert.ok(result, 'the real upstream structural handler succeeds');
    const saved = await session.save();
    const after = await archiveParts(saved);
    const candidate = await candidateEdit(baseline, saved);
    assertCandidate(candidate, saved, sourceHash, actualChangedParts(before, after));
    const reopened = await inspect(await edit(source, [candidate]));
    assertPageOrder(reopened, scenario.pages);
    for (const [path, bytes] of before) {
      if (/^ppt\/(?:media|theme|slideMasters|slideLayouts|charts|embeddings)\//.test(path)) {
        assert.deepEqual(after.get(path), bytes, `structural command preserves resource: ${path}`);
      }
    }
    assertArchiveFidelity(before, new Map([...baseline.archive.entries].map(([path, bytes]) => [path, Buffer.from(bytes)])), []);
  });
}

test('real animation and transition XML survive progressive first-slide text editing and candidate validation', async () => {
  // complex.pptx has no timing block. Generate one with actual pinned handlers,
  // keeping the fixture on disk unchanged and exercising the real save pipeline.
  const animated = await edit(source, [
    command('set-transition', {slideIndex: 0, kind: 'fade'}),
    command('set-advance-times', {times: [{slideIndex: 0, ms: 3500}]}),
    command('set-animations', {slideIndex: 0, items: [{sourceId: 'e_5', effect: 'fade', trigger: 'onClick', durationMs: 750, delayMs: 0}]}),
  ]);
  const before = await archiveParts(animated);
  const originalXml = before.get(slidePaths[0]).toString('utf8');
  const timingPattern = /<p:timing\b[^>]*>[\s\S]*?<\/p:timing>/;
  const transitionPattern = /<p:transition\b[^>]*>[\s\S]*?<\/p:transition>/;
  const timing = originalXml.match(timingPattern)?.[0];
  const transition = originalXml.match(transitionPattern)?.[0];
  assert.ok(timing, 'real animation command creates a timing subtree');
  assert.match(timing, /spid="5"/);
  assert.ok(transition, 'real transition command creates a transition subtree');
  assert.match(transition, /<p:fade\b/);
  assert.match(transition, /advTm="3500"/);
  const opened = await openViewPptx(animated, await inspectView(animated));
  const baseline = captureCandidateBaseline(opened);
  const session = createParitySession(opened, {lazyInitialLayout: true});
  assertRenderTarget(session.openResult().slides[0], 'e_5');
  await session.invoke('slides:edit-text', [textArgs(0, 'e_5', firstText)]);
  assertUnloaded(opened, [1, 2], 'animated first edit');
  const saved = await session.save();
  assertUnloaded(opened, [1, 2], 'animated save');
  const after = await archiveParts(saved);
  assertArchiveFidelity(before, after, [slidePaths[0]]);
  const savedXml = after.get(slidePaths[0]).toString('utf8');
  assert.equal(savedXml.match(timingPattern)?.[0], timing);
  assert.equal(savedXml.match(transitionPattern)?.[0], transition);
  const candidate = await candidateEdit(baseline, saved);
  assertCandidate(candidate, saved, createHash('sha256').update(animated).digest('hex'), [slidePaths[0]]);
  assertUnloaded(opened, [1, 2], 'animated candidate');
  const reopened = await inspect(await edit(animated, [candidate]));
  assertText(reopened, 0, '5', firstText);
  assertPageOrder(reopened, ['PAGE-1', 'PAGE-2', 'PAGE-3']);
});

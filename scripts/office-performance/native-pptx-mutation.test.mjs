// Executes the harness's exact mutate() against the real renderer preload API
// and production parity session/ops from the EXISTING build, then saves/reopens
// actual fixture bytes. No native commands, renderer results or permissions are
// mocked. This is API/byte coverage; native autosave acceptance needs main's run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import JSZip from 'jszip';
import { createApi } from '../../packages/office-pptx/parity-api.mjs';
import { assertNativeHistoryWitness } from './native-history.ts';

// Expose existing compiled production internals in memory; no bundle/build or
// dist write. The renderer initializes this same createParitySession function.
const builtUrl = new URL('../../packages/office-pptx/dist/engine.mjs', import.meta.url);
const built = await readFile(builtUrl, 'utf8');
assert.match(built, /function createParitySession\(/);
assert.match(built, /async function openValidated\(/);
// Preserve the original createRequire resolution base in the in-memory module.
const loaded = built.replace('createRequire(import.meta.url)', `createRequire(${JSON.stringify(builtUrl.href)})`);
const engine = await import(`data:text/javascript;base64,${Buffer.from(`${loaded}\nexport { createParitySession, openValidated };`).toString('base64')}`);
const page = await readFile(new URL('./native-page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('native-page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function collect(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node);
  ts.forEachChild(node, collect);
}
collect(ast);
const functions = ['mutate', 'deadline', 'timeoutError'].map(name => {
  const fn = declarations.get(name);
  assert.ok(fn, `actual harness ${name} exists`); return fn.getText(ast);
}).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let renderedTextArrow;
function findRenderedText(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'renderedText') renderedTextArrow = node.initializer;
  ts.forEachChild(node, findRenderedText);
}
findRenderedText(ast);
assert.ok(renderedTextArrow, 'actual history renderedText callback exists');
const renderedTextCode = ts.transpileModule(`(${renderedTextArrow.getText(ast)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function setup(name) {
  const bytes = new Uint8Array(await readFile(new URL(`../../packages/office-pptx/test/fixtures/${name}.pptx`, import.meta.url)));
  const model = await engine.inspect(bytes), journal = [];
  const session = engine.createParitySession(await engine.openValidated(bytes), { onCommand: edit => journal.push(edit) });
  const api = createApi({ invoke: (name, ...args) => session.invoke(name, args) });
  const file = { object: { id: 'isolated-fixture' } };
  const mutate = vm.runInNewContext(`${compiled}; mutate`, {
    config: { format: 'pptx' }, models: new Map([[file.object.id, model]]), slidesApi: () => api,
    activeMeasurement: null, waitStage: '', lastTimeout: null, diagnostics: () => ({ scope: 'PPT API/bytes unit test' }),
    console, performance, setTimeout, clearTimeout,
  });
  const renderedText = vm.runInNewContext(renderedTextCode, { config: { format: 'pptx' }, slidesApi: () => api });
  return { bytes, model, journal, session, api, file, mutate, renderedText };
}
for (const name of ['simple', 'complex']) test(`${name}: PPT history reads contiguous real renderer text and retains strict content/marker guards`, async () => {
  const { model, api, session, file, mutate, renderedText } = await setup(name);
  const contentWitness = model.textElements.find(node => node.slideIndex === 0 && node.text.trim()).text.trim();
  const marker = `NATIVE_PPTX_${name}_HISTORY`;
  // Metadata only supplies the pure guard's inputs; these are not native acceptance receipts.
  const object = { workspaceId: 'fixture', kind: 'file', id: '7', scope: { kind: 'project', projectId: 3 } };
  const expected = { object, versionNumber: 2, contentHash: 'fixture-hash' };
  const evidence = text => ({ source: { object, fileVersion: 2, revision: expected.contentHash }, expected,
    text, contentWitness, editMarker: marker, historical: false, status: '已保存', saveEnabled: false });
  const originalText = await renderedText();
  assert.throws(() => assertNativeHistoryWitness(evidence(originalText)), /lost the saved edit marker/);
  await mutate(file, marker);
  // The old serialization reproduces the reported false negative on actual glyph runs.
  const serialized = JSON.stringify(await api.getRenderSlides());
  assert.throws(() => assertNativeHistoryWitness(evidence(serialized)), /original native content witness/);
  const text = await renderedText();
  assertNativeHistoryWitness(evidence(text));
  assert.throws(() => assertNativeHistoryWitness({ ...evidence(text), historical: true, status: '历史版本 · 只读' }), /history contains/);
  const reopened = engine.createParitySession(await engine.openValidated(await session.save()));
  const reopenedApi = createApi({ invoke: (name, ...args) => reopened.invoke(name, args) });
  const readReopened = vm.runInNewContext(renderedTextCode, { config: { format: 'pptx' }, slidesApi: () => reopenedApi });
  assertNativeHistoryWitness(evidence(await readReopened()));
  const target = model.textElements.find(node => node.slideIndex === 0 && node.editable && node.originalRichText.paragraphs[0]?.runs.length);
  const key = (await api.getShapeKeys(0)).find(item => String(item.spid) === target.cNvPrId);
  await api.editText({ slideIndex: 0, sourceId: key.sourceId, paragraphs: [{ srcPara: 0, runs: [{ text: marker, srcRun: 0 }] }] });
  const missingOriginal = await renderedText();
  assert.throws(() => assertNativeHistoryWitness(evidence(missingOriginal)), /original native content witness/);
});
for (const name of ['simple', 'complex']) test(`${name}: live shape keys drive editText, journal replay and saved PPTX bytes`, async () => {
  const { bytes, model, journal, session, api, file, mutate } = await setup(name);
  const target = model.textElements.find(item => item.slideIndex === 0 && item.editable && item.originalRichText.paragraphs[0]?.runs.length);
  const keys = await api.getShapeKeys(0), key = keys.find(item => String(item.spid) === target.cNvPrId);
  assert.ok(key);
  assert.ok(model.slides[0].elements.some(item => item.id === `slide-0:shape-${target.cNvPrId}`));
  assert.notEqual(key.sourceId, `slide-0:${target.cNvPrId}`);
  assert.notEqual(key.sourceId, `slide-0:shape-${target.cNvPrId}`);
  const marker = `NATIVE_PPTX_${name}_MUTATION`;
  const result = await mutate(file, marker);
  assert.equal(result.sourceId, key.sourceId);
  assert.equal(journal.length, 1); assert.equal(journal[0].name, 'slides:edit-text');
  assert.equal(journal[0].args[0].sourceId, key.sourceId);
  const expected = structuredClone(target.originalRichText.paragraphs);
  expected[0].runs.at(-1).text += ` ${marker}`;
  const expectedText = expected.map(paragraph => paragraph.runs.map(run => run.text).join('')).join('\n');
  for (const saved of [await session.save(), await engine.edit(bytes, journal)]) {
    const reopened = await engine.inspect(saved);
    const text = reopened.textElements.find(item => item.slideIndex === 0 && item.cNvPrId === target.cNvPrId);
    assert.equal(text.text, expectedText);
    const before = await JSZip.loadAsync(bytes), after = await JSZip.loadAsync(saved);
    for (const [path, entry] of Object.entries(before.files)) if (!entry.dir && /^(ppt\/(media|theme|slideMasters|notesMasters)\/)/.test(path))
      assert.deepEqual(await after.file(path).async('uint8array'), await entry.async('uint8array'), path);
  }
});
test('a target removed from the real session cannot silently select another shape', async () => {
  const { model, api, file, mutate, journal } = await setup('complex');
  const target = model.textElements.find(item => item.slideIndex === 0 && item.editable && item.originalRichText.paragraphs[0]?.runs.length);
  const key = (await api.getShapeKeys(0)).find(item => String(item.spid) === target.cNvPrId);
  await api.deleteElement({ slideIndex: 0, sourceId: key.sourceId });
  journal.length = 0;
  await assert.rejects(mutate(file, 'NO_OTHER_TARGET'), /no unique live sourceId/);
  assert.equal(journal.length, 0);
});
test('the production read-only session rejects mutation without a command or saved content change', async () => {
  const { bytes, model, session, file, mutate, journal } = await setup('complex');
  session.setReadOnly(true);
  await assert.rejects(mutate(file, 'FORBIDDEN_MARKER'), /read only/);
  assert.equal(journal.length, 0);
  const reopened = await engine.inspect(await session.save());
  assert.deepEqual(reopened.textElements, model.textElements);
  assert.ok(bytes.length > 0);
});

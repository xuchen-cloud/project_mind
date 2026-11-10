import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {ast, scope, object, opened, payload, envelope, fixture} from './native-observer-fixture.mjs';

const fixed = {versionNumber: 1, expectedContentHash: 'sha256:original-hash'};
const mediaRead = {kind: 'media', visualId: 'image-1'};
const media = Object.freeze({mediaType: 'image/png', base64: 'ORIGINAL'});
const area = {startRow: 100, endRow: 101, startColumn: 0, endColumn: 1};
const rangeRead = {kind: 'range', sheetId: 's2', range: area};
const range = {area, rangeReady: true, cells: [{row: 100, column: 1, value: 10}, {row: 101, column: 1, value: 20}]};
const model = () => ({format: 'xlsx', coverage: {kind: 'partial', sourceHash: 'original-hash'},
  sheets: [{id: 's1'}, {id: 's2'}], ranges: {s1: {cells: [{row: 0, column: 0, value: 'witness'}]}}, rendererData: {media: {}}});
function deferred() {
  const pending = [], f = fixture(() => new Promise((resolve, reject) => pending.push({resolve, reject})));
  return {...f, pending};
}
async function observe(f, name, data, response) {
  const promise = f.desktopApi.command(name, payload(data));
  f.pending.at(-1).resolve(response); assert.equal(await promise, response);
}

test('actual view media/range responses attach before or after their model without changing native objects', async () => {
  for (const readFirst of [true, false]) {
    const f = deferred(), native = model(), before = JSON.stringify(native);
    const opening = f.desktopApi.command('file_office_view', payload({...fixed, read: null}));
    const reading = f.desktopApi.fileCommand('file_office_view', payload({...fixed, read: mediaRead}));
    if (readFirst) { f.pending[1].resolve(envelope({result: media})); await reading; }
    f.pending[0].resolve(envelope({model: native})); await opening;
    if (!readFirst) { f.pending[1].resolve(envelope({result: media})); await reading; }
    await observe(f, 'file_office_view', {...fixed, read: rangeRead}, envelope({result: range}));
    assert.equal(f.models.get(object), native, 'view reads never select or replace a model');
    const view = f.models.view(native);
    assert.equal(view.media['image-1'], media);
    assert.deepEqual(view.cells.s2.map(cell => cell.value), [10, 20]);
    assert.equal(view.source.contentHash, fixed.expectedContentHash);
    assert.equal(view.source.versionNumber, 1);
    assert.equal(view.reads.length, 2);
    assert.equal(JSON.stringify(native), before);
    assert.equal(f.calls.length, 3, 'observer must issue no additional IO');
  }
});

test('working view reads retain the opened session baseline across a save and late old-session completion', async () => {
  const f = deferred(), first = model(), second = model();
  await observe(f, 'file_working_open', {}, envelope({...opened, contentHash: fixed.expectedContentHash, model: first}));
  const reading = f.desktopApi.command('file_working_read_view', payload({sessionId: opened.sessionId, read: mediaRead}));
  await observe(f, 'file_working_save_office', {sessionId: opened.sessionId}, envelope({...opened, revision: 4, contentHash: 'sha256:saved-hash', noChange: false}));
  await observe(f, 'file_working_open', {}, envelope({...opened, sessionId: 'new-session', contentHash: fixed.expectedContentHash, model: second}));
  f.pending[1].resolve(envelope(media)); await reading;
  assert.equal(f.models.get(object), second);
  assert.equal(f.models.view(second).media['image-1'], undefined);
  assert.equal(f.models.view(first).media['image-1'], media);
  assert.equal(f.models.view(first).source.contentHash, fixed.expectedContentHash);
  assert.equal(f.models.view(first).source.revision, 3);
});

test('same numeric File ID, version, hash or visual ID cannot join different source identities', async () => {
  for (const foreign of [
    {object: {...object, workspaceId: 'foreign'}},
    {object: {...object, scope: {kind: 'project', projectId: 2}}},
    {object: {...object, kind: 'record'}},
    {object: {...object, id: '8'}},
    {versionNumber: 2}, {expectedContentHash: 'sha256:other-hash'},
  ]) {
    const f = deferred(), native = model();
    await observe(f, 'file_office_view', {...fixed, read: null}, envelope({model: native}));
    await observe(f, 'file_office_view', {...fixed, ...foreign, read: mediaRead}, envelope({result: media}));
    assert.equal(f.models.view(native).media['image-1'], undefined);
    assert.equal(f.models.get(object), native);
  }
});

test('foreign generation, failed envelopes and native rejection cannot create view evidence', async () => {
  const f = deferred(), native = model();
  await observe(f, 'file_office_view', {...fixed, read: null}, envelope({model: native}));
  for (const response of [
    {...envelope({result: media}), apiVersion: 2}, {...envelope({result: media}), requestId: 'foreign'},
    {...envelope({result: media}), ok: false, error: {code: 'SOURCE_CHANGED', message: 'changed'}},
  ]) await observe(f, 'file_office_view', {...fixed, read: mediaRead}, response);
  const input = payload({...fixed, read: mediaRead}); input.input.binding.generation = 'g2';
  const foreign = f.desktopApi.command('file_office_view', input); f.pending.at(-1).resolve(envelope({result: media})); await foreign;
  const failure = {code: 'NATIVE_REJECTION', message: 'native object'};
  const failed = f.desktopApi.command('file_office_view', payload({...fixed, read: mediaRead}));
  f.pending.at(-1).reject(failure); await assert.rejects(failed, error => error === failure);
  assert.equal(f.models.view(native).media['image-1'], undefined);
  assert.equal(f.models.get(object), native);
});

test('partial sourceHash mismatch cannot supply a model and a failed latest open cannot reuse stale evidence', async () => {
  const f = deferred(), native = model();
  await observe(f, 'file_office_view', {...fixed, read: null}, envelope({model: native}));
  assert.equal(f.models.get(object, {object, fileVersion: 2, revision: fixed.expectedContentHash}), undefined);
  const latest = f.desktopApi.command('file_office_view', payload({...fixed, expectedContentHash: 'sha256:different', read: null}));
  assert.equal(f.models.get(object), undefined);
  f.pending.at(-1).resolve(envelope({model: native})); await latest;
  assert.equal(f.models.get(object), undefined);
});

test('only the requested complete native range supplies cells; response order cannot overwrite newer reads', async () => {
  const f = deferred(), native = model();
  await observe(f, 'file_office_view', {...fixed, read: null}, envelope({model: native}));
  for (const result of [{...range, rangeReady: false}, {...range, area: {...area, endRow: 999}},
    {...range, cells: [{row: 999, column: 1, value: 42}]}]) {
    await observe(f, 'file_office_view', {...fixed, read: rangeRead}, envelope({result}));
    assert.equal(f.models.view(native).cells.s2, undefined);
  }
  const old = f.desktopApi.command('file_office_view', payload({...fixed, read: rangeRead}));
  const newer = f.desktopApi.command('file_office_view', payload({...fixed, read: rangeRead}));
  f.pending.at(-1).resolve(envelope({result: range})); await newer;
  f.pending.at(-2).resolve(envelope({result: {...range, cells: [{row: 100, column: 1, value: 999}]}})); await old;
  assert.deepEqual(f.models.view(native).cells.s2.map(cell => cell.value), [10, 20]);
});

test('actual DOCX readiness switches from saved current content to observed history and back', async () => {
  const f = deferred(), sourceRefs = new Map(), currentModel = {format: 'docx', nodes: [{text: 'Saved current witness'}]};
  const historyModel = {format: 'docx', nodes: [{text: 'Original retained witness'}]};
  const currentSource = {object, fileVersion: 2, revision: 'saved-hash'};
  const historySource = {object, fileVersion: 1, revision: 'original-hash'};
  let text = currentModel.nodes[0].text;
  const doc = {documentElement: {dataset: {presentationMode: 'preview'}}, fonts: {ready: Promise.resolve()}, images: [], querySelectorAll: () => []};
  const node = {get textContent() {return text;}, getBoundingClientRect: () => ({x: 0, y: 0, width: 100, height: 100}), scrollWidth: 100, scrollHeight: 100};
  const context = vm.createContext({models: f.models, sourceRefs, config: {format: 'docx'},
    rootElement: {querySelector: () => ({contentDocument: doc})}, contentNodes: () => [node], loading: () => false,
    until: async read => {assert.equal(await read(), true, 'actual selected-source content gate');},
    documents: () => [doc], deadline: promise => promise, doubleRaf: async () => {}, assertNoErrors() {},
    activeMeasurement: undefined, performance, document: {visibilityState: 'visible'}, canvasPaint() {},
  });
  const readyNode = scope.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ready');
  vm.runInContext(ts.transpileModule(readyNode.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText, context);
  const ready = vm.runInContext('ready', context), file = {object};
  await observe(f, 'file_working_open', {}, envelope({...opened, archivedVersionNumber: 2, contentHash: 'saved-hash', model: currentModel}));
  sourceRefs.set(object.id, currentSource);
  assert.equal((await ready(file, false, false, performance.now())).expectedText, 'Saved current witness');
  sourceRefs.set(object.id, historySource); text = historyModel.nodes[0].text;
  await assert.rejects(ready(file, false, false, performance.now()), /actual selected-source content gate/);
  await observe(f, 'file_office_view', {versionNumber: 1, expectedContentHash: 'original-hash', read: null}, envelope({model: historyModel}));
  assert.equal((await ready(file, false, false, performance.now())).expectedText, 'Original retained witness');
  sourceRefs.set(object.id, currentSource); text = currentModel.nodes[0].text;
  await observe(f, 'file_working_open', {}, envelope({...opened, archivedVersionNumber: 2, contentHash: 'saved-hash', sessionId: 'returned-current', model: currentModel}));
  assert.equal((await ready(file, false, false, performance.now())).expectedText, 'Saved current witness');
});

test('read request identity is captured before await and merged cells retain native row/column order', async () => {
  const f = deferred(), native = model();
  await observe(f, 'file_office_view', {...fixed, read: null}, envelope({model: native}));
  const input = payload({...fixed, read: {...rangeRead, range: {...area}}});
  input.input.requestId = 'captured-read';
  const reading = f.desktopApi.command('file_office_view', input);
  input.input.data.versionNumber = 9; input.input.data.read.range.startRow = 999;
  f.pending.at(-1).resolve({...envelope({result: range}), requestId: 'captured-read'}); await reading;
  const earlier = {startRow: 1, endRow: 1, startColumn: 1, endColumn: 1};
  await observe(f, 'file_office_view', {...fixed, read: {...rangeRead, range: earlier}}, envelope({result: {area: earlier, rangeReady: true, cells: [{row: 1, column: 1, value: 5}]}}));
  assert.deepEqual(f.models.view(native).cells.s2.map(cell => cell.value), [5, 10, 20]);
  assert.equal(f.models.view(native).reads[0].requestId, 'captured-read');
  assert.equal(f.commands[1].requestId, 'captured-read');
});

test('non-visual progressive reads do not select models or invent visual witnesses', async () => {
  const f = deferred(), native = model();
  await observe(f, 'file_office_view', {...fixed, read: null}, envelope({model: native}));
  for (const kind of ['formulas', 'outline', 'pivot']) {
    await observe(f, 'file_office_view', {...fixed, read: {kind, sheetId: 's1', path: 'pivot'}}, envelope({model: model(), result: media}));
    assert.equal(f.models.get(object), native);
    assert.equal(f.models.view(native).reads.length, 0);
  }
});

test('legacy inspect/save retain their returned model with exact native source metadata', async () => {
  const f = deferred();
  for (const name of ['file_office_inspect', 'file_office_save']) {
    const native = {format: 'docx', nodes: [{text: name}]};
    const data = {object, versionNumber: name.endsWith('_save') ? 2 : 1,
      contentHash: name.endsWith('_save') ? 'saved' : fixed.expectedContentHash, model: native};
    await observe(f, name, fixed, envelope(data));
    assert.equal(f.models.get(object), native);
    await observe(f, name, fixed, envelope({...data, object: {...object, id: 'foreign'}}));
    assert.equal(f.models.get(object), undefined);
  }
});

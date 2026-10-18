// Pure evidence guards only: no native command, DOM, renderer or permission is
// mocked; these tests do not execute or report a native acceptance scenario.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { assertNativeHistoryWitness, assertNativeHistoryUnchanged, runNativeHistoryAcceptance } from './native-history.ts';

const object = { workspaceId: 'w', kind: 'file', id: '7', scope: { kind: 'project', projectId: 3 } };
const original = { object, versionNumber: 1, contentHash: 'hash-v1', state: 'ready', name: 'fixture.docx', relativePath: 'fixture.docx' };
const latest = { ...original, versionNumber: 2, contentHash: 'hash-v2' };
const source = file => ({ object: file.object, revision: file.contentHash, fileVersion: file.versionNumber });
const witness = (historical = true) => ({ source: source(historical ? original : latest), expected: historical ? original : latest,
  text: historical ? '原始内容' : '原始内容 UNIQUE_EDIT', contentWitness: '原始内容', editMarker: 'UNIQUE_EDIT',
  historical, status: historical ? '历史版本 · 只读' : '已保存', saveEnabled: false });
const bytes = { ...latest, byteLength: 3, base64: 'YWJj' };

test('actual XLSX history text adapter keeps multiline scalar values contiguous without JSON escapes', async () => {
  const ast = ts.createSourceFile('native-page.tsx', readFileSync(new URL('./native-page.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'renderedText') callback = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(callback);
  // A facade boundary double verifies only text extraction/guard semantics, not native acceptance.
  const values = [['原样保留\n第二行', null, 30, false, 'UNIQUE_EDIT']];
  const code = ts.transpileModule(`(${callback.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const renderedText = vm.runInNewContext(code, { config: { format: 'xlsx' }, liveSheet: () => ({ sheet: {
    getRange: range => { assert.equal(range, 'A1:L20'); return { getValues: () => values }; },
  } }) });
  const text = await renderedText(), evidence = { ...witness(false), text, contentWitness: values[0][0] };
  assert.equal(text, '原样保留\n第二行\t\t30\tfalse\tUNIQUE_EDIT');
  assert.doesNotThrow(() => assertNativeHistoryWitness(evidence));
  assert.throws(() => assertNativeHistoryWitness({ ...evidence, text: JSON.stringify(values) }), /original native content witness/);
  values[0][0] = '正文已丢失';
  assert.throws(() => assertNativeHistoryWitness({ ...evidence, text: '正文已丢失 UNIQUE_EDIT' }), /original native content witness/);
});

test('admits recorded original/current content witnesses without claiming native execution', () => {
  assert.doesNotThrow(() => assertNativeHistoryWitness(witness()));
  assert.doesNotThrow(() => assertNativeHistoryWitness(witness(false)));
});
test('metadata-only source or a callback for another File cannot prove history', () => {
  for (const actual of [null, { ...source(original), fileVersion: 2 }, { ...source(original), revision: 'wrong' },
    { ...source(original), object: { ...object, id: '8' } },
    { ...source(original), object: { ...object, workspaceId: 'foreign' } },
    { ...source(original), object: { ...object, scope: { kind: 'project', projectId: 4 } } }]) {
    assert.throws(() => assertNativeHistoryWitness({ ...witness(), source: actual }), /source File\/version\/hash/);
  }
});
test('a later edit in history fails even when the original content is still present', () => {
  assert.throws(() => assertNativeHistoryWitness({ ...witness(), text: '原始内容 UNIQUE_EDIT' }), /history contains/);
});
test('returning to an original/pinned renderer cannot prove current saved content', () => {
  assert.throws(() => assertNativeHistoryWitness({ ...witness(false), text: '原始内容' }), /lost the saved edit/);
  assert.throws(() => assertNativeHistoryWitness({ ...witness(false), status: '历史版本 · 只读' }), /status or save/);
});
test('empty or missing native content and marker witnesses cannot pass', () => {
  for (const patch of [{ contentWitness: '' }, { contentWitness: '##' }, { editMarker: '' }, { text: '' }])
    assert.throws(() => assertNativeHistoryWitness({ ...witness(), ...patch }), /witness|marker/);
});
test('read-only status and absence of an enabled save action are mandatory', () => {
  for (const patch of [{ status: '' }, { status: '已保存' }, { status: '保存失败' }, { saveEnabled: true }])
    assert.throws(() => assertNativeHistoryWitness({ ...witness(), ...patch }), /status or save/);
});
test('unchanged current evidence requires the same native File, version and hash', () => {
  assert.doesNotThrow(() => assertNativeHistoryUnchanged(latest, latest, bytes, bytes));
  for (const patch of [{ versionNumber: 3 }, { contentHash: 'hash-v3' }, { object: { ...object, id: '8' } }]) {
    assert.throws(() => assertNativeHistoryUnchanged(latest, { ...latest, ...patch }, bytes, bytes), /File\/version\/hash/);
    assert.throws(() => assertNativeHistoryUnchanged(latest, latest, bytes, { ...bytes, ...patch }), /File\/version\/hash/);
  }
});
test('a matching hash label cannot hide changed original bytes, byte count or location', () => {
  assert.throws(() => assertNativeHistoryUnchanged(latest, latest, bytes, { ...bytes, base64: 'ZGVm' }), /original bytes/);
  assert.throws(() => assertNativeHistoryUnchanged(latest, latest, bytes, { ...bytes, byteLength: 4 }), /original bytes/);
  assert.throws(() => assertNativeHistoryUnchanged(latest, { ...latest, relativePath: 'moved' }, bytes, bytes), /location\/state/);
  assert.throws(() => assertNativeHistoryUnchanged(latest, { ...latest, state: 'missing' }, bytes, bytes), /location\/state/);
  assert.throws(() => assertNativeHistoryUnchanged(latest, latest, { ...bytes, base64: '' }, { ...bytes, base64: '' }), /original bytes/);
});
test('non-isolated or missing real v1/v2 inputs fail before importing or invoking native services', async () => {
  await assert.rejects(runNativeHistoryAcceptance({ file: latest, binding: { workspaceId: 'w' } },
    { isolatedFixture: false, original }), /isolated acceptance fixtures/);
  await assert.rejects(runNativeHistoryAcceptance({ file: original, binding: { workspaceId: 'w' } },
    { isolatedFixture: true, original }), /real pre-edit v1/);
  await assert.rejects(runNativeHistoryAcceptance({ file: latest, binding: { workspaceId: 'foreign' } },
    { isolatedFixture: true, original }), /real pre-edit v1/);
});

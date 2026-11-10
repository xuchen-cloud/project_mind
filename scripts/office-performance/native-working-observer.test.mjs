// Executes the real native-page bridge wrapper with current native envelopes.
// Boundary tests only: real native open/save/reopen is recorded separately.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import {ast, scope, object, status, opened, payload, envelope, fixture} from './native-observer-fixture.mjs';

test('current working open supplies the Office witness through both real API wrappers', async () => {
  for (const api of ['command', 'fileCommand']) {
    const response = envelope(opened), f = fixture(response), input = payload({});
    assert.equal(await f.desktopApi[api]('file_working_open', input), response);
    assert.equal(f.models.get(object), opened.model);
    assert.equal(f.workingStates.get(object.id).revision, 3);
    assert.equal(f.commits.length, 0);
    assert.equal(f.calls[0][1], 'file_working_open'); assert.equal(f.calls[0][2], input);
    assert.equal(typeof f.commands[0].duration, 'number');
  }
});

test('progressive history view supplies its own DOCX model without an extra inspect', async () => {
  for (const api of ['command', 'fileCommand']) {
    const model = {format: 'docx', nodes: [{text: 'original v1 witness'}]};
    const response = envelope({model}), f = fixture(response);
    const input = payload({versionNumber: 1, expectedContentHash: 'original-hash', read: null});
    assert.equal(await f.desktopApi[api]('file_office_view', input), response);
    assert.equal(f.models.get(object), model);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][1], 'file_office_view');
  }
});

test('a late model cannot replace the newer requested source in either direction', async () => {
  for (const historyFirst of [true, false]) {
    const pending = [], f = fixture(() => new Promise(resolve => pending.push(resolve)));
    const old = {format: 'docx', nodes: [{text: 'old history'}]};
    const history = () => f.desktopApi.command('file_office_view', payload({versionNumber: 1, expectedContentHash: 'original-hash', read: null}));
    const current = () => f.desktopApi.command('file_working_open', payload({}));
    const first = historyFirst ? history() : current(), second = historyFirst ? current() : history();
    pending[1](envelope(historyFirst ? opened : {model: old})); await second;
    pending[0](envelope(historyFirst ? {model: old} : opened)); await first;
    assert.equal(f.models.get(object), historyFirst ? opened.model : old);
  }
});

test('working text open decodes the actual UTF-8 base64 response', async () => {
  const text = '# 中文 witness\n正文', f = fixture(envelope({...opened, model: null, format: null, name: 'fixture.md', base64: Buffer.from(text).toString('base64')}));
  await f.desktopApi.command('file_working_open', payload({}));
  assert.equal(f.textSources.get(object.id), text);
});

test('working save records revision/hash without inventing a File Version receipt', async () => {
  for (const command of ['file_working_save_office', 'file_working_save_text']) {
    const saved = {...status, revision: 4, contentHash: 'saved-hash', noChange: false}, response = envelope(saved), f = fixture(response);
    assert.equal(await f.desktopApi.command(command, payload({sessionId: 'session', expectedRevision: 3, expectedContentHash: 'working-hash', text: 'saved 中文'})), response);
    assert.equal(f.commits.length, 1); assert.equal(f.commits[0].protocol, 'working');
    assert.equal(f.commits[0].receipt, saved); assert.equal(f.commits[0].receipt.versionNumber, undefined);
    assert.equal(f.workingStates.get(object.id).revision, 4);
    if (command.endsWith('_text')) assert.equal(f.textSources.get(object.id), 'saved 中文');
  }
});

test('business failures and foreign envelopes never create witness or save evidence', async () => {
  for (const name of ['file_working_open', 'file_working_save_office', 'file_working_save_text']) {
    for (const response of [{apiVersion: 1, requestId: 'request', ok: false, error: {code: 'REVISION_CONFLICT', message: 'fixture conflict'}, data: opened},
      {...envelope(opened), requestId: 'other-request'}, {...envelope(opened), apiVersion: 2}]) {
      const f = fixture(response); assert.equal(await f.desktopApi.command(name, payload({text: 'not saved'})), response);
      assert.equal(f.commits.length, 0); assert.equal(f.models.get(object), undefined); assert.equal(f.textSources.size, 0); assert.equal(f.workingStates.size, 0);
      if (!response.ok) assert.match(f.commands[0].error, /fixture conflict/);
    }
  }
});

test('native rejection is rethrown unchanged and recorded, with no success evidence', async () => {
  const failure = new Error('native fixture rejection'), f = fixture(failure);
  await assert.rejects(f.desktopApi.command('file_working_save_office', payload({})), error => error === failure);
  assert.match(f.commands[0].error, /native fixture rejection/); assert.equal(f.commits.length, 0);
});

test('legacy immutable version receipts keep their distinct protocol', async () => {
  const receipt = {versionNumber: 2, contentHash: 'archived-hash', noChange: false}, f = fixture(envelope({commit: {receipt}, model: opened.model}));
  await f.desktopApi.fileCommand('file_office_save', payload({}));
  assert.equal(f.commits[0].protocol, 'version'); assert.equal(f.commits[0].receipt, receipt);
  assert.equal(f.workingStates.size, 0);
});

test('no-change working save keeps its native flag and never becomes a version receipt', async () => {
  const saved = {...status, noChange: true}, f = fixture(envelope(saved));
  await f.desktopApi.command('file_working_save_text', payload({text: 'unchanged'}));
  assert.equal(f.commits[0].receipt.noChange, true); assert.equal(f.commits[0].protocol, 'working');
});

function acceptanceFixture({wrongHash = false, missingMarker = false} = {}) {
  const rows = [], trace = [], commits = [], workingStates = new Map([[object.id, opened]]);
  const first = {object, versionNumber: 1, contentHash: 'archived-v1'}, latest = {...first, versionNumber: 2, contentHash: 'saved-hash'};
  const saved = {...status, revision: 4, contentHash: 'saved-hash', noChange: false};
  const archived = {...saved, pendingArchive: false, archivedVersionNumber: 2};
  const context = vm.createContext({config: {format: 'md', run: 1}, projectContext: {projectId: 1, binding: {}},
    models: new Map(), textSources: new Map([[object.id, '# original']]), workingStates, commits, crypto, performance, TextDecoder, Uint8Array, atob,
    rootElement: {querySelector: () => ({textContent: '已保存 · 空闲后保留版本'})},
    navigationAcceptance: async () => {}, applyMode: async () => {}, currentMode: () => 'rich',
    deadline: promise => promise,
    operation: async (name, _file, action) => {trace.push(name); const row = await action(0); rows.push({name, ...row});},
    mutate: async () => {commits.push({fileId: object.id, command: 'file_working_save_text', protocol: 'working', receipt: saved}); return {marker: 'NATIVE-marker'};},
    until: async read => assert.ok(await read(), 'working autosave receipt and actual pending-archive UI must satisfy acceptance'),
    closeDisplay: async () => {trace.push('close-display');},
    fileWorkingApi: {
      tick: async () => ({...saved, contentHash: wrongHash ? 'wrong' : saved.contentHash}),
      open: async () => {trace.push('native-open-readback'); return {...opened, ...saved, base64: Buffer.from(missingMarker ? 'lost' : 'NATIVE-marker').toString('base64')};},
      close: async () => {trace.push('close-readback-session');},
      archive: async () => {trace.push('explicit-archive'); return archived;},
    },
    projectFileApi: {resolve: async () => latest}, mount: () => {}, ready: async () => ({}), fileViews: new Map(),
    renderedHasMutation: async () => true,
    runNativeHistoryAcceptance: async () => {trace.push('history-boundary'); return {boundaryOnly: true};},
  });
  const node = scope.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'acceptance');
  vm.runInContext(ts.transpileModule(node.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText, context);
  return {run: () => vm.runInContext('acceptance', context)(first), rows, trace};
}

test('actual acceptance admits working revision before separately materializing archive/history', async () => {
  const f = acceptanceFixture(); await f.run();
  assert.deepEqual(f.rows.map(row => row.name), ['acceptance_real_mutation_autosave', 'acceptance_close_and_native_readback',
    'acceptance_native_archive_boundary', 'acceptance_reopen_and_verify', 'acceptance_native_history_and_stale_cas']);
  assert.equal(f.rows[0].baselineRevision, 3); assert.equal(f.rows[0].persisted.archivedVersionNumber, 1);
  assert.equal(f.rows[0].explicitSaveInvoked, false); assert.equal(f.rows[2].explicitArchiveInvoked, true);
  assert.ok(f.trace.indexOf('close-readback-session') < f.trace.indexOf('explicit-archive'));
});

test('actual acceptance rejects mismatched persisted hash before readback/archive/history', async () => {
  const f = acceptanceFixture({wrongHash: true}); await assert.rejects(f.run(), /does not match autosave receipt/);
  assert.ok(!f.trace.includes('native-open-readback')); assert.ok(!f.trace.includes('explicit-archive'));
});

test('failed native content readback closes its session and cannot reach history', async () => {
  const f = acceptanceFixture({missingMarker: true}); await assert.rejects(f.run(), /lost the accepted edit/);
  assert.ok(f.trace.includes('close-readback-session')); assert.ok(!f.trace.includes('explicit-archive'));
});

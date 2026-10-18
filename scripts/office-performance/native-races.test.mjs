/** Evidence-validation tests only. No native commands, renderer doubles, browser,
 * permissions, sleep-driven race or native acceptance result is synthesized.
 * Actual native scenarios require main's bridge integration + serial runner.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNativeRaceEvidence, NativeRaceObserver } from './native-races.ts';

const a = { workspaceId: 'workspace', kind: 'file', id: '11', scope: { kind: 'project', projectId: 7 } };
const b = { ...a, id: '12' };
const binding = { workspaceId: 'workspace', generation: 'real-generation-recorded-by-page' };
const source = object => ({ object, revision: 'fixed-content-hash', fileVersion: 1,
  recordVersion: null, blockId: null, locator: null, title: 'fixture', excerpt: '' });

function evidence(action = 'switch') {
  const transition = { sequence: 4, object: action === 'switch' ? b : null, pendingTokens: [2] };
  return { action, pendingObject: a, replacementObject: transition.object, pendingToken: 2, transition,
    reads: [{ token: 2, name: 'file_office_inspect', requestId: 'native-request-id', object: a, binding,
      started: 2, settled: 5, error: null }],
    sources: [{ sequence: 1, owner: a, source: null },
      ...(action === 'switch' ? [{ sequence: 6, owner: b, source: source(b) }] : [])],
    displays: [{ sequence: 3, object: a, pendingTokens: [2] }, transition] };
}

test('admits complete recorded switch and close evidence; does not execute a native scenario', () => {
  assert.doesNotThrow(() => assertNativeRaceEvidence(evidence()));
  assert.doesNotThrow(() => assertNativeRaceEvidence(evidence('close')));
});

test('already-finished A cannot count as a pending race, even if the final UI is correct', () => {
  const value = evidence(); value.reads[0].settled = 3;
  assert.throws(() => assertNativeRaceEvidence(value), /remain pending/);
  value.reads[0].settled = 5; value.transition.pendingTokens = [];
  assert.throws(() => assertNativeRaceEvidence(value), /remain pending/);
});

test('unobserved or still-running native reads cannot produce a pass', () => {
  const value = evidence(); value.reads = [];
  assert.throws(() => assertNativeRaceEvidence(value), /no dispatched native read/);
  const pending = evidence(); pending.reads[0].settled = null;
  assert.throws(() => assertNativeRaceEvidence(pending), /not all settled/);
});

test('an unrelated native failure is not successful late-response cancellation coverage', () => {
  const value = evidence('close'); value.reads[0].error = 'SOURCE_NOT_READY';
  assert.throws(() => assertNativeRaceEvidence(value), /failed independently/);
});

test('a late File A source callback fails after either switch or close', () => {
  for (const action of ['switch', 'close']) {
    const value = evidence(action); value.sources.push({ sequence: 7, owner: a, source: source(a) });
    assert.throws(() => assertNativeRaceEvidence(value), /old or foreign async source/);
  }
});

test('replacement callback cannot hide a stale or foreign File identity', () => {
  const value = evidence(); value.sources[1].source = source(a);
  assert.throws(() => assertNativeRaceEvidence(value), /old or foreign async source/);
  const foreign = evidence(); foreign.sources[1].source = source({ ...b, workspaceId: 'another-workspace' });
  assert.throws(() => assertNativeRaceEvidence(foreign), /old or foreign async source/);
});

test('committed display returning to A is rejected even after B source was correct', () => {
  const value = evidence(); value.displays.push({ sequence: 8, object: a, pendingTokens: [] });
  assert.throws(() => assertNativeRaceEvidence(value), /old display was recommitted/);
});

test('a canceled File continuing its native read chain is rejected', () => {
  const value = evidence('close'); value.reads.push({ ...value.reads[0], token: 6, started: 6, settled: 7 });
  assert.throws(() => assertNativeRaceEvidence(value), /another read after cancellation/);
});

test('display pointer/metadata alone is insufficient when source observation is disconnected', () => {
  const value = evidence('close'); value.sources = [];
  assert.throws(() => assertNativeRaceEvidence(value), /onSourceReady observation was not connected/);
  const replacement = evidence(); replacement.sources = replacement.sources.slice(0, 1);
  assert.throws(() => assertNativeRaceEvidence(replacement), /no actual source-ready observation/);
});

test('the race must select a different scoped File, not the same numeric ID or wrong display', () => {
  const same = evidence(); same.replacementObject = a;
  assert.throws(() => assertNativeRaceEvidence(same), /distinct File/);
  const wrong = evidence('close'); wrong.transition.object = b;
  assert.throws(() => assertNativeRaceEvidence(wrong), /committed display/);
  const foreign = evidence(); foreign.reads[0].object = { ...a, scope: { kind: 'project', projectId: 8 } };
  assert.throws(() => assertNativeRaceEvidence(foreign), /no dispatched native read/);
});

test('observer parses the actual command and fileCommand payload envelopes without invoking them', () => {
  const observer = new NativeRaceObserver();
  const observations = [
    ['project_file_resolve', { binding, object: a }, null],
    ['project_file_read_bytes', { binding, input: { object: a, versionNumber: 1, expectedContentHash: 'hash' } }, null],
    ['file_versions_list', { input: { binding, requestId: 'versions', data: { object: a } } }, 'versions'],
    ['file_office_inspect', { input: { binding, requestId: 'inspect', data: { object: a } } }, 'inspect'],
    ['file_source_read', { input: { binding, requestId: 'source', data: { object: a } } }, 'source'],
  ];
  for (const [name, payload, requestId] of observations) {
    const token = observer.commandStarted(name, payload);
    observer.displayCommitted(null);
    observer.commandSettled(token);
    const snapshot = observer.snapshot(0), read = snapshot.reads.at(-1), display = snapshot.displays.at(-1);
    assert.equal(read.requestId, requestId); assert.deepEqual(read.binding, binding);
    assert.deepEqual(read.object, a); assert.ok(display.pendingTokens.includes(token));
    assert.ok(read.started < display.sequence && display.sequence < read.settled);
  }
  assert.equal(observer.commandStarted('workspace_close', {}), null);
  observer.commandSettled(null);
});

test('observer refuses missing/cross-workspace identity and duplicate completion', () => {
  const observer = new NativeRaceObserver();
  assert.throws(() => observer.commandStarted('file_office_inspect', {}), /missing File\/binding/);
  assert.throws(() => observer.commandStarted('project_file_resolve', { binding: { ...binding, workspaceId: 'foreign' }, object: a }), /missing File\/binding/);
  const token = observer.commandStarted('project_file_resolve', { binding, object: a });
  observer.commandSettled(token, 'native-error');
  assert.equal(observer.snapshot(0).reads[0].error, 'native-error');
  assert.throws(() => observer.commandSettled(token), /duplicate command settlement/);
});

test('cursor excludes unrelated earlier reads and preserves actual source-owner identity', () => {
  const observer = new NativeRaceObserver();
  const old = observer.commandStarted('project_file_resolve', { binding, object: a });
  observer.commandSettled(old);
  const after = observer.cursor;
  observer.sourceReady(a, null);
  const pending = observer.commandStarted('project_file_resolve', { binding, object: a });
  observer.displayCommitted(b);
  observer.commandSettled(pending);
  observer.sourceReady(b, source(b));
  const snapshot = observer.snapshot(after);
  assert.equal(snapshot.reads.length, 1);
  assert.equal(snapshot.reads[0].token, pending);
  assert.equal(snapshot.sources.length, 2);
  assert.deepEqual(snapshot.sources[1].owner, b);
});

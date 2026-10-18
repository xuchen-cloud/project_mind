// Observer constraints over recorded event shapes only. No mocked commands,
// renderers or permission results; no test emits a native acceptance pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAppWorkspaceRaceEvidence } from './app-workspace-race.ts';

const stamp = sequence => ({ sequence, ms: sequence * 2, utc: '2026-10-19T00:00:00.000Z' });
const binding = { workspaceId: 'workspace', generation: 'open-generation' };
const error = code => ({ code, name: null, retryable: false });
const observed = (name, start, end) => ({ name, channel: 'command', args: {}, dispatched: stamp(start),
  settled: stamp(end), outcome: 'ok', error: null });
function trace() {
  return { armed: stamp(3), inspect: { ...observed('file_office_inspect', 4, 8), args: { binding,
    requestId: 'actual-request-id', object: { workspaceId: 'workspace', kind: 'file', id: '7', scope: { kind: 'project', projectId: 2 } } } },
    click: stamp(5), close: { ...observed('workspace_close', 6, 7), closedWorkspace: true },
    pendingAtClick: true, pendingAtClose: true, bindingBefore: binding,
    bindingBeforeRead: { ...observed('record_workspace_binding_get', 1, 2), args: { configuredRoot: true }, binding },
    bindingChecked: stamp(10), bindingError: error('WORKSPACE_NOT_OPEN'),
    bindingAfterRead: { ...observed('record_workspace_binding_get', 11, 12), args: { configuredRoot: true },
      outcome: 'error', error: error('WORKSPACE_NOT_OPEN') },
    landing: stamp(9), final: stamp(13), empty: true, forbiddenAdditions: 0, raf: [24, 40] };
}
test('guard admits complete ordered observations; this does not execute native acceptance', () => {
  assert.doesNotThrow(() => assertAppWorkspaceRaceEvidence(trace()));
});
test('pending metadata cannot replace real dispatch, click and close completion', () => {
  for (const key of ['inspect', 'click', 'close']) {
    const e = trace(); e[key] = null;
    assert.throws(() => assertAppWorkspaceRaceEvidence(e), /invalid: missing/);
  }
  const e = trace(); e.close.settled = null;
  assert.throws(() => assertAppWorkspaceRaceEvidence(e), /invalid: missing/);
});
test('inspect must remain pending at UI click AND actual workspace_close dispatch', () => {
  for (const key of ['pendingAtClick', 'pendingAtClose'])
    assert.throws(() => assertAppWorkspaceRaceEvidence({ ...trace(), [key]: false }), /invalid: inspect/);
  const e = trace(); e.inspect.settled = stamp(6);
  assert.throws(() => assertAppWorkspaceRaceEvidence(e), /invalid: inspect/);
  const early = trace(); early.click = stamp(3);
  assert.throws(() => assertAppWorkspaceRaceEvidence(early), /invalid: inspect/);
});
test('configured-root native binding response must precede inspect and match its identity', () => {
  for (const patch of [{ bindingBeforeRead: null }, { bindingBefore: null }])
    assert.throws(() => assertAppWorkspaceRaceEvidence({ ...trace(), ...patch }), /invalid:/);
  const e = trace(); e.bindingBeforeRead.settled = stamp(5);
  assert.throws(() => assertAppWorkspaceRaceEvidence(e), /configured-root binding response/);
  const foreign = trace(); foreign.bindingBeforeRead.binding = { ...binding, generation: 'foreign' };
  assert.throws(() => assertAppWorkspaceRaceEvidence(foreign), /configured-root binding response/);
});
test('a foreign File/workspace/project identity cannot count as this pending File', () => {
  for (const patch of [{ kind: 'record' }, { workspaceId: 'other' }, { scope: { kind: 'workspace' } }, { id: 7 }]) {
    const e = trace(); e.inspect.args.object = { ...e.inspect.args.object, ...patch };
    assert.throws(() => assertAppWorkspaceRaceEvidence(e), /scoped File identity/);
  }
});
test('real close rejection or nonempty native Workspace result cannot pass', () => {
  const e = trace(); e.close.outcome = 'transport-error'; e.close.error = error(null);
  assert.throws(() => assertAppWorkspaceRaceEvidence(e), /failed: real workspace_close/);
  const notClosed = trace(); notClosed.close.closedWorkspace = false;
  assert.throws(() => assertAppWorkspaceRaceEvidence(notClosed), /invalid: workspace_close/);
});
test('only explicit native Workspace invalidation may explain an old inspect rejection', () => {
  for (const code of ['WORKSPACE_NOT_OPEN', 'WORKSPACE_CHANGED']) {
    const e = trace(); e.inspect.outcome = 'error'; e.inspect.error = error(code);
    assert.doesNotThrow(() => assertAppWorkspaceRaceEvidence(e));
  }
  for (const code of ['IO_FAILED', 'SOURCE_NOT_READY', 'CANCELLED', null]) {
    const e = trace(); e.inspect.outcome = 'error'; e.inspect.error = error(code);
    assert.throws(() => assertAppWorkspaceRaceEvidence(e), /failed: old inspect/);
  }
  const transport = trace(); transport.inspect.outcome = 'transport-error'; transport.inspect.error = error('WORKSPACE_CHANGED');
  assert.throws(() => assertAppWorkspaceRaceEvidence(transport), /failed: old inspect/);
});
test('binding invalidation requires actual matching native failure after both calls settled', () => {
  for (const patch of [{ bindingError: null }, { bindingError: error('IO_FAILED') }, { bindingChecked: stamp(7) }, { bindingAfterRead: null }])
    assert.throws(() => assertAppWorkspaceRaceEvidence({ ...trace(), ...patch }), /invalid:/);
  const e = trace(); e.bindingAfterRead.outcome = 'ok';
  assert.throws(() => assertAppWorkspaceRaceEvidence(e), /native binding failure envelope/);
  const wrong = trace(); wrong.bindingAfterRead.args.configuredRoot = false;
  assert.throws(() => assertAppWorkspaceRaceEvidence(wrong), /native binding failure envelope/);
});
test('missing actual landing, incomplete paint frames or surviving/reappearing surfaces fail', () => {
  for (const patch of [{ landing: null }, { final: null }, { raf: [] }, { raf: [10, 10] }])
    assert.throws(() => assertAppWorkspaceRaceEvidence({ ...trace(), ...patch }), /invalid:/);
  for (const patch of [{ empty: false }, { forbiddenAdditions: 1 }])
    assert.throws(() => assertAppWorkspaceRaceEvidence({ ...trace(), ...patch }), /failed: old File/);
});

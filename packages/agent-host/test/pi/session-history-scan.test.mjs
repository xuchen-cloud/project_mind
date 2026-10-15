import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeSession } from '../../src/session-codec.mjs';
import { scanSessionHistory } from '../../src/session-history-scan.mjs';
import { readSessionHistory } from '../../src/session-history.mjs';
import { createHostProtocol } from '../../src/host-protocol.mjs';
import { parseFrame, PROTOCOL_VERSION } from '../../src/protocol.mjs';

const root = '/tmp/history-scan-workspace';
const sessionId = 'a'.repeat(32);
const timestamp = '2026-10-01T00:00:00.000Z';
const header = { type: 'session', version: 3, id: sessionId, timestamp, cwd: root };
const entry = (id, parentId, role, content, more = {}) => ({ type: 'message', id, parentId, timestamp,
  message: { role, content, ...more } });
const entries = [header,
  entry('user1', null, 'user', [{ type: 'text', text: 'A😀中B' }]),
  entry('tool1', 'user1', 'toolResult', [{ type: 'text', text: 'PRIVATE TOOL' }]),
  { type: 'compaction', id: 'compact1', parentId: 'tool1', timestamp, summary: 'PRIVATE SUMMARY' },
  entry('main1', 'compact1', 'assistant', [{ type: 'thinking', thinking: 'PRIVATE THOUGHT' }, { type: 'text', text: 'Main' }], { stopReason: 'stop' }),
  entry('retry1', 'user1', 'assistant', [{ type: 'text', text: 'Retry' }], { stopReason: 'stop' }),
  entry('aborted1', 'retry1', 'assistant', [{ type: 'text', text: 'PRIVATE ABORT' }], { stopReason: 'aborted' }),
  entry('later1', 'aborted1', 'user', 'Later')];
const checkpoint = (source = entries) => ({ ...encodeSession(source, root), leafId: source.at(-1)?.id ?? null });
const scan = (input, cp = checkpoint()) => scanSessionHistory({ sessionId, expectedChecksum: cp.checksum, ...input },
  { workspaceRoot: root, loadCheckpoint: async () => cp });

test('scans all branches in file order with branch ancestry ordinals and exact read parity', async () => {
  const cp = checkpoint();
  const page = await scan({}, cp);
  assert.equal(page.entryCount, entries.length - 1);
  assert.equal(page.complete, true);
  assert.deepEqual(page.messages.map(({ runtimeEntryId, branchId, ordinal, text }) =>
    [runtimeEntryId, branchId, ordinal, text]), [
    ['user1', 'user1', 0, 'A😀中B'], ['main1', 'main1', 2, 'Main'],
    ['retry1', 'retry1', 1, 'Retry'], ['later1', 'later1', 3, 'Later']]);
  assert.equal(JSON.stringify(page).includes('PRIVATE'), false);
  for (const message of page.messages) {
    const read = await readSessionHistory({ sessionId, branchId: message.branchId },
      { workspaceRoot: root, loadCheckpoint: async () => cp });
    const matching = read.messages.find((item) => item.runtimeEntryId === message.runtimeEntryId);
    assert.ok(matching);
    for (const key of ['messageId', 'runtimeEntryId', 'ordinal', 'role', 'createdAt', 'text',
      'contentHash', 'charStart', 'charEnd', 'totalChars']) assert.deepEqual(message[key], matching[key]);
  }
});

test('Unicode fragments resume within one entry and checksum binds later pages', async () => {
  const cp = checkpoint();
  const first = await scan({ maxChars: 2 }, cp);
  assert.deepEqual(first.messages.map(({ text, charStart, charEnd, totalChars }) =>
    [text, charStart, charEnd, totalChars]), [['A😀', 0, 2, 4]]);
  assert.deepEqual(first.nextCursor, { entryOffset: 0, charOffset: 2 });
  const second = await scan({ cursor: first.nextCursor, maxChars: 2 }, cp);
  assert.equal(second.messages[0].text, '中B');
  assert.equal(second.messages[0].contentHash, first.messages[0].contentHash);
  assert.deepEqual(second.nextCursor, { entryOffset: 1, charOffset: 0 });
  const appended = checkpoint([...entries, entry('new1', 'later1', 'user', 'new')]);
  await assert.rejects(scan({ expectedChecksum: cp.checksum, cursor: second.nextCursor }, appended),
    { code: 'REVISION_CONFLICT' });
});

test('proven checkpoint prefix resumes both mid-message and after completion on append', async () => {
  const old = checkpoint();
  const appended = checkpoint([...entries, entry('new1', 'later1', 'user', 'New')]);
  const previousCheckpoint = { checksum: old.checksum, entryCount: entries.length - 1 };
  const middle = await scan({ maxChars: 2 }, old);
  const resumed = await scan({ cursor: middle.nextCursor, previousCheckpoint, maxChars: 2 }, appended);
  assert.equal(resumed.messages[0].text, '中B');
  assert.equal(resumed.messages[0].contentHash, middle.messages[0].contentHash);
  const completed = await scan({}, old);
  assert.equal(completed.complete, true);
  const afterAppend = await scan({ cursor: { entryOffset: completed.entryCount, charOffset: 0 },
    previousCheckpoint }, appended);
  assert.deepEqual(afterAppend.messages.map((message) => message.text), ['New']);
  assert.equal(afterAppend.complete, true);
});

test('changed prefix and false old cursor binding reject incremental scans', async () => {
  const old = checkpoint();
  const previousCheckpoint = { checksum: old.checksum, entryCount: entries.length - 1 };
  const changed = checkpoint([...entries.slice(0, 4),
    entry('main1', 'compact1', 'assistant', [{ type: 'text', text: 'Changed' }], { stopReason: 'stop' }),
    ...entries.slice(5), entry('new1', 'later1', 'user', 'New')]);
  await assert.rejects(scan({ previousCheckpoint, cursor: { entryOffset: previousCheckpoint.entryCount, charOffset: 0 } }, changed),
    { code: 'REVISION_CONFLICT' });
  const appended = checkpoint([...entries, entry('new1', 'later1', 'user', 'New')]);
  await assert.rejects(scan({ previousCheckpoint, cursor: { entryOffset: previousCheckpoint.entryCount + 1, charOffset: 0 } }, appended),
    { code: 'REVISION_CONFLICT' });
  await assert.rejects(scan({ previousCheckpoint: { checksum: old.checksum, entryCount: entries.length + 1 } }, appended),
    { code: 'REVISION_CONFLICT' });
  await assert.rejects(scan({ previousCheckpoint: { checksum: old.checksum, entryCount: 0 } }, old),
    { code: 'REVISION_CONFLICT' });
});

test('entry budget advances through invisible entries and empty pages', async () => {
  const source = [header];
  for (let i = 0; i < 2005; i++) source.push({ type: 'custom', id: `custom${i}`,
    parentId: i ? `custom${i - 1}` : null, timestamp });
  const cp = checkpoint(source);
  const first = await scan({}, cp);
  assert.deepEqual([first.messages.length, first.nextCursor.entryOffset, first.complete], [0, 1000, false]);
  const second = await scan({ cursor: first.nextCursor }, cp);
  assert.deepEqual([second.messages.length, second.nextCursor.entryOffset, second.complete], [0, 2000, false]);
  const third = await scan({ cursor: second.nextCursor }, cp);
  assert.deepEqual([third.messages.length, third.nextCursor, third.complete], [0, null, true]);
  const atEnd = await scan({ cursor: { entryOffset: 2005, charOffset: 0 } }, cp);
  assert.equal(atEnd.complete, true);
});

test('strict scan inputs, cursor positions, missing and corrupt checkpoints', async () => {
  const cp = checkpoint();
  for (const input of [
    { extra: true }, { expectedChecksum: null }, { limit: 0 }, { limit: 201 },
    { maxChars: 0 }, { maxChars: 262145 }, { cursor: { entryOffset: -1, charOffset: 0 } },
    { cursor: { entryOffset: 1, charOffset: 1 } }, { cursor: { entryOffset: 0, charOffset: 4 } },
    { cursor: { entryOffset: entries.length, charOffset: 0 } },
    { cursor: { entryOffset: entries.length - 1, charOffset: 1 } },
    { cursor: { entryOffset: 0, charOffset: 0, extra: true } },
    { previousCheckpoint: {} }, { previousCheckpoint: { checksum: cp.checksum, entryCount: -1 } },
    { previousCheckpoint: { checksum: cp.checksum, entryCount: 0, extra: true } }]) {
    await assert.rejects(scan(input, cp), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal((await scan({ previousCheckpoint: null, cursor: null, limit: null, maxChars: null }, cp)).complete, true);
  await assert.rejects(scanSessionHistory({ sessionId, expectedChecksum: cp.checksum },
    { workspaceRoot: root, loadCheckpoint: async () => null }), { code: 'NOT_FOUND' });
  await assert.rejects(scan({}, { ...cp, checksum: cp.checksum, jsonl: `${cp.jsonl} ` }),
    { code: 'RUNTIME_INCOMPATIBLE' });
});

test('Host scan is registered and never opens a model or persists', async () => {
  const frames = [];
  let made = 0; let persisted = 0;
  const cp = checkpoint();
  const host = createHostProtocol({ write: (frame) => frames.push(frame), workspaceRoot: root,
    loadCheckpoint: async () => cp,
    makeSession: async () => { made++; throw new Error('must not open'); },
    persistCheckpoint: async () => { persisted++; throw new Error('must not persist'); } });
  const frame = (method, data) => ({ protocolVersion: PROTOCOL_VERSION, requestId: method, method, data });
  assert.equal(parseFrame(JSON.stringify(frame('session.history.scan', {}))).method, 'session.history.scan');
  await host.handle(frame('session.history.scan', { sessionId, expectedChecksum: cp.checksum }));
  assert.equal(frames.at(-1).error.code, 'RUNTIME_INCOMPATIBLE');
  await host.handle(frame('initialize', { workspaceRoot: root, systemPrompt: 'Scoped', tools: [] }));
  await host.handle(frame('session.history.scan', { sessionId, expectedChecksum: cp.checksum }));
  assert.equal(frames.at(-1).ok, true);
  assert.equal(frames.at(-1).data.messages.length, 4);
  assert.equal(made, 0);
  assert.equal(persisted, 0);
});

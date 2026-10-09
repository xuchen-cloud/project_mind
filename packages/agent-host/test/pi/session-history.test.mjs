import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { encodeSession } from '../../src/session-codec.mjs';
import { readSessionHistory, historyMessageId } from '../../src/session-history.mjs';
import { createHostProtocol } from '../../src/host-protocol.mjs';
import { PROTOCOL_VERSION } from '../../src/protocol.mjs';

const root = '/tmp/history-workspace';
const sessionId = 'a'.repeat(32);
const timestamp = '2026-10-01T00:00:00.000Z';
const header = { type: 'session', version: 3, id: sessionId, timestamp, cwd: root };
const entry = (id, parentId, role, content, more = {}) => ({ type: 'message', id, parentId, timestamp,
  message: { role, content, ...more } });
const user = entry('user1', null, 'user', [{ type: 'text', text: 'A😀中B' }]);
const tool = entry('tool1', 'user1', 'toolResult', [{ type: 'text', text: 'PRIVATE TOOL LOG' }]);
const compaction = { type: 'compaction', id: 'compact1', parentId: 'tool1', timestamp,
  summary: 'PRIVATE SUMMARY', firstKeptEntryId: 'user1' };
const assistant = entry('assistant1', 'compact1', 'assistant', [
  { type: 'thinking', thinking: 'PRIVATE THOUGHT' }, { type: 'text', text: 'Done' },
  { type: 'toolCall', name: 'secret', arguments: { value: 'PRIVATE ARGUMENT' } }], { stopReason: 'stop' });
const alternate = entry('alternate1', 'user1', 'assistant', [{ type: 'text', text: 'Alternate' }], { stopReason: 'stop' });
const aborted = entry('aborted1', 'assistant1', 'assistant', [{ type: 'text', text: 'PRIVATE ABORT' }], { stopReason: 'aborted' });
const appended = entry('appended1', 'aborted1', 'user', 'Later');
const entries = [header, user, tool, compaction, assistant, alternate, aborted, appended];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const checkpoint = (leafId, source = entries) => ({ ...encodeSession(source, root), leafId });
const read = (data, cp = checkpoint('assistant1')) => readSessionHistory({ sessionId, ...data },
  { workspaceRoot: root, loadCheckpoint: async () => cp });

test('branch ancestry keeps projection ordinals, crosses compaction, and exposes text only', async () => {
  const result = await read({});
  assert.equal(result.branchId, 'assistant1');
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.messages.map((message) => [message.runtimeEntryId, message.ordinal, message.text]),
    [['user1', 0, 'A😀中B'], ['assistant1', 2, 'Done']]);
  assert.equal(result.messages[0].messageId, historyMessageId(sessionId, 'user1'));
  assert.equal(result.messages[0].contentHash, `sha256:${sha('A😀中B')}`);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const other = await read({ branchId: 'alternate1' });
  assert.deepEqual(other.messages.map((message) => message.text), ['A😀中B', 'Alternate']);
});

test('cursor pins branch through append and splits by Unicode codepoint', async () => {
  const first = await read({ maxChars: 2, limit: 1 });
  assert.equal(first.messages[0].text, 'A😀');
  assert.deepEqual([first.messages[0].charStart, first.messages[0].charEnd, first.messages[0].totalChars], [0, 2, 4]);
  const second = await read({ maxChars: 2, cursor: first.nextCursor }, checkpoint('appended1'));
  assert.equal(second.branchId, 'assistant1');
  assert.equal(second.messages[0].text, '中B');
  assert.equal(second.messages[0].contentHash, first.messages[0].contentHash);
  const third = await read({ maxChars: 2, cursor: second.nextCursor }, checkpoint('appended1'));
  assert.equal(third.messages[0].text, 'Do');
  const fourth = await read({ cursor: third.nextCursor }, checkpoint('appended1'));
  assert.equal(fourth.messages[0].text, 'ne');
  assert.equal(fourth.hasMore, false);
});

test('ranges validate branch membership, order, and cursor binding', async () => {
  const userId = historyMessageId(sessionId, 'user1');
  const assistantId = historyMessageId(sessionId, 'assistant1');
  const alternateId = historyMessageId(sessionId, 'alternate1');
  const result = await read({ fromMessageId: userId, toMessageId: assistantId, limit: 1 });
  assert.equal(result.messages.length, 1);
  const continued = await read({ cursor: result.nextCursor });
  assert.deepEqual(continued.messages.map((message) => message.text), ['Done']);
  const nullOptionals = await read({ branchId: null, fromMessageId: null, toMessageId: null,
    cursor: null, limit: null, maxChars: null });
  assert.equal(nullOptionals.messages.length, 2);
  await assert.rejects(read({ fromMessageId: alternateId }), { code: 'NOT_FOUND' });
  await assert.rejects(read({ branchId: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(read({ fromMessageId: assistantId, toMessageId: userId }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(read({ fromMessageId: userId, toMessageId: assistantId,
    cursor: { ...result.nextCursor, toMessageId: userId } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(read({ maxChars: 12001 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(read({ limit: 51 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(read({ extra: true }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(read({ cursor: { ...result.nextCursor, extra: true } }), { code: 'INVALID_ARGUMENT' });
});

test('empty checkpoint returns an empty page and unfinished assistant text is hidden', async () => {
  const empty = await read({}, checkpoint(null, [header]));
  assert.deepEqual(empty, { sessionId, branchId: null, messages: [], nextCursor: null, hasMore: false });
  const unfinished = entry('unfinished1', 'assistant1', 'assistant', [{ type: 'text', text: 'PRIVATE UNFINISHED' }]);
  const toolUse = entry('tooluse1', 'unfinished1', 'assistant', [{ type: 'text', text: 'Calling tool' }], { stopReason: 'toolUse' });
  const result = await read({}, checkpoint('tooluse1', [...entries, unfinished, toolUse]));
  assert.deepEqual(result.messages.map((message) => message.text), ['A😀中B', 'Done', 'Calling tool']);
});

test('corrupt checkpoint remains incompatible and missing checkpoint is not found', async () => {
  await assert.rejects(read({}, { ...checkpoint('assistant1'), checksum: 'sha256:bad' }), { code: 'RUNTIME_INCOMPATIBLE' });
  await assert.rejects(readSessionHistory({ sessionId }, { workspaceRoot: root, loadCheckpoint: async () => null }), { code: 'NOT_FOUND' });
  const absent = Object.assign(async () => { throw new Error('must not load'); }, { exists: async () => false });
  await assert.rejects(readSessionHistory({ sessionId }, { workspaceRoot: root, loadCheckpoint: absent }), { code: 'NOT_FOUND' });
});

test('Host history read needs initialize but neither opens a model nor persists', async () => {
  const frames = [];
  let made = 0; let persisted = 0;
  const host = createHostProtocol({ write: (frame) => frames.push(frame), workspaceRoot: root,
    loadCheckpoint: async () => checkpoint('assistant1'),
    makeSession: async () => { made++; throw new Error('must not open'); },
    persistCheckpoint: async () => { persisted++; throw new Error('must not persist'); } });
  const frame = (method, data) => ({ protocolVersion: PROTOCOL_VERSION, requestId: method, method, data });
  await host.handle(frame('session.history.read', { sessionId }));
  assert.equal(frames.at(-1).error.code, 'RUNTIME_INCOMPATIBLE');
  await host.handle(frame('initialize', { workspaceRoot: root, systemPrompt: 'Scoped', tools: [] }));
  await host.handle(frame('session.history.read', { sessionId }));
  assert.equal(frames.at(-1).ok, true);
  assert.equal(frames.at(-1).data.messages.length, 2);
  assert.equal(made, 0);
  assert.equal(persisted, 0);
});

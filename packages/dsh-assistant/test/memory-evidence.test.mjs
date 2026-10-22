import test from 'node:test';
import assert from 'node:assert/strict';
import { readMemoryMessage } from '../scripts/memory-evidence.mjs';

const context = { kind: 'project', id: 7, directory: '/project-seven' };
const source = { kind: 'message', id: 'message-1', sessionId: 'session-1', messageId: 'message-1', scope: { kind: 'project', projectId: 7 }, excerpt: 'stale saved excerpt' };
function fixture() {
  const state = { owner: '/project-seven', header: '/project-seven', reads: 0, present: true, messageSource: 'user' };
  const ctx = {
    sessionController: { list: async () => ({ items: state.present ? [{ sessionId: 'session-1', cwd: state.owner }] : [] }) },
    sessionQuery: { readSession: async () => { state.reads++; return { session: { cwd: state.header }, events: [
      { type: 'user/message', data: { id: 'message-1', source: { kind: state.messageSource }, content: [{ type: 'text', text: '原始🙂消息正文' }] } },
    ] }; } },
  };
  return { ctx, state };
}
test('reads actual message text in bounded Unicode pages instead of the saved excerpt', async () => {
  const { ctx } = fixture();
  const first = await readMemoryMessage(ctx, context, source, null, { limit: 3 });
  assert.equal(first.text, '原始🙂'); assert.equal(first.nextOffset, 3); assert.equal(first.totalChars, 7);
  const next = await readMemoryMessage(ctx, context, source, null, { offset: first.nextOffset, limit: 4 });
  assert.equal(next.text, '消息正文'); assert.equal(next.nextOffset, null); assert.equal(next.historical, true);
});
test('a missing session or original user event reports source removed without replaying its excerpt', async () => {
  const { ctx, state } = fixture(); state.present = false;
  assert.deepEqual(await readMemoryMessage(ctx, context, source), { availability: 'source_removed' }); assert.equal(state.reads, 0);
  state.present = true; state.messageSource = 'skill';
  assert.deepEqual(await readMemoryMessage(ctx, context, source), { availability: 'source_removed' });
});
test('scope and actual session ownership are enforced before and after log I/O', async () => {
  const { ctx, state } = fixture();
  assert.deepEqual(await readMemoryMessage(ctx, { ...context, id: 8 }, source), { availability: 'access_denied' });
  state.owner = '/foreign';
  assert.deepEqual(await readMemoryMessage(ctx, context, source), { availability: 'access_denied' }); assert.equal(state.reads, 0);
  state.owner = context.directory; state.header = '/foreign';
  assert.deepEqual(await readMemoryMessage(ctx, context, source), { availability: 'access_denied' });
});
test('invalid budgets and real read failures are surfaced without inventing original text', async () => {
  const { ctx } = fixture();
  await assert.rejects(readMemoryMessage(ctx, context, source, null, { limit: 12001 }), /1–12000/);
  ctx.sessionQuery.readSession = async () => { throw new Error('read failed'); };
  await assert.rejects(readMemoryMessage(ctx, context, source), /read failed/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionInventory } from '../scripts/session-inventory.mjs';

const context = { directory: '/owned', kind: 'project', id: 1 };
const scope = { kind: 'project', projectId: 1 };
function fixture() {
  const rows = [
    { sessionId: 'a', cwd: '/owned', updatedAt: 1000, projections: { values: { title: 'Plan% Alpha' } } },
    { sessionId: 'b', cwd: '/owned', updatedAt: 2000, title: 'Other', running: true },
    { sessionId: 'secret', cwd: '/foreign', updatedAt: 3000, title: 'Secret' },
  ];
  let inspected = 0;
  const sessions = {
    list: async () => ({ items: rows }),
    inspect: async id => {
      inspected++;
      assert.notEqual(id, 'secret');
      return { meta: { cwd: '/owned', createdAt: 100 }, events: [
        { type: 'user/message', seq: 0, time: 100, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: id === 'a' ? 'A Needle' : 'Elsewhere' }] } },
      ] };
    },
  };
  return { sessions, rows, inspected: () => inspected };
}

test('session inventory counts actual scope metadata without reading history and pages without duplicates', async () => {
  const f = fixture();
  const count = await sessionInventory(f.sessions, context, { scope, limit: 0 }, 'grant');
  assert.equal(count.totalCount, 2); assert.deepEqual(count.items, []); assert.equal(f.inspected(), 0);
  const first = await sessionInventory(f.sessions, context, { scope, limit: 1 }, 'grant');
  assert.equal(first.items[0].title, 'Plan% Alpha'); assert.equal(first.hasMore, true);
  const last = await sessionInventory(f.sessions, context, { scope, limit: 1, cursor: first.nextCursor }, 'grant');
  assert.equal(last.items[0].id, 'b'); assert.equal(last.hasMore, false); assert.equal(last.totalCount, 2);
  await assert.rejects(sessionInventory(f.sessions, context, { scope, cursor: first.nextCursor }, 'other-grant'), { code: 'INVALID_ARGUMENT' });
  f.rows[0].title = 'Changed';
  await assert.rejects(sessionInventory(f.sessions, context, { scope, cursor: first.nextCursor }, 'grant'), { code: 'SOURCE_CHANGED' });
});

test('session IDs, title and human text match before counts; metadata excludes content and detail includes it', async () => {
  const f = fixture();
  const input = { scope, ids: ['a'], titleQuery: '% alpha', contentQuery: 'NEEDLE' };
  const metadata = await sessionInventory(f.sessions, context, input, 'grant');
  assert.equal(metadata.totalCount, 1); assert.equal('content' in metadata.items[0], false);
  const detail = await sessionInventory(f.sessions, context, { ...input, mode: 'detail' }, 'grant');
  assert.match(detail.items[0].content, /A Needle/); assert.equal(detail.items[0].contentComplete, true);
  assert.equal((await sessionInventory(f.sessions, context, { ...input, titleQuery: '_' }, 'grant')).totalCount, 0);
  await assert.rejects(sessionInventory(f.sessions, context, { scope, budgetChars: 1 }, 'grant'), error => {
    assert.equal(error.code, 'BUDGET_EXCEEDED'); assert.equal(error.details.title, 'Plan% Alpha'); assert.ok(error.details.minimumBudgetChars > 1); return true;
  });
  await assert.rejects(sessionInventory(f.sessions, context, { scope, tag: 'unsupported' }, 'grant'), { code: 'INVALID_ARGUMENT' });
});

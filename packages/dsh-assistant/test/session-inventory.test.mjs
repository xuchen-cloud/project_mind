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

test('native Option null defaults preserve explicit zero', async () => {
  for (const input of [{ limit: null, budgetChars: null }, { limit: 0, budgetChars: null }, { limit: null, budgetChars: 4000 }]) {
    const f = fixture();
    const page = await sessionInventory(f.sessions, context, { scope, ...input }, 'grant');
    assert.equal(page.totalCount, 2);
    assert.equal(page.items.length, input.limit === 0 ? 0 : 2);
  }
});

test('content pages reuse bounded projected reads and invalidate on revision, scope and grant', async () => {
  let revision = 0, inspected = 0, textReads = 0;
  const rows = Array.from({ length: 100 }, (_, index) => ({ sessionId: String(index).padStart(3, '0'), cwd: '/owned', updatedAt: 1000 }));
  const sessions = { revision: () => revision, list: async () => ({ items: rows }), inspect: async () => {
    inspected++;
    return { meta: { cwd: '/owned', createdAt: 100 }, events: Array.from({ length: 40 }, () => ({ type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', get text() { textReads++; return 'needle'; } }] } })) };
  } };
  let cursor;
  for (let page = 0; page < 5; page++) {
    const result = await sessionInventory(sessions, context, { scope, contentQuery: 'needle', limit: 20, budgetChars: 12000, cursor }, 'grant');
    assert.equal(result.items.length, 20);
    assert.equal(result.items[0].createdAt, new Date(100).toISOString());
    cursor = result.nextCursor;
  }
  assert.equal(inspected, 100);
  assert.equal(textReads, 4000);
  revision++;
  await sessionInventory(sessions, context, { scope, contentQuery: 'needle' }, 'grant');
  assert.equal(inspected, 200);
  await sessionInventory(sessions, context, { scope, contentQuery: 'needle' }, 'new-grant');
  assert.equal(inspected, 300);
});

test('projected read cache enforces byte and entry budgets without retaining oversized content', async () => {
  const { createSessionReadCache } = await import('../scripts/session-inventory.mjs');
  const cache = createSessionReadCache({ maxBytes: 100, maxEntries: 2 });
  cache.set('a', '😀'.repeat(10)); cache.set('b', 'second');
  assert.equal(cache.size, 2);
  cache.get('a'); cache.set('c', 'third');
  assert.equal(cache.get('b'), undefined);
  cache.set('huge', 'x'.repeat(101));
  assert.equal(cache.get('huge'), undefined);
  cache.set('byte-pressure', 'x'.repeat(80));
  assert.ok(cache.bytes <= 100); assert.ok(cache.size <= 2);
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
});

test('content mutation during inspect rejects and same-row revision invalidates continuation', async () => {
  const f = fixture(); let revision = 0;
  f.sessions.revision = () => revision;
  const first = await sessionInventory(f.sessions, context, { scope, limit: 1 }, 'grant');
  revision++;
  await assert.rejects(sessionInventory(f.sessions, context, { scope, cursor: first.nextCursor }, 'grant'), { code: 'SOURCE_CHANGED' });
  const inspect = f.sessions.inspect;
  f.sessions.inspect = async id => { const result = await inspect(id); revision++; return result; };
  await assert.rejects(sessionInventory(f.sessions, context, { scope, contentQuery: 'needle' }, 'grant'), { code: 'SOURCE_CHANGED' });
});

test('shared content cache clears on scope/grant change and isolates concurrent namespaces', async () => {
  const { createSessionReadCache } = await import('../scripts/session-inventory.mjs');
  const state = { cache: createSessionReadCache() };
  const first = fixture(), second = fixture();
  for (const f of [first, second]) { f.sessions.revision = () => 0; f.sessions.readCacheState = state; }
  await sessionInventory(first.sessions, context, { scope, contentQuery: 'needle' }, 'grant');
  await sessionInventory(second.sessions, context, { scope, contentQuery: 'needle' }, 'grant');
  assert.equal(second.inspected(), 0);
  await sessionInventory(second.sessions, context, { scope, contentQuery: 'needle' }, 'new-grant');
  assert.equal(second.inspected(), 2);
  const otherScope = { kind: 'project', projectId: 2 };
  await sessionInventory(second.sessions, { ...context, id: 2 }, { scope: otherScope, contentQuery: 'needle' }, 'new-grant');
  assert.equal(second.inspected(), 4);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  first.sessions.inspect = async () => { await gate; return { meta: { cwd: '/owned', createdAt: 100 }, events: [] }; };
  const pending = sessionInventory(first.sessions, context, { scope, contentQuery: 'nothing' }, 'concurrent');
  await new Promise(resolve => setImmediate(resolve));
  await sessionInventory(second.sessions, context, { scope, contentQuery: 'needle' }, 'new-grant');
  release(); await pending;
  const reused = await sessionInventory(second.sessions, context, { scope, contentQuery: 'needle' }, 'new-grant');
  assert.equal(reused.totalCount, 1);
});

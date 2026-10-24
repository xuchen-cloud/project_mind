import { createHash } from 'node:crypto';
import { isAppendSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session/surface';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const size = value => [...JSON.stringify(value)].length;
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const contains = (text, query) => query == null || text.toLowerCase().includes(query.toLowerCase());

function transcript(events) {
  return events.filter(event => isAppendSurfaceEvent(event)
    && ['user/message', 'assistant/message', 'tool/result'].includes(event.type))
    .map(event => {
      const message = deriveEventMessage(event);
      const text = typeof message?.content === 'string' ? message.content
        : (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      return `[${message?.role ?? event.type}]\n${text}`;
    }).join('\n\n');
}

// Reads the actual DSH controller; never resumes an Agent or scans a second history database.
export async function sessionInventory(sessions, context, input, authorization, signal) {
  const { limit = 20, budgetChars = 4000, mode = 'metadata', ids = [], titleQuery, contentQuery } = input;
  if (!Number.isInteger(limit) || limit < 0 || limit > 50 || !Number.isInteger(budgetChars)
    || budgetChars < 1 || budgetChars > 12000 || !['metadata', 'detail'].includes(mode)
    || !Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id || id.length > 128)
    || [titleQuery, contentQuery].some(q => q != null && (typeof q !== 'string' || !q.trim() || [...q].length > 256))
    || input.tag != null || (input.tagIds?.length ?? 0) > 0) fail('INVALID_ARGUMENT', 'Invalid session list filters');
  const catalog = async () => (await sessions.list({}, signal)).items
    .filter(row => row.cwd === context.directory).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const rows = await catalog();
  const snapshot = hash(rows);
  const query = hash({ authorization, scope: input.scope, mode, ids, titleQuery, contentQuery });
  let after = '';
  if (input.cursor != null) {
    let cursor;
    try { if (typeof input.cursor !== 'string' || input.cursor.length > 2048) throw Error(); cursor = JSON.parse(Buffer.from(input.cursor, 'base64url')); }
    catch { fail('INVALID_ARGUMENT', 'Invalid session list cursor'); }
    if (cursor.query !== query || typeof cursor.id !== 'string') fail('INVALID_ARGUMENT', 'Session cursor belongs to another query or grant');
    if (cursor.snapshot !== snapshot) fail('SOURCE_CHANGED', 'Session inventory changed; restart without cursor');
    after = cursor.id;
  }
  const candidates = [];
  let totalCount = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    const title = row.title || row.projections?.values?.title || '新会话';
    if ((ids.length && !ids.includes(row.sessionId)) || !contains(title, titleQuery)) continue;
    const inWindow = limit > 0 && row.sessionId.localeCompare(after) > 0 && candidates.length < limit + 1;
    let content;
    let createdAt = null;
    if (contentQuery != null || (inWindow && mode === 'detail')) {
      const inspection = await sessions.inspect(row.sessionId, signal);
      if (inspection.meta.cwd !== context.directory) fail('SCOPE_DENIED', 'Session moved outside the authorized scope');
      content = transcript(inspection.events);
      createdAt = new Date(inspection.meta.createdAt).toISOString();
      if (!contains(content, contentQuery)) continue;
    }
    totalCount++;
    if (inWindow) candidates.push({ id: row.sessionId, scope: input.scope, title,
      updatedAt: new Date(row.updatedAt).toISOString(), createdAt,
      running: Boolean(row.running), pinned: Boolean(row.pinned),
      ...(mode === 'detail' ? { content, contentFormat: 'conversationText', contentComplete: true } : {}) });
  }
  if (hash(await catalog()) !== snapshot) fail('SOURCE_CHANGED', 'Session inventory changed while reading');
  const page = { scope: input.scope, items: [], totalCount, staleCount: 0, hasMore: false, nextCursor: null };
  const cursor = id => Buffer.from(JSON.stringify({ query, snapshot, id })).toString('base64url');
  for (const [index, item] of candidates.slice(0, limit).entries()) {
    page.items.push(item);
    page.hasMore = index + 1 < candidates.length;
    page.nextCursor = page.hasMore ? cursor(item.id) : null;
    const required = size(page);
    if (required > budgetChars) {
      page.items.pop();
      if (!page.items.length) fail('BUDGET_EXCEEDED', 'Session item does not fit budget; increase budgetChars or use metadata mode',
        { title: [...item.title].slice(0, 120).join(''), id: item.id, minimumBudgetChars: required });
      page.hasMore = true; page.nextCursor = cursor(page.items.at(-1).id); break;
    }
  }
  if (size(page) > budgetChars) fail('BUDGET_EXCEEDED', 'Session list metadata does not fit budget');
  return page;
}

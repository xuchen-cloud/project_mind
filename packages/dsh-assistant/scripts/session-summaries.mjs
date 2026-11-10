import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { syncDirectory } from './fs-durability.mjs';
import { createSessionReadCache } from './session-inventory.mjs';

// This is a derived title index, never membership or content authority. DSH's
// cached projection hints have lifecycle identity but no physical source revision.
// Keep them as hints; repair through the public logical query (including codecs
// and historical generations), without preparing any Session projections.
export function createSessionSummaries(ctx, { home, canPublish, changed }) {
  const cache = createSessionReadCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 1024 });
  const queue = new Map();
  const abort = new AbortController();
  let timer, active, work, running = false, revision = 0;
  const identity = header => JSON.stringify(header);
  const filename = id => path.join(home, 'mind-session-summaries', createHash('sha256').update(id).digest('hex') + '.json');
  const warn = error => ctx.logger?.warn?.(`Session title summary repair failed: ${String(error)}`);
  async function load(id) {
    let entry = cache.get(id);
    if (entry) return entry;
    if (home) {
      try {
        const value = JSON.parse(await readFile(filename(id), 'utf8'));
        if (value.version !== 1 || value.header?.id !== id || typeof value.revision !== 'string'
          || value.title !== null && (typeof value.title?.title !== 'string' || !Number.isSafeInteger(value.title.eventSeq))) {
          throw new Error(`Invalid derived title summary for ${id}`);
        }
        entry = { value }; // revision tokens are only authoritative within a service instance
      } catch (error) { if (error.code !== 'ENOENT') warn(error); }
    }
    entry ??= {};
    cache.set(id, entry);
    return entry;
  }
  async function persist(id, value) {
    if (!home) return;
    const file = filename(id), directory = path.dirname(file);
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    await syncDirectory(directory);
  }
  function schedule() {
    if (timer || running || abort.signal.aborted || !queue.size) return;
    // Yield the response first. One logical title read at a time, only for
    // requested scopes; missing legacy indexes never block the list response.
    timer = setTimeout(() => { timer = undefined; work = repair(); }, 25);
    timer.unref();
  }
  async function repair() {
    running = true;
    const [id, expected] = queue.entries().next().value;
    queue.delete(id);
    active = { id, source: expected };
    try {
      const persistence = ctx.sessionPersistence;
      const before = await persistence.stat(id, { signal: abort.signal });
      if (!before || identity(before.header) !== identity(expected.header) || before.revision !== expected.revision
        || ctx.sessions?.get(id) || !canPublish(before.header)) return;
      const observation = await ctx.sessionQuery.readTitleSnapshot(id, abort.signal);
      const after = await persistence.stat(id, { signal: abort.signal });
      abort.signal.throwIfAborted();
      if (!after || before.revision !== after.revision || identity(observation.session) !== identity(before.header)
        || identity(after.header) !== identity(before.header) || ctx.sessions?.get(id) || !canPublish(after.header)) return;
      const value = { version: 1, header: after.header, revision: after.revision, title: observation.title ?? null };
      await persist(id, value);
      abort.signal.throwIfAborted();
      cache.set(id, { value, verified: after.revision, persistence: persistence.identity });
      revision++; changed();
    } catch (error) { if (!abort.signal.aborted) warn(error); }
    finally { active = undefined; running = false; schedule(); }
  }
  return {
    revision: () => revision,
    async hint(row, source) {
      if (!source) return row;
      const entry = await load(row.sessionId);
      const matches = entry.value && identity(entry.value.header) === identity(source.header);
      if (ctx.sessionQuery?.readTitleSnapshot && ctx.sessionPersistence?.stat
        && (!matches || entry.verified !== source.revision || entry.persistence !== ctx.sessionPersistence.identity)) {
        if (active?.id !== row.sessionId || active.source.revision !== source.revision) queue.set(row.sessionId, source);
        schedule();
      }
      if (!matches || entry.verified !== source.revision && (row.projections?.asOfSeq ?? 0) > (entry.value.title?.eventSeq ?? -1)) return row;
      // Even a confirmed no-title result replaces a stale predecessor hint.
      return { ...row, title: entry.value.title?.title ?? null, projections: { kind: 'cached', asOfSeq: entry.value.title?.eventSeq ?? -1,
        values: { ...row.projections?.values, title: entry.value.title?.title ?? null } } };
    },
    async dispose() { abort.abort(); clearTimeout(timer); queue.clear(); await work; cache.clear(); },
  };
}

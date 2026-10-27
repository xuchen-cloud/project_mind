import path from 'node:path';
import { normalizeDirectory } from './context-directory.mjs';
import { watch } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sessionInventory, createSessionReadCache } from './session-inventory.mjs';
import { searchContextSessions } from './context-session-reads.mjs';
import { syncDirectory } from './fs-durability.mjs';
import { realpath, stat, readFile, open, rename, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { isAppendSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session/surface';

// The native host supplies exactly one real scope. DSH_HOME is assigned by the
// host separately, so the Workspace and its Projects never share history.
export async function readContext(line) {
  let frame;
  try { frame = JSON.parse(line); } catch { throw new Error('Invalid main context configuration'); }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)
    || Object.hasOwn(frame, 'project') === Object.hasOwn(frame, 'workspace')) {
    throw new Error('Invalid main context configuration');
  }
  const kind = Object.hasOwn(frame, 'project') ? 'project' : 'workspace';
  const context = frame[kind];
  const validId = kind === 'project'
    ? Number.isSafeInteger(context?.id) && context.id > 0
    : typeof context?.id === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(context.id);
  if (!context || !validId
    || typeof context.name !== 'string' || !context.name.trim()
    || typeof context.directory !== 'string' || !path.isAbsolute(context.directory)) {
    throw new Error(`Invalid main ${kind} configuration`);
  }
  const directory = await realpath(context.directory);
  if (!(await stat(directory)).isDirectory()) throw new Error(`Main ${kind} directory is unavailable`);
  return { kind, id: context.id, name: context.name.trim(), directory };
}

// A native scope is registered once and remains independent of the visible page.
// Controllers retain their original persistence and execution admission rules.
export async function bindContext(ctx, initial, { home, cli } = {}) {
  const workspaces = ctx.workspaceController;
  const sessions = ctx.sessionController;
  const original = {
    create: workspaces.create, initializeDefault: workspaces.initializeDefault,
    rename: workspaces.rename, delete: workspaces.delete, sessionCreate: sessions.create,
    sessionList: sessions.list, sessionFollow: sessions.follow,
  };
  const contexts = new Map();
  const directories = new Map();
  const revokedWorkspaces = new Set();
  const workspacePaths = new Map();
  const sessionVersions = new Map();
  let committedArchived;
  let catalogGeneration = 0, contentRevision = 0;
  let catalog, catalogPending;
  let readSerial = 0, minimumSerial = 0, checkedAt = 0, persistedRevision;
  let persistenceWatcher, watcherFailed = false, watchGeneration = 0;
  const liveArtifacts = new Map();
  const rememberLiveArtifact = session => {
    const located = ctx.sessionPersistence?.locate?.(session.header);
    if (home && located?.path) liveArtifacts.set(path.relative(home, located.path), session.id);
  };
  for (const session of ctx.sessions?.list?.() ?? []) rememberLiveArtifact(session);
  // The pinned controller calls query.listSessions -> persistence.list. Retain
  // that exact snapshot inside this catalogue request, including its revisions,
  // rather than traversing the same JSONL corpus a second time.
  const catalogRead = new AsyncLocalStorage();
  const persistence = ctx.sessionPersistence;
  const originalPersistenceList = persistence?.list;
  if (persistence) persistence.list = function (...args) {
    const read = catalogRead.getStore();
    if (!read) return originalPersistenceList.apply(this, args);
    return read.persisted ??= originalPersistenceList.apply(this, args);
  };
  const RECONCILE_MS = 5000;
  const titles = createSessionReadCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 1024 });
  const inventoryCache = { cache: createSessionReadCache() };
  const attachments = createSessionReadCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 128 });
  const invalidate = () => {
    catalogGeneration++; contentRevision++; catalog = undefined;
    titles.clear(); attachments.clear(); inventoryCache.cache.clear(); sessionVersions.clear();
  };
  // The JSONL lifecycle emits creation/disposal; cwd is immutable on a Session
  // generation. Workspace domain deltas also cover archive/unarchive and scope
  // changes, and arrive before the registry entity has finished updating.
  ctx.on?.('session/created', session => { rememberLiveArtifact(session); invalidate(); });
  ctx.on?.('session/disposed', session => {
    for (const [artifact, id] of liveArtifacts) if (id === session.id) liveArtifacts.delete(artifact);
    invalidate();
  });
  ctx.on?.('session/event', session => {
    contentRevision++; inventoryCache.cache.clear();
    sessionVersions.set(session.id, (sessionVersions.get(session.id) ?? 0) + 1);
    titles.delete(session.id); attachments.delete(session.id);
  });
  ctx.on?.('domain/changed', change => {
    if (change.domain !== 'workspace') return;
    if (change.table === '' && change.operation === 'put') committedArchived = new Set(change.value.archivedSessionIds);
    if (change.table === 'workspaces') {
      if (change.operation === 'deleted') revokedWorkspaces.add(change.key);
      else { revokedWorkspaces.delete(change.key); workspacePaths.set(change.key, change.value.path); }
    }
    invalidate();
  });
  const readCatalog = async (signal, refresh = false) => {
    signal?.throwIfAborted();
    // Native DSH events do not observe writes by another process. A recursive
    // home watcher supplies that generation; a bounded persistence revision
    // reconciliation also catches missed/coalesced platform notifications.
    if (refresh || watcherFailed || performance.now() - checkedAt >= RECONCILE_MS) {
      minimumSerial = Math.max(minimumSerial, readSerial + 1);
      catalog = undefined;
    }
    while (!catalog || catalog.serial < minimumSerial || catalog.watchGeneration !== watchGeneration) {
      if (!catalogPending) {
        const generation = catalogGeneration;
        const observedWatch = watchGeneration;
        const serial = ++readSerial;
        // Sharing the I/O does not transfer one caller's cancellation to others.
        const pending = (async () => {
          const read = {};
          const value = await catalogRead.run(read, () => original.sessionList.call(sessions, {}));
          const persisted = ctx.sessionPersistence ? await (read.persisted ?? ctx.sessionPersistence.list()) : undefined;
          const revision = persisted && createHash('sha256').update(JSON.stringify(persisted.map(item => {
            const live = ctx.sessions?.get(item.header.id);
            // Live append revisions already have session/event invalidation.
            // Physical 200ms drains must not invalidate unrelated cold caches.
            return [live?.header ?? item.header, live ? 'live' : item.revision];
          })
            .sort((a, b) => a[0].id.localeCompare(b[0].id)))).digest('hex');
          if (generation === catalogGeneration && serial >= minimumSerial && observedWatch === watchGeneration) {
            if (persistedRevision !== undefined && revision !== persistedRevision) invalidate();
            persistedRevision = revision;
            checkedAt = performance.now();
            catalog = { generation: catalogGeneration, watchGeneration, serial, value, byId: new Map(value.items.map(row => [row.sessionId, row])) };
            for (const id of sessionVersions.keys()) if (!catalog.byId.has(id)) sessionVersions.delete(id);
          }
        })().finally(() => { if (catalogPending === pending) catalogPending = undefined; });
        catalogPending = pending;
      }
      if (!signal) await catalogPending;
      else {
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        try { await Promise.race([catalogPending, cancelled]); }
        finally { signal.removeEventListener('abort', abort); }
      }
      signal?.throwIfAborted();
    }
    return catalog;
  };
  const key = value => `${value.kind ?? 'project'}:${value.id}`;
  const isRemoved = id => committedArchived ? committedArchived.has(id) : ctx.workspaceRegistry.archivedSessionIds.includes(id);
  const file = home && path.join(home, 'mind-contexts.json');
  let mappings = { version: 1, contexts: [] };
  if (file) {
    try { mappings = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (mappings.version !== 1 || !Array.isArray(mappings.contexts)) throw new Error('Invalid native context mappings');
  }
  const save = async () => {
    if (!file) return;
    await mkdir(home, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(mappings) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    await syncDirectory(home);
  };
  const current = context => {
    const value = ctx.workspaceRegistry.get(context.workspaceId);
    return { workspace: { workspaceId: value.id, path: value.path, title: value.title,
      sessionIds: value.sessionIds, createdAt: value.createdAt, updatedAt: value.updatedAt } };
  };
  let chain = Promise.resolve();
  const register = (context, binding) => {
    const next = chain.then(async () => {
      context = await readContext(JSON.stringify({ [context.kind ?? 'project']: context }));
      const existing = contexts.get(key(context));
      const persisted = mappings.contexts.find(item => key(item) === key(context));
      if (existing && normalizeDirectory(existing.directory) !== normalizeDirectory(context.directory)) throw new Error('Context directory changed; restart the assistant');
      if ([...contexts.values(), ...mappings.contexts].some(item => key(item) !== key(context) && normalizeDirectory(item.directory) === normalizeDirectory(context.directory))) throw new Error('Context directory already belongs to another native scope');
      let workspaceId = persisted?.workspaceId;
      if (workspaceId) {
        const record = ctx.workspaceRegistry.get(workspaceId);
        if (!record || normalizeDirectory(record.path) !== normalizeDirectory(context.directory) || normalizeDirectory(persisted.directory) !== normalizeDirectory(context.directory)) throw new Error('Native context directory changed; restart to restore its history');
      } else {
        const { workspace } = await original.create.call(workspaces, { path: context.directory });
        workspaceId = workspace.workspaceId;
      }
      const mapped = ctx.workspaceRegistry.get(workspaceId);
      // Native display names may repeat across scopes; the registry identity owns
      // membership, while the standalone rename UI enforces unique display names.
      if (mapped.title !== undefined && mapped.title !== context.name) await mapped.setTitle(context.name);
      if (!persisted) {
        mappings.contexts.push({ kind: context.kind, id: context.id, directory: context.directory, workspaceId });
        await save();
      }
      const value = { ...context, workspaceId, ...(binding ? { cli: binding } : existing?.cli ? { cli: existing.cli } : {}) };
      contexts.set(key(context), value);
      directories.set(value.directory, value);
      invalidate();
      return value;
    });
    chain = next.catch(() => {});
    return next;
  };
  const bootstrap = await register(initial, cli);
  if (home) {
    try {
      persistenceWatcher = watch(home, { recursive: true }, (_event, filename) => {
        if (filename == null) { watchGeneration++; return; }
        const relative = String(filename);
        if (relative.split(path.sep)[0] !== 'sessions') return;
        const liveId = liveArtifacts.get(relative);
        // macOS recursive fs.watch reports append+fsync as "rename" too. The
        // public Session/query lifecycle gives attached Sessions live precedence;
        // their immutable header and session/event already govern authority and
        // content. Never infer a logical Session deletion from this event kind.
        // Cold files and directory/unknown paths still invalidate immediately;
        // the 5s reconciliation checks physical state even for attached files.
        if (liveId && ctx.sessions.get(liveId)) return;
        watchGeneration++;
      });
      persistenceWatcher.unref();
      persistenceWatcher.on('error', () => { watcherFailed = true; invalidate(); });
    } catch { watcherFailed = true; }
  }
  const available = context => context && !revokedWorkspaces.has(context.workspaceId)
    && (!workspacePaths.has(context.workspaceId) || normalizeDirectory(workspacePaths.get(context.workspaceId)) === normalizeDirectory(context.directory));
  const select = selector => {
    const value = contexts.get(key(selector ?? bootstrap));
    if (!available(value) || selector?.directory !== undefined && normalizeDirectory(selector.directory) !== normalizeDirectory(value.directory)) throw Object.assign(new Error('Native context is not registered'), { code: 'SCOPE_DENIED' });
    return value;
  };
  const scopeForSession = async (sessionId, signal) => {
    let state = await readCatalog(signal);
    while (state.generation !== catalogGeneration || state.watchGeneration !== watchGeneration) state = await readCatalog(signal);
    signal?.throwIfAborted();
    const row = state.byId.get(sessionId);
    const context = row && directories.get(row.cwd);
    return available(context) ? context : undefined;
  };
  const forSession = async (sessionId, signal) => {
    if (typeof sessionId !== 'string' || !sessionId || isRemoved(sessionId)) throw new Error('Session was removed or is unavailable');
    while (true) {
      const generation = catalogGeneration;
      const context = await scopeForSession(sessionId, signal);
      if (generation !== catalogGeneration) continue;
      if (!available(context) || isRemoved(sessionId)) throw new Error('Session belongs to another context');
      return context;
    }
  };
  const registry = {
    workspace: bootstrap, register, forSession, scopeForSession, select,
    revision: () => `${contentRevision}:${watchGeneration}`,
    async snapshot(context, signal) {
      const { value: rows } = await readCatalog(signal);
      select(context);
      const mapped = ctx.workspaceRegistry.get(context.workspaceId);
      // Current Session creation persists its history before attaching it to
      // the Workspace. Repair that crash window only when membership is read;
      // registering a native scope must not enumerate shared Session history.
      for (const item of rows.items) {
        signal?.throwIfAborted();
        if (item.cwd === context.directory && !isRemoved(item.sessionId) && !mapped.sessionIds.includes(item.sessionId)) {
          await mapped.attachSession(item.sessionId);
          signal?.throwIfAborted();
          select(context);
        }
      }
      const value = current(context).workspace;
      const own = new Set(rows.items.filter(item => item.cwd === context.directory).map(item => item.sessionId));
      return { items: [value], archivedSessionIds: [...(committedArchived ?? ctx.workspaceRegistry.archivedSessionIds)].filter(id => own.has(id)),
        pinnedSessionIds: (ctx.workspaceRegistry.pinnedSessionIds ?? []).filter(id => own.has(id)) };
    },
    forAgent(agent) {
      const context = directories.get(agent?.session?.header?.cwd);
      if (!available(context) || isRemoved(agent.session.id)) throw new Error('Agent belongs to another context');
      return context;
    },
  };
  ctx.mindContexts = registry;
  const initialize = async (context, signal) => ({ workspace: (await registry.snapshot(context, signal)).items[0] });
  workspaces.initializeDefault = () => initialize(bootstrap);
  workspaces.create = async request => {
    const directory = await realpath(request.path);
    const context = [...contexts.values()].find(item => item.directory === directory);
    if (!context) throw new Error('Use the main application navigation');
    return { ...current(context), created: false };
  };
  workspaces.rename = workspaces.delete = async () => { throw new Error('Manage workspaces and projects in the main application'); };
  sessions.list = async (request = {}, signal) => {
    let state = await readCatalog(signal, true);
    while (state.generation !== catalogGeneration || state.watchGeneration !== watchGeneration || state.serial < minimumSerial) state = await readCatalog(signal);
    const { value, generation } = state;
    const directory = request.cwd ?? bootstrap.directory;
    const candidates = value.items.filter(item => !isRemoved(item.sessionId) && (request.cwd === undefined || item.cwd === directory));
    const versions = new Map(candidates.filter(item => item.cwd === directory && item.agentAvailable === false)
      .map(item => [item.sessionId, sessionVersions.get(item.sessionId) ?? 0]));
    const hydrated = [];
    for (const item of candidates) {
      if (item.cwd === directory && item.agentAvailable === false) {
        // Cached list hints may be predecessors. Validate once through the
        // projection controller, then retain only the small title projection.
        const fingerprint = JSON.stringify([item.cwd, item.updatedAt, item.title, item.projections?.kind,
          item.projections?.asOfSeq, item.projections?.values?.title]);
        const cached = titles.get(item.sessionId);
        let projection = cached && (cached.fingerprint === fingerprint || cached.updatedAt === item.updatedAt && cached.cwd === item.cwd
          && item.projections?.values?.title === cached.projection.values.title) ? cached.projection : undefined;
        if (!projection) {
          const version = sessionVersions.get(item.sessionId) ?? 0;
          const block = await sessions.projections({ sessionId: item.sessionId }, signal);
          signal?.throwIfAborted();
          if (block === null) throw new Error('Session disappeared while loading its title');
          if (generation !== catalogGeneration || version !== (sessionVersions.get(item.sessionId) ?? 0)) throw new Error('Session changed while loading its title');
          projection = { kind: 'sequenced', asOfSeq: block.asOfSeq, values: { title: block.values.title } };
          titles.set(item.sessionId, { fingerprint, updatedAt: item.updatedAt, cwd: item.cwd, projection });
        }
        hydrated.push({ ...item, projections: { ...item.projections, ...projection, values: { ...item.projections?.values, ...projection.values } } });
      } else hydrated.push(item);
    }
    let finalState = await readCatalog(signal);
    while (finalState.watchGeneration !== watchGeneration) finalState = await readCatalog(signal);
    if (generation !== catalogGeneration || [...versions].some(([id, version]) => version !== (sessionVersions.get(id) ?? 0))) throw new Error('Session list changed while reading');
    const pins = new Map((ctx.workspaceRegistry.pinnedSessionIds ?? []).map((id, index) => [id, index]));
    const items = hydrated.filter(item => !isRemoved(item.sessionId)).map(item => ({ ...item, pinned: pins.has(item.sessionId) }));
    items.sort((a, b) => (pins.get(a.sessionId) ?? pins.size) - (pins.get(b.sessionId) ?? pins.size));
    return { ...value, items };
  };
  sessions.follow = function(...args) {
    const id = args[0]?.address?.sessionId ?? args[0]?.sessionId;
    if (id && isRemoved(id)) throw new Error('Session was removed from this context');
    return original.sessionFollow.apply(sessions, args);
  };
  const create = async (request, context) => {
    if (request.sessionId) {
      if (isRemoved(request.sessionId)) throw new Error('Session was removed from this context');
      const rows = await original.sessionList.call(sessions, {});
      const existing = rows.items.find(item => item.sessionId === request.sessionId);
      if (existing && existing.cwd !== context.directory) throw new Error('Session belongs to another context');
    }
    if (request.workspaceId !== undefined && request.workspaceId !== context.workspaceId
      || request.cwd !== undefined && await realpath(request.cwd) !== context.directory) throw new Error('Session belongs to another context');
    const { cwd, context: ignored, ...rest } = request;
    try { return await original.sessionCreate.call(sessions, { ...rest, workspaceId: context.workspaceId }); } finally { invalidate(); }
  };
  sessions.create = request => create(request, bootstrap);
  function route(method, dispatch) {
    ctx.connection.fetch.register({ path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('invalid content type', { status: 415 });
        let frame;
        try { frame = clientRequestSchema.parse(await request.json()); } catch { return new Response('invalid request', { status: 400 }); }
        if (frame.method !== method) return new Response('invalid method', { status: 400 });
        let result;
        try { result = { ok: true, value: await dispatch(frame.payload?.args?.request, request.signal) }; }
        catch (error) { result = { ok: false, error: { code: 'gateway/internal', message: String(error.message ?? error), details: {} } }; }
        return Response.json({ type: 'server-response', rpcId: frame.rpcId, result });
      },
    });
  }
  route('mind/context', async request => ({ workspaceId: (await register(request.context, request.cli)).workspaceId }));
  route('mind/session/context', async (request, signal) => {
    const { kind, id, name, directory } = await forSession(request.sessionId, signal);
    return { context: { kind, id, name, directory } };
  });
  route('mind/workspace/initializeDefault', (request, signal) => initialize(select(request.context), signal));
  route('mind/session/list', (request, signal) => sessions.list({ cwd: select(request.context).directory }, signal));
  route('mind/session/create', request => create(request, select(request.context)));
  route('mind/session/search', (request, signal) => searchContextSessions(ctx, registry, select(request.context), request, signal));
  route('mind/session/fileAccess', async (request, signal) => {
    const context = select(request.context);
    if (typeof request.path !== 'string' || !path.isAbsolute(request.path)) throw new Error('Attachment path must be absolute');
    const requested = await realpath(request.path);
    const rows = (await readCatalog(signal)).value.items.filter(row => row.cwd === context.directory && !isRemoved(row.sessionId));
    const revision = contentRevision;
    for (const row of rows) {
      let locatedPaths = attachments.get(row.sessionId);
      if (!locatedPaths) {
        const inspection = await sessions.inspect(row.sessionId, signal);
        if (revision !== contentRevision) throw new Error('Attachment Session changed while reading');
        locatedPaths = [];
        for (const event of inspection.events) {
          if (!isAppendSurfaceEvent(event)) continue;
          for (const block of deriveEventMessage(event)?.content ?? []) {
            if (!block.attachment || !['image', 'file'].includes(block.type)) continue;
            const located = block.type === 'image' ? ctx.attachments.imageHostPath(block.attachment) : ctx.attachments.fileHostPath(block.attachment);
            if (located) locatedPaths.push(located);
          }
        }
        attachments.set(row.sessionId, [...new Set(locatedPaths)]);
      }
      // Resolve paths at the I/O boundary each time: symlink targets are mutable.
      for (const located of locatedPaths) {
        if (await realpath(located) !== requested) continue;
        const owner = await forSession(row.sessionId, signal);
        signal?.throwIfAborted();
        if (revision !== contentRevision || key(owner) !== key(context)) throw new Error('Attachment Session scope changed');
        return { allowed: true };
      }
    }
    return { allowed: false };
  });
  route('mind/session/delete', async (request, signal) => {
    const context = select(request.context);
    if (key(await forSession(request.sessionId, signal)) !== key(context)) throw new Error('Session belongs to another context');
    await ctx.workspaceRegistry.archiveSession(request.sessionId);
    invalidate();
    ctx.emit('api-session/removed', request.sessionId);
    return null;
  });
  // Stable per-scope facades own bounded, grant-sensitive projected reads.
  const inventoryControllers = new Map();
  route('mind/session/inventory', async (request, signal) => {
    try {
      const { input, authorization } = request;
      const context = select(request.context ?? (input.scope?.kind === 'project' ? { kind: 'project', id: input.scope.projectId } : bootstrap));
      if (typeof authorization !== 'string' || !authorization || input.scope?.kind !== context.kind
        || context.kind === 'project' && input.scope.projectId !== context.id) throw Object.assign(new Error('Session scope mismatch'), { code: 'SCOPE_DENIED' });
      let controller = inventoryControllers.get(key(context));
      if (!controller) {
        controller = { list: (_request, signal) => sessions.list({ cwd: context.directory }, signal),
          inspect: (id, signal) => sessions.inspect(id, signal), revision: () => contentRevision, readCacheState: inventoryCache };
        inventoryControllers.set(key(context), controller);
      }
      return { page: await sessionInventory(controller, context, input, authorization, signal) };
    } catch (error) { return { error: { code: error.code ?? 'RUNTIME_UNAVAILABLE', message: String(error.message ?? error), retryable: false, ...(error.details ? { details: error.details } : {}) } }; }
  });
  ctx.effect(() => () => {
    persistenceWatcher?.close();
    if (persistence) persistence.list = originalPersistenceList;
    liveArtifacts.clear();
    invalidate(); directories.clear(); contexts.clear(); workspacePaths.clear(); inventoryControllers.clear();
    workspaces.create = original.create; workspaces.initializeDefault = original.initializeDefault;
    workspaces.rename = original.rename; workspaces.delete = original.delete;
    sessions.create = original.sessionCreate; sessions.list = original.sessionList; sessions.follow = original.sessionFollow;
  });
  return registry;
}

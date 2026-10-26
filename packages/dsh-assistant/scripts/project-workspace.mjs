import path from 'node:path';
import { sessionInventory } from './session-inventory.mjs';
import { searchContextSessions } from './context-session-reads.mjs';
import { syncDirectory } from './fs-durability.mjs';
import { realpath, stat, readFile, open, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  const key = value => `${value.kind ?? 'project'}:${value.id}`;
  const isRemoved = id => ctx.workspaceRegistry.archivedSessionIds.includes(id);
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
      if (existing && existing.directory !== context.directory) throw new Error('Context directory changed; restart the assistant');
      if ([...contexts.values()].some(item => key(item) !== key(context) && item.directory === context.directory)) throw new Error('Context directory already belongs to another native scope');
      let workspaceId = persisted?.workspaceId;
      if (workspaceId) {
        const record = ctx.workspaceRegistry.get(workspaceId);
        if (!record || record.path !== context.directory || persisted.directory !== context.directory) throw new Error('Native context directory changed; restart to restore its history');
      } else {
        const { workspace } = await original.create.call(workspaces, { path: context.directory });
        workspaceId = workspace.workspaceId;
      }
      const mapped = ctx.workspaceRegistry.get(workspaceId);
      const catalog = await original.sessionList.call(sessions, {});
      for (const item of catalog.items) {
        if (item.cwd === context.directory && !isRemoved(item.sessionId) && !mapped.sessionIds.includes(item.sessionId)) await mapped.attachSession(item.sessionId);
      }
      // Native display names may repeat across scopes; the registry identity owns
      // membership, while the standalone rename UI enforces unique display names.
      if (mapped.title !== undefined && mapped.title !== context.name) await mapped.setTitle(context.name);
      if (!persisted) {
        mappings.contexts.push({ kind: context.kind, id: context.id, directory: context.directory, workspaceId });
        await save();
      }
      const value = { ...context, workspaceId, ...(binding ? { cli: binding } : existing?.cli ? { cli: existing.cli } : {}) };
      contexts.set(key(context), value);
      return value;
    });
    chain = next.catch(() => {});
    return next;
  };
  const bootstrap = await register(initial, cli);
  const select = selector => {
    const value = contexts.get(key(selector ?? bootstrap));
    if (!value || selector?.directory !== undefined && selector.directory !== value.directory) throw Object.assign(new Error('Native context is not registered'), { code: 'SCOPE_DENIED' });
    return value;
  };
  const scopeForSession = async (sessionId, signal) => {
    const catalog = await original.sessionList.call(sessions, {}, signal);
    signal?.throwIfAborted();
    const row = catalog.items.find(item => item.sessionId === sessionId);
    return row && [...contexts.values()].find(item => item.directory === row.cwd);
  };
  const forSession = async (sessionId, signal) => {
    if (typeof sessionId !== 'string' || !sessionId || isRemoved(sessionId)) throw new Error('Session was removed or is unavailable');
    const context = await scopeForSession(sessionId, signal);
    if (!context || isRemoved(sessionId)) throw new Error('Session belongs to another context');
    return context;
  };
  const registry = {
    workspace: bootstrap, register, forSession, scopeForSession, select,
    async snapshot(context, signal) {
      const value = current(context).workspace;
      const rows = await original.sessionList.call(sessions, {}, signal);
      const own = new Set(rows.items.filter(item => item.cwd === context.directory).map(item => item.sessionId));
      return { items: [value], archivedSessionIds: ctx.workspaceRegistry.archivedSessionIds.filter(id => own.has(id)),
        pinnedSessionIds: (ctx.workspaceRegistry.pinnedSessionIds ?? []).filter(id => own.has(id)) };
    },
    forAgent(agent) {
      const context = [...contexts.values()].find(item => item.directory === agent?.session?.header?.cwd);
      if (!context || isRemoved(agent.session.id)) throw new Error('Agent belongs to another context');
      return context;
    },
  };
  ctx.mindContexts = registry;
  workspaces.initializeDefault = async () => current(bootstrap);
  workspaces.create = async request => {
    const directory = await realpath(request.path);
    const context = [...contexts.values()].find(item => item.directory === directory);
    if (!context) throw new Error('Use the main application navigation');
    return { ...current(context), created: false };
  };
  workspaces.rename = workspaces.delete = async () => { throw new Error('Manage workspaces and projects in the main application'); };
  sessions.list = async (request = {}, signal) => {
    const value = await original.sessionList.call(sessions, {}, signal);
    const directory = request.cwd ?? bootstrap.directory;
    const candidates = value.items.filter(item => !isRemoved(item.sessionId) && (request.cwd === undefined || item.cwd === directory));
    const hydrated = [];
    for (const item of candidates) {
      if (item.cwd === directory && item.agentAvailable === false) {
        const projections = await sessions.projections({ sessionId: item.sessionId }, signal);
        if (projections === null) throw new Error('Session disappeared while loading its title');
        hydrated.push({ ...item, projections: { kind: 'sequenced', ...projections } });
      } else hydrated.push(item);
    }
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
    return original.sessionCreate.call(sessions, { ...rest, workspaceId: context.workspaceId });
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
  route('mind/workspace/initializeDefault', request => current(select(request.context)));
  route('mind/session/list', (request, signal) => sessions.list({ cwd: select(request.context).directory }, signal));
  route('mind/session/create', request => create(request, select(request.context)));
  route('mind/session/search', (request, signal) => searchContextSessions(ctx, registry, select(request.context), request, signal));
  route('mind/session/fileAccess', async (request, signal) => {
    const context = select(request.context);
    if (typeof request.path !== 'string' || !path.isAbsolute(request.path)) throw new Error('Attachment path must be absolute');
    const requested = await realpath(request.path);
    const rows = (await original.sessionList.call(sessions, {}, signal)).items.filter(row => row.cwd === context.directory && !isRemoved(row.sessionId));
    for (const row of rows) {
      const inspection = await sessions.inspect(row.sessionId, signal);
      for (const event of inspection.events) {
        if (!isAppendSurfaceEvent(event)) continue;
        for (const block of deriveEventMessage(event)?.content ?? []) {
          if (!block.attachment || !['image', 'file'].includes(block.type)) continue;
          const located = block.type === 'image' ? ctx.attachments.imageHostPath(block.attachment) : ctx.attachments.fileHostPath(block.attachment);
          if (located && await realpath(located) === requested) {
            if (key(await forSession(row.sessionId, signal)) !== key(context)) throw new Error('Attachment Session scope changed');
            return { allowed: true };
          }
        }
      }
    }
    return { allowed: false };
  });
  route('mind/session/delete', async (request, signal) => {
    const context = select(request.context);
    if (key(await forSession(request.sessionId, signal)) !== key(context)) throw new Error('Session belongs to another context');
    await ctx.workspaceRegistry.archiveSession(request.sessionId);
    ctx.emit('api-session/removed', request.sessionId);
    return null;
  });
  route('mind/session/inventory', async (request, signal) => {
    try {
      const { input, authorization } = request;
      const context = select(request.context ?? (input.scope?.kind === 'project' ? { kind: 'project', id: input.scope.projectId } : bootstrap));
      if (typeof authorization !== 'string' || !authorization || input.scope?.kind !== context.kind
        || context.kind === 'project' && input.scope.projectId !== context.id) throw Object.assign(new Error('Session scope mismatch'), { code: 'SCOPE_DENIED' });
      return { page: await sessionInventory({ list: (_request, signal) => sessions.list({ cwd: context.directory }, signal), inspect: sessions.inspect?.bind(sessions) }, context, input, authorization, signal) };
    } catch (error) { return { error: { code: error.code ?? 'RUNTIME_UNAVAILABLE', message: String(error.message ?? error), retryable: false, ...(error.details ? { details: error.details } : {}) } }; }
  });
  ctx.effect(() => () => {
    workspaces.create = original.create; workspaces.initializeDefault = original.initializeDefault;
    workspaces.rename = original.rename; workspaces.delete = original.delete;
    sessions.create = original.sessionCreate; sessions.list = original.sessionList; sessions.follow = original.sessionFollow;
  });
  return registry;
}

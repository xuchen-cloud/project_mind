import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';

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
    : typeof context?.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.id);
  if (!context || !validId
    || typeof context.name !== 'string' || !context.name.trim()
    || typeof context.directory !== 'string' || !path.isAbsolute(context.directory)) {
    throw new Error(`Invalid main ${kind} configuration`);
  }
  const directory = await realpath(context.directory);
  if (!(await stat(directory)).isDirectory()) throw new Error(`Main ${kind} directory is unavailable`);
  return { kind, id: context.id, name: context.name.trim(), directory };
}

// Native navigation owns the scope. The upstream controller still creates,
// follows and persists sessions inside that scope's actual directory.
export async function bindContext(ctx, context) {
  const workspaces = ctx.workspaceController;
  const sessions = ctx.sessionController;
  const original = {
    create: workspaces.create, initializeDefault: workspaces.initializeDefault,
    rename: workspaces.rename, delete: workspaces.delete, sessionCreate: sessions.create,
    sessionList: sessions.list, sessionFollow: sessions.follow,
  };
  const { workspace } = await original.create.call(workspaces, { path: context.directory });
  const isRemoved = id => ctx.workspaceRegistry.archivedSessionIds.includes(id);
  const mapped = ctx.workspaceRegistry.get(workspace.workspaceId);
  const catalog = await original.sessionList.call(sessions, {});
  // Older embedded sessions can have a valid persisted cwd but no workspace
  // account. The native context owns this directory; restore through the registry's
  // stored-header validation and durable mutation before publishing READY.
  for (const item of catalog.items) {
    if (item.cwd === context.directory && !isRemoved(item.sessionId)
      && !mapped.sessionIds.includes(item.sessionId)) {
      await mapped.attachSession(item.sessionId);
    }
  }
  if (workspace.title !== context.name) {
    await original.rename.call(workspaces, { workspaceId: workspace.workspaceId, title: context.name });
  }
  const current = () => {
    const value = ctx.workspaceRegistry.get(workspace.workspaceId);
    return { workspace: { workspaceId: value.id, path: value.path, title: value.title,
      sessionIds: value.sessionIds, createdAt: value.createdAt, updatedAt: value.updatedAt } };
  };
  workspaces.initializeDefault = async () => current();
  workspaces.create = async request => {
    if (await realpath(request.path) !== context.directory) throw new Error('Use the main application navigation');
    return { ...current(), created: false };
  };
  workspaces.rename = workspaces.delete = async () => { throw new Error('Manage workspaces and projects in the main application'); };
  sessions.list = async (...args) => {
    const value = await original.sessionList.apply(sessions, args);
    return { ...value, items: value.items.filter(item => !isRemoved(item.sessionId)) };
  };
  sessions.follow = function(...args) {
    const id = args[0]?.address?.sessionId ?? args[0]?.sessionId;
    if (id && isRemoved(id)) throw new Error('Session was removed from this context');
    return original.sessionFollow.apply(sessions, args);
  };
  // The pinned DSH has durable archival and execution admission, but no log
  // deletion API. Main-app removal uses that primitive and retains history.
  ctx.connection.fetch.register({
    path: '/api/mind/session/delete', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body;
      try { body = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
      const envelope = clientRequestSchema.safeParse(body);
      if (!envelope.success || envelope.data.method !== 'mind/session/delete') {
        return new Response('invalid context session request', { status: 400 });
      }
      const { rpcId, payload } = envelope.data;
      let result;
      try {
        const id = payload?.args?.request?.sessionId;
        if (typeof id !== 'string' || !id) throw new Error('Invalid context session');
        const catalog = await original.sessionList.call(sessions, {}, request.signal);
        const owned = catalog.items.find(item => item.sessionId === id && item.cwd === context.directory);
        if (!owned) throw new Error('Session belongs to another context');
        await ctx.workspaceRegistry.archiveSession(id);
        ctx.emit('api-session/removed', id);
        result = { ok: true, value: null };
      } catch (error) {
        result = { ok: false, error: { code: 'gateway/internal', message: String(error.message ?? error), details: {} } };
      }
      return Response.json({ type: 'server-response', rpcId, result });
    },
  });
  sessions.create = async request => {
    if (request.sessionId && isRemoved(request.sessionId)) throw new Error('Session was removed from this context');
    if ((request.workspaceId !== undefined && request.workspaceId !== workspace.workspaceId)
      || (request.cwd !== undefined && await realpath(request.cwd) !== context.directory)) {
      throw new Error('Session belongs to another context');
    }
    const { cwd, ...rest } = request;
    return original.sessionCreate.call(sessions, { ...rest, workspaceId: workspace.workspaceId });
  };
  ctx.effect(() => () => {
    workspaces.create = original.create; workspaces.initializeDefault = original.initializeDefault;
    workspaces.rename = original.rename; workspaces.delete = original.delete;
    sessions.create = original.sessionCreate; sessions.list = original.sessionList; sessions.follow = original.sessionFollow;
  });
}

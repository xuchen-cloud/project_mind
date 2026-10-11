import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';

export async function readProject(line) {
  const project = JSON.parse(line).project;
  if (!project || !Number.isSafeInteger(project.id) || project.id <= 0
    || typeof project.name !== 'string' || !project.name.trim()
    || typeof project.directory !== 'string' || !path.isAbsolute(project.directory)) {
    throw new Error('Invalid main project configuration');
  }
  const directory = await realpath(project.directory);
  if (!(await stat(directory)).isDirectory()) throw new Error('Main project directory is unavailable');
  return { id: project.id, name: project.name.trim(), directory };
}

// The native project is the workspace owner. The upstream controller still
// creates, follows and persists sessions; the browser cannot create a second
// workspace or choose another working directory.
export async function bindProject(ctx, project) {
  const workspaces = ctx.workspaceController;
  const sessions = ctx.sessionController;
  const original = {
    create: workspaces.create, initializeDefault: workspaces.initializeDefault,
    rename: workspaces.rename, delete: workspaces.delete, sessionCreate: sessions.create,
    sessionList: sessions.list, sessionFollow: sessions.follow,
  };
  const { workspace } = await original.create.call(workspaces, { path: project.directory });
  const isRemoved = id => ctx.workspaceRegistry.archivedSessionIds.includes(id);
  const mapped = ctx.workspaceRegistry.get(workspace.workspaceId);
  const catalog = await original.sessionList.call(sessions, {});
  // Older embedded sessions can have a valid persisted cwd but no workspace
  // account. The main Project owns this directory; restore through the registry's
  // stored-header validation and durable mutation before publishing READY.
  for (const item of catalog.items) {
    if (item.cwd === project.directory && !isRemoved(item.sessionId)
      && !mapped.sessionIds.includes(item.sessionId)) {
      await mapped.attachSession(item.sessionId);
    }
  }
  if (workspace.title !== project.name) {
    await original.rename.call(workspaces, { workspaceId: workspace.workspaceId, title: project.name });
  }
  const current = () => {
    const value = ctx.workspaceRegistry.get(workspace.workspaceId);
    return { workspace: { workspaceId: value.id, path: value.path, title: value.title,
      sessionIds: value.sessionIds, createdAt: value.createdAt, updatedAt: value.updatedAt } };
  };
  workspaces.initializeDefault = async () => current();
  workspaces.create = async request => {
    if (await realpath(request.path) !== project.directory) throw new Error('Use the main application project navigation');
    return { ...current(), created: false };
  };
  workspaces.rename = workspaces.delete = async () => { throw new Error('Manage projects in the main application'); };
  sessions.list = async (...args) => {
    const value = await original.sessionList.apply(sessions, args);
    return { ...value, items: value.items.filter(item => !isRemoved(item.sessionId)) };
  };
  sessions.follow = function(...args) {
    const id = args[0]?.address?.sessionId ?? args[0]?.sessionId;
    if (id && isRemoved(id)) throw new Error('Session was removed from the project');
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
        return new Response('invalid project session request', { status: 400 });
      }
      const { rpcId, payload } = envelope.data;
      let result;
      try {
        const id = payload?.args?.request?.sessionId;
        if (typeof id !== 'string' || !id) throw new Error('Invalid project session');
        const catalog = await original.sessionList.call(sessions, {}, request.signal);
        const owned = catalog.items.find(item => item.sessionId === id && item.cwd === project.directory);
        if (!owned) throw new Error('Session belongs to another project');
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
    if (request.sessionId && isRemoved(request.sessionId)) throw new Error('Session was removed from the project');
    if ((request.workspaceId !== undefined && request.workspaceId !== workspace.workspaceId)
      || (request.cwd !== undefined && await realpath(request.cwd) !== project.directory)) {
      throw new Error('Session belongs to another project');
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

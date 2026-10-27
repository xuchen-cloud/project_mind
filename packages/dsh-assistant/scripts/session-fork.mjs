import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';

const _vp = String.fromCharCode(92,92,63,92);
const normalizeDirectory = v => typeof v === 'string' && v.startsWith(_vp) ? v.slice(_vp.length) : v;

const key = context => `${context.kind}:${context.id}:${context.directory}`;
// Match the pinned upstream fork default: include events after the last completed
// turn until a new turn/user append/inbox splice starts. Never copy a live tail.
function completedBoundary(events, sessionId) {
  const end = events.findLast(event => event.type === 'turn/end');
  if (!end) throw new Error(`session "${sessionId}" has no completed turn to fork from`);
  let boundary = end.seq;
  for (const event of events.slice(boundary + 1)) {
    if (event.type === 'turn/start' || event.type === 'user/message' && event.surfaceOp === 'append' || event.type === 'agent/inbox/spliced') break;
    boundary = event.seq;
  }
  return boundary;
}

export function createStableSessionFork(ctx, registry) {
  const pending = new Map();
  async function run(request, context, signal) {
    const assertParent = async () => {
      const owner = await registry.forSession(request.sessionId, signal);
      if (key(owner) !== key(context) || key(registry.select(request.context)) !== key(context)) throw new Error('Fork source belongs to another context');
    };
    await assertParent();
    signal?.throwIfAborted();
    let child;
    try { child = await ctx.sessionQuery.observeSession(request.childSessionId); }
    catch (error) { if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error; }
    if (child) {
      try {
        if (child.header.parentSession !== request.sessionId || normalizeDirectory(child.header.cwd) !== normalizeDirectory(context.directory)) throw new Error('Child identity belongs to another fork');
        if (key(await registry.forSession(request.childSessionId, signal)) !== key(context)) throw new Error('Child identity belongs to another fork');
      } finally { child[Symbol.dispose](); }
      // A previous response or workspace attachment may have failed after the
      // durable Session was created. Finish that exact child instead of forking.
      const live = ctx.sessions.get(request.childSessionId);
      if (live) await ctx.sessions.flush(live);
    } else {
      const source = await ctx.sessionQuery.observeSession(request.sessionId);
      try {
        if (normalizeDirectory(source.header.cwd) !== normalizeDirectory(context.directory)) throw new Error('Fork source belongs to another context');
        const boundary = completedBoundary(source.events, request.sessionId);
        const seed = buildForkSeed(source.events, boundary);
        // Reuse rc.2's controller-owned preset and model-selection setup, as
        // upstream fork does, rather than activating the source Agent.
        const controller = ctx.sessionController.agents;
        const composition = await controller.composeAgent(controller.presetForObservation(source));
        await assertParent();
        signal?.throwIfAborted();
        const { provider, model } = ctx.agentDefaultModel.currentSelection();
        const handle = await ctx.agents.create({ sessionId: request.childSessionId, seed, inheritedEventCount: boundary + 1,
          meta: { cwd: source.header.cwd, parentSession: source.header.id, isSeeded: true,
            ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
          agentOptions: { provider, model }, setup: composition.setup });
        // After creation, finish durability/membership even if the HTTP response
        // is cancelled. A later retry verifies this persisted lineage.
        await ctx.sessions.flush(handle.agent.session);
      } finally { source[Symbol.dispose](); }
    }
    if (key(registry.select(request.context)) !== key(context)) throw new Error('Fork context changed');
    const workspace = ctx.workspaceRegistry.get(context.workspaceId);
    if (!workspace.sessionIds.includes(request.childSessionId)) await workspace.attachSession(request.childSessionId);
    return { sessionId: request.childSessionId };
  }
  return async (request, signal) => {
    signal?.throwIfAborted();
    if (!request || Object.keys(request).some(field => !['context','sessionId','childSessionId'].includes(field))
      || typeof request.sessionId !== 'string' || !request.sessionId
      || typeof request.childSessionId !== 'string' || !/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.childSessionId)
      || request.sessionId === request.childSessionId) throw new Error('Invalid fork child identity');
    const context = registry.select(request.context);
    const existing = pending.get(request.childSessionId);
    if (existing) {
      if (existing.parent !== request.sessionId || existing.context !== key(context)) throw new Error('Child identity belongs to another fork');
      return existing.promise;
    }
    const promise = run(request, context, signal);
    pending.set(request.childSessionId, { parent: request.sessionId, context: key(context), promise });
    try { return await promise; } finally { pending.delete(request.childSessionId); }
  };
}

export function installStableSessionFork(ctx, registry) {
  const fork = createStableSessionFork(ctx, registry);
  const method = 'mind/session/fork';
  ctx.connection.fetch.register({path:`/api/${method}`,methods:['POST'],requestBody:'buffered',async fetch(request) {
    if (request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('invalid content type',{status:415});
    let frame;
    try { frame=clientRequestSchema.parse(await request.json()); } catch { return new Response('invalid request',{status:400}); }
    if (frame.method!==method) return new Response('invalid method',{status:400});
    let result;
    try { result={ok:true,value:await fork(frame.payload?.args?.request,request.signal)}; }
    catch(error) { result={ok:false,error:{code:'gateway/internal',message:String(error.message ?? error),details:{}}}; }
    return Response.json({type:'server-response',rpcId:frame.rpcId,result});
  }});
}

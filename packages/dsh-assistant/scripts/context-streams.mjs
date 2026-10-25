const key = context => `${context.kind}:${context.id}`;
const denied = message => ({ ok: false, error: { code: 'gateway/context-denied', message, details: {} } });

function sessionIdentities(frame) {
 const ids = new Set();
 const add = value => { if (typeof value === 'string' && value) ids.add(value); };
 const explicit = value => {
  if (!value || typeof value !== 'object') return;
  add(value.sessionId); add(value.agentId);
 };
 explicit(frame); explicit(frame.request);
 for (const argument of frame.args ?? []) explicit(argument);
 if (frame.event === 'api-session/added') add(frame.args?.[0]?.sessionId);
 else if (['api-session/removed', 'api-session/status', 'api-session/activity', 'api-session/error'].includes(frame.event)) add(frame.args?.[0]);
 return ids;
}

// Native attaches mindContext to the transport payload after authorizing its
// binding. This layer projects the shared upstream streams without changing the
// gateway's protocol or reaching into its event-client bookkeeping.
export function installContextStreams(ctx, registry) {
 const gateway = ctx.typertGateway;
 const open = gateway.openWireStream;
 const dispatch = gateway.dispatchRpc;
 const clients = new Map();
 gateway.openWireStream = async function(endpoint, payload, uplink, peer, signal, control) {
  if (endpoint !== '$events' && endpoint !== 'workspace/follow') return open.call(this, endpoint, payload, uplink, peer, signal, control);
  const context = registry.select(payload?.mindContext ?? registry.workspace);
  const { mindContext: _context, ...upstreamPayload } = payload;
  const source = await open.call(this, endpoint, upstreamPayload, uplink, peer, signal, control);
  return (async function* () {
   let clientId;
   const forwarded = new Set();
   try {
    for await (const frame of source) {
     signal?.throwIfAborted();
     if (endpoint === 'workspace/follow') {
      if (frame.type === 'baseline') {
       const value = await registry.snapshot(context, signal);
       signal?.throwIfAborted();
       yield { type: 'baseline', value };
      } else if (frame.type === 'upsert') {
       // Domain notifications carry the committed membership before the live
       // Workspace entity finishes updating. Preserve that authoritative delta.
       if (frame.workspace.workspaceId === context.workspaceId) yield frame;
      } else if (frame.type === 'remove') {
       if (frame.workspaceId === context.workspaceId) yield frame;
      } else if (frame.type === 'order') {
       yield { type: 'order', workspaceIds: frame.workspaceIds.filter(id => id === context.workspaceId) };
      } else if (frame.type === 'archived' || frame.type === 'pinned') {
       const property = frame.type === 'archived' ? 'archivedSessionIds' : 'pinnedSessionIds';
       const visible = [];
       for (const id of frame[property]) {
        const owner = await registry.scopeForSession(id, signal);
        signal?.throwIfAborted();
        if (owner && key(owner) === key(context)) visible.push(id);
       }
       yield { type: frame.type, [property]: visible };
      }
      continue;
     }
     if (frame.type === 'ready') {
      clientId = frame.clientId;
      if (clients.has(clientId)) throw new Error('Duplicate Remote event stream identity');
      clients.set(clientId, { context, forwarded });
      yield frame;
      continue;
     }
     if (frame.type === 'cancel') {
      if (forwarded.delete(frame.eventId)) yield frame;
      continue;
     }
     const ids = sessionIdentities(frame);
     let allowed = true;
     for (const id of ids) {
      const owner = await registry.scopeForSession(id, signal);
      signal?.throwIfAborted();
      if (!owner || key(owner) !== key(context)) { allowed = false; break; }
     }
     // Session lifecycle and scoped waterfalls always require a real identity;
     // a malformed frame cannot turn a scoped event into a global broadcast.
     if (!ids.size && (frame.event?.startsWith('api-session/') || frame.type === 'waterfall')) allowed = false;
     if (!allowed) continue;
     if (typeof frame.eventId === 'string') forwarded.add(frame.eventId);
     yield frame;
    }
   } finally {
    if (clientId !== undefined && clients.get(clientId)?.forwarded === forwarded) clients.delete(clientId);
   }
  })();
 };
 gateway.dispatchRpc = async function(endpoint, payload, signal, peer) {
  if (endpoint !== '$events/result') return dispatch.call(this, endpoint, payload, signal, peer);
  let context;
  try { context = registry.select(payload?.mindContext ?? registry.workspace); }
  catch { return denied('Native event context is not registered'); }
  // rc.2's actual wire contract is args={clientId,eventId,outcome}.
  const result = payload?.args;
  const client = clients.get(result?.clientId);
  if (!client || key(client.context) !== key(context) || !client.forwarded.has(result?.eventId)) return denied('Remote event result does not belong to this context and stream');
  const { mindContext: _context, ...upstreamPayload } = payload;
  const response = await dispatch.call(this, endpoint, upstreamPayload, signal, peer);
  if (response?.ok) client.forwarded.delete(result.eventId);
  return response;
 };
}

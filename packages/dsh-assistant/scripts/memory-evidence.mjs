// The source must come from the native, scope-projected fact, never model input.
// Read the actual immutable user message; a saved excerpt is not proof that its
// original conversation still exists.
export async function readMemoryMessage(ctx, context, source, signal, { offset = 0, limit = 4000 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000) {
    throw new Error('Memory evidence offset must be nonnegative and limit must be 1–12000 characters');
  }
  if (source.kind !== 'message' || !source.sessionId || !source.messageId) {
    throw new Error('This source is not a stored conversation anchor; read its native source reference instead');
  }
  const allowed = source.scope?.kind === context.kind && (context.kind === 'workspace' || source.scope.projectId === context.id);
  if (!allowed) return { availability: 'access_denied' };
  const catalog = await ctx.sessionController.list({}, signal);
  const owner = catalog.items.find(item => item.sessionId === source.sessionId);
  if (!owner) return { availability: 'source_removed' };
  if (owner.cwd !== context.directory) return { availability: 'access_denied' };
  signal?.throwIfAborted();
  const log = await ctx.sessionQuery.readSession(source.sessionId);
  signal?.throwIfAborted();
  // The persisted header is checked after asynchronous I/O as well as catalog
  // admission. A changed owner cannot expose an old scope's original message.
  if (log.session.cwd !== context.directory) return { availability: 'access_denied' };
  const event = log.events.find(event => event.type === 'user/message' && event.data.id === source.messageId && event.data.source?.kind === 'user');
  if (!event) return { availability: 'source_removed' };
  const chars = Array.from((event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
  return { availability: 'available', historical: true, sessionId: source.sessionId, messageId: source.messageId,
    text: chars.slice(offset, offset + limit).join(''), offset, totalChars: chars.length,
    nextOffset: offset + limit < chars.length ? offset + limit : null };
}

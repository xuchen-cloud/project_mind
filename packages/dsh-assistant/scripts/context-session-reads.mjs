import { SessionReferenceError } from '@deepseek-ai/dsh-session-reference';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

const key = context => `${context.kind}:${context.id}`;
const same = (left, right) => left && right && key(left) === key(right) && left.directory === right.directory;
const archive = (ctx, id) => ctx.workspaceRegistry.archivedSessionIds.includes(id);
function contextStillCurrent(registry, context, signal) {
 signal?.throwIfAborted();
 if (!same(registry.select(context), context)) throw new Error('Native context changed during session read');
}
function agentStillCurrent(registry, agent, context, signal) {
 contextStillCurrent(registry, context, signal);
 if (!same(registry.forAgent(agent), context)) throw new SessionReferenceError('Agent context changed during session reference read', 'SESSION_REFERENCE_INVALID_REFERENCE');
}

/** The deployed query service intentionally has no search index. Scan only
 * authorized scope IDs through its public semantic filter API, which applies
 * current-surface and whitespace-flexible literal text predicates itself. */
export async function searchContextSessions(ctx, registry, context, request, signal) {
 const query = typeof request?.query === 'string' ? request.query.trim() : '';
 context = { ...context };
 if (!query || query.length > 500 || query.includes('\0')) throw new RemoteError('gateway/bad-request', 'Session search requires a nonempty query of at most 500 characters without NUL', {});
 contextStillCurrent(registry, context, signal);
 const snapshot = await registry.snapshot(context, signal);
 contextStillCurrent(registry, context, signal);
 const ids = [...new Set(snapshot.items[0]?.sessionIds ?? [])];
 const items = [];
 const filters = [{ kind: 'type', values: ['user/message', 'assistant/message'] },
  { kind: 'surface', values: ['current'] }, { kind: 'text', text: query }];
 for (const id of ids) {
  contextStillCurrent(registry, context, signal);
  if (archive(ctx, id)) continue;
  const owner = await registry.forSession(id, signal);
  contextStillCurrent(registry, context, signal);
  if (!same(owner, context) || archive(ctx, id)) continue;
  const matches = await ctx.sessionQuery.filterEvents(id, filters);
  contextStillCurrent(registry, context, signal);
  if (archive(ctx, id)) continue;
  const currentOwner = await registry.forSession(id, signal);
  contextStillCurrent(registry, context, signal);
  if (!same(currentOwner, context) || archive(ctx, id)) continue;
  const match = matches.find(document => document.sessionId === id && document.surface === 'current'
   && ['user/message', 'assistant/message'].includes(document.type));
  if (!match) continue;
  items.push({ sessionId: id, snippet: [...match.text].slice(0, 240).join('') });
  if (items.length > 20) break;
 }
 contextStillCurrent(registry, context, signal);
 const visible = items.filter(item => !archive(ctx, item.sessionId));
 return { items: visible.slice(0, 20), hasMore: visible.length > 20 };
}

/** The pinned resolver's remote candidates and parsed URI path dynamically call
 * these public methods, so both UI completion and prompt preparation use the
 * same real Agent ownership without replacing upstream reads or snapshots. */
export function installSessionReferenceScope(ctx, registry) {
 const resolver = ctx.sessionReferenceResolver;
 const listCandidates = resolver.listCandidates;
 const prepare = resolver.prepare;
 resolver.listCandidates = async function(agent, query, limit, signal) {
  const context = { ...registry.forAgent(agent) };
  agentStillCurrent(registry, agent, context, signal);
  const candidates = await listCandidates.call(this, agent, query, limit, signal);
  agentStillCurrent(registry, agent, context, signal);
  const visible = [];
  for (const candidate of candidates) {
   const owner = await registry.scopeForSession(candidate.sessionId, signal);
   agentStillCurrent(registry, agent, context, signal);
   if (same(owner, context) && !archive(ctx, candidate.sessionId)) visible.push(candidate);
  }
  return visible;
 };
 resolver.prepare = async function(agent, content, references, signal) {
  const context = { ...registry.forAgent(agent) };
  const inputs = structuredClone(references);
  const validate = async () => {
   agentStillCurrent(registry, agent, context, signal);
   for (const reference of inputs) {
    const owner = await registry.forSession(reference.sessionId, signal);
    agentStillCurrent(registry, agent, context, signal);
    if (!same(owner, context)) throw new SessionReferenceError('Referenced Session belongs to another context', 'SESSION_REFERENCE_INVALID_REFERENCE');
   }
  };
  await validate();
  agentStillCurrent(registry, agent, context, signal);
  const result = await prepare.call(this, agent, content, inputs, signal);
  await validate();
  return result;
 };
}

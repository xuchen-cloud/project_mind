import { createHash } from 'node:crypto';

const incompatible = () => Object.assign(new Error('Pi history context cannot be identified'),
  { code: 'RUNTIME_INCOMPATIBLE' });

function fingerprint(message) {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

function pairToolMessages(messages) {
  const matchedCalls = new Map();
  const matchedResults = new Set();
  let pending = new Map();
  messages.forEach((message, messageIndex) => {
    if (message.role === 'assistant') {
      pending = new Map();
      if (Array.isArray(message.content)) message.content.forEach((part, contentIndex) => {
        if (part.type === 'toolCall') pending.set(part.id, { messageIndex, contentIndex });
      });
    } else if (message.role === 'toolResult') {
      const call = pending.get(message.toolCallId);
      if (call) {
        const indexes = matchedCalls.get(call.messageIndex) ?? new Set();
        indexes.add(call.contentIndex);
        matchedCalls.set(call.messageIndex, indexes);
        matchedResults.add(messageIndex);
        pending.delete(message.toolCallId);
      }
    } else {
      pending = new Map();
    }
  });
  return messages.flatMap((message, messageIndex) => {
    if (message.role === 'toolResult') return matchedResults.has(messageIndex) ? [message] : [];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [message];
    const content = message.content.filter((part, contentIndex) =>
      part.type !== 'toolCall' || matchedCalls.get(messageIndex)?.has(contentIndex));
    if (content.length === message.content.length) return [message];
    return content.length ? [{ ...message, content }] : [];
  });
}

// The session projection records the entry that contributed each model message.
// Keep the original transcript intact; this policy only selects provider context.
export function installContextPolicy(session, manager, historyPolicy) {
  const agent = session.agent;
  const original = agent.transformContext?.bind(agent);
  let sequence = 0;
  let history = new Map();
  let historicalBranchIds = new Set();
  let current = new Set();
  let currentFingerprints = new Set();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end') currentFingerprints.add(fingerprint(event.message));
  });

  function beginRun() {
    // A compaction summary may contain anything from the earlier branch, even
    // entries Pi no longer projects into its active model context.
    historicalBranchIds = new Set(manager.getBranch().filter((entry) => entry.type === 'message'
      && ['user', 'assistant', 'toolResult'].includes(entry.message.role))
      .map((entry) => entry.id));
    const projected = manager.buildSessionProjection().entries.flatMap(({ sourceEntry, messages }) =>
      messages.map((message) => ({ sourceEntry, fingerprint: fingerprint(message) })));
    const buckets = new Map();
    for (const item of projected) {
      const bucket = buckets.get(item.fingerprint) ?? [];
      bucket.push(item.sourceEntry);
      buckets.set(item.fingerprint, bucket);
    }
    history = new Map();
    current = new Set();
    currentFingerprints = new Set();
    for (const message of agent.state.messages) {
      const bucket = buckets.get(fingerprint(message));
      const source = bucket?.shift();
      if (source) history.set(message, source);
      else if (message.role === 'system') history.set(message, null); // Current SDK system prompt.
      else throw incompatible();
    }
    if ([...buckets.values()].some((bucket) => bucket.length)) throw incompatible();
  }

  function select(messages, allowed, summaryAllowed) {
    const filtered = [];
    const live = new Set(agent.state.messages);
    const historicalFingerprints = new Map();
    const summaryFingerprints = new Set(manager.buildSessionProjection().entries
      .filter(({ sourceEntry }) => sourceEntry.type === 'compaction')
      .flatMap(({ messages: projected }) => projected.map(fingerprint)));
    for (const [message, source] of history) {
      const key = fingerprint(message);
      const sources = historicalFingerprints.get(key) ?? [];
      sources.push(source);
      historicalFingerprints.set(key, sources);
    }
    for (const message of messages) {
      if (summaryFingerprints.has(fingerprint(message))) {
        if (summaryAllowed) filtered.push(message);
        continue;
      }
      const source = history.has(message) ? history.get(message)
        : historicalFingerprints.get(fingerprint(message))?.shift();
      if (history.has(message) || source !== undefined) {
        if (source === null || (source.type === 'message' && allowed.has(source.id))
          || (source.type === 'compaction' && summaryAllowed)) filtered.push(message);
      } else if (currentFingerprints.has(fingerprint(message))) {
        filtered.push(message);
      } else if (current.has(message) || (live.has(message) && !history.has(message))) {
        // Messages created after beginRun belong to this run only. Remember them
        // so an SDK context clone can be checked against their exact contents.
        if (!['user', 'assistant', 'toolResult'].includes(message.role)) throw incompatible();
        current.add(message);
        currentFingerprints.add(fingerprint(message));
        filtered.push(message);
      } else {
        throw incompatible();
      }
    }
    return filtered;
  }

  agent.transformContext = async (messages, signal) => {
    const hasSummary = manager.buildSessionProjection().entries.some(({ sourceEntry, messages: projected }) =>
      sourceEntry.type === 'compaction' && projected.length > 0);
    const entryIds = [...new Set([...history.values()]
      .filter((source) => source?.type === 'message').map((source) => source.id))];
    if (hasSummary) for (const id of historicalBranchIds) if (!entryIds.includes(id)) entryIds.push(id);
    const result = await historyPolicy({ method: 'session.context.check',
      toolCallId: `context-check-${++sequence}`, payload: { entryIds }, signal });
    if (!result || !Array.isArray(result.allowedEntryIds)
      || !result.allowedEntryIds.every((id) => typeof id === 'string')) throw incompatible();
    const allowed = new Set(result.allowedEntryIds);
    // Branch summaries may carry content from another branch. We do not
    // generate them, and their full provenance cannot be checked here.
    const summaryAllowed = hasSummary && !manager.getBranch().some((entry) => entry.type === 'branch_summary')
      && [...historicalBranchIds].every((id) => allowed.has(id));
    const selected = select(messages, allowed, summaryAllowed);
    const transformed = original ? await original(selected, signal) : selected;
    // A context hook must not reintroduce old or unidentifiable material.
    return pairToolMessages(select(transformed, allowed, summaryAllowed));
  };
  return { beginRun, dispose: unsubscribe,
    async beforeCompact(event) {
      if (event.branchEntries.some((entry) => entry.type === 'branch_summary')) return { cancel: true };
      const entryIds = event.branchEntries.filter((entry) => entry.type === 'message'
        && historicalBranchIds.has(entry.id)).map((entry) => entry.id);
      try {
        const result = await historyPolicy({ method: 'session.context.check',
          toolCallId: `context-check-${++sequence}`, payload: { entryIds }, signal: event.signal });
        if (!result || !Array.isArray(result.allowedEntryIds)
          || !result.allowedEntryIds.every((id) => typeof id === 'string')) return { cancel: true };
        const allowed = new Set(result.allowedEntryIds);
        if (entryIds.some((id) => !allowed.has(id))) return { cancel: true };
      } catch { return { cancel: true }; }
    } };
}

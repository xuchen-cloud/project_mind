import { decodeSession } from './session-codec.mjs';

export function projectCheckpoint(checkpoint, workspaceRoot, sessionId, leafId = checkpoint.leafId) {
  const entries = decodeSession(checkpoint.jsonl, workspaceRoot, sessionId, checkpoint.checksum);
  const byId = new Map(entries.slice(1).map((entry) => [entry.id, entry]));
  const branch = [];
  let id = leafId;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry) throw Object.assign(new Error('Checkpoint branch is missing'), { code: 'RUNTIME_INCOMPATIBLE' });
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse().filter((entry) => entry.type === 'message'
    && ['user', 'assistant', 'toolResult'].includes(entry.message.role)).map((entry, ordinal) => {
    const message = entry.message;
    const projection = { runtimeEntryId: entry.id, parentId: entry.parentId, ordinal,
      createdAt: entry.timestamp, role: message.role === 'toolResult' ? 'tool' : message.role, content: message.content };
    for (const key of ['stopReason', 'usage', 'toolCallId', 'toolName', 'isError']) {
      if (message[key] !== undefined) projection[key] = structuredClone(message[key]);
    }
    return projection;
  });
}

export function aggregateUsage(messages) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  for (const message of messages) if (message.role === 'assistant' && message.usage) {
    for (const key of Object.keys(usage)) {
      if (Number.isFinite(message.usage[key]) && message.usage[key] >= 0) usage[key] += message.usage[key];
    }
  }
  return usage;
}

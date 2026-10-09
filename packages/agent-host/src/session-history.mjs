import { createHash } from 'node:crypto';
import { decodeSession } from './session-codec.mjs';
import { projectCheckpoint } from './message-projection.mjs';

const sessionIdPattern = /^[0-9a-f]{32}$/;
const messageIdPattern = /^[0-9a-f]{32}$/;
const entryIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const inputKeys = new Set(['sessionId', 'branchId', 'fromMessageId', 'toMessageId', 'cursor', 'limit', 'maxChars']);
const cursorKeys = new Set(['branchId', 'fromMessageId', 'toMessageId', 'messageId', 'charOffset']);
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
const missing = (message) => Object.assign(new Error(message), { code: 'NOT_FOUND' });

export function historyMessageId(sessionId, runtimeEntryId) {
  return createHash('sha256').update(`${sessionId}:${runtimeEntryId}`).digest('hex').slice(0, 32);
}

function textOf(message) {
  if (message.role !== 'user' && message.role !== 'assistant') return '';
  if (message.role === 'assistant' && !['stop', 'toolUse'].includes(message.stopReason)) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('');
}

function boundedInteger(value, defaultValue, max, name) {
  if (value == null) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > max) throw invalid(`Invalid ${name}`);
  return value;
}

export async function readSessionHistory(input, { loadCheckpoint, workspaceRoot }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !inputKeys.has(key))
    || !sessionIdPattern.test(input.sessionId ?? '')) throw invalid('Invalid history request');
  const { sessionId } = input;
  const cursor = input.cursor ?? undefined;
  const branchAnchor = input.branchId ?? undefined;
  const fromMessageId = input.fromMessageId ?? cursor?.fromMessageId ?? undefined;
  const toMessageId = input.toMessageId ?? cursor?.toMessageId ?? undefined;
  const limit = boundedInteger(input.limit, 50, 50, 'message limit');
  const maxChars = boundedInteger(input.maxChars, 12000, 12000, 'character limit');
  for (const key of ['fromMessageId', 'toMessageId']) {
    if (input[key] != null && !messageIdPattern.test(input[key])) throw invalid(`Invalid ${key}`);
  }
  if (branchAnchor !== undefined && (!entryIdPattern.test(branchAnchor) || branchAnchor.length > 128)) throw invalid('Invalid branch ID');
  if (cursor !== undefined && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || Object.keys(cursor).some((key) => !cursorKeys.has(key))
    || !entryIdPattern.test(cursor.branchId ?? '') || cursor.branchId.length > 128
    || !messageIdPattern.test(cursor.messageId ?? '')
    || (cursor.fromMessageId != null && !messageIdPattern.test(cursor.fromMessageId))
    || (cursor.toMessageId != null && !messageIdPattern.test(cursor.toMessageId))
    || !Number.isInteger(cursor.charOffset) || cursor.charOffset < 0
    || (cursor.fromMessageId ?? undefined) !== fromMessageId || (cursor.toMessageId ?? undefined) !== toMessageId
    || (branchAnchor !== undefined && cursor.branchId !== branchAnchor))) throw invalid('Invalid history cursor binding');

  if (loadCheckpoint.exists && !await loadCheckpoint.exists(sessionId)) throw missing('Session history does not exist');
  const checkpoint = await loadCheckpoint(sessionId);
  if (!checkpoint) throw missing('Session history does not exist');
  // Decode before resolving the anchor so corrupt persisted data retains its
  // RUNTIME_INCOMPATIBLE meaning, distinct from a missing caller-supplied ID.
  const entries = decodeSession(checkpoint.jsonl, workspaceRoot, sessionId, checkpoint.checksum);
  const branchId = cursor?.branchId ?? branchAnchor ?? checkpoint.leafId;
  if (branchId !== null && !entries.slice(1).some((entry) => entry.id === branchId)) throw missing('History branch does not exist');
  const projected = projectCheckpoint(checkpoint, workspaceRoot, sessionId, branchId);
  const all = projected.map((message) => ({ ...message, messageId: historyMessageId(sessionId, message.runtimeEntryId) }));
  const index = new Map(all.map((message, i) => [message.messageId, i]));
  const from = fromMessageId === undefined ? 0 : index.get(fromMessageId);
  const to = toMessageId === undefined ? all.length - 1 : index.get(toMessageId);
  if (from === undefined || to === undefined) throw missing('History message is outside the branch');
  if (from > to && all.length) throw invalid('History range is reversed');

  const eligible = all.slice(from, to + 1).map((message) => {
    const text = textOf(message);
    return text ? { message, text } : null;
  }).filter(Boolean);
  let position = 0;
  let charOffset = 0;
  if (cursor) {
    position = eligible.findIndex(({ message }) => message.messageId === cursor.messageId);
    if (position < 0) throw invalid('History cursor is outside the readable range');
    charOffset = cursor.charOffset;
    if (charOffset >= Array.from(eligible[position].text).length) throw invalid('History cursor character offset is outside the message');
  }
  const messages = [];
  let charsLeft = maxChars;
  while (position < eligible.length && messages.length < limit && charsLeft > 0) {
    const { message, text } = eligible[position];
    const chars = Array.from(text);
    const charEnd = Math.min(chars.length, charOffset + charsLeft);
    messages.push({ messageId: message.messageId, runtimeEntryId: message.runtimeEntryId,
      ordinal: message.ordinal, role: message.role, createdAt: message.createdAt,
      text: chars.slice(charOffset, charEnd).join(''),
      contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      charStart: charOffset, charEnd, totalChars: chars.length });
    charsLeft -= charEnd - charOffset;
    if (charEnd === chars.length) { position++; charOffset = 0; }
    else charOffset = charEnd;
  }
  const hasMore = position < eligible.length;
  const nextCursor = hasMore ? { branchId, fromMessageId,
    toMessageId, messageId: eligible[position].message.messageId, charOffset } : null;
  return { sessionId, branchId, messages, nextCursor, hasMore };
}

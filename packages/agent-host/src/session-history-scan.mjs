import { createHash } from 'node:crypto';
import { decodeSession } from './session-codec.mjs';
import { historyMessageId, textOf } from './session-history.mjs';

const sessionIdPattern = /^[0-9a-f]{32}$/;
const checksumPattern = /^sha256:[0-9a-f]{64}$/;
const inputKeys = new Set(['sessionId', 'expectedChecksum', 'previousCheckpoint', 'cursor', 'limit', 'maxChars']);
const cursorKeys = new Set(['entryOffset', 'charOffset']);
const previousKeys = new Set(['checksum', 'entryCount']);
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
const missing = (message) => Object.assign(new Error(message), { code: 'NOT_FOUND' });

function boundedInteger(value, fallback, maximum, name) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw invalid(`Invalid ${name}`);
  return value;
}

export async function scanSessionHistory(input, { loadCheckpoint, workspaceRoot }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !inputKeys.has(key))
    || !sessionIdPattern.test(input.sessionId ?? '')
    || !checksumPattern.test(input.expectedChecksum ?? '')) throw invalid('Invalid history scan request');
  const { sessionId, expectedChecksum } = input;
  const previous = input.previousCheckpoint ?? undefined;
  if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous)
    || Object.keys(previous).some((key) => !previousKeys.has(key))
    || !checksumPattern.test(previous.checksum ?? '')
    || !Number.isSafeInteger(previous.entryCount) || previous.entryCount < 0)) {
    throw invalid('Invalid previous checkpoint');
  }
  const limit = boundedInteger(input.limit, 200, 200, 'message limit');
  const maxChars = boundedInteger(input.maxChars, 262144, 262144, 'character limit');
  const cursor = input.cursor ?? { entryOffset: 0, charOffset: 0 };
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || Object.keys(cursor).some((key) => !cursorKeys.has(key))
    || !Number.isInteger(cursor.entryOffset) || cursor.entryOffset < 0
    || !Number.isInteger(cursor.charOffset) || cursor.charOffset < 0) throw invalid('Invalid history scan cursor');

  if (loadCheckpoint.exists && !await loadCheckpoint.exists(sessionId)) throw missing('Session history does not exist');
  const checkpoint = await loadCheckpoint(sessionId);
  if (!checkpoint) throw missing('Session history does not exist');
  if (expectedChecksum !== checkpoint.checksum) {
    throw Object.assign(new Error('Session checkpoint has changed'), { code: 'REVISION_CONFLICT' });
  }
  const entries = decodeSession(checkpoint.jsonl, workspaceRoot, sessionId, checkpoint.checksum).slice(1);
  const entryCount = entries.length;
  if (previous && previous.checksum === checkpoint.checksum && previous.entryCount !== entryCount) {
    throw Object.assign(new Error('Previous checkpoint entry count differs'), { code: 'REVISION_CONFLICT' });
  }
  if (previous && previous.checksum !== checkpoint.checksum) {
    if (previous.entryCount > entryCount
      || cursor.entryOffset > previous.entryCount
      || (cursor.entryOffset === previous.entryCount && cursor.charOffset !== 0)) {
      throw Object.assign(new Error('Previous checkpoint is outside current history'), { code: 'REVISION_CONFLICT' });
    }
    // Hash the original JSONL lines. Re-serializing parsed entries would not
    // prove that the previous persisted checkpoint is a byte-exact prefix.
    const lines = checkpoint.jsonl.slice(0, -1).split('\n');
    const prefix = `${lines.slice(0, previous.entryCount + 1).join('\n')}\n`;
    const prefixChecksum = `sha256:${createHash('sha256').update(prefix).digest('hex')}`;
    if (prefixChecksum !== previous.checksum) {
      throw Object.assign(new Error('Previous checkpoint is not a prefix'), { code: 'REVISION_CONFLICT' });
    }
  }
  if (cursor.entryOffset > entryCount || (cursor.entryOffset === entryCount && cursor.charOffset !== 0)) {
    throw invalid('History scan cursor is outside the entries');
  }

  // The codec requires parents to precede children. Store each parent's message
  // count so every branch ordinal can be calculated in one pass.
  const counts = new Map();
  const readable = new Array(entryCount);
  for (let i = 0; i < entryCount; i++) {
    const entry = entries[i];
    const count = entry.parentId === null ? 0 : counts.get(entry.parentId);
    const message = entry.type === 'message' ? entry.message : undefined;
    const projected = message && ['user', 'assistant', 'toolResult'].includes(message.role);
    counts.set(entry.id, count + (projected ? 1 : 0));
    if (projected) {
      const role = message.role === 'toolResult' ? 'tool' : message.role;
      const text = textOf({ ...message, role });
      if (text) readable[i] = { entry, role, text, ordinal: count };
    }
  }
  if (cursor.charOffset) {
    const item = readable[cursor.entryOffset];
    if (!item || cursor.charOffset >= Array.from(item.text).length) {
      throw invalid('History scan cursor is outside the message');
    }
  }

  const messages = [];
  let entryOffset = cursor.entryOffset;
  let charOffset = cursor.charOffset;
  let charsLeft = maxChars;
  let scanned = 0;
  while (entryOffset < entryCount && scanned < 1000 && messages.length < limit && charsLeft > 0) {
    const item = readable[entryOffset];
    scanned++;
    if (!item) { entryOffset++; continue; }
    const chars = Array.from(item.text);
    const charEnd = Math.min(chars.length, charOffset + charsLeft);
    messages.push({ messageId: historyMessageId(sessionId, item.entry.id),
      runtimeEntryId: item.entry.id, branchId: item.entry.id, ordinal: item.ordinal,
      role: item.role, createdAt: item.entry.timestamp,
      text: chars.slice(charOffset, charEnd).join(''),
      contentHash: `sha256:${createHash('sha256').update(item.text).digest('hex')}`,
      charStart: charOffset, charEnd, totalChars: chars.length });
    charsLeft -= charEnd - charOffset;
    if (charEnd === chars.length) { entryOffset++; charOffset = 0; }
    else charOffset = charEnd;
  }
  const complete = entryOffset === entryCount;
  return { sessionId, checksum: checkpoint.checksum, entryCount, messages,
    nextCursor: complete ? null : { entryOffset, charOffset }, complete };
}

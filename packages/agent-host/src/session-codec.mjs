import { createHash } from 'node:crypto';
import path from 'node:path';

// Persist the SDK's own entries, changing only its documented path fields. Message
// content remains byte-for-byte meaningful, including paths typed by the user.
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const ENTRY_TYPES = new Set(['message', 'thinking_level_change', 'model_change', 'usage',
  'compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info']);
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function incompatible(message) {
  return Object.assign(new Error(message), { code: 'RUNTIME_INCOMPATIBLE' });
}

function portablePath(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw Object.assign(new Error('Session system path must be inside the Workspace'), { code: 'SCOPE_DENIED' });
  }
  const relative = path.relative(root, value);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Session system path escapes the Workspace'), { code: 'SCOPE_DENIED' });
  }
  return `workspace:${relative.split(path.sep).join('/') || '.'}`;
}

function resolvedPath(value, root) {
  if (typeof value !== 'string' || !value.startsWith('workspace:')) throw incompatible('Non-portable session path');
  const relative = value.slice('workspace:'.length);
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.includes(':')
    || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '..')
    || (relative !== '.' && relative.split('/').includes('.'))) {
    throw incompatible('Invalid Workspace path reference');
  }
  return path.resolve(root, ...relative.split('/'));
}

function validateEntries(entries, expectedId) {
  const header = entries[0];
  if (!header || header.type !== 'session' || header.version !== 3
    || typeof header.id !== 'string' || !ID.test(header.id)
    || (expectedId !== undefined && header.id !== expectedId)
    || typeof header.timestamp !== 'string' || !Number.isFinite(Date.parse(header.timestamp))) {
    throw incompatible('Invalid or unsupported SDK session header');
  }
  const ids = new Set();
  for (const entry of entries.slice(1)) {
    if (!entry || !ENTRY_TYPES.has(entry.type) || typeof entry.id !== 'string' || !ID.test(entry.id)
      || ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))
      || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw incompatible('Invalid SDK session entry or parent chain');
    }
    // These links refer to existing history, never to a later or absent entry.
    for (const key of ['targetId', 'firstKeptEntryId']) {
      if (entry[key] !== undefined && entry[key] !== null && !ids.has(entry[key])) {
        throw incompatible('Invalid SDK history reference');
      }
    }
    ids.add(entry.id);
  }
}

const checksum = (jsonl) => `sha256:${createHash('sha256').update(jsonl, 'utf8').digest('hex')}`;

export function encodeSession(entries, workspaceRoot) {
  if (!path.isAbsolute(workspaceRoot)) throw incompatible('Workspace root must be absolute');
  validateEntries(entries);
  const header = { ...entries[0], cwd: portablePath(entries[0].cwd, workspaceRoot) };
  if (header.parentSession !== undefined) header.parentSession = portablePath(header.parentSession, workspaceRoot);
  const lines = [header, ...entries.slice(1)].map((entry) => JSON.stringify(entry));
  if (lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES)) throw incompatible('Session entry exceeds checkpoint limit');
  const jsonl = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(jsonl, 'utf8');
  if (bytes > MAX_CHECKPOINT_BYTES) throw incompatible('Session exceeds checkpoint limit');
  return { jsonl, checksum: checksum(jsonl), bytes };
}

export function decodeSession(jsonl, workspaceRoot, expectedId, expectedChecksum) {
  if (!path.isAbsolute(workspaceRoot) || typeof jsonl !== 'string'
    || Buffer.byteLength(jsonl, 'utf8') > MAX_CHECKPOINT_BYTES || !jsonl.endsWith('\n')
    || typeof expectedChecksum !== 'string' || checksum(jsonl) !== expectedChecksum) {
    throw incompatible('Session checkpoint is incomplete or its checksum differs');
  }
  const lines = jsonl.slice(0, -1).split('\n');
  if (lines.some((line) => !line || Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES)) throw incompatible('Invalid session checkpoint framing');
  let entries;
  try { entries = lines.map((line) => JSON.parse(line)); }
  catch { throw incompatible('Invalid session checkpoint JSON'); }
  validateEntries(entries, expectedId);
  entries[0].cwd = resolvedPath(entries[0].cwd, workspaceRoot);
  if (entries[0].parentSession !== undefined) entries[0].parentSession = resolvedPath(entries[0].parentSession, workspaceRoot);
  return entries;
}

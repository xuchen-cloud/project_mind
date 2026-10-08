import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { encodeSession, decodeSession } from '../../src/session-codec.mjs';

test('Workspace move resolves system paths and preserves literal user messages', () => {
  const root = path.join(os.tmpdir(), 'old 工作区');
  const moved = path.join(os.tmpdir(), 'moved 中文');
  const header = { type: 'session', version: 3, id: '1'.repeat(32), timestamp: '2026-09-30T00:00:00.000Z', cwd: path.join(root, 'Project A') };
  const entries = [header, { type: 'message', id: 'entry001', parentId: null, timestamp: header.timestamp,
    message: { role: 'user', content: `Remember ${root}/notes.txt literally`, timestamp: 1 } }];
  const encoded = encodeSession(entries, root);
  assert.equal(JSON.parse(encoded.jsonl.split('\n')[0]).cwd, 'workspace:Project A');
  const restored = decodeSession(encoded.jsonl, moved, header.id, encoded.checksum);
  assert.equal(restored[0].cwd, path.join(moved, 'Project A'));
  assert.equal(restored[1].message.content, `Remember ${root}/notes.txt literally`);
  assert.throws(() => decodeSession(encoded.jsonl + ' ', root, header.id, encoded.checksum), { code: 'RUNTIME_INCOMPATIBLE' });
  assert.throws(() => encodeSession([{ ...header, cwd: '/outside' }], root), { code: 'SCOPE_DENIED' });
});

test('codec preserves SDK branching and rejects broken history rather than dropping entries', () => {
  const root = path.join(os.tmpdir(), '工作区');
  const moved = path.join(os.tmpdir(), 'moved');
  const manager = SessionManager.inMemory(root, { id: '3'.repeat(32) });
  const first = manager.appendMessage({ role: 'user', content: 'First', timestamp: 1 });
  manager.appendMessage({ role: 'user', content: 'Old branch', timestamp: 2 });
  manager.branch(first);
  manager.appendMessage({ role: 'user', content: 'New branch', timestamp: 3 });
  const encoded = encodeSession([manager.getHeader(), ...manager.getEntries()], root);
  const entries = decodeSession(encoded.jsonl, moved, manager.getSessionId(), encoded.checksum);
  const restored = SessionManager.inMemory(moved, undefined, entries);
  assert.deepEqual(restored.buildSessionContext().messages, manager.buildSessionContext().messages);
  assert.equal(restored.getEntries().length, 3);
  const bad = structuredClone(entries);
  bad[2].id = bad[1].id;
  assert.throws(() => encodeSession(bad, moved), { code: 'RUNTIME_INCOMPATIBLE' });
  bad[2].id = 'other';
  bad[2].parentId = 'missing';
  assert.throws(() => encodeSession(bad, moved), { code: 'RUNTIME_INCOMPATIBLE' });
  assert.throws(() => decodeSession(encoded.jsonl, root, 'other-session', encoded.checksum), { code: 'RUNTIME_INCOMPATIBLE' });
});

test('valid checksum does not permit a path escape or an unsupported session version', () => {
  const root = path.join(os.tmpdir(), 'workspace');
  const manager = SessionManager.inMemory(root, { id: '4'.repeat(32) });
  const encoded = encodeSession([manager.getHeader()], root);
  const checksum = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  for (const cwd of ['workspace:../outside', 'workspace:/absolute', 'workspace:C:/Windows', 'workspace:foo\\bar', '/old/root']) {
    const changed = `${JSON.stringify({ ...JSON.parse(encoded.jsonl), cwd })}\n`;
    assert.throws(() => decodeSession(changed, root, manager.getSessionId(), checksum(changed)), { code: 'RUNTIME_INCOMPATIBLE' });
  }
  const changed = `${JSON.stringify({ ...JSON.parse(encoded.jsonl), version: 99 })}\n`;
  assert.throws(() => decodeSession(changed, root, manager.getSessionId(), checksum(changed)), { code: 'RUNTIME_INCOMPATIBLE' });
});

test('File payload checkpoints support escaped 2 MiB entries while preserving entry and total bounds', () => {
  const root = path.join(os.tmpdir(), 'file-checkpoint');
  const manager = SessionManager.inMemory(root, { id: '5'.repeat(32) });
  const content = '\0'.repeat(2 * 1024 * 1024);
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'tool1', name: 'mind_output_stage', arguments: { intent: { intent: 'file_create', projectId: 1, safeName: 'source.txt', utf8Content: content }, sources: [] } }], timestamp: 1 });
  const encoded = encodeSession([manager.getHeader(), ...manager.getEntries()], root);
  assert.ok(encoded.bytes > 12 * 1024 * 1024);
  const decoded = decodeSession(encoded.jsonl, root, manager.getSessionId(), encoded.checksum);
  assert.equal(decoded[1].message.content[0].arguments.intent.utf8Content, content);
  const header = manager.getHeader();
  const entry = { type: 'message', id: 'entry1', parentId: null, timestamp: header.timestamp, message: { role: 'user', content: 'x'.repeat(16 * 1024 * 1024), timestamp: 1 } };
  assert.throws(() => encodeSession([header, entry], root), { code: 'RUNTIME_INCOMPATIBLE' });
  entry.message.content = 'x'.repeat(13 * 1024 * 1024);
  const large = Array.from({ length: 5 }, (_, index) => ({ ...entry, id: `entry${index}`, parentId: index ? `entry${index - 1}` : null }));
  assert.throws(() => encodeSession([header, ...large], root), { code: 'RUNTIME_INCOMPATIBLE' });
});

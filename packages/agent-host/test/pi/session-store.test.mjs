import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, cp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSessionStore } from '../../src/session-store.mjs';
import { encodeSession, decodeSession } from '../../src/session-codec.mjs';

test('durable SDK checkpoint survives a move and damage preserves the original history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-store-中文 '));
  const moved = await mkdtemp(path.join(os.tmpdir(), 'mind-store-moved '));
  const sessionId = '5'.repeat(32);
  try {
    const manager = SessionManager.inMemory(root, { id: sessionId });
    manager.appendMessage({ role: 'user', content: 'Saved prompt', timestamp: 1 });
    const checkpoint = { ...encodeSession([manager.getHeader(), ...manager.getEntries()], root), leafId: manager.getLeafId() };
    const store = await createSessionStore(root);
    const metadata = await store.save(sessionId, checkpoint);
    assert.equal(metadata.bytes, checkpoint.bytes);
    await cp(path.join(root, '.project-mind'), path.join(moved, '.project-mind'), { recursive: true });
    const restoredStore = await createSessionStore(moved);
    const restored = await restoredStore.load(sessionId);
    assert.equal(decodeSession(restored.jsonl, moved, sessionId, restored.checksum)[0].cwd, moved);
    const file = path.join(moved, '.project-mind', 'agent', 'sessions', sessionId, 'session.jsonl');
    await writeFile(file, restored.jsonl + '{incomplete');
    await assert.rejects(restoredStore.load(sessionId), { code: 'RUNTIME_INCOMPATIBLE' });
    await assert.rejects(restoredStore.save(sessionId, restored), { code: 'RUNTIME_INCOMPATIBLE' });
    assert.equal(await readFile(file, 'utf8'), restored.jsonl + '{incomplete');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test('session store refuses path traversal and symbolic directory redirects', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-store-safe-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'mind-store-outside-'));
  const sessionId = '6'.repeat(32);
  try {
    const manager = SessionManager.inMemory(root, { id: sessionId });
    const checkpoint = { ...encodeSession([manager.getHeader()], root), leafId: null };
    const store = await createSessionStore(root);
    await assert.rejects(store.save('../outside', checkpoint));
    await mkdir(path.join(root, '.project-mind'));
    await symlink(outside, path.join(root, '.project-mind', 'agent'));
    await assert.rejects(store.save(sessionId, checkpoint), { code: 'SCOPE_DENIED' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

import { constants } from 'node:fs';
import { realpath, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeSession } from './session-codec.mjs';
import { projectCheckpoint } from './message-projection.mjs';

const incompatible = () => Object.assign(new Error('Session checkpoint is missing or damaged; history has been preserved'), { code: 'RUNTIME_INCOMPATIBLE' });
const denied = () => Object.assign(new Error('Session store path is outside its private Workspace directory'), { code: 'SCOPE_DENIED' });

export async function createSessionStore(workspaceRoot) {
  const root = await realpath(workspaceRoot);
  async function directory(sessionId, create) {
    if (!/^[0-9a-f]{32}$/.test(sessionId)) throw denied();
    let current = root;
    for (const segment of ['.project-mind', 'agent', 'sessions', sessionId]) {
      current = path.join(current, segment);
      // The packaged Host precreates the fixed private ancestors. Avoid mkdir
      // on existing ancestors so Node needs write permission only for sessions.
      const stat = await lstat(current).catch(async (error) => {
        if (!create || error.code !== 'ENOENT') throw error;
        await mkdir(current, { mode: 0o700 }).catch((failure) => { if (failure.code !== 'EEXIST') throw failure; });
        return lstat(current);
      });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw denied();
    }
    return current;
  }
  async function readPrivate(file, maxBytes = 64 * 1024 * 1024) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw denied();
    if (stat.size > maxBytes) throw incompatible();
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return await handle.readFile('utf8'); } finally { await handle.close(); }
  }
  async function replacePrivate(file, content) {
    const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function syncDirectory(directoryPath) {
    // Windows does not expose portable directory fsync through Node. Files are
    // individually fsynced there; packaged crash acceptance remains mandatory.
    if (process.platform === 'win32') return;
    const handle = await open(directoryPath, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  function validate(sessionId, checkpoint) {
    const entries = decodeSession(checkpoint.jsonl, root, sessionId, checkpoint.checksum);
    if (checkpoint.bytes !== Buffer.byteLength(checkpoint.jsonl, 'utf8')
      || (checkpoint.leafId !== null && !entries.slice(1).some((entry) => entry.id === checkpoint.leafId))) throw incompatible();
  }
  async function load(sessionId) {
    try {
      const dir = await directory(sessionId, false);
      const metadata = JSON.parse(await readPrivate(path.join(dir, 'checkpoint.json'), 16384));
      if (metadata.schemaVersion !== 1) throw incompatible();
      const checkpoint = { ...metadata, jsonl: await readPrivate(path.join(dir, 'session.jsonl')) };
      validate(sessionId, checkpoint);
      checkpoint.offset = checkpoint.bytes;
      checkpoint.entryCount = decodeSession(checkpoint.jsonl, root, sessionId, checkpoint.checksum).length - 1;
      checkpoint.messageCount = projectCheckpoint(checkpoint, root, sessionId).length;
      return checkpoint;
    } catch (error) { if (error.code === 'SCOPE_DENIED') throw error; throw incompatible(); }
  }
  return {
    async save(sessionId, checkpoint) {
      validate(sessionId, checkpoint);
      const dir = await directory(sessionId, true);
      const exists = async (name) => {
        try { await lstat(path.join(dir, name)); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      };
      if (await exists('session.jsonl') || await exists('checkpoint.json')) {
        const previous = await load(sessionId);
        if (!checkpoint.jsonl.startsWith(previous.jsonl)) throw incompatible();
      }
      const metadata = { schemaVersion: 1, checksum: checkpoint.checksum, bytes: checkpoint.bytes, offset: checkpoint.bytes, leafId: checkpoint.leafId,
        entryCount: decodeSession(checkpoint.jsonl, root, sessionId, checkpoint.checksum).length - 1,
        messageCount: projectCheckpoint(checkpoint, root, sessionId).length };
      // The complete SDK tree replaces the prior checkpoint atomically. A crash
      // between the two renames is detectable and never reinitializes history.
      await replacePrivate(path.join(dir, 'session.jsonl'), checkpoint.jsonl);
      await replacePrivate(path.join(dir, 'checkpoint.json'), `${JSON.stringify(metadata)}\n`);
      await syncDirectory(dir);
      return metadata;
    },
    load,
    async exists(sessionId) {
      try { await directory(sessionId, false); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
  };
}

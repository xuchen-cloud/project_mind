import path from 'node:path';
import { lstat, mkdir, realpath, readdir, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function optionalLstat(target) {
  try { return await lstat(target); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

export function validEntryName(name) {
  return name.length > 0 && !name.startsWith('.') && !/[\\/\0]/.test(name);
}

export async function checkDisabledRoot(root, create = false) {
  const disabled = path.join(root, '.disabled');
  if (create) {
    try { await mkdir(disabled); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await optionalLstat(disabled);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error(`Unsafe .disabled root (must be a directory, not a symlink): ${disabled}`);
  }
  return disabled;
}

const heldRoots = new Set();

// Each acquisition publishes a unique PID claim atomically. Any other live
// claimant means busy (no retries); dead claims can be unlinked safely because
// their UUID paths are never reused. Keep the directory so creating a claim
// cannot race another process removing its parent.
export async function withRootLock(root, operation) {
  const canonicalRoot = await realpath(root);
  if (heldRoots.has(canonicalRoot)) throw new Error(`Skill management is busy: ${root}`);
  heldRoots.add(canonicalRoot);
  const lock = path.join(canonicalRoot, '.skill-management.lock');
  const claim = `${process.pid}-${randomUUID()}`;
  const claimPath = path.join(lock, claim);
  let published = false;
  try {
    await mkdir(lock, { recursive: true });
    if ((await lstat(lock)).isSymbolicLink()) throw new Error('Unsafe skill management lock directory');
    await writeFile(claimPath, '', { flag: 'wx' });
    published = true;
    for (const other of await readdir(lock)) {
      if (other === claim || other === 'links') continue;
      const match = /^(\d+)-[0-9a-f-]{36}$/.exec(other);
      if (!match) throw new Error(`Invalid skill management lock owner: ${other}`);
      let dead = false;
      try { process.kill(Number(match[1]), 0); }
      catch (error) {
        if (error.code === 'ESRCH') dead = true;
        else if (error.code !== 'EPERM') throw error;
      }
      if (!dead) throw new Error(`Skill management is busy: ${root}`);
      try { await unlink(path.join(lock, other)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return await operation(canonicalRoot);
  } finally {
    try { if (published) await unlink(claimPath); }
    finally { heldRoots.delete(canonicalRoot); }
  }
}

export async function mutateSkillEntry(root, skill, action, original) {
  const name = path.basename(skill.entryPath);
  if (!validEntryName(name)) throw new Error('Invalid skill entry basename');
  const disabledRoot = await checkDisabledRoot(root, action === 'disable');
  const destination = action === 'disable' ? path.join(disabledRoot, name) : path.join(root, name);
  if (action !== 'delete' && await optionalLstat(destination)) {
    throw new Error(`Skill destination already exists: ${destination}`);
  }
  const current = await lstat(skill.entryPath);
  if (current.dev !== original.dev || current.ino !== original.ino || current.mode !== original.mode) {
    throw new Error('Skill entry changed during management');
  }
  if (action === 'delete') {
    if (current.isSymbolicLink() || current.isFile()) await unlink(skill.entryPath);
    else if (current.isDirectory()) await rm(skill.entryPath, { recursive: true });
    else throw new Error('Unsupported skill entry type');
  } else {
    if (current.isSymbolicLink()) {
      const target = await readlink(skill.entryPath);
      if (!path.isAbsolute(target)) {
        // A relative link changes meaning when moved into/out of .disabled.
        // Normalize it atomically in place first; a termination here leaves
        // the original state intact and still points at the same resource.
        const staging = path.join(await realpath(root), '.skill-management.lock/links');
        await mkdir(staging, { recursive: true });
        if ((await lstat(staging)).isSymbolicLink()) throw new Error('Unsafe skill link staging directory');
        const temporary = path.join(staging, `${process.pid}-${randomUUID()}`);
        await symlink(path.resolve(path.dirname(skill.entryPath), target), temporary);
        try {
          const checked = await lstat(skill.entryPath);
          if (checked.dev !== current.dev || checked.ino !== current.ino || checked.mode !== current.mode) {
            throw new Error('Skill entry changed during management');
          }
          await rename(temporary, skill.entryPath);
        } catch (error) {
          await unlink(temporary);
          throw error;
        }
      }
    }
    await rename(skill.entryPath, destination);
  }
}

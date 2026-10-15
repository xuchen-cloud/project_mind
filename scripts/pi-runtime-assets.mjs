import { cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { checksum, packageNoticeAssets } from './record-worker-notices.mjs';

function supports(values, target) {
  return !values || (!values.includes(`!${target}`) && (!values.some(value => !value.startsWith('!')) || values.includes(target)));
}

/** Copy the lock-installed production tree, retaining nested dependencies and
 * SDK resources. npm's SDK shrinkwrap may install every optional esbuild binary;
 * select only packages matching the explicit target metadata. */
export async function copyPiDependencies(source, destination, target, lock) {
  const roots = [];
  const visit = async (directory, output) => {
    await mkdir(output, { recursive: true });
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Invalid production dependency entry: ${entry.name}`);
      const root = path.join(directory, entry.name);
      const copied = path.join(output, entry.name);
      if (entry.name.startsWith('@')) { await visit(root, copied); continue; }
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      const location = path.relative(source, root).split(path.sep).join('/');
      const pinned = lock.packages[location];
      if (!pinned || pinned.dev || pinned.version !== manifest.version) throw new Error(`Dependency differs from production lockfile: ${manifest.name}`);
      if (!supports(manifest.os, target.platform) || !supports(manifest.cpu, target.arch)) {
        if (!pinned.optional) throw new Error(`Required dependency does not support ${target.runtimeTarget}: ${manifest.name}`);
        continue;
      }
      await cp(root, copied, { recursive: true, filter: async (file) => {
        if (file !== root && path.relative(root, file).split(path.sep)[0] === 'node_modules') return false;
        if ((await lstat(file)).isSymbolicLink()) throw new Error(`Unexpected dependency symlink: ${file}`);
        return true;
      } });
      roots.push(copied);
      try { await lstat(path.join(root, 'node_modules')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await visit(path.join(root, 'node_modules'), path.join(copied, 'node_modules'));
    }
  };
  await visit(path.join(source, 'node_modules'), path.join(destination, 'node_modules'));
  return roots;
}

export async function piFileChecksums(directory, names) {
  const files = [];
  const visit = async (name) => {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Invalid Pi distribution symlink: ${name}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(file)).sort()) await visit(`${name}/${entry}`);
    } else if (info.isFile()) files.push({ file: name, checksum: checksum(await readFile(file)) });
    else throw new Error(`Invalid Pi distribution file: ${name}`);
  };
  for (const name of names) await visit(name);
  return files.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

export async function piNoticeAssets(roots) {
  return packageNoticeAssets(roots, 'Pi Agent Host production dependencies');
}

export async function verifyPiDistribution(directory) {
  const bytes = await readFile(path.join(directory, 'pi-distribution.json'));
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length
    || !Array.isArray(manifest.packages) || !manifest.packages.length) throw new Error('Invalid Pi distribution manifest');
  if (checksum(await readFile(path.join(directory, 'PI-THIRD-PARTY-NOTICES.txt'))) !== manifest.noticesChecksum) throw new Error('Pi notices differ from the build manifest');
  const actual = await piFileChecksums(directory, ['src', 'node_modules', 'package.json', 'package-lock.json']);
  const files = new Map(actual.map(entry => [entry.file, entry.checksum]));
  if (manifest.files.length !== actual.length) throw new Error('Pi distribution file inventory differs from the licensed build');
  for (const entry of manifest.files) {
    if (typeof entry.file !== 'string' || entry.file.includes('\\') || path.posix.isAbsolute(entry.file)
      || entry.file.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('Invalid Pi distribution file name');
    if (files.get(entry.file) !== entry.checksum) throw new Error(`Pi file differs from the licensed build: ${entry.file}`);
    files.delete(entry.file);
  }
  if (files.size) throw new Error('Pi distribution contains duplicate or missing files');
  if (manifest.lockfileChecksum !== checksum(await readFile(path.join(directory, 'package-lock.json')))) throw new Error('Pi lockfile differs from its distribution receipt');
  return { manifest, manifestChecksum: checksum(bytes) };
}

import { readFile, writeFile, mkdir, copyFile, rm, rename, mkdtemp, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifySourceWorkerDistribution } from './source-worker-assets.mjs';
const repository = fileURLToPath(new URL('..', import.meta.url));
const resources = path.join(repository, 'src-tauri/resources');
const host = path.join(repository, 'packages/agent-host');
const distribution = await verifySourceWorkerDistribution(path.join(host, 'source-dist'));
const entry = path.join(host, 'src/source-worker-entry.mjs');
const entryInfo = await lstat(entry);
if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error('Invalid source utility entry');
const entryBytes = await readFile(entry);
const runtimeManifest = JSON.parse(await readFile(path.join(host, 'runtime-manifest.json')));
const runtime = JSON.parse(await readFile(path.join(resources, 'agent-host/runtime.json')));
const target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const runtimeTarget = process.argv[2] ?? target;
if (!runtimeManifest.targets[runtimeTarget] || runtime.target !== runtimeTarget || runtime.nodeVersion !== runtimeManifest.nodeVersion || runtime.sourceArchiveChecksum !== runtimeManifest.targets[runtimeTarget].sha256) throw new Error('Prepare the pinned document runtime before staging source extraction');
const nodeBytes = await readFile(path.join(resources, 'agent-host', runtimeTarget.startsWith('win-') ? 'node.exe' : 'node'));
if (createHash('sha256').update(nodeBytes).digest('hex') !== runtime.nodeChecksum) throw new Error('Prepared Node differs from its runtime receipt');
const staging = await mkdtemp(path.join(resources, '.source-extractor-'));
try {
  await mkdir(path.join(staging, 'src')); await mkdir(path.join(staging, 'source-dist'));
  await writeFile(path.join(staging, 'src/source-worker-entry.mjs'), entryBytes);
  for (const file of [...distribution.manifest.bundles.map(entry => entry.file), ...distribution.manifest.assets.map(entry => entry.file), 'SOURCE-THIRD-PARTY-NOTICES.txt', 'source-worker-distribution.json']) {
    await mkdir(path.dirname(path.join(staging, 'source-dist', file)), { recursive: true });
    await copyFile(path.join(host, 'source-dist', file), path.join(staging, 'source-dist', file));
  }
  const copied = await verifySourceWorkerDistribution(path.join(staging, 'source-dist'));
  if (copied.manifestChecksum !== distribution.manifestChecksum) throw new Error('Source build changed during staging');
  await writeFile(path.join(staging, 'runtime.json'), JSON.stringify({ target: runtimeTarget, nodeVersion: runtime.nodeVersion, nodeChecksum: runtime.nodeChecksum,
    sourceDistributionChecksum: copied.manifestChecksum, sourceEntryChecksum: createHash('sha256').update(entryBytes).digest('hex') }, null, 2) + '\n');
  const destination = path.join(resources, 'source-extractor');
  await rm(destination, { recursive: true, force: true }); await rename(staging, destination);
  process.stdout.write(`Prepared source extraction resources: ${runtimeTarget}\n`);
} finally { await rm(staging, { recursive: true, force: true }); }

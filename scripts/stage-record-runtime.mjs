import { readFile, writeFile, mkdir, copyFile, chmod, rm, rename, mkdtemp, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyRecordWorkerDistribution } from './record-worker-notices.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const host = path.join(repository, 'packages/agent-host');
const manifest = JSON.parse(await readFile(path.join(host, 'runtime-manifest.json'), 'utf8'));
const target = process.argv[2] ?? `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
if (!manifest.targets[target]) throw new Error(`Unsupported document utility target: ${target}`);
const executable = target.startsWith('win-') ? 'node.exe' : 'node';
const runtime = path.join(host, 'runtime', target);
const distribution = await verifyRecordWorkerDistribution(path.join(host, 'dist'));
const receipt = JSON.parse(await readFile(path.join(runtime, 'verified-runtime.json'), 'utf8'));
const checksum = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
if (receipt.target !== target || receipt.nodeVersion !== manifest.nodeVersion
  || receipt.archiveChecksum !== manifest.targets[target].sha256
  || receipt.executableChecksum !== await checksum(path.join(runtime, executable))
  || receipt.licenseChecksum !== await checksum(path.join(runtime, 'LICENSE'))) {
  throw new Error('Prepared runtime differs from its verified archive receipt; prepare it again');
}
const files = [path.join(runtime, executable), path.join(runtime, 'LICENSE'),
  path.join(host, 'src/record-worker-entry.mjs'), path.join(host, 'dist/record-document-worker.mjs')];
for (const file of files) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Prepare the pinned runtime and build the document worker first: ${file}`);
}
if (target === `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`) {
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(runtime, executable), ['--version'], { env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let version = '';
    child.stdout.on('data', (chunk) => { version += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 && version.trim() === `v${manifest.nodeVersion}`
      ? resolve() : reject(new Error('Prepared document utility has an incompatible Node version')));
  });
}
const resources = path.join(repository, 'src-tauri/resources');
await mkdir(resources, { recursive: true });
const staging = await mkdtemp(path.join(resources, '.record-runtime-'));
try {
  await mkdir(path.join(staging, 'src'));
  await copyFile(path.join(runtime, executable), path.join(staging, executable));
  await copyFile(path.join(runtime, 'LICENSE'), path.join(staging, 'NODE-LICENSE'));
  await copyFile(path.join(host, 'src/record-worker-entry.mjs'), path.join(staging, 'src/record-worker-entry.mjs'));
  await mkdir(path.join(staging, 'dist'));
  for (const file of [...distribution.manifest.bundles.map((entry) => entry.file), 'THIRD-PARTY-NOTICES.txt', 'record-worker-distribution.json']) {
    await copyFile(path.join(host, 'dist', file), path.join(staging, 'dist', file));
  }
  const copied = await verifyRecordWorkerDistribution(path.join(staging, 'dist'));
  if (copied.manifestChecksum !== distribution.manifestChecksum) throw new Error('Utility build changed while staging resources');
  if (!target.startsWith('win-')) await chmod(path.join(staging, executable), 0o755);
  const nodeChecksum = createHash('sha256').update(await readFile(path.join(staging, executable))).digest('hex');
  await writeFile(path.join(staging, 'runtime.json'), JSON.stringify({ target, nodeVersion: manifest.nodeVersion,
    nodeChecksum, sourceArchive: manifest.targets[target].archive, sourceArchiveChecksum: manifest.targets[target].sha256,
    workerDistributionChecksum: distribution.manifestChecksum, workerNoticesChecksum: distribution.manifest.noticesChecksum }, null, 2));
  const destination = path.join(resources, 'agent-host');
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  process.stdout.write(`Prepared packaged document utility: ${target}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

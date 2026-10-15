import { readFile, writeFile, mkdtemp, mkdir, copyFile, chmod, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'runtime-manifest.json'), 'utf8'));
const [target, archive] = process.argv.slice(2);
const entry = manifest.targets[target];
if (!entry || !archive) throw new Error(`Usage: prepare-runtime.mjs <${Object.keys(manifest.targets).join('|')}> <official-archive>`);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest('hex') !== entry.sha256) throw new Error('Official Node archive checksum does not match the pinned manifest');
const staging = await mkdtemp(path.join(os.tmpdir(), 'mind-node-prepare-'));
const archiveRoot = entry.archive.replace(/\.(tar\.gz|zip)$/, '');
try {
  // tar/bsdtar handles the official tar and zip archives. Only the pinned Node
  // executable and its complete license notices enter application resources.
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', path.resolve(archive), '-C', staging,
      `${archiveRoot}/${entry.executable}`, `${archiveRoot}/${manifest.licenseFile}`], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Cannot extract verified Node runtime')));
  });
  const destination = path.join(packageRoot, 'runtime', target);
  await mkdir(destination, { recursive: true });
  const executable = target.startsWith('win-') ? 'node.exe' : 'node';
  await copyFile(path.join(staging, archiveRoot, entry.executable), path.join(destination, executable));
  await copyFile(path.join(staging, archiveRoot, manifest.licenseFile), path.join(destination, 'LICENSE'));
  if (!target.startsWith('win-')) await chmod(path.join(destination, executable), 0o755);
  await writeFile(path.join(destination, 'verified-runtime.json'), JSON.stringify({
    target, nodeVersion: manifest.nodeVersion, archiveChecksum: entry.sha256,
    executableChecksum: createHash('sha256').update(await readFile(path.join(destination, executable))).digest('hex'),
    licenseChecksum: createHash('sha256').update(await readFile(path.join(destination, 'LICENSE'))).digest('hex'),
  }, null, 2));
  process.stdout.write(`${destination}\n`);
} finally { await rm(staging, { recursive: true, force: true }); }

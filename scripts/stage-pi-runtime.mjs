import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DESKTOP_RUNTIME_TARGETS } from './desktop-runtime-target.mjs';
import { checksum } from './record-worker-notices.mjs';
import { copyPiDependencies, piFileChecksums, piNoticeAssets, verifyPiDistribution } from './pi-runtime-assets.mjs';

export async function stagePiRuntime(repository, runtimeTarget, productionHost) {
  const target = Object.values(DESKTOP_RUNTIME_TARGETS).find(entry => entry.runtimeTarget === runtimeTarget);
  if (!target || !productionHost) throw new Error('Usage: stage-pi-runtime.mjs <runtime target> <lock-installed production host directory>');
  const host = path.join(repository, 'packages/agent-host');
  const resources = path.join(repository, 'src-tauri/resources');
  const destination = path.join(resources, 'agent-host');
  const nodeManifest = JSON.parse(await readFile(path.join(host, 'runtime-manifest.json')));
  const runtime = JSON.parse(await readFile(path.join(destination, 'runtime.json')));
  const executable = target.platform === 'win32' ? 'node.exe' : 'node';
  if (runtime.target !== runtimeTarget || runtime.nodeVersion !== nodeManifest.nodeVersion
    || runtime.sourceArchiveChecksum !== nodeManifest.targets[runtimeTarget].sha256
    || runtime.nodeChecksum !== checksum(await readFile(path.join(destination, executable)))) throw new Error('Stage the pinned Record runtime before composing Pi');
  const lockBytes = await readFile(path.join(host, 'package-lock.json'));
  if (checksum(await readFile(path.join(productionHost, 'package-lock.json'))) !== checksum(lockBytes)) throw new Error('Pi production tree lockfile differs from the repository lockfile');
  const lock = JSON.parse(lockBytes);
  const sdk = nodeManifest.sdk;
  if (lock.packages[''].dependencies[sdk.package] !== sdk.version) throw new Error('Pi SDK differs from the runtime manifest');
  const staging = await mkdtemp(path.join(resources, '.pi-runtime-'));
  try {
    const replaced = new Set(['node_modules', 'src', 'package.json', 'package-lock.json', 'pi-distribution.json', 'PI-THIRD-PARTY-NOTICES.txt']);
    await cp(destination, staging, { recursive: true, filter: file => file === destination || !replaced.has(path.relative(destination, file).split(path.sep)[0]) });
    await mkdir(path.join(staging, 'src'));
    for (const name of (await readdir(path.join(host, 'src'))).filter(name => name.endsWith('.mjs')).sort()) {
      await copyFile(path.join(host, 'src', name), path.join(staging, 'src', name));
    }
    for (const name of ['package.json', 'package-lock.json']) await copyFile(path.join(host, name), path.join(staging, name));
    const roots = await copyPiDependencies(productionHost, staging, target, lock);
    const { notices, packages } = await piNoticeAssets(roots);
    if (!packages.some(entry => entry.name === sdk.package && entry.version === sdk.version && entry.license === sdk.license)) throw new Error('Pinned Pi SDK is missing from the production dependency tree');
    await writeFile(path.join(staging, 'PI-THIRD-PARTY-NOTICES.txt'), notices);
    const distribution = { schemaVersion: 1, target: runtimeTarget, sdk, lockfileChecksum: checksum(lockBytes),
      noticesChecksum: checksum(notices), packages,
      files: await piFileChecksums(staging, ['src', 'node_modules', 'package.json', 'package-lock.json']) };
    await writeFile(path.join(staging, 'pi-distribution.json'), JSON.stringify(distribution, null, 2) + '\n');
    const verified = await verifyPiDistribution(staging);
    await writeFile(path.join(staging, 'runtime.json'), JSON.stringify({ ...runtime,
      piDistributionChecksum: verified.manifestChecksum, piNoticesChecksum: distribution.noticesChecksum }, null, 2) + '\n');
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    process.stdout.write(`Prepared production Pi resources: ${runtimeTarget}\n`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stagePiRuntime(fileURLToPath(new URL('..', import.meta.url)), process.argv[2], process.argv[3]);
}

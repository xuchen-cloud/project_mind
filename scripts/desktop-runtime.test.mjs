import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopResourceCommands, desktopRuntimeTarget } from './desktop-runtime-target.mjs';
import { checksum } from './record-worker-notices.mjs';
import { verifyPiDistribution } from './pi-runtime-assets.mjs';
import { stagePiRuntime } from './stage-pi-runtime.mjs';

test('Rust targets select release runtimes independently of the build machine', () => {
  for (const [triple, expected] of [
    ['aarch64-apple-darwin', ['darwin-arm64', 'darwin', 'arm64']],
    ['x86_64-apple-darwin', ['darwin-x64', 'darwin', 'x64']],
    ['x86_64-pc-windows-msvc', ['win-x64', 'win32', 'x64']],
    ['x86_64-unknown-linux-gnu', ['linux-x64', 'linux', 'x64']],
  ]) {
    const target = desktopRuntimeTarget(triple, {});
    assert.deepEqual([target.runtimeTarget, target.platform, target.arch], expected);
    assert.deepEqual(desktopRuntimeTarget(undefined, { TAURI_ENV_TARGET_TRIPLE: triple, CARGO_BUILD_TARGET: triple }), target);
  }
  assert.throws(() => desktopRuntimeTarget(undefined, {}), /must not default/);
  assert.throws(() => desktopRuntimeTarget('x86_64-unknown-linux-musl', {}), /Unsupported/);
  assert.throws(() => desktopRuntimeTarget('x86_64-apple-darwin', { CARGO_BUILD_TARGET: 'aarch64-apple-darwin' }), /Conflicting/);
});

test('resource command composition prepares one Node and stages Pi after Record replacement and Source', () => {
  const target = desktopRuntimeTarget('x86_64-apple-darwin', {});
  const commands = desktopResourceCommands(target, '/pinned/archive', '/production/host');
  assert.deepEqual(commands, [
    ['packages/agent-host/scripts/prepare-runtime.mjs', 'darwin-x64', '/pinned/archive'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.record-worker.config.ts'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.source-worker.config.ts'],
    ['scripts/stage-record-runtime.mjs', 'darwin-x64'],
    ['scripts/stage-source-runtime.mjs', 'darwin-x64'],
    ['scripts/stage-pi-runtime.mjs', 'darwin-x64', '/production/host'],
  ]);
});

test('Pi composition preserves Record and Source, pins dependencies, filters optional target binaries, and detects tampering', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'mind-runtime-composition-'));
  const host = path.join(repository, 'packages/agent-host');
  const production = path.join(repository, 'production');
  const resources = path.join(repository, 'src-tauri/resources');
  const destination = path.join(resources, 'agent-host');
  const put = async (name, text) => { await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, text); };
  const json = async (name, value) => put(name, JSON.stringify(value));
  try {
    const sdk = { package: 'fixture-pi', version: '1.0.0', license: 'MIT', lockfile: 'package-lock.json' };
    await json(path.join(host, 'runtime-manifest.json'), { nodeVersion: '24.21.0', sdk, targets: { 'linux-x64': { sha256: 'archive-checksum' } } });
    await put(path.join(destination, 'node'), 'pinned-node');
    await put(path.join(destination, 'NODE-LICENSE'), 'node license');
    await put(path.join(destination, 'dist/record-document-worker.mjs'), 'record bundle');
    await put(path.join(resources, 'source-extractor/source-dist/source-extraction-worker.mjs'), 'source bundle');
    await json(path.join(destination, 'runtime.json'), { target: 'linux-x64', nodeVersion: '24.21.0', sourceArchiveChecksum: 'archive-checksum',
      nodeChecksum: checksum('pinned-node'), workerDistributionChecksum: 'record-checksum' });
    await put(path.join(host, 'src/index.mjs'), 'export const host = true;');
    await put(path.join(host, 'src/record-worker-entry.mjs'), 'record entry');
    const lock = { packages: { '': { dependencies: { 'fixture-pi': '1.0.0' } },
      'node_modules/fixture-pi': { version: '1.0.0' },
      'node_modules/fixture-pi/node_modules/fixture-nested': { version: '2.0.0' },
      'node_modules/@fixture/linux-bin': { version: '1.0.0', optional: true },
      'node_modules/@fixture/win-bin': { version: '1.0.0', optional: true },
    } };
    await json(path.join(host, 'package-lock.json'), lock);
    await json(path.join(host, 'package.json'), { type: 'module', dependencies: { 'fixture-pi': '1.0.0' } });
    await json(path.join(production, 'package-lock.json'), lock);
    for (const [location, name, version, os] of [
      ['node_modules/fixture-pi', 'fixture-pi', '1.0.0'],
      ['node_modules/fixture-pi/node_modules/fixture-nested', 'fixture-nested', '2.0.0'],
      ['node_modules/@fixture/linux-bin', '@fixture/linux-bin', '1.0.0', ['linux']],
      ['node_modules/@fixture/win-bin', '@fixture/win-bin', '1.0.0', ['win32']],
    ]) {
      const root = path.join(production, location);
      await json(path.join(root, 'package.json'), { name, version, license: 'MIT', os });
      await put(path.join(root, 'LICENSE'), `MIT ${name}`);
      await put(path.join(root, 'index.js'), `export const name = '${name}';`);
    }
    await stagePiRuntime(repository, 'linux-x64', production);
    assert.equal(await readFile(path.join(destination, 'dist/record-document-worker.mjs'), 'utf8'), 'record bundle');
    assert.equal(await readFile(path.join(resources, 'source-extractor/source-dist/source-extraction-worker.mjs'), 'utf8'), 'source bundle');
    const first = await verifyPiDistribution(destination);
    assert.deepEqual(first.manifest.packages.map(entry => entry.name), ['@fixture/linux-bin', 'fixture-nested', 'fixture-pi']);
    await assert.rejects(readFile(path.join(destination, 'node_modules/@fixture/win-bin/package.json')), { code: 'ENOENT' });
    const runtime = JSON.parse(await readFile(path.join(destination, 'runtime.json')));
    assert.equal(runtime.workerDistributionChecksum, 'record-checksum');
    assert.equal(runtime.piDistributionChecksum, first.manifestChecksum);
    assert.equal(runtime.piNoticesChecksum, first.manifest.noticesChecksum);
    await stagePiRuntime(repository, 'linux-x64', production);
    assert.equal((await verifyPiDistribution(destination)).manifestChecksum, first.manifestChecksum);
    await put(path.join(destination, 'src/unlisted.mjs'), 'unlisted source');
    await assert.rejects(verifyPiDistribution(destination), /inventory differs/);
    await rm(path.join(destination, 'src/unlisted.mjs'));
    await put(path.join(destination, 'src/index.mjs'), 'tampered host');
    await assert.rejects(verifyPiDistribution(destination), /differs from the licensed build/);
    lock.packages['node_modules/fixture-pi'].version = '9.0.0';
    await json(path.join(production, 'package-lock.json'), lock);
    await assert.rejects(stagePiRuntime(repository, 'linux-x64', production), /lockfile differs/);
  } finally { await rm(repository, { recursive: true, force: true }); }
});

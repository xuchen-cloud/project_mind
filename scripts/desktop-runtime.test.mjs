import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopResourceCommands, desktopRuntimeTarget } from './desktop-runtime-target.mjs';
import * as runtime from './desktop-runtime-target.mjs';

const exec = promisify(execFile);

test('development CLI rejects an unverified Node archive before building workers or preparing DSH', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-development-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'invalid-archive');
  await writeFile(archive, 'not the pinned Node archive');
  await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('./prepare-desktop-runtime.mjs', import.meta.url)), '--development'], {
    windowsHide: true,
    env: { ...process.env, TAURI_ENV_TARGET_TRIPLE: '', CARGO_BUILD_TARGET: '',
      PROJECT_MIND_NODE_ARCHIVE: archive, npm_execpath: 'unused-npm-cli' },
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Official Node archive checksum does not match the pinned manifest/);
    return true;
  });
});

test('development selects a supported host and rejects conflicting targets before preparation', () => {
  for (const [platform, arch, triple] of [
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
  ]) {
    const host = { platform, arch };
    const expected = { development: true, target: desktopRuntimeTarget(triple, {}) };
    assert.deepEqual(runtime.desktopRuntimePreparation(['--development'], {}, host), expected);
    assert.deepEqual(runtime.desktopRuntimePreparation(['--development'], {
      TAURI_ENV_TARGET_TRIPLE: triple, CARGO_BUILD_TARGET: triple,
    }, host), expected);
    for (const name of ['TAURI_ENV_TARGET_TRIPLE', 'CARGO_BUILD_TARGET']) {
      assert.throws(() => runtime.desktopRuntimePreparation(['--development'], {
        [name]: triple === 'aarch64-apple-darwin' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin',
      }, host), /Conflicting/);
    }
  }
  assert.throws(() => runtime.desktopRuntimePreparation(['--development'], {}, { platform: 'linux', arch: 'arm64' }), /Unsupported/);
  for (const args of [['--unknown'], ['--development', 'aarch64-apple-darwin'], ['aarch64-apple-darwin', '--development']]) {
    assert.throws(() => runtime.desktopRuntimePreparation(args, {}), /Usage/);
  }
  assert.throws(() => runtime.desktopRuntimePreparation([], {}, { platform: 'darwin', arch: 'arm64' }), /must not default/);
  assert.deepEqual(runtime.desktopRuntimePreparation(['x86_64-pc-windows-msvc'], {}, { platform: 'darwin', arch: 'arm64' }), {
    development: false, target: desktopRuntimeTarget('x86_64-pc-windows-msvc', {}),
  });
  assert.deepEqual(runtime.desktopRuntimePreparation([], { TAURI_ENV_TARGET_TRIPLE: 'x86_64-apple-darwin' }), {
    development: false, target: desktopRuntimeTarget('x86_64-apple-darwin', {}),
  });
});

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

test('resource command composition prepares one Node and stages DSH after Record, Source', () => {
  const target = desktopRuntimeTarget('x86_64-apple-darwin', {});
  const commands = desktopResourceCommands(target, '/pinned/archive', '/production/dsh');
  assert.deepEqual(commands, [
    ['packages/agent-host/scripts/prepare-runtime.mjs', 'darwin-x64', '/pinned/archive'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.record-worker.config.ts'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.source-worker.config.ts'],
    ['scripts/stage-record-runtime.mjs', 'darwin-x64'],
    ['scripts/stage-source-runtime.mjs', 'darwin-x64'],
    ['scripts/build-office-runtime.mjs', 'x86_64-apple-darwin'],
    ['scripts/stage-office-runtime.mjs', 'darwin-x64'],
    ['scripts/stage-dsh-runtime.mjs', 'darwin-x64', '/production/dsh'],
  ]);
});

test('development prepares document workers including Source shared resources without Office or DSH staging', () => {
  const target = desktopRuntimeTarget('aarch64-apple-darwin', {});
  assert.deepEqual(desktopResourceCommands(target, '/pinned/archive', undefined, { development: true }), [
    ['packages/agent-host/scripts/prepare-runtime.mjs', 'darwin-arm64', '/pinned/archive'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.record-worker.config.ts'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.source-worker.config.ts'],
    ['scripts/stage-record-runtime.mjs', 'darwin-arm64'],
    ['scripts/stage-source-runtime.mjs', 'darwin-arm64'],
    ['scripts/build-office-runtime.mjs', 'aarch64-apple-darwin'],
  ]);
});

test('desktop build prepares target Office assets once before the frontend consumes them', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const steps = scripts['build:desktop'].split(' && ');
  assert.deepEqual(steps, ['npm run prepare:desktop-runtime', 'tsc', 'vite build']);
  const commands = desktopResourceCommands(desktopRuntimeTarget('x86_64-pc-windows-msvc', {}), '/archive', '/dsh');
  const officeBuilds = commands.filter(([script]) => script === 'scripts/build-office-runtime.mjs');
  assert.deepEqual(officeBuilds, [['scripts/build-office-runtime.mjs', 'x86_64-pc-windows-msvc']]);
});

test('Tauri normal and manual development wait for preparation and stop before Vite when it fails', async t => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const { build } = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
  assert.equal(scripts['prepare:dev-runtime'], 'node scripts/prepare-desktop-runtime.mjs --development');
  assert.equal(build.beforeDevCommand, 'npm run prepare:dev-runtime && npm run dev');
  assert.equal(scripts['dev:tauri'], 'npm run prepare:cli:dev && tauri dev');
  assert.equal(scripts['dev:tauri:manual'], 'npm run prepare:cli:dev && tauri dev --no-watch');

  // Execute the real hook with only Vite replaced by a marker: no app or server starts.
  const directory = await mkdtemp(path.join(tmpdir(), 'mind-development-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'invalid-archive');
  await writeFile(archive, 'not the pinned Node archive');
  await writeFile(path.join(directory, 'vite-marker.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('vite-started', 'unexpected');");
  const preparation = fileURLToPath(new URL('./prepare-desktop-runtime.mjs', import.meta.url));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: {
    hook: build.beforeDevCommand,
    'prepare:dev-runtime': `node "${preparation}" --development`,
    dev: 'node vite-marker.mjs',
  } }));
  await assert.rejects(exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'hook'], {
    cwd: directory, shell: process.platform === 'win32', windowsHide: true,
    env: { ...process.env, TAURI_ENV_TARGET_TRIPLE: '', CARGO_BUILD_TARGET: '', PROJECT_MIND_NODE_ARCHIVE: archive },
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Official Node archive checksum does not match the pinned manifest/);
    return true;
  });
  await assert.rejects(lstat(path.join(directory, 'vite-started')), { code: 'ENOENT' });
});


test('document workers have no independent Pi install or SDK runtime receipt', async () => {
  const worker = JSON.parse(await readFile(new URL('../packages/agent-host/package.json', import.meta.url)));
  const lock = JSON.parse(await readFile(new URL('../packages/agent-host/package-lock.json', import.meta.url)));
  const runtime = JSON.parse(await readFile(new URL('../packages/agent-host/runtime-manifest.json', import.meta.url)));
  assert.deepEqual(Object.keys(lock.packages), ['']);
  assert.equal(worker.dependencies, undefined);
  assert.equal(runtime.sdk, undefined);
  const preparation = await readFile(new URL('./prepare-desktop-runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(preparation, /productionHost|stagePiRuntime|stage-pi-runtime/);
});

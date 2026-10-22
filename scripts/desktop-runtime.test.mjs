import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { desktopResourceCommands, desktopRuntimeTarget } from './desktop-runtime-target.mjs';

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

test('desktop build prepares target Office assets once before the frontend consumes them', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const steps = scripts['build:desktop'].split(' && ');
  assert.deepEqual(steps, ['npm run prepare:desktop-runtime', 'tsc', 'vite build']);
  const commands = desktopResourceCommands(desktopRuntimeTarget('x86_64-pc-windows-msvc', {}), '/archive', '/dsh');
  const officeBuilds = commands.filter(([script]) => script === 'scripts/build-office-runtime.mjs');
  assert.deepEqual(officeBuilds, [['scripts/build-office-runtime.mjs', 'x86_64-pc-windows-msvc']]);
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

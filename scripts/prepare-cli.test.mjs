import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCli } from './prepare-cli.mjs';

const targets = [
  ['aarch64-apple-darwin', 'mind-aarch64-apple-darwin'],
  ['x86_64-apple-darwin', 'mind-x86_64-apple-darwin'],
  ['x86_64-pc-windows-msvc', 'mind-x86_64-pc-windows-msvc.exe'],
  ['x86_64-unknown-linux-gnu', 'mind-x86_64-unknown-linux-gnu'],
];

test('release CLI staging uses Cargo metadata and preserves unrelated Tauri configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mind CLI 中文 $literal '));
  const repository = path.join(directory, '仓库 with spaces');
  const targetDirectory = path.join(directory, 'Cargo 目标 输出');
  const originalConfig = { build: { frontendDist: '../dist' }, bundle: {
    externalBin: ['binaries/mind'], resources: { 'resources/': '' },
  }, plugins: { updater: { enabled: true } } };
  try {
    await mkdir(path.join(repository, 'src-tauri'), { recursive: true });
    for (const [target, filename] of targets) {
      const calls = [];
      const env = { CARGO_BUILD_TARGET: target, CARGO_TARGET_DIR: 'misleading relative target',
        TAURI_CONFIG: JSON.stringify(originalConfig), OTHER_BUILD_SETTING: 'retained' };
      const cargo = async (args, context) => {
        calls.push({ args, context });
        assert.equal(context.env.OTHER_BUILD_SETTING, 'retained');
        const config = JSON.parse(context.env.TAURI_CONFIG);
        assert.deepEqual(config.bundle.externalBin, []);
        assert.deepEqual(config.bundle.resources, originalConfig.bundle.resources);
        assert.deepEqual(config.build, originalConfig.build);
        assert.deepEqual(config.plugins, originalConfig.plugins);
        if (args[0] === 'metadata') return JSON.stringify({ target_directory: targetDirectory });
        assert.deepEqual(args.slice(0, 7), ['build', '--release', '--locked', '--bin', 'mind', '--target', target]);
        const binary = path.join(targetDirectory, target, 'release', target.includes('windows') ? 'mind.exe' : 'mind');
        await mkdir(path.dirname(binary), { recursive: true });
        await writeFile(binary, `binary for ${target}`);
      };
      const destination = await prepareCli({ repository, env, cargo });
      assert.equal(destination, path.join(repository, 'src-tauri', 'binaries', filename));
      assert.equal(await readFile(destination, 'utf8'), `binary for ${target}`);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].context.cwd, repository);
      assert.equal(calls[0].args.at(-1), path.join(repository, 'src-tauri', 'Cargo.toml'));
    }
    assert.deepEqual(originalConfig.bundle.externalBin, ['binaries/mind']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed or missing CLI builds never produce a staged sidecar', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'mind-cli-failure-'));
  const target = 'x86_64-unknown-linux-gnu';
  const targetDirectory = path.join(repository, 'target');
  const destination = path.join(repository, 'src-tauri/binaries', `mind-${target}`);
  const metadata = async () => JSON.stringify({ target_directory: targetDirectory });
  try {
    await assert.rejects(() => prepareCli({ repository, env: { CARGO_BUILD_TARGET: target },
      cargo: async (args) => args[0] === 'metadata' ? metadata() : Promise.reject(new Error('compiler failed')) }), /compiler failed/);
    await assert.rejects(() => readFile(destination), { code: 'ENOENT' });
    await assert.rejects(() => prepareCli({ repository, env: { CARGO_BUILD_TARGET: target },
      cargo: async (args) => args[0] === 'metadata' ? metadata() : undefined }), { code: 'ENOENT' });
    await assert.rejects(() => readFile(destination), { code: 'ENOENT' });
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('release entrypoints all select the sidecar overlay', async () => {
  const [base, overlay, packageJson, beta, patch] = await Promise.all([
    readFile('src-tauri/tauri.conf.json', 'utf8').then(JSON.parse),
    readFile('src-tauri/tauri.release.conf.json', 'utf8').then(JSON.parse),
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('.github/workflows/publish-beta.yml', 'utf8'),
    readFile('.github/workflows/publish-windows-patch.yml', 'utf8'),
  ]);
  assert.equal(base.bundle.externalBin, undefined);
  assert.deepEqual(overlay.bundle.externalBin, ['binaries/mind']);
  assert.match(overlay.build.beforeBuildCommand, /build:desktop:release/);
  assert.match(packageJson.scripts['build:desktop:release'], /prepare:cli/);
  assert.match(packageJson.scripts['build:tauri'], /tauri\.release\.conf\.json/);
  for (const workflow of [beta, patch]) assert.match(workflow, /--config src-tauri\/tauri\.release\.conf\.json/);
});

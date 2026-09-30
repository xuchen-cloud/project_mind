import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordWorkerNoticeAssets, verifyRecordWorkerDistribution, checksum } from '../../../scripts/record-worker-notices.mjs';

test('worker notices cover emitted packages and packaging detects altered code or notices', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-notices-'));
  try {
    const packageRoot = path.join(root, 'node_modules/@example/editor');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@example/editor', version: '1.0.0', license: 'MIT' }));
    await writeFile(path.join(packageRoot, 'LICENSE_MIT'), 'Copyright Example\nPermission notice\n');
    const code = 'export const value = 1;\n';
    const bundle = { worker: { type: 'chunk', fileName: 'record-document-worker.mjs', code, modules: { [path.join(packageRoot, 'index.js')]: {}, [path.join(root, 'src/app.ts')]: {} } } };
    const { notices, manifest } = await recordWorkerNoticeAssets(bundle);
    assert.equal(manifest.packages.length, 1);
    assert.equal(manifest.packages[0].name, '@example/editor');
    assert.ok(notices.includes('Copyright Example\nPermission notice'));
    assert.equal(manifest.bundles[0].checksum, checksum(code));
    const distribution = path.join(root, 'dist');
    await mkdir(distribution);
    await writeFile(path.join(distribution, 'record-worker-distribution.json'), JSON.stringify(manifest));
    await writeFile(path.join(distribution, 'THIRD-PARTY-NOTICES.txt'), notices);
    await writeFile(path.join(distribution, 'record-document-worker.mjs'), code);
    assert.equal((await verifyRecordWorkerDistribution(distribution)).manifestChecksum, checksum(await readFile(path.join(distribution, 'record-worker-distribution.json'))));
    await writeFile(path.join(distribution, 'record-document-worker.mjs'), 'altered');
    await assert.rejects(verifyRecordWorkerDistribution(distribution), /differs from the licensed build/);
    await writeFile(path.join(distribution, 'record-document-worker.mjs'), code);
    await writeFile(path.join(distribution, 'THIRD-PARTY-NOTICES.txt'), 'missing notices');
    await assert.rejects(verifyRecordWorkerDistribution(distribution), /notices differ/);
    await rm(path.join(packageRoot, 'LICENSE_MIT'));
    await assert.rejects(recordWorkerNoticeAssets(bundle), /Missing third-party license text/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual utility build retains package notices and verifies its complete chunk set', async () => {
  const directory = new URL('../dist/', import.meta.url);
  const { manifest } = await verifyRecordWorkerDistribution(fileURLToPath(directory));
  assert.ok(manifest.packages.some((entry) => entry.name === 'prosemirror-model'));
  assert.ok(manifest.packages.some((entry) => entry.name === 'boolbase' && entry.license === 'ISC'));
  assert.ok(manifest.bundles.every((entry) => !entry.file.includes('/')));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleOfficeDistribution } from './office-distribution.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-office-distribution-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, bytes) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  };
  for (const format of ['docx', 'xlsx', 'pptx']) {
    for (const [name, bytes] of Object.entries({
      'engine.mjs': `import {basename} from 'node:path'; export const inspect=()=>basename('/${format}');`,
      'THIRD-PARTY-NOTICES.txt': 'abc',
      'browser.mjs': 'legacy browser API',
      'renderer.html': '<script src="renderer.mjs"></script>',
      'renderer.mjs': 'official renderer',
      'fonts/official.woff2': new Uint8Array([0, 255, 32, 80]),
      'engine.meta.json': '{}',
      'engine-metafile.json': '{}',
      'renderer-meta.json': '{}',
      'frame-metafile.json': '{}',
      'engine.d.mts': 'export declare function inspect(): string;',
    })) await put(`packages/office-${format}/dist/${name}`, bytes);
  }
  await put('packages/office-xlsx/dist/LICENSE', 'official license');
  await put('packages/office-xlsx/dist/NOTICE', 'official notice');
  await put('packages/office-xlsx/dist/xlsx-sidecar', 'unix binary');
  await put('packages/office-xlsx/dist/xlsx-sidecar.exe', 'windows binary');
  await put('packages/office-runtime/worker.mjs', 'export const worker=true;');
  await put('packages/agent-host/office-dist/renderer/stale.woff2', 'stale packaged font');
  return { root, put, distribution: path.join(root, 'packages/agent-host/office-dist') };
}

async function snapshot(directory) {
  const files = {};
  async function visit(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), name + '/');
      else files[name] = await readFile(path.join(dir, entry.name));
    }
  }
  await visit(directory);
  return files;
}

test('a fresh checkout can import the assembler before Word build tools are installed', async t => {
  const f = await fixture(t);
  for (const name of ['office-distribution.mjs', 'desktop-runtime-target.mjs']) {
    await f.put(`scripts/${name}`, await readFile(new URL(name, import.meta.url)));
  }
  const moduleUrl = pathToFileURL(path.join(f.root, 'scripts/office-distribution.mjs')).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {createRequire} from 'node:module';
    import assert from 'node:assert/strict';
    const require=createRequire(new URL('../packages/office-docx/package.json', ${JSON.stringify(moduleUrl)}));
    assert.throws(()=>require.resolve('esbuild'), {code:'MODULE_NOT_FOUND'});
    assert.throws(()=>require.resolve('typescript'), {code:'MODULE_NOT_FOUND'});
    const {assembleOfficeDistribution}=await import(${JSON.stringify(moduleUrl)});
    assert.equal(typeof assembleOfficeDistribution,'function');
    console.log('imported without build tools');
  `], { encoding: 'utf8' });
  assert.equal(output.trim(), 'imported without build tools');
});

test('native distribution excludes duplicate renderers, fonts, nested sidecars and build metadata without altering format dist', async t => {
  const f = await fixture(t);
  const originals = {};
  for (const format of ['docx', 'xlsx', 'pptx']) originals[format] = await snapshot(path.join(f.root, `packages/office-${format}/dist`));
  await assembleOfficeDistribution(f.root, 'aarch64-apple-darwin');
  const files = await snapshot(f.distribution);
  assert.deepEqual(Object.keys(files).sort(), [
    'docx-engine.mjs', 'docx/THIRD-PARTY-NOTICES.txt', 'docx/engine.mjs',
    'office-distribution.json',
    'pptx-engine.mjs', 'pptx/THIRD-PARTY-NOTICES.txt', 'pptx/engine.mjs',
    'worker.mjs', 'xlsx-engine.mjs', 'xlsx-sidecar',
    'xlsx/LICENSE', 'xlsx/NOTICE', 'xlsx/THIRD-PARTY-NOTICES.txt', 'xlsx/engine.mjs',
  ].sort());
  for (const format of ['docx', 'xlsx', 'pptx']) {
    assert.deepEqual(await snapshot(path.join(f.root, `packages/office-${format}/dist`)), originals[format]);
    assert.equal((await import(pathToFileURL(path.join(f.distribution, `${format}-engine.mjs`)).href)).inspect(), format);
  }
  const manifest = JSON.parse(files['office-distribution.json']);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.rustTarget, 'aarch64-apple-darwin');
  assert.equal(manifest.runtimeTarget, 'darwin-arm64');
  assert.equal(manifest.upstream, 'd32d1711f1bf985430757b8c6b3fbddd3831d946');
  assert.equal(manifest.files.length, 13);
  assert.deepEqual(manifest.files.map(row => row.file).sort(), Object.keys(files).filter(name => name !== 'office-distribution.json').sort());
  assert.equal(manifest.files.find(row => row.file === 'docx/THIRD-PARTY-NOTICES.txt').sha256,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const row of manifest.files) assert.equal(row.sha256, createHash('sha256').update(files[row.file]).digest('hex'), row.file);
});

test('an engine closure change fails before replacing the previous distribution', async t => {
  for (const [name, code] of [
    ['relative module', "import value from './extra.mjs'; export const inspect=()=>value;"],
    ['external package', "import value from 'new-runtime-package'; export const inspect=()=>value;"],
    ['computed import', 'export const inspect=name=>import(name);'],
    ['computed require', 'export const inspect=name=>require(name);'],
    ['adjacent asset', "export const inspect=()=>new URL('./font.woff2',import.meta.url);"],
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    await f.put('packages/office-docx/dist/engine.mjs', code);
    await f.put('packages/office-docx/dist/extra.mjs', 'export default 42;');
    const previous = await snapshot(f.distribution);
    await assert.rejects(assembleOfficeDistribution(f.root, 'aarch64-apple-darwin'), /Office docx engine closure/);
    assert.deepEqual(await snapshot(f.distribution), previous);
  });
});

test('Windows distribution uses the requested target and only its executable', async t => {
  const f = await fixture(t);
  await f.put('packages/office-xlsx/dist/engine.mjs', `
    import {fileURLToPath} from 'node:url';
    export const inspect=context=>context.binaryPath ?? fileURLToPath(new URL(
      process.platform === 'win32' ? './xlsx-sidecar.exe' : './xlsx-sidecar', import.meta.url));
  `);
  const manifest = await assembleOfficeDistribution(f.root, 'x86_64-pc-windows-msvc');
  assert.equal(manifest.rustTarget, 'x86_64-pc-windows-msvc');
  assert.equal(manifest.runtimeTarget, 'win-x64');
  assert.equal(manifest.files.length, 13);
  assert.deepEqual(manifest.files.filter(row => row.file.includes('sidecar')).map(row => row.file), ['xlsx-sidecar.exe']);
  assert.equal(await readFile(path.join(f.distribution, 'xlsx-sidecar.exe'), 'utf8'), 'windows binary');
});

test('the real worker passes the retained top-level sidecar to the relocated XLSX engine', async t => {
  const f = await fixture(t);
  await f.put('packages/office-runtime/worker.mjs', await readFile(new URL('../packages/office-runtime/worker.mjs', import.meta.url)));
  await f.put('packages/office-xlsx/dist/engine.mjs', `
    import {fileURLToPath} from 'node:url';
    export const inspect=(bytes,context)=>({binaryPath:context.binaryPath ?? fileURLToPath(new URL(
      process.platform === 'win32' ? './xlsx-sidecar.exe' : './xlsx-sidecar', import.meta.url))});
  `);
  await assembleOfficeDistribution(f.root, process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'aarch64-apple-darwin');
  const { handleOfficeRequest } = await import(pathToFileURL(path.join(f.distribution, 'worker.mjs')).href);
  const response = await handleOfficeRequest({ requestId: 'relocated', method: 'office.inspect', data: { format: 'xlsx', base64: 'YWJj' } });
  assert.equal(response.ok, true);
  const expected = path.join(f.distribution, process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar');
  assert.equal(response.data.model.binaryPath, expected);
  assert.ok((await readFile(expected)).length);
});

test('invalid targets, missing target binaries and missing licenses leave the previous distribution intact', async t => {
  for (const scenario of ['unsupported target', 'missing Windows binary', 'missing license']) await t.test(scenario, async t => {
    const f = await fixture(t);
    let target = 'x86_64-pc-windows-msvc';
    if (scenario === 'unsupported target') target = 'unknown-target';
    if (scenario === 'missing Windows binary') await rm(path.join(f.root, 'packages/office-xlsx/dist/xlsx-sidecar.exe'));
    if (scenario === 'missing license') await rm(path.join(f.root, 'packages/office-xlsx/dist/LICENSE'));
    const previous = await snapshot(f.distribution);
    await assert.rejects(assembleOfficeDistribution(f.root, target), scenario === 'unsupported target' ? /Unsupported desktop Rust target/ : /ENOENT/);
    assert.deepEqual(await snapshot(f.distribution), previous);
  });
});

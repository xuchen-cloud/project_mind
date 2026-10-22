import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundlePatchFiles, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = path.join(root, 'vendor/dsh-web-app');
const require = createRequire(new URL('../package.json', import.meta.url));
const read = file => readFile(file, 'utf8');
const json = async file => JSON.parse(await read(file));
const hash = value => createHash('sha256').update(value).digest('hex');
test('local web bundle preserves pinned upstream bytes except the documented manifest dependencies', async () => {
  const provenance = await json(path.join(vendor, 'provenance.json'));
  assert.equal(provenance.version, '0.2.0-rc.2');
  assert.equal(provenance.publishedArchive.integrity, 'sha512-pCIMPLfTKVfY942dP4eJSDVw7iUw86pemzfOr/e5DWP7CdCKTfvA82kP0RJAKJcyKJd8s679hqtCue/p4P20Dg==');
  for (const [file, expected] of Object.entries(provenance.upstreamSha256)) {
    let contents = await read(path.join(vendor, file));
    if (file === 'package.json') {
      const original = JSON.parse(contents);
      original.dependencies['@deepseek-ai/dsh-office-to-pdf'] = '0.2.0-rc.2';
      original.devDependencies['@deepseek-ai/libreoffice-kit'] = '^0.1.1';
      // Published metadata uses this order and has no trailing newline.
      const order = (values, key, before) => Object.fromEntries(Object.entries(values).flatMap(([name, value]) =>
        name === before ? [[key, values[key]], [name, value]] : name === key ? [] : [[name, value]]));
      original.dependencies = order(original.dependencies, '@deepseek-ai/dsh-office-to-pdf', '@deepseek-ai/dsh-persona');
      original.devDependencies = { '@deepseek-ai/libreoffice-kit': '^0.1.1', ...original.devDependencies };
      contents = JSON.stringify(original, null, 2);
    }
    assert.equal(hash(contents), expected, file);
  }
  assert.match(await read(path.join(vendor, 'LICENSE')), /Copyright \(c\) 2026 DeepSeek/);
  assert.equal(require.resolve('@deepseek-ai/dsh-web-app'), path.join(vendor, 'lib/index.js'));
  assert.equal(typeof (await import('@deepseek-ai/dsh-web-app')).apply, 'function');
  assert.equal(typeof (await import('@deepseek-ai/dsh-web-app/startup')).apply, 'function');
});

test('official plugin composition preserves Office preview and keeps only its converter disabled', async () => {
  const layers = [];
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const file = require.resolve(`${name}/package.json`);
    const pkg = await json(file);
    for (const patch of bundlePatchFiles(pkg.dsh.bundle)) layers.push(path.resolve(path.dirname(file), patch));
  }
  const warnings = [];
  const current = composeEntries([...layers, path.join(root, 'config/desktop.patch.yml')]
    .map(file => loadOverlayPatches('web-bundle-test', file)), warning => warnings.push(warning));
  assert.deepEqual(warnings, []);
  assert.equal(current.find(row => row.id === 'office-to-pdf').disabled, true);
  assert.ok(current.some(row => row.name === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' && !row.disabled));
  for (const row of current.filter(row => row.disabled !== true && row.name)) {
    assert.ok(require.resolve(row.name), `active plugin must resolve: ${row.id}`);
  }
});

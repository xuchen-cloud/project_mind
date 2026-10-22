import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async name => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url)));

test('locked install graph excludes the disabled Office converter and every LibreOffice payload', async () => {
  const lock = await json('package-lock.json');
  for (const [location, pkg] of Object.entries(lock.packages)) {
    assert.doesNotMatch(location, /dsh-office-to-pdf|libreoffice/i);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(pkg[field] ?? {})) {
        assert.doesNotMatch(dependency, /dsh-office-to-pdf|libreoffice/i, `${location}: ${field}`);
      }
    }
  }
  assert.equal(lock.packages['node_modules/@earendil-works/pi-ai'].version, '0.87.1');
});

test('the web bundle is an explicit local install dependency with the pinned upstream identity', async () => {
  const manifest = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-web-app'], 'file:vendor/dsh-web-app');
  assert.deepEqual(lock.packages['node_modules/@deepseek-ai/dsh-web-app'], {
    resolved: 'vendor/dsh-web-app', link: true,
  });
  const vendor = await json('vendor/dsh-web-app/package.json');
  assert.equal(vendor.name, '@deepseek-ai/dsh-web-app');
  assert.equal(vendor.version, '0.2.0-rc.2');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import postcss from 'postcss';
import { dshUiAliases } from './vite-aliases.mjs';
import { scopeTheme } from './scope-styles.mjs';
const manifest = JSON.parse(await fs.readFile(new URL('./provenance.json', import.meta.url), 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');

test('inventory verifies every pinned source byte and limits changes to recorded host integration patches', async () => {
  const allowed = new Set(manifest.localChanges.flatMap(change => change.paths));
  for (const file of manifest.files) {
    const data = await fs.readFile(new URL(file.path, import.meta.url));
    assert.equal(sha(data), file.sha256, file.path);
    if (file.added || file.originalSha256 !== file.sha256) assert.ok(allowed.has(file.path), `Unrecorded patch: ${file.path}`);
    assert.doesNotMatch(file.path, /(?:^|\/)(?:node_modules|\.upstream|\.downloads|\.acceptance|lib|dist)(?:\/|$)/u);
  }
  assert.match(await fs.readFile(new URL('./LICENSE', import.meta.url), 'utf8'), /Copyright \(c\) 2026 DeepSeek/u);
});

test('all browser aliases select real source entries without capturing generated remote exports', async () => {
  const adapter = dshUiAliases.filter(alias => alias.find.test('@project-mind/dsh-ui/adapters'));
  assert.equal(adapter.length, 1);
  assert.equal(adapter[0].replacement, new URL('./adapters/index.jsx', import.meta.url).pathname);
  await fs.access(adapter[0].replacement);
  for (const pkg of manifest.packages) {
    const id = `${pkg.name}/client`;
    const matching = dshUiAliases.filter(alias => alias.find.test(id));
    assert.equal(matching.length, 1, id);
    await fs.access(matching[0].replacement);
    if (pkg.name === '@deepseek-ai/dsh-client-ui-primitives') {
      assert.equal(matching[0].replacement, new URL('./adapters/primitives.tsx', import.meta.url).pathname);
      const wrapper = await fs.readFile(matching[0].replacement, 'utf8');
      assert.match(wrapper, /export \* from "\.\.\/upstream\/client\/ui-primitives\/src\/index"/u);
      assert.match(wrapper, /export function FileTypeIcon/u);
      assert.match(wrapper, /<UpstreamFileTypeIcon \{\.\.\.props\}/u);
    } else assert.ok(matching[0].replacement.endsWith(pkg.entry), id);
    assert.ok(!dshUiAliases.some(alias => alias.find.test(`${pkg.name}/remote`)), pkg.name);
  }
  for (const pkg of ['dsh-client-product-analytics', 'dsh-client-file-upload', 'dsh-client-ui-plugin-manager']) {
    const url = import.meta.resolve(`@deepseek-ai/${pkg}/remote`);
    assert.doesNotMatch(await fs.readFile(new URL(url), 'utf8'), /ModuleLoader/u);
  }
});

test('scoped stylesheet is reproducible and every selector belongs to a host', async () => {
  const derived = manifest.derivedAssets[0];
  const expected = (await Promise.all(derived.sources.map(async source => {
    const name = source.split('/').at(-1);
    return `/* Upstream ui-theme/${name}; selectors scoped to the native host. */\n${scopeTheme(await fs.readFile(new URL(source, import.meta.url), 'utf8'))}`;
  }))).join('\n\n');
  const actual = await fs.readFile(new URL('./styles/scoped.css', import.meta.url), 'utf8');
  assert.equal(actual, expected);
  postcss.parse(actual).walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/u.test(rule.parent.name)) return;
    for (const selector of rule.selectors) assert.ok(selector.includes('.dsh-ui-host'), selector);
  });
});

test('embedded browser install graph excludes native Office conversion engines', async () => {
  const lock = JSON.parse(await fs.readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const nativeOffice = /(?:^|[/])(?:libreoffice-kit(?:-[^/]+)?|koffi(?:-[^/]+)?)(?:[/]|$)/u;
  for (const [location, pkg] of Object.entries(lock.packages)) {
    assert.doesNotMatch(location, nativeOffice, location);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(pkg[field] ?? {})) {
        assert.doesNotMatch(dependency, nativeOffice, `${location}: ${field}`);
      }
    }
  }
});


test('Office browser Remote is the original upstream contribution without a converter export', async () => {
  const directory = new URL('../dsh-office-client/', import.meta.url);
  const provenance = JSON.parse(await fs.readFile(new URL('provenance.json', directory), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(new URL('package.json', directory), 'utf8'));
  assert.equal(pkg.version, '0.2.0-rc.2');
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./package.json', './remote', './types']);
  for (const [file, hash] of Object.entries(provenance.upstreamSha256)) {
    assert.equal(sha(await fs.readFile(new URL(file, directory))), hash, file);
  }
  assert.equal(typeof (await import('@deepseek-ai/dsh-office-to-pdf/remote')).default, 'object');
});

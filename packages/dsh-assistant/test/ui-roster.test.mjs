import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { composeEntries, loadOverlayPatches, bundlePatchFiles } from '@deepseek-ai/dsh-app-boot';
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = path.join(root, 'vendor/dsh-desktop-client-ui');
const require = createRequire(new URL('../package.json', import.meta.url));
const read = file => readFile(file, 'utf8');
const json = async file => JSON.parse(await read(file));
const hash = source => createHash('sha256').update(source).digest('hex');
const client = await read(path.join(vendor, 'client.js'));
const manifest = await json(path.join(vendor, 'package.json'));
const provenance = await json(path.join(vendor, 'provenance.json'));

// These are fingerprints of the pinned upstream artifacts, not generated UI.
const upstreamHashes = {
  'index.js': '39947400685dd3eeb870bfa2b713c001404e259c82bfef420d8a5cc31faf3b78',
  'client.js': '12fbe5932d3f7c1ce57ea5f6903b2cf8477e604204575298a73898daf3b27e52',
  'package.json': '504c8db2c0c2eb4c974045e0ac946965c48598dc9475baeca32b64ab27c7b021',
  LICENSE: '434c81c99d0154715e5bdfca16fe5fcc4473346d34a329e19d2aea4ef73cb29e',
};

test('vendor is the pinned MIT upstream plugin with only documented browser gates', async () => {
  assert.equal(provenance.repository, 'https://github.com/dataelement/dsh-desktop');
  assert.equal(provenance.commit, '115a0b474cc2c4794316171c640a8898398591fe');
  assert.equal(provenance.sourceDirectory, 'packages/dsh-desktop-client-ui');
  assert.deepEqual(provenance.upstreamSha256, upstreamHashes);
  assert.equal(hash(await read(path.join(vendor, 'index.js'))), upstreamHashes['index.js']);
  assert.equal(hash(await read(path.join(vendor, 'LICENSE'))), upstreamHashes.LICENSE);
  assert.match(await read(path.join(vendor, 'LICENSE')), /Copyright \(c\) 2026 DataElement/);
  assert.equal(client.split('if (window.dshDesktop) ctx.slots.inject').length - 1, 2);
  const original = client.replace(/    \/\/ BEGIN Project Mind embedded shell[\s\S]*?    \/\/ END Project Mind embedded shell\n\n/, '')
    .replace('      if (window.__MIND_DSH_EMBEDDED__) embedInMainApplication(ctx)\n', '')
    .replaceAll('if (window.dshDesktop) ctx.slots.inject', 'ctx.slots.inject');
  assert.equal(hash(original), upstreamHashes['client.js']);
  // Keep all upstream metadata and exports; only peer ranges changed.
  const originalManifest = structuredClone(manifest);
  for (const name of Object.keys(originalManifest.peerDependencies)) {
    originalManifest.peerDependencies[name] = name === '@deepseek-ai/cordis' ? '^4.0.1'
      : name.endsWith('conversation') || name.endsWith('renderer') || name.endsWith('sidebar')
        ? '^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1'
        : '^0.1.7-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1';
  }
  assert.equal(hash(JSON.stringify(originalManifest, null, 2) + '\n'), upstreamHashes['package.json']);
});

test('host and browser exports are real plugin entries with exact rc.2 peers', async () => {
  assert.equal(manifest.name, 'dsh-desktop-client-ui');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(await read(require.resolve('dsh-desktop-client-ui')), await read(path.join(vendor, 'index.js')));
  const host = await import(pathToFileURL(require.resolve('dsh-desktop-client-ui')).href);
  assert.equal(typeof host.apply, 'function');
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    assert.equal(version, name === '@deepseek-ai/cordis' ? '4.0.4' : '0.2.0-rc.2');
    assert.equal((await json(require.resolve(`${name}/package.json`))).version, version);
  }
  assert.deepEqual(manifest.dsh.client.inject, Object.keys(manifest.peerDependencies).filter(name => name !== '@deepseek-ai/cordis'));
});

test('official module discovery finds the named vendor package and its browser bundle', () => {
  // Exercise upstream manifest discovery alone; its constructor also mounts
  // HTTP routes and HMR listeners, which this bounded test does not start.
  const registry = Object.create(ClientModuleRegistry.prototype);
  Object.defineProperty(registry, 'ctx', { value: { loader: { internal: undefined } } });
  registry.pkgMeta = new Map();
  const meta = registry.resolveMeta('dsh-desktop-client-ui', pathToFileURL(path.join(root, 'package.json')).href);
  assert.ok(meta, 'named host package must produce a browser roster entry');
  assert.equal(meta.packageName, manifest.name);
  assert.equal(meta.meta.clientPath, path.join(vendor, 'client.js'));
  assert.deepEqual(meta.meta.inject, manifest.dsh.client.inject);
});

async function composedRoster() {
  const layers = [];
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const file = require.resolve(`${name}/package.json`);
    const pkg = await json(file);
    assert.equal(pkg.version, '0.2.0-rc.2');
    for (const patch of bundlePatchFiles(pkg.dsh.bundle)) {
      layers.push(loadOverlayPatches('ui-roster-test', path.resolve(path.dirname(file), patch)));
    }
  }
  layers.push(loadOverlayPatches('ui-roster-test', path.join(root, 'config/desktop.patch.yml')));
  const warnings = [];
  const rows = composeEntries(layers, warning => warnings.push(warning));
  assert.deepEqual(warnings, [], 'overlay must target actual upstream rows');
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'one row per id');
  return new Map(rows.map(row => [row.id, row]));
}

test('official base/web roster retains chat, model setup, live transport and durable history', async () => {
  const rows = await composedRoster();
  for (const id of ['connection', 'api-remotes', 'modules', 'webserver', 'web-runtime',
    'session-controller', 'workspace-controller', 'settings-controller', 'workspace',
    'ui-session', 'ui-chat', 'ui-conversation', 'ui-workspace', 'ui-settings',
    'ui-settings-models', 'ui-model-selection', 'ui-sidebar-documentpreview',
    'session', 'session-persistence-jsonl', 'session-query-sqlite',
    'session-projection', 'session-projection-cache', 'storage', 'storage-json', 'storage-domain']) {
    assert.ok(rows.has(id), `missing required row ${id}`);
    assert.notEqual(rows.get(id).disabled, true, `disabled required row ${id}`);
  }
  assert.equal(rows.get('connection').name, '@deepseek-ai/dsh-client-connection');
  assert.equal(rows.get('ui-chat').name, '@deepseek-ai/dsh-client-ui-chat');
  assert.equal(rows.get('dsh-desktop-client-ui').name, 'dsh-desktop-client-ui');
  for (const name of manifest.dsh.client.inject) {
    assert.ok([...rows.values()].some(row => row.name === name && row.disabled !== true), `missing browser dependency ${name}`);
  }
  for (const id of ['ui-brand-official', 'ui-settings-account', 'office-to-pdf',
    'directory-picker', 'open-in-app', 'ui-open-in-app']) assert.equal(rows.get(id).disabled, true, id);
  assert.deepEqual(rows.get('session-controller').config, { nativeOpen: false });
  const picker = rows.get('directory-picker-browse');
  const surface = rows.get('ui-directory-picker-browse');
  assert.equal(picker.name, '@deepseek-ai/dsh-host-directory-picker-browse');
  assert.equal(surface.name, '@deepseek-ai/dsh-client-ui-directory-picker-browse');
  for (const row of [picker, surface]) {
    assert.notEqual(row.disabled, true);
    assert.equal((await json(require.resolve(`${row.name}/package.json`))).version, '0.2.0-rc.2');
  }
  const overlay = await read(path.join(root, 'config/desktop.patch.yml'));
  assert.doesNotMatch(overlay, /electron|sdk-jsonrpc-server|dsh-desktop-office|ppt-composer|dsh-desktop-workbenches/i);
});

// Run the actual browser bundle against its public slots/React seam without a UI.
function loadClient(desktop) {
  let definition;
  const styles = [];
  const cleanups = [];
  const window = { __ModuleLoader__: { load(value) { definition = value; } },
    confirm: () => true, alert(reason) { throw new Error(reason); } };
  if (desktop) window.dshDesktop = desktop;
  const document = { documentElement: { lang: 'en' }, getElementById: () => null,
    createElement: () => ({ remove() { styles.splice(styles.indexOf(this), 1); } }),
    head: { appendChild(style) { styles.push(style); } } };
  vm.runInNewContext(client, { window, document });
  assert.equal(definition.id, manifest.name);
  const React = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}] };
  const primitives = { BrandWordmark: 'BrandWordmark', FishLogo: 'FishLogo', MenuItemButton: 'MenuItemButton' };
  const plugin = definition.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`Unexpected browser dependency: ${name}`);
  });
  const registrations = [];
  const calls = [];
  const ctx = {
    slots: {
      inject(_name, callback) {
        const result = callback();
        if (result?.[Symbol.iterator]) [...result];
        return result;
      },
      register(config, component) { registrations.push({ config, component }); return () => {}; },
    },
    effect(setup) { cleanups.push(setup()); },
    get(name) {
      assert.equal(name, 'uiWorkspace');
      return { deleteSession: id => { calls.push(id); return Promise.resolve(); } };
    },
  };
  plugin.apply(ctx);
  return { registrations, calls, styles, cleanups, plugin, window };
}

test('browser uses upstream brand slots and keeps delete/unread, without native action seats', async () => {
  const { registrations, plugin, styles, cleanups, calls, window } = loadClient();
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'remote.session', 'sessions', 'uiWorkspace']);
  assert.deepEqual(registrations.map(row => row.config.id ?? row.config.name), [
    'sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark',
    'desktop-delete-session', 'desktop-unread-session',
  ]);
  assert.equal(registrations[1].component({}).props.includeMark, false);
  assert.equal(registrations[2].component({ size: 48 }).type, 'FishLogo');
  assert.equal(registrations[0].component({}).children[0].props.fill, 'currentColor');
  assert.equal(styles.length, 1);
  cleanups.forEach(cleanup => cleanup?.());
  assert.equal(styles.length, 0, 'upstream style has an owned lifetime');
  const deleteRow = registrations.find(row => row.config.id === 'desktop-delete-session');
  const menuProps = { sessionId: 'session-1', useMenuOpenState: () => [true, () => {}], ...deleteRow.config.inject() };
  window.confirm = () => false;
  deleteRow.component(menuProps).props.onSelect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  window.confirm = () => true;
  deleteRow.component(menuProps).props.onSelect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['session-1'], 'delete uses upstream workspace navigation, not a desktop bridge');
  const unreadRow = registrations.find(row => row.config.id === 'desktop-unread-session');
  let changed;
  unreadRow.component({ ...menuProps, unread: false, onUnreadChange: (...args) => { changed = args; } }).props.onSelect();
  assert.deepEqual(changed, ['session-1', true]);
});

test('documented native gates preserve the original occupants for a real desktop carrier', () => {
  const { registrations } = loadClient({ openInFinder() {} });
  assert.ok(registrations.some(row => row.config.id === 'desktop-open-local'));
  assert.ok(registrations.some(row => row.config.id === 'desktop-open-session-folder'));
});

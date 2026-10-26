import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Keep module mocks and process.platform changes out of the normal test runner.
async function scenario(platform, body) {
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as fs from 'node:fs/promises';
    import path from 'node:path';
    import os from 'node:os';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-fs-durability-'));
    const events = [];
    let directoryError = ${JSON.stringify(platform === 'win32' ? 'EPERM' : null)};
    mock.module('node:fs/promises', { namedExports: { ...fs,
      open: async (file, ...args) => {
        if (args[0] === 'r' && (await fs.stat(file)).isDirectory()) {
          events.push(['directory-open', file]);
          return {
            async sync() {
              events.push(['directory-sync', file]);
              if (directoryError) throw Object.assign(new Error('directory sync failed'), { code: directoryError });
            },
            async close() { events.push(['directory-close', file]); },
          };
        }
        const handle = await fs.open(file, ...args);
        const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
        handle.sync = async () => { events.push(['file-sync', file]); await sync(); };
        handle.close = async () => { events.push(['file-close', file]); await close(); };
        return handle;
      },
      rename: async (from, to) => { events.push(['rename', from, to]); await fs.rename(from, to); },
    } });
    const { migrateSharedRuntime, reconcileContextDirectories } = await import(${JSON.stringify(new URL('../scripts/shared-runtime-migration.mjs', import.meta.url).href)});
    const { bindContext } = await import(${JSON.stringify(new URL('../scripts/project-workspace.mjs', import.meta.url).href)});
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const home = path.join(root, 'home'), legacyRoot = path.join(root, 'legacy');
    const workspaceId = '0123456789abcdef0123456789abcdef';
    const directory = await fs.realpath(root);
    const initial = { kind: 'workspace', id: workspaceId, name: 'Workspace', directory };
    const ctx = {
      workspaceRegistry: { archivedSessionIds: [], get: () => ({ id: 'mapped', path: directory, title: 'Workspace', sessionIds: [] }) },
      workspaceController: { create: async () => ({ workspace: { workspaceId: 'mapped' } }) },
      sessionController: { list: async () => ({ items: [] }) },
      connection: { fetch: { register() {} } }, effect() {},
    };
    try { ${body} }
    finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  `;
  const result = await promisify(execFile)(process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-e', script]);
  assert.equal(result.stdout, '');
}

test('Windows fresh startup migrates and saves context mappings with file sync before atomic rename', async () => {
  await scenario('win32', `
    assert.deepEqual(await migrateSharedRuntime({ legacyRoot, home, workspaceId }), { version: 1, contexts: [] });
    const contexts = await bindContext(ctx, initial, { home });
    assert.equal(contexts.workspace.workspaceId, 'mapped');
    const expected = { version: 1, contexts: [{ kind: 'workspace', id: workspaceId, directory, workspaceId: 'mapped' }] };
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'mind-contexts.json'), 'utf8')), expected);
    assert.deepEqual(await migrateSharedRuntime({ legacyRoot, home, workspaceId }), expected);
    assert.equal(events.filter(([kind]) => kind.startsWith('directory-')).length, 0);
    const synced = events.filter(([kind]) => kind === 'file-sync');
    assert.equal(synced.length, 4);
    for (const event of synced) {
      const syncIndex = events.indexOf(event);
      assert.deepEqual(events[syncIndex + 1], ['file-close', event[1]]);
      assert.ok(events.slice(syncIndex + 2).some(([kind]) => kind === 'rename'));
    }
    assert.equal(events.filter(([kind]) => kind === 'rename').length, 2);
  `);
});

test('Windows history migration and directory reconciliation preserve sessions and stable mappings', async () => {
  await scenario('win32', `
    const source = path.join(legacyRoot, 'workspace');
    await fs.mkdir(path.join(source, 'storages'), { recursive: true });
    await fs.writeFile(path.join(source, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 }, global: { workspaceIds: ['mapped'] },
      tables: { workspaces: { mapped: { path: directory, sessionIds: ['session'] } } },
    }));
    await fs.mkdir(path.join(source, 'sessions', 'group', 'session'), { recursive: true });
    const history = JSON.stringify({ type: 'session', id: 'session', cwd: directory }) + '\\nevent bytes';
    await fs.writeFile(path.join(source, 'sessions', 'group', 'session', 'session.jsonl'), history);
    await fs.mkdir(path.join(source, 'attachments', 'v1'), { recursive: true });
    await fs.writeFile(path.join(source, 'attachments', 'v1', 'file'), 'attachment');
    await migrateSharedRuntime({ legacyRoot, home, workspaceId });
    const moved = path.join(directory, 'moved');
    const mappings = await reconcileContextDirectories({ home, contexts: [{ ...initial, directory: moved }] });
    assert.deepEqual(mappings.contexts, [{ kind: 'workspace', id: workspaceId, directory: moved, workspaceId: 'mapped' }]);
    const registry = JSON.parse(await fs.readFile(path.join(home, 'storages/workspace.json'), 'utf8'));
    assert.equal(registry.tables.workspaces.mapped.path, moved);
    const files = (await fs.readdir(path.join(home, 'sessions'), { recursive: true })).filter(file => path.basename(file) === 'session.jsonl');
    assert.equal(files.length, 1);
    assert.equal(await fs.readFile(path.join(home, 'sessions', files[0]), 'utf8'), JSON.stringify({ type: 'session', id: 'session', cwd: moved }) + '\\nevent bytes');
    assert.equal(await fs.readFile(path.join(home, 'attachments', 'v1', 'file'), 'utf8'), 'attachment');
    assert.equal(await fs.readFile(path.join(source, 'sessions', 'group', 'session', 'session.jsonl'), 'utf8'), history);
    assert.equal(events.filter(([kind]) => kind.startsWith('directory-')).length, 0);
  `);
});

test('POSIX syncs and closes directories and propagates EIO and EPERM through both startup paths', async () => {
  await scenario('linux', `
    const { syncDirectory } = await import(${JSON.stringify(new URL('../scripts/fs-durability.mjs', import.meta.url).href)});
    await syncDirectory(root);
    assert.deepEqual(events.splice(0), [['directory-open', root], ['directory-sync', root], ['directory-close', root]]);
    for (const code of ['EIO', 'EPERM']) {
      directoryError = code;
      await assert.rejects(syncDirectory(root), { code });
      assert.deepEqual(events.splice(0), [['directory-open', root], ['directory-sync', root], ['directory-close', root]]);
      await assert.rejects(migrateSharedRuntime({ legacyRoot, home, workspaceId }), { code });
      await assert.rejects(fs.access(home), { code: 'ENOENT' });
      await assert.rejects(bindContext(ctx, initial, { home }), { code });
      await fs.rm(home, { recursive: true, force: true });
      events.length = 0;
    }
  `);
});

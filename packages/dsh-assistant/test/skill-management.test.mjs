import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink, lstat, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as filesystem from '@deepseek-ai/dsh-skill-filesystem';
import { discoverSkills, manageSkill, prepareBundledSkills } from '../scripts/skills.mjs';

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mind-skill-management-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, 'external');
  const bundledSkillDir = path.join(cwd, 'bundled');
  await mkdir(root);
  await mkdir(bundledSkillDir);
  const config = { includeDefaultRoots: false, customSkillDirs: [root], bundledSkillDir };
  const put = async (directory, entry, name = entry) => {
    const target = path.join(directory, entry);
    const flat = entry.endsWith('.md');
    await mkdir(flat ? directory : target, { recursive: true });
    await writeFile(flat ? target : path.join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody.\n`);
    return target;
  };
  const manage = (action, entryPath) => manageSkill(cwd, { action, entryPath }, config);
  return { cwd, root, bundledSkillDir, config, put, manage };
}

test('management moves whole bundles, keeps disabled duplicates, and never exposes disabled skills as active', async t => {
  const f = await fixture(t);
  const entry = await f.put(f.root, 'one', 'shared');
  await writeFile(path.join(entry, 'script.sh'), 'script');
  await f.put(path.join(f.bundledSkillDir, '.disabled'), 'two', 'shared');
  const active = await discoverSkills(f.cwd, f.config);
  assert.deepEqual(active.skills.map(s => [s.source, s.disabled, s.canDelete]), [['custom', false, true], ['bundled', true, false]]);
  assert.equal(active.skills[0].entryPath, entry);
  assert.equal(active.skills[0].directory, entry);
  await f.put(path.join(f.root, '.disabled'), 'three', 'shared');
  const disabled = await f.manage('disable', entry);
  assert.equal(disabled.skills.length, 3);
  assert.ok(disabled.skills.every(s => s.disabled));
  const ctx = new Context();
  try {
    await ctx.plugin(SkillRegistry);
    await ctx.plugin(filesystem, { ...f.config, watch: false });
    assert.deepEqual((await ctx.skills.snapshot({ cwd: f.cwd })).skills, []);
  } finally { await ctx.fiber.dispose(); }
  const parked = path.join(f.root, '.disabled/one');
  assert.equal(await readFile(path.join(parked, 'script.sh'), 'utf8'), 'script');
  const enabled = await f.manage('enable', parked);
  assert.equal(enabled.skills.find(s => s.entryPath === entry).disabled, false);
  await f.manage('delete', entry);
  await assert.rejects(lstat(entry), { code: 'ENOENT' });
  await assert.rejects(f.manage('delete', path.join(f.bundledSkillDir, '.disabled/two')), /built.?in|bundled/i);
});

test('flat Markdown moves only the file and opens its containing scan directory', async t => {
  const f = await fixture(t);
  const entry = await f.put(f.root, 'flat.md', 'flat');
  await writeFile(path.join(f.root, 'keep.txt'), 'keep');
  const catalog = await f.manage('disable', entry);
  const parked = path.join(f.root, '.disabled/flat.md');
  assert.equal(catalog.skills[0].entryPath, parked);
  assert.equal(catalog.skills[0].directory, path.dirname(parked));
  assert.equal(catalog.skills[0].disabled, true);
  await f.manage('enable', parked);
  await f.manage('delete', entry);
  assert.equal(await readFile(path.join(f.root, 'keep.txt'), 'utf8'), 'keep');
});

test('symlink bundle management preserves lexical entry paths and never removes its target', async t => {
  const f = await fixture(t);
  const target = await f.put(f.cwd, 'resource');
  const link = path.join(f.root, 'linked');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const catalog = await discoverSkills(f.cwd, f.config);
  assert.equal(catalog.skills[0].path, path.join(target, 'SKILL.md'));
  assert.equal(catalog.skills[0].entryPath, link);
  assert.equal(catalog.skills[0].directory, link);
  const parked = path.join(f.root, '.disabled/linked');
  await f.manage('disable', link);
  assert.ok((await lstat(parked)).isSymbolicLink());
  await f.manage('enable', parked);
  await f.manage('delete', link);
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /resource/);
});

test('refuses collisions, unknown paths, invalid states, builtin deletion and escaped disabled roots', async t => {
  const f = await fixture(t);
  const entry = await f.put(f.root, 'one');
  const builtin = await f.put(f.bundledSkillDir, 'builtin');
  await mkdir(path.join(f.root, '.disabled'));
  await writeFile(path.join(f.root, '.disabled/one'), 'collision');
  await assert.rejects(f.manage('disable', entry), /exist|collision/i);
  await assert.rejects(f.manage('enable', entry), /disabled|state/i);
  await assert.rejects(f.manage('delete', builtin), /built.?in|bundled/i);
  for (const target of [f.root, path.join(entry, 'SKILL.md'), path.join(f.cwd, 'unknown'), path.join(f.root, '.disabled'), `${f.root}/one/../one`]) {
    await assert.rejects(f.manage('delete', target));
  }
  await assert.rejects(f.manage('unknown', entry));
  await rm(path.join(f.root, '.disabled'), { recursive: true });
  await symlink(f.cwd, path.join(f.root, '.disabled'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manage('disable', entry), /disabled.*symlink|symbolic|unsafe/i);
  assert.ok((await lstat(entry)).isDirectory());
});

test('concurrent same-entry mutations cannot overwrite, resurrect or delete the other operation target', async t => {
  const f = await fixture(t);
  const entry = await f.put(f.root, 'one');
  const results = await Promise.allSettled([f.manage('disable', entry), f.manage('delete', entry)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const names = await readdir(f.root);
  assert.ok(names.includes('.skill-management.lock'));
  assert.deepEqual(await readdir(path.join(f.root, '.skill-management.lock')), []);
  const catalog = await discoverSkills(f.cwd, f.config);
  if (catalog.skills.length) {
    assert.equal(catalog.skills[0].entryPath, path.join(f.root, '.disabled/one'));
    assert.equal(catalog.skills[0].disabled, true);
  }
});

test('discovery failure aborts mutations before touching a valid entry', async t => {
  const f = await fixture(t);
  const entry = await f.put(f.root, 'one');
  const loop = path.join(f.cwd, 'loop');
  await symlink(loop, loop, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manageSkill(f.cwd, { action: 'delete', entryPath: entry }, {
    ...f.config, customSkillDirs: [f.root, loop],
  }));
  assert.ok((await lstat(entry)).isDirectory());
});

test('builtin preparation preserves disabled state and refreshes links when resources move', async t => {
  const f = await fixture(t);
  const resources = path.join(f.cwd, 'resources-v1');
  const upgraded = path.join(f.cwd, 'resources-v2');
  const dataDir = path.join(f.cwd, 'data');
  await f.put(resources, 'builtin');
  await f.put(upgraded, 'builtin');
  const environment = await prepareBundledSkills({ resourceDir: resources, dataDir });
  const builtin = environment.DSH_BUNDLED_SKILL_DIR;
  const entry = path.join(builtin, 'builtin');
  assert.ok((await lstat(entry)).isSymbolicLink());
  const config = { ...f.config, bundledSkillDir: builtin };
  await manageSkill(f.cwd, { action: 'disable', entryPath: entry }, config);
  await prepareBundledSkills({ resourceDir: upgraded, dataDir });
  await assert.rejects(lstat(entry), { code: 'ENOENT' });
  const parked = path.join(builtin, '.disabled/builtin');
  assert.equal(await realpath(parked), path.join(upgraded, 'builtin'));
  assert.ok((await lstat(path.join(resources, 'builtin'))).isDirectory());
  const catalog = await manageSkill(f.cwd, { action: 'enable', entryPath: parked }, config);
  assert.equal(catalog.skills[0].disabled, false);
  await assert.rejects(manageSkill(f.cwd, { action: 'delete', entryPath: entry }, config), /built.?in|bundled/i);
});

test('CLI lists and mutates JSON using managed builtins and isolated assistant environment', async t => {
  const f = await fixture(t);
  const dataDir = path.join(f.cwd, 'data');
  const env = { ...process.env, PROJECT_MIND_DSH_SKILLS_DATA: dataDir, PROJECT_MIND_DSH_USER_DATA: path.join(f.cwd, 'assistant'), DSH_AGENTS_HOME: path.join(f.cwd, 'agents') };
  const cli = new URL('../scripts/skills.mjs', import.meta.url);
  const run = async args => JSON.parse((await promisify(execFile)(process.execPath, [fileURLToPath(cli), '--cwd', f.cwd, ...args], { env })).stdout);
  const catalog = await run([]);
  const builtin = catalog.skills.find(s => s.source === 'bundled');
  assert.equal(builtin.canDelete, false);
  assert.equal(builtin.disabled, false);
  assert.ok(builtin.entryPath.startsWith(path.join(dataDir, 'builtin')));
  const disabled = await run(['--action', 'disable', '--entry', builtin.entryPath]);
  assert.equal(disabled.skills.find(s => s.name === builtin.name).disabled, true);
  assert.equal((await run([])).skills.find(s => s.name === builtin.name).disabled, true);
});

test('a killed CLI process leaves a recoverable lock; live owners still reject other processes', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const entry = await f.put(f.root, 'one');
  const module = new URL('../scripts/skill-management.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withRootLock } from ${JSON.stringify(module)};
    await withRootLock(${JSON.stringify(f.root)}, async () => {
      process.send('locked');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.deepEqual(await once(child, 'message'), ['locked', undefined]);
  await assert.rejects(f.manage('delete', entry), /busy/i);
  assert.ok((await lstat(entry)).isDirectory());
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal((await readdir(path.join(f.root, '.skill-management.lock'))).length, 1);
  const catalog = await f.manage('disable', entry);
  assert.equal(catalog.skills[0].disabled, true);
  assert.deepEqual(await readdir(path.join(f.root, '.skill-management.lock')), []);
});

test('builtin replacement recovers interrupted junction updates in both states without overwriting directories', async t => {
  const f = await fixture(t);
  const resourceDir = path.join(f.cwd, 'v1');
  const nextResources = path.join(f.cwd, 'v2');
  const dataDir = path.join(f.cwd, 'managed');
  for (const resources of [resourceDir, nextResources]) {
    await f.put(resources, 'active');
    await f.put(resources, 'disabled');
  }
  const { DSH_BUNDLED_SKILL_DIR: root } = await prepareBundledSkills({ resourceDir, dataDir });
  await manageSkill(f.cwd, { action: 'disable', entryPath: path.join(root, 'disabled') }, { ...f.config, bundledSkillDir: root });
  // State left by termination between moving the old junction and installing
  // the new junction: the backup must preserve which side was disabled.
  const parked = path.join(root, '.disabled/disabled');
  await rename(parked, path.join(root, '.disabled/.builtin-previous-disabled'));
  await symlink(path.join(resourceDir, 'disabled'), path.join(root, '.disabled/.builtin-next-disabled'), process.platform === 'win32' ? 'junction' : 'dir');
  await prepareBundledSkills({ resourceDir: nextResources, dataDir });
  assert.equal(await realpath(parked), path.join(nextResources, 'disabled'));
  assert.equal(await realpath(path.join(root, 'active')), path.join(nextResources, 'active'));
  await assert.rejects(lstat(path.join(root, 'disabled')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(path.join(root, '.disabled'))).sort(), ['disabled']);
  await rm(path.join(root, 'active'));
  await mkdir(path.join(root, 'active'));
  await assert.rejects(prepareBundledSkills({ resourceDir: nextResources, dataDir }), /not a link/i);
  assert.ok((await lstat(path.join(root, 'active'))).isDirectory());
});

test('standalone CLI derives managed builtin data from assistant user data and OS home without native injection', async t => {
  const f = await fixture(t);
  const home = path.join(f.cwd, 'home');
  await mkdir(home);
  for (const override of [path.join(f.cwd, 'standalone-data'), undefined]) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_AGENTS_HOME: path.join(f.cwd, 'agents') };
    for (const key of ['PROJECT_MIND_DSH_SKILLS_DATA', 'PROJECT_MIND_DSH_USER_DATA', 'XDG_DATA_HOME', 'APPDATA', 'DSH_BUNDLED_SKILL_DIR']) delete env[key];
    if (override) env.PROJECT_MIND_DSH_USER_DATA = override;
    const args = [fileURLToPath(new URL('../scripts/skills.mjs', import.meta.url)), '--cwd', f.cwd];
    const run = async extra => JSON.parse((await promisify(execFile)(process.execPath, [...args, ...extra], { env })).stdout);
    const catalog = await run([]);
    const builtin = catalog.skills.find(s => s.source === 'bundled');
    const base = override ?? (process.platform === 'darwin'
      ? path.join(home, 'Library/Application Support/project-mind-dsh')
      : process.platform === 'win32' ? path.join(home, 'AppData/Roaming/project-mind-dsh') : path.join(home, '.local/share/project-mind-dsh'));
    assert.equal(path.dirname(builtin.entryPath), path.join(base, 'skills/builtin'));
    assert.ok((await lstat(builtin.entryPath)).isSymbolicLink());
    await run(['--action', 'disable', '--entry', builtin.entryPath]);
    assert.equal((await run([])).skills.find(s => s.name === builtin.name).disabled, true);
    await assert.rejects(promisify(execFile)(process.execPath, [...args, '--action', 'delete', '--entry', path.join(base, 'skills/builtin/.disabled', path.basename(builtin.entryPath))], { env }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /cannot be deleted/);
      assert.doesNotMatch(error.stderr, /\n\s+at |Node\.js|Error:/);
      return true;
    });
  }
});

test('nested custom roots retain the actual flat entry and builtin aliases cannot bypass deletion protection', async t => {
  const f = await fixture(t);
  const nested = path.join(f.root, 'nested');
  const flat = await f.put(nested, 'flat.md', 'flat');
  await f.put(f.bundledSkillDir, 'builtin');
  const alias = path.join(f.cwd, 'builtin-alias');
  await symlink(f.bundledSkillDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const config = { ...f.config, customSkillDirs: [f.root, nested, alias] };
  const catalog = await discoverSkills(f.cwd, config);
  assert.equal(catalog.skills.find(s => s.name === 'flat').entryPath, flat);
  assert.equal(catalog.skills.find(s => s.name === 'flat').directory, nested);
  const builtin = catalog.skills.find(s => s.name === 'builtin');
  assert.equal(builtin.source, 'custom');
  assert.equal(builtin.canDelete, false);
  await assert.rejects(manageSkill(f.cwd, { action: 'delete', entryPath: builtin.entryPath }, config), /cannot be deleted/);
});

test('directory links still resolve after disable and enable', async t => {
  const f = await fixture(t);
  const target = await f.put(f.cwd, 'relative-resource');
  const link = path.join(f.root, 'relative');
  await symlink(process.platform === 'win32' ? target : path.relative(f.root, target), link,
    process.platform === 'win32' ? 'junction' : 'dir');
  const disabled = await f.manage('disable', link);
  assert.equal(disabled.skills[0].disabled, true);
  assert.equal(disabled.skills[0].path, path.join(target, 'SKILL.md'));
  const parked = path.join(f.root, '.disabled/relative');
  await f.manage('enable', parked);
  await f.manage('delete', link);
  assert.ok((await lstat(target)).isDirectory());
});

test('relative flat file symlinks still resolve after disable and enable', async t => {
  const f = await fixture(t);
  const flatTarget = await f.put(f.cwd, 'resource.md', 'flat-link');
  const flatLink = path.join(f.root, 'link.md');
  try { await symlink(path.relative(f.root, flatTarget), flatLink, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows file symlinks require Developer Mode or the symlink privilege');
      return;
    }
    throw error;
  }
  assert.equal((await f.manage('disable', flatLink)).skills[0].path, flatTarget);
  await f.manage('enable', path.join(f.root, '.disabled/link.md'));
  await f.manage('delete', flatLink);
  assert.ok((await lstat(flatTarget)).isFile());
});

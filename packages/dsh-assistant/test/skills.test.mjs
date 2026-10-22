import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as filesystem from '@deepseek-ai/dsh-skill-filesystem';
import { discoverSkills, prepareBundledSkills } from '../scripts/skills.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mind-skills-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const dshHome = path.join(root, 'dsh');
  const agentsHome = path.join(root, 'agents');
  const bundledSkillDir = path.join(root, 'bundled');
  await mkdir(cwd, { recursive: true });
  const put = async (directory, name, description) => {
    const folder = path.join(directory, name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.\n`);
    return path.join(folder, 'SKILL.md');
  };
  return { cwd, dshHome, agentsHome, bundledSkillDir, put };
}

test('catalog uses DSH discovery and precedence across project, user and bundled skills', async t => {
  const f = await fixture(t);
  await f.put(f.bundledSkillDir, 'project-mind-cli', 'Use Mind CLI');
  await f.put(path.join(f.dshHome, 'skills'), 'same-name', 'User copy');
  const winning = await f.put(path.join(f.cwd, '.agents/skills'), 'same-name', 'Project copy');
  await f.put(path.join(f.agentsHome, 'skills'), 'user-only', 'User skill');
  const catalog = await discoverSkills(f.cwd, f);
  assert.equal(catalog.complete, true);
  assert.deepEqual(catalog.skills.map(s => s.name), ['project-mind-cli', 'same-name', 'user-only']);
  assert.equal(catalog.skills.find(s => s.name === 'same-name').path, winning);
  assert.equal(catalog.skills.find(s => s.name === 'same-name').source, 'project-agents');
  assert.equal(catalog.skills[0].source, 'bundled');
  assert.deepEqual(catalog.directories, [
    path.join(f.cwd, '.dsh/skills'),
    path.join(f.cwd, '.agents/skills'),
    path.join(f.dshHome, 'skills'),
    path.join(f.agentsHome, 'skills'),
    f.bundledSkillDir,
  ]);
});

test('catalog keeps shared, empty and symlink scan roots for directory and flat Markdown skills', async t => {
  const f = await fixture(t);
  const shared = path.join(f.cwd, 'shared');
  const empty = path.join(f.cwd, 'empty');
  const missing = path.join(f.cwd, 'missing');
  const linked = path.join(f.cwd, 'linked');
  const target = path.join(f.cwd, 'target');
  const first = await f.put(shared, 'first', 'First skill');
  await f.put(shared, 'second', 'Second skill');
  await mkdir(empty);
  await writeFile(path.join(shared, 'flat.md'), '---\nname: flat\ndescription: Flat Markdown\n---\nFlat body.\n');
  const external = await f.put(target, 'external', 'Linked skill');
  await symlink(target, linked, 'dir');
  await symlink(path.dirname(external), path.join(shared, 'linked-skill'), 'dir');
  const catalog = await discoverSkills(f.cwd, {
    ...f, includeDefaultRoots: false, customSkillDirs: [shared, empty, missing, linked],
  });
  assert.equal(catalog.complete, true);
  assert.deepEqual(catalog.skills.map(s => s.name), ['external', 'first', 'flat', 'second']);
  assert.equal(catalog.skills.find(s => s.name === 'first').path, first);
  assert.equal(catalog.skills.find(s => s.name === 'external').path, external);
  assert.ok(catalog.skills.every(s => s.source === 'custom'));
  assert.deepEqual(catalog.directories, [shared, empty, missing, linked, f.bundledSkillDir]);
});

test('nested cwd scans the nearest git root, including a worktree .git file', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, '.git'));
  const inner = path.join(f.cwd, 'inner');
  const nested = path.join(inner, 'src/deep');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(inner, '.git'), 'gitdir: /unused/worktree\n');
  await f.put(path.join(f.cwd, '.dsh/skills'), 'outer-only', 'Outer project');
  const winning = await f.put(path.join(inner, '.dsh/skills'), 'same-name', 'Nearest project');
  await f.put(path.join(inner, '.agents/skills'), 'same-name', 'Lower project priority');
  await f.put(path.join(nested, '.dsh/skills'), 'cwd-only', 'Not the git root');
  const catalog = await discoverSkills(nested, f);
  assert.deepEqual(catalog.skills.map(s => s.name), ['same-name']);
  assert.equal(catalog.skills[0].path, winning);
  assert.equal(catalog.skills[0].source, 'project-dsh');
  assert.deepEqual(catalog.directories, [
    path.join(inner, '.dsh/skills'), path.join(inner, '.agents/skills'),
    path.join(f.dshHome, 'skills'), path.join(f.agentsHome, 'skills'), f.bundledSkillDir,
  ]);
});

test('custom roots resolve against process cwd and deduplicate without changing provider priority', async t => {
  const f = await fixture(t);
  const custom = path.join(f.cwd, 'custom');
  await f.put(path.join(f.cwd, '.agents/skills'), 'same-name', 'Project wins');
  await f.put(custom, 'same-name', 'Custom copy');
  await f.put(f.bundledSkillDir, 'same-name', 'Bundled copy');
  const config = {
    ...f,
    customSkillDirs: [path.relative(process.cwd(), custom), path.join(custom, '.'), f.bundledSkillDir],
  };
  const defaults = await discoverSkills(f.cwd, config);
  assert.equal(defaults.skills[0].source, 'project-agents');
  assert.deepEqual(defaults.directories, [
    path.join(f.cwd, '.dsh/skills'), path.join(f.cwd, '.agents/skills'),
    custom, f.bundledSkillDir, path.join(f.dshHome, 'skills'), path.join(f.agentsHome, 'skills'),
  ]);
  const explicit = await discoverSkills(f.cwd, { ...config, includeDefaultRoots: false });
  assert.equal(explicit.skills[0].source, 'custom');
  assert.equal(explicit.skills[0].description, 'Custom copy');
  assert.deepEqual(explicit.directories, [custom, f.bundledSkillDir]);
});

test('home roots follow config, environment and OS defaults with DSH tilde expansion', async t => {
  const f = await fixture(t);
  const home = path.join(f.cwd, 'home');
  const envDsh = path.join(home, 'env-dsh');
  const envAgents = path.join(home, 'env-agents');
  await f.put(path.join(home, '.dsh/skills'), 'home-dsh', 'Default DSH home');
  await f.put(path.join(home, '.agents/skills'), 'home-agents', 'Default agents home');
  await f.put(path.join(envDsh, 'skills'), 'env-dsh', 'Environment DSH home');
  await f.put(path.join(envAgents, 'skills'), 'env-agents', 'Environment agents home');
  await f.put(path.join(home, 'configured/skills'), 'configured', 'Configured DSH home');
  const run = async (config, dshHome = '', agentsHome) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome };
    delete env.DSH_AGENTS_HOME;
    if (agentsHome !== undefined) env.DSH_AGENTS_HOME = agentsHome;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { discoverSkills } from ${JSON.stringify(new URL('../scripts/skills.mjs', import.meta.url).href)};
      console.log(JSON.stringify(await discoverSkills(${JSON.stringify(f.cwd)}, ${JSON.stringify({ bundledSkillDir: f.bundledSkillDir, ...config })})));
    `], { env });
    return JSON.parse(stdout);
  };
  const fallback = await run({}, '   ');
  assert.deepEqual(fallback.skills.map(s => s.name), ['home-agents', 'home-dsh']);
  assert.deepEqual(fallback.directories, [
    path.join(f.cwd, '.dsh/skills'), path.join(f.cwd, '.agents/skills'),
    path.join(home, '.dsh/skills'), path.join(home, '.agents/skills'), f.bundledSkillDir,
  ]);
  const environment = await run({}, '~/env-dsh', envAgents);
  assert.deepEqual(environment.skills.map(s => s.name), ['env-agents', 'env-dsh']);
  assert.deepEqual(environment.directories.slice(2), [path.join(envDsh, 'skills'), path.join(envAgents, 'skills'), f.bundledSkillDir]);
  const configured = await run({ dshHome: '~/configured', agentsHome: f.agentsHome }, envDsh, envAgents);
  assert.deepEqual(configured.skills.map(s => s.name), ['configured']);
  assert.deepEqual(configured.directories.slice(2), [path.join(home, 'configured/skills'), path.join(f.agentsHome, 'skills'), f.bundledSkillDir]);
});

test('the same bundled skill configuration is loadable by the real DSH registry used by the assistant', async t => {
  const f = await fixture(t);
  const environment = await prepareBundledSkills({ dataDir: path.join(f.cwd, 'skill-data') });
  const ctx = new Context();
  try {
    await ctx.plugin(SkillRegistry);
    await ctx.plugin(filesystem, { bundledSkillDir: environment.DSH_BUNDLED_SKILL_DIR, dshHome: f.dshHome, agentsHome: f.agentsHome, watch: false });
    const catalog = await ctx.skills.snapshot({ cwd: f.cwd });
    assert.equal(catalog.complete, true);
    assert.ok(!catalog.skills.some(skill => skill.name === 'project-mind-memory'), 'memory rules come from the editable Workspace snapshot, not a second packaged Skill');
    const skill = await ctx.skills.get('project-mind-cli', { cwd: f.cwd });
    assert.ok(skill, 'built-in CLI skill must be visible and loadable by an Agent');
    assert.match(skill.content, /mind capabilities --json/);
    assert.match(skill.path, /skills[/\\]project-mind-cli[/\\]SKILL\.md$/);
  } finally { await ctx.fiber.dispose(); }
});

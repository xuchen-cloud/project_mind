import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as filesystem from '@deepseek-ai/dsh-skill-filesystem';
import { discoverSkills, bundledSkillEnvironment } from '../scripts/skills.mjs';

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
  assert.ok(catalog.directories.includes(f.bundledSkillDir));
  assert.ok(catalog.directories.includes(path.dirname(winning)));
});

test('the same bundled skill configuration is loadable by the real DSH registry used by the assistant', async t => {
  const f = await fixture(t);
  const environment = bundledSkillEnvironment();
  const ctx = new Context();
  try {
    await ctx.plugin(SkillRegistry);
    await ctx.plugin(filesystem, { bundledSkillDir: environment.DSH_BUNDLED_SKILL_DIR, dshHome: f.dshHome, agentsHome: f.agentsHome, watch: false });
    const catalog = await ctx.skills.snapshot({ cwd: f.cwd });
    assert.equal(catalog.complete, true);
    const skill = await ctx.skills.get('project-mind-cli', { cwd: f.cwd });
    assert.ok(skill, 'built-in CLI skill must be visible and loadable by an Agent');
    assert.match(skill.content, /mind capabilities --json/);
    assert.match(skill.path, /skills[/\\]project-mind-cli[/\\]SKILL\.md$/);
  } finally { await ctx.fiber.dispose(); }
});

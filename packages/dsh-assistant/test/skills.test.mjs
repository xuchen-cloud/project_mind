import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.dirname(external), path.join(shared, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir');
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
    const skill = await ctx.skills.get('project-mind-cli', { cwd: f.cwd });
    assert.ok(skill, 'built-in CLI skill must be visible and loadable by an Agent');
    assert.match(skill.content, /mind capabilities --json/);
    const office=await ctx.skills.get('genoffice-authoring',{cwd:f.cwd});
    assert.ok(office,'the adapted authoring skill must be available through the real registry');
    const {isSkillResourceRead}=await import('../scripts/skills.mjs');
    assert.equal(await isSkillResourceRead(ctx.skills,path.join(path.dirname(office.path),'references/upstream-skill.md'),{cwd:f.cwd}),true);
    assert.match(skill.path, /skills[/\\]project-mind-cli[/\\]SKILL\.md$/);
  } finally { await ctx.fiber.dispose(); }
});

test('resource reads require a current registry skill and stay within its canonical bundle', async t => {
  const { isSkillResourceRead } = await import('../scripts/skills.mjs');
  const f = await fixture(t);
  const skillFile = await f.put(f.bundledSkillDir, 'reader', 'Read resources');
  const base = path.dirname(skillFile);
  const reference = path.join(base, 'references', 'guide.md');
  await mkdir(path.dirname(reference));
  await writeFile(reference, 'resource');
  const outside = path.join(f.cwd, 'secret.md');
  await writeFile(outside, 'business');
  await symlink(outside, path.join(base, 'escape.md'));
  const ctx = new Context();
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(filesystem, { includeDefaultRoots: false, bundledSkillDir: f.bundledSkillDir, watch: false });
  t.after(() => ctx.fiber.dispose());
  const options = { cwd: f.cwd };
  assert.equal(await isSkillResourceRead(ctx.skills, reference, options), true);
  assert.equal(await isSkillResourceRead(ctx.skills, outside, options), false);
  assert.equal(await isSkillResourceRead(ctx.skills, path.join(base, 'escape.md'), options), false);
  assert.equal(await isSkillResourceRead(ctx.skills, path.join(base, '..', 'secret.md'), options), false);
  await mkdir(path.join(f.bundledSkillDir, '.disabled'));
  await rename(base, path.join(f.bundledSkillDir, '.disabled', 'reader'));
  assert.equal(await isSkillResourceRead(ctx.skills, path.join(f.bundledSkillDir, '.disabled', 'reader', 'references', 'guide.md'), options), false);
  assert.equal(await isSkillResourceRead(ctx.skills, reference, options), false, 'parking a skill revokes its resources');
  await rename(path.join(f.bundledSkillDir, '.disabled', 'reader'), base);
  await rm(skillFile);
  assert.equal(await isSkillResourceRead(ctx.skills, reference, options), false, 'cached discovery cannot authorize a removed skill');
});

test('bounded catalog reader reuses discovery but detects external skill edits and forced refresh', async t => {
  const { createSkillCatalogReader } = await import('../scripts/skills.mjs');
  assert.equal(typeof createSkillCatalogReader, 'function');
  const f = await fixture(t);
  const file = await f.put(f.bundledSkillDir, 'cached', 'Initial');
  let discoveries = 0;
  const reader = createSkillCatalogReader({ maxEntries: 2, maxBytes: 100000, discover: async (...args) => { discoveries++; return discoverSkills(...args); } });
  assert.equal((await reader(f.cwd, f)).skills[0].description, 'Initial');
  await reader(f.cwd, f); assert.equal(discoveries, 1);
  await writeFile(file, '---\nname: cached\ndescription: Changed externally\n---\nInstructions\n');
  assert.equal((await reader(f.cwd, f)).skills[0].description, 'Changed externally');
  assert.equal(discoveries, 2);
  await reader(f.cwd, f, { refresh: true }); assert.equal(discoveries, 3);
  await rm(file); assert.equal((await reader(f.cwd, f)).skills.length, 0);
});

test('resource reads resolve the requested target once across unrelated skill candidates', async t => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { isSkillResourceRead } = await import('../scripts/skills.mjs');
  const f = await fixture(t);
  const target = path.join(f.cwd, 'business.txt'); await writeFile(target, 'business');
  const skills = [];
  for (let index = 0; index < 20; index++) {
    const base = path.dirname(await f.put(f.bundledSkillDir, `s${index}`, 'Example'));
    skills.push({ provider: 'filesystem', resourceBase: { kind: 'directory', path: base } });
  }
  let targets = 0;
  const original = fs.realpath;
  fs.realpath = async value => { if (value === target) targets++; return original(value); };
  syncBuiltinESMExports();
  try { assert.equal(await isSkillResourceRead({ snapshot: async () => ({ complete: true, skills }) }, target, { cwd: f.cwd }), false); }
  finally { fs.realpath = original; syncBuiltinESMExports(); }
  assert.equal(targets, 1);
});


test('catalog cache observes managed disabled content and enforces entry and byte budgets', async t => {
  const { createSkillCatalogReader, manageSkill } = await import('../scripts/skills.mjs');
  const f = await fixture(t);
  const file = await f.put(path.join(f.cwd, '.dsh/skills'), 'managed', 'Active');
  let discoveries = 0;
  const discover = async (...args) => {discoveries++; return discoverSkills(...args);};
  const reader = createSkillCatalogReader({maxEntries: 1, discover});
  await reader(f.cwd, f); await reader(f.cwd, f); assert.equal(discoveries, 1);
  await manageSkill(f.cwd, {action: 'disable', entryPath: path.dirname(file)}, f);
  assert.equal((await reader(f.cwd, f)).skills[0].disabled, true);
  const disabled = path.join(path.dirname(path.dirname(file)), '.disabled/managed');
  await writeFile(path.join(disabled, 'SKILL.md'), '---\nname: managed\ndescription: Parked edit\n---\nInstructions');
  assert.equal((await reader(f.cwd, f)).skills[0].description, 'Parked edit');
  await manageSkill(f.cwd, {action:'enable',entryPath:disabled}, f);
  assert.equal((await reader(f.cwd, f)).skills[0].disabled, false);
  const other = path.join(f.cwd, 'other'); await mkdir(other);
  await reader(other,f); const before = discoveries; await reader(f.cwd,f); assert.equal(discoveries,before+1);
  const tiny = createSkillCatalogReader({maxBytes:1,discover});
  const start=discoveries; await tiny(f.cwd,f); await tiny(f.cwd,f); assert.equal(discoveries,start+2);
});

test('actual serve child exits when its parent exits and closes the input pipe', {timeout:10000}, async t => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('../scripts/skills.mjs', import.meta.url));
  const parent = `const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const child=spawn(process.execPath,[process.argv[1],'--serve'],{stdio:['pipe','pipe','inherit']});
child.once('error',error=>{console.error(error);process.exitCode=1;});
child.once('exit',(code,signal)=>{console.error('Skills child exited before ready:',code,signal);process.exitCode=1;});
createInterface({input:child.stdout}).once('line',line=>{
  const response=JSON.parse(line);
  if(response.ok!==true) throw new Error(response.error||'Skills catalog failed');
  process.stdout.write(child.pid+'\\n',()=>process.exit(0));
});
child.stdin.write(JSON.stringify({cwd:process.argv[2],userData:process.argv[3]})+'\\n');`;
  const {stdout} = await promisify(execFile)(process.execPath, ['--eval',parent,script,f.cwd,f.dshHome], {
    env:{...process.env,PROJECT_MIND_DSH_USER_DATA:f.dshHome,DSH_AGENTS_HOME:f.agentsHome,DSH_BUNDLED_SKILL_DIR:f.bundledSkillDir}, timeout:8000,
  });
  const pid = Number(stdout.trim()); assert.ok(Number.isSafeInteger(pid) && pid>0);
  let alive=true;
  t.after(() => {
    if (!alive) return;
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  for(let index=0;index<200;index++) {
    try {process.kill(pid,0);} catch(error) {if(error.code!=='ESRCH') throw error;alive=false;break;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(alive,false,'the real --serve process must not survive its parent');
});

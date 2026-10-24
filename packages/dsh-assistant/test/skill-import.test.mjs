import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { importSkill } from '../scripts/skills.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { dshHome: path.join(root, 'dsh'), agentsHome: path.join(root, 'agents'), bundledSkillDir: undefined };
  const archive = path.join(root, 'skill.zip');
  const pack = async entries => { await writeFile(archive, zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, typeof value === 'string' ? strToU8(value) : value])))); return archive; };
  return { root, config, archive, pack, installed: path.join(config.dshHome, 'skills') };
}
const skill = '---\nname: research-notes\ndescription: Read research notes\n---\nUse references/example.txt.\n';

test('imports a ZIP directory using native discovery, preserves resources and never replaces an existing skill', async t => {
  const f = await fixture(t);
  await f.pack({ 'research-notes/SKILL.md': skill, 'research-notes/references/example.txt': 'Evidence', 'research-notes/scripts/helper.sh': 'echo example', '__MACOSX/._research-notes': 'metadata', 'research-notes/.DS_Store': 'metadata' });
  const catalog = await importSkill(f.root, f.archive, f.config);
  const imported = catalog.skills.find(s => s.name === 'research-notes');
  assert.equal(imported.disabled, false);
  assert.equal(await readFile(path.join(f.installed, 'research-notes/references/example.txt'), 'utf8'), 'Evidence');
  await assert.rejects(importSkill(f.root, f.archive, f.config), /同名|已存在/);
  assert.equal(await readFile(path.join(f.installed, 'research-notes/SKILL.md'), 'utf8'), skill);
  assert.deepEqual((await readdir(f.installed)).filter(name => name.startsWith('.skill-import-')), []);
});

test('accepts root SKILL.md and rejects malformed packages without leaving partial installs', async t => {
  const f = await fixture(t);
  for (const entries of [
    { '../escaped.txt': 'bad', 'SKILL.md': skill },
    { 'C:/outside.txt': 'bad', 'SKILL.md': skill },
    { 'SKILL.md': skill, 'skill.md': skill },
    { 'a/SKILL.md': skill, 'b/SKILL.md': skill },
    { 'SKILL.md': 'Missing frontmatter' },
    { 'SKILL.md': skill, 'con.txt': 'bad' },
  ]) {
    await f.pack(entries);
    await assert.rejects(importSkill(f.root, f.archive, f.config));
  }
  await f.pack({ 'SKILL.md': skill });
  assert.equal((await importSkill(f.root, f.archive, f.config)).skills[0].name, 'research-notes');
});

test('rejects excessive expanded contents before extraction', async t => {
  const f = await fixture(t);
  await f.pack({ 'SKILL.md': skill, 'big.txt': new Uint8Array(51 * 1024 * 1024) });
  await assert.rejects(importSkill(f.root, f.archive, f.config), /解压后 50 MB/);
});

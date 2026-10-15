import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as filesystem from '@deepseek-ai/dsh-skill-filesystem';
import { assistantEnvironment } from './isolation.mjs';

const bundledSkillDir = fileURLToPath(new URL('../skills', import.meta.url));

// Shared by the assistant composition and the model-free settings catalog.
export function bundledSkillEnvironment() {
  return { DSH_BUNDLED_SKILL_DIR: bundledSkillDir };
}

export async function discoverSkills(cwd, config = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(SkillRegistry);
    await ctx.plugin(filesystem, { bundledSkillDir, ...config, watch: false });
    const snapshot = await ctx.skills.snapshot({ cwd });
    const skills = snapshot.skills.map(skill => ({
      name: skill.name, description: skill.description,
      path: skill.path ?? null, source: skill.source,
    }));
    const directories = [...new Set([
      config.bundledSkillDir ?? bundledSkillDir,
      ...skills.flatMap(skill => skill.path === null ? [] : [path.dirname(skill.path)]),
    ])];
    return { skills, directories, complete: snapshot.complete };
  } finally { await ctx.fiber.dispose(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--cwd' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: skills.mjs --cwd ABSOLUTE_PATH');
  }
  Object.assign(process.env, assistantEnvironment(), bundledSkillEnvironment());
  process.stdout.write(`${JSON.stringify(await discoverSkills(args[1]))}\n`);
}

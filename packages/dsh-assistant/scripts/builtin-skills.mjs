import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths';
import { assistantDataPath } from './isolation.mjs';
import { checkDisabledRoot, optionalLstat, validEntryName, withRootLock } from './skill-management.mjs';

export const resourceSkillDir = fileURLToPath(new URL('../skills', import.meta.url));

function skillsDataPath() {
  const data = process.env.PROJECT_MIND_DSH_SKILLS_DATA ?? path.join(assistantDataPath(), 'skills');
  if (!path.isAbsolute(data)) throw new Error('PROJECT_MIND_DSH_SKILLS_DATA must be an absolute path');
  return data;
}

export function bundledSkillEnvironment() {
  return { DSH_BUNDLED_SKILL_DIR: path.join(skillsDataPath(), 'builtin') };
}

async function checkedLink(location) {
  const info = await optionalLstat(location);
  if (info && !info.isSymbolicLink()) throw new Error(`Managed builtin entry is not a link: ${location}`);
  return info;
}

// Windows cannot rename over an existing directory junction. Keep the old link
// in a state-specific backup until the new one has been installed; preparation
// can finish an interrupted replacement without re-enabling a disabled skill.
async function updateLink(location, target, name) {
  const parent = path.dirname(location);
  const backup = path.join(parent, `.builtin-previous-${name}`);
  const next = path.join(parent, `.builtin-next-${name}`);
  const existing = await checkedLink(location);
  const previous = await checkedLink(backup);
  const staged = await checkedLink(next);
  if (existing && path.resolve(parent, await readlink(location)) === target) {
    if (previous) await unlink(backup);
    if (staged) await unlink(next);
    return;
  }
  if (staged) await unlink(next);
  await symlink(target, next, process.platform === 'win32' ? 'junction' : 'dir');
  if (existing) {
    if (previous) await unlink(backup);
    await rename(location, backup);
  }
  await rename(next, location);
  if (existing || previous) await unlink(backup);
}

export async function prepareBundledSkills({ resourceDir = resourceSkillDir, dataDir = skillsDataPath() } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('PROJECT_MIND_DSH_SKILLS_DATA must be an absolute path');
  const root = path.join(dataDir, 'builtin');
  const relative = path.relative(await canonicalizeWatchPath(resourceDir), await canonicalizeWatchPath(root));
  if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error('Managed builtin directory must be outside packaged resources');
  }
  await mkdir(root, { recursive: true });
  if ((await optionalLstat(root)).isSymbolicLink()) throw new Error('Managed builtin root must not be a symlink');
  await withRootLock(root, async () => {
    const disabled = await checkDisabledRoot(root);
    for (const entry of await readdir(resourceDir, { withFileTypes: true })) {
      if (!validEntryName(entry.name) || !entry.isDirectory()) continue;
      const target = path.resolve(resourceDir, entry.name);
      if (!await optionalLstat(path.join(target, 'SKILL.md'))) continue;
      const activePath = path.join(root, entry.name);
      const disabledPath = path.join(disabled, entry.name);
      const active = await checkedLink(activePath);
      const parked = await checkedLink(disabledPath);
      const activeBackup = await checkedLink(path.join(root, `.builtin-previous-${entry.name}`));
      const disabledBackup = await checkedLink(path.join(disabled, `.builtin-previous-${entry.name}`));
      if ((active || activeBackup) && (parked || disabledBackup)) {
        throw new Error(`Builtin exists in both active and disabled locations: ${entry.name}`);
      }
      const location = parked || disabledBackup ? disabledPath : activePath;
      await updateLink(location, target, entry.name);
    }
  });
  return { DSH_BUNDLED_SKILL_DIR: root };
}

import path from 'node:path';
import { importSkillArchive } from './skill-import.mjs';
import os from 'node:os';
import { access, lstat, realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as filesystem from '@deepseek-ai/dsh-skill-filesystem';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { assistantEnvironment } from './isolation.mjs';
import { bundledSkillEnvironment, prepareBundledSkills, resourceSkillDir } from './builtin-skills.mjs';
import { checkDisabledRoot, mutateSkillEntry, optionalLstat, validEntryName, withRootLock } from './skill-management.mjs';

export { bundledSkillEnvironment, prepareBundledSkills };

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    && !relative.split(path.sep).includes('.disabled');
}

// Use the executing agent's registry view, including provider precedence and
// scope. get() reloads the original locator even when discovery was cached,
// so removing or parking a managed builtin link revokes its resources too.
export async function isSkillResourceRead(registry, filePath, options) {
  if (!registry) return false;
  const requested = path.resolve(options.cwd, filePath);
  const snapshot = await registry.snapshot(options);
  if (!snapshot.complete) return false;
  let canonicalTarget;
  try { canonicalTarget = await realpath(requested); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  for (const summary of snapshot.skills) {
    if (summary.provider !== 'filesystem' || summary.resourceBase?.kind !== 'directory') continue;
    const base = summary.resourceBase.path;
    let canonicalBase;
    try {
      canonicalBase = await realpath(base);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw error;
    }
    if ((!within(base, requested) && !within(canonicalBase, requested)) || !within(canonicalBase, canonicalTarget)) continue;
    const skill = await registry.get(summary.name, options);
    if (skill?.provider === summary.provider && skill.resourceBase?.kind === 'directory'
      && skill.resourceBase.path === base && await realpath(base) === canonicalBase
      && await realpath(requested) === canonicalTarget) return true;
  }
  return false;
}

// Match the installed filesystem provider's roots/findProjectRoot rules. Keep
// scan paths lexical: winners use realpath and omit empty or shadowed roots.
async function scanRoots(cwd, config) {
  const roots = [];
  if (config.includeDefaultRoots && cwd !== undefined) {
    const start = path.resolve(cwd);
    let projectRoot = start;
    while (true) {
      try {
        await access(path.join(projectRoot, '.git'));
        break;
      } catch {
        const parent = path.dirname(projectRoot);
        if (parent === projectRoot) {
          projectRoot = start;
          break;
        }
        projectRoot = parent;
      }
    }
    roots.push({ path: path.join(projectRoot, '.dsh/skills'), source: 'project-dsh' }, { path: path.join(projectRoot, '.agents/skills'), source: 'project-agents' });
  }
  roots.push(...config.customSkillDirs.map(root => ({ path: root, source: 'custom' })));
  if (config.includeDefaultRoots) {
    roots.push({ path: path.join(config.dshHome, 'skills'), source: 'user-dsh' }, { path: path.join(config.agentsHome, 'skills'), source: 'user-agents' });
  }
  if (config.bundledSkillDir !== undefined) roots.push({ path: config.bundledSkillDir, source: 'bundled' });
  return roots;
}

function resolveConfig(config) {
  const providerConfig = { bundledSkillDir: bundledSkillEnvironment().DSH_BUNDLED_SKILL_DIR, ...config, watch: false };
  providerConfig.includeDefaultRoots ??= true;
  providerConfig.dshHome = resolveDshHome(providerConfig.dshHome);
  providerConfig.agentsHome = path.resolve(providerConfig.agentsHome ?? process.env.DSH_AGENTS_HOME ?? path.join(os.homedir(), '.agents'));
  providerConfig.customSkillDirs = (providerConfig.customSkillDirs ?? []).map(root => path.resolve(root));
  const bundled = providerConfig.bundledSkillDir ?? (providerConfig.includeDefaultRoots ? process.env.DSH_BUNDLED_SKILL_DIR : undefined);
  providerConfig.bundledSkillDir = bundled === undefined ? undefined : path.resolve(bundled);
  return providerConfig;
}

// Use the public provider's lexical locators, while leaving winner selection to
// the real registry. Disabled candidates deliberately bypass name merging.
async function collect(cwd, config) {
  const ctx = new Context();
  let provider;
  let candidates = [];
  try {
    await ctx.plugin(SkillRegistry);
    ctx.skills.registerProvider(control => {
      provider = new filesystem.FileSystemSkillProvider(ctx, control, config);
      return {
        name: provider.name,
        async list(options) {
          const result = await provider.list(options);
          candidates = Array.isArray(result) ? result : result.candidates;
          return result;
        },
        get: (candidate, options) => provider.get(candidate, options),
      };
    });
    const snapshot = await ctx.skills.snapshot({ cwd });
    return { snapshot, candidates };
  } finally {
    try { await provider?.dispose(); }
    finally { await ctx.fiber.dispose(); }
  }
}

function describe(candidate, root, disabled, protectedRoot) {
  const relative = path.relative(root.path, candidate.locator.path).split(path.sep);
  const flat = relative.length === 1;
  const entryPath = flat ? candidate.locator.path : path.dirname(candidate.locator.path);
  return {
    name: candidate.name, description: candidate.description,
    path: candidate.path ?? null, source: root.source,
    disabled, entryPath, directory: flat ? root.path : entryPath,
    canDelete: root.source !== 'bundled' && !protectedRoot,
  };
}

async function canonicalIfPresent(root) {
  if (!root || !await optionalLstat(root)) return undefined;
  return await realpath(root);
}

export async function discoverSkills(cwd, config = {}) {
  const providerConfig = resolveConfig(config);
  const roots = await scanRoots(cwd, providerConfig);
  for (const root of roots) await checkDisabledRoot(root.path);
  const { snapshot, candidates } = await collect(cwd, providerConfig);
  const protectedPath = await canonicalIfPresent(providerConfig.bundledSkillDir);
  const protectedRoots = new Set();
  for (const root of roots) {
    if (protectedPath && await canonicalIfPresent(root.path) === protectedPath) protectedRoots.add(root.path);
  }
  const skills = snapshot.skills.map(skill => {
    const candidate = candidates.find(c => c.name === skill.name && c.source === skill.source && c.path === skill.path);
    const root = roots.find(r => r.source === candidate.source && (
      path.dirname(candidate.locator.path) === r.path || path.basename(candidate.locator.path) === 'SKILL.md' && path.dirname(path.dirname(candidate.locator.path)) === r.path
    ));
    return describe(candidate, root, false, protectedRoots.has(root.path));
  });
  const seen = new Set();
  let complete = snapshot.complete;
  for (const root of roots) {
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    const disabledRoot = { ...root, path: path.join(root.path, '.disabled') };
    if (!await optionalLstat(disabledRoot.path)) continue;
    const disabled = await collect(cwd, {
      ...providerConfig, includeDefaultRoots: false, customSkillDirs: [disabledRoot.path], bundledSkillDir: undefined,
    });
    complete &&= disabled.snapshot.complete;
    for (const candidate of disabled.candidates) {
      if (root.source === 'user-dsh' && path.basename(candidate.locator.directory) === '.system') continue;
      skills.push(describe(candidate, disabledRoot, true, protectedRoots.has(root.path)));
    }
  }
  return { skills, directories: [...new Set(roots.map(root => root.path))], complete };
}

export async function manageSkill(cwd, { action, entryPath }, config = {}) {
  if (!['enable', 'disable', 'delete'].includes(action)) throw new Error('Invalid skill management action');
  if (typeof entryPath !== 'string' || !path.isAbsolute(entryPath) || path.resolve(entryPath) !== entryPath || !validEntryName(path.basename(entryPath))) {
    throw new Error('Invalid absolute skill entry path');
  }
  const providerConfig = resolveConfig(config);
  const roots = await scanRoots(cwd, providerConfig);
  const parent = path.dirname(entryPath);
  const root = roots.find(root => parent === root.path || parent === path.join(root.path, '.disabled'));
  if (!root) throw new Error('Skill entry is outside scan roots');
  return await withRootLock(root.path, async canonicalRoot => {
    await checkDisabledRoot(root.path);
    const original = await lstat(entryPath);
    const catalog = await discoverSkills(cwd, config);
    if (!catalog.complete) throw new Error('Cannot manage skills after incomplete discovery');
    const skill = catalog.skills.find(skill => skill.entryPath === entryPath);
    if (!skill) throw new Error('Skill entry is not in the fresh catalog');
    if (action === 'delete' && !skill.canDelete) throw new Error('Bundled built-in skills cannot be deleted');
    if (action === 'enable' && !skill.disabled || action === 'disable' && skill.disabled) throw new Error('Skill is in the wrong disabled state');
    if (canonicalRoot === await canonicalIfPresent(resourceSkillDir)) throw new Error('Prepare managed builtin skills before changing their state');
    if (await realpath(root.path) !== canonicalRoot) throw new Error('Skill scan root changed during management');
    await mutateSkillEntry(root.path, skill, action, original);
    return await discoverSkills(cwd, config);
  });
}

export async function importSkill(cwd, archive, config = {}) {
  const providerConfig = resolveConfig(config);
  await importSkillArchive(archive, path.join(providerConfig.dshHome, 'skills'), async staging => {
    const checked = await collect(cwd, { ...providerConfig, includeDefaultRoots: false, bundledSkillDir: undefined, customSkillDirs: [staging] });
    if (!checked.snapshot.complete || checked.snapshot.skills.length !== 1) throw new Error('SKILL.md 格式无效：需要有效的 name、description 和 YAML 头部');
    const name = checked.snapshot.skills[0].name;
    const current = await discoverSkills(cwd, config);
    if (!current.complete) throw new Error('Skills 发现未完成，请重试');
    if (current.skills.some(skill => skill.name.toLowerCase() === name.toLowerCase())) throw new Error('同名 Skill 已存在：' + name);
    return name;
  });
  return discoverSkills(cwd, config);
}

// Mirror the pinned provider's flat .md / child SKILL.md discovery, including
// parked entries and symlink targets. Metadata is checked on every read; this
// cache never authorizes a management mutation or hides external edits.
async function catalogRevision(cwd, config) {
  const digest = createHash('sha256');
  const record = async target => {
    try {
      const link = await lstat(target, { bigint: true });
      const info = await stat(target, { bigint: true });
      digest.update(JSON.stringify([target, String(link.ino), String(link.ctimeNs), String(info.dev),
        String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]));
      return info;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      digest.update(JSON.stringify([target, 'absent']));
    }
  };
  for (const root of await scanRoots(cwd, config)) {
    for (const directory of [root.path, path.join(root.path, '.disabled')]) {
      if (!(await record(directory))?.isDirectory()) continue;
      for (const entry of (await readdir(directory)).sort()) {
        if (!validEntryName(entry)) continue;
        const candidate = path.join(directory, entry);
        const info = await record(candidate);
        if (info?.isDirectory()) await record(path.join(candidate, 'SKILL.md'));
      }
    }
  }
  return digest.digest('hex');
}

export function createSkillCatalogReader({ maxEntries = 8, maxBytes = 8 * 1024 * 1024,
  discover = discoverSkills, prepare } = {}) {
  const cache = new Map();
  let bytes = 0;
  return async (cwd, config = {}, { refresh = false } = {}) => {
    const resolved = resolveConfig(config);
    const key = JSON.stringify([cwd, resolved]);
    let revision = await catalogRevision(cwd, resolved);
    const entry = cache.get(key);
    if (!refresh && entry?.revision === revision) {
      cache.delete(key); cache.set(key, entry);
      return structuredClone(entry.value);
    }
    if (entry) { cache.delete(key); bytes -= entry.bytes; }
    if (prepare) {
      await prepare();
      revision = await catalogRevision(cwd, resolved);
    }
    const value = await discover(cwd, resolved);
    const after = await catalogRevision(cwd, resolved);
    const cost = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key) + Buffer.byteLength(after);
    if (value.complete && revision === after && cost <= maxBytes && maxEntries > 0) {
      while (cache.size >= maxEntries || bytes + cost > maxBytes) {
        const oldest = cache.keys().next().value;
        bytes -= cache.get(oldest).bytes; cache.delete(oldest);
      }
      cache.set(key, { revision, value: structuredClone(value), bytes: cost }); bytes += cost;
    }
    return value;
  };
}

async function serveCatalog() {
  Object.assign(process.env, assistantEnvironment(), bundledSkillEnvironment());
  const reader = createSkillCatalogReader({ prepare: () => prepareBundledSkills() });
  // Serial protocol: at most one discovery runs, and EOF releases the process.
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      const input = JSON.parse(line);
      if (!path.isAbsolute(input.cwd) || !path.isAbsolute(input.userData)) throw new Error('Invalid Skills scope');
      const value = await reader(input.cwd, { dshHome: input.userData }, { refresh: input.refresh === true });
      const output = JSON.stringify({ ok: true, value });
      if (Buffer.byteLength(output) + 1 > 8 * 1024 * 1024) throw new Error('Skills catalog exceeds response budget');
      process.stdout.write(output + '\n');
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--serve') { await serveCatalog(); }
    else {
      if (!((args.length === 2 || args.length === 4 || args.length === 6) && args[0] === '--cwd' && path.isAbsolute(args[1])) ||
          args.length === 6 && (args[2] !== '--action' || args[4] !== '--entry') || args.length === 4 && args[2] !== '--import') {
        throw new Error('Usage: skills.mjs --cwd ABSOLUTE_PATH [--action enable|disable|delete --entry ABSOLUTE_PATH | --import ABSOLUTE_ZIP]');
      }
      await prepareBundledSkills();
      Object.assign(process.env, assistantEnvironment(), bundledSkillEnvironment());
      const result = args.length === 4 ? await importSkill(args[1], args[3]) : args.length === 2 ? await discoverSkills(args[1]) : await manageSkill(args[1], { action: args[3], entryPath: args[5] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

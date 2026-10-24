import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { desktopResourceCommands, desktopRuntimePreparation } from './desktop-runtime-target.mjs';
import { prepareDshProduction } from './stage-dsh-runtime.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const host = path.join(repository, 'packages/agent-host');
const { development, target } = desktopRuntimePreparation(process.argv.slice(2));
const manifest = JSON.parse(await readFile(path.join(host, 'runtime-manifest.json'), 'utf8'));
const entry = manifest.targets[target.runtimeTarget];
if (!entry) throw new Error(`No pinned Node archive for ${target.runtimeTarget}`);
if (!process.env.npm_execpath) throw new Error('Run preparation through npm run prepare:desktop-runtime or prepare:dev-runtime (npm CLI path is required)');

const run = (command, args, cwd = repository) => new Promise((resolve, reject) => {
  // Inherit proxy, TLS trust and other build settings; never disable verification.
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${signal ?? code})`)));
});
const temporary = await mkdtemp(path.join(os.tmpdir(), 'mind-desktop-resources-'));
try {
  let archive = process.env.PROJECT_MIND_NODE_ARCHIVE;
  if (!archive) {
    const cache = path.join(host, 'runtime/archives');
    await mkdir(cache, { recursive: true });
    archive = path.join(cache, entry.archive);
    try { if (!(await lstat(archive)).isFile()) throw new Error('Pinned Node archive cache is not a regular file'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const download = path.join(temporary, entry.archive);
      await run('curl', ['--fail', '--location', '--silent', '--show-error', '--output', download,
        new URL(entry.archive, manifest.releaseBaseUrl).href]);
      await copyFile(download, archive);
    }
  }
  archive = path.resolve(archive);
  let productionDsh;
  if (!development) {
    productionDsh = path.join(temporary, 'dsh-assistant');
    await prepareDshProduction(path.join(repository, 'packages/dsh-assistant'), productionDsh, target, run);
  }
  for (const [script, ...args] of desktopResourceCommands(target, archive, productionDsh, { development })) {
    await run(process.execPath, [path.join(repository, script), ...args]);
  }
  process.stdout.write(`Desktop ${development ? 'development' : 'release'} backend resources prepared for ${target.rustTarget} (${target.runtimeTarget})\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

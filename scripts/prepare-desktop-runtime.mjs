import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { desktopResourceCommands, desktopRuntimeTarget } from './desktop-runtime-target.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const host = path.join(repository, 'packages/agent-host');
const target = desktopRuntimeTarget(process.argv[2]);
if (process.argv.length > 3) throw new Error('Usage: npm run prepare:desktop-runtime -- <Rust target triple>');
const manifest = JSON.parse(await readFile(path.join(host, 'runtime-manifest.json'), 'utf8'));
const entry = manifest.targets[target.runtimeTarget];
if (!entry) throw new Error(`No pinned Node archive for ${target.runtimeTarget}`);
if (!process.env.npm_execpath) throw new Error('Run preparation through npm run prepare:desktop-runtime (npm CLI path is required)');

const run = (command, args, cwd = repository) => new Promise((resolve, reject) => {
  // Inherit proxy, TLS trust and other build settings; never disable verification.
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
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
  const productionHost = path.join(temporary, 'agent-host');
  await mkdir(productionHost);
  for (const name of ['package.json', 'package-lock.json']) await copyFile(path.join(host, name), path.join(productionHost, name));
  // A fresh production tree excludes development files and selects the target's
  // optional binaries even for a macOS x64 build on an arm64 runner. SDK package
  // resources remain intact; do not bundle dynamic SDK imports or run host-native
  // install scripts against a cross-target dependency tree.
  await run(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', `--os=${target.platform}`, `--cpu=${target.arch}`], productionHost);
  for (const [script, ...args] of desktopResourceCommands(target, archive, productionHost)) {
    await run(process.execPath, [path.join(repository, script), ...args]);
  }
  process.stdout.write(`Desktop backend resources prepared for ${target.rustTarget} (${target.runtimeTarget})\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

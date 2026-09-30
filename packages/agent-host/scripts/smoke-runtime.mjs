import { spawn } from 'node:child_process';
import { mkdtemp, readdir, copyFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const executable = process.platform === 'win32' ? 'node.exe' : 'node';
const root = await mkdtemp(path.join(os.tmpdir(), 'ProjectMind 运行时验证 '));
try {
  const bundledNode = path.join(root, executable);
  await copyFile(path.join(packageRoot, 'runtime', target, executable), bundledNode);
  if (process.platform !== 'win32') await chmod(bundledNode, 0o755);
  const directory = path.join(packageRoot, 'test', 'pi');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(directory, name));
  // Neither the parent's PATH nor model credentials reach the child. The
  // absolute executable and paths with spaces/Chinese must suffice.
  const env = { PATH: '', HOME: root, TMPDIR: root, TEMP: root, TMP: root };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  await new Promise((resolve, reject) => {
    const child = spawn(bundledNode, ['--test', ...files], { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Bundled Node probe failed')));
  });
} finally { await rm(root, { recursive: true, force: true }); }

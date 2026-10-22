import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantEnvironment } from './isolation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [command, ...args] = process.argv.slice(2);
if (!['build', 'dev', 'start', 'check'].includes(command)) throw new Error('Usage: desktop.mjs build|dev|start|check [--port N] [--no-open]');
function run(executable, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd: root, env: assistantEnvironment(), stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const clean = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { clean(); reject(error); });
    child.once('exit', (code, signal) => { clean(); if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolve(); else reject(new Error(`DSH exited (${signal ?? code})`)); });
  });
}
if (command === 'check' || command === 'build') {
  for (const file of ['scripts/desktop.mjs', 'scripts/runtime.mjs', 'scripts/model-utility.mjs', 'scripts/model-utility-entry.mjs', 'scripts/skills.mjs', 'scripts/builtin-skills.mjs', 'scripts/skill-management.mjs', 'scripts/isolation.mjs', 'scripts/shared-model.mjs', 'scripts/project-workspace.mjs', 'scripts/office-service.mjs', 'vendor/dsh-desktop-client-ui/index.js', 'vendor/dsh-desktop-client-ui/client.js']) await run(process.execPath, ['--check', file]);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const pin = JSON.parse(await readFile(path.join(root, 'upstream.json'), 'utf8'));
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const installed = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== pin.dshVersion || manifest.dependencies[name] !== (name === '@deepseek-ai/dsh-web-app' ? 'file:vendor/dsh-web-app' : pin.dshVersion)) throw new Error(`Version mismatch: ${name}`);
  }
  await access(path.join(root, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'));
  process.stdout.write('Pinned Node DSH and upstream browser assets ready.\n');
} else {
  await run(process.execPath, ['scripts/runtime.mjs', '--host', '127.0.0.1', '--port', '3081', ...args]);
}

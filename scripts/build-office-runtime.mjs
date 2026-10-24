import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DESKTOP_RUNTIME_TARGETS, desktopRuntimeTarget } from './desktop-runtime-target.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const requested = process.argv[2];
const hostTarget = Object.entries(DESKTOP_RUNTIME_TARGETS).find(([, target]) => target.platform === process.platform && target.arch === process.arch)?.[0];
const target = requested ? desktopRuntimeTarget(requested) : desktopRuntimeTarget(hostTarget, {});
if (!process.env.npm_execpath) throw new Error('Run through npm run build:office');
const run = (args, cwd, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {cwd,env,stdio:'inherit',windowsHide:true});
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Office build failed (${code})`)));
});
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
async function installLocked(source) {
  const lock = checksum(await readFile(path.join(source, 'package-lock.json')));
  let installed = '';
  try { installed = await readFile(path.join(source, 'node_modules/.mind-office-lock'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installed !== lock) {
    await run(['ci','--ignore-scripts','--no-audit','--no-fund'],source);
    await writeFile(path.join(source,'node_modules/.mind-office-lock'),lock);
  }
}
const markdown = path.join(root, 'packages/markdown-editor');
await installLocked(markdown);
await run(['run','verify:vendor'],markdown);
const html2docx = path.join(root, 'packages/office-html2docx');
await installLocked(html2docx);
await run(['run','build'],html2docx);
for (const format of ['docx', 'xlsx', 'pptx']) {
  const source = path.join(root, `packages/office-${format}`);
  await installLocked(source);
  await run(['run','build'],source,{...process.env,OFFICE_RUST_TARGET:target.rustTarget});
}
const { assembleOfficeDistribution } = await import('./office-distribution.mjs');
await assembleOfficeDistribution(root, target.rustTarget);

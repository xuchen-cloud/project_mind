import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, rm, writeFile, readdir, lstat } from 'node:fs/promises';
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
  const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {cwd,env,stdio:'inherit'});
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Office build failed (${code})`)));
});
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const distribution = path.join(root, 'packages/agent-host/office-dist');
await rm(distribution, { recursive: true, force: true });
await mkdir(distribution, { recursive: true });
for (const format of ['docx', 'xlsx', 'pptx']) {
  const source = path.join(root, `packages/office-${format}`);
  const lock = checksum(await readFile(path.join(source, 'package-lock.json')));
  let installed = '';
  try { installed = await readFile(path.join(source, 'node_modules/.mind-office-lock'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installed !== lock) {
    await run(['ci','--ignore-scripts','--no-audit','--no-fund'],source);
    await writeFile(path.join(source,'node_modules/.mind-office-lock'),lock);
  }
  await run(['run','build'],source,{...process.env,OFFICE_RUST_TARGET:target.rustTarget});
  const destination = path.join(distribution, format);
  await rm(destination, {recursive:true,force:true});
  await cp(path.join(source,'dist'), destination, {recursive:true,filter: file => !file.endsWith('.meta.json') && !file.endsWith('.d.mts')});
  await writeFile(path.join(distribution,`${format}-engine.mjs`),`export * from './${format}/engine.mjs';\n`);
}
const executable = target.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
await copyFile(path.join(root, 'packages/office-xlsx/dist', executable),path.join(distribution,executable));
await copyFile(path.join(root, 'packages/office-runtime/worker.mjs'),path.join(distribution,'worker.mjs'));
const files = [];
async function visit(directory, prefix = '') {
  for (const entry of (await readdir(directory, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name;
    if (name === 'office-distribution.json') continue;
    const file = path.join(directory,entry.name); const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Office asset cannot be a symlink: ${name}`);
    if (entry.isDirectory()) await visit(file, name + '/');
    else if (entry.isFile()) files.push({file:name,sha256:checksum(await readFile(file))});
    else throw new Error(`Invalid Office asset: ${name}`);
  }
}
await visit(distribution);
await writeFile(path.join(distribution,'office-distribution.json'),JSON.stringify({schemaVersion:1,rustTarget:target.rustTarget,runtimeTarget:target.runtimeTarget,upstream:'d32d1711f1bf985430757b8c6b3fbddd3831d946',files},null,2)+'\n');

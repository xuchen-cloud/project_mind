import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..',import.meta.url));
const target = process.argv[2];
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const host = path.join(root,'packages/agent-host');
const source = path.join(host,'office-dist');
const manifestBytes = await readFile(path.join(source,'office-distribution.json'));
const distribution = JSON.parse(manifestBytes);
if (distribution.schemaVersion !== 1 || distribution.runtimeTarget !== target) throw new Error('Office build target differs from the desktop target');
for (const entry of distribution.files) {
  if (path.posix.isAbsolute(entry.file) || entry.file.includes('\\') || entry.file.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid Office distribution path');
  const file = path.join(source,entry.file);
  if (!(await lstat(file)).isFile() || checksum(await readFile(file)) !== entry.sha256) throw new Error(`Office asset differs from its build: ${entry.file}`);
}
const runtimeRoot = path.join(root,'src-tauri/resources/agent-host');
const runtime = JSON.parse(await readFile(path.join(runtimeRoot,'runtime.json')));
const pinned = JSON.parse(await readFile(path.join(host,'runtime-manifest.json')));
const executable = target?.startsWith('win-') ? 'node.exe' : 'node';
const bytes = await readFile(path.join(runtimeRoot,executable));
if (runtime.target !== target || runtime.nodeVersion !== pinned.nodeVersion || runtime.sourceArchiveChecksum !== pinned.targets[target]?.sha256 || checksum(bytes) !== runtime.nodeChecksum) throw new Error('Office requires the verified desktop Node runtime');
const resources = path.join(root,'src-tauri/resources');
const staging = await mkdtemp(path.join(resources,'.office-editor-'));
try {
  await mkdir(path.join(staging,'src'));
  await copyFile(path.join(runtimeRoot,executable),path.join(staging,executable));
  await copyFile(path.join(runtimeRoot,'NODE-LICENSE'),path.join(staging,'NODE-LICENSE'));
  await copyFile(path.join(host,'src/office-worker-entry.mjs'),path.join(staging,'src/office-worker-entry.mjs'));
  await cp(source,path.join(staging,'office-dist'),{recursive:true});
  if (!target.startsWith('win-')) {
    await chmod(path.join(staging,executable),0o755);
    await chmod(path.join(staging,'office-dist/xlsx-sidecar'),0o755);
  }
  // Verify the copied snapshot before replacing the previous packaged utility.
  for (const entry of distribution.files) if (checksum(await readFile(path.join(staging,'office-dist',entry.file))) !== entry.sha256) throw new Error('Office distribution changed during staging');
  const destination = path.join(resources,'office-editor');
  await rm(destination,{recursive:true,force:true}); await rename(staging,destination);
} finally { await rm(staging,{recursive:true,force:true}); }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(`${root}/source-lock.json`, 'utf8'));
if (lock.commit !== 'd32d1711f1bf985430757b8c6b3fbddd3831d946') throw new Error('Unexpected GenOffice revision');
for (const entry of lock.files) {
  if (!/^(?:packages\/(?:pptx-engine|pptx-render|pptx-ops|pipelines|docx-engine|electron-utils|ui|i18n|ai-provider|zip-gate|agent-core)\/|apps\/(?:slides)\/|apps\/docs\/src\/renderer\/fonts\/|LICENSE(?:-UNICODE.txt)?$|NOTICE$)/.test(entry.path) || entry.path.includes('..')) throw new Error('Invalid source path');
  const destination = `${root}/vendor/${entry.path}`;
  if (process.argv.includes('--fetch')) {
    const response = await fetch(`https://raw.githubusercontent.com/genspark-ai/genoffice/${lock.commit}/${entry.path}`);
    if (!response.ok) throw new Error(`Source download failed: ${entry.path} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verify(bytes, entry);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  } else verify(await readFile(destination), entry);
}
const attribution = JSON.parse(await readFile(`${root}/licenses/provenance.json`, 'utf8'));
const licenseBytes = await readFile(`${root}/licenses/nodable-LICENSE`);
if (createHash('sha256').update(licenseBytes).digest('hex') !== attribution.sha256) throw new Error('Dependency license integrity mismatch');
function verify(bytes, entry) {
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== entry.bytes || hash !== entry.git_blob_sha1) throw new Error(`Pinned source integrity mismatch: ${entry.path}`);
}
console.log(`Verified ${lock.files.length} GenOffice sources at ${lock.commit}`);

const forkLock=JSON.parse(await readFile(`${root}/fork-source-lock.json`,'utf8'));
if(forkLock.commit!=='86e288908456be5d3b3cccc97e79708e4adf1bc4')throw new Error('Unexpected Web fork revision');
for(const entry of forkLock.files){
 const source=entry.path==='vite.web.config.ts'?'apps/slides/vite.web.config.ts':`apps/slides/src/renderer/${entry.path}`;
 const destination=`${root}/fork-research/${entry.path}`;
 if(process.argv.includes('--fetch')){const response=await fetch(`https://raw.githubusercontent.com/Nothing1024/dsh-genoffice-engine/${forkLock.commit}/${source}`);if(!response.ok)throw new Error(`Fork download failed: ${source}`);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,new Uint8Array(await response.arrayBuffer()))}
 const bytes=await readFile(destination);if(bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`Fork source integrity mismatch: ${source}`);
}
console.log(`Verified ${forkLock.files.length} Web adaptation sources at ${forkLock.commit}`);

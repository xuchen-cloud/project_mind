import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, open, rename, rm, lstat } from 'node:fs/promises';
import { syncDirectory } from './fs-durability.mjs';
import { normalizeDirectory } from './context-directory.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function exists(file) {
 try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function durableWrite(file, data) {
 await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
 const handle = await open(file, 'wx', 0o600);
 try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
async function syncTreeDirectories(directory) {
 for(const entry of await entries(directory)) if(entry.isDirectory()) await syncTreeDirectories(path.join(directory,entry.name));
 await syncDirectory(directory);
}
async function entries(directory) {
 try { return (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name)); }
 catch(error) { if(error.code==='ENOENT') return []; throw error; }
}
// rc.2 stores the header in an independent checksummed first Zstd frame.
// Locate only that frame; event frames and any crash-torn tail stay byte exact.
function splitHeader(bytes, compressed) {
 let end;
 if(compressed) {
  if(bytes.length<5||bytes.readUInt32LE(0)!==0xfd2fb528) throw new Error('Invalid Zstd session header');
  const descriptor=bytes[4];if(descriptor&24) throw new Error('Invalid Zstd frame descriptor');
  const flag=descriptor>>>6,single=Boolean(descriptor&32),dictionary=descriptor&3;
  let offset=5+(single?0:1)+(dictionary===3?4:dictionary)+(flag===0?(single?1:0):1<<flag);
  for(;;) {
   if(offset+3>bytes.length) throw new Error('Incomplete Zstd header frame');
   const block=bytes.readUIntLE(offset,3),type=(block>>>1)&3;offset+=3;
   if(type===3) throw new Error('Invalid Zstd header block');
   offset+=type===1?1:block>>>3;
   if(offset>bytes.length) throw new Error('Incomplete Zstd header frame');
   if(block&1) break;
  }
  end=offset+(descriptor&4?4:0);if(end>bytes.length) throw new Error('Incomplete Zstd checksum');
 } else {end=bytes.indexOf(10)+1;if(!end) throw new Error('Incomplete session header');}
 const first=compressed?zstdDecompressSync(bytes.subarray(0,end)):bytes.subarray(0,end);
 if(first.indexOf(10)!==first.length-1) throw new Error('Session first frame must contain exactly one header');
 return {header:JSON.parse(first.toString('utf8')),rest:bytes.subarray(end)};
}
// Only selected durable trees enter the new home; refuse symlinks across the boundary.
async function copyTree(source, destination) {
 const info=await lstat(source);
 if(info.isSymbolicLink()) throw new Error(`History contains a symbolic link: ${source}`);
 if(info.isDirectory()) {
  await mkdir(destination,{recursive:true,mode:0o700});
  for(const item of await entries(source)) await copyTree(path.join(source,item.name),path.join(destination,item.name));
  await syncDirectory(destination);
 } else if(info.isFile()) {
  const bytes=await readFile(source);
  if(await exists(destination)) {
   if(!(await readFile(destination)).equals(bytes)) throw new Error(`History file conflict: ${destination}`);
  } else await durableWrite(destination,bytes);
 } else throw new Error(`Unsupported history entry: ${source}`);
}

/** Open only the current shared home. Old per-scope homes are never read.
 * Recovery is limited to an already published current directory-move journal.
 */
export async function prepareCurrentRuntime({ home, contexts }) {
 if(!path.isAbsolute(home)) throw new Error('Invalid runtime home');
 const mappings=await reconcileContextDirectories({home,contexts});
 await mkdir(home,{recursive:true,mode:0o700});
 return mappings;
}

// Exact rc.2 dsh-session-persistence-jsonl projectKey spelling. Session IDs and
// their contents remain unchanged when a native scope's directory moves.
export function projectKey(cwd) {
 if(cwd.length===0) throw new Error('cannot encode an empty project path');
 let readable='',separatorRun=false;
 for(let i=0;i<cwd.length;i++) {
  const code=cwd.charCodeAt(i),ch=String.fromCharCode(code);
  if(ch==='/'||ch==='\\'||ch===':') {if(!separatorRun) readable+='-';separatorRun=true;}
  else if(ch!=='~'&&/^[A-Za-z0-9._-]$/.test(ch)) {readable+=ch;separatorRun=false;}
  else {readable+='~'+code.toString(16).toUpperCase().padStart(4,'0');separatorRun=false;}
 }
 return `--${(readable.replace(/^-+/,'')||'root').slice(0,251)}--`;
}
async function recoverDirectoryMove(home) {
 const journalFile=`${home}.directory-move.json`;
 if(!await exists(journalFile)) return;
 const journal=await readJson(journalFile);
 if(journal.version!==1||journal.home!==home||journal.staging!==`${home}.directory-staging`||path.dirname(journal.backup)!==path.dirname(home)||!path.basename(journal.backup).startsWith(`${path.basename(home)}.directory-backup-`)) throw new Error('Invalid directory migration journal');
 if(!await exists(journal.backup)) {
  if(!await exists(home)||!await exists(journal.staging)) throw new Error('Directory migration is missing recovery data');
  await rename(home,journal.backup);await syncDirectory(path.dirname(home));
 }
 if(!await exists(home)) {
  if(!await exists(journal.staging)) throw new Error('Directory migration is missing staged data');
  await rename(journal.staging,home);await syncDirectory(path.dirname(home));
 }
 await rm(journalFile);await syncDirectory(path.dirname(home));
}

/** Native identity, rather than directory spelling, owns the persisted DSH ID.
 * Called only before starting Harness, for scopes admitted by the native host. Existing scopes omitted from contexts are retained unchanged.
 */
export async function reconcileContextDirectories({home,contexts}) {
 await recoverDirectoryMove(home);
 const mappingFile=path.join(home,'mind-contexts.json');
 let mappings;
 try { mappings=await readJson(mappingFile); }
 catch(error) { if(error.code!=='ENOENT') throw error; mappings={version:1,contexts:[]}; }
 if(mappings.version!==1||!Array.isArray(mappings.contexts)||!Array.isArray(contexts)) throw new Error('Invalid context mappings');
 const identities=new Set(),workspaceIds=new Set(),directories=new Set();
 const currentWorkspace=contexts.find(context=>context.kind==='workspace');
 for(const context of mappings.contexts) {
  if(!context||typeof context.directory!=='string'||!path.isAbsolute(context.directory)
   ||typeof context.workspaceId!=='string'||!context.workspaceId
   ||!(context.kind==='workspace'?typeof context.id==='string'&&context.id:context.kind==='project'&&Number.isSafeInteger(context.id)&&context.id>0)) throw new Error('Invalid context mappings');
  if(currentWorkspace&&context.kind==='workspace'&&context.id!==currentWorkspace.id) throw new Error('Native workspace mapping identity mismatch');
  const key=`${context.kind}:${context.id}`,directory=normalizeDirectory(context.directory);
  if(identities.has(key)||workspaceIds.has(context.workspaceId)||directories.has(directory)) throw new Error('Context mapping ownership conflict');
  identities.add(key);workspaceIds.add(context.workspaceId);directories.add(directory);
 }
 const targets=new Map();
 for(const context of contexts) {
  const key=`${context.kind}:${context.id}`;
  if(targets.has(key)||!path.isAbsolute(context.directory)) throw new Error('Invalid native directory bindings');
  targets.set(key,normalizeDirectory(context.directory));
 }
 const moves=mappings.contexts.filter(context=>targets.has(`${context.kind}:${context.id}`)&&targets.get(`${context.kind}:${context.id}`)!==normalizeDirectory(context.directory));
 if(!moves.length) return mappings;
 const registry=await readJson(path.join(home,'storages/workspace.json'));
 const staging=`${home}.directory-staging`,backup=`${home}.directory-backup-${randomUUID()}`;
 await rm(staging,{recursive:true,force:true});await mkdir(staging,{mode:0o700});
 try {
  // Native CLI discovery is an expiring credential, not history. Preboot has no
  // valid leases; revoke it before retaining the recovery copy of the old home.
  await rm(path.join(home,'native-cli.json'),{force:true});
  for(const entry of await entries(home)) await copyTree(path.join(home,entry.name),path.join(staging,entry.name));
  for(const context of moves) {
   const directory=targets.get(`${context.kind}:${context.id}`);
   const record=registry.tables?.workspaces?.[context.workspaceId];
   if(!record||normalizeDirectory(record.path)!==normalizeDirectory(context.directory)) throw new Error('Context mapping disagrees with workspace registry');
   if(mappings.contexts.some(other=>other!==context&&(normalizeDirectory(other.directory)===directory||(targets.get(`${other.kind}:${other.id}`)??normalizeDirectory(other.directory))===directory))) throw new Error('Native directory binding conflict');
   for(const group of await entries(path.join(staging,'sessions'))) {
    if(!group.isDirectory()) throw new Error('Unexpected session group');
    for(const session of await entries(path.join(staging,'sessions',group.name))) {
     const sessionDirectory=path.join(staging,'sessions',group.name,session.name);
     const generations=(await entries(sessionDirectory)).filter(item=>/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(item.name));
     const rewrites=[];
     for(const generation of generations) {
      const file=path.join(sessionDirectory,generation.name);const bytes=await readFile(file);
      const compressed=generation.name.endsWith('.zstd');
      const {header,rest}=splitHeader(bytes,compressed);
      if(normalizeDirectory(header.cwd)!==normalizeDirectory(context.directory)) continue;
      header.cwd=directory;
      const first=Buffer.from(JSON.stringify(header)+'\n');
      const encoded=compressed?zstdCompressSync(first,{params:{[constants.ZSTD_c_checksumFlag]:1}}):first;
      rewrites.push({file,bytes:Buffer.concat([encoded,rest])});
     }
     if(!rewrites.length) continue;
     for(const rewrite of rewrites) {await rm(rewrite.file);await durableWrite(rewrite.file,rewrite.bytes);}
     const destination=path.join(staging,'sessions',projectKey(directory),session.name);
     if(destination!==sessionDirectory) {
      if(await exists(destination)) throw new Error('Session destination conflict during directory migration');
      await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await rename(sessionDirectory,destination);
     }
    }
   }
   record.path=directory;context.directory=directory;
  }
  for(const [file,value] of [[path.join(staging,'storages/workspace.json'),registry],[path.join(staging,'mind-contexts.json'),mappings]]) {
   await rm(file);await durableWrite(file,JSON.stringify(value)+'\n');
  }
  await syncTreeDirectories(staging);
  const journalFile=`${home}.directory-move.json`,temporary=`${journalFile}.${randomUUID()}.tmp`;
  await durableWrite(temporary,JSON.stringify({version:1,home,staging,backup})+'\n');
  await rename(temporary,journalFile);await syncDirectory(path.dirname(home));
  await recoverDirectoryMove(home);
  return mappings;
 } catch(error) {
  // A published journal owns its staging and backup until recovery succeeds.
  if(!await exists(`${home}.directory-move.json`)) await rm(staging,{recursive:true,force:true});
  throw error;
 }
}

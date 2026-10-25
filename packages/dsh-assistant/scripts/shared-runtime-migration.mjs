import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, open, rename, rm, lstat } from 'node:fs/promises';
import { validateStore } from './scheduled-tasks-schema.mjs';

const manifestName = 'mind-migration.json';
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
async function syncDirectory(directory) {
 const handle = await open(directory, 'r');
 try { await handle.sync(); } finally { await handle.close(); }
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

/** Import one native Workspace's former per-scope homes before Harness boots.
 * The native lifecycle serializes this call. A complete staged home is published
 * with one directory rename; interrupted staging is rebuilt from retained sources.
 */
export async function migrateSharedRuntime({ legacyRoot, home, workspaceId }) {
 if(!path.isAbsolute(legacyRoot)||!path.isAbsolute(home)||typeof workspaceId!=='string'||!workspaceId) throw new Error('Invalid migration identity');
 await recoverDirectoryMove(home);
 if(await exists(home)) {
  if(await exists(path.join(home,manifestName))) {
   const saved=await readJson(path.join(home,manifestName));
   if(saved.version!==1||saved.workspaceId!==workspaceId||saved.complete!==true) throw new Error('Shared runtime migration identity mismatch');
   return readJson(path.join(home,'mind-contexts.json'));
  }
  if((await entries(home)).length) throw new Error('Shared runtime destination contains unrecognized data');
  await rm(home,{recursive:true});
 }
 const staging=`${home}.migration-staging`;
 await mkdir(path.dirname(home),{recursive:true,mode:0o700});
 await rm(staging,{recursive:true,force:true});
 const contexts=[];
 const workspaceRecords={};
 const global={initialized:true,workspaceIds:[],archivedSessionIds:[],pinnedSessionIds:[]};
 const sessions=new Set();
 const accountedSessions=new Set();
 const sources=[];
 try {
  await mkdir(staging,{mode:0o700});
  const candidates=(await entries(legacyRoot)).filter(entry=>entry.name==='workspace'||/^[1-9]\d*$/.test(entry.name)).sort((a,b)=>a.name==='workspace'?-1:b.name==='workspace'?1:a.name.localeCompare(b.name));
  for(const scope of candidates) {
   if(!scope.isDirectory()) throw new Error('Legacy scope is not a real directory');
   if(scope.name!=='workspace'&&!Number.isSafeInteger(Number(scope.name))) throw new Error('Invalid legacy native Project identity');
   const source=path.join(legacyRoot,scope.name);
   const registryFile=path.join(source,'storages/workspace.json');
   const sessionGroups=await entries(path.join(source,'sessions'));
   const registry=await exists(registryFile)?await readJson(registryFile):null;
   if(!registry) {
    if(sessionGroups.length||await exists(path.join(source,'scheduled-tasks.json'))) throw new Error(`Legacy scope ${scope.name} has history without workspace registry`);
    continue;
   }
   if(registry.unit?.name!=='workspace'||registry.unit.version!==2||!registry.tables?.workspaces||!Array.isArray(registry.global?.workspaceIds)||registry.global.pendingMutation) throw new Error(`Invalid or interrupted workspace registry: ${scope.name}`);
   const ids=registry.global.workspaceIds;
   if(ids.length!==1||Object.keys(registry.tables.workspaces).length!==1) throw new Error(`Legacy scope ${scope.name} must contain exactly one workspace`);
   const id=ids[0],record=registry.tables.workspaces[id];
   if(!record||typeof record.path!=='string'||!path.isAbsolute(record.path)||!Array.isArray(record.sessionIds)) throw new Error('Invalid legacy workspace record');
   if(Object.hasOwn(workspaceRecords,id)) throw new Error(`Workspace identity conflict: ${id}`);
   for(const sessionId of record.sessionIds) {
    if(typeof sessionId!=='string'||accountedSessions.has(sessionId)) throw new Error(`Session ownership conflict: ${sessionId}`);
    accountedSessions.add(sessionId);
   }
   const ownSessions=new Set();
   for(const group of sessionGroups) {
    if(!group.isDirectory()) throw new Error('Unexpected session layout');
    for(const session of await entries(path.join(source,'sessions',group.name))) {
     if(!session.isDirectory()) throw new Error('Unexpected legacy session layout');
     const sessionDirectory=path.join(source,'sessions',group.name,session.name);
     const generations=(await entries(sessionDirectory)).filter(item=>/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(item.name));
     if(!generations.length) throw new Error('Session has no committed history');
     let sessionId;
     for(const generation of generations) {
      const bytes=await readFile(path.join(sessionDirectory,generation.name));
      const {header}=splitHeader(bytes,generation.name.endsWith('.zstd'));
      if(header.type!=='session'||typeof header.id!=='string'||header.cwd!==record.path) throw new Error(`Session history belongs to another directory: ${scope.name}`);
      if(sessionId!==undefined&&sessionId!==header.id) throw new Error('Session generation identity conflict');
      sessionId=header.id;
     }
     if(sessions.has(sessionId)) throw new Error(`Session identity conflict: ${sessionId}`);
     sessions.add(sessionId);ownSessions.add(sessionId);
     for(const artifact of await entries(sessionDirectory)) if(artifact.name!=='session.lock') await copyTree(path.join(sessionDirectory,artifact.name),path.join(staging,'sessions',group.name,session.name,artifact.name));
    }
   }
   for(const sessionId of record.sessionIds) if(!ownSessions.has(sessionId)) throw new Error(`Workspace references missing session: ${sessionId}`);
   workspaceRecords[id]=record;global.workspaceIds.push(id);
   for(const field of ['archivedSessionIds','pinnedSessionIds']) {
    const values=registry.global[field]??[];
    if(!Array.isArray(values)||values.some(id=>!ownSessions.has(id))) throw new Error(`Invalid registry ${field}`);
    global[field].push(...values);
   }
   if(scope.name==='workspace'&&registry.global.defaultWorkspaceId) global.defaultWorkspaceId=registry.global.defaultWorkspaceId;
   contexts.push({kind:scope.name==='workspace'?'workspace':'project',id:scope.name==='workspace'?workspaceId:Number(scope.name),directory:record.path,workspaceId:id});
   sources.push(scope.name);
   for(const tree of ['attachments']) if(await exists(path.join(source,tree))) await copyTree(path.join(source,tree),path.join(staging,tree));
   const tasksFile=path.join(source,'scheduled-tasks.json');
   if(await exists(tasksFile)) {
    if(scope.name!=='workspace') throw new Error('Project scope contains unexpected scheduled tasks');
    validateStore(await readJson(tasksFile));
    await durableWrite(path.join(staging,'scheduled-tasks.json'),await readFile(tasksFile));
   }
  }
  const mappings={version:1,contexts};
  await durableWrite(path.join(staging,'storages/workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global,tables:{workspaces:workspaceRecords}})+'\n');
  await durableWrite(path.join(staging,'mind-contexts.json'),JSON.stringify(mappings)+'\n');
  await durableWrite(path.join(staging,manifestName),JSON.stringify({version:1,workspaceId,complete:true,sources})+'\n');
  await syncTreeDirectories(staging);
  await rename(staging,home);await syncDirectory(path.dirname(home));
  return mappings;
 } catch(error) {
  await rm(staging,{recursive:true,force:true});
  throw error;
 }
}

// Exact rc.2 dsh-session-persistence-jsonl projectKey spelling. Session IDs and
// their contents remain unchanged when a native scope's directory moves.
function projectKey(cwd) {
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
 * Called only before starting Harness, after the native host resolves all current
 * directories. Existing scopes omitted from contexts are retained unchanged.
 */
export async function reconcileContextDirectories({home,contexts}) {
 await recoverDirectoryMove(home);
 const mappingFile=path.join(home,'mind-contexts.json');
 const mappings=await readJson(mappingFile);
 if(mappings.version!==1||!Array.isArray(mappings.contexts)||!Array.isArray(contexts)) throw new Error('Invalid context mappings');
 const targets=new Map();
 for(const context of contexts) {
  const key=`${context.kind}:${context.id}`;
  if(targets.has(key)||!path.isAbsolute(context.directory)) throw new Error('Invalid native directory bindings');
  targets.set(key,context.directory);
 }
 const moves=mappings.contexts.filter(context=>targets.has(`${context.kind}:${context.id}`)&&targets.get(`${context.kind}:${context.id}`)!==context.directory);
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
   if(!record||record.path!==context.directory) throw new Error('Context mapping disagrees with workspace registry');
   if(mappings.contexts.some(other=>other!==context&&(other.directory===directory||(targets.get(`${other.kind}:${other.id}`)??other.directory)===directory))) throw new Error('Native directory binding conflict');
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
      if(header.cwd!==context.directory) continue;
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

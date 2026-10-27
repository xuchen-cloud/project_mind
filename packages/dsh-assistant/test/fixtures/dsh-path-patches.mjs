import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Minimal executable rc.2 anchor surfaces: no native code or package lifecycle.
export const persistenceSource = String.raw`
function projectKey(cwd) {
 if (cwd.length === 0) throw new Error("cannot encode an empty project path");
 let readable='',separatorRun=false;
 for(let i=0;i<cwd.length;i++) {
  const code=cwd.charCodeAt(i),ch=String.fromCharCode(code);
  if(ch==='/'||ch==='\\'||ch===':') {if(!separatorRun) readable+='-';separatorRun=true;}
  else if(ch!=='~'&&/^[A-Za-z0-9._-]$/.test(ch)) {readable+=ch;separatorRun=false;}
  else {readable+='~'+code.toString(16).toUpperCase().padStart(4,'0');separatorRun=false;}
 }
 return '--'+(readable.replace(/^-+/,'')||'root').slice(0,251)+'--';
}
export { projectKey };
`;
export const workspaceSource = `
import { win32 } from 'node:path';
const realpath = async value => value;
async function realpathNormalize(path) {
 return await realpath(path);
}
class Workspace {
 constructor(record, host) { this.record = record; this.host = host; }
 async attachCheck(cwd) {
  if (cwd !== this.record.path) throw new Error('foreign directory');
 }
 mutate(changed) {
  const sessionIds=changed.sessionIds.filter(id=>this.host.sessionPath(id) === changed.path);
  return {
   ...changed,
   sessionIds,
  };
 }
}
export { Workspace };
`;

export async function writePathDependencyFixture(root, sources = [persistenceSource, workspaceSource]) {
 for(const [index,name] of ['dsh-session-persistence-jsonl','dsh-workspace'].entries()) {
  const directory=path.join(root,name);await mkdir(path.join(directory,'lib'),{recursive:true});
  await writeFile(path.join(directory,'package.json'),JSON.stringify({name:`@deepseek-ai/${name}`,version:'0.2.0-rc.2',type:'module'}));
  await writeFile(path.join(directory,'lib/index.js'),sources[index]);
 }
}

export function legacyPathSources() {
 const persistence=persistenceSource.replace(
  'if (cwd.length === 0) throw new Error("cannot encode an empty project path");',
  'if (cwd.length === 0) throw new Error("cannot encode an empty project path"); if (cwd.startsWith(String.fromCharCode(92,92,63,92))) cwd = cwd.slice(4);');
 const workspace=workspaceSource
  .replace('return await realpath(path);\n}', "return await realpath(path);\n}\nconst _vprefix = win32.sep + win32.sep + '?' + win32.sep;\nfunction _stripV(p) { return p && typeof p === 'string' && p.startsWith(_vprefix) ? p.slice(_vprefix.length) : p; }")
  .replace('this.record = record;', 'this.record = record && record.path ? { ...record, path: _stripV(record.path) } : record;')
  .replace('if (cwd !== this.record.path) throw new Error', 'const wsp = await realpathNormalize(this.record.path); if (cwd !== wsp) throw new Error')
  .replace('this.host.sessionPath(id) === changed.path', '_stripV(this.host.sessionPath(id)) === _stripV(changed.path)')
  .replace('...changed,\n   sessionIds,','...changed,\n   path: _stripV(changed.path),\n   sessionIds,');
 return [persistence,workspace];
}

/** Rebuild the fixed renderer source manifest from a checkout of the locked commit. */
import {readFile,writeFile,mkdir,readdir,copyFile,rm} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=import.meta.dirname;
const source=process.argv[2];
if(!source) throw Error('Pass the fixed GenOffice checkout');
const lock=JSON.parse(await readFile(resolve(root,'source-lock.json'),'utf8'));
// Repository READMEs are not renderer inputs; retain licenses/font notices.
const nonruntime=path=>/(^|\/)README(?:\.[^/]*)?$/i.test(path);
for(const file of lock.files.filter(file=>nonruntime(file.path)))await rm(resolve(root,'upstream',file.path),{force:true});
const paths=new Set(lock.files.map(f=>f.path).filter(path=>!nonruntime(path)));
async function visit(path){
  for(const ent of await readdir(resolve(source,path),{withFileTypes:true})){
    const name=`${path}/${ent.name}`;
    if(ent.isDirectory()) await visit(name);
    else if(!nonruntime(name)&&!/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) paths.add(name);
  }
}
for(const dir of ['apps/docs/src/renderer','apps/docs/src/shared',...['ui','agent-core','ai-provider','font-metrics'].map(n=>`packages/${n}/src`)]) await visit(dir);
for(const path of ['packages/electron-utils/src/headless-export.ts','packages/electron-utils/src/safe-external-url.ts']) paths.add(path);
lock.files=[];
for(const path of [...paths].sort()){
  const bytes=await readFile(resolve(source,path));
  lock.files.push({path,bytes:bytes.length,git_blob_sha1:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
  const dest=resolve(root,'upstream',path);await mkdir(dirname(dest),{recursive:true});await copyFile(resolve(source,path),dest);
}
await writeFile(resolve(root,'source-lock.json'),JSON.stringify(lock,null,2)+'\n');
console.log(`Pinned ${lock.files.length} original files at ${lock.commit}`);

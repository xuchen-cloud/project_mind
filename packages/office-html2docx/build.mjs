import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import './prepare-source.mjs';
const root=import.meta.dirname;
await mkdir(resolve(root,'dist'),{recursive:true});
const result=await build({absWorkingDir:root,entryPoints:['src/index.ts'],outfile:'dist/index.mjs',platform:'browser',bundle:true,format:'esm',target:'es2022',metafile:true,inject:['src/browser-globals.ts'],alias:{'node:zlib':resolve(root,'src/browser-zlib.ts')},legalComments:'eof',logLevel:'warning',plugins:[{name:'raw-helper-source',setup(b){b.onResolve({filter:/\?raw$/},({path,resolveDir})=>({path:resolve(resolveDir,path.slice(0,-4)),namespace:'trusted-raw'}));b.onLoad({filter:/.*/,namespace:'trusted-raw'},async({path})=>({contents:await readFile(path,'utf8'),loader:'text'}));}}]});
const lock=JSON.parse(await readFile(resolve(root,'source-lock.json'),'utf8'));
const pinned=new Set(lock.files.map(row=>`upstream/${row.path}`));
for(const input of Object.keys(result.metafile.inputs)){const path=input.replace('trusted-raw:'+root+'/','');if(path.startsWith('upstream/')&&!pinned.has(path))throw Error(`Unpinned upstream input ${input}`);}
await writeFile(resolve(root,'dist/index.meta.json'),JSON.stringify(result.metafile,null,2));

await writeFile(resolve(root,'dist/index.d.mts'),await readFile(resolve(root,'types.ts'),'utf8'));
const noticeParts=[`Project Mind browser HTML to DOCX helper\nGenOffice ${lock.commit}\n${lock.repository}\n`,await readFile(resolve(root,'LICENSE'),'utf8'),await readFile(resolve(root,'NOTICE'),'utf8')];
const usedPackages=new Set();
for(const input of Object.keys(result.metafile.inputs)){
 const match=/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);if(match)usedPackages.add(match[1]);
}
for(const name of [...usedPackages].sort()){
 const at=resolve(root,'node_modules',name),metadata=JSON.parse(await readFile(resolve(at,'package.json'),'utf8'));
 let license;
 for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','LICENCE','license','license.md'])try{license=await readFile(resolve(at,file),'utf8');break;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!license)throw Error(`Missing distribution license for ${name}`);
 noticeParts.push(`\n--- ${name}@${metadata.version} (${metadata.license}) ---\n${license}`);
}
await writeFile(resolve(root,'dist/THIRD-PARTY-NOTICES.txt'),noticeParts.join('\n'));
await writeFile(resolve(root,'dist/source-lock.json'),JSON.stringify(lock,null,2)+'\n');

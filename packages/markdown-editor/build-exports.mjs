import {build} from 'esbuild';
import {readFile,writeFile,mkdir,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export const portablePath = file => file.replaceAll('\\','/');
export function dependencyPackage(input){
  const absolute=portablePath(input);const marker=absolute.lastIndexOf('/node_modules/');
  if(marker<0)return null;
  const components=absolute.slice(marker+14).split('/');
  const name=components[0].startsWith('@')?components.slice(0,2).join('/'):components[0];
  return {name,directory:absolute.slice(0,marker+14)+name};
}
async function main(){
const root=path.dirname(fileURLToPath(import.meta.url));
const supplied=process.argv.find((arg,index)=>index>1&&!arg.startsWith('--'));
const locked=JSON.parse(await readFile(path.join(root,'source-lock.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const target=path.join(root,'src/export/upstream-docx.mjs');
async function bundle(source){
  return build({absWorkingDir:root,stdin:{contents:`export {exportDocxBytes} from ${JSON.stringify(portablePath(path.join(source,'apps/markdown/src/renderer/export/docxExport.ts')))}`,resolveDir:root,sourcefile:'export-entry.js'},bundle:true,platform:'browser',format:'esm',target:'es2021',minify:true,write:false,metafile:true,legalComments:'eof',
    alias:{'@genoffice/docx-engine':path.join(source,'packages/docx-engine/src/index.ts'),'@genoffice/zip-gate':path.join(source,'packages/zip-gate/src/index.ts'),'@genoffice/pptx-engine/custgeom':path.join(source,'packages/pptx-engine/src/custgeom.ts')},
    nodePaths:[path.join(root,'node_modules')],plugins:[{name:'markdown-export-language-only',setup(context){context.onResolve({filter:/^\.\.\/editor\/diagrams$/},()=>({path:path.join(root,'src/export/diagram-language.ts')}));}}]});
}
if(supplied){
  const source=await realpath(supplied);const result=await bundle(source);
  const paths=Object.keys(result.metafile.inputs).map(input=>path.resolve(root,input)).filter(input=>input.startsWith(source+path.sep)).map(input=>portablePath(path.relative(source,input)));
  paths.push('apps/markdown/src/renderer/export/exportImage.ts','apps/markdown/src/renderer/export/printHtml.ts','apps/markdown/src/renderer/export/imageExport.ts','apps/markdown/src/shared/export-image-mime.ts');
  for(const relative of new Set(paths)){
    const bytes=await readFile(path.join(source,relative));const existing=locked.files.find(entry=>entry.path===relative);
    if(existing&&existing.sha256!==sha(bytes))throw Error(`Fixed source mismatch: ${relative}`);
    if(!existing)locked.files.push({path:relative,sha256:sha(bytes),...((relative.includes('/docxExport.')||relative.includes('/imageExport.')||!relative.includes('/renderer/'))?{referenceOnly:true}:{})});
    const output=path.join(root,'upstream',relative);await mkdir(path.dirname(output),{recursive:true});await writeFile(output,bytes);
  }
  await writeFile(path.join(root,'source-lock.json'),JSON.stringify(locked,null,2)+'\n');
}
for(const entry of locked.files){const bytes=await readFile(path.join(root,'upstream',entry.path));if(sha(bytes)!==entry.sha256)throw Error(`Fixed source mismatch: ${entry.path}`);}
const result=await bundle(path.join(root,'upstream'));
const bytes=result.outputFiles[0].contents;
if(process.argv.includes('--check')){if(sha(await readFile(target))!==sha(bytes))throw Error('Rebuild upstream-docx.mjs with npm run build:exports');}
else await writeFile(target,bytes);
const dependencies=new Map();
for(const input of Object.keys(result.metafile.inputs)){
  const absolute=path.resolve(root,input);
  if(absolute.startsWith(path.join(root,'upstream')+path.sep)&&!locked.files.some(entry=>path.join(root,'upstream',entry.path)===absolute))throw Error(`Unpinned export input: ${input}`);
  const dependency=dependencyPackage(absolute);
  if(dependency)dependencies.set(dependency.name,dependency.directory);
}
const notices=['# DOCX export bundled dependencies','',`GenOffice ${locked.commit}: Apache-2.0; see upstream/LICENSE and upstream/NOTICE.`, ''];
for(const [name,directory]of [...dependencies].sort(([a],[b])=>a.localeCompare(b))){
  const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));const files=(await readdir(directory)).filter(name=>/^(?:licen[sc]e|copying|notice)(?:\.|$)/iu.test(name)).sort();
  notices.push(`## ${name} ${pkg.version}`,`License: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license)}`,'');
  for(const file of files)notices.push(`### ${file}`,'',await readFile(path.join(directory,file),'utf8'),'');
}
const notice=notices.join('\n');const noticePath=path.join(root,'EXPORT-THIRD-PARTY-NOTICES.md');
if(process.argv.includes('--check')){if(await readFile(noticePath,'utf8')!==notice)throw Error('Export dependency notices drift');}else await writeFile(noticePath,notice);
console.log(`Verified fixed-source DOCX export bundle (${bytes.length} bytes).`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();

import {build} from 'vite';
import {writeFile} from 'node:fs/promises';
// Normal shipping graph, with only an observational generateBundle hook.
if(process.env.OFFICE_PERFORMANCE==='1')throw Error('Use normal shipping entries for this graph');
await build({logLevel:'warn',plugins:[{name:'capture-host-build-boundaries',generateBundle(_,bundle){
 const chunks=Object.values(bundle).filter(item=>item.type==='chunk').map(chunk=>({file:chunk.fileName,name:chunk.name,facade:chunk.facadeModuleId,entry:chunk.isEntry,dynamicEntry:chunk.isDynamicEntry,bytes:Buffer.byteLength(chunk.code),imports:chunk.imports,dynamicImports:chunk.dynamicImports,modules:Object.keys(chunk.modules)}));
 return writeFile(new URL('./output/host-bundle-after.json',import.meta.url),JSON.stringify({qualification:'normal-production-build-static-graph',chunks},null,2));
}}]});

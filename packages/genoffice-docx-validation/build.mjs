import {build} from 'esbuild';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname);
const names=['docx-engine','pptx-engine','pptx-render','zip-gate','ui','i18n','font-metrics'];
const alias=Object.fromEntries(names.map(n=>['@genoffice/'+n,root+'/upstream/packages/'+n+'/src/index.ts']));
alias['@genoffice/pptx-engine/custgeom']=root+'/upstream/packages/pptx-engine/src/custgeom.ts';
alias['@genoffice/pptx-render/preset-geometry']=root+'/upstream/packages/pptx-render/src/preset-geometry.ts';
alias['@genoffice/pptx-render/metrics']=root+'/upstream/packages/pptx-render/src/metrics.ts';
alias['@genoffice/ai-provider/browser']=root+'/upstream/packages/ai-provider/src/browser.ts';
alias['@genoffice/agent-core/redact-core']=root+'/upstream/packages/agent-core/src/redact-core.ts';
const common={bundle:true,format:'esm',target:'es2022',alias,treeShaking:true,metafile:true,jsx:'automatic',logLevel:'warning'};
for(const [entry,out,platform] of [['validate.ts','build/validate.mjs','node'],['prototype.ts','build/prototype.mjs','node'],['prototype.ts','build/prototype.browser.js','browser']]) {
 const result=await build({...common,entryPoints:[entry],outfile:out,platform,packages:platform==='node'?'external':undefined});
 const {writeFile,mkdir}=await import('node:fs/promises');await mkdir('build',{recursive:true});await writeFile(out+'.meta.json',JSON.stringify(result.metafile,null,2));
}
console.log('Built unchanged public sources; engine and converter bundles ready');

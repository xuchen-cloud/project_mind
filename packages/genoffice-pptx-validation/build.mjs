import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const root=dirname(fileURLToPath(import.meta.url));
await mkdir(`${root}/build`,{recursive:true});
for(const [entry,name] of [['upstream/packages/pptx-engine/src/index.ts','pptx-engine'],['browser/backend.ts','backend']]) {
  const result=await build({absWorkingDir:root,entryPoints:[entry],bundle:true,platform:'node',format:'esm',outfile:`build/${name}.mjs`,metafile:true});
  await writeFile(`${root}/build/${name==='pptx-engine'?'engine':name}-metafile.json`,JSON.stringify(result.metafile,null,2));
  const ee=Object.keys(result.metafile.inputs).filter(p=>p.startsWith('ee/')||p.includes('/ee/'));
  if(ee.length)throw new Error(`Unexpected ee input: ${ee.join(',')}`);
  console.log(`Built ${name}.mjs, ${Object.keys(result.metafile.inputs).length} inputs; no ee`);
}

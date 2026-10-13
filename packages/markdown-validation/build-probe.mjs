import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
await mkdir(new URL('./build/',import.meta.url),{recursive:true});
const result=await build({entryPoints:[new URL('./entry.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'headless-css-only',setup(b){b.onResolve({filter:/\.css$/},args=>({path:args.path,namespace:'headless-css'}));b.onLoad({filter:/.*/,namespace:'headless-css'},()=>({contents:'export default {}',loader:'js'}));}}],loader:{'.svg':'text','.woff2':'empty','.ttf':'empty'},outfile:new URL('./build/entry.mjs',import.meta.url).pathname,metafile:true});
await writeFile(new URL('./build/metafile.json',import.meta.url),JSON.stringify(result.metafile,null,2));
console.log(`Bundled ${Object.keys(result.metafile.inputs).length} local sources for headless probe`);

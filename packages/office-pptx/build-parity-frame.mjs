import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {parityPlugins} from './parity-build.mjs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
export async function buildParityFrame(){
 const out=await build({absWorkingDir:root,entryPoints:['parity-entry.tsx'],bundle:true,platform:'browser',format:'iife',target:'es2022',jsx:'automatic',write:false,minify:true,metafile:true,plugins:parityPlugins(root,{browser:true}),inject:[`${root}/browser-globals.ts`],loader:{'.ttf':'dataurl','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl','.css':'css'},outfile:'frame.js',define:{'process.env.NODE_ENV':'"production"'},legalComments:'inline'});
 const js=out.outputFiles.find(f=>f.path.endsWith('.js')).text;
 const css=out.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'';
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 await writeFile(`${root}/dist/frame-metafile.json`,JSON.stringify(out.metafile,null,2)+'\n');
 await writeFile(`${root}/parity-html.ts`,`// Generated self-contained upstream renderer frame.\nexport const parityHtml=${JSON.stringify(html)};\n`);
 return out.metafile;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildParityFrame();

import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parityPlugins} from './parity-build.mjs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
export async function buildParityFrame(){
 const out=await build({absWorkingDir:root,entryPoints:['parity-entry.tsx'],bundle:true,platform:'browser',format:'iife',target:'es2022',jsx:'automatic',write:false,minify:true,metafile:true,plugins:parityPlugins(root,{browser:true}),inject:[`${root}/browser-globals.ts`],loader:{'.ttf':'dataurl','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl','.css':'css'},outfile:'frame.js',define:{'process.env.NODE_ENV':'"production"'},legalComments:'inline'});
 const js=out.outputFiles.find(f=>f.path.endsWith('.js')).text;
 const css=(out.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'')+'\n'+await readFile(`${root}/../editor-chrome/status-bar.css`,'utf8')+'\n'+await readFile(`${root}/../editor-chrome/editor-chrome.css`,'utf8');
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 await writeFile(`${root}/dist/frame-metafile.json`,JSON.stringify(out.metafile,null,2)+'\n');
 await writeFile(`${root}/parity-html.ts`,`// Generated self-contained upstream renderer frame.\nexport const parityHtml=${JSON.stringify(html)};\n`);
 // Keep the legacy standalone API while the product loads the same renderer
 // from separately cached files. Decode font data only at build time.
 const files=['renderer.html','renderer.mjs','renderer.css'];
 await mkdir(`${root}/dist/renderer-fonts`,{recursive:true});
 let externalCss=css;
 for(const match of css.matchAll(/url\(["']?(data:([^;,]+)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+))["']?\)/g)){
  if(!/font|octet-stream/.test(match[2]))continue;
  const bytes=Buffer.from(match[3],'base64'),magic=bytes.subarray(0,4).toString();
  const extension=magic==='wOF2'?'woff2':magic==='wOFF'?'woff':magic==='OTTO'?'otf':'ttf';
  const name=`renderer-fonts/${createHash('sha256').update(bytes).digest('hex').slice(0,20)}.${extension}`;
  await writeFile(`${root}/dist/${name}`,bytes);files.push(name);
  externalCss=externalCss.replace(match[0],`url("./${name}")`);
 }
 await writeFile(`${root}/dist/renderer.mjs`,js);
 await writeFile(`${root}/dist/renderer.css`,externalCss);
 const resourceErrors="addEventListener('error',event=>{const target=event.target;if(target instanceof HTMLScriptElement||target instanceof HTMLLinkElement)parent.postMessage({source:'project-mind-pptx',type:'resource-error',message:'PPTX renderer resource failed: '+(target.src||target.href)},'*')},true);";
 await writeFile(`${root}/dist/renderer.html`,'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script>'+resourceErrors+'</script><link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div><script type="module" src="./renderer.mjs"></script></body></html>');
 await writeFile(`${root}/dist/renderer-resources.json`,JSON.stringify({entry:'renderer.html',files:[...new Set(files)].sort()},null,2)+'\n');
 return out.metafile;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildParityFrame();

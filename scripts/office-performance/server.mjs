import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
const root=resolve(import.meta.dirname,'../..');
const mime={'.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.json':'application/json'};
export async function rendererContracts(artifactRoot){
 const contracts={};
 for(const format of ['docx','xlsx','pptx']){
  const directory=resolve(artifactRoot,`packages/office-${format}/dist`),base=`/packages/office-${format}/dist/`;
  let manifest;
  try{manifest=JSON.parse(await readFile(resolve(directory,'renderer-resources.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  const apiEntry=format==='pptx'&&manifest?null:format==='docx'&&manifest?'full-editor.mjs':format==='docx'?'editor.mjs':'browser.mjs';
  if(apiEntry)await stat(resolve(directory,apiEntry));
  const contract={apiEntry:apiEntry?base+apiEntry:null,externalRenderer:!!manifest,rendererUrl:null,resourceModule:null,hints:[]};
  if(manifest){
   if(!manifest.files.includes(manifest.entry))throw Error('Renderer manifest omits its entry: '+format);
   contract.rendererUrl=base+manifest.entry;contract.resourceModule=`/renderer-resource/${format}.mjs`;
   const html=await readFile(resolve(directory,manifest.entry),'utf8');
   contract.hints=[...[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m=>[m[1],'modulepreload','script']),...[...html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["']/gi)].map(m=>[m[1],'modulepreload','script']),...[...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)].map(m=>[m[1],'preload','style'])];
  }
  contracts[format]=contract;
 }
 return contracts;
}
export async function startServer({samples,artifactRoot=root}){
 const contracts=await rendererContracts(artifactRoot);
 const engines=new Map(),allowed=new Map(samples.map(s=>[s.id,s]));const engineFor=async format=>{
  if(!engines.has(format))engines.set(format,import(pathToFileURL(resolve(artifactRoot,`packages/office-${format}/dist/engine.mjs`)).href));return engines.get(format);
 };
 const server=createServer(async(req,res)=>{
  const start=performance.now();
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/harness-config'){res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(contracts));return}
   if(url.pathname.startsWith('/renderer-resource/')){
    const format=url.pathname.split('/').at(-1).replace(/\.mjs$/,''),contract=contracts[format];
    if(!contract?.externalRenderer)throw Error('No external renderer manifest for '+format);
    res.setHeader('Content-Type','text/javascript');res.setHeader('Cache-Control','no-store');
    res.end(`const url=${JSON.stringify(contract.rendererUrl)};export default url;export function preload(){const links=${JSON.stringify(contract.hints)}.map(([path,rel,as])=>{const link=document.createElement('link');link.rel=rel;link.as=as;link.href=new URL(path,new URL(url,document.baseURI)).href;document.head.append(link);return link});return ()=>links.forEach(link=>link.remove())}`);return;
   }
   if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return}
   if(url.pathname==='/inspect'||url.pathname==='/recalculate'){
    const sample=allowed.get(url.searchParams.get('id'));if(!sample)throw Error('Unknown fixture');
    const t=performance.now(),bytes=await readFile(sample.path),readMs=performance.now()-t;
    const i=performance.now(),engine=await engineFor(sample.format),engineImportMs=performance.now()-i;
    const e=performance.now();let value;
    if(url.pathname==='/inspect')value=await engine.inspect(new Uint8Array(bytes));
    else{let body='';for await(const chunk of req)body+=chunk;if(body.length>8_000_000)throw Error('Recalculate request exceeds budget');value=await engine.recalculate(new Uint8Array(bytes),JSON.parse(body))}
    const engineMs=performance.now()-e;
    let formulaExpectations;
    if(sample.format==='xlsx'&&url.pathname==='/inspect'){
     const require=createRequire(resolve(root,'packages/office-xlsx/package.json')),numfmt=require('numfmt');
     formulaExpectations=Object.entries(value.ranges).flatMap(([sheetId,range])=>range.cells.filter(c=>c.formula).map(c=>({sheetId,row:c.row,column:c.column,value:c.value,formula:c.formula,formatted:typeof c.value==='number'?numfmt.format(value.styles[c.styleIndex??0]?.numberFormat??'General',c.value):String(c.value??'')})));
    }
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({value,formulaExpectations,timings:{readMs,engineImportMs,engineMs,serverMs:performance.now()-start},bytes:bytes.length}));return;
   }
   if(url.pathname.startsWith('/deps/')){
    const jsx=url.pathname.includes('jsx');const require=createRequire(resolve(root,'packages/office-pptx/package.json'));
    const packageRoot=resolve(require.resolve('react/package.json'),'..');
    const raw=await readFile(resolve(packageRoot,`cjs/react${jsx?'-jsx-runtime':''}.production.js`),'utf8');
    const names=jsx?['jsx','jsxs','Fragment']:['useId','useRef','useState'];
    res.setHeader('Content-Type','text/javascript');res.end(`${jsx?"import * as React from '/deps/react.mjs';const require=()=>React;":''}const exports={};\n${raw}\n${names.map(n=>`export const ${n}=exports.${n};`).join('\n')}`);return;
   }
   const isDist=url.pathname.startsWith('/packages/'),relative=isDist?url.pathname.slice(1):url.pathname==='/'?'harness.html':url.pathname.slice(1);
   if(isDist&&!/^packages\/office-(docx|pptx|xlsx)\/dist\//.test(relative))throw Error('Not a dist resource');
   const base=isDist?resolve(artifactRoot):import.meta.dirname,path=resolve(base,relative);
   if(!path.startsWith(base+sep))throw Error('Invalid path');
   const info=await stat(path);if(!info.isFile())throw Error('Not a file');
   res.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream');
   // Browser HTTP cache may warm within a session. New processes get a new context/cache.
   res.setHeader('Cache-Control',isDist?'public, max-age=3600':'no-store');
   res.end(await readFile(path));
  }catch(error){res.statusCode=500;res.setHeader('Content-Type','text/plain');res.end(error.stack??String(error))}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {contracts,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise((r,j)=>server.close(e=>e?j(e):r()))};
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat,readdir} from 'node:fs/promises';
import {resolve,dirname,basename,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {init,parse} from 'es-module-lexer';
// Inspect the current build directly; no ignored agent-generated graph fixture.
await init;
const dist=fileURLToPath(new URL('../../dist/',import.meta.url));
const assets=resolve(dist,'assets');
const cache=new Map();
async function closure(file,visited=new Set()){
 file=resolve(dist,file.replace(/^\//,''));
 if(visited.has(file)||!file.endsWith('.js'))return visited;
 visited.add(file);
 let imports=cache.get(file);
 if(!imports){
  const source=await readFile(file,'utf8');
  imports=parse(source)[0].filter(item=>item.d===-1&&item.n&&(item.n.startsWith('.')||item.n.startsWith('/'))).map(item=>item.n.startsWith('/')?resolve(dist,item.n.slice(1)):resolve(dirname(file),item.n));
  cache.set(file,imports);
 }
 for(const dependency of imports)await closure(dependency.startsWith(dist)?relative(dist,dependency):dependency,visited);
 return visited;
}
const names=await readdir(assets);
for(const name of ['OfficeFileContent','DocxEditor','XlsxEditor','PptxEditor'])test(`${name} production static graph executes no Record rich-editor or Tiptap chunk`,async()=>{
 const entry=names.find(file=>file.startsWith(name+'-')&&file.endsWith('.js'));
 assert.ok(entry,`production root ${name} exists; build first`);
 const files=[...await closure('assets/'+entry)];
 assert.deepEqual(files.filter(file=>/^(?:rich-editor|editor)-/u.test(basename(file))),[]);
});
test('normal startup keeps format editors lazy and main within 250 KiB',async()=>{
 const html=await readFile(resolve(dist,'index.html'),'utf8');
 const main=html.match(/<script[^>]+src="([^"]+)"/u)?.[1];assert.ok(main);
 assert.ok((await stat(resolve(dist,main.replace(/^\//,'')))).size<=250*1024,'main script budget');
 const roots=[main,...[...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/gu)].map(match=>match[1])];
 const files=new Set();for(const entry of roots)for(const file of await closure(entry))files.add(file);
 assert.deepEqual([...files].filter(file=>/^(?:OfficeFileContent|DocxEditor|XlsxEditor|PptxEditor|renderer\.html)-/u.test(basename(file))),[],'no Office host, format component or renderer resource module executes on startup');
});

test('shipping compilation strips host marks and measurement compilation retains them',async()=>{
 const {rolldown}=await import('rolldown');
 for(const path of ['src/components/office/office-component-loader.ts','src/components/office/OfficeFileContent.tsx']){
  for(const enabled of [false,true]){
   const bundle=await rolldown({input:new URL('../../'+path,import.meta.url).pathname,external:()=>true,transform:{define:{'import.meta.env.OFFICE_PERFORMANCE':String(enabled)}}});
   const {output}=await bundle.generate({format:'esm',minify:true});await bundle.close();
   const code=output.filter(item=>item.type==='chunk').map(item=>item.code).join('');
   assert.equal(code.includes('office-component:'),enabled,path+' uses the compile-time measurement gate');
  }
 }
});

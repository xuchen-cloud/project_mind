/** Explicit, opt-in headless acceptance host. Never started by build or npm test. */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { inspect, edit } from '../dist/engine.mjs';
import { poisonedLinksFixture } from './fixtures/poisoned-links.mjs';
import {altChunkFixture,richAltChunkHtml} from './fixtures/alt-chunk.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'test/output/browser');
const rendererManifest=JSON.parse(await readFile(resolve(root,'dist/renderer-resources.json'),'utf8'));
const rendererFiles=new Set(rendererManifest.files);
const rendererMime=file=>({'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'}[extname(file)]??'application/octet-stream');
const resourcePlugin={name:'acceptance-office-resource',setup(builder){
  builder.onResolve({filter:/renderer\.html\?office-resource$/},()=>({path:'renderer',namespace:'office-resource'}));
  builder.onLoad({filter:/.*/,namespace:'office-resource'},()=>({contents:'export default "/word-renderer/renderer.html";',loader:'js'}));
}};
await mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['test/browser-harness.tsx'], outfile: 'test/output/browser/harness.mjs',
  platform: 'browser', format: 'esm', target: 'es2022', bundle: true, jsx: 'automatic', logLevel: 'warning',
  alias: { react: resolve(root, 'node_modules/react'), 'react-dom': resolve(root, 'node_modules/react-dom') },
  define: { 'process.env.NODE_ENV': '"production"' },plugins:[resourcePlugin],
});
await build({absWorkingDir:root,entryPoints:['test/lifecycle-harness.ts'],outfile:'test/output/browser/lifecycle.mjs',platform:'browser',format:'esm',target:'es2022',bundle:true,logLevel:'warning'});
await build({absWorkingDir:root,entryPoints:['test/presentation-harness.ts'],outfile:'test/output/browser/presentation.mjs',platform:'browser',format:'esm',target:'es2022',bundle:true,logLevel:'warning'});
const css = await readFile(resolve(root, '../../src/styles/app.css'), 'utf8');
const tokens = css.slice(css.indexOf(':root {'), css.indexOf('\n}\n', css.indexOf(':root {')) + 2);
await writeFile(resolve(out, 'tokens.css'), tokens + '\nhtml,body,#root{height:100%;margin:0;}*{box-sizing:border-box;}');
const originalBytes = process.env.OFFICE_DOCX_ALT_CHUNK ? await altChunkFixture(process.env.OFFICE_DOCX_ALT_CHUNK==='rich'?richAltChunkHtml:undefined) : process.env.OFFICE_DOCX_POISONED_LINKS === '1' ? await poisonedLinksFixture()
  : new Uint8Array(await readFile(resolve(root, 'test/fixtures/complex.original.docx')));
let bytes=originalBytes;
const routes = { '/harness.mjs': ['harness.mjs', 'text/javascript'], '/presentation.mjs':['presentation.mjs','text/javascript'], '/lifecycle.mjs':['lifecycle.mjs','text/javascript'], '/harness.css': ['harness.css', 'text/css'], '/tokens.css': ['tokens.css', 'text/css'] };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.url === '/reset'&&request.method==='POST') { bytes=originalBytes;response.end('reset'); }
    else if(request.url==='/bytes'){response.setHeader('content-type','application/octet-stream');response.end(bytes);}
    // Explicit integration fixture only: exercise the helper's own built bundle,
    // without adding an alias or dependency to the production Word renderer.
    else if(pathname==='/html2docx.mjs'&&process.env.OFFICE_DOCX_ALT_CHUNK){response.setHeader('content-type','text/javascript');response.end(await readFile(resolve(root,'../office-html2docx/dist/index.mjs')));}
    else if(request.url==='/export'&&request.method==='POST'){
      let body='';for await(const chunk of request)body+=chunk;
      const file=JSON.parse(body);if(!file.name||/[\/\\]/.test(file.name))throw Error('invalid test export name');
      await writeFile(resolve(out,file.name),new Uint8Array(file.bytes));response.end('written');
    }
    else if(request.url==='/print'&&request.method==='POST'){
      let body='';for await(const chunk of request)body+=chunk;
      await writeFile(resolve(out,'native-print.html'),JSON.parse(body).html);response.end('printed');
    }
    else if (request.url === '/model') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await inspect(bytes))); }
    else if (request.url === '/save' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      bytes = await edit(bytes, JSON.parse(body).edits);
      await writeFile(resolve(out, 'saved.docx'), bytes);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ model: await inspect(bytes) }));
    } else if (pathname === '/'||pathname==='/lifecycle'||pathname==='/presentation') {
      response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/'+(pathname==='/presentation'?'presentation':pathname==='/lifecycle'?'lifecycle':'harness')+'.mjs"></script></html>');
    } else if(pathname==='/standalone'){
      response.setHeader('content-type','text/html');
      response.end('<!doctype html><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/harness.css"><div id="root" class="office-docx"><div class="office-docx__embed"></div></div><script type="module">import {mountFullEditor} from "/word-package/full-editor.mjs";window.standalone=mountFullEditor(document.querySelector(".office-docx__embed"),{model:await(await fetch("/model")).json(),edits:[],onChange:()=>{}});</script>');
    } else if(pathname==='/word-package/full-editor.mjs'){
      response.setHeader('content-type','text/javascript');response.end(await readFile(resolve(root,'dist/full-editor.mjs')));
    } else if(pathname.startsWith('/word-package/')&&rendererFiles.has(pathname.slice('/word-package/'.length))){
      const file=pathname.slice('/word-package/'.length);
      response.setHeader('content-type',rendererMime(file));response.end(await readFile(resolve(root,'dist',file)));
    } else if(pathname.startsWith('/word-renderer/')&&rendererFiles.has(pathname.slice('/word-renderer/'.length))){
      const file=pathname.slice('/word-renderer/'.length);
      response.setHeader('content-type',rendererMime(file));response.end(await readFile(resolve(root,'dist',file)));
    } else if (routes[request.url]) {
      const [name, mime] = routes[request.url]; response.setHeader('content-type', mime); response.end(await readFile(resolve(out, name)));
    } else { response.statusCode = 404; response.end(); }
  } catch (error) { response.statusCode = 400; response.end(String(error)); }
});
server.listen(0, '127.0.0.1', () => console.log(`DOCX acceptance: http://127.0.0.1:${server.address().port}`));

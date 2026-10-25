/** Explicit, headless rendering acceptance for generated complex Word bytes. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {extname} from 'node:path';
import {create,inspect} from '../dist/engine.mjs';
import {complexAuthoringContent} from './fixtures/authoring.mjs';
const playwright=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const bytes=await create(await complexAuthoringContent()),model=await inspect(bytes);
const dist=new URL('../dist/',import.meta.url),manifest=JSON.parse(await readFile(new URL('renderer-resources.json',dist)));
const files=new Set([...manifest.files,'full-editor.mjs']);
const server=createServer(async(req,res)=>{try{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><style>html,body,#editor{height:100%;margin:0}#editor iframe{width:100%;height:100%;border:0}</style><div id="editor"></div><script type="module">import {mountFullEditor} from "/full-editor.mjs";window.controller=mountFullEditor(document.querySelector("#editor"),{model:await(await fetch("/model")).json(),edits:[],readOnly:true,presentationMode:"preview",onChange(){},onError(message){window.authoringError=message;}});await window.controller.ready;window.authoringReady=true;</script>');}
  else if(req.url==='/model'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(model));}
  else if(files.has(req.url.slice(1))){res.setHeader('Content-Type',({'.mjs':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.json':'application/json'})[extname(req.url)]??'application/octet-stream');res.end(await readFile(new URL(req.url.slice(1),dist)));}
  else {res.statusCode=404;res.end();}
}catch(e){res.statusCode=500;res.end(String(e));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await playwright.chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.authoringReady||window.authoringError,{timeout:30000});
 assert.equal(await page.evaluate(()=>window.authoringError),undefined);
 const frame=page.frameLocator('iframe');await frame.locator('.tiptap.doc-page').first().waitFor();
 assert.ok((await frame.locator('body').innerText()).includes('季度经营报告'));
 assert.ok((await frame.locator('table').count())>=1);
 assert.ok((await frame.locator('img.doc-protected-img').count())>=1);
 assert.deepEqual(errors,[]);
 const out=new URL('output/browser/',import.meta.url);await mkdir(out,{recursive:true});
 await frame.locator('.doc-page').first().screenshot({path:new URL('authoring-complex-chromium.png',out).pathname});
 await writeFile(new URL('authoring-complex.docx',out),bytes);
 const result={browser:browser.version(),nativeTable:true,inlinePicture:true,chartOOXML:model.authoring.blocks.some(b=>b.kind==='chart'),headersFooters:model.authoring.headersFooters,errors};
 await writeFile(new URL('authoring-complex-results.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

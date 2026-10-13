import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const assets={'/':'browser/index.html','/main.js':'browser/main.js','/prototype.js':'build/prototype.browser.js','/simple.docx':'fixtures/simple.original.docx','/complex.docx':'fixtures/complex.original.docx'};
http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://127.0.0.1');
 if(u.pathname==='/save'&&req.method==='POST'){
  const kind=u.searchParams.get('kind'), engine=u.searchParams.get('engine');
  if(!['simple','complex'].includes(kind)||!['chromium','webkit'].includes(engine))throw Error('Unsupported fixture/browser');
  const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);
  await mkdir(`${root}/browser/output/${engine}`,{recursive:true});
  await writeFile(`${root}/browser/output/${engine}/${kind}.browser-edited.docx`,bytes);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({bytes:bytes.length,candidate:`browser/output/${engine}/${kind}.browser-edited.docx`}));return;
 }
 if(req.method!=='GET'||!assets[u.pathname]){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.docx')?'application/octet-stream':'text/html');
 res.end(await readFile(resolve(root,assets[u.pathname])));
}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}}).listen(1440,'127.0.0.1',()=>console.log('GenOffice DOCX thin host on 127.0.0.1:1440'));

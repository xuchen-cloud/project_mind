import {officeRendererResources} from '../../../../scripts/office-renderer-resources.mjs';
import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { inspectView, inspect, edit } from '../../dist/engine.mjs';
const progressive=process.env.OFFICE_PPTX_PROGRESSIVE==='1';
let fixture = new Uint8Array(await readFile(new URL('../fixtures/complex.pptx', import.meta.url)));
if(progressive){
  const zip=await JSZip.loadAsync(fixture);
  const source=await zip.file('ppt/slides/slide3.xml').async('string');
  const rels=await zip.file('ppt/slides/_rels/slide3.xml.rels').async('string');
  let pres=await zip.file('ppt/presentation.xml').async('string');
  let presRels=await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  let types=await zip.file('[Content_Types].xml').async('string');
  for(let n=4;n<=48;n++){
    zip.file(`ppt/slides/slide${n}.xml`,source.replaceAll('第三页原文。',`第${n}页原文。`));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`,rels);
    pres=pres.replace('</p:sldIdLst>',`<p:sldId id="${1000+n}" r:id="pm${n}"/></p:sldIdLst>`);
    presRels=presRels.replace('</Relationships>',`<Relationship Id="pm${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`);
    types=types.replace('</Types>',`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  }
  zip.file('ppt/presentation.xml',pres);zip.file('ppt/_rels/presentation.xml.rels',presRels);zip.file('[Content_Types].xml',types);
  fixture=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
let bytes=fixture;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [officeRendererResources(),tailwind(), { name: 'office-pptx-fixture', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (!['/model','/view-model','/save','/reset','/bytes','/source-bytes'].includes(request.url)) return next();
      try {
        if(request.url==='/reset')bytes=fixture;
        if(request.url==='/bytes'||request.url==='/source-bytes'){response.setHeader('content-type','application/octet-stream');response.end(Buffer.from(request.url==='/bytes'?bytes:fixture));return}
        if (request.url === '/save' && request.method === 'POST') {
          let body = ''; for await (const chunk of request) body += chunk;
          bytes = await edit(bytes, JSON.parse(body).edits);
        }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await (request.url==='/view-model'||progressive&&request.url!=='/model'?inspectView:inspect)(bytes)));
      } catch (error) { response.statusCode = 400; response.end(String(error)); }
    });
  } }],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 0, open: false, watch: { ignored: ['**/output/**'] }, fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] } },
});

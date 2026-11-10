/** Opt-in real renderer/engine host; never start it from build/unit tests. */
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {build} from 'esbuild';
import {inspectView, edit} from '../dist/engine.mjs';
import {largeFixture} from './fixtures/progressive.mjs';
const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'test/output/browser'), {recursive: true});
await build({absWorkingDir: root, entryPoints: ['test/progressive-harness.ts'], outfile: 'test/output/browser/progressive-harness.mjs', bundle: true, format: 'esm', platform: 'browser', logLevel: 'warning'});
const original = (await largeFixture()).bytes;
let bytes = original;
const manifest = new Set(JSON.parse(await readFile(resolve(root, 'dist/renderer-resources.json'))).files);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/model') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await inspectView(bytes))); }
    else if (path === '/bytes' || path === '/original') { response.end(path === '/bytes' ? bytes : original); }
    else if (path === '/save' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      bytes = await edit(bytes, JSON.parse(body).edits);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await inspectView(bytes)));
    } else if (path === '/reset' && request.method === 'POST') { bytes = original; response.end('reset'); }
    else if (path === '/progressive-harness.mjs') { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(resolve(root, 'test/output/browser/progressive-harness.mjs'))); }
    else if (path.startsWith('/word-renderer/') && manifest.has(path.slice(15))) {
      response.setHeader('content-type', ({'.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2'}[extname(path)] ?? 'application/octet-stream'));
      response.end(await readFile(resolve(root, 'dist', path.slice(15))));
    } else if (path === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}#root{display:flex}iframe{border:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="/progressive-harness.mjs"></script>');
    } else { response.statusCode = 404; response.end(); }
  } catch (error) { response.statusCode = 400; response.end(String(error)); }
});
server.listen(0, '127.0.0.1', () => console.log(`DOCX progressive: http://127.0.0.1:${server.address().port}`));

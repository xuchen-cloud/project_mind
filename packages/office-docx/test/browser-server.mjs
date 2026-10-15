/** Explicit, opt-in headless acceptance host. Never started by build or npm test. */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { inspect, edit } from '../dist/engine.mjs';
import { poisonedLinksFixture } from './fixtures/poisoned-links.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'test/output/browser');
await mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['test/browser-harness.tsx'], outfile: 'test/output/browser/harness.mjs',
  platform: 'browser', format: 'esm', target: 'es2022', bundle: true, jsx: 'automatic', logLevel: 'warning',
  alias: { react: resolve(root, 'node_modules/react'), 'react-dom': resolve(root, 'node_modules/react-dom') },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await readFile(resolve(root, '../../src/styles/app.css'), 'utf8');
const tokens = css.slice(css.indexOf(':root {'), css.indexOf('\n}\n', css.indexOf(':root {')) + 2);
await writeFile(resolve(out, 'tokens.css'), tokens + '\nhtml,body,#root{height:100%;margin:0;}*{box-sizing:border-box;}');
let bytes = process.env.OFFICE_DOCX_POISONED_LINKS === '1' ? await poisonedLinksFixture()
  : new Uint8Array(await readFile(resolve(root, 'test/fixtures/complex.original.docx')));
const routes = { '/harness.mjs': ['harness.mjs', 'text/javascript'], '/harness.css': ['harness.css', 'text/css'], '/tokens.css': ['tokens.css', 'text/css'] };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.url === '/model') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await inspect(bytes))); }
    else if (request.url === '/save' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      bytes = await edit(bytes, JSON.parse(body).edits);
      await writeFile(resolve(out, 'saved.docx'), bytes);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ model: await inspect(bytes) }));
    } else if (pathname === '/') {
      response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.mjs"></script></html>');
    } else if (routes[request.url]) {
      const [name, mime] = routes[request.url]; response.setHeader('content-type', mime); response.end(await readFile(resolve(out, name)));
    } else { response.statusCode = 404; response.end(); }
  } catch (error) { response.statusCode = 400; response.end(String(error)); }
});
server.listen(0, '127.0.0.1', () => console.log(`DOCX acceptance: http://127.0.0.1:${server.address().port}`));

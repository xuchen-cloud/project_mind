import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { inspect, edit } from '../../dist/engine.mjs';
const fixture = new Uint8Array(await readFile(new URL('../fixtures/complex.pptx', import.meta.url)));
let bytes=fixture;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tailwind(), { name: 'office-pptx-fixture', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/model' && request.url !== '/save' && request.url !== '/reset') return next();
      try {
        if(request.url==='/reset')bytes=fixture;
        if (request.url === '/save' && request.method === 'POST') {
          let body = ''; for await (const chunk of request) body += chunk;
          bytes = await edit(bytes, JSON.parse(body).edits);
        }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await inspect(bytes)));
      } catch (error) { response.statusCode = 400; response.end(String(error)); }
    });
  } }],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 0, open: false, watch: { ignored: ['**/output/**'] }, fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] } },
});

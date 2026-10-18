import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {build, createServer} from 'vite';
import {officeRendererResources} from './office-renderer-resources.mjs';

async function fixture(run) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'office-resources-')));
  try {
    await mkdir(resolve(root, 'renderer/fonts'), {recursive:true});
    for (const [name, bytes] of Object.entries({
      'index.html':'<script type="module" src="/main.js"></script>',
      'main.js':'window.openRenderer = () => import("./lazy.js");',
      'lazy.js':'import url from "./renderer/renderer.html?office-resource"; export default url;',
      'renderer/renderer.html':'<link rel="stylesheet" href="screen.css"><link rel="modulepreload" href="main.mjs"><script type="module" src="renderer.mjs"></script>',
      'renderer/renderer.mjs':'window.rendererLoaded = true;',
      'renderer/main.mjs':'window.mainExecuted = true;',
      'renderer/screen.css':'@font-face {font-family:Office;src:url(fonts/regular.woff2)}',
      'renderer/fonts/regular.woff2':'font-byte-witness',
      'renderer/renderer-resources.json':JSON.stringify({entry:'renderer.html',files:['renderer.html','renderer.mjs','main.mjs','screen.css','fonts/regular.woff2']}),
    })) await writeFile(resolve(root, name), bytes);
    await run(root);
  } finally { await rm(root, {recursive:true, force:true}); }
}

test('production stages byte-exact renderer tree, keeps host lazy and invalidates changed assets', async () => fixture(async root => {
  const compile = () => build({configFile:false, root, logLevel:'silent', plugins:[officeRendererResources()]});
  await compile();
  const assets = resolve(root, 'dist/assets');
  const first = (await readdir(assets)).find(name => name.startsWith('office-'));
  assert.ok(first);
  assert.equal(await readFile(resolve(assets, first, 'fonts/regular.woff2'), 'utf8'), 'font-byte-witness');
  assert.equal(await readFile(resolve(assets, first, 'renderer.html'), 'utf8'), await readFile(resolve(root, 'renderer/renderer.html'), 'utf8'));
  const index = await readFile(resolve(root, 'dist/index.html'), 'utf8');
  assert.doesNotMatch(index, /office-|renderer\.mjs|rel="modulepreload"/);
  const lazy = (await readdir(assets)).find(name => name.startsWith('lazy-'));
  assert.match(await readFile(resolve(assets, lazy), 'utf8'), new RegExp(first + '/renderer.html'));
  await writeFile(resolve(root, 'renderer/fonts/regular.woff2'), 'changed-font-bytes');
  await compile();
  assert.notEqual((await readdir(assets)).find(name => name.startsWith('office-')), first);
}));

test('development serves complete renderer dependencies with correct MIME and rejects unlisted paths', async () => fixture(async root => {
  const server = await createServer({configFile:false, root, logLevel:'silent', plugins:[officeRendererResources()], server:{host:'127.0.0.1',port:0}});
  try {
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    const lazy = await (await fetch(new URL('lazy.js', origin))).text();
    const imported = lazy.match(/import url from "([^"]+)"/)[1];
    const module = await (await fetch(new URL(imported, origin))).text();
    assert.match(module, /export default/, module);
    assert.match(module, /\["main.mjs","modulepreload","script"\]/);
    const path = module.match(/const url\s*=\s*"([^"]+)"/)[1];
    const page = await fetch(new URL(path, origin));
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(await page.text(), await readFile(resolve(root, 'renderer/renderer.html'), 'utf8'));
    const font = await fetch(new URL('fonts/regular.woff2', new URL(path, origin)));
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal(await font.text(), 'font-byte-witness');
    const invalid = await fetch(new URL('unlisted.js', new URL(path, origin)));
    assert.notEqual(invalid.headers.get('content-type'), 'text/javascript');
  } finally { await server.close(); }
}));

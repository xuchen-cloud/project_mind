import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

test('the worker engine relocates with no workspace imports or runtime sidecar assets', async () => {
  const meta = JSON.parse(await readFile(new URL('../dist/engine.meta.json', import.meta.url)));
  const imports = meta.outputs['dist/engine.mjs'].imports;
  assert.ok(imports.every(i => builtinModules.includes(i.path.replace(/^node:/, ''))), JSON.stringify(imports));
  const code = await readFile(new URL('../dist/engine.mjs', import.meta.url), 'utf8');
  assert.ok(!code.includes('/Users/xuchen/'));
  assert.ok(!code.includes('genoffice-docx-validation'));
  const manifest = JSON.parse(await readFile(new URL('../dist/runtime-manifest.json', import.meta.url)));
  assert.deepEqual(manifest.engineAssets, []);
  const notices = await readFile(new URL('../dist/THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8');
  assert.ok(notices.includes('Apache License'));
  assert.ok(notices.includes('@tiptap/core@3.31.0'));
  const root = new URL('output/relocated/', import.meta.url);
  await mkdir(root, { recursive: true });
  await copyFile(new URL('../dist/engine.mjs', import.meta.url), new URL('engine.mjs', root));
  await copyFile(new URL('fixtures/simple.original.docx', import.meta.url), new URL('source.docx', root));
  await writeFile(new URL('check.mjs', root), `import {readFile} from 'node:fs/promises'; import {inspect,edit} from './engine.mjs';
const bytes=await readFile(new URL('./source.docx',import.meta.url));
const model=await inspect(bytes); const edited=await edit(bytes,[{type:'text',nodeId:'docx:2',text:'独立工作进程中文编辑'}]);
const reopened=await inspect(edited); if(!reopened.nodes.some(n=>n.text==='独立工作进程中文编辑'))throw Error('Relocated worker did not reopen');
console.log(model.format);`);
  const result = await promisify(execFile)(process.execPath, ['check.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.stdout.trim(), 'docx');
  assert.equal(result.stderr, '');
});

test('slim full editor excludes renderer payload and keeps the standalone default URL', async () => {
  const meta = JSON.parse(await readFile(new URL('../dist/full-editor.meta.json', import.meta.url)));
  assert.ok(!Object.keys(meta.inputs).some(file => /renderer-resource|full-editor-legacy|renderer\.tsx/.test(file)));
  assert.deepEqual(meta.outputs['dist/full-editor.mjs'].imports, []);
  const code = await readFile(new URL('../dist/full-editor.mjs', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(code) < 64 * 1024, 'Host entry stays independent of renderer/font size');
  assert.match(code, /new URL\(rendererPath, import\.meta\.url\)/);
  assert.doesNotMatch(code, /new URL\(\s*["'`]\.\/renderer\.html["'`]\s*,\s*import\.meta\.url/,
    'The containing Vite build must not emit a second isolated renderer HTML asset');
  assert.deepEqual(Object.keys(await import('../dist/full-editor.mjs')), ['mountFullEditor']);
  const legacy = await readFile(new URL('../dist/editor.mjs', import.meta.url), 'utf8');
  assert.match(legacy, /rendererHtml/);
  assert.match(legacy, /mountFullEditor/);
});

test('renderer resource manifest closes over static assets and preserves every font byte', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('renderer-resources.json', dist)));
  assert.equal(manifest.entry, 'renderer.html');
  const files = new Set(manifest.files);
  assert.equal(files.size, manifest.files.length);
  for (const file of files) {
    assert.ok(!file.startsWith('/') && !file.split('/').includes('..'));
    assert.ok(!/engine|\.meta\.json|renderer-resource|editor\.mjs|NOTICE/.test(file));
    assert.ok((await readFile(new URL(file, dist))).length > 0);
  }
  const html = await readFile(new URL(manifest.entry, dist), 'utf8');
  assert.ok(Buffer.byteLength(html) < 1024);
  assert.match(html, /href="\.\/renderer\.css"/);
  assert.match(html, /src="\.\/renderer\.mjs"/);
  assert.doesNotMatch(html, /atob|data:|<style|<script[^>]*>[^<]+/);
  const css = await readFile(new URL('renderer.css', dist), 'utf8');
  for (const match of css.matchAll(/url\((?:"([^"]+)"|'([^']+)'|([^\)]+))\)/g)) {
    const file = match[1] ?? match[2] ?? match[3];
    if (!file.startsWith('data:')) assert.ok(files.has(posix.normalize(file)), `Missing CSS asset: ${file}`);
  }
  const meta = JSON.parse(await readFile(new URL('renderer.meta.json', dist)));
  let screenFonts = 0;
  for (const [output, info] of Object.entries(meta.outputs)) if (/\.(woff2?|ttf)$/.test(output)) {
    const source = Object.keys(info.inputs);
    assert.equal(source.length, 1);
    assert.deepEqual(await readFile(new URL('../' + output, import.meta.url)), await readFile(new URL('../' + source[0], import.meta.url)));
    assert.ok(files.has(output.replace(/^dist\//, '')));
    screenFonts++;
  }
  assert.ok(screenFonts > 0);
  const mapping = JSON.parse(await readFile(new URL('print-fonts.json', dist)));
  assert.ok(files.has('print-fonts.json'));
  const lock = JSON.parse(await readFile(new URL('../print-fonts/source-lock.json', import.meta.url)));
  assert.equal(Object.keys(mapping).length, lock.files.length);
  for (const row of lock.files) {
    const file = `print-fonts/${row.file}`;
    assert.ok(files.has(file));
    assert.equal(Object.values(mapping).filter(value => value === file).length, 1);
    const bytes = await readFile(new URL(file, dist));
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
  }
  for (const screen of Object.keys(mapping)) assert.ok(files.has(posix.normalize(screen)));
});

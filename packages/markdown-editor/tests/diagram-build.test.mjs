import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

test('diagram and DOCX browser graphs retain Mermaid without WaveDrom or its evaluator', async () => {
  const result = await build({absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['src/genoffice/editor/diagrams.ts', 'src/export/upstream-docx.mjs'],
    bundle: true, splitting: true, format: 'esm', platform: 'browser', outdir: 'output/diagrams',
    write: false, metafile: true});
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some(input => input.includes('/node_modules/mermaid/')));
  assert.deepEqual(inputs.filter(input => /(?:\/wavedrom(?:\/|\.)|\/node_modules\/(?:bit-field|logidrom|onml|tspan|json5)\/)/u.test(input)), []);
});

test('declared runtime dependencies and lockfile drop the exclusive WaveDrom packages', async () => {
  const root = new URL('../../../', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  for (const name of ['wavedrom', 'json5', 'bit-field', 'logidrom', 'onml', 'tspan']) {
    assert.equal(pkg.dependencies[name], undefined, name);
    assert.equal(lock.packages[''].dependencies[name], undefined, name);
    assert.equal(lock.packages[`node_modules/${name}`], undefined, name);
  }
  assert.equal(pkg.dependencies.mermaid, lock.packages[''].dependencies.mermaid);
  assert.equal(pkg.dependencies.katex, lock.packages[''].dependencies.katex);
});

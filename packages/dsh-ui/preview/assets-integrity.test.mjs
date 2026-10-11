import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const assets = JSON.parse(fs.readFileSync(new URL('./pdf-assets.json', import.meta.url)));
const inventory = JSON.parse(fs.readFileSync(new URL('./pdf-assets-provenance.json', import.meta.url)));
const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
const root = new URL('../../../node_modules/pdfjs-dist/', import.meta.url);
const sha = data => createHash('sha256').update(data).digest('hex');
test('all PDF binary resources and associated licenses are complete, exact-version build inputs', () => {
  assert.equal(JSON.parse(fs.readFileSync(new URL('package.json', root))).version, inventory.version);
  let count = 0;
  for (const [kind, directory] of Object.entries(directories)) {
    const sourceNames = fs.readdirSync(new URL(directory + '/', root)).sort();
    for (const name of sourceNames) {
      const source = fs.readFileSync(new URL(`${directory}/${name}`, root));
      if (/LICENSE|NOTICE/u.test(name)) {
        assert.equal(sha(fs.readFileSync(new URL(`./licenses/${directory}-${name}`, import.meta.url))), sha(source));
      } else {
        count++;
        const retained = Buffer.from(assets[kind][name], 'base64');
        const record = inventory.files.find(file => file.path === `pdfjs-dist/${directory}/${name}`);
        assert.ok(record, name); assert.equal(sha(source), record.sha256); assert.equal(sha(retained), record.sha256);
      }
    }
  }
  assert.equal(count, inventory.files.length);
  assert.equal(sha(fs.readFileSync(new URL('./licenses/pdfjs-dist-LICENSE', import.meta.url))), sha(fs.readFileSync(new URL('LICENSE', root))));
});

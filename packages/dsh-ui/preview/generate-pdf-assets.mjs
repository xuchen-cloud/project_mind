import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../../node_modules/pdfjs-dist/', import.meta.url));
const output = fileURLToPath(new URL('./', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
if (version !== '6.2.108') throw new Error('PDF worker/assets must remain pinned to 6.2.108');
const assets = {};
const inventory = [];
for (const [kind, directory] of Object.entries({ cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' })) {
  assets[kind] = {};
  for (const name of fs.readdirSync(path.join(root, directory)).sort()) {
    const file = path.join(root, directory, name);
    if (!fs.statSync(file).isFile()) continue;
    const data = fs.readFileSync(file);
    if (/LICENSE|NOTICE/u.test(name)) {
      fs.mkdirSync(path.join(output, 'licenses'), { recursive: true });
      fs.copyFileSync(file, path.join(output, 'licenses', directory + '-' + name));
    } else {
      assets[kind][name] = data.toString('base64');
      inventory.push({ path: `pdfjs-dist/${directory}/${name}`, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'licenses', 'pdfjs-dist-LICENSE'));
fs.writeFileSync(path.join(output, 'pdf-assets.json'), JSON.stringify(assets) + '\n');
fs.writeFileSync(path.join(output, 'pdf-assets-provenance.json'), JSON.stringify({ package: 'pdfjs-dist', version, license: 'Apache-2.0', generator: 'generate-pdf-assets.mjs', files: inventory }, null, 2) + '\n');

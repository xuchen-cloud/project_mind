import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';

// dom-selector 10 creates nine window listeners per queried DOMParser document.
// Share only interaction state for a Window; all document selector caches stay
// independent. This fixes the measured quadratic jsdom suite slowdown (#191).
const require = createRequire(import.meta.url);
let jsdomEntry;
try { jsdomEntry = require.resolve('jsdom'); }
catch (error) { if (error.code === 'MODULE_NOT_FOUND') process.exit(0); throw error; }
const fromJsdom = createRequire(jsdomEntry);
const manifest = fromJsdom.resolve('@asamuzakjp/dom-selector/package.json');
const metadata = JSON.parse(await readFile(manifest, 'utf8'));
if (metadata.version !== '10.0.3') throw new Error('Recheck the jsdom listener fix before changing dom-selector 10.0.3');
const path = join(dirname(manifest), 'src/js/event.js');
const original = await readFile(path, 'utf8');
const marker = 'const windowInteractionHandlers = new WeakMap();';
const hash = createHash('sha256').update(original).digest('hex');
if (hash === '8459ee51df5b1f8fb28e4a46ac8998af5473ec047e5d9d74f321dc0d2fc08182') process.exit(0);
if (hash !== 'e899ed720709e0b25a4117d3d29fd3bed0ff99169bad7b996139013d4e9cb53d') {
  throw new Error('Unexpected dom-selector event source; refusing to apply the test DOM fix');
}
const patched = original
  .replace('export class EventHandler {', `${marker}\n\nexport class EventHandler {`)
  .replace('  constructor(window) {', '  constructor(window) {\n    const retained = windowInteractionHandlers.get(window);\n    if (retained) return retained;')
  .replace('    this.registerEventListeners();', '    this.registerEventListeners();\n    windowInteractionHandlers.set(window, this);');
await writeFile(path, patched);
console.log('Applied jsdom window interaction listener fix.');

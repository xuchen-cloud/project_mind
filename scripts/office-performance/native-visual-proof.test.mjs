// Source-extracted native logic and the browser-installed copy share exact gates.
// Boundary doubles verify readiness decisions; real SVG/image paint needs the runner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { installXlsxVisualProbe } from './probes.mjs';
const source = readFileSync(new URL('./native-page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('native-page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const scope = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installNativePage')?.body ?? ast;
const fn = scope.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sheetVisualState');
assert.ok(fn, 'native readiness helper exists');
const compiled = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const nativeCheck = vm.runInNewContext(`${compiled}; sheetVisualState`);

function fixture(width = 980) {
  const bounds = (x, y, width, height) => ({ x, y, width, height });
  function node(rect, attrs = {}) {
    return { rect, parentElement: null, style: { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' },
      getBoundingClientRect() { return this.rect; }, getAttribute(key) { return attrs[key] ?? null; },
      querySelector(selector) { return this.selectors?.[selector] ?? null; },
      querySelectorAll(selector) { return this.lists?.[selector] ?? []; } };
  }
  const surface = node(bounds(0, 0, width, 857));
  const bars = [node(bounds(350, 130, 20, 80), { width: '20', height: '80' }), node(bounds(380, 50, 20, 160), { width: '20', height: '160' })];
  const svg = node(bounds(310, 50, 500, 250)); svg.lists = { 'g rect': bars };
  const title = node(bounds(310, 28, 200, 20)); title.textContent = '未编辑金额图';
  const chart = node(bounds(310, 25, 560, 280), { 'data-print-visual': 'visual-1' });
  chart.firstElementChild = chart; chart.selectors = { 'svg.chart-svg': svg, figcaption: title };
  const src = 'data:image/png;base64,REAL';
  const image = node(bounds(310, 425, 120, 60));
  Object.assign(image, { currentSrc: src, src, naturalWidth: 120, naturalHeight: 60, decode: () => Promise.resolve() });
  const picture = node(bounds(310, 425, 120, 60), { 'data-print-visual': 'visual-2' });
  picture.firstElementChild = picture; picture.selectors = { img: image };
  const doc = { documentElement: { clientWidth: width, clientHeight: 857 }, defaultView: { getComputedStyle: node => node.style },
    nodes: [chart, picture], querySelector: () => surface, querySelectorAll() { return this.nodes; } };
  const sheet = { getSheetId: () => 'sheet1', getZoom: () => 1, getSheet: () => ({ getFreeze: () => ({ xSplit: 0, ySplit: 0 }) }),
    getRange: (row, column) => ({ getCellRect: () => bounds(30 + column * 70, row * 25, 70, 25) }) };
  const workbook = { getActiveSheet: () => sheet, getScrollStateBySheetId: () => ({ sheetViewStartRow: 0, sheetViewStartColumn: 0, offsetX: 0, offsetY: 0 }) };
  const anchor = (row, toRow, toColumn) => ({ fromColumn: 4, fromRow: row, fromColumnOffset: 0, fromRowOffset: 0, toColumn, toRow, toColumnOffset: 0, toRowOffset: 0 });
  const model = { activeSheetId: 'sheet1', sheets: [{ id: 'sheet1', name: '明细' }],
    ranges: { sheet1: { cells: [{ row: 2, column: 1, value: 10 }, { row: 3, column: 1, value: 20 }] } },
    visuals: [{ id: 'visual-1', sheetId: 'sheet1', kind: 'chart', anchor: anchor(1, 13, 12),
      chart: { chartTypes: ['barChart'], barDirection: 'col', title: '未编辑金额图', series: [{ values: [], valuesRef: "'明细'!$B$3:$B$4" }] } },
    { id: 'visual-2', sheetId: 'sheet1', kind: 'image', anchor: anchor(17, 20, 6) }],
    rendererData: { media: { 'visual-2': { mediaType: 'image/png', base64: 'REAL' } } } };
  const decoded = new WeakMap();
  return { model, doc, workbook, decoded, check: () => nativeCheck(model, doc, workbook, decoded), chart, svg, title, bars, image, picture, surface };
}
async function settled(f) { f.check(); await Promise.resolve(); return f.check(); }

test('first screen requires asynchronous wrappers, actual SVG/title and native positive series geometry', async () => {
  const f = fixture(); f.doc.nodes = [];
  assert.match(f.check().reason, /not installed/);
  f.doc.nodes = [f.chart, f.picture];
  f.chart.selectors['svg.chart-svg'] = null; assert.match(f.check().reason, /SVG\/title/);
  f.chart.selectors['svg.chart-svg'] = f.svg;
  f.title.textContent = 'stale title'; assert.match(f.check().reason, /SVG\/title/);
  f.title.textContent = '未编辑金额图';
  f.svg.lists['g rect'] = []; assert.match(f.check().reason, /series bars/);
  f.svg.lists['g rect'] = f.bars;
  f.bars[1].getAttribute = key => key === 'height' ? '80' : '20'; assert.match(f.check().reason, /series bars/);
  f.bars[1].getAttribute = key => key === 'height' ? '160' : '20';
  assert.equal((await settled(f)).ready, true);
  assert.deepEqual(Array.from(f.check().visuals[0].expectedBars), [10, 20]);
});

test('expected native image must match source, decode, and have actual visible pixels', async () => {
  const f = fixture(); f.image.currentSrc = 'data:image/png;base64,WRONG';
  assert.match(f.check().reason, /source differs/);
  f.image.currentSrc = f.image.src;
  let finish; f.image.decode = () => new Promise(resolve => { finish = resolve; });
  assert.match(f.check().reason, /decoded visible pixels/);
  finish(); await Promise.resolve(); assert.equal(f.check().ready, true);
  f.image.naturalWidth = 0; assert.equal(f.check().ready, false);
});

test('image decode errors are explicit failures', async () => {
  const f = fixture(); f.image.decode = () => Promise.reject(new Error('corrupt real image'));
  f.check(); await Promise.resolve();
  assert.throws(f.check, /decode failed: Error: corrupt real image/);
});

test('980/640/490 viewports require partially intersecting visuals, not absent offscreen visuals', async () => {
  for (const width of [980, 640, 490]) {
    const f = fixture(width);
    assert.equal((await settled(f)).ready, true);
    assert.ok(f.check().visuals.every(v => v.actualIntersection.width > 0));
    f.doc.nodes = []; assert.equal(f.check().ready, false);
  }
  const f = fixture(300); f.doc.nodes = [];
  assert.equal(f.check().ready, true);
  assert.ok(f.check().visuals.every(v => v.offscreen));
});

test('clipped or hidden actual visual cannot satisfy an intersecting native anchor', () => {
  const f = fixture();
  f.chart.style.visibility = 'hidden'; assert.equal(f.check().ready, false);
  f.chart.style.visibility = 'visible';
  f.chart.parentElement = { ...f.surface, rect: { x: 0, y: 0, width: 200, height: 857 }, style: { ...f.surface.style, overflowX: 'hidden' } };
  assert.equal(f.check().ready, false);
});

test('visible visual geometry changes appear in stability signature and inactive sheets impose no obligation', async () => {
  const f = fixture(); await settled(f);
  const before = JSON.stringify(f.check().visuals.map(v => v.geometry));
  f.bars[0].rect.x++;
  assert.notEqual(JSON.stringify(f.check().visuals.map(v => v.geometry)), before);
  f.model.visuals.forEach(v => { v.sheetId = 'other-sheet'; }); f.doc.nodes = [];
  assert.equal(f.check().ready, true);
});

test('browser-installed visual gate uses identical source-extracted native logic', async () => {
  const browserAst = ts.createSourceFile('browser.js', installXlsxVisualProbe.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let browserHelper;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'sheetVisualState') browserHelper = node; ts.forEachChild(node, visit); };
  visit(browserAst); assert.ok(browserHelper);
  const print = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  assert.equal(print(browserHelper.getText(browserAst)), compiled, 'browser and native gate algorithm must stay identical');
  const f = fixture();
  const context = { window: { __officePerfEvidence: { runtime: { univerAPI: { getActiveWorkbook: () => f.workbook } } } }, document: f.doc, console };
  vm.runInNewContext(`(${installXlsxVisualProbe.toString()})(model)`, { ...context, model: f.model });
  const browserRead = context.window.__officePerfEvidence.readVisuals;
  browserRead(); await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(browserRead())), JSON.parse(JSON.stringify(await settled(f))));
  f.doc.nodes = [];
  assert.equal(browserRead().ready, false); assert.equal(f.check().ready, false);
});

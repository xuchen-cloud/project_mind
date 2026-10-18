/** Unit verification of the frozen entry's actual tracing code, without a browser.
 * Canvas methods below are deterministic boundary doubles, not rasterization.
 * Native image decoding, tainting and actual pixels still require runner evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const { format: formatNumber } = createRequire(import.meta.url)('../../packages/office-xlsx/node_modules/numfmt');

const entry = new URL(process.env.OFFICE_CANVAS_PROOF_ENTRY ?? './native-page.tsx', import.meta.url);
const source = readFileSync(entry, 'utf8');
const ast = ts.createSourceFile(entry.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['sheetCanvases', 'canvasSequence', 'overlap', 'containsBox', 'transformedBox',
  'observeSheetCanvas', 'sheetComposition', 'sheetNavigationPaint', 'watchContinuity', 'withoutMode', 'visible', 'canvasPaint', 'errorMessage']);
const selected = [];
const scope = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installNativePage')?.body ?? ast;
for (const statement of scope.statements) {
  const name = ts.isFunctionDeclaration(statement) ? statement.name?.text
    : ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
      ? statement.declarationList.declarations[0].name.getText(ast) : undefined;
  if (!names.has(name)) continue;
  names.delete(name);
  selected.push(statement.getText(ast));
}
assert.equal(names.size, 0, `Actual entry helpers missing: ${[...names].join(', ')}`);
const compiled = ts.transpileModule(selected.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness() {
  const context = vm.createContext({ performance, console, formatNumber });
  vm.runInContext(compiled, context, { filename: `${entry.pathname}:actual-tracing-helpers` });
  const api = vm.runInContext('({ observeSheetCanvas, sheetComposition, sheetNavigationPaint, watchContinuity, canvasPaint, errorMessage })', context);
  function realm() {
    const owner = { painted: [], pixelChecks: [], witness: 'WITNESS' };
    let pixelError;
    const document = { documentElement: { clientWidth: 400, clientHeight: 300 },
      defaultView: { getComputedStyle: canvas => canvas.style },
      createElement: () => new Canvas('probe') };
    class Canvas {
      constructor(id = '') {
        this.id = id; this._width = 200; this._height = 100;
        this.ownerDocument = document;
        this.rect = { x: 0, y: 0, width: 200, height: 100 };
        this.style = { display: 'block', visibility: 'visible', opacity: '1' };
        this.context = new Context(this);
      }
      get width() { return this._width; }
      set width(value) { this._width = value; this.context.reset(); }
      get height() { return this._height; }
      set height(value) { this._height = value; this.context.reset(); }
      getBoundingClientRect() {
        const { x, y, width, height } = this.rect;
        return { ...this.rect, left: x, top: y, right: x + width, bottom: y + height };
      }
      closest() { return null; }
      getContext() { return this.context; }
    }
    class Context {
      constructor(canvas) { this.canvas = canvas; this.initialize(); }
      reset() { this.initialize(); }
      initialize() {
        this.globalAlpha = 1; this.globalCompositeOperation = 'source-over';
        this.fillStyle = '#000000'; this.filter = 'none'; this.lineWidth = 1; this.miterLimit = 10;
        this.transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; this.stack = [];
      }
      getTransform() {
        const values = { ...this.transform };
        return { ...values, toJSON: () => values };
      }
      save() { this.stack.push({ transform: { ...this.transform } }); }
      restore() { if (this.stack.length) this.transform = this.stack.pop().transform; }
      measureText(text) { return { width: text.length * 6, actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; }
      // Native drawing calls deliberately have no proof logic. All tracing,
      // propagation, clips and invalidation execute code extracted above.
      beginPath() {} rect() {} roundRect() {} closePath() {} moveTo() {} lineTo() {} arc() {} quadraticCurveTo() {} clip() {}
      fill() {} stroke() {} clearRect() {} fillRect() {} strokeRect() {} strokeText() {}
      fillText() {} drawImage() {} putImageData() {}
      getImageData() { if (pixelError) throw pixelError; return { data: new Uint8ClampedArray(96 * 64 * 4) }; }
    }
    api.observeSheetCanvas({ HTMLCanvasElement: Canvas, CanvasRenderingContext2D: Context }, owner);
    const cache = new Canvas('cache'), main = new Canvas('univer-sheet-main-canvas-test');
    const write = (canvas = cache, text = 'WITNESS') => canvas.context.fillText(text, 20, 30);
    const copy = (from = cache, to = main) => to.context.drawImage(from, 0, 0);
    const proof = (canvas = main, witness = 'WITNESS') => api.sheetComposition(canvas, witness);
    return { target: { HTMLCanvasElement: Canvas, CanvasRenderingContext2D: Context }, Canvas, owner, cache, main, document, write, copy, proof, setPixelError: error => { pixelError = error; } };
  }
  return { ...api, realm, context, foreignError(name) {
    return vm.runInNewContext(`Object.assign(new Error('pixel read blocked'), {name: ${JSON.stringify(name)}})`);
  } };
}

function navigatedFixture() {
  const h = harness(), r = h.realm();
  const selected = { sheetId: 'sheet-2', startRow: 2, startColumn: 1 };
  const model = { styles: [], ranges: { 'sheet-2': { cells: [{ row: 2, column: 1, value: 30 }] } } };
  let actual = 30;
  const sheet = { getSheetId: () => 'sheet-2', getZoom: () => 1.1,
    getSheet: () => ({ getFreeze: () => ({ xSplit: 0, ySplit: 0 }) }),
    getRange: (row, column) => ({ getCellData: () => ({ v: actual }),
      getCellRect: () => ({ x: 30 + column * 70, y: 20 + row * 20, width: 70, height: 20 }) }) };
  const live = { observation: r.owner, sheet, workbook: { getActiveRange: () => ({ getRange: () => selected }),
    getScrollStateBySheetId: () => ({ sheetViewStartRow: 2, sheetViewStartColumn: 1, offsetX: 0, offsetY: 0 }) } };
  r.document.querySelectorAll = () => [r.main]; r.main.isConnected = true;
  const frame = Object.assign(new r.Canvas('iframe'), { isConnected: true, contentDocument: r.document });
  Object.assign(h.context, { liveSheet: () => live, rendererDocument: () => r.document, rendererFrame: () => frame,
    config: { format: 'xlsx' }, displayedFile: { object: { id: 'fixture' } }, models: new Map([['fixture', { ...model, format: 'xlsx' }]]),
    viewState: () => ({ mode: 'preview', sheetId: selected.sheetId, row: selected.startRow, column: selected.startColumn, zoom: 1.1 }),
    contentNodes: () => [r.main], loading: () => false, rootElement: {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } } });
  const paint = (text = '30', x = 40, y = 35) => { r.cache.context.fillText(text, x, y); r.copy(); };
  return { h, r, live, model, selected, paint, check: () => h.sheetNavigationPaint(model), setActual: value => { actual = value; } };
}

test('navigation continuity proves current B3 text at 110% after scroll, without weakening initial witness', () => {
  const f = navigatedFixture();
  f.r.owner.witness = 'OFFSCREEN_FIRST_VIEWPORT';
  f.r.setPixelError(f.h.foreignError('SecurityError'));
  f.paint();
  assert.equal(f.h.canvasPaint(f.r.main), false, 'initial paint gate still rejects absent original witness');
  const proof = f.check();
  assert.equal(proof.sheetId, 'sheet-2'); assert.equal(proof.row, 2); assert.equal(proof.column, 1);
  assert.equal(proof.witness, '30'); assert.equal(proof.actual, 30); assert.equal(proof.zoom, 1.1);
  assert.equal(proof.cellBox.x, 33); assert.equal(proof.cellBox.y, 22);
  assert.ok(proof.proof.chain.length > 0);
  const continuity = f.h.watchContinuity()();
  assert.ok(continuity.samples.every(sample => sample.painted && sample.sheetPaint.witness === '30'));
  assert.equal(f.r.owner.witness, 'OFFSCREEN_FIRST_VIEWPORT', 'navigation never rewrites first-screen readiness');
});

test('navigation rejects cache-only, cleared, wrong-cell, wrong-text and mismatched native/facade evidence', () => {
  for (const alter of [
    f => f.r.cache.context.fillText('30', 40, 35),
    f => { f.paint(); f.r.main.context.clearRect(0, 0, 200, 100); },
    f => f.paint('30', 150, 80),
    f => f.paint('130'),
    f => { f.paint(); f.setActual(31); },
    f => { f.paint(); f.selected.sheetId = 'sheet-1'; },
    f => { f.paint(); f.model.ranges['sheet-2'].cells = []; },
    f => { f.paint(); f.r.main.rect.x = 500; },
    f => { f.paint(); f.live.observation = { painted: [] }; },
  ]) {
    const f = navigatedFixture(); alter(f);
    assert.equal(f.check(), undefined);
    assert.throws(() => f.h.watchContinuity()(), /flashed or remounted/);
  }
});

test('cache-only text and direct main text cannot claim cache-to-main composition', () => {
  const { realm } = harness(), r = realm();
  r.write();
  assert.deepEqual(r.owner.painted, ['WITNESS']);
  assert.equal(r.proof(), undefined);
  r.write(r.main);
  assert.equal(r.proof(), undefined);
});

test('actual helpers propagate a two-hop cache witness and transformed main destination', () => {
  const r = harness().realm(), intermediate = new r.Canvas('intermediate');
  r.write(); r.copy(r.cache, intermediate);
  r.main.context.transform = { a: 1.5, b: 0, c: 0, d: 1.5, e: 5, f: 1 };
  r.main.context.drawImage(intermediate, 0, 0, 100, 60, 10, 5, 100, 60);
  const proof = r.proof();
  assert.ok(proof);
  assert.equal(proof.chain.length, 2);
  assert.equal(proof.chain[0].to, proof.chain[1].from);
  assert.equal(proof.chain[1].to, proof.mainCanvas);
  assert.equal(proof.screenBox.x, 50);
  assert.equal(proof.screenBox.y, 41.5);
  assert.ok(proof.viewportIntersection.width > 0);
});

test('source crop excluding or cutting the witness cannot pass', () => {
  for (const sourceX of [100, 30]) {
    const r = harness().realm(); r.write();
    r.main.context.drawImage(r.cache, sourceX, 0, 80, 100, 0, 0, 80, 100);
    assert.equal(r.proof(), undefined);
  }
});

test('target clip excluding witness prevents proof; restore allows fresh composition', () => {
  const r = harness().realm(); r.write();
  const ctx = r.main.context;
  ctx.save(); ctx.beginPath(); ctx.rect(100, 0, 100, 100); ctx.clip(); r.copy();
  assert.equal(r.proof(), undefined);
  ctx.restore(); r.copy();
  assert.ok(r.proof());
});

test('visible main canvas with witness outside viewport cannot pass', () => {
  const r = harness().realm(); r.write(); r.copy();
  r.main.rect.x = -100; // Canvas intersects viewport, but text ends before x=0.
  assert.equal(r.proof(), undefined);
});

test('main clear and opaque overwrite invalidate a previous successful proof', () => {
  for (const method of ['clearRect', 'fillRect', 'putImageData']) {
    const r = harness().realm(); r.write(); r.copy(); assert.ok(r.proof());
    r.main.context[method](0, 0, r.main.width, r.main.height);
    assert.equal(r.proof(), undefined, method);
  }
});

test('source clear prevents future propagation; already composited pixels remain valid', () => {
  const r = harness().realm(); r.write(); r.copy();
  r.cache.context.clearRect(0, 0, r.cache.width, r.cache.height);
  assert.ok(r.proof(), 'clearing source does not erase prior main pixels');
  const blankMain = new r.Canvas('univer-sheet-main-canvas-new');
  r.copy(r.cache, blankMain);
  assert.equal(r.proof(blankMain), undefined);
});

test('canvas reset including same-size assignment removes stale proof', () => {
  for (const reset of [r => { r.main.width = r.main.width; }, r => { r.main.height = 80; }, r => r.main.context.reset()]) {
    const r = harness().realm(); r.write(); r.copy(); assert.ok(r.proof());
    reset(r);
    assert.equal(r.proof(), undefined);
  }
});

test('new file cannot inherit old cache proof, even with identical witness/canvas IDs', () => {
  const h = harness(), previous = h.realm(); previous.write(); previous.copy(); assert.ok(previous.proof());
  const next = h.realm();
  assert.equal(next.proof(), undefined);
  next.copy(previous.cache, next.main);
  assert.equal(next.proof(), undefined, 'old renderer owner must not propagate into new file');
  next.write(); next.copy(); assert.ok(next.proof());
});

test('wrong or absent target witness and a newly created canvas reject old evidence', () => {
  const r = harness().realm(); r.write(); r.copy();
  assert.equal(r.proof(r.main, 'OTHER FILE'), undefined);
  assert.equal(r.proof(r.main, ''), undefined);
  assert.equal(r.proof(new r.Canvas(r.main.id)), undefined);
});

test('SecurityError is reported and permits only witnessed main composition', () => {
  const h = harness(), r = h.realm(), error = h.foreignError('SecurityError');
  assert.equal(error instanceof Error, false, 'exception belongs to source VM realm');
  r.setPixelError(error); r.write();
  assert.throws(() => h.canvasPaint(r.main), error, 'unobserved blank canvas has no owner proof');
  r.main.context.clearRect(0, 0, r.main.width, r.main.height);
  assert.equal(h.canvasPaint(r.main), false, 'cache-only is insufficient even when pixels are tainted');
  r.copy(); assert.equal(h.canvasPaint(r.main), true);
  const blocked = r.owner.pixelChecks.at(-1);
  assert.equal(blocked.pixelCheckBlocked, true);
  assert.match(blocked.reason, /SecurityError: pixel read blocked/);
  assert.ok(blocked.proof.chain.length);
  assert.throws(() => h.canvasPaint(r.cache), error, 'fallback never applies to cache canvas');
});

test('unrelated pixel exceptions propagate even with a valid composition proof', () => {
  const h = harness(), r = h.realm(), error = h.foreignError('InvalidStateError');
  r.write(); r.copy(); r.setPixelError(error);
  assert.throws(() => h.canvasPaint(r.main), error);
  assert.equal(r.owner.pixelChecks.length, 0);
  assert.match(h.errorMessage(error), /InvalidStateError: pixel read blocked/);
  assert.match(h.errorMessage(error), /at /, 'foreign error stack is retained');
});

test('strokeRect and rect stroke preserve interior witness while an edge crossing invalidates it', () => {
  for (const method of ['strokeRect', 'rect']) {
    const r = harness().realm(); r.write(); r.copy();
    const ctx = r.main.context;
    if (method === 'rect') { ctx.beginPath(); ctx.rect(0, 0, 150, 80); ctx.stroke(); }
    else ctx.strokeRect(0, 0, 150, 80);
    assert.ok(r.proof(), `${method} border must not erase its interior`);
    ctx.strokeRect(0, 22, 150, 60);
    assert.equal(r.proof(), undefined, 'top edge crosses actual text bounds');
  }
});

test('independent grid segments preserve text inside their overall bounding box', () => {
  const r = harness().realm(); r.write(); r.copy();
  const ctx = r.main.context;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(150, 0);
  ctx.moveTo(0, 80); ctx.lineTo(150, 80); ctx.stroke();
  assert.ok(r.proof());
  ctx.beginPath(); ctx.moveTo(0, 25); ctx.lineTo(150, 25); ctx.stroke();
  assert.equal(r.proof(), undefined);
});

test('closed axis-aligned border preserves text, but unknown curve and Path2D remain strict', () => {
  for (const unknown of ['curve', 'Path2D']) {
    const r = harness().realm(); r.write(); r.copy();
    const ctx = r.main.context;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(150, 0); ctx.lineTo(150, 80); ctx.lineTo(0, 80); ctx.closePath(); ctx.stroke();
    assert.ok(r.proof());
    ctx.beginPath();
    if (unknown === 'curve') { ctx.arc(20, 25, 5, 0, Math.PI * 2); ctx.stroke(); }
    else ctx.stroke({ opaquePath: true });
    assert.equal(r.proof(), undefined, unknown);
  }
});

test('standalone injected observer reports segment evidence without changing final verdict', async () => {
  const script = readFileSync(new URL('./native-canvas-observer.js', import.meta.url), 'utf8');
  let posted;
  const window = { __OFFICE_PERFORMANCE__: { reportUrl: 'http://fixture/result' }, addEventListener() {},
    fetch(input, init) { posted = { input, init }; return Promise.resolve({ ok: true }); } };
  vm.runInNewContext(script, { window, performance, console });
  const api = window.__OFFICE_CANVAS_DIAGNOSTICS__;
  const r = harness().realm();
  api.install(r.target, { title: 'Excel 完整编辑器', isConnected: true });
  r.write(r.cache, 'PERF_test'); r.copy();
  r.main.context.strokeRect(0, 0, 150, 80);
  let report = api.snapshot('PERF_test');
  const main = report.frames[0].canvases.find(canvas => canvas.id === r.main.id);
  assert.ok(main.strictComposition);
  assert.ok(report.frames[0].events.some(event => event.method === 'strokeRect' && event.removed.length === 0));
  r.main.context.fillRect(0, 0, 200, 100);
  report = api.snapshot('PERF_test');
  assert.ok(report.frames[0].witnessEvents.some(event => event.method === 'fillRect' && event.removed.some(mark => mark.text === 'PERF_test')));
  await window.fetch('http://fixture/result', { method: 'POST', body: JSON.stringify({ status: 'error', diagnostics: { sheetCheck: { witness: 'PERF_test' } } }) });
  const payload = JSON.parse(posted.init.body);
  assert.equal(payload.status, 'error', 'observer must never promote a failed frozen probe');
  assert.equal(payload.canvasTraceDiagnostic.frames[0].witness, 'PERF_test');
  assert.equal(payload.canvasTraceDiagnostic.frames[0].canvases.find(canvas => canvas.id === r.main.id).strictComposition, undefined);
});

test('tracked empty transparent overlay preserves a real underlying witness', () => {
  const r = harness().realm(); r.write(); r.copy();
  const overlay = new r.Canvas('transparent-overlay');
  overlay.context.clearRect(0, 0, overlay.width, overlay.height);
  r.copy(overlay, r.main);
  assert.ok(r.proof());
});

test('overlay paint coverage, not canvas size, decides whether it covers witness', () => {
  for (const method of ['fillRect', 'fillText', 'strokeRect']) {
    const r = harness().realm(); r.write(); r.copy();
    const overlay = new r.Canvas('overlay');
    overlay.context.clearRect(0, 0, 200, 100);
    if (method === 'fillText') overlay.context.fillText('elsewhere', 100, 80);
    else overlay.context[method](100, 60, 50, 30);
    r.copy(overlay, r.main); assert.ok(r.proof(), method);
    overlay.context.fillRect(20, 22, 60, 10);
    r.copy(overlay, r.main); assert.equal(r.proof(), undefined, 'solid paint crosses text');
  }
});

test('cropped scaled overlay maps its true coverage into destination coordinates', () => {
  const r = harness().realm(); r.write(); r.copy();
  const overlay = new r.Canvas('cropped'); overlay.context.fillRect(100, 60, 10, 10);
  r.main.context.drawImage(overlay, 100, 60, 20, 20, 100, 60, 40, 40);
  assert.ok(r.proof(), 'mapped coverage lies away from witness');
  r.main.context.drawImage(overlay, 100, 60, 20, 20, 20, 22, 40, 40);
  assert.equal(r.proof(), undefined, 'same source mapped over witness');
});

test('clear, partial clear and resize recover transparency without old coverage', () => {
  for (const clear of [o => o.context.clearRect(0, 0, 200, 100), o => { o.width = o.width; o.context.save(); },
    o => o.context.clearRect(20, 22, 60, 10)]) {
    const r = harness().realm(); r.write(); r.copy();
    const overlay = new r.Canvas('cleared-overlay'); overlay.context.fillRect(20, 22, 60, 10);
    clear(overlay); r.copy(overlay, r.main); assert.ok(r.proof());
  }
});

test('unknown/untracked source, unknown path coverage and copy remain conservative', () => {
  for (const mode of ['untracked', 'unknown-path', 'copy']) {
    const r = harness().realm(); r.write(); r.copy();
    const overlay = new r.Canvas('overlay');
    if (mode === 'unknown-path') { overlay.context.beginPath(); overlay.context.arc(150, 80, 5, 0, Math.PI * 2); overlay.context.stroke(); }
    if (mode === 'copy') { overlay.context.clearRect(0, 0, 200, 100); r.main.context.globalCompositeOperation = 'copy'; }
    r.copy(overlay, r.main); assert.equal(r.proof(), undefined, mode);
  }
});

test('resized transparent layer remains known blank without subsequent context operations', () => {
  for (const reset of [o => { o.width = o.width; }, o => { o.height = o.height; }, o => o.context.reset()]) {
    const r = harness().realm(); r.write(); r.copy();
    const layer = new r.Canvas('resized-empty');
    layer.context.fillRect(0, 0, 200, 100);
    reset(layer);
    r.copy(layer, r.main);
    assert.ok(r.proof(), 'resize/reset itself establishes blank coverage');
  }
});

test('main invalidation diagnostics identify wrapped clears, unknown strokes and record resets', () => {
  for (const [method, act] of [
    ['clearRect', r => r.main.context.clearRect(0, 0, 200, 100)],
    ['fillRect', r => r.main.context.fillRect(0, 0, 200, 100)],
    ['stroke', r => { r.main.context.beginPath(); r.main.context.arc(0, 0, 2, 0, 6); r.main.context.stroke(); }],
    ['reset', r => r.main.context.reset()],
    ['set:width', r => { r.main.width = r.main.width; }],
    ['set:height', r => { r.main.height = r.main.height; }],
  ]) {
    const r = harness().realm(); r.write(); r.copy(); act(r);
    const event = r.owner.invalidationEvents.find(item => item.method === method);
    assert.ok(event, method);
    assert.equal(event.before, 1); assert.equal(event.after, 0);
    assert.equal(event.removed[0].text, 'WITNESS');
    assert.equal(r.proof(), undefined);
    assert.doesNotThrow(() => JSON.stringify(r.owner.invalidationEvents));
  }
});

test('main loss diagnostics are bounded and omit drawImage source objects', () => {
  const r = harness().realm(); r.write();
  for (let i = 0; i < 16; i++) {
    r.copy(); r.copy(new r.Canvas('untracked'), r.main);
  }
  const events = r.owner.invalidationEvents;
  assert.equal(events.length, 12);
  assert.ok(events.every(event => event.method === 'drawImage' && event.args.length === 2));
  assert.equal(events[0].composite, 'source-over');
  assert.equal(events[0].alpha, 1);
  assert.doesNotThrow(() => JSON.stringify(events));
});

test('rounded scrollbar fill preserves distant witness but invalidates overlapping text', () => {
  for (const overlap of [false, true]) {
    const r = harness().realm(); r.write(); r.copy();
    const c = r.main.context;
    c.beginPath(); c.roundRect(overlap ? 15 : 180, overlap ? 18 : 80, 15, 15, 3); c.fill();
    assert.equal(!!r.proof(), !overlap);
  }
});

test('rounded rectangle cannot recover an earlier unknown curved path', () => {
  const r = harness().realm(); r.write(); r.copy();
  const c = r.main.context;
  c.beginPath(); c.quadraticCurveTo(20, 25, 20, 6); c.roundRect(180, 80, 15, 15, 3); c.fill();
  assert.equal(r.proof(), undefined);
});

test('actual Univer rounded scrollbar arc path preserves distant text', () => {
  const r=harness().realm();r.write();r.copy();const c=r.main.context;
  c.transform.e=140;c.transform.f=80;c.beginPath();
  c.moveTo(3,0);c.lineTo(47,0);c.arc(47,3,3,Math.PI*3/2,0,false);
  c.lineTo(50,7);c.arc(47,7,3,0,Math.PI/2,false);
  c.lineTo(3,10);c.arc(3,7,3,Math.PI/2,Math.PI,false);
  c.lineTo(0,3);c.arc(3,3,3,Math.PI,Math.PI*3/2,false);c.closePath();c.fill();
  assert.ok(r.proof());
});

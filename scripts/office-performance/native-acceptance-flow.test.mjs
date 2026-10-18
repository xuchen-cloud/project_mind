// Source-extracted orchestration checks only. Boundary doubles do not exercise
// native commands, renderer paint, autosave or permissions, or prove native pass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./native-page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('native-page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const scope = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installNativePage').body;
const declaration = name => {
  const node = scope.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node;
};
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const helpers = ['operation', 'navigationAcceptance', 'acceptance', 'runErrors', 'reportStatus', 'errorMessage'];
const runStatements = declaration('run').body.statements;
const tailStart = runStatements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(ast) === 'config.acceptance');
assert.ok(tailStart >= 0);
let finalize;
function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'finally' && node.arguments[0]?.getText(ast).includes('harnessRunning = false')) finalize = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(scope); assert.ok(finalize);
const reportBaseDeclaration = scope.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(ast) === 'reportBase');
assert.ok(reportBaseDeclaration);

function fixture({ continuityFails = true, resetFails = false, checkpointFails = false } = {}) {
  const trace = [], measurements = [], errors = [], controls = { textContent: '' }, sent = [];
  const file = { name: 'complex.xlsx', object: { id: '1' }, versionNumber: 1 };
  const failure = new Error('continuity painted=false at 18830'), resetError = new Error('real reset failed'), transportError = new Error('checkpoint POST failed');
  const context = vm.createContext({ performance, console, measurements, errors, commands: [], activeMeasurement: undefined,
    lastSheetCheck: {}, lastTimeout: null, shellReady: 0, scope: 'test-only orchestration', commits: [], harnessRunning: true,
    controlStatus: controls, rootElement: {}, document: { visibilityState: 'visible' },
    config: { format: 'xlsx', acceptance: true }, first: file, other: { name: 'simple.xlsx', object: { id: '2' } },
    projectContext: { projectId: 1, binding: {} }, project: { id: 1 }, displayedFile: file,
    models: new Map([['1', { format: 'xlsx', activeSheetId: 's', ranges: { s: { cells: [{ value: 'native original witness' }] } } }]]),
    currentMode: () => 'edit', deadline: promise => promise, diagnostics: () => ({}), resources: () => [],
    checkpoint: async name => { trace.push(`checkpoint:${name}`); if (checkpointFails) throw transportError; },
    applyMode: async mode => { trace.push(`mode:${mode}`); }, navigateAndZoom: async () => { trace.push('navigate'); return {}; },
    viewState: () => ({ sheetId: 's', zoom: 1.1 }), assertSameView() {},
    watchContinuity: () => () => { trace.push('continuity'); if (continuityFails) throw failure; return {}; },
    resetNavigation: async () => { trace.push('reset'); if (resetFails) throw resetError; },
    raceObserver: null, officePreviewCache: { clear() { trace.push('clear-cache'); } },
    mount() {}, closeDisplay() {}, ready() {}, doubleRaf() {}, window: {}, fileViews: new Map(),
    runPendingFileRace: async (_hooks, input) => { trace.push(`race:${input.action}`); return { boundaryOnly: true }; },
    measure: async name => { trace.push(name); }, send: async report => { sent.push(report); },
  });
  vm.runInContext(compile(helpers.map(name => declaration(name).getText(ast)).join('\n') + '\n' + reportBaseDeclaration.getText(ast) +
    `\nasync function runTail() {${runStatements.slice(tailStart).map(node => node.getText(ast)).join('\n')}}\nconst finishControls = ${finalize.getText(ast)};`), context);
  const api = vm.runInContext('({navigationAcceptance, acceptance, operation, runErrors, reportStatus, reportBase, runTail, finishControls})', context);
  return { api, context, trace, measurements, errors, controls, sent, file, failure, resetError, transportError };
}

test('continuity error row survives a successful real-reset boundary and cannot become passed', async () => {
  const f = fixture(); await f.api.navigationAcceptance(f.file);
  assert.deepEqual(f.measurements.map(row => [row.name, row.status]), [
    ['acceptance_navigation_zoom_and_mode', 'error'], ['acceptance_reset_navigation', 'passed']]);
  assert.match(f.measurements[0].error, /painted=false at 18830/);
  assert.deepEqual(f.errors, [], 'retained row does not weaken/poison runtime-error gates');
  assert.equal(f.api.runErrors().length, 1); assert.equal(f.api.reportStatus(), 'error');
  assert.match(f.api.reportBase().errors[0], /painted=false/);
  f.api.finishControls(); assert.equal(f.controls.textContent, '验收失败');
});

test('normal navigation/reset stays passed; over-budget never hides a retained error', async () => {
  const f = fixture({ continuityFails: false }); await f.api.navigationAcceptance(f.file);
  assert.ok(f.measurements.every(row => row.status === 'passed')); assert.equal(f.api.reportStatus(), 'passed');
  f.measurements.push({ status: 'over_budget' }); assert.equal(f.api.reportStatus(), 'over_budget');
  f.measurements.push({ name: 'later acceptance', status: 'error', error: 'native readback failed' });
  assert.equal(f.api.reportStatus(), 'error');
});

test('reset failure aborts actual acceptance before mutation, preserving both failures', async () => {
  const f = fixture({ resetFails: true });
  await assert.rejects(f.api.acceptance(f.file), error => error === f.resetError);
  assert.deepEqual(f.measurements.map(row => row.status), ['error', 'error']);
  assert.equal(f.api.reportBase().errors.length, 2);
  assert.ok(!f.measurements.some(row => row.name.includes('mutation')));
});

test('checkpoint transport failure is not mistaken for a recoverable navigation failure', async () => {
  for (const continuityFails of [true, false]) {
    const f = fixture({ checkpointFails: true, continuityFails });
    await assert.rejects(f.api.navigationAcceptance(f.file), error => error === f.transportError);
    assert.ok(!f.trace.includes('reset'));
  }
});

test('actual acceptance reaches mutation only after reset; a later dependency error still aborts', async () => {
  const f = fixture(), stop = new Error('mutation dependency failed'), op = f.api.operation;
  f.context.operation = async (name, ...args) => {
    if (name === 'acceptance_real_mutation_autosave') { f.trace.push('mutation-boundary'); throw stop; }
    return op(name, ...args);
  };
  await assert.rejects(f.api.acceptance(f.file), error => error === stop);
  assert.ok(f.trace.indexOf('mutation-boundary') > f.trace.indexOf('reset'));
  assert.ok(!f.measurements.some(row => row.name.includes('history') || row.name.includes('readback')));
});

test('actual run tail continues independent race boundaries but reports/UI retain navigation failure', async () => {
  const f = fixture(); f.context.acceptance = () => f.api.navigationAcceptance(f.file);
  f.context.raceObserver = { boundaryOnly: true };
  await f.api.runTail();
  assert.deepEqual(f.trace.filter(item => item.startsWith('race:')), ['race:switch', 'race:close']);
  assert.ok(f.trace.includes('after_races_reopen'));
  assert.equal(f.sent.at(-1).status, 'error'); assert.match(f.sent.at(-1).errors[0], /painted=false/);
  assert.equal(f.sent.at(-1).measurements[0].status, 'error');
  f.api.finishControls(); assert.equal(f.controls.textContent, '验收失败');
});

test('final reporting includes original row plus a later fatal error without duplicates', async () => {
  const f = fixture(); await f.api.navigationAcceptance(f.file);
  f.errors.push('later fatal reset/readback error', f.measurements[0].error);
  assert.equal(f.api.reportBase().errors.length, 2); assert.equal(f.api.reportStatus(), 'error');
});

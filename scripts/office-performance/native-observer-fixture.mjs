// Runs the actual native-page invoke wrapper; it never invokes native services.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {NativeOfficeObserver} from './native-office-observer.ts';

const source = readFileSync(new URL('./native-page.tsx', import.meta.url), 'utf8');
export const ast = ts.createSourceFile('native-page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
export const scope = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installNativePage').body;
const wrapper = scope.statements.find(node => ts.isForOfStatement(node) && node.initializer.getText(ast) === 'const api');
const errorMessage = scope.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'errorMessage');
assert.ok(wrapper); assert.ok(errorMessage);
export const object = {kind: 'file', workspaceId: 'fixture', scope: {kind: 'project', projectId: 1}, id: '7'};
export const status = {object, revision: 3, contentHash: 'working-hash', archivedVersionNumber: 1,
  pendingArchive: true, lastActivityAtMs: 100, archiveDueAtMs: 900100};
export const opened = {...status, sessionId: 'session', name: 'fixture.docx', format: 'docx', base64: '', model: {format: 'docx', nodes: [{text: 'native witness'}]}};
export const payload = data => ({input: {binding: {workspaceId: 'fixture', generation: 'g1'}, requestId: 'request', data: {object, ...data}}});
export const envelope = data => ({apiVersion: 1, requestId: 'request', ok: true, data});
export function fixture(result) {
  const calls = [], commands = [], commits = [], models = new NativeOfficeObserver(), textSources = new Map(), workingStates = new Map();
  const desktopApi = Object.fromEntries(['command', 'fileCommand'].map(api => [api, async (...args) => {
    calls.push([api, ...args]); if (result instanceof Error) throw result; return typeof result === 'function' ? result(...args) : result;
  }]));
  const context = vm.createContext({desktopApi, commands, commits, models, textSources, workingStates,
    performance, raceObserver: undefined, TextDecoder, Uint8Array, atob});
  vm.runInContext(ts.transpileModule(errorMessage.getText(ast) + '\n' + wrapper.getText(ast), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
  }).outputText, context);
  return {desktopApi, calls, commands, commits, models, textSources, workingStates};
}

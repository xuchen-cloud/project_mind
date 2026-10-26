// Post-fix regressions for the historical review audit, without opening the app.
// The archived report records the prior failing behavior at 5de9a91.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {QueryClient} from '@tanstack/react-query';
import {sessionInventory} from '../../packages/dsh-assistant/scripts/session-inventory.mjs';
import {runModelUtility} from '../../packages/dsh-assistant/scripts/model-utility.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function functionSource(file, name) {
  const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast); ts.forEachChild(node, visit);}
  visit(ast); assert.ok(found, `${file}:${name}`);
  return ts.transpileModule(found, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
}

const sessions = {async list() {return {items: []};}};
const context = {directory: '/fixture'};
const base = {scope: {kind: 'workspace'}, mode: 'metadata', ids: []};
for (const options of [{limit: null, budgetChars: null}, {limit: 0, budgetChars: null}, {limit: null, budgetChars: 4000}]) {
  assert.equal((await sessionInventory(sessions, context, {...base, ...options}, 'fixture')).totalCount, 0);
}
assert.equal((await sessionInventory(sessions, context, {...base, limit: 0, budgetChars: 4000}, 'fixture')).totalCount, 0);
console.log('PR235: all 3 native-null default combinations and explicit limit:0 succeed');

// Capacity discovery uses the installed official catalog; it does not generate model text.
const discovered = await runModelUtility({operation: 'capacity', profile: {providerFamily: 'openai_compatible',
  baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4', supportsText: true, enabled: true}, modelId: 'gpt-4'});
assert.equal(discovered.ok, true);
const capacity = discovered.data;
assert.equal(capacity.contextWindow, 8192);
assert.equal(capacity.outputTokens, 2048);
assert.ok(capacity.outputTokens <= capacity.contextWindow / 4);
console.log('PR205: real catalog context 8192 returns output 2048 within the native quarter-context bound');

let errorMessage;
const choose = runInNewContext(`${await functionSource('src/components/document/ProjectFileContent.tsx', 'choose')}; choose`, {
  editorFlush: {current: async () => {throw Error('save failed');}},
  setError: value => {errorMessage = value;}, message: error => error.message,
  sourceCallback: {current() {throw Error('must not switch');}}, setSelection() {throw Error('must not switch');}, callbacks: {},
});
await assert.rejects(choose(2), /save failed/); assert.equal(errorMessage, 'save failed');
console.log('PR171: failed editor flush preserves page error and rejects version onSelect');

let retryError, backendCalls = 0; const childIds = [];
const manage = runInNewContext(`${await functionSource('src/components/home/ProjectSidebarSessions.tsx', 'manage')}; manage`, {
  active: {current: true}, action: {current: null}, AbortController, workspaceRoot: '/fixture', projectId: 1,
  setOpening() {}, setBusyLabel() {}, setMenu() {}, setEditing() {}, setDeleting() {},
  setError: value => {retryError = value;}, getErrorMessage: e => e.message,
  async manageProjectSession({action}) {backendCalls++; childIds.push(action.childSessionId); throw Error('response lost after persistence');},
  openProjectContent() {throw Error('unreachable');}, open() {throw Error('unreachable');}, load() {},
});
await manage({id: 'parent', title: 'Fixture'}, {kind: 'fork', childSessionId: 'session-10000000-0000-4000-8000-000000000001'});
retryError.retry(); await new Promise(resolve => setImmediate(resolve));
assert.equal(backendCalls, 2); assert.equal(new Set(childIds).size, 1); assert.ok(childIds[0]);
console.log('PR181: ambiguous fork UI retry carries the same child identity (transport simulated; native persistence covered separately)');

// Transpile the actual current Todo module/cache. Replace only native transport import;
// the transport passed below is an isolated fixture. TanStack Query is real.
const compiledModules = new Map();
for (const file of ['src/lib/queryKeys.ts', 'src/lib/tags.ts', 'src/todo/todo-cache.ts', 'src/todo/todo-module.ts']) {
  compiledModules.set(path.resolve(root, file), ts.transpileModule(await readFile(path.resolve(root, file), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText);
}
const loadedModules = new Map();
function loadModule(file) {
  if (file.endsWith('/services/projectMindApi.ts')) return {projectMindApi: {}};
  if (loadedModules.has(file)) return loadedModules.get(file);
  assert.ok(compiledModules.has(file), `Unexpected dependency: ${file}`);
  const exports = {}; loadedModules.set(file, exports);
  runInNewContext(compiledModules.get(file), {exports, require: spec => loadModule(path.resolve(path.dirname(file), `${spec}.ts`))});
  return exports;
}
const {createTodoModule} = loadModule(path.resolve(root, 'src/todo/todo-module.ts'));
const {queryKeys} = loadModule(path.resolve(root, 'src/lib/queryKeys.ts'));
const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
let finishProjects, projectCalls = 0;
try {
  const pending = client.fetchQuery({queryKey: queryKeys.projects.all, queryFn: () => {projectCalls++; return new Promise(resolve => {finishProjects = resolve;});}}).catch(error => error);
  const module = createTodoModule({queryClient: client, transport: {
    async projectTagSettingsGet() {return {tags: []};},
    async todoCreate(input) {return {...input, id: 1, revision: 1, tags: [], progresses: [], status: 'unfinished', createdAt: 'fixture', updatedAt: 'fixture'};},
  }});
  await module.change({type: 'create', ownership: {scope: 'workspace'}, content: 'Fixture', priority: 'not_urgent_important'});
  finishProjects([{id: 7, name: 'Project'}]); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.getQueryData(queryKeys.projects.all), [{id: 7, name: 'Project'}]);
  assert.equal(client.getQueryState(queryKeys.projects.all).fetchStatus, 'idle');
  assert.equal(projectCalls, 1);
  console.log('PR11/cache: Workspace Todo leaves the first project query running; its late response populates the cache');
} finally {client.clear();}

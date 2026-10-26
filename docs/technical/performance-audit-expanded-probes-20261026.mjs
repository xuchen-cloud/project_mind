// Post-fix call-count regressions for the archived 2026-10-26 audit.
// No app, model provider, or user data is opened.
// Run from repository root: node docs/technical/performance-audit-expanded-probes-20261026.mjs
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {bindContext} from '../../packages/dsh-assistant/scripts/project-workspace.mjs';
import {installContextStreams} from '../../packages/dsh-assistant/scripts/context-streams.mjs';
import {installSourceService} from '../../packages/dsh-assistant/scripts/source-bridge.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-expanded-audit-')));
try {
  const rows = [], workspaces = new Map(), routes = new Map(), handlers = new Map();
  let catalogReads = 0, inspections = 0, deliveries = 0;
  const ctx = {
    workspaceController: {async create({path: directory}) {
      const id = `w${workspaces.size}`;
      workspaces.set(id, {id, path: directory, sessionIds: [], async attachSession(id) {this.sessionIds.push(id);}});
      return {workspace: {workspaceId: id}};
    }},
    workspaceRegistry: {archivedSessionIds: [], get: id => workspaces.get(id)},
    sessionController: {
      async list() {catalogReads++; return {items: rows};},
      async inspect() {inspections++; return {events: []};},
    },
    connection: {fetch: {register(route) {routes.set(route.path, route);}}},
    agents: {list() {return []; }},
    on(name, handler) {handlers.set(name, handler);}, effect() {},
    typertGateway: {
      async openWireStream() {return (async function*() {
        for (let i = 0; i < 100; i++) yield {type: 'emit', event: 'api-session/added', args: [{sessionId: 's0'}]};
      })();}, async dispatchRpc() {},
    },
  };
  const contexts = [];
  for (let i = 0; i < 5; i++) {
    const directory = path.join(root, `project-${i}`); await mkdir(directory);
    contexts.push({kind: 'project', id: i + 1, name: `Project ${i + 1}`, directory});
  }
  for (let i = 0; i < 100; i++) rows.push({sessionId: `s${i}`, cwd: contexts[i % 5].directory});
  const registry = await bindContext(ctx, contexts[0]);
  for (const context of contexts.slice(1)) await registry.register(context);
  installContextStreams(ctx, registry);
  catalogReads = 0;
  let forwarded = 0;
  for (const context of contexts) {
    const stream = await ctx.typertGateway.openWireStream('$events', {args: {}, mindContext: {kind: context.kind, id: context.id}});
    for await (const frame of stream) forwarded++;
  }
  assert.equal(catalogReads, 1); assert.equal(forwarded, 100);
  console.log(JSON.stringify({probe: 'context-broadcast', consumers: 5, events: 100, catalogRows: 100, catalogReads, forwarded}));

  await installSourceService(ctx, registry, {async request() {deliveries++;}});
  const sourceRef = {object: {workspaceId: 'workspace', scope: {kind: 'project', projectId: 1}, kind: 'file', id: '9'},
    revision: `sha256:${'a'.repeat(64)}`, fileVersion: 1, recordVersion: null, blockId: null,
    locator: {kind: 'line', start: 1, end: 1}, title: 'fixed.txt', excerpt: ''};
  const messages = Array.from({length: 20}, (_, i) => {
    const metadata = {id: `fixed-${i}`, sourceRef, offset: 1, limit: 1, requestedLimit: 1, truncated: false, content: '1: immutable bytes'};
    return {id: `message-${i}`, role: 'tool', content: [{type: 'text', text:
      `@mind-source/${Buffer.from(JSON.stringify(sourceRef)).toString('base64url')}/fixed.txt\n<mind-file-source>${JSON.stringify(metadata)}</mind-file-source>`}]};
  });
  catalogReads = 0;
  for (let i = 0; i < 10; i++) {
    for await (const chunk of handlers.get('llm/stream')({sessionId: 's0', messages}, async function*() {yield {type: 'text-delta', text: 'ok'};})) {}
  }
  assert.equal(catalogReads, 0); assert.equal(deliveries, 20);
  console.log(JSON.stringify({probe: 'source-history', rounds: 10, fixedProjections: 20, catalogReads, deliveries}));

  // Invoke the real registered route: a valid absolute path absent from every session.
  catalogReads = 0;
  const route = routes.get('/api/mind/session/fileAccess');
  const response = await route.fetch(new Request('http://localhost/api/mind/session/fileAccess', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
      type: 'client-request', rpcId: 'audit', method: 'mind/session/fileAccess',
      payload: {args: {request: {context: {kind: 'project', id: 1}, path: root}}},
    }),
  }));
  const access = await response.json();
  assert.equal(access.result?.value?.allowed, false, JSON.stringify(access));
  assert.equal(inspections, 20);
  console.log(JSON.stringify({probe: 'shared-attachment-miss', projectSessions: 20, catalogReads, inspections}));
} finally {await rm(root, {recursive: true, force: true});}

// Execute the real renderer host after erasing imports; only its DOM and byte builder are mocked.
const source = await readFile(new URL('../../packages/office-docx/renderer-host.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer-host.ts', source, ts.ScriptTarget.Latest, true);
const stripped = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getFullText(ast)).join('\n');
const compiled = ts.transpileModule(stripped, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
let builds = 0, changes = 0;
const options = {sourceBase64: 'YQ==', baselineHash: 'fixture', readOnly: false, presentationMode: 'edit', hasDraft: false,
  appearance: {theme: 'light', font: 'sans-serif', tokens: {}}, onChange() {changes++;}};
const window = {frameElement: {__projectMindDocxOptions: options}, dispatchEvent() {}, addEventListener() {}};
const document = {addEventListener() {}, querySelectorAll() {return [];},
  documentElement: {dataset: {}, classList: {toggle() {}}, style: {setProperty() {}}}};
const sandbox = {exports: {}, window, document, URL, Blob, Event, atob, btoa, Uint8Array, queueMicrotask, setTimeout, clearTimeout,
  requestAnimationFrame: fn => setImmediate(fn), createPdfBridge: () => ({cancelImages() {}}),
  pickImage() {}, copyImageToClipboard() {}, exportHtml() {}, pickViaInput() {}};
runInNewContext(compiled, sandbox);
sandbox.exports.initializeHost({async buildDocBytes() {builds++; return new Uint8Array([1, 2, 3]);}, isDocDirty() {return true;}});
const host = window.__projectMindDocxHost;
try {
  for (let i = 0; i < 10; i++) {
    host.render({doc: {revision: i}}, false);
    await new Promise(resolve => setImmediate(resolve));
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(builds, 1); assert.equal(changes, 1);
  console.log(JSON.stringify({probe: 'word-pre-autosave', separateDirtyRenders: 10, docxBuilds: builds, changeCallbacks: changes, nativeSaves: 0}));
} finally {host.destroy();}

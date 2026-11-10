/** #304: one-window real components + IPC; loaded only by the measurement entry. */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { EditorView } from '@codemirror/view';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ProjectContentWorkspace } from '../../src/components/project/ProjectContentWorkspace';
import { createProjectMindQueryClient } from '../../src/lib/queryClient';
import { getContentLayout } from '../../src/lib/project-content-layout';
import { useProjectContentStore } from '../../src/state/project-content-store';
import { desktopApi } from '../../src/services/desktopApi';
import { projectMindApi } from '../../src/services/projectMindApi';
import { projectFileApi } from '../../src/services/projectFileApi';
import { recordDocumentApi } from '../../src/services/recordDocumentApi';
import { fileWorkingApi, type FileWorkingOpen } from '../../src/services/fileWorkingApi';
import { fileEditorApi } from '../../src/services/fileEditorApi';
import { fileDocumentApi } from '../../src/services/fileDocumentApi';
import { openProjectContent } from '../../src/services/projectContentApi';
import { moveContentOwner } from '../../src/services/contentOwnerMoveApi';
import { createFileDropBatch } from '../../src/services/fileDropApi';
import type { AgentWorkspaceBinding } from '../../src/lib/agent-types';
import type { ProjectDirectoryFile } from '../../src/lib/file-types';
import '@fontsource/work-sans/400.css';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '../../src/styles/app.css';

interface Config { page: string; workspaceRoot: string; controlUrl: string }
interface Call { name: string; args: Record<string, any>; result?: any; error?: string; ok?: boolean; started: number; settled?: number }
interface Snapshot { [id: string]: { document: { project_id: number; current_version_number: number }; working: { text: string; state: unknown } | null; sessions: string[]; versions: { id: number; version_number: number; content_hash: string; display_name: string | null; is_important: number; metadata_revision: number }[] } }
const config = (window as unknown as { __OFFICE_PERFORMANCE__: Config }).__OFFICE_PERFORMANCE__;
const calls: Call[] = [], events: { topic: string; payload: any }[] = [], runtimeErrors: string[] = [];
const assertions: { name: string; passed: boolean; evidence: unknown }[] = [];
const snapshots: Record<string, Snapshot> = {};
let phase = 'preflight';
const errorText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
const status = document.createElement('p');
status.style.cssText = 'margin:0;padding:12px;font:14px system-ui;background:#f4f4f2;color:#222';
status.setAttribute('role', 'status');
function stage(value: string) { phase = value; status.textContent = `File flows native acceptance · ${value}`; }
function check(name: string, passed: unknown, evidence: unknown) {
  assertions.push({ name, passed: !!passed, evidence });
  if (!passed) throw Error(`Assertion failed: ${name}`);
}
async function until<T>(name: string, read: () => T | undefined | null | false): Promise<T> {
  const end = performance.now() + 30000;
  while (performance.now() < end) {
    if (runtimeErrors.length) throw Error(runtimeErrors.join('\n'));
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`Timed out: ${name}`);
}
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function control<T>(name: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.controlUrl}/${name}`, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw Error(`${name}: ${await response.text()}`);
  return response.json();
}
// Observe the original Promise/result/rejection. No native calls are delayed or replaced.
function observe<T>(name: string, args: Record<string, any> | undefined, send: () => Promise<T>): Promise<T> {
  const promise = send();
  if (!name.startsWith('file_')) return promise;
  const call: Call = { name, args: structuredClone(args ?? {}), started: performance.now() };
  calls.push(call);
  void promise.then(result => {
    call.result = result;
    const envelope = result as { ok?: boolean; apiVersion?: number; requestId?: string } | null;
    call.ok = args?.input?.binding ? envelope?.ok === true && envelope.apiVersion === 1 && envelope.requestId === args.input.requestId : true;
    call.settled = performance.now();
  }, error => { call.error = errorText(error); call.ok = false; call.settled = performance.now(); });
  return promise;
}
const objectId = (call: Call) => String(call.args.input?.data?.object?.id ?? call.args.input?.data?.id ?? call.args.input?.documentId ?? call.args.documentId ?? '');
const data = (call: Call) => call.result?.apiVersion === 1 ? call.result.data : call.result;
const forFile = (name: string, file: ProjectDirectoryFile, from = 0) => calls.slice(from).filter(call => call.name === name && objectId(call) === file.object.id);
const panel = (file: ProjectDirectoryFile) => document.querySelector<HTMLElement>(`[data-content-object="file:${file.object.id}"]`);
function editor(file: ProjectDirectoryFile): EditorView | undefined {
  const element = panel(file)?.querySelector<HTMLElement>('.cm-content');
  return element ? EditorView.findFromDOM(element) ?? undefined : undefined;
}
function draft(view: EditorView, text: string) {
  if (view.state.readOnly || view.dom.closest('[inert]')) throw Error('Cannot edit a frozen/hidden fixture');
  flushSync(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' }));
  if (view.state.doc.toString() !== text) throw Error('Real editor transaction did not apply');
}
async function expectFailure(action: () => Promise<unknown>): Promise<unknown> {
  try { await action(); } catch (error) { return error; }
  throw Error('Expected a real native failure, but the action succeeded');
}
const code = (error: unknown) => (error as { code?: string })?.code;

async function run() {
  if (!import.meta.env.OFFICE_PERFORMANCE || config?.page !== 'file-flows' || !('__TAURI_INTERNALS__' in window))
    throw Error('Requires the opt-in native measurement host');
  document.getElementById('native-controls')!.hidden = true;
  document.body.prepend(status);
  document.getElementById('root')!.style.cssText = 'height:calc(100vh - 45px);min-height:0';
  const command = desktopApi.command.bind(desktopApi), fileCommand = desktopApi.fileCommand.bind(desktopApi);
  desktopApi.command = <T,>(name: string, args?: Record<string, unknown>) => observe(name, args, () => command<T>(name, args));
  desktopApi.fileCommand = <T,>(name: string, args: Record<string, unknown>) => observe(name, args, () => fileCommand<T>(name, args));
  window.addEventListener('error', event => runtimeErrors.push(errorText(event.error ?? event.message)));
  window.addEventListener('unhandledrejection', event => runtimeErrors.push(errorText(event.reason)));
  await until('visible native window', () => document.visibilityState === 'visible');
  if (getCurrentWebviewWindow().label !== 'main') throw Error('Harness must run in the real main Webview');
  for (const topic of ['file:editor-flush-request', 'content:owner-moved', 'content:owner-move-released', 'content:file-replaced'])
    await desktopApi.listenEvent(topic, payload => { events.push({ topic, payload }); });

  stage('create isolated Workspace and native Projects');
  await projectMindApi.workspaceCreate({ rootPath: config.workspaceRoot });
  const source = await projectMindApi.projectCreate({ name: 'File flow source' });
  const destination = await projectMindApi.projectCreate({ name: 'File flow destination' });
  const fixtures = await control<{ originals: Record<string, string>; replacement: string; replacementPath: string }>('fixtures', {
    sourceRoot: source.rootPath, destinationRoot: destination.rootPath, sourceId: source.id, destinationId: destination.id,
  });
  const binding: AgentWorkspaceBinding = await recordDocumentApi.bindingGet(config.workspaceRoot);
  const scope = { workspaceId: binding.workspaceId, projectId: source.id };
  const files = await Promise.all(['move.md', 'failed-save.md', 'replace.md', 'unrelated.md'].map(name => projectFileApi.register(binding, source.id, name)));
  const [moving, failing, replacing, unrelated] = files;
  const ids = files.map(file => Number(file.object.id));
  const snapshot = async (name: string) => snapshots[name] = await control<Snapshot>('snapshot', { ids });
  const queryClient = createProjectMindQueryClient();
  createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[`/projects/${source.id}`]}><ProjectContentWorkspace workspaceRoot={config.workspaceRoot}
      projectId={source.id} active overview={() => <p>Isolated native fixture</p>} /></MemoryRouter>
  </QueryClientProvider>);
  const tab = (file: ProjectDirectoryFile) => getContentLayout(useProjectContentStore.getState(), scope).tabs.find(item => item.object.id === Number(file.object.id));
  async function open(file: ProjectDirectoryFile) {
    await openProjectContent({ workspaceRoot: config.workspaceRoot, projectId: source.id,
      object: { kind: 'file', id: Number(file.object.id), title: file.name }, view: { sourceMode: true }, reveal: false });
    const view = await until(`real source editor ${file.name}`, () => {
      const current = editor(file);
      return current && !current.state.readOnly && !current.dom.closest('[inert]') && current;
    });
    await until(`native editor registration ${file.name}`, () => forFile('file_editor_register', file).some(call => call.ok));
    const opened = await until(`working session ${file.name}`, () => {
      const matching = forFile('file_working_open', file).filter(call => call.ok);
      const call = matching[matching.length - 1];
      return call && data(call) as FileWorkingOpen;
    });
    return { view, opened, tabId: tab(file)!.id };
  }
  const unrelatedView = await open(unrelated);
  // Drive the real pending-input handler; no timer or save API is patched.
  flushSync(() => unrelatedView.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'draft' })));
  const unrelatedDraft = '# Unrelated unsaved draft\nMust survive every other File operation.\n';
  draft(unrelatedView.view, unrelatedDraft);
  await paint();
  const unrelatedStart = await fileWorkingApi.tick(binding, unrelated.object);
  const unrelatedSince = calls.length;
  const failed = await open(failing);
  check('native-main-and-registered-editors', getCurrentWebviewWindow().label === 'main'
    && forFile('file_editor_register', failing).some(call => call.ok)
    && forFile('file_editor_register', unrelated).some(call => call.ok), { source: source.id, destination: destination.id, binding });

  stage('G13 real save CAS failure retains original draft');
  const failedDraft = '# Original dirty draft retained after CAS failure\n';
  draft(failed.view, failedDraft);
  const peer = await fileWorkingApi.open(binding, failing.object);
  try {
    await fileWorkingApi.saveText(binding, { object: failing.object, sessionId: peer.sessionId,
      expectedRevision: peer.revision, expectedContentHash: peer.contentHash, text: '# Concurrent native saved content\n' }, crypto.randomUUID());
  } finally { await fileWorkingApi.close(binding, { object: failing.object, sessionId: peer.sessionId }); }
  const failedSince = calls.length;
  const saveFailure = await expectFailure(() => moveContentOwner({ workspaceRoot: config.workspaceRoot, binding,
    sourceProjectId: source.id, destinationProjectId: destination.id, object: { kind: 'file', id: Number(failing.object.id) } }));
  const failedSql = (await snapshot('save-failed'))[failing.object.id];
  check('g13-save-failure-retains-draft', code(saveFailure) === 'REVISION_CONFLICT'
    && tab(failing)?.id === failed.tabId && editor(failing) === failed.view && failed.view.state.doc.toString() === failedDraft
    && failedSql.sessions.includes(failed.opened.sessionId) && failedSql.document.project_id === source.id
    && forFile('file_owner_move', failing, failedSince).length === 0
    && forFile('file_working_save_text', failing, failedSince).some(call => call.result?.error?.code === 'REVISION_CONFLICT'),
  { error: errorText(saveFailure), tabId: failed.tabId, session: failed.opened.sessionId });

  stage('G13 real move CAS failure releases source');
  const movingView = await open(moving);
  const savedDraft = '# Saved target before rejected move\n';
  draft(movingView.view, savedDraft);
  const rejectedId = crypto.randomUUID();
  await fileEditorApi.flush(binding, moving.object, rejectedId);
  const baseline = await desktopApi.fileCommand<{ expectedVersion: number; expectedWorkingRevision: number | null; expectedHash: string }>('file_owner_move_baseline', {
    binding, documentId: Number(moving.object.id), sourceOwner: source.id,
  });
  let moveFailure;
  try {
    moveFailure = await expectFailure(() => desktopApi.fileCommand('file_owner_move', { binding, requestId: rejectedId,
      input: { documentId: Number(moving.object.id), sourceOwner: source.id, targetOwner: destination.id,
        ...baseline, expectedVersion: baseline.expectedVersion + 1 } }));
  } finally { await fileEditorApi.release(binding, moving.object, rejectedId); }
  await until('native failure release', () => events.some(event => event.topic === 'content:owner-move-released' && event.payload.operationId === rejectedId));
  await until('source unlocked', () => !panel(moving)?.inert);
  const rejectedSql = (await snapshot('move-rejected'))[moving.object.id];
  check('g13-commit-failure-releases-source', code(moveFailure) === 'REVISION_CONFLICT'
    && tab(moving)?.id === movingView.tabId && editor(moving) === movingView.view
    && movingView.view.state.doc.toString() === savedDraft && rejectedSql.working?.text === savedDraft
    && rejectedSql.document.project_id === source.id && rejectedSql.sessions.includes(movingView.opened.sessionId),
  { error: errorText(moveFailure), operationId: rejectedId, session: movingView.opened.sessionId });

  stage('G13 save target only and close source Tab');
  const moveText = '# Saved by the real move flow\n';
  const moveSince = calls.length, eventSince = events.length;
  draft(movingView.view, moveText);
  await moveContentOwner({ workspaceRoot: config.workspaceRoot, binding, sourceProjectId: source.id,
    destinationProjectId: destination.id, object: { kind: 'file', id: Number(moving.object.id) } });
  await until('source Tab and component closed', () => !tab(moving) && !panel(moving));
  const savedCalls = calls.slice(moveSince).filter(call => ['file_working_save_text', 'file_working_save_office'].includes(call.name));
  const flushes = events.slice(eventSince).filter(event => event.topic === 'file:editor-flush-request');
  check('g13-saves-only-target', savedCalls.some(call => call.ok && objectId(call) === moving.object.id)
    && savedCalls.every(call => objectId(call) === moving.object.id) && flushes.length === 1
    && flushes.every(event => event.payload.object.id === moving.object.id)
    && calls.slice(moveSince).some(call => call.name === 'file_editor_flush_reply' && call.args.input?.data?.outcome === 'saved'
      && flushes.some(event => event.payload.flushId === call.args.input.data.flushId)), { saves: savedCalls, flushes });
  const movedSql = (await snapshot('moved'))[moving.object.id];
  check('g13-closes-source-and-preserves-saved-bytes', movedSql.document.project_id === destination.id
    && movedSql.working?.text === moveText && !movedSql.sessions.includes(movingView.opened.sessionId)
    && forFile('file_working_close', moving, moveSince).length === 0,
  { fileId: moving.object.id, oldTab: movingView.tabId, oldSession: movingView.opened.sessionId, native: movedSql });

  stage('G14 replacement retains Tab and opens a new session');
  const replacementView = await open(replacing);
  const pendingText = '# Saved pending text retained as a version boundary\n';
  const page = await projectMindApi.projectPageGet({ projectId: source.id });
  const nativeDocument = page.projectDocuments.find(item => item.id === Number(replacing.object.id));
  if (!nativeDocument) throw Error('Native Project page did not return registered replacement File');
  draft(replacementView.view, pendingText);
  const dropSince = calls.length;
  const outcomes = await createFileDropBatch(binding, [{ sourcePath: fixtures.replacementPath, target: {
    kind: 'update', documentId: nativeDocument.id, projectId: source.id, managedPath: nativeDocument.managedPath,
    expectedVersionNumber: nativeDocument.currentVersionNumber,
  } }]).run();
  const outcome = outcomes[0];
  if (outcome.status !== 'success' || outcome.releaseError) throw Error(`Drop failed: ${JSON.stringify(outcome)}`);
  const newView = await until('replacement rendered in a new editor', () => {
    const current = editor(replacing);
    return current && current !== replacementView.view && current.state.doc.toString() === fixtures.replacement && current;
  });
  await until('replacement unlock', () => !panel(replacing)?.inert);
  const reopened = await until('new working session', () => forFile('file_working_open', replacing, dropSince)
    .find(call => call.ok && data(call).sessionId !== replacementView.opened.sessionId));
  const dropSql = (await snapshot('replaced'))[replacing.object.id];
  check('g14-replaces-session-keeps-tab', outcome.result.oldSessionsClosed && !outcome.result.noChange
    && tab(replacing)?.id === replacementView.tabId && !dropSql.sessions.includes(replacementView.opened.sessionId)
    && dropSql.sessions.includes(data(reopened).sessionId) && dropSql.working?.text === fixtures.replacement
    && forFile('file_working_close', replacing, dropSince).length === 0,
  { outcome, tabId: replacementView.tabId, oldSession: replacementView.opened.sessionId, newSession: data(reopened).sessionId });
  const history = await fileDocumentApi.versionsList(binding, { object: replacing.object });
  let preservedVersion: number | undefined;
  for (const version of history.versions) {
    const content = await fileDocumentApi.sourceRead(binding, { object: replacing.object,
      versionNumber: version.versionNumber, expectedContentHash: version.contentHash, budgetChars: 4096 });
    if (content.complete && content.text === pendingText) preservedVersion = version.versionNumber;
  }
  check('g14-preserves-saved-pending-version', preservedVersion !== undefined, { preservedVersion, replacementVersion: outcome.result.versionNumber });

  stage('G15 actual metadata controls preserve current session');
  const version = history.versions.find(item => item.versionNumber === outcome.result.versionNumber)!;
  if (!version) throw Error('Replacement version absent from native history');
  const metadataSince = calls.length;
  panel(replacing)!.querySelector<HTMLButtonElement>('button[aria-label="文件查看版本"]')!.click();
  (await until('version edit action', () => documentQuery<HTMLButtonElement>(`button[aria-label="编辑 V${version.versionNumber} 标记"]`))).click();
  const dialog = await until('real version metadata dialog', () => documentQuery<HTMLElement>('[role="dialog"]'));
  const input = dialog.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Native acceptance label');
  flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  flushSync(() => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click();
  await until('native metadata receipt', () => forFile('file_version_metadata_update', replacing, metadataSince).some(call => call.ok));
  await until('metadata UI saved status', () => [...dialog.querySelectorAll('[role="status"]')].some(node => node.textContent === '已保存'));
  const metadata = await fileDocumentApi.versionGet(binding, { object: replacing.object, versionId: version.id });
  const metadataSql = (await snapshot('metadata'))[replacing.object.id];
  const storedVersion = metadataSql.versions.find(item => String(item.id) === version.id);
  await paint();
  check('g15-metadata-keeps-session-and-content', metadata.version.displayName === 'Native acceptance label' && metadata.version.isImportant
    && metadata.version.contentHash === version.contentHash && metadata.version.versionNumber === version.versionNumber
    && metadata.version.metadataRevision === version.metadataRevision + 1
    && storedVersion?.display_name === 'Native acceptance label' && storedVersion.is_important === 1
    && editor(replacing) === newView && tab(replacing)?.id === replacementView.tabId
    && JSON.stringify(metadataSql.sessions) === JSON.stringify(dropSql.sessions)
    && metadataSql.working?.text === fixtures.replacement
    && calls.slice(metadataSince).every(call => !['file_working_open', 'file_working_close', 'file_working_save_text', 'file_editors_flush'].includes(call.name)),
  { version: metadata.version, session: data(reopened).sessionId, native: metadataSql });

  const unrelatedEnd = await fileWorkingApi.tick(binding, unrelated.object);
  const unrelatedSql = (await snapshot('final'))[unrelated.object.id];
  check('unrelated-dirty-instance-untouched', editor(unrelated) === unrelatedView.view && tab(unrelated)?.id === unrelatedView.tabId
    && unrelatedView.view.state.doc.toString() === unrelatedDraft && unrelatedEnd.revision === unrelatedStart.revision
    && unrelatedEnd.contentHash === unrelatedStart.contentHash && unrelatedSql.working?.text === fixtures.originals['unrelated.md']
    && unrelatedSql.sessions.includes(unrelatedView.opened.sessionId)
    && calls.slice(unrelatedSince).every(call => objectId(call) !== unrelated.object.id
      || !['file_working_save_text', 'file_working_close', 'file_editor_unregister', 'file_working_open'].includes(call.name))
    && events.filter(event => event.topic === 'file:editor-flush-request').every(event => event.payload.object.id !== unrelated.object.id),
  { tab: unrelatedView.tabId, session: unrelatedView.opened.sessionId, persisted: unrelatedSql, pendingDraft: unrelatedDraft });
  stage('passed; awaiting runner shutdown');
}
function documentQuery<T extends Element>(selector: string) { return window.document.querySelector<T>(selector); }
void (async () => {
  let failure: unknown;
  try { await run(); if (runtimeErrors.length) throw Error(runtimeErrors.join('\n')); }
  catch (error) { failure = error; status.textContent = `FAILED at ${phase}: ${errorText(error)}`; }
  const report = { kind: 'file-flows-native', status: failure ? 'failed' : 'passed', error: failure ? errorText(failure) : null,
    phase, assertions, calls, events, snapshots, runtimeErrors, windowLabel: getCurrentWebviewWindow().label,
    visibility: document.visibilityState, scope: 'one main Webview; real ProjectContentWorkspace/ProjectFileContent/Markdown + native IPC + read-only SQLite',
    notCovered: ['cross-window / multiple target instances', 'Record', 'Office formats', 'OS keyboard / IME', 'native drag hit testing', 'Windows', 'crash / cross-volume recovery'] };
  try { await control('result', report); } catch (error) { status.textContent += `; report delivery failed: ${errorText(error)}`; console.error(error); }
})();

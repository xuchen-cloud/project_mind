/** #191/#118: full App acceptance on the runner's isolated Workspace only.
 * main.tsx owns OFFICE_PERFORMANCE && page==='app' dynamic import. No opening,
 * unmounting, cache clearing, native response delay or replacement occurs here.
 * Unit checks validate observer constraints; only a real native run is acceptance.
 */
import type { AgentWorkspaceBinding } from '../../src/lib/agent-types';
type Stamp = { sequence: number; ms: number; utc: string };
type NativeError = { code: string | null; name: string | null; retryable: boolean | null };
type Observed = { name: string; channel: string; args: Record<string, unknown>; dispatched: Stamp;
  settled: Stamp | null; outcome: string | null; error: NativeError | null; binding?: AgentWorkspaceBinding; closedWorkspace?: boolean };
export interface AppWorkspaceRaceEvidence {
  armed: Stamp; inspect: Observed | null; click: Stamp | null; close: Observed | null;
  pendingAtClick: boolean; pendingAtClose: boolean; bindingBefore: AgentWorkspaceBinding | null;
  bindingBeforeRead: Observed | null; bindingAfterRead: Observed | null;
  bindingError: NativeError | null; bindingChecked: Stamp | null; landing: Stamp | null;
  final: Stamp | null; empty: boolean; forbiddenAdditions: number; raf: number[];
}
const workspaceErrors = new Set(['WORKSPACE_NOT_OPEN', 'WORKSPACE_CHANGED']);
const data = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const errorIdentity = (error: unknown): NativeError => {
  const value = data(error);
  return { code: typeof value.code === 'string' ? value.code : null, name: typeof value.name === 'string' ? value.name : null,
    retryable: typeof value.retryable === 'boolean' ? value.retryable : null };
};
/** Throws on incomplete or contradictory observations; never manufactures a pass. */
export function assertAppWorkspaceRaceEvidence(e: AppWorkspaceRaceEvidence): void {
  const require = (ok: unknown, reason: string) => { if (!ok) throw Error(reason); };
  const { inspect: old, close } = e;
  require(old?.name === 'file_office_inspect' && old.settled && close?.name === 'workspace_close' && close.settled && e.click,
    'invalid: missing dispatched/settled inspect, actual UI click or workspace_close');
  if (!old?.settled || !close?.settled || !e.click) return;
  require(e.armed.sequence < old.dispatched.sequence && old.dispatched.sequence < e.click.sequence &&
    e.click.sequence < close.dispatched.sequence && close.dispatched.sequence < old.settled.sequence &&
    e.pendingAtClick && e.pendingAtClose, 'invalid: inspect was not pending through actual UI close dispatch');
  const binding = data(old.args.binding), object = data(old.args.object), scope = data(object.scope);
  const read = e.bindingBeforeRead;
  require(read?.name === 'record_workspace_binding_get' && read.args.configuredRoot === true && read.outcome === 'ok' &&
    read.settled && read.settled.sequence < old.dispatched.sequence && read.binding?.workspaceId === binding.workspaceId &&
    read.binding?.generation === binding.generation, 'invalid: missing real configured-root binding response before inspect');
  require(e.bindingBefore && binding.workspaceId === e.bindingBefore.workspaceId && binding.generation === e.bindingBefore.generation &&
    object.workspaceId === binding.workspaceId && object.kind === 'file' && typeof object.id === 'string' &&
    scope.kind === 'project' && typeof scope.projectId === 'number', 'invalid: real configured-root binding or scoped File identity missing');
  require(close.outcome === 'ok' && !close.error, 'failed: real workspace_close failed');
  require(close.closedWorkspace === true, 'invalid: workspace_close did not return an empty currentWorkspace');
  require((old.outcome === 'ok' && !old.error) || (old.outcome === 'error' && workspaceErrors.has(old.error?.code ?? '')),
    'failed: old inspect failed for a reason other than native Workspace invalidation');
  require(e.bindingChecked && e.bindingChecked.sequence > close.settled.sequence && e.bindingChecked.sequence > old.settled.sequence &&
    workspaceErrors.has(e.bindingError?.code ?? ''), 'invalid: old-root binding did not fail with a known native Workspace error');
  const after = e.bindingAfterRead;
  require(after?.name === 'record_workspace_binding_get' && after.args.configuredRoot === true && after.outcome === 'error' &&
    after.error?.code === e.bindingError?.code && after.dispatched.sequence > e.bindingChecked!.sequence && after.settled &&
    after.settled.sequence < (e.final?.sequence ?? 0), 'invalid: no completed native binding failure envelope');
  require(e.landing && e.final && e.landing.sequence > close.settled.sequence && e.final.sequence > e.bindingChecked!.sequence &&
    e.raf.length === 2 && e.raf[1] > e.raf[0], 'invalid: actual landing and two paint frames were not observed');
  require(e.empty && e.forbiddenAdditions === 0, 'failed: old File/editor surface remained or reappeared');
}

export async function installAppWorkspaceRace(config: { page?: string; workspaceRoot: string; reportUrl: string }) {
  if (config.page !== 'app' || !('__TAURI_INTERNALS__' in window) || !config.workspaceRoot.startsWith('/') || !config.reportUrl)
    throw Error('App Workspace race requires native app page, isolated absolute Workspace root and reportUrl');
  const { desktopApi } = await import('../../src/services/desktopApi');
  const { recordDocumentApi } = await import('../../src/services/recordDocumentApi');
  const command = desktopApi.command, fileCommand = desktopApi.fileCommand;
  const commands: Observed[] = [];
  let sequence = 0, e: AppWorkspaceRaceEvidence | null = null, disposed = false, stopped = false;
  let before: Observed | null = null, dom: MutationObserver | null = null, timer: ReturnType<typeof setTimeout>;
  const stamp = (): Stamp => ({ sequence: ++sequence, ms: performance.now(), utc: new Date().toISOString() });
  const selector = '.project-file-content,iframe,.mind-markdown';
  const root = document.getElementById('root');
  if (!root) throw Error('Actual App root missing');
  const empty = () => !document.body.querySelector(selector);
  const landing = () => [...root.querySelectorAll('h1')].some(node => node.textContent?.trim() === '打开你的 Workspace' &&
    node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
  const button = document.createElement('button'); button.textContent = '准备工作区切换竞态'; button.type = 'button';
  button.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 12px';
  document.body.append(button);
  const inspectDOM = (records: MutationRecord[]) => {
    if (!e) return;
    if (e.landing) for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === 1 && ((node as Element).matches(selector) || (node as Element).querySelector(selector))) e.forbiddenAdditions++;
    }
    if (!e.landing && e.close?.settled && landing()) { e.landing = stamp(); e.empty = empty(); }
  };
  const finish = async (failure?: unknown) => {
    if (stopped || !e) return; stopped = true; clearTimeout(timer);
    inspectDOM(dom?.takeRecords() ?? []); dom?.disconnect();
    let status = 'passed', reason: string | null = null;
    try { if (failure) throw failure; assertAppWorkspaceRaceEvidence(e); }
    catch (error) { reason = error instanceof Error ? error.message : 'invalid: observer failed'; status = reason.startsWith('failed:') ? 'failed' : 'invalid'; }
    button.textContent = `工作区竞态：${status}`;
    const body = { kind: 'acceptance', scope: 'fullApp workspace acceptance', status, reason, evidence: e, commands,
      observationBoundary: 'real UI close through old inspect settlement, native old-root binding failure, landing and two RAFs; no business content',
      visibility: document.visibilityState };
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
    try { const response = await fetch(config.reportUrl, { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw Error(`Workspace race report HTTP ${response.status}`); }
    finally { clearTimeout(timeout); }
  };
  const reportFailed = () => { button.textContent = '工作区竞态：报告发送失败'; console.error('office-performance:workspace-race report failed'); };
  const fail = (error: unknown) => { if (stopped) return reportFailed(); void finish(error).catch(reportFailed); };
  const check = async () => {
    if (!e || stopped) return;
    inspectDOM(dom?.takeRecords() ?? []);
    if (!e.close?.settled || !e.inspect?.settled || !e.landing) return;
    if (e.bindingChecked) return; e.bindingChecked = stamp();
    try { await recordDocumentApi.bindingGet(config.workspaceRoot); }
    catch (error) { e.bindingError = errorIdentity(error); }
    for (let i = 0; i < 2; i++) e.raf.push(await new Promise<number>(resolve => requestAnimationFrame(resolve)));
    inspectDOM(dom?.takeRecords() ?? []); e.empty = e.empty && empty() && landing(); e.final = stamp();
    await finish();
  };
  const observe = <T,>(channel: string, name: string, payload: unknown, dispatch: () => Promise<T>): Promise<T> => {
    const pending = dispatch(); // ORIGINAL dispatch first. Its Promise/result/errors are returned untouched.
    if (disposed || stopped || !['file_office_inspect', 'workspace_close', 'record_workspace_binding_get'].includes(name)) return pending;
    const input = data(data(payload).input), args = data(input.data);
    const observed: Observed = { name, channel, args: name === 'file_office_inspect' ? {
      binding: { workspaceId: data(input.binding).workspaceId, generation: data(input.binding).generation }, requestId: input.requestId,
      object: { workspaceId: data(args.object).workspaceId, kind: data(args.object).kind, id: data(args.object).id,
        scope: { kind: data(data(args.object).scope).kind, projectId: data(data(args.object).scope).projectId } },
      versionNumber: args.versionNumber, expectedContentHash: args.expectedContentHash,
    } : name === 'record_workspace_binding_get' ? { requestId: input.requestId, configuredRoot: input.workspaceRoot === config.workspaceRoot } : {},
    dispatched: stamp(), settled: null, outcome: null, error: null };
    if (e) commands.push(observed);
    if (e && name === 'workspace_close' && e.click && !e.close) { e.close = observed; e.pendingAtClose = !e.inspect?.settled; }
    if (e?.bindingChecked && name === 'record_workspace_binding_get' && input.workspaceRoot === config.workspaceRoot && !e.bindingAfterRead) e.bindingAfterRead = observed;
    const settled = (result: unknown, rejected: boolean) => {
      const value = data(result); observed.settled = stamp();
      observed.outcome = rejected ? 'transport-error' : value.ok === false ? 'error' : 'ok';
      observed.error = rejected ? errorIdentity(result) : value.ok === false ? errorIdentity(value.error) : null;
      if (!rejected && name !== 'workspace_close' && (value.apiVersion !== 1 || value.requestId !== input.requestId || typeof value.ok !== 'boolean')) observed.outcome = 'invalid-response';
      if (name === 'workspace_close') observed.closedWorkspace = value.currentWorkspace === null;
      if (name === 'record_workspace_binding_get' && input.workspaceRoot === config.workspaceRoot && value.ok === true) {
        const binding = data(value.data);
        if (observed.outcome === 'ok' && typeof binding.workspaceId === 'string' && typeof binding.generation === 'string') {
          observed.binding = { workspaceId: binding.workspaceId, generation: binding.generation }; before = observed;
        }
      }
      void check().catch(fail);
    };
    // Observing rejection here does not convert the ORIGINAL caller's rejection to success.
    void pending.then(result => settled(result, false), error => settled(error, true)).catch(fail);
    if (e && name === 'file_office_inspect' && !e.inspect) {
      e.inspect = observed; e.bindingBeforeRead = before; e.bindingBefore = before?.binding ? { ...before.binding } : null;
      queueMicrotask(() => {
        if (!e || stopped) return;
        const target = root.querySelector<HTMLButtonElement>('button[aria-label="切换 Workspace"]');
        if (observed.settled || !e.bindingBefore || data(observed.args.binding).workspaceId !== e.bindingBefore.workspaceId ||
          data(observed.args.binding).generation !== e.bindingBefore.generation || !target || target.disabled ||
          !target.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
          return fail(Error('invalid: no pending inspect, configured-root binding or real Workspace switch button'));
        e.pendingAtClick = true; e.click = stamp(); target.click();
      });
    }
    return pending;
  };
  const wrappedCommand: typeof command = <T,>(name: string, payload?: Record<string, unknown>) => observe('command', name, payload, () => command<T>(name, payload));
  const wrappedFile: typeof fileCommand = <T,>(name: string, payload: Record<string, unknown>) => observe('fileCommand', name, payload, () => fileCommand<T>(name, payload));
  desktopApi.command = wrappedCommand; desktopApi.fileCommand = wrappedFile;
  button.onclick = () => {
    if (e) return; button.disabled = true; button.textContent = '已准备：请从 App 文件列表打开 File';
    e = { armed: stamp(), inspect: null, click: null, close: null, pendingAtClick: false, pendingAtClose: false,
      bindingBefore: null, bindingBeforeRead: null, bindingAfterRead: null, bindingError: null, bindingChecked: null,
      landing: null, final: null, empty: true, forbiddenAdditions: 0, raf: [] };
    dom = new MutationObserver(records => { inspectDOM(records); void check().catch(fail); });
    dom.observe(document.body, { childList: true, subtree: true });
    timer = setTimeout(() => fail(Error('invalid: missing pending/close/binding/landing/paint evidence before 120s deadline')), 120000);
  };
  return () => { disposed = true; if (e && !stopped) fail(Error('invalid: diagnostic disposed before completion'));
    dom?.disconnect(); button.remove();
    if (desktopApi.command === wrappedCommand) desktopApi.command = command;
    if (desktopApi.fileCommand === wrappedFile) desktopApi.fileCommand = fileCommand;
  };
}

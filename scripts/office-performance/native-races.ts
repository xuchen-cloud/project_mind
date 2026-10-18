/** #191 / #118: opt-in native pending-read acceptance, NOT a performance probe.
 * Main owns native-page integration; this module launches no process and owns no UI.
 * Dependencies: real native command promises, ProjectFileContent close guard,
 * onSourceReady and the existing content/paint readiness checks. Never hold,
 * replace, retry or synthesize a native response to manufacture a race window.
 *
 * Page handoff (not wired here):
 * - commandStarted(name, payload) at dispatch of the ORIGINAL desktopApi call;
 *   commandSettled(token, record.error) in its existing finally.
 * - ProjectFileContent onSourceReady: observer.sourceReady(file.object, source).
 * - AFTER mount's actual flushSync: observer.displayCommitted(file?.object ?? null).
 * - runPendingFileRace({observer, mount, close: closeDisplay, ready, settlePaint}, ...)
 *   inside a separate acceptance operation, outside performance samples. Pass
 *   root: rootElement; the module itself observes the actual closed DOM. mount
 *   selects the real component; ready checks the actual renderer/fixture witness;
 *   settlePaint is the existing bounded double-RAF helper. No cached debug state.
 *
 * Local tests validate recorded evidence/observer boundaries only. They are NOT
 * native acceptance. A native pass requires this bridge wired to the real page
 * and an authorized serial native run after builds stop.
 */
import type { AgentObjectRef, AgentSourceRef, AgentWorkspaceBinding } from '../../src/lib/agent-types';
import type { ProjectDirectoryFile } from '../../src/lib/file-types';

export const nativeRaceGaps = {
  workspace: 'This shell mounts ProjectFileContent directly, not App workspace-reset subscriptions. Calling workspace_close then manually unmounting only proves harness cleanup. Full coverage needs the real App invalidation path, a changed/null native binding, and observation through old request settlement.',
  history: 'The current mount bridge omits versionNumber and its public open accepts samples only. History coverage needs a real retained pre-edit version, actual version-menu/prop selection, immutable File/version/hash plus read-only renderer evidence, then a stale native restore/save CAS rejection with unchanged current bytes/version. Fixture metadata or mocked permission replies cannot substitute.',
} as const;

const readCommands = ['project_file_resolve', 'project_file_read_bytes', 'file_versions_list', 'file_office_inspect', 'file_source_read'] as const;
export type NativeRaceReadCommand = typeof readCommands[number];
type Action = 'switch' | 'close';
export interface NativeReadObservation {
  token: number; name: NativeRaceReadCommand; requestId: string | null;
  object: AgentObjectRef; binding: AgentWorkspaceBinding;
  started: number; settled: number | null; error: string | null;
}
interface SourceObservation { sequence: number; owner: AgentObjectRef; source: AgentSourceRef | null }
interface DisplayObservation { sequence: number; object: AgentObjectRef | null; pendingTokens: number[] }
export interface NativeRaceEvidence {
  action: Action; pendingObject: AgentObjectRef; replacementObject: AgentObjectRef | null;
  pendingToken: number; transition: DisplayObservation;
  reads: NativeReadObservation[]; sources: SourceObservation[]; displays: DisplayObservation[];
}

function sameFile(a: AgentObjectRef | null, b: AgentObjectRef | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === 'file' && b.kind === 'file' && a.workspaceId === b.workspaceId && a.id === b.id &&
    a.scope.kind === 'project' && b.scope.kind === 'project' && a.scope.projectId === b.scope.projectId;
}
function copyObject(object: AgentObjectRef): AgentObjectRef { return { ...object, scope: { ...object.scope } }; }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
function fileObject(value: unknown): AgentObjectRef | undefined {
  const object = record(value), scope = record(object?.scope);
  if (object?.kind !== 'file' || typeof object.workspaceId !== 'string' || typeof object.id !== 'string' ||
    scope?.kind !== 'project' || typeof scope.projectId !== 'number') return undefined;
  return { kind: 'file', workspaceId: object.workspaceId, id: object.id, scope: { kind: 'project', projectId: scope.projectId } };
}
function requireProof(condition: unknown, detail: string): asserts condition {
  if (!condition) throw Error(`Native race proof failed: ${detail}`);
}
export class NativeRaceNotObserved extends Error {
  readonly code = 'RACE_NOT_OBSERVED';
  constructor(detail: string) { super(detail); this.name = 'NativeRaceNotObserved'; }
}

/** Validates real observations; does not treat elapsed sleep or pointer state as proof. */
export function assertNativeRaceEvidence(evidence: NativeRaceEvidence): void {
  const { pendingObject: a, replacementObject: b, transition, pendingToken, reads, sources, displays } = evidence;
  requireProof(a.kind === 'file' && a.scope.kind === 'project', 'A is not a scoped File');
  requireProof(evidence.action === 'close' ? b === null : b !== null && !sameFile(a, b), 'switch requires a distinct File; close requires no replacement');
  requireProof(sameFile(transition.object, b), 'committed display does not match the requested action');
  const pending = reads.find(read => read.token === pendingToken && sameFile(read.object, a));
  requireProof(pending, 'no dispatched native read belonging to File A');
  requireProof(pending.started < transition.sequence && transition.pendingTokens.includes(pendingToken) &&
    (pending.settled === null || pending.settled > transition.sequence), 'File A did not remain pending through the actual UI commit');
  const oldReads = reads.filter(read => sameFile(read.object, a));
  requireProof(oldReads.every(read => read.settled !== null), 'File A native reads have not all settled');
  requireProof(oldReads.every(read => read.error === null), 'File A failed independently; no successful late response was exercised');
  requireProof(!oldReads.some(read => read.started > transition.sequence), 'File A started another read after cancellation');
  requireProof(sources.some(event => sameFile(event.owner, a)), 'actual onSourceReady observation was not connected');
  const late = sources.filter(event => event.sequence > transition.sequence && event.source !== null);
  requireProof(late.every(event => sameFile(event.owner, b) && sameFile(event.source!.object, b)), 'old or foreign async source replaced the target after cancellation');
  requireProof(displays.filter(event => event.sequence >= transition.sequence).every(event => sameFile(event.object, b)), 'old display was recommitted after cancellation');
  if (b) requireProof(late.some(event => sameFile(event.source!.object, b)), 'replacement File produced no actual source-ready observation');
}

/** Small observer for the page's existing bridge. It never invokes a command. */
export class NativeRaceObserver {
  private sequence = 0;
  private reads: NativeReadObservation[] = [];
  private sources: SourceObservation[] = [];
  private displays: DisplayObservation[] = [];
  private changed = new Set<() => void>();
  get cursor(): number { return this.sequence; }

  commandStarted(name: string, payload: unknown): number | null {
    if (!readCommands.some(command => command === name)) return null;
    const args = record(payload);
    // fileCommand uses {binding, object} / {binding, input}; agent commands use
    // {input:{binding,requestId,data:{object}}}. These are the production shapes.
    const input = name.startsWith('project_file_') ? args : record(args?.input);
    const object = fileObject(name === 'project_file_read_bytes' ? record(input?.input)?.object :
      name.startsWith('project_file_') ? input?.object : record(input?.data)?.object);
    const binding = record(input?.binding);
    requireProof(object && typeof binding?.workspaceId === 'string' && typeof binding.generation === 'string' &&
      object.workspaceId === binding.workspaceId, `missing File/binding identity on ${name}`);
    const sequence = ++this.sequence;
    this.reads.push({ token: sequence, name: name as NativeRaceReadCommand, object, binding: {
      workspaceId: binding.workspaceId, generation: binding.generation,
    }, requestId: typeof input?.requestId === 'string' ? input.requestId : null,
    started: sequence, settled: null, error: null });
    this.notify(); return sequence;
  }
  commandSettled(token: number | null, error: string | null = null): void {
    if (token === null) return;
    const read = this.reads.find(read => read.token === token);
    requireProof(read && read.settled === null, 'unknown or duplicate command settlement');
    read.settled = ++this.sequence; read.error = error; this.notify();
  }
  sourceReady(owner: AgentObjectRef, source: AgentSourceRef | null): void {
    this.sources.push({ sequence: ++this.sequence, owner: copyObject(owner),
      source: source ? { ...source, object: copyObject(source.object) } : null });
    this.notify();
  }
  displayCommitted(object: AgentObjectRef | null): void {
    this.displays.push({ sequence: ++this.sequence, object: object ? copyObject(object) : null,
      pendingTokens: this.reads.filter(read => read.settled === null).map(read => read.token) });
    this.notify();
  }
  watchClosedCommit(after: number, committed: () => void): () => void {
    const check = () => {
      if (this.displays.some(event => event.sequence > after && event.object === null)) {
        this.changed.delete(check); committed();
      }
    };
    this.changed.add(check);
    return () => this.changed.delete(check);
  }
  snapshot(after: number) {
    return { reads: this.reads.filter(read => read.started > after).map(read => ({ ...read, object: copyObject(read.object), binding: { ...read.binding } })),
      sources: this.sources.filter(event => event.sequence > after).map(event => ({ ...event })),
      displays: this.displays.filter(event => event.sequence > after).map(event => ({ ...event, pendingTokens: [...event.pendingTokens] })) };
  }
  async pending(object: AgentObjectRef, command: NativeRaceReadCommand, after: number): Promise<number> {
    await this.until(() => this.reads.some(read => read.started > after && sameFile(read.object, object) &&
      read.name === command && read.settled === null), 15000, `No pending real ${command} for File A; no race was observed`);
    const read = this.reads.find(read => read.started > after && sameFile(read.object, object) && read.name === command && read.settled === null);
    if (!read) throw new NativeRaceNotObserved('Native read settled before the cancellation action could begin');
    return read.token;
  }
  async drained(object: AgentObjectRef, after: number): Promise<void> {
    await this.until(() => this.reads.filter(read => read.started > after && sameFile(read.object, object))
      .every(read => read.settled !== null), 45000, 'Old native read did not settle; stale completion safety is unproven');
  }
  private notify(): void { for (const changed of this.changed) changed(); }
  private until(predicate: () => boolean, timeoutMs: number, detail: string): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { if (predicate()) { clearTimeout(timer); this.changed.delete(done); resolve(); } };
      const timer = setTimeout(() => { this.changed.delete(done); reject(new NativeRaceNotObserved(detail)); }, timeoutMs);
      this.changed.add(done);
    });
  }
}

export interface NativeRaceHooks {
  observer: NativeRaceObserver;
  root: HTMLElement;
  mount(file: ProjectDirectoryFile | null): void;
  close(): Promise<void>;
  /** Existing real content/fixture readiness, not just displayedFile/debugState. */
  ready(file: ProjectDirectoryFile): Promise<Record<string, unknown>>;
  settlePaint(): Promise<void>;
}
export interface PendingFileRaceOptions {
  action: Action; pendingFile: ProjectDirectoryFile; replacementFile?: ProjectDirectoryFile;
  /** Default tests pre-render File loading. Request inspect explicitly for a
   * cold, uncached Office File; warm cache hits cannot prove an inspect race. */
  pendingCommand?: NativeRaceReadCommand;
}

const surfaceSelector = '.project-file-content,iframe,.mind-markdown';
function assertClosed(root: HTMLElement): Record<string, unknown> {
  requireProof(!root.querySelector(surfaceSelector), 'actual file/editor/iframe surface remained or reappeared after close');
  return { closed: true, surfaceCount: root.querySelectorAll(surfaceSelector).length };
}
/** Observe additions themselves, not just the final DOM: a stale iframe added
 * and removed in one mutation batch must still fail. Armed synchronously by
 * the page's post-flushSync commit hook, before closeDisplay awaits paint. */
function observeClosedSurface(root: HTMLElement, observer: NativeRaceObserver, after: number) {
  const Mutation = root.ownerDocument.defaultView?.MutationObserver;
  requireProof(Mutation, 'actual DOM MutationObserver unavailable');
  let armed = false, mutations = 0;
  const additions: string[] = [];
  const inspect = (records: MutationRecord[]) => {
    if (!armed) return;
    mutations += records.length;
    for (const change of records) for (const node of change.addedNodes) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.matches(surfaceSelector) || element.querySelector(surfaceSelector)) additions.push(element.tagName);
    }
  };
  const dom = new Mutation(inspect);
  dom.observe(root, { subtree: true, childList: true });
  const stopCommit = observer.watchClosedCommit(after, () => {
    dom.takeRecords(); armed = true; assertClosed(root);
  });
  return {
    check() {
      inspect(dom.takeRecords());
      requireProof(armed, 'closed DOM guard never observed an actual close commit');
      requireProof(!additions.length, 'file/editor/iframe was added again after close, even if later removed');
      return { ...assertClosed(root), mutationRecords: mutations, forbiddenAdditions: [...additions],
        scope: 'actual root DOM from committed close through old-read settlement and final paint checks' };
    },
    dispose() { stopCommit(); dom.disconnect(); },
  };
}

export async function runPendingFileRace(hooks: NativeRaceHooks, options: PendingFileRaceOptions) {
  const { action, pendingFile: a, replacementFile: b, pendingCommand = 'file_versions_list' } = options;
  requireProof(action === 'close' ? !b : b && !sameFile(a.object, b.object), 'invalid pending switch/close inputs');
  // Establish a clean real surface; do not cancel dirty edits by force-unmounting.
  await hooks.close();
  const after = hooks.observer.cursor;
  hooks.mount(a);
  const pendingToken = await hooks.observer.pending(a.object, pendingCommand, after);
  const closedDom = action === 'close' ? observeClosedSurface(hooks.root, hooks.observer, pendingToken) : undefined;
  try {
  if (action === 'switch') hooks.mount(b!);
  else await hooks.close();
  const target = action === 'switch' ? b!.object : null;
  const transition = hooks.observer.snapshot(after).displays.find(event => event.sequence > pendingToken && sameFile(event.object, target));
  if (!transition || !transition.pendingTokens.includes(pendingToken))
    throw new NativeRaceNotObserved('File A did not remain pending through the actual switch/close commit; retry only in a separate authorized run');
  await hooks.observer.drained(a.object, after);
  const finalSurface = action === 'switch' ? await hooks.ready(b!) : closedDom!.check();
  await hooks.settlePaint();
  // Check again after native completions + actual target readiness + paint.
  const finalCheck = action === 'switch' ? await hooks.ready(b!) : closedDom!.check();
  const evidence: NativeRaceEvidence = { action, pendingObject: copyObject(a.object), replacementObject: target,
    pendingToken, transition, ...hooks.observer.snapshot(after) };
  assertNativeRaceEvidence(evidence);
  return { kind: 'acceptance', status: 'passed', name: `pending_file_${action}`, evidence, finalSurface, finalCheck,
    scope: 'native File read pending through real UI commit; old reads settled without stale source/display; target renderer or empty shell rechecked',
    pendingCommand, cancellation: 'component lifetime cancellation; native request is allowed to finish, not proof of worker termination',
    observationBoundary: 'through recorded A read settlement, actual target readiness and bounded paint checks; no artificial response delay',
    gaps: nativeRaceGaps };
  } finally { closedDom?.dispose(); }
}

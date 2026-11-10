import type { AgentObjectRef, AgentWorkspaceBinding } from "./agent-types";
import type { ContentOwnerMoved } from "./content-owner-move-events";

export type MovingContentObject = { kind: "record" | "file"; id: number };
type ProjectCloseGuard = {
  workspaceRoot: string;
  projectId: number | null;
  binding?: AgentWorkspaceBinding;
  moveEventsReady?: () => boolean;
  isCurrent?: () => boolean;
  viewIdentity?: (object: MovingContentObject) => string | undefined;
  prepare: (object?: MovingContentObject) => Promise<void>;
  lockObject?: (object: MovingContentObject) => () => void;
  moved?: (object: MovingContentObject, nativeSessionsClosed: boolean) => void;
  closeMoved?: (object: MovingContentObject) => Promise<void>;
};
type WorkspaceRecordCloseGuard = { workspaceRoot: string; recordId: number; prepare: () => Promise<void> };
const workspaceRecords = new Map<string, WorkspaceRecordCloseGuard>();
const projects = new Map<string, ProjectCloseGuard>();
const key = (workspaceRoot: string, projectId: number | null) => JSON.stringify([workspaceRoot, projectId]);
export interface ContentOwnerMoveRelease {
  binding: AgentWorkspaceBinding;
  operationId: string;
  source: AgentObjectRef;
}
const barriers = new Map<string, { guard?: ProjectCloseGuard; release: () => void; participants: Set<symbol>; terminalConfirmed: boolean }>();
const completed = new WeakMap<ProjectCloseGuard, Map<string, Promise<void>>>();
type ObjectMove = { holders: number; unlock?: () => void; completion?: Promise<void>; completedView?: string };
const moves = new WeakMap<ProjectCloseGuard, Map<string, ObjectMove>>();
const objectKey = (object: MovingContentObject) => `${object.kind}:${object.id}`;
function moveState(guard: ProjectCloseGuard, object: MovingContentObject) {
  let objects = moves.get(guard);
  if (!objects) { objects = new Map(); moves.set(guard, objects); }
  let state = objects.get(objectKey(object));
  if (!state) { state = { holders: 0 }; objects.set(objectKey(object), state); }
  return state;
}
function holdObject(guard: ProjectCloseGuard | undefined, object: MovingContentObject, shared = false) {
  if (!guard) return () => {};
  const state = moveState(guard, object);
  if (state.holders && !shared) throw new Error("该内容正在移动，请等待完成");
  if (!state.holders) { state.unlock = guard.lockObject?.(object); state.completion = undefined; }
  ++state.holders;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.holders === 0) { state.unlock?.(); state.unlock = undefined; }
  };
}
function closeMoved(guard: ProjectCloseGuard | undefined, object: MovingContentObject, nativeSessionsClosed: boolean) {
  if (!guard || !isCurrentGuard(guard)) return Promise.resolve();
  const state = moveState(guard, object);
  const view = guard.viewIdentity?.(object);
  if (guard.viewIdentity && !view) return state.completion ?? Promise.resolve();
  if (view !== state.completedView) state.completion = undefined;
  if (!state.completion) {
    state.completedView = view;
    guard.moved?.(object, nativeSessionsClosed);
    state.completion = Promise.resolve().then(() => { if (isCurrentGuard(guard)) return guard.closeMoved?.(object); });
  }
  return state.completion;
}
const sameBinding = (a: AgentWorkspaceBinding, b: AgentWorkspaceBinding) => a.workspaceId === b.workspaceId && a.generation === b.generation;
const isCurrentGuard = (guard: ProjectCloseGuard) => projects.get(key(guard.workspaceRoot, guard.projectId)) === guard && guard.isCurrent?.() !== false;
const operationKey = ({ binding, source, operationId }: ContentOwnerMoveRelease) => JSON.stringify([
  binding.workspaceId, binding.generation, source.workspaceId, source.scope.kind,
  source.scope.kind === "project" ? source.scope.projectId : null, source.kind, source.id, operationId,
]);
function matchingGuard(binding: AgentWorkspaceBinding, source: AgentObjectRef) {
  if (source.workspaceId !== binding.workspaceId) return;
  const projectId = source.scope.kind === "project" ? source.scope.projectId : null;
  return [...projects.values()].find(guard => guard.projectId === projectId && guard.binding && sameBinding(guard.binding, binding) && isCurrentGuard(guard));
}
function movingObject(source: AgentObjectRef): MovingContentObject {
  const id = Number(source.id);
  if ((source.kind !== "record" && source.kind !== "file") || !Number.isSafeInteger(id) || id <= 0 || String(id) !== source.id) {
    throw new Error("移动对象身份无效");
  }
  return { kind: source.kind, id };
}

/** Capture remains owned by the registered editor; this helper never saves twice. */
export function prepareContentOwnerMove<T>(binding: AgentWorkspaceBinding, source: AgentObjectRef, operationId: string, flush: () => Promise<T>): Promise<T> {
  if (source.workspaceId !== binding.workspaceId) return Promise.reject(new Error("移动对象工作区不符"));
  const id = operationKey({ binding, source, operationId });
  const object = movingObject(source);
  let barrier = barriers.get(id);
  if (!barrier) {
    const guard = matchingGuard(binding, source);
    if (guard?.moveEventsReady?.() === false) return Promise.reject(new Error("移动通知尚未就绪，请稍后重试"));
    barrier = { guard, release: holdObject(guard, object, true), participants: new Set(), terminalConfirmed: false };
    barriers.set(id, barrier);
  }
  const captured = barrier;
  // Every registered editor captures independently; only its object lock is shared.
  return Promise.resolve().then(flush).catch(failure => {
    if (barriers.get(id) === captured) { barriers.delete(id); captured.release(); }
    throw failure;
  });
}

export function hasPendingContentOwnerMove(identity: ContentOwnerMoveRelease): boolean {
  return barriers.has(operationKey(identity));
}

/** Captured instances retire independently before a confirmed replacement unlocks. */
export function registerContentOwnerMoveParticipant(identity: ContentOwnerMoveRelease): { complete(): void; dispose(): void } {
  const id = operationKey(identity);
  const captured = barriers.get(id);
  const token = Symbol();
  captured?.participants.add(token);
  let settled = false;
  const finish = (terminalConfirmed: boolean) => {
    if (settled) return;
    settled = true;
    if (!captured || barriers.get(id) !== captured) return;
    captured.participants.delete(token);
    if (terminalConfirmed) captured.terminalConfirmed = true;
    if (captured.terminalConfirmed && captured.participants.size === 0) {
      barriers.delete(id);
      captured.release();
    }
  };
  return { complete: () => finish(true), dispose: () => finish(false) };
}

export function releaseContentOwnerMove(event: ContentOwnerMoveRelease) {
  const id = operationKey(event);
  const barrier = barriers.get(id);
  if (barrier) { barriers.delete(id); barrier.release(); }
}

/** Native success closes the saved source view without invoking any save guard. */
export async function completeContentOwnerMove(event: ContentOwnerMoved) {
  const guard = matchingGuard(event.binding, event.source);
  if (!guard || (event.source.kind !== "record" && event.source.kind !== "file")) return;
  const barrier = barriers.get(operationKey(event));
  if (!barrier || barrier.guard !== guard) return;
  return completeMoved(guard, event, event.oldSessionsClosed);
}

function completeMoved(guard: ProjectCloseGuard | undefined, identity: ContentOwnerMoveRelease, nativeSessionsClosed: boolean) {
  if (!guard) { releaseContentOwnerMove(identity); return Promise.resolve(); }
  const id = operationKey(identity);
  let receipts = completed.get(guard);
  if (!receipts) { receipts = new Map(); completed.set(guard, receipts); }
  if (receipts.has(id)) return receipts.get(id);
  const object = movingObject(identity.source);
  const closing = closeMoved(guard, object, nativeSessionsClosed).finally(() => releaseContentOwnerMove(identity));
  receipts.set(id, closing);
  return closing;
}

/** Window-local guards retain actual editor ownership; no business content is stored here. */
export function registerProjectContentCloseGuard(guard: ProjectCloseGuard) {
  const id = key(guard.workspaceRoot, guard.projectId);
  projects.set(id, guard);
  return () => {
    if (projects.get(id) === guard) projects.delete(id);
    for (const [operation, barrier] of barriers) {
      if (barrier.guard === guard) { barriers.delete(operation); barrier.release(); }
    }
  };
}
export async function prepareProjectContentClose(workspaceRoot: string, projectId: number | null) {
  await projects.get(key(workspaceRoot, projectId))?.prepare();
}

/** The move callback reads its native CAS baseline after this object's editor saves. */
export async function withProjectContentMove<T>(workspaceRoot: string, projectId: number | null, object: MovingContentObject, move: () => Promise<T>, options: { nativeSessionsClosed?: boolean; moveIdentity?: ContentOwnerMoveRelease } = {}): Promise<T> {
  const guard = projects.get(key(workspaceRoot, projectId));
  if (guard?.moveEventsReady?.() === false) throw new Error("移动通知尚未就绪，请稍后重试");
  const unlock = holdObject(guard, object);
  try {
    await guard?.prepare(object);
    const result = await move();
    if (options.moveIdentity) await completeMoved(guard, options.moveIdentity, options.nativeSessionsClosed === true);
    else await closeMoved(guard, object, options.nativeSessionsClosed === true);
    return result;
  } finally { unlock?.(); }
}
export function registerWorkspaceRecordCloseGuard(guard: WorkspaceRecordCloseGuard) {
  const id = key(guard.workspaceRoot, guard.recordId);
  workspaceRecords.set(id, guard);
  return () => { if (workspaceRecords.get(id) === guard) workspaceRecords.delete(id); };
}
export async function prepareWorkspaceContentClose(workspaceRoot: string) {
  const guards = [...projects.values(), ...workspaceRecords.values()];
  for (const guard of guards) if (guard.workspaceRoot === workspaceRoot) await guard.prepare();
}

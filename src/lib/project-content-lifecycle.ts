export type MovingContentObject = { kind: "record" | "file"; id: number };
type ProjectCloseGuard = {
  workspaceRoot: string;
  projectId: number | null;
  prepare: (object?: MovingContentObject) => Promise<void>;
  lockObject?: (object: MovingContentObject) => () => void;
  moved?: (object: MovingContentObject, nativeSessionsClosed: boolean) => void;
  closeMoved?: (object: MovingContentObject) => Promise<void>;
};
type WorkspaceRecordCloseGuard = { workspaceRoot: string; recordId: number; prepare: () => Promise<void> };
const workspaceRecords = new Map<string, WorkspaceRecordCloseGuard>();
const projects = new Map<string, ProjectCloseGuard>();
const key = (workspaceRoot: string, projectId: number | null) => JSON.stringify([workspaceRoot, projectId]);

/** Window-local guards retain actual editor ownership; no business content is stored here. */
export function registerProjectContentCloseGuard(guard: ProjectCloseGuard) {
  const id = key(guard.workspaceRoot, guard.projectId);
  projects.set(id, guard);
  return () => { if (projects.get(id) === guard) projects.delete(id); };
}
export async function prepareProjectContentClose(workspaceRoot: string, projectId: number | null) {
  await projects.get(key(workspaceRoot, projectId))?.prepare();
}

/** The move callback reads its native CAS baseline after this object's editor saves. */
export async function withProjectContentMove<T>(workspaceRoot: string, projectId: number | null, object: MovingContentObject, move: () => Promise<T>, options: { nativeSessionsClosed?: boolean } = {}): Promise<T> {
  const guard = projects.get(key(workspaceRoot, projectId));
  const unlock = guard?.lockObject?.(object);
  try {
    await guard?.prepare(object);
    const result = await move();
    guard?.moved?.(object, options.nativeSessionsClosed === true);
    await guard?.closeMoved?.(object);
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

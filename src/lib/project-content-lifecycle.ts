type ProjectCloseGuard = { workspaceRoot: string; projectId: number | null; prepare: () => Promise<void> };
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
export function registerWorkspaceRecordCloseGuard(guard: WorkspaceRecordCloseGuard) {
  const id = key(guard.workspaceRoot, guard.recordId);
  workspaceRecords.set(id, guard);
  return () => { if (workspaceRecords.get(id) === guard) workspaceRecords.delete(id); };
}
export async function prepareWorkspaceContentClose(workspaceRoot: string) {
  const guards = [...projects.values(), ...workspaceRecords.values()];
  for (const guard of guards) if (guard.workspaceRoot === workspaceRoot) await guard.prepare();
}

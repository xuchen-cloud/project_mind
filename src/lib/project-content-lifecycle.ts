type ProjectCloseGuard = { workspaceRoot: string; projectId: number; prepare: () => Promise<void> };
const projects = new Map<string, ProjectCloseGuard>();
const key = (workspaceRoot: string, projectId: number) => JSON.stringify([workspaceRoot, projectId]);

/** Window-local guards retain actual editor ownership; no business content is stored here. */
export function registerProjectContentCloseGuard(guard: ProjectCloseGuard) {
  const id = key(guard.workspaceRoot, guard.projectId);
  projects.set(id, guard);
  return () => { if (projects.get(id) === guard) projects.delete(id); };
}
export async function prepareProjectContentClose(workspaceRoot: string, projectId: number) {
  await projects.get(key(workspaceRoot, projectId))?.prepare();
}
export async function prepareWorkspaceContentClose(workspaceRoot: string) {
  for (const guard of projects.values()) if (guard.workspaceRoot === workspaceRoot) await guard.prepare();
}

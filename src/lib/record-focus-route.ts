export type RecordFocusRoute =
  | { key: string; kind: "project"; projectId: number; recordId: number }
  | { key: string; kind: "workspace"; recordId: number };

export function parseRecordFocusRoute(pathname: string): RecordFocusRoute | null {
  const projectMatch = /^\/projects\/(\d+)\/records\/(\d+)$/u.exec(pathname);
  if (projectMatch) {
    const projectId = Number.parseInt(projectMatch[1] ?? "", 10);
    const recordId = Number.parseInt(projectMatch[2] ?? "", 10);
    if (Number.isFinite(projectId) && Number.isFinite(recordId)) {
      return {
        key: `project:${projectId}:${recordId}`,
        kind: "project",
        projectId,
        recordId,
      };
    }
  }

  const workspaceMatch = /^\/workspace\/records\/(\d+)$/u.exec(pathname);
  if (!workspaceMatch) return null;
  const recordId = Number.parseInt(workspaceMatch[1] ?? "", 10);
  return Number.isFinite(recordId)
    ? { key: `workspace:${recordId}`, kind: "workspace", recordId }
    : null;
}

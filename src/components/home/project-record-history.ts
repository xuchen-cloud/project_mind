export function recentProjectRecordKey(workspaceRoot: string, projectId: number) {
  return `project-mind:recent-records:${workspaceRoot}:${projectId}`;
}

export function rememberProjectRecord(workspaceRoot: string, projectId: number, recordId: number) {
  const key = recentProjectRecordKey(workspaceRoot, projectId);
  let ids: number[] = [];
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); ids = Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : []; } catch { /* reset invalid history */ }
  try {
    localStorage.setItem(key, JSON.stringify([recordId, ...ids.filter((id) => id !== recordId)].slice(0, 20)));
    window.dispatchEvent(new Event("home-record-history-changed"));
  } catch { /* Navigation still works when device storage is unavailable. */ }
}


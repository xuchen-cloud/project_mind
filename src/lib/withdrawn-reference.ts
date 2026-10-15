/** Native resolver failures alone offer recovery; quoted model data is never read here. */
export interface WithdrawnReference {
  workspaceId: string | null;
  creationOperationId: string | null;
  withdrawalRevision: number | null;
  restoreAvailable: boolean;
}

export function withdrawnReference(error: unknown): WithdrawnReference | null {
  let value: unknown = error;
  const text = typeof error === "string" ? error : error instanceof Error && !("code" in error) ? error.message : null;
  if (text) {
    try { value = JSON.parse(text.replace(/^Error:\s*/i, "")); } catch { return null; }
  }
  if (!value || typeof value !== "object" || !("code" in value) || value.code !== "OBJECT_WITHDRAWN") return null;
  const details = "details" in value && value.details && typeof value.details === "object" ? value.details as Record<string, unknown> : {};
  const candidateWorkspace = details.workspaceId ?? (typeof details.objectKey === "string" ? details.objectKey.split("/")[0] : null);
  const workspaceId = typeof candidateWorkspace === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(candidateWorkspace) ? candidateWorkspace : null;
  const creationOperationId = typeof details.creationOperationId === "string" && /^[a-f0-9]{32}$/.test(details.creationOperationId) ? details.creationOperationId : null;
  const withdrawalRevision = typeof details.withdrawalRevision === "number" && Number.isSafeInteger(details.withdrawalRevision) && details.withdrawalRevision > 0 ? details.withdrawalRevision : null;
  return { workspaceId, creationOperationId, withdrawalRevision, restoreAvailable: details.restoreAvailable === true && !!workspaceId && !!creationOperationId && withdrawalRevision !== null };
}

import type { AgentObjectRef, AgentOperationEntry } from "./agent-types";

export type AgentOperationChainReason = "revision_gap" | "snapshot_mismatch" | "missing_revision" | "missing_snapshot";

/** Receipt history only: continuity does not verify the current native object head. */
export interface AgentOperationGroup {
  runId: string;
  objectKey: string;
  object: AgentObjectRef;
  change: "created" | "modified";
  operations: AgentOperationEntry[];
  operationIds: string[];
  chain: { state: "continuous" | "discontinuous" | "unknown"; reason: AgentOperationChainReason | null };
  undo: { state: "available" | "undone" | "unavailable" | "partial"; available: number; undone: number; unavailable: number };
  recovery: AgentOperationEntry["recovery"];
}

const businessKinds = new Set(["record.create", "record.patch", "todo.create", "todo.update", "file.create", "file.version.commit"]);
const creationKinds = new Set(["record.create", "todo.create", "file.create"]);
const fileChainUndoRequest = /^filechainundo:[0-9a-f]{32}:[0-9a-f]{32}$/;

function objectKey(object: AgentObjectRef): string {
  return JSON.stringify([object.workspaceId, object.scope.kind, object.scope.kind === "project" ? object.scope.projectId : null, object.kind, object.id]);
}

function chainReason(previous: AgentOperationEntry, current: AgentOperationEntry): AgentOperationChainReason | null {
  if (previous.afterRevision === null || current.beforeRevision === null) return "missing_revision";
  if (previous.afterRevision !== current.beforeRevision) return "revision_gap";
  if (previous.afterSnapshotRef === null || current.beforeSnapshotRef === null) return "missing_snapshot";
  // Record action boundaries create fresh version IDs for the same canonical
  // head revision (record_documents::record_commit_transaction). ID inequality
  // alone is not a discontinuity. Todo/File snapshots are revision identities.
  if (previous.afterSnapshotRef !== current.beforeSnapshotRef && current.object.kind !== "record") return "snapshot_mismatch";
  return null;
}

/** Pass operationList pages concatenated in their native rowid order; never sort. */
export function groupAgentOperations(runId: string, operations: readonly AgentOperationEntry[]): AgentOperationGroup[] {
  const grouped = new Map<string, AgentOperationEntry[]>();
  for (const operation of operations) {
    if (operation.runId !== runId || !businessKinds.has(operation.kind)) continue;
    // File undo writes a new native version under file.version.commit. Its
    // trusted service reserves this request prefix; the wire DTO omits the
    // receipt's context.recovery field, so kind alone cannot exclude it.
    if (operation.kind === "file.version.commit"
      && (operation.requestId.startsWith("fileundo:") || fileChainUndoRequest.test(operation.requestId))) continue;
    // The wire receipt has no noChange flag. Native no-change modification
    // receipts are unavailable and retain the same non-null revision.
    if (!creationKinds.has(operation.kind) && operation.undoState === "unavailable"
      && operation.beforeRevision !== null && operation.beforeRevision === operation.afterRevision) continue;
    const key = objectKey(operation.object);
    const group = grouped.get(key);
    if (group) group.push(operation);
    else grouped.set(key, [operation]);
  }
  return [...grouped.values()].map(receipts => {
    const first = receipts[0];
    const creation = receipts.find(receipt => creationKinds.has(receipt.kind));
    const reasons = receipts.slice(1).map((receipt, index) => chainReason(receipts[index], receipt));
    const discontinuity = reasons.find(reason => reason === "revision_gap" || reason === "snapshot_mismatch");
    const uncertainty = reasons.find(reason => reason !== null);
    const counts = { available: 0, undone: 0, unavailable: 0 };
    for (const receipt of receipts) counts[receipt.undoState]++;
    const undoState = counts.available === receipts.length ? "available"
      : counts.undone === receipts.length ? "undone"
      : counts.unavailable === receipts.length ? "unavailable" : "partial";
    return {
      runId, objectKey: objectKey(first.object), object: first.object,
      change: creation ? "created" : "modified", operations: receipts,
      operationIds: receipts.map(receipt => receipt.operationId),
      chain: {
        state: discontinuity ? "discontinuous" : uncertainty ? "unknown" : "continuous",
        reason: discontinuity ?? uncertainty ?? null,
      },
      undo: { state: undoState, ...counts }, recovery: creation?.recovery ?? null,
    };
  });
}

import { expect, it } from "vitest";
import type { AgentObjectRef, AgentOperationEntry } from "./agent-types";
import { groupAgentOperations } from "./agent-operation-groups";

const object: AgentObjectRef = { workspaceId: "w", scope: { kind: "workspace" }, kind: "record", id: "7" };
function receipt(operationId: string, overrides: Partial<AgentOperationEntry> = {}): AgentOperationEntry {
  return { operationId, runId: "run", requestId: operationId, kind: "record.patch", object,
    beforeRevision: 1, afterRevision: 2, beforeSnapshotRef: "v1", afterSnapshotRef: "v2",
    undoState: "available", undoOperationId: null, createdAt: "2026-10-08T12:00:00Z", recovery: null, ...overrides };
}

it("preserves native order across equal timestamps and random IDs, including interleaved objects", () => {
  const operations = [receipt("z"), receipt("other", { object: { ...object, id: "8" } }), receipt("a", { beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "v2", afterSnapshotRef: "v3" })];
  const groups = groupAgentOperations("run", operations);
  expect(groups.map(group => group.operationIds)).toEqual([["z", "a"], ["other"]]);
  expect(groups[0].operations).toEqual([operations[0], operations[2]]);
  expect(groups[0].chain).toMatchObject({ state: "continuous", reason: null });
  expect(operations.map(operation => operation.operationId)).toEqual(["z", "other", "a"]);
});

it("marks creation plus two edits as created and accepts fresh Record snapshots of the same revision", () => {
  const recovery = { withdrawn: false, withdrawalRevision: null, restoreAvailable: false };
  const groups = groupAgentOperations("run", [
    receipt("create", { kind: "record.create", beforeRevision: null, afterRevision: 1, beforeSnapshotRef: null, afterSnapshotRef: "created-v1", recovery }),
    receipt("edit1", { beforeSnapshotRef: "boundary-v1", afterSnapshotRef: "saved-v2" }),
    receipt("edit2", { beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "boundary-v2", afterSnapshotRef: "saved-v3" }),
  ]);
  expect(groups[0]).toMatchObject({ change: "created", operationIds: ["create", "edit1", "edit2"], recovery, chain: { state: "continuous" } });
  expect(groups[0].chain.reason).toBeNull();
  expect(groups[0].operations[2]).toMatchObject({ beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "boundary-v2", afterSnapshotRef: "saved-v3" });
});

it("reports a revision gap even when snapshot IDs match, without claiming undo success", () => {
  const group = groupAgentOperations("run", [receipt("a"), receipt("b", { beforeRevision: 5, afterRevision: 6, beforeSnapshotRef: "v2" })])[0];
  expect(group.change).toBe("modified");
  expect(group.chain).toMatchObject({ state: "discontinuous", reason: "revision_gap" });
  expect(group.undo).toEqual({ state: "available", available: 2, undone: 0, unavailable: 0 });
});

it("isolates kinds, scopes, workspaces and runs even with the same object ID", () => {
  const objects: AgentObjectRef[] = [object, { ...object, kind: "todo" }, { ...object, kind: "file" }, { ...object, scope: { kind: "project", projectId: 1 } }, { ...object, scope: { kind: "project", projectId: 2 } }, { ...object, workspaceId: "other" }];
  const operations = objects.map((target, index) => receipt(String(index), { object: target, kind: target.kind === "todo" ? "todo.update" : target.kind === "file" ? "file.version.commit" : "record.patch" }));
  operations.push(receipt("different-run", { runId: "run2" }));
  const groups = groupAgentOperations("run", operations);
  expect(groups).toHaveLength(6);
  expect(new Set(groups.map(group => group.objectKey)).size).toBe(6);
  expect(groups.map(group => group.operationIds)).toEqual(operations.slice(0, 6).map(operation => [operation.operationId]));
  expect(groupAgentOperations("run2", operations).map(group => group.operationIds)).toEqual([["different-run"]]);
  expect(groupAgentOperations("run", [receipt("no-run", { runId: null })])).toEqual([]);
});

it("filters management and no-change receipts while retaining changed but unavailable history", () => {
  const operations = ["record.undo", "record.restore_created", "todo.undo", "todo.restore_created", "file.undo", "file.restore_created", "record.document.commit"].map(kind => receipt(kind, { kind }));
  operations.push(receipt("nochange", { kind: "file.version.commit", object: { ...object, kind: "file" }, beforeRevision: 2, afterRevision: 2, undoState: "unavailable" }));
  operations.push(receipt("legacy-changed", { undoState: "unavailable" }));
  expect(groupAgentOperations("run", operations).map(group => group.operationIds)).toEqual([["legacy-changed"]]);
  expect(groupAgentOperations("run", [])).toEqual([]);
});

it("keeps mixed undo status partial and preserves actual creation recovery", () => {
  const recovery = { withdrawn: true, withdrawalRevision: 1, restoreAvailable: true };
  const group = groupAgentOperations("run", [
    receipt("create", { kind: "todo.create", object: { ...object, kind: "todo" }, undoState: "undone", undoOperationId: "withdraw", recovery }),
    receipt("edit", { kind: "todo.update", object: { ...object, kind: "todo" }, beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "v2" }),
  ])[0];
  expect(group.undo).toEqual({ state: "partial", available: 1, undone: 1, unavailable: 0 });
  expect(group.recovery).toEqual(recovery);
  expect(group.operations[0].undoOperationId).toBe("withdraw");
});

it("excludes actual File undo version receipts without filtering ordinary unavailable modifications", () => {
  const file = { ...object, kind: "file" as const };
  const original = receipt("original", { kind: "file.version.commit", object: file, undoState: "undone", undoOperationId: "undo-native" });
  const undo = receipt("undo-native", {
    kind: "file.version.commit", object: file, requestId: "fileundo:original", undoState: "unavailable",
    beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "v2", afterSnapshotRef: "v3",
  });
  const unavailable = receipt("ordinary", {
    kind: "file.version.commit", object: file, requestId: "ordinary-request", undoState: "unavailable",
    beforeRevision: 3, afterRevision: 4, beforeSnapshotRef: "v3", afterSnapshotRef: "v4",
  });
  const group = groupAgentOperations("run", [original, undo, unavailable])[0];
  expect(group.operationIds).toEqual(["original", "ordinary"]);
  expect(group.undo).toEqual({ state: "partial", available: 0, undone: 1, unavailable: 1 });
  expect(group.chain).toEqual({ state: "discontinuous", reason: "revision_gap" });
});

it("excludes the exact native File chain undo request while retaining similar ordinary request IDs", () => {
  const firstId = "a".repeat(32), lastId = "b".repeat(32), undoId = "c".repeat(32);
  const file = { ...object, kind: "file" as const };
  const first = receipt(firstId, { kind: "file.version.commit", object: file, undoState: "undone", undoOperationId: undoId, beforeSnapshotRef: "1", afterSnapshotRef: "2" });
  const last = receipt(lastId, { kind: "file.version.commit", object: file, undoState: "undone", undoOperationId: undoId, beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "2", afterSnapshotRef: "3" });
  const recovery = receipt(undoId, {
    kind: "file.version.commit", object: file, requestId: `filechainundo:${firstId}:${lastId}`, undoState: "unavailable",
    beforeRevision: 3, afterRevision: 4, beforeSnapshotRef: "3", afterSnapshotRef: "4",
  });
  const group = groupAgentOperations("run", [first, last, recovery])[0];
  expect(group.operationIds).toEqual([firstId, lastId]);
  expect(group.undo).toEqual({ state: "undone", available: 0, undone: 2, unavailable: 0 });
  expect(group.chain).toEqual({ state: "continuous", reason: null });
  for (const requestId of [`ordinary:filechainundo:${firstId}:${lastId}`, `filechainundo:${firstId}:${lastId}:extra`, "filechainundo:first:last"]) {
    expect(groupAgentOperations("run", [first, last, { ...recovery, requestId }])[0].operationIds).toEqual([firstId, lastId, recovery.operationId]);
  }
});

it.each(["todo", "file"] as const)("does not equate mismatching %s snapshot identities, or missing chain evidence", kind => {
  const target = { ...object, kind };
  const operationKind = kind === "todo" ? "todo.update" : "file.version.commit";
  const first = receipt("a", { kind: operationKind, object: target });
  const second = receipt("b", { kind: operationKind, object: target, beforeRevision: 2, afterRevision: 3, beforeSnapshotRef: "different-v2" });
  expect(groupAgentOperations("run", [first, second])[0].chain).toMatchObject({ state: "discontinuous", reason: "snapshot_mismatch" });
  expect(groupAgentOperations("run", [first, { ...second, beforeSnapshotRef: null }])[0].chain.state).toBe("unknown");
});

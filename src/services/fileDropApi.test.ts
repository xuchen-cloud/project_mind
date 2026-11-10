import { beforeEach, expect, it, vi } from "vitest";
import { createFileDropBatch } from "./fileDropApi";
import { publishFileReplacedReceipt } from "../lib/content-owner-move-events";
import { prepareContentOwnerMove, registerProjectContentCloseGuard, releaseContentOwnerMove } from "../lib/project-content-lifecycle";
vi.mock("../lib/content-owner-move-events", () => ({ publishFileReplacedReceipt: vi.fn() }));
const ipc = vi.hoisted(() => vi.fn());
const agent = vi.hoisted(() => vi.fn());
vi.mock("./desktopApi", () => ({ desktopApi: { fileCommand: ipc, command: agent } }));
const binding = { workspaceId: "workspace", generation: "generation" };
beforeEach(() => { vi.mocked(publishFileReplacedReceipt).mockReset(); ipc.mockReset(); agent.mockReset().mockImplementation(async (_command, args) => ({ apiVersion: 1, requestId: args.input.requestId, ok: true, data: null })); });
it.each([false, true])("confirms the same local replacement terminal from its successful receipt when no native event arrives (noChange=%s)", async noChange => {
  ipc.mockImplementation(async command => command === "file_drop_prepare" ? { intentId: "intent" }
    : { documentId: 4, versionNumber: 3, contentHash: "h3", noChange, oldSessionsClosed: !noChange, cleanupWarning: null });
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/managed.md", expectedVersionNumber: 2 } }]);
  await batch.run();
  expect(publishFileReplacedReceipt).toHaveBeenCalledExactlyOnceWith({ binding, operationId: ipc.mock.calls[0][1].requestId,
    object: { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: 7 }, kind: "file", id: "4" },
    versionNumber: 3, contentHash: "h3", noChange, oldSessionsClosed: !noChange });
  await batch.run();
  expect(publishFileReplacedReceipt).toHaveBeenCalledOnce();
});
it.each(["native", "transport", "identity"] as const)("keeps the draft and releases only a confirmed failure when release events are lost (%s failure)", async failureKind => {
  const uncertain = failureKind !== "native";
  const object = { workspaceId: binding.workspaceId, scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "4" };
  let locked = false, operationId = "";
  const closeMoved = vi.fn();
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding, prepare: async () => {}, closeMoved,
    lockObject: () => { locked = true; return () => { locked = false; }; } });
  agent.mockImplementation(async (command, args) => {
    if (command === "file_editors_flush") {
      operationId = args.input.requestId;
      await prepareContentOwnerMove(binding, object, operationId, async () => {});
      if (failureKind === "identity") return { apiVersion: 1, requestId: "wrong-response", ok: true, data: null };
    }
    return { apiVersion: 1, requestId: args.input.requestId, ok: true, data: null };
  });
  ipc.mockRejectedValue(failureKind === "transport" ? new Error("response lost") : { code: "REVISION_CONFLICT", message: "changed" });
  try {
    const [outcome] = await createFileDropBatch(binding, [{ sourcePath: "/source.md", target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/managed.md", expectedVersionNumber: 2 } }]).run();
    expect(outcome).toMatchObject({ status: "error", uncertain });
    expect(locked).toBe(uncertain);
    expect(closeMoved).not.toHaveBeenCalled(); expect(publishFileReplacedReceipt).not.toHaveBeenCalled();
  } finally { releaseContentOwnerMove({ binding, operationId, source: object }); stop(); }
});
it("keeps each source's committed result and cleanup warning when another destination fails", async () => {
  const denied = { code: "SCOPE_DENIED", message: "denied", details: { owner: 7 } };
  ipc.mockImplementation(async (command, args) => {
    if (command === "file_drop_prepare") {
      if (args.sourcePath === "/bad.pdf") throw denied;
      return { intentId: "intent-a" };
    }
    return { documentId: 42, versionNumber: 1, contentHash: "hash", noChange: false, cleanupWarning: "源回收失败" };
  });
  const results = await createFileDropBatch(binding, [
    { sourcePath: "/good.pdf", target: { kind: "new", owner: null, name: "good.pdf" } },
    { sourcePath: "/bad.pdf", target: { kind: "new", owner: null, name: "bad.pdf" } },
  ]).run();
  expect(results).toMatchObject([
    { sourcePath: "/good.pdf", status: "success", result: { documentId: 42, cleanupWarning: "源回收失败" } },
    { sourcePath: "/bad.pdf", status: "error", error: denied, uncertain: false },
  ]);
  const prepare = ipc.mock.calls[0][1];
  expect(prepare).toEqual({ binding, requestId: expect.any(String), sourcePath: "/good.pdf", target: { kind: "new", owner: null, name: "good.pdf" } });
  expect(ipc.mock.calls[1]).toEqual(["file_drop_commit", { binding, requestId: prepare.requestId, intentId: "intent-a" }]);
  expect(ipc.mock.calls.filter(([command]) => command === "file_drop_commit")).toHaveLength(1);
});
it("releases a captured instance after an uncertain commit is later confirmed rejected and native release was already acknowledged", async () => {
  const object = { workspaceId: binding.workspaceId, scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "4" };
  let locked = false, operationId = "", commits = 0;
  const closeMoved = vi.fn();
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding, prepare: async () => {}, closeMoved,
    lockObject: () => { locked = true; return () => { locked = false; }; } });
  agent.mockImplementation(async (command, args) => {
    if (command === "file_editors_flush") {
      operationId = args.input.requestId;
      await prepareContentOwnerMove(binding, object, operationId, async () => {});
    }
    return { apiVersion: 1, requestId: args.input.requestId, ok: true, data: null };
  });
  ipc.mockImplementation(async command => {
    if (command === "file_drop_prepare") return { intentId: "pinned" };
    if (++commits === 1) throw new Error("commit response lost");
    throw { code: "REVISION_CONFLICT", message: "commit rejected" };
  });
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/managed.md", expectedVersionNumber: 2 } }]);
  try {
    expect(await batch.run()).toMatchObject([{ status: "error", uncertain: true }]);
    expect(locked).toBe(true);
    agent.mockClear();
    expect(await batch.run()).toMatchObject([{ status: "error", uncertain: false }]);
    expect(locked).toBe(false);
    expect(agent).not.toHaveBeenCalled();
    expect(closeMoved).not.toHaveBeenCalled(); expect(publishFileReplacedReceipt).not.toHaveBeenCalled();
  } finally { releaseContentOwnerMove({ binding, operationId, source: object }); stop(); }
});
it.each(["prepare", "commit"])("confirms a lost %s response using the same frozen request/intent and never resubmits a success", async lostStage => {
  let lost = true;
  ipc.mockImplementation(async command => {
    if (command === `file_drop_${lostStage}` && lost) { lost = false; throw new Error("IPC disconnected"); }
    if (command === "file_drop_prepare") return { intentId: "pinned" };
    return { documentId: 4, versionNumber: 3, contentHash: "h", noChange: true, cleanupWarning: null };
  });
  const target = { kind: "new" as const, owner: 7, name: "source.md" };
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target }]);
  target.name = "changed.md";
  expect(await batch.run()).toMatchObject([{ status: "error", uncertain: true }]);
  expect(await batch.run()).toMatchObject([{ status: "success", result: { noChange: true } }]);
  const calls = ipc.mock.calls;
  const prepares = calls.filter(([command]) => command === "file_drop_prepare");
  expect(prepares[0][1]).toMatchObject({ target: { name: "source.md" } });
  expect(new Set(calls.map(([, args]) => args.requestId)).size).toBe(1);
  if (lostStage === "prepare") expect(prepares[1]).toEqual(prepares[0]);
  else expect(calls[2]).toEqual(calls[1]);
  const count = calls.length;
  await batch.run();
  expect(ipc).toHaveBeenCalledTimes(count);
});

it("captures only the displayed target before preparing, and releases the same operation after commit", async () => {
  const order: string[] = [];
  agent.mockImplementation(async (command, args) => { order.push(command); return { apiVersion: 1, requestId: args.input.requestId, ok: true, data: null }; });
  ipc.mockImplementation(async command => { order.push(command); return command === "file_drop_prepare" ? { intentId: "update-intent" }
    : { documentId: 4, versionNumber: 4, contentHash: "new-hash", noChange: false, cleanupWarning: null, oldSessionsClosed: true }; });
  const target = { kind: "update" as const, documentId: 4, projectId: 7, managedPath: "/managed.md", expectedVersionNumber: 3 };
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target }]);
  target.expectedVersionNumber = 99;
  expect(await batch.run()).toMatchObject([{ status: "success", result: { oldSessionsClosed: true } }]);
  expect(order).toEqual(["file_editors_flush", "file_drop_prepare", "file_drop_commit", "file_editors_release"]);
  const requestId = ipc.mock.calls[0][1].requestId;
  expect(ipc.mock.calls[0][1].target.expectedVersionNumber).toBe(3);
  expect(agent.mock.calls.map(([, args]) => args.input)).toEqual([0, 1].map(() => ({ binding, requestId,
    data: { workspaceId: "workspace", scope: { kind: "project", projectId: 7 }, kind: "file", id: "4" } })));
});
it.each(["flush", "prepare", "commit"])("releases only the target after a typed %s failure and preserves native details", async phase => {
  const failure = { code: "REVISION_CONFLICT", message: "stale displayed version", retryable: false, details: { displayed: 3, actual: 4 } };
  agent.mockImplementation(async (command, args) => ({ apiVersion: 1, requestId: args.input.requestId,
    ...(phase === "flush" && command === "file_editors_flush" ? { ok: false, error: failure } : { ok: true, data: null }) }));
  ipc.mockImplementation(async command => { if (command === `file_drop_${phase}`) throw failure;
    return command === "file_drop_prepare" ? { intentId: "pinned" } : { documentId: 4, versionNumber: 4, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: true }; });
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target: { kind: "update", documentId: 4, projectId: null, managedPath: "/files/a.md", expectedVersionNumber: 3 } }]);
  expect(await batch.run()).toMatchObject([{ status: "error", uncertain: false, error: failure }]);
  expect(agent.mock.calls.at(-1)?.[0]).toBe("file_editors_release");
  if (phase === "flush") expect(ipc).not.toHaveBeenCalled();
  if (phase === "prepare") expect(ipc.mock.calls.map(([command]) => command)).toEqual(["file_drop_prepare"]);
  const count = ipc.mock.calls.length;
  await batch.run(); expect(ipc).toHaveBeenCalledTimes(count);
});
it("retains a committed destination after release fails and retries only release", async () => {
  let releaseCount = 0;
  agent.mockImplementation(async (command, args) => {
    if (command === "file_editors_release" && ++releaseCount === 1) throw new Error("release response lost");
    return { apiVersion: 1, requestId: args.input.requestId, ok: true, data: null };
  });
  ipc.mockImplementation(async command => command === "file_drop_prepare" ? { intentId: "pinned" } : { documentId: 4, versionNumber: 4, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: true });
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/a.md", expectedVersionNumber: 3 } }]);
  expect(await batch.run()).toMatchObject([{ status: "success", releaseError: expect.any(Error) }]);
  expect(await batch.run()).toEqual([{ sourcePath: "/source.md", status: "success", result: { documentId: 4, versionNumber: 4, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: true } }]);
  expect(ipc).toHaveBeenCalledTimes(2);
  expect(agent.mock.calls.map(([command]) => command)).toEqual(["file_editors_flush", "file_editors_release", "file_editors_release"]);
  expect(new Set(agent.mock.calls.map(([, args]) => args.input.requestId)).size).toBe(1);
});
it("shares an in-flight batch and allocates one independent frozen request per source", async () => {
  let resolve!: (value: { intentId: string }) => void;
  ipc.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({ documentId: 4, versionNumber: 1, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: false });
  const mutableBinding = { ...binding };
  const batch = createFileDropBatch(mutableBinding, [{ sourcePath: "/a.md", target: { kind: "new", owner: null, name: "a.md" } }]);
  mutableBinding.generation = "other";
  const first = batch.run(); const second = batch.run();
  expect(first).toBe(second);
  resolve({ intentId: "pinned" }); await first;
  expect(ipc).toHaveBeenCalledTimes(2);
  expect(ipc.mock.calls[0][1].binding).toEqual(binding);
  expect(agent).not.toHaveBeenCalled();
});
it("confirms an existing update receipt without capturing a newer editor or preparing again", async () => {
  let commits = 0;
  ipc.mockImplementation(async command => {
    if (command === "file_drop_prepare") return { intentId: "pinned" };
    if (++commits === 1) throw new Error("committed response lost");
    return { documentId: 4, versionNumber: 4, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: true };
  });
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/a.md", expectedVersionNumber: 3 } }]);
  expect(await batch.run()).toMatchObject([{ status: "error", uncertain: true }]);
  agent.mockClear();
  expect(await batch.run()).toMatchObject([{ status: "success" }]);
  expect(agent).not.toHaveBeenCalled();
  expect(ipc.mock.calls[2]).toEqual(ipc.mock.calls[1]);
  expect(ipc.mock.calls.filter(([command]) => command === "file_drop_prepare")).toHaveLength(1);
});
it.each(["EDITOR_BUSY", "REVISION_CONFLICT"])("only reacquires a seal for explicit %s when confirming an uncertain commit", async code => {
  let commits = 0;
  const order: string[] = [];
  agent.mockImplementation(async (command, args) => { order.push(command); return { apiVersion: 1, requestId: args.input.requestId, ok: true, data: null }; });
  ipc.mockImplementation(async command => {
    order.push(command);
    if (command === "file_drop_prepare") return { intentId: "pinned" };
    if (++commits === 1) throw new Error("response lost");
    if (commits === 2) throw { code, message: "no receipt" };
    return { documentId: 4, versionNumber: 4, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: true };
  });
  const batch = createFileDropBatch(binding, [{ sourcePath: "/source.md", target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/a.md", expectedVersionNumber: 3 } }]);
  await batch.run(); order.length = 0;
  const results = await batch.run();
  if (code === "EDITOR_BUSY") {
    expect(order).toEqual(["file_drop_commit", "file_editors_flush", "file_drop_commit", "file_editors_release"]);
    expect(results).toMatchObject([{ status: "success" }]);
  } else {
    expect(order).toEqual(["file_drop_commit"]);
    expect(results).toMatchObject([{ status: "error", uncertain: false, error: { code: "REVISION_CONFLICT" } }]);
  }
  expect(ipc.mock.calls.filter(([command]) => command === "file_drop_prepare")).toHaveLength(1);
  expect(new Set([...ipc.mock.calls.map(([, args]) => args.requestId), ...agent.mock.calls.map(([, args]) => args.input.requestId)]).size).toBe(1);
});

import { registerQuickNoteFlusher } from "./quick-note-transfer";
import { expect, it, vi } from "vitest";
import { prepareProjectContentClose, prepareWorkspaceContentClose, registerProjectContentCloseGuard, registerWorkspaceRecordCloseGuard } from "./project-content-lifecycle";
import { completeContentOwnerMove, prepareContentOwnerMove, releaseContentOwnerMove, withProjectContentMove } from "./project-content-lifecycle";

const binding = { workspaceId: "w", generation: "g" };
const source = { workspaceId: "w", scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "11" };

it("refuses a move capture if its source page cannot receive terminal events", async () => {
  const flush = vi.fn(async () => {}), lockObject = vi.fn(() => () => {});
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, lockObject, moveEventsReady: () => false });
  try {
    await expect(prepareContentOwnerMove(binding, source, "no-listener", flush)).rejects.toThrow("移动通知");
    expect(flush).not.toHaveBeenCalled(); expect(lockObject).not.toHaveBeenCalled();
  } finally { stop(); }
});

it("locks before capturing only the requested object and holds it until its matching release", async () => {
  let locked = false;
  const prepare = vi.fn(async () => {});
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding, prepare,
    lockObject: object => { expect(object).toEqual({ kind: "file", id: 11 }); locked = true; return () => { locked = false; }; } });
  try {
    const flush = vi.fn(async () => { expect(locked).toBe(true); return "captured"; });
    expect(await prepareContentOwnerMove(binding, source, "move-1", flush)).toBe("captured");
    expect(locked).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    releaseContentOwnerMove({ binding, operationId: "other", source });
    expect(locked).toBe(true);
    releaseContentOwnerMove({ binding, operationId: "move-1", source });
    expect(locked).toBe(false);
  } finally { stop(); }
});

it.each(["before", "after"])("shares the initiating lock and closes once when the terminal event arrives %s the response", async order => {
  let locked = false;
  const moved = vi.fn(), closeMoved = vi.fn(async () => {});
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", binding, projectId: 7,
    prepare: async () => {}, moved, closeMoved,
    lockObject: () => { if (locked) throw new Error("duplicate lock"); locked = true; return () => { locked = false; }; },
  });
  try {
    const event = { binding, source, operationId: "move-reentrant", target: { ...source, scope: { kind: "project" as const, projectId: 8 } }, oldSessionsClosed: true };
    await withProjectContentMove("/workspace", 7, { kind: "file", id: 11 }, async () => {
      await prepareContentOwnerMove(binding, source, "move-reentrant", async () => "saved");
      if (order === "before") await completeContentOwnerMove(event);
      return "receipt";
    }, { nativeSessionsClosed: true });
    if (order === "after") await completeContentOwnerMove(event);
    expect(moved).toHaveBeenCalledExactlyOnceWith({ kind: "file", id: 11 }, true);
    expect(closeMoved).toHaveBeenCalledOnce();
    expect(locked).toBe(false);
  } finally { stop(); }
});

it("captures both registered editors independently while sharing one operation's object lock", async () => {
  const unlock = vi.fn(), lockObject = vi.fn(() => unlock);
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", binding, projectId: 7, prepare: async () => {}, lockObject });
  try {
    const first = vi.fn(async () => "editor-a-saved"), second = vi.fn(async () => "editor-b-saved");
    expect(await Promise.all([
      prepareContentOwnerMove(binding, source, "two-editors", first),
      prepareContentOwnerMove(binding, source, "two-editors", second),
    ])).toEqual(["editor-a-saved", "editor-b-saved"]);
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    expect(lockObject).toHaveBeenCalledOnce(); expect(unlock).not.toHaveBeenCalled();
    releaseContentOwnerMove({ binding, source, operationId: "two-editors" });
    expect(unlock).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it("runs registered capture without a mounted pane or a matching local binding", async () => {
  const lockObject = vi.fn(() => () => {});
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", binding: { ...binding, generation: "next" }, projectId: 7, prepare: async () => {}, lockObject });
  try {
    const flush = vi.fn(async () => "standalone-editor-saved");
    expect(await prepareContentOwnerMove(binding, source, "standalone", flush)).toBe("standalone-editor-saved");
    expect(flush).toHaveBeenCalledOnce(); expect(lockObject).not.toHaveBeenCalled();
  } finally { releaseContentOwnerMove({ binding, source, operationId: "standalone" }); stop(); }
});

it("releases the operation on capture failure, and does not let another operation's release unlock the object", async () => {
  let locks = 0;
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", binding, projectId: 7, prepare: async () => {},
    lockObject: () => { ++locks; return () => { --locks; }; } });
  try {
    await expect(prepareContentOwnerMove(binding, source, "failed", async () => { throw new Error("capture failed"); })).rejects.toThrow("capture failed");
    expect(locks).toBe(0);
    await prepareContentOwnerMove(binding, source, "live", async () => {});
    releaseContentOwnerMove({ binding, source, operationId: "failed" });
    releaseContentOwnerMove({ binding: { ...binding, generation: "stale" }, source, operationId: "live" });
    releaseContentOwnerMove({ binding, source: { ...source, kind: "record" }, operationId: "live" });
    expect(locks).toBe(1);
    releaseContentOwnerMove({ binding, source, operationId: "live" });
    releaseContentOwnerMove({ binding, source, operationId: "live" });
    expect(locks).toBe(0);
  } finally { stop(); }
});

it("releases a pending object lock when its bound pane unregisters", async () => {
  const unlock = vi.fn();
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", binding, projectId: 7, prepare: async () => {}, lockObject: () => unlock });
  await prepareContentOwnerMove(binding, source, "unmount", async () => {});
  stop();
  expect(unlock).toHaveBeenCalledOnce();
  releaseContentOwnerMove({ binding, source, operationId: "unmount" });
  expect(unlock).toHaveBeenCalledOnce();
});

it("prepares each editor once when an awaited save re-registers its guard", async () => {
  const prepare = vi.fn(async () => { stop(); stop = registerWorkspaceRecordCloseGuard({ workspaceRoot: "/workspace", recordId: 7, prepare }); });
  let stop = registerWorkspaceRecordCloseGuard({ workspaceRoot: "/workspace", recordId: 7, prepare });
  try {
    await prepareWorkspaceContentClose("/workspace");
    expect(prepare).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it('prepares the Workspace layout and Project layouts without crossing Workspace roots', async () => {
  const workspace = vi.fn(async () => {}), project = vi.fn(async () => {}), foreign = vi.fn(async () => {});
  const stops = [registerProjectContentCloseGuard({ workspaceRoot: '/current', projectId: null, prepare: workspace }),
    registerProjectContentCloseGuard({ workspaceRoot: '/current', projectId: 1, prepare: project }),
    registerProjectContentCloseGuard({ workspaceRoot: '/other', projectId: null, prepare: foreign })];
  try { await prepareWorkspaceContentClose('/current');expect(workspace).toHaveBeenCalledOnce();expect(project).toHaveBeenCalledOnce();expect(foreign).not.toHaveBeenCalled(); }
  finally { stops.forEach(stop => stop()); }
});

it("waits for the target Project QuickNote and retains the Project on failure without flushing another scope", async () => {
  let fail = true;
  const target = vi.fn(async () => { if (fail) throw new Error("QuickNote disk full"); });
  const other = vi.fn(async () => undefined);
  const content = vi.fn(async () => undefined);
  const stops = [
    registerQuickNoteFlusher("target", target, { workspaceRoot: "/drafts", projectId: 1 }),
    registerQuickNoteFlusher("other", other, { workspaceRoot: "/drafts", projectId: 2 }),
    registerProjectContentCloseGuard({ workspaceRoot: "/drafts", projectId: 1, prepare: content }),
  ];
  try {
    await expect(prepareProjectContentClose("/drafts", 1)).rejects.toThrow("QuickNote disk full");
    expect(content).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    fail = false;
    await prepareProjectContentClose("/drafts", 1);
    expect(content).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  } finally { stops.forEach(stop => stop()); }
});

it("flushes a new QuickNote edit after an awaited content guard completes", async () => {
  let draft = "before";
  let stored = "";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const flush = vi.fn(async () => { stored = draft; });
  const prepare = vi.fn(() => gate);
  const stops = [registerQuickNoteFlusher("late-input", flush, { workspaceRoot: "/late", projectId: 1 }),
    registerProjectContentCloseGuard({ workspaceRoot: "/late", projectId: 1, prepare })];
  try {
    const closing = prepareProjectContentClose("/late", 1);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(stored).toBe("before");
    draft = "after";
    release();
    await closing;
    expect(stored).toBe("after");
  } finally { stops.forEach(stop => stop()); }
});

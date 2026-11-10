import { expect, it, vi } from "vitest";
import { prepareWorkspaceContentClose, registerProjectContentCloseGuard, registerWorkspaceRecordCloseGuard } from "./project-content-lifecycle";
import { completeContentOwnerMove, hasPendingContentOwnerMove, prepareContentOwnerMove, registerContentOwnerMoveParticipant, releaseContentOwnerMove, withProjectContentMove } from "./project-content-lifecycle";

const binding = { workspaceId: "w", generation: "g" };
const source = { workspaceId: "w", scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "11" };

function participantFixture() {
  const identity = { binding, source, operationId: "participants" };
  const unlock = vi.fn(), closeMoved = vi.fn(async () => {});
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, lockObject: () => unlock, closeMoved });
  const capture = async () => {
    let participant!: ReturnType<typeof registerContentOwnerMoveParticipant>;
    await prepareContentOwnerMove(binding, source, identity.operationId, async () => {
      participant = registerContentOwnerMoveParticipant(identity);
    });
    return participant;
  };
  return { identity, unlock, closeMoved, stop, capture };
}

it.each([0, 1])("keeps the shared barrier until both captured instances complete (first=%s)", async first => {
  const { identity, unlock, closeMoved, stop, capture } = participantFixture();
  try {
    const participants = await Promise.all([capture(), capture()]);
    participants[first].complete();
    participants[first].complete();
    participants[first].dispose();
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    expect(unlock).not.toHaveBeenCalled();
    participants[1 - first].complete();
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    expect(unlock).toHaveBeenCalledOnce();
    expect(closeMoved).not.toHaveBeenCalled();
  } finally { stop(); }
});

it.each([0, 1])("waits for asynchronous retirement in either completion order (first=%s)", async first => {
  const { identity, unlock, stop, capture } = participantFixture();
  try {
    const participants = await Promise.all([capture(), capture()]);
    const finish: Array<() => void> = [];
    const retired = [false, false];
    const cleanup = participants.map((participant, index) => (async () => {
      await new Promise<void>(resolve => { finish[index] = resolve; });
      retired[index] = true;
      participant.complete();
    })());
    unlock.mockImplementation(() => expect(retired).toEqual([true, true]));
    finish[first]();
    await cleanup[first];
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    expect(unlock).not.toHaveBeenCalled();
    finish[1 - first]();
    await cleanup[1 - first];
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    expect(unlock).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it.each(["before", "after"])("releases after the remaining captured instance is destroyed %s terminal confirmation", async order => {
  const { identity, unlock, stop, capture } = participantFixture();
  try {
    const [first, second] = await Promise.all([capture(), capture()]);
    if (order === "before") second.dispose(); else first.complete();
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    expect(unlock).not.toHaveBeenCalled();
    if (order === "before") first.complete(); else second.dispose();
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    expect(unlock).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it("does not unlock an unconfirmed operation when every participant is destroyed", async () => {
  const { identity, unlock, stop, capture } = participantFixture();
  try {
    const participants = await Promise.all([capture(), capture()]);
    participants.forEach(participant => participant.dispose());
    participants.forEach(participant => participant.complete());
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    expect(unlock).not.toHaveBeenCalled();
    releaseContentOwnerMove(identity);
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    expect(unlock).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it("does not let stale participants complete or dispose a replacement barrier with the same operation identity", async () => {
  const { identity, unlock, stop, capture } = participantFixture();
  try {
    const stale = await Promise.all([capture(), capture()]);
    releaseContentOwnerMove(identity);
    const current = await capture();
    stale[0].complete(); stale[1].dispose();
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    expect(unlock).toHaveBeenCalledOnce();
    current.complete();
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    expect(unlock).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});

it("registers participants only on an existing capture, including one without a mounted guard", async () => {
  const identity = { binding, source, operationId: "standalone-participant" };
  const missing = registerContentOwnerMoveParticipant(identity);
  expect(hasPendingContentOwnerMove(identity)).toBe(false);
  try {
    await prepareContentOwnerMove(binding, source, identity.operationId, async () => {});
    missing.complete(); missing.dispose();
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    registerContentOwnerMoveParticipant(identity).complete();
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
  } finally { releaseContentOwnerMove(identity); }
});

it.each(["release", "moved"])("preserves forced %s semantics even with incomplete participants", async terminal => {
  const { identity, unlock, closeMoved, stop, capture } = participantFixture();
  try {
    const participants = await Promise.all([capture(), capture()]);
    if (terminal === "release") releaseContentOwnerMove(identity);
    else await completeContentOwnerMove({ ...identity, target: { ...source, scope: { kind: "project", projectId: 8 } }, oldSessionsClosed: true });
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    expect(unlock).toHaveBeenCalledOnce();
    expect(closeMoved).toHaveBeenCalledTimes(terminal === "moved" ? 1 : 0);
    participants[0].complete(); participants[1].dispose();
    expect(unlock).toHaveBeenCalledOnce();
  } finally { stop(); }
});

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
    }, { nativeSessionsClosed: true, moveIdentity: event });
    if (order === "after") await completeContentOwnerMove(event);
    expect(moved).toHaveBeenCalledExactlyOnceWith({ kind: "file", id: 11 }, true);
    expect(closeMoved).toHaveBeenCalledOnce();
    expect(locked).toBe(false);
  } finally { stop(); }
});

it.each(["record", "file"] as const)("accepts a native %s terminal only for its exact pending capture", async kind => {
  const capturedSource = { ...source, kind };
  const event = { binding, source: capturedSource, operationId: "captured-terminal",
    target: { ...capturedSource, scope: { kind: "project" as const, projectId: 8 } }, oldSessionsClosed: kind === "file" };
  const moved = vi.fn(), closeMoved = vi.fn(async () => {}), unlock = vi.fn();
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, moved, closeMoved, lockObject: () => unlock });
  try {
    await completeContentOwnerMove(event);
    expect(moved).not.toHaveBeenCalled(); expect(closeMoved).not.toHaveBeenCalled();
    await prepareContentOwnerMove(binding, capturedSource, event.operationId, async () => {});
    await completeContentOwnerMove({ ...event, operationId: "uncaptured-terminal" });
    expect(moved).not.toHaveBeenCalled(); expect(closeMoved).not.toHaveBeenCalled();
    expect(hasPendingContentOwnerMove(event)).toBe(true); expect(unlock).not.toHaveBeenCalled();
    await Promise.all([completeContentOwnerMove(event), completeContentOwnerMove(event)]);
    expect(moved).toHaveBeenCalledExactlyOnceWith({ kind, id: 11 }, kind === "file");
    expect(closeMoved).toHaveBeenCalledOnce(); expect(unlock).toHaveBeenCalledOnce();
    expect(hasPendingContentOwnerMove(event)).toBe(false);
    await completeContentOwnerMove(event);
    expect(closeMoved).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it.each(["pending", "completed"])("ignores an old native terminal after its guard is rebuilt (%s capture)", async state => {
  const event = { binding, source, operationId: "previous-guard",
    target: { ...source, scope: { kind: "project" as const, projectId: 8 } }, oldSessionsClosed: true };
  const oldClose = vi.fn(async () => {}), newClose = vi.fn(async () => {}), newMoved = vi.fn();
  const stopOld = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, closeMoved: oldClose });
  let stopNew: (() => void) | undefined;
  try {
    await prepareContentOwnerMove(binding, source, event.operationId, async () => {});
    if (state === "completed") await completeContentOwnerMove(event);
    // Leave a pending old barrier in place to exercise guard ownership, not just presence.
    stopNew = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
      prepare: async () => {}, moved: newMoved, closeMoved: newClose });
    await completeContentOwnerMove(event);
    expect(newClose).not.toHaveBeenCalled(); expect(newMoved).not.toHaveBeenCalled();
    expect(hasPendingContentOwnerMove(event)).toBe(state === "pending");
    const current = { ...event, operationId: "current-guard" };
    await prepareContentOwnerMove(binding, source, current.operationId, async () => {});
    await completeContentOwnerMove(event);
    expect(newClose).not.toHaveBeenCalled();
    await completeContentOwnerMove(current);
    expect(newClose).toHaveBeenCalledOnce();
    expect(oldClose).toHaveBeenCalledTimes(state === "completed" ? 1 : 0);
  } finally { stopNew?.(); stopOld(); }
});

it("does not adopt a guardless capture into a subsequently mounted pane", async () => {
  const event = { binding, source, operationId: "guardless-terminal",
    target: { ...source, scope: { kind: "project" as const, projectId: 8 } }, oldSessionsClosed: true };
  await prepareContentOwnerMove(binding, source, event.operationId, async () => {});
  const closeMoved = vi.fn(async () => {});
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, closeMoved });
  try {
    await completeContentOwnerMove(event);
    expect(closeMoved).not.toHaveBeenCalled();
    expect(hasPendingContentOwnerMove(event)).toBe(true);
  } finally { releaseContentOwnerMove(event); stop(); }
});

it("keeps a successful response bound to its original guard when a new pane replaces it", async () => {
  const identity = { binding, source, operationId: "old-response" };
  const oldClose = vi.fn(async () => {}), newClose = vi.fn(async () => {});
  const stopOld = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, closeMoved: oldClose });
  let stopNew: (() => void) | undefined;
  try {
    await withProjectContentMove("/workspace", 7, { kind: "file", id: 11 }, async () => {
      await prepareContentOwnerMove(binding, source, identity.operationId, async () => {});
      stopOld();
      stopNew = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
        prepare: async () => {}, closeMoved: newClose });
    }, { nativeSessionsClosed: true, moveIdentity: identity });
    expect(oldClose).not.toHaveBeenCalled(); expect(newClose).not.toHaveBeenCalled();
  } finally { stopNew?.(); stopOld(); }
});

it("releases the successful response's barrier even if closing its source view fails", async () => {
  let locked = false;
  const identity = { binding, source, operationId: "close-failure" };
  const closeMoved = vi.fn(async () => { throw new Error("cannot close source view"); });
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, closeMoved,
    lockObject: () => { locked = true; return () => { locked = false; }; } });
  try {
    await expect(withProjectContentMove("/workspace", 7, { kind: "file", id: 11 }, async () => {
      await prepareContentOwnerMove(binding, source, identity.operationId, async () => {});
    }, { nativeSessionsClosed: true, moveIdentity: identity })).rejects.toThrow("cannot close source view");
    expect(closeMoved).toHaveBeenCalledOnce();
    expect(locked).toBe(false);
  } finally { stop(); }
});

it("does not close a failed move or consume its still-pending terminal barrier", async () => {
  let locked = false;
  const identity = { binding, source, operationId: "native-failure" };
  const moved = vi.fn(), closeMoved = vi.fn(async () => {});
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding,
    prepare: async () => {}, moved, closeMoved,
    lockObject: () => { locked = true; return () => { locked = false; }; } });
  try {
    await expect(withProjectContentMove("/workspace", 7, { kind: "file", id: 11 }, async () => {
      await prepareContentOwnerMove(binding, source, identity.operationId, async () => {});
      throw new Error("native ownership rejected");
    }, { nativeSessionsClosed: true, moveIdentity: identity })).rejects.toThrow("native ownership rejected");
    expect(moved).not.toHaveBeenCalled();
    expect(closeMoved).not.toHaveBeenCalled();
    expect(locked).toBe(true);
    releaseContentOwnerMove(identity);
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

it("reports only the exact pending operation and becomes false after release", async () => {
  const identity = { binding, source, operationId: "pending-query" };
  const stop = registerProjectContentCloseGuard({ workspaceRoot: "/workspace", projectId: 7, binding, prepare: async () => {} });
  try {
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    await prepareContentOwnerMove(binding, source, identity.operationId, async () => {});
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    expect(hasPendingContentOwnerMove({ ...identity, operationId: "other" })).toBe(false);
    releaseContentOwnerMove(identity);
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
    stop();
    // Standalone instances still participate in receipt/terminal correlation.
    await prepareContentOwnerMove(binding, source, identity.operationId, async () => {});
    expect(hasPendingContentOwnerMove(identity)).toBe(true);
    releaseContentOwnerMove(identity);
    expect(hasPendingContentOwnerMove(identity)).toBe(false);
  } finally { releaseContentOwnerMove(identity); stop(); }
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

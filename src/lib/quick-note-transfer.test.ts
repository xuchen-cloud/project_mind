import { describe, expect, it } from "vitest";

import { QuickNoteTransferSession } from "./quick-note-transfer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("QuickNoteTransferSession", () => {
  it("checks the Workspace binding before persisting the transfer draft", async () => {
    const writes: string[] = [];
    const session = new QuickNoteTransferSession({
      readCommitted: () => "Idea", isEmpty: () => false,
      beforeTransfer: async () => { throw new Error("WORKSPACE_CHANGED"); },
      persist: async (value) => { writes.push(value); return value; },
      commit: async () => { writes.push("commit"); return 1; },
      clearLocal: () => { writes.push("clear"); }, setBusy: () => undefined,
    });
    await expect(session.transfer({ kind: "new" })).rejects.toThrow("WORKSPACE_CHANGED");
    expect(writes).toEqual([]);
  });
  it("moves one committed QuickNote into one Record after an older save completes", async () => {
    const olderSave = deferred();
    let draft = "A useful idea";
    let persisted = "";
    const records: string[] = [];
    const session = new QuickNoteTransferSession({
      readCommitted: () => draft,
      isEmpty: (value) => !value.trim(),
      persist: async (value) => {
        if (value === "older") await olderSave.promise;
        persisted = value;
        return value;
      },
      commit: async (value) => {
        records.push(value);
        persisted = "";
        return records.length;
      },
      clearLocal: () => { draft = ""; },
      setBusy: () => undefined,
    });

    const save = session.save("older");
    const first = session.transfer({ kind: "new" });
    const second = session.transfer({ kind: "new" });
    olderSave.resolve();

    expect(await first).toBe(1);
    expect(await second).toBe(1);
    await save;
    expect({ draft, persisted, records }).toEqual({
      draft: "",
      persisted: "",
      records: ["A useful idea"],
    });
  });

  it("keeps the draft when writing a Record fails and can retry", async () => {
    let draft = "Keep this";
    let attempts = 0;
    const records: string[] = [];
    const session = new QuickNoteTransferSession({
      readCommitted: () => draft,
      isEmpty: (value) => !value.trim(),
      persist: async (value) => value,
      commit: async (value) => {
        if (++attempts === 1) throw new Error("write failed");
        records.push(value);
        return records.length;
      },
      clearLocal: () => { draft = ""; },
      setBusy: () => undefined,
    });

    await expect(session.transfer({ kind: "new" })).rejects.toThrow("write failed");
    expect(draft).toBe("Keep this");
    expect(await session.transfer({ kind: "new" })).toBe(1);
    expect(records).toEqual(["Keep this"]);
  });

  it("does not write a delayed pre-transfer autosave back over the cleared QuickNote", async () => {
    const commitGate = deferred();
    let draft = "Move me";
    let persisted = "Move me";
    const session = new QuickNoteTransferSession({
      readCommitted: () => draft,
      isEmpty: (value) => !value.trim(),
      persist: async (value) => { persisted = value; return value; },
      commit: async () => {
        await commitGate.promise;
        persisted = "";
        return 42;
      },
      clearLocal: () => { draft = ""; },
      setBusy: () => undefined,
    });

    const transfer = session.transfer({ kind: "new" });
    const staleSave = session.save("Move me");
    commitGate.resolve();
    await transfer;
    await staleSave;

    expect({ draft, persisted }).toEqual({ draft: "", persisted: "" });
  });

  it("replays a lost commit response without persisting or creating the QuickNote again", async () => {
    let draft = "Durable idea";
    let persisted = "";
    let writes = 0;
    const receipts = new Map<string, number>();
    const requestIds: string[] = [];
    const session = new QuickNoteTransferSession({
      readCommitted: () => draft,
      isEmpty: (value) => !value.trim(),
      persist: async (value) => { writes += 1; persisted = value; return value; },
      commit: async (_value, _target, context) => {
        requestIds.push(context.requestId);
        const existing = receipts.get(context.requestId);
        if (existing) return existing;
        receipts.set(context.requestId, 42);
        persisted = "";
        throw new Error("response lost");
      },
      clearLocal: () => { draft = ""; },
      setBusy: () => undefined,
    });

    await expect(session.transfer({ kind: "new" })).rejects.toThrow("response lost");
    await session.save("Durable idea");
    expect(await session.transfer({ kind: "new" })).toBe(42);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect({ writes, persisted, draft, count: receipts.size }).toEqual({
      writes: 1, persisted: "", draft: "", count: 1,
    });
  });

  it("starts a new attempt when the draft or destination changes after a failure", async () => {
    let draft = "First idea";
    const writes: string[] = [];
    const requestIds: string[] = [];
    const session = new QuickNoteTransferSession({
      readCommitted: () => draft,
      isEmpty: (value) => !value.trim(),
      persist: async (value) => { writes.push(value); return value; },
      commit: async (_value, _target, context) => {
        requestIds.push(context.requestId);
        throw new Error("conflict");
      },
      clearLocal: () => undefined,
      setBusy: () => undefined,
    });
    await expect(session.transfer({ kind: "new" })).rejects.toThrow("conflict");
    draft = "Revised idea";
    await expect(session.transfer({ kind: "new" })).rejects.toThrow("conflict");
    await expect(session.transfer({ kind: "append", recordId: 7 })).rejects.toThrow("conflict");
    expect(new Set(requestIds).size).toBe(3);
    expect(writes).toEqual(["First idea", "Revised idea", "Revised idea"]);
  });

  it("does not revive an older queued snapshot when the transfer response is lost", async () => {
    const gate = deferred();
    let persisted = "Idea";
    const session = new QuickNoteTransferSession({
      readCommitted: () => "Idea", isEmpty: () => false,
      persist: async (value) => { persisted = value; return value; },
      commit: async () => { await gate.promise; persisted = ""; throw new Error("response lost"); },
      clearLocal: () => undefined, setBusy: () => undefined,
    });
    const transfer = session.transfer({ kind: "new" });
    const olderSave = session.save("Older formatting");
    gate.resolve();
    await expect(transfer).rejects.toThrow("response lost");
    await olderSave;
    expect(persisted).toBe("");
  });
});

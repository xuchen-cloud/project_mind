import { describe, expect, it } from "vitest";

import { QuickNoteTransferSession } from "./quick-note-transfer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("QuickNoteTransferSession", () => {
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
});

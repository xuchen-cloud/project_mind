import { describe, expect, it, vi } from "vitest";

import {
  RecordSaveCoordinator,
  RecordSaveFailure,
  type CommittedProjectRecordSnapshot,
  type RecordSaveAdapter,
} from "./record-save-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function snapshot(
  recordId: number,
  markdown: string,
): CommittedProjectRecordSnapshot {
  return {
    scope: "project",
    workspaceKey: "/workspace/alpha",
    projectId: 1,
    recordId,
    title: `Record ${recordId}`,
    tagIds: [2],
    defaultCodeLanguage: "typescript",
    committedContent: {
      html: `<p>${markdown}</p>`,
      text: markdown,
      markdown,
    },
  };
}

function canonicalSnapshot(markdown: string): CommittedProjectRecordSnapshot {
  return { ...snapshot(7, markdown), canonicalBody: {
    binding: { workspaceId: "workspace-a", generation: "open-1" },
    requestId: `save-${markdown}`, baseRevision: 4, editSessionId: "a".repeat(32), origin: "manual",
    document: { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "1".repeat(32) }, content: [{ type: "text", text: markdown }] }] },
  } };
}

describe("RecordSaveCoordinator", () => {
  it("flushes one record independently of a conflict in another record", async () => {
    const coordinator = new RecordSaveCoordinator({ adapter: { persist: async (value) => {
      if (value.recordId === 8) throw new RecordSaveFailure("Other record conflict", { retryable: false, code: "REVISION_CONFLICT" });
      return { updatedAt: "saved" };
    } } });
    coordinator.submit(snapshot(8, "conflict"));
    coordinator.submit(snapshot(7, "saved"));
    await expect(coordinator.flush("project:1:7")).resolves.toBeUndefined();
    await expect(coordinator.flush()).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  it("notifies each successful revision before another draft is captured and isolates observer failures", async () => {
    const coordinator = new RecordSaveCoordinator({ adapter: { persist: async (value) => ({ updatedAt: "saved", headRevision: value.canonicalBody!.baseRevision + 1 }) } });
    const revisions: number[] = [];
    const unsubscribe = coordinator.subscribeSaved((value, result) => {
      revisions.push(result.headRevision!);
      if (value.committedContent.markdown === "first") {
        const next = canonicalSnapshot("next"); next.canonicalBody!.baseRevision = result.headRevision!;
        coordinator.submit(next);
      }
    });
    coordinator.subscribeSaved(() => { throw new Error("Observer failure"); });
    coordinator.submit(canonicalSnapshot("first"));
    await coordinator.flush();
    expect(revisions).toEqual([5, 6]);
    unsubscribe();
    const last = canonicalSnapshot("last"); last.canonicalBody!.baseRevision = 6;
    coordinator.submit(last);
    await coordinator.flush();
    expect(revisions).toEqual([5, 6]);
    expect(coordinator.getStatus().pendingCount).toBe(0);
  });
  it("advances queued autosaves only after this coordinator commits their shared baseline", async () => {
    const first = deferred<{ updatedAt: string; headRevision: number }>();
    const captured: Readonly<CommittedProjectRecordSnapshot>[] = [];
    const coordinator = new RecordSaveCoordinator({ adapter: { persist: async (value) => {
      if (value.scope !== "project") throw new Error("Unexpected scope");
      captured.push(value);
      return captured.length === 1 ? first.promise : { updatedAt: "second", headRevision: 6 };
    } } });
    coordinator.submit(canonicalSnapshot("first"));
    const second = canonicalSnapshot("second"); coordinator.submit(second);
    second.canonicalBody!.document.content![0]!.content![0]!.text = "caller mutation";
    await Promise.resolve();
    expect(captured[0]?.canonicalBody?.baseRevision).toBe(4);
    first.resolve({ updatedAt: "first", headRevision: 5 });
    await coordinator.flush();
    expect(captured[1]?.canonicalBody).toMatchObject({ baseRevision: 5, requestId: "save-second", document: { content: [{ content: [{ text: "second" }] }] } });
    expect(second.canonicalBody?.baseRevision).toBe(4);
  });
  it("retains every queued draft when a canonical save encounters a permanent conflict", async () => {
    const writes: number[] = [];
    const coordinator = new RecordSaveCoordinator({ adapter: { persist: async (value) => {
      writes.push(value.canonicalBody!.baseRevision);
      throw new RecordSaveFailure("正文已被其他窗口修改", { retryable: false });
    } } });
    coordinator.submit(canonicalSnapshot("first"));
    coordinator.submit(canonicalSnapshot("second"));
    await expect(coordinator.flush()).rejects.toThrow("其他窗口");
    coordinator.retryFailed();
    await Promise.resolve();
    expect(writes).toEqual([4]);
    expect(coordinator.getLatestSnapshot("project:1:7")?.canonicalBody).toMatchObject({ baseRevision: 4, requestId: "save-second" });
    expect(coordinator.getStatus()).toMatchObject({ pendingCount: 2, retryableFailedCount: 0 });
  });
  it("advances queued metadata baselines from an acknowledged save while retaining the newer header draft", async () => {
    const captured: Readonly<CommittedProjectRecordSnapshot>[] = [];
    const coordinator = new RecordSaveCoordinator({ adapter: { persist: async (value) => {
      if (value.scope !== "project") throw new Error("Unexpected scope");
      captured.push(value);
      return { updatedAt: "saved", headRevision: 4 + captured.length,
        metadata: { title: value.title, tagIds: value.tagIds, revision: `metadata-${captured.length + 1}`, updatedAt: "saved" } };
    } } });
    const first = canonicalSnapshot("first"); first.title = "First title";
    const second = canonicalSnapshot("second"); second.title = "Newer title";
    for (const value of [first, second]) value.canonicalBody!.metadataBase = { title: "Record 7", tagIds: [2], revision: "metadata-1", updatedAt: "baseline" };
    coordinator.submit(first); coordinator.submit(second);
    await coordinator.flush();
    expect(captured[1]?.canonicalBody?.metadataBase).toMatchObject({ title: "First title", revision: "metadata-2" });
    expect(captured[1]?.title).toBe("Newer title");
    expect(second.canonicalBody?.metadataBase?.revision).toBe("metadata-1");
  });
  it("returns a receipt immediately and finishes a delayed save independently", async () => {
    const write = deferred<{ updatedAt: string }>();
    const adapter: RecordSaveAdapter = {
      persist: vi.fn(() => write.promise),
    };
    const coordinator = new RecordSaveCoordinator({ adapter });

    const receipt = coordinator.submit(snapshot(7, "latest"));

    expect(receipt).toMatchObject({ recordKey: "project:1:7", sequence: 1 });
    expect(coordinator.getStatus()).toMatchObject({ phase: "saving", pendingCount: 1 });
    write.resolve({ updatedAt: "2026-08-23T00:00:00.000Z" });
    await coordinator.flush();
    expect(coordinator.getStatus()).toMatchObject({ phase: "idle", pendingCount: 0 });
  });

  it("serializes writes per Record while allowing different Records to progress", async () => {
    const first = deferred<{ updatedAt: string }>();
    const writes: string[] = [];
    const adapter: RecordSaveAdapter = {
      persist: vi.fn(async (value) => {
        writes.push(value.committedContent.markdown);
        if (value.recordId === 7 && value.committedContent.markdown === "first") {
          return first.promise;
        }
        return { updatedAt: value.committedContent.markdown };
      }),
    };
    const coordinator = new RecordSaveCoordinator({ adapter });

    coordinator.submit(snapshot(7, "first"));
    coordinator.submit(snapshot(7, "second"));
    coordinator.submit(snapshot(8, "other-record"));
    await Promise.resolve();

    expect(writes).toEqual(["first", "other-record"]);
    first.resolve({ updatedAt: "first" });
    await coordinator.flush();
    expect(writes).toEqual(["first", "other-record", "second"]);
  });

  it("only synchronizes the newest completion for a Record", async () => {
    const first = deferred<{ updatedAt: string }>();
    const synchronized: string[] = [];
    const coordinator = new RecordSaveCoordinator({
      adapter: {
        persist: vi.fn((value) =>
          value.committedContent.markdown === "old"
            ? first.promise
            : Promise.resolve({ updatedAt: "new" }),
        ),
      },
      onLatestSaved: (value) => synchronized.push(value.committedContent.markdown),
    });

    coordinator.submit(snapshot(7, "old"));
    coordinator.submit(snapshot(7, "new"));
    first.resolve({ updatedAt: "old" });
    await coordinator.flush();

    expect(synchronized).toEqual(["new"]);
  });

  it("retains a failed snapshot, reports the error, and retries without dropping order", async () => {
    const persist = vi
      .fn<RecordSaveAdapter["persist"]>()
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockResolvedValueOnce({ updatedAt: "retry" })
      .mockResolvedValueOnce({ updatedAt: "next" });
    const coordinator = new RecordSaveCoordinator({ adapter: { persist } });
    coordinator.submit(snapshot(7, "failed"));
    coordinator.submit(snapshot(7, "after-failure"));

    await expect(coordinator.flush()).rejects.toThrow("disk busy");
    expect(coordinator.getStatus()).toMatchObject({
      phase: "error",
      pendingCount: 2,
      failedCount: 1,
    });

    coordinator.retryFailed();
    await coordinator.flush();
    expect(persist.mock.calls.map(([value]) => value.committedContent.markdown)).toEqual([
      "failed",
      "failed",
      "after-failure",
    ]);
  });

  it("copies submitted content so later caller mutation cannot change the queued save", async () => {
    const captured: CommittedProjectRecordSnapshot[] = [];
    const coordinator = new RecordSaveCoordinator({
      adapter: {
        persist: vi.fn(async (value) => {
          captured.push(value);
          return { updatedAt: "saved" };
        }),
      },
    });
    const value = snapshot(7, "immutable");

    coordinator.submit(value);
    value.tagIds.push(99);
    value.committedContent.markdown = "mutated";
    await coordinator.flush();

    expect(captured[0]).toMatchObject({
      tagIds: [2],
      committedContent: { markdown: "immutable" },
    });
    expect(Object.isFrozen(captured[0]?.committedContent)).toBe(true);
  });

  it("keeps permanent failures visible without retrying them", async () => {
    const persist = vi.fn(async () => {
      throw new RecordSaveFailure("invalid Record", { retryable: false });
    });
    const coordinator = new RecordSaveCoordinator({ adapter: { persist } });
    coordinator.submit(snapshot(7, "invalid"));

    await expect(coordinator.flush()).rejects.toThrow("invalid Record");
    expect(coordinator.getStatus()).toMatchObject({
      phase: "error",
      failedCount: 1,
      retryableFailedCount: 0,
    });
    coordinator.retryFailed();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

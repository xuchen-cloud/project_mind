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
    activityId: null,
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

describe("RecordSaveCoordinator", () => {
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

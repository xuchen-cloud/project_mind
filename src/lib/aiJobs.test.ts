import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiJobSnapshot } from "./types";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(), bindingGet: vi.fn(), list: vi.fn(), enqueue: vi.fn(), get: vi.fn(), cancel: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../services/projectMindApi", () => ({ projectMindApi: {
  aiJobBindingGet: mocks.bindingGet, aiJobsListActive: mocks.list,
  aiJobEnqueue: mocks.enqueue, aiJobGet: mocks.get, aiJobCancel: mocks.cancel,
} }));
import { cancelAiJob, enqueueAndWait, ensureAiJobSync, resetAiJobSync } from "./aiJobs";
import { useAiJobStore } from "../state/ai-job-store";

const a = { workspaceId: "A", generation: "open-A" };
const b = { workspaceId: "B", generation: "open-B" };
function job(binding = b, status: AiJobSnapshot["status"] = "running"): AiJobSnapshot {
  return { binding, id: 1, kind: "editor_skill", targetKey: "same-target", status,
    queuedAt: "now", streamText: binding.workspaceId, result: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let handlers: ((event: { payload: AiJobSnapshot }) => void)[];
let unlisteners: ReturnType<typeof vi.fn>[];
beforeEach(() => {
  resetAiJobSync(); vi.resetAllMocks(); handlers = []; unlisteners = [];
  mocks.bindingGet.mockResolvedValue(b);
  mocks.list.mockResolvedValue([]); mocks.get.mockResolvedValue(null);
  mocks.enqueue.mockResolvedValue(job());
  mocks.listen.mockImplementation(async (_name, handler) => {
    handlers.push(handler); const stop = vi.fn(); unlisteners.push(stop); return stop;
  });
});
afterEach(resetAiJobSync);

it("rejects A's same-ID result after switching to B, including a callback already in flight", async () => {
  mocks.bindingGet.mockResolvedValueOnce(a);
  await ensureAiJobSync();
  resetAiJobSync();
  await ensureAiJobSync();
  handlers[1]({ payload: job() });
  handlers[0]({ payload: job(a, "succeeded") });
  handlers[1]({ payload: job(a, "succeeded") });
  expect(useAiJobStore.getState().jobsById[1]).toEqual(job());
  expect(unlisteners[0]).toHaveBeenCalledOnce();
});

it("unlistens an asynchronous registration that finishes after reset", async () => {
  const registration = deferred<() => void>(); const stop = vi.fn();
  mocks.listen.mockReturnValueOnce(registration.promise);
  const first = ensureAiJobSync();
  await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
  resetAiJobSync();
  await ensureAiJobSync();
  registration.resolve(stop); await first;
  expect(stop).toHaveBeenCalledOnce();
  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(unlisteners[0]).not.toHaveBeenCalled();
});

it("does not publish an old list response after reset", async () => {
  const list = deferred<AiJobSnapshot[]>();
  mocks.bindingGet.mockResolvedValueOnce(a); mocks.list.mockReturnValueOnce(list.promise);
  const first = ensureAiJobSync();
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
  resetAiJobSync(); await ensureAiJobSync();
  handlers[1]({ payload: job() });
  list.resolve([job(a, "succeeded")]); await first;
  expect(useAiJobStore.getState().jobsById[1]).toEqual(job());
});

it("settles old waiters on reset and cannot resolve them with B's same-ID completion", async () => {
  mocks.bindingGet.mockResolvedValueOnce(a); mocks.enqueue.mockResolvedValueOnce(job(a));
  let outcome = "pending";
  const running = enqueueAndWait({ kind: "editor_skill", targetKey: "same-target", input: {
    skillName: "test", prompt: "test", resultMode: "modify", selectedText: "A",
  } }).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
  resetAiJobSync();
  await vi.waitFor(() => expect(outcome).toBe("rejected"));
  await ensureAiJobSync(); handlers[1]({ payload: job(b, "succeeded") });
  await running;
});

it("does not publish a get response that finishes after reset", async () => {
  const response = deferred<AiJobSnapshot | null>(); mocks.get.mockReturnValueOnce(response.promise);
  mocks.bindingGet.mockResolvedValueOnce(a); mocks.enqueue.mockResolvedValueOnce(job(a));
  const running = enqueueAndWait({ kind: "profile_test", targetKey: "profile", input: { name: "Test", providerFamily: "openai_compatible", baseUrl: "https://never-called.invalid", defaultModel: "test", supportsText: true, supportsImage: false, supportsFile: false, enabled: true } }).catch(() => undefined);
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
  resetAiJobSync(); await ensureAiJobSync(); handlers[1]({ payload: job() });
  response.resolve(job(a, "succeeded")); await Promise.resolve(); await Promise.resolve();
  expect(useAiJobStore.getState().jobsById[1]).toEqual(job());
  await running;
});


it("rejects results from a previous opening of the same Workspace", async () => {
  await ensureAiJobSync();
  handlers[0]({ payload: job() });
  handlers[0]({ payload: job({ ...b, generation: "previous-open" }, "succeeded") });
  expect(useAiJobStore.getState().jobsById[1]).toEqual(job());
});

it("does not enqueue A content when reset happens before binding lookup finishes", async () => {
  const binding = deferred<typeof a>(); mocks.bindingGet.mockReturnValueOnce(binding.promise);
  const running = enqueueAndWait({ kind: "editor_skill", targetKey: "target", input: {
    skillName: "Test", prompt: "test", resultMode: "modify", selectedText: "A",
  } });
  const settled = expect(running).rejects.toThrow("工作区已切换");
  resetAiJobSync(); await settled;
  binding.resolve(b); await Promise.resolve();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("rejects a bound metadata request that no longer matches the current Workspace", async () => {
  await expect(enqueueAndWait({ kind: "editor_skill", targetKey: "target", input: {
    skillName: "Test", prompt: "test", resultMode: "modify", selectedText: "A",
  } }, a)).rejects.toThrow("工作区已切换");
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("does not publish an enqueue response that arrives after switching Workspace", async () => {
  const response = deferred<AiJobSnapshot>(); mocks.enqueue.mockReturnValueOnce(response.promise);
  mocks.bindingGet.mockResolvedValueOnce(a);
  const running = enqueueAndWait({ kind: "editor_skill", targetKey: "target", input: {
    skillName: "Test", prompt: "test", resultMode: "modify", selectedText: "A",
  } });
  const settled = expect(running).rejects.toThrow("工作区已切换");
  await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  resetAiJobSync(); await settled; await ensureAiJobSync();
  handlers[1]({ payload: job() }); response.resolve(job(a, "succeeded"));
  await Promise.resolve(); await Promise.resolve();
  expect(useAiJobStore.getState().jobsById[1]).toEqual(job());
});

it("unlistens on setup failure and retries with only one effective listener", async () => {
  mocks.list.mockRejectedValueOnce(new Error("list failed"));
  await expect(ensureAiJobSync()).rejects.toThrow("list failed");
  expect(unlisteners[0]).toHaveBeenCalledOnce();
  await ensureAiJobSync();
  await ensureAiJobSync();
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  expect(unlisteners[1]).not.toHaveBeenCalled();
});

it("settles waiters when the native get fails instead of leaving an unhandled rejection", async () => {
  mocks.get.mockRejectedValueOnce(new Error("get failed"));
  await expect(enqueueAndWait({ kind: "editor_skill", targetKey: "target", input: {
    skillName: "Test", prompt: "test", resultMode: "modify", selectedText: "B",
  } })).rejects.toThrow("get failed");
  expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ id: 1, binding: b }));
});


it("cancels the captured identity and ignores a late cancellation response", async () => {
  const response = deferred<AiJobSnapshot | null>(); mocks.cancel.mockReturnValueOnce(response.promise);
  mocks.bindingGet.mockResolvedValueOnce(a); await ensureAiJobSync();
  const identity = { id: 1, binding: a };
  const cancelling = cancelAiJob(identity);
  expect(mocks.cancel).toHaveBeenCalledWith(identity);
  resetAiJobSync(); await ensureAiJobSync(); handlers[1]({ payload: job() });
  response.resolve(job(a, "cancelled")); await cancelling;
  expect(useAiJobStore.getState().jobsById[1]).toEqual(job());
});

it("does not tear down the current listener when an old pending setup fails", async () => {
  let fail!: (error: Error) => void;
  mocks.list.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  const oldSetup = ensureAiJobSync();
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
  resetAiJobSync(); await ensureAiJobSync();
  fail(new Error("old list failed")); expect(await oldSetup).toBeNull();
  await ensureAiJobSync();
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  expect(unlisteners[1]).not.toHaveBeenCalled();
});

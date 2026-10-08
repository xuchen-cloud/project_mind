import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeOutput } from "../lib/agent-types";
import { agentApi } from "../services/agentApi";
import { agentReviewPlanSummary, useAgentReviewPlan, type AgentReviewPlanOptions } from "./useAgentReviewPlan";
vi.mock("../services/agentApi", async importOriginal => {
  const original = await importOriginal<typeof import("../services/agentApi")>();
  return { ...original, agentApi: { outputReview: vi.fn() } };
});
const binding = { workspaceId: "workspace", generation: "one" };
function output(id: string, ordinal: number): AgentRuntimeOutput {
  return { id, runId: "run", ordinal, revision: 1, mode: "review", state: "staged", object: null, dismissed: false, errorCode: null, sources: [], sourceChanged: [], intent: { intent: "record_create", scope: { kind: "workspace" }, title: `记录 ${id}`, markdown: "候选正文" } };
}
const one = output("one", 0), two = output("two", 1);
const saved = (candidate: AgentRuntimeOutput): AgentRuntimeOutput => ({ ...candidate, state: "committed", object: { workspaceId: binding.workspaceId, scope: { kind: "workspace" }, kind: "record", id: candidate.id } });
function options(overrides: Partial<AgentReviewPlanOptions> = {}): AgentReviewPlanOptions {
  return { binding, runId: "run", current: true, terminal: true, complete: true, outputs: [two, one], commitOutput: vi.fn(async candidate => saved(candidate)), readOutputs: vi.fn(async () => [one, two]), applyOutputs: vi.fn(), ...overrides };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentApi.outputReview).mockImplementation(async (_binding, input, requestId) => ({ runId: input.runId, decision: input.decision, outputs: input.outputs.map(item => ({ ...(item.outputId === one.id ? one : two), revision: item.expectedRevision + (input.decision === "cancel" ? 1 : 0), dismissed: input.decision === "cancel", reviewDecision: { requestId: requestId!, decision: input.decision, text: input.text, decidedAt: "native-now" } })) }));
});
it("offers one plan only for the complete terminal current run", () => {
  const input = options();
  const view = renderHook(props => useAgentReviewPlan(props), { initialProps: { ...input, terminal: false } });
  expect(view.result.current.handle).toBeNull();
  for (const denied of [{ current: false }, { complete: false }]) {
    view.rerender({ ...input, ...denied }); expect(view.result.current.handle).toBeNull();
  }
  view.rerender(input);
  expect(view.result.current.handle?.pending).toEqual([{ outputId: "one", expectedRevision: 1 }, { outputId: "two", expectedRevision: 1 }]);
  expect(view.result.current.handle?.summary).toBe("创建记录 2 项（记录 one、记录 two）");
  expect(agentApi.outputReview).not.toHaveBeenCalled();
});
it("persists one explicit text decision before sequential native commits and suppresses duplicate clicks", async () => {
  let finish!: (value: AgentRuntimeOutput) => void;
  const input = options({ commitOutput: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(async candidate => saved(candidate)) });
  const view = renderHook(() => useAgentReviewPlan(input));
  let first!: Promise<unknown>, duplicate!: Promise<unknown>;
  act(() => { first = view.result.current.handle!.decide("confirm", "确认这两项"); duplicate = view.result.current.handle!.decide("confirm", "确认这两项"); });
  expect(first).toBe(duplicate);
  await waitFor(() => expect(input.commitOutput).toHaveBeenCalledTimes(1));
  expect(input.commitOutput).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "one", reviewDecision: expect.objectContaining({ text: "确认这两项" }) }));
  expect(agentApi.outputReview).toHaveBeenCalledOnce();
  expect(agentApi.outputReview).toHaveBeenCalledWith(binding, { runId: "run", decision: "confirm", text: "确认这两项", outputs: [{ outputId: "one", expectedRevision: 1 }, { outputId: "two", expectedRevision: 1 }] }, expect.any(String));
  await act(async () => { finish(saved(one)); await first; });
  expect(input.commitOutput).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "two" }));
  expect(view.result.current.result?.outputs.map(item => item.state)).toEqual(["committed", "committed"]);
});
it("waits for the in-flight native result then cancels the actual remaining complete set", async () => {
  let finish!: (value: AgentRuntimeOutput) => void;
  const input = options({ commitOutput: vi.fn(() => new Promise(resolve => { finish = resolve; })), readOutputs: vi.fn(async () => [saved(one), { ...two, revision: 3 }]) });
  const view = renderHook(() => useAgentReviewPlan(input)); let running!: Promise<unknown>, stopped!: Promise<unknown>;
  act(() => { running = view.result.current.handle!.decide("confirm"); });
  await waitFor(() => expect(input.commitOutput).toHaveBeenCalledOnce());
  act(() => { stopped = view.result.current.handle!.stop("停止剩余项"); });
  expect(stopped).toBe(running); expect(input.readOutputs).not.toHaveBeenCalled();
  expect(agentApi.outputReview).toHaveBeenCalledOnce();
  await act(async () => { finish(saved(one)); await stopped; });
  expect(input.commitOutput).toHaveBeenCalledOnce();
  expect(input.readOutputs).toHaveBeenCalledOnce();
  expect(agentApi.outputReview).toHaveBeenLastCalledWith(binding, { runId: "run", decision: "cancel", text: "停止剩余项", outputs: [{ outputId: "two", expectedRevision: 3 }] }, expect.any(String));
  expect(view.result.current.result?.outputs.map(item => [item.id, item.state, item.dismissed])).toEqual([["one", "committed", false], ["two", "staged", true]]);
});
it("reports partial native failures and reconciles durable states without guessing saved contents", async () => {
  const failure = { code: "REVISION_CONFLICT" };
  const input = options({ commitOutput: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(saved(two)), readOutputs: vi.fn(async () => [{ ...one, state: "failed" }, saved(two)]) });
  const view = renderHook(() => useAgentReviewPlan(input));
  await act(async () => { await view.result.current.handle!.decide("confirm"); });
  expect(input.commitOutput).toHaveBeenCalledTimes(2);
  expect(view.result.current.result?.failures).toEqual([{ outputId: "one", error: failure }]);
  expect(view.result.current.result?.outputs.map(item => item.state)).toEqual(["failed", "committed"]);
  expect(agentApi.outputReview).toHaveBeenCalledOnce();
});
it("cancels only through the durable metadata decision and preserves text and server revisions", async () => {
  const input = options(); const view = renderHook(() => useAgentReviewPlan(input));
  await act(async () => { await view.result.current.handle!.decide("cancel", "取消方案"); });
  expect(input.commitOutput).not.toHaveBeenCalled();
  expect(view.result.current.result?.outputs.every(item => item.dismissed && item.revision === 2 && item.reviewDecision?.text === "取消方案")).toBe(true);
});
it("reuses the same frozen decision request after network failure and uses a new identity for a changed candidate", async () => {
  vi.mocked(agentApi.outputReview).mockRejectedValueOnce(new Error("network"));
  const input = options(); const view = renderHook(props => useAgentReviewPlan(props), { initialProps: input });
  await act(async () => { await expect(view.result.current.handle!.decide("confirm", "确认")).rejects.toThrow("network"); });
  await act(async () => { await view.result.current.handle!.decide("confirm", "确认"); });
  expect(vi.mocked(agentApi.outputReview).mock.calls[0][2]).toBe(vi.mocked(agentApi.outputReview).mock.calls[1][2]);
  view.rerender({ ...input, outputs: [{ ...one, revision: 2 }] });
  await act(async () => { await view.result.current.handle!.decide("cancel"); });
  expect(vi.mocked(agentApi.outputReview).mock.calls[2][2]).not.toBe(vi.mocked(agentApi.outputReview).mock.calls[1][2]);
});
it("does not continue commits or apply old metadata after a Workspace generation changes", async () => {
  let reviewed!: (value: unknown) => void;
  vi.mocked(agentApi.outputReview).mockImplementationOnce(() => new Promise(resolve => { reviewed = resolve; }));
  const input = options(); const view = renderHook(props => useAgentReviewPlan(props), { initialProps: input }); let running!: Promise<unknown>;
  act(() => { running = view.result.current.handle!.decide("confirm"); });
  view.rerender({ ...input, binding: { ...binding, generation: "two" } });
  await act(async () => { reviewed({ runId: "run", decision: "confirm", outputs: [one, two] }); await expect(running).rejects.toMatchObject({ code: "REVISION_CONFLICT" }); });
  expect(input.commitOutput).not.toHaveBeenCalled(); expect(input.applyOutputs).not.toHaveBeenCalled();
});
it("bounds UTF-8 confirmation text and derives summary only from actual candidate names and counts", async () => {
  const input = options(); const view = renderHook(() => useAgentReviewPlan(input));
  await expect(view.result.current.handle!.decide("confirm", "字".repeat(1366))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  expect(agentApi.outputReview).not.toHaveBeenCalled();
  expect(agentReviewPlanSummary([{ ...one, intent: { intent: "file_create", projectId: 7, safeName: "实际计划.html", utf8Content: "<h1>内容</h1>" } }, two])).toBe("创建文件 1 项（实际计划.html），创建记录 1 项（记录 two）");
});


it("preserves a native save whose later response failed and never cancels that committed item", async () => {
  let reject!: (error: unknown) => void;
  const input = options({ commitOutput: vi.fn(() => new Promise((_resolve, fail) => { reject = fail; })), readOutputs: vi.fn(async () => [saved(one), two]) });
  const view = renderHook(() => useAgentReviewPlan(input)); let running!: Promise<unknown>;
  act(() => { running = view.result.current.handle!.decide("confirm"); });
  await waitFor(() => expect(input.commitOutput).toHaveBeenCalledOnce());
  act(() => { void view.result.current.handle!.stop(); });
  await act(async () => { reject(new Error("later notification failed")); await running; });
  expect(agentApi.outputReview).toHaveBeenLastCalledWith(binding, { runId: "run", decision: "cancel", outputs: [{ outputId: "two", expectedRevision: 1 }] }, expect.any(String));
  expect(view.result.current.result?.outputs.find(item => item.id === "one")?.state).toBe("committed");
  expect(view.result.current.result?.failures).toEqual([]);
});

it("keeps the handle stable for an unchanged plan and rejects an old Workspace handle", async () => {
  const input = options(); const view = renderHook(props => useAgentReviewPlan(props), { initialProps: input });
  const handle = view.result.current.handle;
  view.rerender({ ...input, outputs: [...input.outputs] });
  expect(view.result.current.handle).toBe(handle);
  view.rerender({ ...input, binding: { ...binding, generation: "new" } });
  await expect(handle!.decide("confirm")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(agentApi.outputReview).not.toHaveBeenCalled();
});


it("retries an already confirmed exact candidate directly and preserves its first durable approval", async () => {
  const approved = { ...one, state: "failed" as const, reviewDecision: { requestId: "first-confirm", decision: "confirm" as const, text: "首次确认", decidedAt: "first-time" } };
  const input = options({ outputs: [approved] }); const view = renderHook(() => useAgentReviewPlan(input));
  expect(view.result.current.handle?.confirmed).toBe(true);
  await act(async () => { await view.result.current.handle!.decide("confirm", "重试"); });
  expect(agentApi.outputReview).not.toHaveBeenCalled();
  expect(input.commitOutput).toHaveBeenCalledWith(approved);
  expect(view.result.current.result?.outputs[0].reviewDecision).toEqual(approved.reviewDecision);
});

it("rejects a stale handle when the proposal revision changes in the same run", async () => {
  const input = options(); const view = renderHook(props => useAgentReviewPlan(props), { initialProps: input });
  const oldHandle = view.result.current.handle!;
  view.rerender({ ...input, outputs: [{ ...one, revision: 2 }, two] });
  await expect(oldHandle.decide("confirm")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(agentApi.outputReview).not.toHaveBeenCalled();
  await act(async () => { await view.result.current.handle!.decide("cancel"); });
  expect(agentApi.outputReview).toHaveBeenCalledWith(binding, expect.objectContaining({ outputs: [{ outputId: "one", expectedRevision: 2 }, { outputId: "two", expectedRevision: 1 }] }), expect.any(String));
});

it("settles local busy state if the run stops being current during a save", async () => {
  let finish!: (candidate: AgentRuntimeOutput) => void;
  const input = options({ commitOutput: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
  const view = renderHook(props => useAgentReviewPlan(props), { initialProps: input }); let running!: Promise<unknown>;
  act(() => { running = view.result.current.handle!.decide("confirm"); });
  await waitFor(() => expect(input.commitOutput).toHaveBeenCalledOnce());
  view.rerender({ ...input, current: false });
  await act(async () => { finish(saved(one)); await expect(running).rejects.toMatchObject({ code: "REVISION_CONFLICT" }); });
  expect(view.result.current.busy).toBe(false);
  expect(input.commitOutput).toHaveBeenCalledOnce();
  expect(view.result.current.handle).toBeNull();
});

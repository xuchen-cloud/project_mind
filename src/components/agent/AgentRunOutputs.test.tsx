import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeOutput } from "../../lib/agent-types";
import { AgentRunOutputs } from "./AgentRunOutputs";
const api = vi.hoisted(() => ({ statusGet: vi.fn(), outputReview: vi.fn(), outputList: vi.fn(), operationList: vi.fn(), outputCommit: vi.fn(), outputDismiss: vi.fn(), outputGet: vi.fn(), operationUndo: vi.fn(), operationUndoBatch: vi.fn(), operationGet: vi.fn(), operationRestoreCreated: vi.fn() }));
vi.mock("../../services/agentApi", async importOriginal => ({ ...await importOriginal<typeof import("../../services/agentApi")>(), agentApi: api }));
vi.mock("./AgentOutputCard", () => ({ AgentOutputCard: ({ output, operation, recoveryOperation, presentation, hideUndo, hideRestore, onCommit, onDismiss, onUndo, onRestore }: { output: AgentRuntimeOutput; operation: unknown; recoveryOperation?: { operationId: string; recovery?: { withdrawn: boolean } }; presentation?: string; hideUndo?: boolean; hideRestore?: boolean; onCommit: () => Promise<void>; onDismiss: () => Promise<void>; onUndo: () => Promise<void>; onRestore: () => Promise<void> }) => presentation === "link" ? recoveryOperation?.recovery?.withdrawn ? null : <span>对象 {output.id}</span> : <article>
  <span>{output.id} · {output.dismissed ? "dismissed" : output.state}</span><button onClick={() => { void onCommit().catch(() => {}); void onCommit().catch(() => {}); }}>保存 {output.id}</button>
  {!output.dismissed ? <button onClick={() => { void onDismiss().catch(() => {}); void onDismiss().catch(() => {}); }}>取消 {output.id}</button> : null}
  {operation ? <>{!hideUndo ? <button onClick={() => void onUndo()}>撤销 {output.id}</button> : null}{!hideRestore ? <button onClick={() => void onRestore()}>恢复 {output.id}</button> : null}</> : null}
  {recoveryOperation ? <span>恢复基线 {output.id}: {recoveryOperation.operationId}</span> : null}</article> }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project", projectId: 1 } as const, kind: "record" as const, id: "7" };
const output: AgentRuntimeOutput = { id: "out", runId: "run", ordinal: 0, revision: 1, intent: { intent: "record_create", scope: object.scope, title: "候选记录", markdown: "正文" }, sources: [], sourceChanged: [], dismissed: false, state: "staged", mode: "review", object: null, errorCode: null };
const operation = { operationId: "op", requestId: "output:out:1", kind: "record.create", object, afterRevision: 1, undoState: "available", recovery: { withdrawn: false, withdrawalRevision: null, restoreAvailable: false } };
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current /></QueryClientProvider>);
}
beforeEach(() => { vi.resetAllMocks(); api.statusGet.mockResolvedValue({ binding }); api.outputList.mockResolvedValue({ outputs: [output], nextCursor: null }); api.operationList.mockResolvedValue({ operations: [], nextCursor: null }); });

it("reads every bounded candidate page before offering one whole-run confirmation", async () => {
  let lastPage!: (value: unknown) => void;
  api.outputList.mockResolvedValueOnce({ outputs: [output], nextCursor: "next" }).mockImplementationOnce(() => new Promise(resolve => { lastPage = resolve; }));
  view(); expect(api.outputList).toHaveBeenCalledOnce(); expect(api.operationList).toHaveBeenCalledOnce();
  await waitFor(() => expect(api.outputList).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  expect(api.outputList).toHaveBeenCalledWith(binding, { runId: "run", cursor: null, limit: 50 });
  expect(api.operationList).toHaveBeenCalledWith(binding, { runId: "run", limit: 50 });
  expect(api.outputCommit).not.toHaveBeenCalled();
  await act(async () => lastPage({ outputs: [{ ...output, id: "next", ordinal: 1 }], nextCursor: null }));
  await waitFor(() => expect(screen.getByText("next · staged")).toBeInTheDocument());
  expect(api.outputList).toHaveBeenLastCalledWith(binding, { runId: "run", cursor: "next", limit: 50 });
  expect(screen.getAllByRole("button", { name: "确认执行" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
});

it("prevents duplicate UI commit and never rewrites a committed output", async () => {
  let complete!: (value: unknown) => void;
  api.outputCommit.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  view();
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  expect(api.outputCommit).toHaveBeenCalledOnce();
  expect(api.outputCommit).toHaveBeenCalledWith(binding, { outputId: "out", expectedRevision: 1 }, expect.any(String));
  await act(async () => complete({ output: { ...output, state: "committed", object }, receipt: {}, operation }));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "撤销 out", hidden: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  expect(api.outputCommit).toHaveBeenCalledOnce();
});

it("reconciles a failed commit before retry and reuses the same UI request identity", async () => {
  api.outputCommit.mockRejectedValueOnce({ code: "OUTPUT_COMMIT_FAILED" })
    .mockResolvedValueOnce({ output: { ...output, state: "committed", object }, receipt: {}, operation });
  api.outputGet.mockResolvedValue({ ...output, state: "failed", errorCode: "OUTPUT_COMMIT_FAILED" });
  view();
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  await waitFor(() => expect(screen.getByText("out · failed")).toBeInTheDocument());
  expect(api.outputGet).toHaveBeenCalledWith(binding, { outputId: "out" });
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  expect(api.outputCommit).toHaveBeenCalledTimes(2);
  expect(api.outputCommit.mock.calls[0][2]).toBe(api.outputCommit.mock.calls[1][2]);
});

it("refreshes actual receipt recovery after undo and restores using its withdrawal revision", async () => {
  api.outputList.mockResolvedValue({ outputs: [{ ...output, state: "committed", object }], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [operation], nextCursor: null });
  api.operationUndo.mockResolvedValue({ withdrawn: true, revision: 2 });
  api.operationGet.mockResolvedValueOnce({ ...operation, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } })
    .mockResolvedValue({ ...operation, undoState: "undone", recovery: { withdrawn: false, withdrawalRevision: 3, restoreAvailable: false } });
  api.operationRestoreCreated.mockResolvedValue({ withdrawn: false, revision: 3 });
  view();
  await waitFor(() => expect(screen.getByRole("button", { name: "撤销 out", hidden: true })).toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("已保存 1 项");
  fireEvent.click(screen.getByRole("button", { name: "撤销 out", hidden: true }));
  await waitFor(() => expect(api.operationGet).toHaveBeenCalledWith(binding, { operationId: "op" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已撤回 1 项"));
  expect(screen.getByRole("status")).not.toHaveTextContent("已保存");
  expect(api.operationUndo).toHaveBeenCalledWith(binding, { operationId: "op", expectedHeadRevision: 1 }, expect.any(String));
  fireEvent.click(screen.getByRole("button", { name: "恢复 out", hidden: true }));
  await waitFor(() => expect(api.operationRestoreCreated).toHaveBeenCalledWith(binding, { creationOperationId: "op", expectedWithdrawalRevision: 2 }, expect.any(String)));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已恢复 1 项"));
});

it("discards an old workspace output response when the inline binding switches", async () => {
  let oldPage!: (value: unknown) => void;
  api.outputList.mockImplementationOnce(() => new Promise(resolve => { oldPage = resolve; }));
  const client = new QueryClient();
  const wrap = (generation: string) => <QueryClientProvider client={client}><AgentRunOutputs binding={{ ...binding, generation }} runId="run" current /></QueryClientProvider>;
  const rendered = render(wrap("g"));

  rendered.rerender(wrap("new"));
  await act(async () => oldPage({ outputs: [{ ...output, id: "old" }], nextCursor: null }));
  expect(screen.queryByText("old · staged")).not.toBeInTheDocument();

  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  expect(api.outputList).toHaveBeenLastCalledWith({ ...binding, generation: "new" }, { runId: "run", cursor: null, limit: 50 });
});

it("does not let an older list response downgrade a committed output", async () => {
  let outdated!: (value: unknown) => void;
  api.outputList.mockResolvedValueOnce({ outputs: [output], nextCursor: null })
    .mockImplementationOnce(() => new Promise(resolve => { outdated = resolve; }));
  api.outputCommit.mockResolvedValue({ output: { ...output, state: "committed", object }, receipt: {}, operation });
  const client = new QueryClient();
  const wrap = (active: boolean) => <QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" active={active} /></QueryClientProvider>;
  const rendered = render(wrap(false));
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  rendered.rerender(wrap(true));
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  await act(async () => outdated({ outputs: [output], nextCursor: null }));
  expect(screen.getByText("out · committed")).toBeInTheDocument();
});

it("takes one final read when a run settles and stops polling even if a collaborate candidate is staged", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  api.outputList.mockResolvedValue({ outputs: [{ ...output, mode: "collaborate" }], nextCursor: null });
  const wrapper = (active: boolean) => <QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current active={active} /></QueryClientProvider>;
  const rendered = render(wrapper(true));
  try {
    await act(async () => {});
    expect(api.outputList).toHaveBeenCalledTimes(1);
    await act(async () => rendered.rerender(wrapper(false)));
    expect(api.outputList).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(10000));
    expect(api.outputList).toHaveBeenCalledTimes(2);
    expect(api.outputCommit).not.toHaveBeenCalled();
  } finally { rendered.unmount(); vi.useRealTimers(); }
});


it("updates a Todo card from the actual commit receipt and invalidates the native Todo views", async () => {
  const todoObject = { ...object, kind: "todo" as const, id: "18" };
  const todo: AgentRuntimeOutput = { ...output, mode: "collaborate", intent: { intent: "todo_create", scope: object.scope,
    dedupeKey: "verify-evidence", content: "核对资料", priority: "not_urgent_important", dueDate: null, tagIds: [], children: [] } };
  const todoReceipt = { ...operation, kind: "todo.create", object: todoObject };
  api.outputList.mockResolvedValue({ outputs: [todo], nextCursor: null });
  api.outputCommit.mockResolvedValue({ output: { ...todo, state: "committed", object: todoObject }, receipt: { revision: 1 }, operation: todoReceipt });
  const client = new QueryClient(); const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current /></QueryClientProvider>);

  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "撤销 out", hidden: true })).toBeInTheDocument();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["todo-views"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["todos"] });
  api.operationUndo.mockResolvedValue({ withdrawn: true, revision: 2 });
  api.operationGet.mockResolvedValue({ ...todoReceipt, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } });
  fireEvent.click(screen.getByRole("button", { name: "撤销 out", hidden: true }));
  await waitFor(() => expect(api.operationGet).toHaveBeenCalledWith(binding, { operationId: "op" }));
  fireEvent.click(screen.getByRole("button", { name: "恢复 out", hidden: true }));
  await waitFor(() => expect(api.operationRestoreCreated).toHaveBeenCalledWith(binding, { creationOperationId: "op", expectedWithdrawalRevision: 2 }, expect.any(String)));
});

it("matches a Todo update receipt and uses its real numeric after-revision for undo", async () => {
  const todoObject = { ...object, kind: "todo" as const, id: "18" };
  const todo: AgentRuntimeOutput = { ...output, object: todoObject, state: "committed", intent: { intent: "todo_update", target: todoObject, expectedRevision: 3, changes: [{ change: "status", status: "finished" }] } };
  const todoReceipt = { ...operation, kind: "todo.update", object: todoObject, beforeRevision: 3, afterRevision: 4, recovery: null };
  api.outputList.mockResolvedValue({ outputs: [todo], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [todoReceipt], nextCursor: null });
  api.operationUndo.mockResolvedValue({ operationId: "undo", originalOperationId: "op", object: todoObject, beforeRevision: 4, afterRevision: 5, beforeSnapshotRef: "before", afterSnapshotRef: "after", bodyHash: "sha256:restored" });
  api.operationGet.mockResolvedValue({ ...todoReceipt, undoState: "undone" });
  view();
  await waitFor(() => expect(screen.getByRole("button", { name: "撤销 out", hidden: true })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "撤销 out", hidden: true }));
  await waitFor(() => expect(api.operationUndo).toHaveBeenCalledWith(binding, { operationId: "op", expectedHeadRevision: 4 }, expect.any(String)));
  expect(api.outputCommit).not.toHaveBeenCalled();
});


it("hides empty inline output groups without a management heading or empty-state message", async () => {
  api.outputList.mockResolvedValue({ outputs: [], nextCursor: null });
  const rendered = view();
  await waitFor(() => expect(api.outputList).toHaveBeenCalledOnce());
  expect(rendered.container).toBeEmptyDOMElement();
  expect(screen.queryByRole("button", { name: "本次运行成果" })).not.toBeInTheDocument();
});

it("persists cancellation through CAS, suppresses duplicate dismissal, and reads the cancelled state again after reopening", async () => {
  let settle!: (value: AgentRuntimeOutput) => void;
  api.outputDismiss.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const rendered = view();
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "取消 out", hidden: true }));
  expect(api.outputDismiss).toHaveBeenCalledOnce();
  expect(api.outputDismiss).toHaveBeenCalledWith(binding, { outputId: "out", expectedRevision: 1 }, expect.any(String));
  expect(api.outputCommit).not.toHaveBeenCalled();
  expect(screen.queryByText("out · dismissed")).not.toBeInTheDocument();
  const dismissed = { ...output, revision: 2, dismissed: true };
  await act(async () => settle(dismissed));
  await waitFor(() => expect(screen.getByText("out · dismissed")).toBeInTheDocument());
  api.outputList.mockResolvedValue({ outputs: [dismissed], nextCursor: null });
  rendered.unmount(); view();
  await waitFor(() => expect(screen.getByText("out · dismissed")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  expect(api.outputCommit).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "取消 out", hidden: true })).not.toBeInTheDocument();
});

it("applies the actual File commit receipt, version cache invalidation and receipt-based undo", async () => {
  const fileObject = { ...object, kind: "file" as const, id: "41" };
  const file: AgentRuntimeOutput = { ...output, intent: { intent: "file_patch", patch: { object: fileObject, expectedVersionNumber: 2, expectedContentHash: "sha256:current", appendText: "补充", edits: null } } };
  const receipt = { ...operation, kind: "file.version.commit", object: fileObject, beforeRevision: 2, afterRevision: 3, recovery: null };
  api.outputList.mockResolvedValue({ outputs: [file], nextCursor: null });
  api.outputCommit.mockResolvedValue({ output: { ...file, state: "committed", object: fileObject, fileReceipt: { documentId: 41, versionNumber: 3, contentHash: "sha256:new", noChange: false } }, receipt: { documentId: 41, versionNumber: 3, contentHash: "sha256:new", noChange: false }, operation: receipt });
  const client = new QueryClient(); const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "保存 out", hidden: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "撤销 out", hidden: true })).toBeInTheDocument());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["documentVersions", 41] });
  api.operationGet.mockResolvedValue({ ...receipt, undoState: "undone" });
  fireEvent.click(screen.getByRole("button", { name: "撤销 out", hidden: true }));
  await waitFor(() => expect(api.operationUndo).toHaveBeenCalledWith(binding, { operationId: "op", expectedHeadRevision: 3 }, expect.any(String)));
});

function reviewedFixture(values: AgentRuntimeOutput[]) {
  let actual = values;
  api.outputList.mockImplementation(async (_binding, input) => { expect(input.limit).toBeLessThanOrEqual(50); return { outputs: actual, nextCursor: null }; });
  api.outputGet.mockImplementation(async (_binding, input) => actual.find(value => value.id === input.outputId));
  api.outputReview.mockImplementation(async (_binding, input, requestId) => {
    const selected = new Set<string>(input.outputs.map((value: { outputId: string }) => value.outputId));
    actual = actual.map(value => selected.has(value.id) ? { ...value,
      reviewDecision: { requestId, decision: input.decision, text: input.text, decidedAt: "2026-10-08T00:00:00Z" },
      ...(input.decision === "cancel" ? { dismissed: true, revision: value.revision + 1 } : {}),
    } : value);
    return { runId: input.runId, decision: input.decision, outputs: actual.filter(value => selected.has(value.id)) };
  });
  return {
    read: () => actual,
    fail(id: string) { actual = actual.map(value => value.id === id ? { ...value, state: "failed", errorCode: "OUTPUT_COMMIT_FAILED" } : value); },
    save(id: string) {
      const candidate = actual.find(value => value.id === id)!;
      const committed: AgentRuntimeOutput = { ...candidate, state: "committed", errorCode: null, object: { ...object, id: id === "out" ? "7" : "8" } };
      actual = actual.map(value => value.id === id ? committed : value);
      return { output: committed, receipt: {}, operation: null };
    },
  };
}
const second: AgentRuntimeOutput = { ...output, id: "second", ordinal: 1, intent: { ...output.intent, title: "后续记录" } as AgentRuntimeOutput["intent"] };

it("confirms the complete plan once and saves serially in actual ordinal order", async () => {
  const fixture = reviewedFixture([second, output]);
  let settle!: () => void;
  api.outputCommit.mockImplementation(async (_binding, input) => {
    if (input.outputId === "out") await new Promise<void>(resolve => { settle = resolve; });
    return fixture.save(input.outputId);
  });
  view();
  const confirm = await screen.findByRole("button", { name: "确认执行" });
  expect(screen.getByText(/创建记录 2 项/)).toHaveTextContent("候选记录、后续记录");
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(api.outputCommit).toHaveBeenCalledTimes(1));
  expect(api.outputReview).toHaveBeenCalledOnce();
  expect(api.outputReview).toHaveBeenCalledWith(binding, { runId: "run", outputs: [{ outputId: "out", expectedRevision: 1 }, { outputId: "second", expectedRevision: 1 }], decision: "confirm" }, expect.any(String));
  expect(api.outputCommit.mock.calls[0][1].outputId).toBe("out");
  await act(async () => settle());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存 2 项"));
  expect(api.outputCommit.mock.calls[1][1].outputId).toBe("second");
  expect(screen.getAllByText("对象 out")).toHaveLength(1);
  expect(screen.getAllByText("对象 second")).toHaveLength(1);
  expect(screen.getByText("查看成果详情（2）").closest("details")).not.toHaveAttribute("open");
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
});

it("reports partial saves and retries the persisted approved candidate without another decision", async () => {
  const fixture = reviewedFixture([output, second]);
  let first = true;
  api.outputCommit.mockImplementation(async (_binding, input) => {
    if (input.outputId === "out" && first) { first = false; fixture.fail("out"); throw { code: "OUTPUT_COMMIT_FAILED" }; }
    return fixture.save(input.outputId);
  });
  view(); fireEvent.click(await screen.findByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存 1 项，1 项未保存"));
  expect(api.outputCommit).toHaveBeenCalledTimes(2);
  fireEvent.click(await screen.findByRole("button", { name: "重试未保存项" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存 2 项"));
  expect(api.outputReview).toHaveBeenCalledOnce();
  expect(api.outputCommit).toHaveBeenCalledTimes(3);
  expect(api.outputCommit.mock.calls[2][1].outputId).toBe("out");
  expect(api.outputCommit.mock.calls[2][2]).toBe(api.outputCommit.mock.calls[0][2]);
});

it("exposes the same stable handle for typed cancellation and retains no old confirmation after reopening", async () => {
  const fixture = reviewedFixture([output, second]);
  const onReviewChange = vi.fn();
  const client = new QueryClient();
  const wrapper = <QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current onReviewChange={onReviewChange} /></QueryClientProvider>;
  const rendered = render(wrapper);
  await screen.findByRole("button", { name: "确认执行" });
  const handle = onReviewChange.mock.calls.at(-1)![0];
  rendered.rerender(wrapper);
  expect(onReviewChange.mock.calls.at(-1)![0]).toBe(handle);
  await act(async () => { await handle.decide("cancel", "取消"); });
  expect(api.outputReview.mock.calls[0][1].text).toBe("取消");
  expect(screen.getByRole("status")).toHaveTextContent("已取消 2 项");
  expect(screen.getByText("已取消：取消")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  expect(onReviewChange.mock.calls.at(-1)![0]).toBeNull();
  expect(api.outputCommit).not.toHaveBeenCalled();
  rendered.unmount(); render(wrapper);
  await screen.findByText("已取消：取消");
  expect(fixture.read().every(value => value.dismissed && value.revision === 2)).toBe(true);
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
});

it("waits for the current save before stopping and cancels only the actual remaining proposal", async () => {
  const fixture = reviewedFixture([output, second]);
  let settle!: () => void;
  api.outputCommit.mockImplementation(async (_binding, input) => {
    await new Promise<void>(resolve => { settle = resolve; });
    return fixture.save(input.outputId);
  });
  view(); fireEvent.click(await screen.findByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(api.outputCommit).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "停止剩余项" }));
  expect(api.outputReview).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();
  await act(async () => settle());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存 1 项，已取消 1 项"));
  expect(api.outputCommit).toHaveBeenCalledOnce();
  expect(api.outputReview.mock.calls[1][1]).toEqual({ runId: "run", outputs: [{ outputId: "second", expectedRevision: 1 }], decision: "cancel" });
  expect(screen.getByText("对象 out")).toBeInTheDocument();
  expect(screen.queryByText("对象 second")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
});

it("waits for an active run, then keeps its pending plan actionable in history", async () => {
  const onReviewChange = vi.fn();
  const client = new QueryClient();
  const wrap = (current: boolean, active: boolean) => <QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current={current} active={active} onReviewChange={onReviewChange} /></QueryClientProvider>;
  const rendered = render(wrap(true, true));
  await screen.findByText("out · staged");
  expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  expect(onReviewChange.mock.calls.at(-1)![0]).toBeNull();
  rendered.rerender(wrap(false, false));
  await waitFor(() => expect(api.outputList).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "确认执行" })).toBeInTheDocument();
  expect(api.outputReview).not.toHaveBeenCalled();
});

it("refreshes a historical plan once when a later run settles", async () => {
  const client = new QueryClient();
  const wrap=(refreshToken: string) => <QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current={false} refreshToken={refreshToken} /></QueryClientProvider>;
  api.outputList.mockResolvedValueOnce({outputs:[output],nextCursor:null})
    .mockResolvedValue({outputs:[{...output,state:"committed",object}],nextCursor:null});
  const rendered=render(wrap("later:running"));
  await screen.findByRole("button",{name:"确认执行"});
  rendered.rerender(wrap("later:completed"));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  expect(screen.queryByRole("button",{name:"确认执行"})).not.toBeInTheDocument();
  expect(api.outputList).toHaveBeenCalledTimes(2);
});

it("does not offer approval after a later revision retires the historical plan", async () => {
  api.outputList.mockResolvedValue({outputs:[{...output,dismissed:true,revision:2,reviewDecision:{requestId:"revise",decision:"revise",decidedAt:"2026-10-09T00:00:00Z"}}],nextCursor:null});
  const client=new QueryClient();
  render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current={false} /></QueryClientProvider>);
  await screen.findByText("out · dismissed");
  expect(screen.queryByRole("button",{name:"确认执行"})).not.toBeInTheDocument();
  expect(screen.getByText(/已调整旧方案/)).toBeInTheDocument();
});

it.each([true, false])("reads a deeper original receipt before claiming a saved result after reopening (current=%s)", async current => {
  api.outputList.mockResolvedValue({ outputs: [{ ...output, state: "committed", object }], nextCursor: null });
  api.operationList.mockResolvedValueOnce({ operations: [{ ...operation, operationId: "earlier", requestId: "output:earlier:1" }], nextCursor: "original-next" })
    .mockResolvedValueOnce({ operations: [{ ...operation, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } }], nextCursor: "more-history" });
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current={current} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已撤回 1 项"));
  expect(screen.getByRole("status")).not.toHaveTextContent("已保存");
  expect(api.operationList).toHaveBeenCalledTimes(2);
  expect(api.operationList).toHaveBeenLastCalledWith(binding, { runId: "run", cursor: "original-next", limit: 50 });
  expect(screen.getByRole("button", { name: "更多操作记录" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("已显示：");
  expect(api.outputCommit).not.toHaveBeenCalled();
});

it("does not exhaust operation history looking for a receipt for an unchanged File", async () => {
  const fileObject = { ...object, kind: "file" as const, id: "41" };
  const file: AgentRuntimeOutput = { ...output, state: "committed", object: fileObject,
    intent: { intent: "file_patch", patch: { object: fileObject, expectedVersionNumber: 2, expectedContentHash: "sha256:same", appendText: "", edits: null } },
    fileReceipt: { documentId: 41, versionNumber: 2, contentHash: "sha256:same", noChange: true } };
  api.outputList.mockResolvedValue({ outputs: [file], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [], nextCursor: "unrelated-history" });
  view();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("内容相同 1 项"));
  expect(api.operationList).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "更多操作记录" })).toBeInTheDocument();
});

const batchReceipt = { ...operation, runId: "run", beforeRevision: null, beforeSnapshotRef: null, afterSnapshotRef: "v1", createdAt: "2026-10-08T00:00:00Z", undoOperationId: null };
const changedReceipt = { ...batchReceipt, operationId: "update", requestId: "output:later:1", kind: "record.patch", beforeRevision: 1, afterRevision: 2, beforeSnapshotRef: "v1", afterSnapshotRef: "v2", recovery: null };
const committed = { ...output, state: "committed" as const, object };

it("reads all operation pages before undoing creation and later changes as one object", async () => {
  const unrelated = Array.from({ length: 49 }, (_, index) => ({ ...batchReceipt, operationId: `other-${index}`, object: { ...object, id: `${index + 20}` }, undoState: "unavailable" as const }));
  api.outputList.mockResolvedValue({ outputs: [committed, { ...committed, id: "later", ordinal: 1 }], nextCursor: null });
  api.operationList.mockImplementation(async (_binding, input) => input.cursor === "next" ? { operations: [changedReceipt], nextCursor: null }
    : { operations: [batchReceipt, ...unrelated], nextCursor: "next" });
  api.operationUndoBatch.mockResolvedValue({ runId: "run", results: [{ object, operationIds: ["op", "update"], outcome: { status: "succeeded", result: { withdrawn: true } } }], excludedNoChangeIds: [] });
  view();
  fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(api.operationUndoBatch).toHaveBeenCalledOnce());
  expect(api.operationUndoBatch).toHaveBeenCalledWith(binding, { runId: "run", operationIds: ["op", "update"] });
  expect(api.operationList.mock.calls.some(([, input]) => input.cursor === "next")).toBe(true);
  expect(screen.getAllByText("对象 later")).toHaveLength(1);
  expect(screen.queryByText("对象 out")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "撤销 out", hidden: true })).not.toBeInTheDocument();
});

it("undoes multiple updates of one object with one native batch and its first baseline", async () => {
  const first = { ...changedReceipt, operationId: "first", beforeRevision: 3, afterRevision: 4, beforeSnapshotRef: "v3", afterSnapshotRef: "v4" };
  const second = { ...changedReceipt, operationId: "second", beforeRevision: 4, afterRevision: 5, beforeSnapshotRef: "v4", afterSnapshotRef: "v5" };
  api.outputList.mockResolvedValue({ outputs: [{ ...committed, intent: { intent: "record_patch", patch: { record: object, baseRevision: 3, operations: [] } } }], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [first, second], nextCursor: null });
  api.operationUndoBatch.mockResolvedValue({ runId: "run", results: [{ object, operationIds: ["first", "second"], outcome: { status: "succeeded", result: { operationId: "undo", originalOperationId: "first", object } } }], excludedNoChangeIds: [] });
  view(); fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(api.operationUndoBatch).toHaveBeenCalledWith(binding, { runId: "run", operationIds: ["first", "second"] }));
  expect(api.operationUndo).not.toHaveBeenCalled();
  expect(screen.getByText(/修改记录/)).toBeInTheDocument();
});

it("counts a creation plus update as one withdrawn object and restores its creation receipt from the latest card", async () => {
  const withdrawnCreation = { ...batchReceipt, undoState: "undone" as const, recovery: { withdrawn: true, withdrawalRevision: 3, restoreAvailable: true } };
  const undoneUpdate = { ...changedReceipt, undoState: "undone" as const };
  api.outputList.mockResolvedValue({ outputs: [committed, { ...committed, id: "later", ordinal: 1 }], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [withdrawnCreation, undoneUpdate], nextCursor: null });
  api.operationGet.mockResolvedValue({ ...withdrawnCreation, recovery: { withdrawn: false, withdrawalRevision: 4, restoreAvailable: false } });
  api.operationRestoreCreated.mockResolvedValue({ withdrawn: false, revision: 4 });
  view();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已撤回 1 项"));
  expect(screen.getByRole("status")).not.toHaveTextContent("已撤销 1 项");
  expect(screen.queryByText("对象 later")).not.toBeInTheDocument();
  expect(screen.getByText("恢复基线 later: op")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "恢复 out", hidden: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "恢复 later", hidden: true }));
  await waitFor(() => expect(api.operationRestoreCreated).toHaveBeenCalledWith(binding, { creationOperationId: "op", expectedWithdrawalRevision: 3 }, expect.any(String)));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已恢复 1 项"));
});

it("keeps successful groups out of partial retry and shows the failed object", async () => {
  const secondObject = { ...object, id: "8" };
  const secondReceipt = { ...batchReceipt, operationId: "second-op", object: secondObject, requestId: "output:second:1" };
  let receipts = [batchReceipt, secondReceipt];
  api.outputList.mockResolvedValue({ outputs: [committed, { ...committed, id: "second", object: secondObject }], nextCursor: null });
  api.operationList.mockImplementation(async () => ({ operations: receipts, nextCursor: null }));
  api.operationUndoBatch.mockImplementationOnce(async () => {
    receipts = [{ ...batchReceipt, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } }, secondReceipt];
    return { runId: "run", results: [
      { object, operationIds: ["op"], outcome: { status: "succeeded", result: { withdrawn: true } } },
      { object: secondObject, operationIds: ["second-op"], outcome: { status: "failed", error: { code: "UNDO_CONFLICT", message: "conflict", retryable: false } } },
    ], excludedNoChangeIds: [] };
  }).mockResolvedValue({ runId: "run", results: [{ object: secondObject, operationIds: ["second-op"], outcome: { status: "succeeded", result: { withdrawn: true } } }], excludedNoChangeIds: [] });
  view(); fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(screen.getByText(/1 项撤销未完成/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(api.operationUndoBatch).toHaveBeenCalledTimes(2));
  expect(api.operationUndoBatch.mock.calls[1][1].operationIds).toEqual(["second-op"]);
});

it("keeps another object error visible after retrying one failed group", async () => {
  const secondObject = { ...object, id: "8" };
  const secondReceipt = { ...batchReceipt, operationId: "second-op", object: secondObject, requestId: "output:second:1" };
  api.outputList.mockResolvedValue({ outputs: [committed, { ...committed, id: "second", object: secondObject }], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [batchReceipt, secondReceipt], nextCursor: null });
  api.operationUndoBatch.mockResolvedValueOnce({ runId: "run", results: [
    { object, operationIds: ["op"], outcome: { status: "failed", error: { code: "UNDO_CONFLICT", message: "first", retryable: false } } },
    { object: secondObject, operationIds: ["second-op"], outcome: { status: "failed", error: { code: "UNDO_CONFLICT", message: "second", retryable: false } } },
  ], excludedNoChangeIds: [] }).mockResolvedValue({ runId: "run", results: [{ object, operationIds: ["op"], outcome: { status: "succeeded", result: { withdrawn: true } } }], excludedNoChangeIds: [] });
  view(); fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(3));
  const firstRow = screen.getAllByText(/创建记录“候选记录”/)[0].parentElement!;
  fireEvent.click(firstRow.querySelector("button")!);
  await waitFor(() => expect(api.operationUndoBatch).toHaveBeenCalledTimes(2));
  expect(api.operationUndoBatch.mock.calls[1][1].operationIds).toEqual(["op"]);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("does not send a batch after the workspace binding changes during the full read", async () => {
  let settle!: (page: unknown) => void;
  api.outputList.mockResolvedValue({ outputs: [committed], nextCursor: null });
  api.operationList.mockResolvedValueOnce({ operations: [batchReceipt], nextCursor: null })
    .mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const client = new QueryClient();
  const wrap = (generation: string) => <QueryClientProvider client={client}><AgentRunOutputs binding={{ ...binding, generation }} runId="run" /></QueryClientProvider>;
  const rendered = render(wrap("g"));
  fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  rendered.rerender(wrap("new"));
  await act(async () => settle({ operations: [batchReceipt], nextCursor: null }));
  expect(api.operationUndoBatch).not.toHaveBeenCalled();
});

it("stops old-run operation pagination as soon as a pending page resolves", async () => {
  let settle!: (page: unknown) => void;
  api.outputList.mockResolvedValue({ outputs: [committed], nextCursor: null });
  api.operationList.mockResolvedValueOnce({ operations: [batchReceipt], nextCursor: null })
    .mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const client = new QueryClient();
  const wrap = (runId: string) => <QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId={runId} /></QueryClientProvider>;
  const rendered = render(wrap("run"));
  fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  rendered.rerender(wrap("other"));
  await act(async () => settle({ operations: [batchReceipt], nextCursor: "next" }));
  expect(api.operationList.mock.calls.filter(([, input]) => input.runId === "run")).toHaveLength(2);
  expect(api.operationUndoBatch).not.toHaveBeenCalled();
});

it("does not apply a late batch result to a different run", async () => {
  let settle!: (result: unknown) => void;
  api.outputList.mockResolvedValue({ outputs: [committed], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [batchReceipt], nextCursor: null });
  api.operationUndoBatch.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  const client = new QueryClient(); const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrap = (runId: string) => <QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId={runId} /></QueryClientProvider>;
  const rendered = render(wrap("run"));
  fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(api.operationUndoBatch).toHaveBeenCalledOnce());
  rendered.rerender(wrap("another-run"));
  await act(async () => settle({ runId: "run", results: [{ object, operationIds: ["op"], outcome: { status: "succeeded", result: { withdrawn: true } } }], excludedNoChangeIds: [] }));
  expect(invalidate).not.toHaveBeenCalled();
  expect(screen.queryByText(/本次更改：/)).not.toBeInTheDocument();
});

it("blocks a direct confirmed review handle from committing while batch undo is pending", async () => {
  let settle!: (result: unknown) => void;
  const pending = { ...output, id: "pending", ordinal: 1 };
  const approved = { ...pending, reviewDecision: { requestId: "approved", decision: "confirm" as const, decidedAt: "2026-10-08T00:00:00Z" } };
  api.outputList.mockResolvedValueOnce({ outputs: [committed, pending], nextCursor: null })
    .mockResolvedValue({ outputs: [committed, approved], nextCursor: null });
  api.outputReview.mockResolvedValue({ runId: "run", decision: "confirm", outputs: [approved] });
  api.operationList.mockResolvedValue({ operations: [batchReceipt], nextCursor: null });
  api.operationUndoBatch.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  const onReviewChange = vi.fn();
  const client = new QueryClient(); const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current onReviewChange={onReviewChange} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(api.operationUndoBatch).toHaveBeenCalledOnce());
  const handle = onReviewChange.mock.calls.map(call => call[0]).find(value => value?.pending.some((item: { outputId: string }) => item.outputId === "pending"));
  expect(handle).toBeTruthy();
  await act(async () => { await handle.decide("confirm"); });
  expect(api.outputCommit).not.toHaveBeenCalled();
  expect(api.outputReview).toHaveBeenCalledOnce();
  expect(screen.getByText("已确认。")).toBeInTheDocument();
  await act(async () => settle({ runId: "run", results: [{ object, operationIds: ["op"], outcome: { status: "succeeded", result: { withdrawn: true } } }], excludedNoChangeIds: [] }));
  await waitFor(() => expect(invalidate).toHaveBeenCalled());
});

it("fails explicitly when more than 256 selected receipt IDs would be sent", async () => {
  const receipts = Array.from({ length: 257 }, (_, index) => ({ ...batchReceipt, operationId: `op-${index}`, object: { ...object, id: `${index}` } }));
  api.outputList.mockResolvedValue({ outputs: [committed], nextCursor: null });
  api.operationList.mockImplementation(async (_binding, input) => {
    const offset = input.cursor ? Number(input.cursor) : 0;
    return { operations: receipts.slice(offset, offset + 50), nextCursor: offset + 50 < receipts.length ? String(offset + 50) : null };
  });
  view(); fireEvent.click(await screen.findByRole("button", { name: "撤销本次更改" }));
  await waitFor(() => expect(screen.getByText(/超过 256 条操作记录/)).toBeInTheDocument());
  expect(api.operationUndoBatch).not.toHaveBeenCalled();
});

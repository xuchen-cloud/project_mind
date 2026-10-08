import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeOutput } from "../../lib/agent-types";
import { AgentRunOutputs } from "./AgentRunOutputs";
const api = vi.hoisted(() => ({ outputList: vi.fn(), operationList: vi.fn(), outputCommit: vi.fn(), outputDismiss: vi.fn(), outputGet: vi.fn(), operationUndo: vi.fn(), operationGet: vi.fn(), operationRestoreCreated: vi.fn() }));
vi.mock("../../services/agentApi", async importOriginal => ({ ...await importOriginal<typeof import("../../services/agentApi")>(), agentApi: api }));
vi.mock("./AgentOutputCard", () => ({ AgentOutputCard: ({ output, operation, onCommit, onDismiss, onUndo, onRestore }: { output: AgentRuntimeOutput; operation: unknown; onCommit: () => Promise<void>; onDismiss: () => Promise<void>; onUndo: () => Promise<void>; onRestore: () => Promise<void> }) => <article>
  <span>{output.id} · {output.dismissed ? "dismissed" : output.state}</span><button onClick={() => { void onCommit().catch(() => {}); void onCommit().catch(() => {}); }}>保存 {output.id}</button>
  {!output.dismissed ? <button onClick={() => { void onDismiss().catch(() => {}); void onDismiss().catch(() => {}); }}>取消 {output.id}</button> : null}
  {operation ? <><button onClick={() => void onUndo()}>撤销 {output.id}</button><button onClick={() => void onRestore()}>恢复 {output.id}</button></> : null}</article> }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project", projectId: 1 } as const, kind: "record" as const, id: "7" };
const output: AgentRuntimeOutput = { id: "out", runId: "run", ordinal: 0, revision: 1, intent: { intent: "record_create", scope: object.scope, title: "候选记录", markdown: "正文" }, sources: [], sourceChanged: [], dismissed: false, state: "staged", mode: "review", object: null, errorCode: null };
const operation = { operationId: "op", requestId: "output:out:1", kind: "record.create", object, afterRevision: 1, undoState: "available", recovery: { withdrawn: false, withdrawalRevision: null, restoreAvailable: false } };
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current /></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); api.outputList.mockResolvedValue({ outputs: [output], nextCursor: null }); api.operationList.mockResolvedValue({ operations: [], nextCursor: null }); });

it("loads a bounded inline output page automatically and reads more only on request", async () => {
  api.outputList.mockResolvedValueOnce({ outputs: [output], nextCursor: "next" }).mockResolvedValueOnce({ outputs: [{ ...output, id: "next" }], nextCursor: null });
  view(); expect(api.outputList).toHaveBeenCalledOnce(); expect(api.operationList).toHaveBeenCalledOnce();

  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  expect(api.outputList).toHaveBeenCalledWith(binding, { runId: "run", cursor: null, limit: 20 });
  expect(api.operationList).toHaveBeenCalledWith(binding, { runId: "run", limit: 50 });
  expect(api.outputCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await waitFor(() => expect(screen.getByText("next · staged")).toBeInTheDocument());
  expect(api.outputList).toHaveBeenLastCalledWith(binding, { runId: "run", cursor: "next", limit: 20 });
});

it("prevents duplicate UI commit and never rewrites a committed output", async () => {
  let complete!: (value: unknown) => void;
  api.outputCommit.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  view();
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "保存 out" }));
  expect(api.outputCommit).toHaveBeenCalledOnce();
  expect(api.outputCommit).toHaveBeenCalledWith(binding, { outputId: "out", expectedRevision: 1 }, expect.any(String));
  await act(async () => complete({ output: { ...output, state: "committed", object }, receipt: {}, operation }));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "撤销 out" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存 out" }));
  expect(api.outputCommit).toHaveBeenCalledOnce();
});

it("reconciles a failed commit before retry and reuses the same UI request identity", async () => {
  api.outputCommit.mockRejectedValueOnce({ code: "OUTPUT_COMMIT_FAILED" })
    .mockResolvedValueOnce({ output: { ...output, state: "committed", object }, receipt: {}, operation });
  api.outputGet.mockResolvedValue({ ...output, state: "failed", errorCode: "OUTPUT_COMMIT_FAILED" });
  view();
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "保存 out" }));
  await waitFor(() => expect(screen.getByText("out · failed")).toBeInTheDocument());
  expect(api.outputGet).toHaveBeenCalledWith(binding, { outputId: "out" });
  fireEvent.click(screen.getByRole("button", { name: "保存 out" }));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  expect(api.outputCommit).toHaveBeenCalledTimes(2);
  expect(api.outputCommit.mock.calls[0][2]).toBe(api.outputCommit.mock.calls[1][2]);
});

it("refreshes actual receipt recovery after undo and restores using its withdrawal revision", async () => {
  api.outputList.mockResolvedValue({ outputs: [{ ...output, state: "committed", object }], nextCursor: null });
  api.operationList.mockResolvedValue({ operations: [operation], nextCursor: null });
  api.operationUndo.mockResolvedValue({ withdrawn: true, revision: 2 });
  api.operationGet.mockResolvedValue({ ...operation, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } });
  api.operationRestoreCreated.mockResolvedValue({ withdrawn: false, revision: 3 });
  view();
  await waitFor(() => expect(screen.getByRole("button", { name: "撤销 out" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "撤销 out" }));
  await waitFor(() => expect(api.operationGet).toHaveBeenCalledWith(binding, { operationId: "op" }));
  expect(api.operationUndo).toHaveBeenCalledWith(binding, { operationId: "op", expectedHeadRevision: 1 }, expect.any(String));
  fireEvent.click(screen.getByRole("button", { name: "恢复 out" }));
  await waitFor(() => expect(api.operationRestoreCreated).toHaveBeenCalledWith(binding, { creationOperationId: "op", expectedWithdrawalRevision: 2 }, expect.any(String)));
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
  expect(api.outputList).toHaveBeenLastCalledWith({ ...binding, generation: "new" }, { runId: "run", cursor: null, limit: 20 });
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
  fireEvent.click(screen.getByRole("button", { name: "保存 out" }));
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
  fireEvent.click(screen.getByRole("button", { name: "保存 out" }));
  await waitFor(() => expect(screen.getByText("out · committed")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "撤销 out" })).toBeInTheDocument();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["todo-views"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["todos"] });
  api.operationUndo.mockResolvedValue({ withdrawn: true, revision: 2 });
  api.operationGet.mockResolvedValue({ ...todoReceipt, undoState: "undone", recovery: { withdrawn: true, withdrawalRevision: 2, restoreAvailable: true } });
  fireEvent.click(screen.getByRole("button", { name: "撤销 out" }));
  await waitFor(() => expect(api.operationGet).toHaveBeenCalledWith(binding, { operationId: "op" }));
  fireEvent.click(screen.getByRole("button", { name: "恢复 out" }));
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
  await waitFor(() => expect(screen.getByRole("button", { name: "撤销 out" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "撤销 out" }));
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
  fireEvent.click(screen.getByRole("button", { name: "取消 out" }));
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
  fireEvent.click(screen.getByRole("button", { name: "保存 out" }));
  expect(api.outputCommit).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "取消 out" })).not.toBeInTheDocument();
});

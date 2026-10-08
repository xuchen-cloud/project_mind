import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeOutput } from "../../lib/agent-types";
import { AgentRunOutputs } from "./AgentRunOutputs";
const api = vi.hoisted(() => ({ outputList: vi.fn(), operationList: vi.fn(), outputCommit: vi.fn(), outputGet: vi.fn(), operationUndo: vi.fn(), operationGet: vi.fn(), operationRestoreCreated: vi.fn() }));
vi.mock("../../services/agentApi", async importOriginal => ({ ...await importOriginal<typeof import("../../services/agentApi")>(), agentApi: api }));
vi.mock("./AgentOutputCard", () => ({ AgentOutputCard: ({ output, operation, onCommit, onUndo, onRestore }: { output: AgentRuntimeOutput; operation: unknown; onCommit: () => Promise<void>; onUndo: () => Promise<void>; onRestore: () => Promise<void> }) => <article>
  <span>{output.id} · {output.state}</span><button onClick={() => { void onCommit().catch(() => {}); void onCommit().catch(() => {}); }}>保存 {output.id}</button>
  {operation ? <><button onClick={() => void onUndo()}>撤销 {output.id}</button><button onClick={() => void onRestore()}>恢复 {output.id}</button></> : null}</article> }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project", projectId: 1 } as const, kind: "record" as const, id: "7" };
const output: AgentRuntimeOutput = { id: "out", runId: "run", ordinal: 0, revision: 1, intent: { intent: "record_create", scope: object.scope, title: "候选记录", markdown: "正文" }, sources: [], sourceChanged: [], state: "staged", mode: "review", object: null, errorCode: null };
const operation = { operationId: "op", requestId: "output:out:1", kind: "record.create", object, afterRevision: 1, undoState: "available", recovery: { withdrawn: false, withdrawalRevision: null, restoreAvailable: false } };
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AgentRunOutputs binding={binding} runId="run" current /></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); api.outputList.mockResolvedValue({ outputs: [output], nextCursor: null }); api.operationList.mockResolvedValue({ operations: [], nextCursor: null }); });

it("loads bounded output pages only on expansion and does not commit when browsing", async () => {
  api.outputList.mockResolvedValueOnce({ outputs: [output], nextCursor: "next" }).mockResolvedValueOnce({ outputs: [{ ...output, id: "next" }], nextCursor: null });
  view(); expect(api.outputList).not.toHaveBeenCalled(); expect(api.operationList).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "本次运行成果" }));
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  expect(api.outputList).toHaveBeenCalledWith(binding, { runId: "run", cursor: null, limit: 20 });
  expect(api.operationList).toHaveBeenCalledWith(binding, { runId: "run", limit: 50 });
  expect(api.outputCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "更多成果" }));
  await waitFor(() => expect(screen.getByText("next · staged")).toBeInTheDocument());
  expect(api.outputList).toHaveBeenLastCalledWith(binding, { runId: "run", cursor: "next", limit: 20 });
});

it("prevents duplicate UI commit and never rewrites a committed output", async () => {
  let complete!: (value: unknown) => void;
  api.outputCommit.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  view(); fireEvent.click(screen.getByRole("button", { name: "本次运行成果" }));
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
  view(); fireEvent.click(screen.getByRole("button", { name: "本次运行成果" }));
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
  view(); fireEvent.click(screen.getByRole("button", { name: "本次运行成果" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "撤销 out" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "撤销 out" }));
  await waitFor(() => expect(api.operationGet).toHaveBeenCalledWith(binding, { operationId: "op" }));
  expect(api.operationUndo).toHaveBeenCalledWith(binding, { operationId: "op", expectedHeadRevision: 1 }, expect.any(String));
  fireEvent.click(screen.getByRole("button", { name: "恢复 out" }));
  await waitFor(() => expect(api.operationRestoreCreated).toHaveBeenCalledWith(binding, { creationOperationId: "op", expectedWithdrawalRevision: 2 }, expect.any(String)));
});

it("discards an old workspace output response and resets lazy expansion on binding switch", async () => {
  let oldPage!: (value: unknown) => void;
  api.outputList.mockImplementationOnce(() => new Promise(resolve => { oldPage = resolve; }));
  const client = new QueryClient();
  const wrap = (generation: string) => <QueryClientProvider client={client}><AgentRunOutputs binding={{ ...binding, generation }} runId="run" current /></QueryClientProvider>;
  const rendered = render(wrap("g"));
  fireEvent.click(screen.getByRole("button", { name: "本次运行成果" }));
  rendered.rerender(wrap("new"));
  await act(async () => oldPage({ outputs: [{ ...output, id: "old" }], nextCursor: null }));
  expect(screen.queryByText("old · staged")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "本次运行成果" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "本次运行成果" }));
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  expect(api.outputList).toHaveBeenLastCalledWith({ ...binding, generation: "new" }, { runId: "run", cursor: null, limit: 20 });
});

it("does not let an older list response downgrade a committed output", async () => {
  let outdated!: (value: unknown) => void;
  api.outputList.mockResolvedValueOnce({ outputs: [output], nextCursor: null })
    .mockImplementationOnce(() => new Promise(resolve => { outdated = resolve; }));
  api.outputCommit.mockResolvedValue({ output: { ...output, state: "committed", object }, receipt: {}, operation });
  view(); fireEvent.click(screen.getByRole("button", { name: "本次运行成果" }));
  await waitFor(() => expect(screen.getByText("out · staged")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "刷新成果" }));
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
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "本次运行成果" })));
    expect(api.outputList).toHaveBeenCalledTimes(1);
    await act(async () => rendered.rerender(wrapper(false)));
    expect(api.outputList).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(10000));
    expect(api.outputList).toHaveBeenCalledTimes(2);
    expect(api.outputCommit).not.toHaveBeenCalled();
  } finally { rendered.unmount(); vi.useRealTimers(); }
});

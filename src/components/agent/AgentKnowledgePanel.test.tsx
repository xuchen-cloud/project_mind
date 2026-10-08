import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentContextEntry, AgentScope, KnowledgeGetInput } from "../../lib/agent-types";
import { AgentKnowledgePanel } from "./AgentKnowledgePanel";

const mocks = vi.hoisted(() => ({ contextGet: vi.fn(), overviewGet: vi.fn(), knowledgeSearch: vi.fn(), knowledgeGet: vi.fn(), sourceMaintenance: vi.fn() }));
vi.mock("../../services/agentApi", () => ({ agentApi: mocks }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: ({ source }: { source: { title: string } }) => <div>{source.title}</div> }));
const binding = { workspaceId: "w1", generation: "g1" };
const scope: AgentScope = { kind: "project", projectId: 7 };
const coverage = { processed: 3, partial: 1, pending: 2, excluded: 1, unsupported: 0 };
const metadata: AgentContextEntry = { identity: { scope, name: "验收项目", archived: false }, status: "partial", overviewUpdatedAt: "2026-10-08T08:00:00Z",
  positioning: null, coverage, nodes: [], hasMore: false, availableReads: [] };
const progress = { scope, batchId: "batch1", chargedChars: 123, chargedChunks: 2, attemptedJobs: 2, cancelled: false, budgetExhausted: false,
  foregroundBusy: false, pendingJobs: 2, failedJobs: 1, partialSources: 1, backfillComplete: false };
const card = { nodeId: "node:decision-1", title: "范围决策", snippet: "目录摘要", kind: "decision", revision: 3, stale: false, epistemicStatus: "recorded" };
function panel(props: { binding: typeof binding; scope: AgentScope; open?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return { client, view: render(<QueryClientProvider client={client}><AgentKnowledgePanel {...props} /></QueryClientProvider>) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.contextGet.mockResolvedValue(metadata);
  mocks.overviewGet.mockResolvedValue({ scope, revision: 3, sections: [], items: [], stale: false, pendingCount: 2, needsRebuild: false, coverage,
    asOfSeq: 12, correctionRevision: 0, nextCursor: null });
  mocks.knowledgeSearch.mockResolvedValue({ scope, items: [card], nextCursor: null, sourceFallbackRequired: false });
  mocks.sourceMaintenance.mockResolvedValue(progress);
});
afterEach(() => { vi.useRealTimers(); });

it("loads only metadata and bounded directories after the knowledge menu opens", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><AgentKnowledgePanel binding={binding} scope={scope} open={false} /></QueryClientProvider>);
  expect(mocks.contextGet).not.toHaveBeenCalled(); expect(mocks.overviewGet).not.toHaveBeenCalled(); expect(mocks.sourceMaintenance).not.toHaveBeenCalled();
  view.rerender(<QueryClientProvider client={client}><AgentKnowledgePanel binding={binding} scope={scope} /></QueryClientProvider>);
  expect(await screen.findByRole("button", { name: "范围决策" })).toBeVisible();
  expect(mocks.overviewGet).toHaveBeenCalledWith(binding, { scope, sections: [], itemIds: [], budgetChars: 1000 });
  expect(mocks.knowledgeSearch).toHaveBeenCalledWith(binding, { scope, query: "", cursor: null, limit: 10, budgetChars: 2000 });
  expect(mocks.knowledgeGet).not.toHaveBeenCalled();
  expect(screen.getByText("部分覆盖")).toBeVisible();
  expect(screen.getByText(/整理时间：/)).toBeVisible();
  expect(screen.getByText("已处理 3 · 部分 1 · 待处理 2 · 已排除 1 · 不支持 0")).toBeVisible();
});

it("loads selected Knowledge sections and further body pages only on explicit expansion", async () => {
  mocks.knowledgeGet.mockImplementation(async (_binding: unknown, input: KnowledgeGetInput) => ({ scope, nodeId: card.nodeId, revision: 3,
    kind: "decision", title: "范围决策", view: input.view, summary: input.view === "summary" ? "已整理的摘要" : null, summaryOffset: 0,
    sections: input.view === "summary" ? [] : [{ id: "choice", title: "决策依据", text: input.view === "outline" ? null : input.cursor ? "后续片段" : "首个片段", textOffset: input.cursor ? 10 : 0, complete: Boolean(input.cursor) }],
    sourceRefs: [], related: [], coverage, stale: false, epistemicStatus: "recorded", validState: "current",
    nextCursor: input.view === "content" && !input.cursor ? "body-next" : null }));
  panel({ binding, scope });
  fireEvent.click(await screen.findByRole("button", { name: "范围决策" }));
  expect(await screen.findByText("已整理的摘要")).toBeVisible();
  expect(mocks.knowledgeGet.mock.calls.map(([, data]) => data.view)).toEqual(["summary", "outline"]);
  fireEvent.click(await screen.findByRole("button", { name: "查看正文：决策依据" }));
  expect(await screen.findByText("首个片段")).toBeVisible();
  expect(mocks.knowledgeGet).toHaveBeenLastCalledWith(binding, { scope, nodeId: "node:decision-1", version: 3, view: "content", sectionIds: ["choice"], cursor: null, budgetChars: 2000 });
  fireEvent.click(await screen.findByRole("button", { name: "继续读取正文" }));
  expect(await screen.findByText("后续片段")).toBeVisible();
  expect(mocks.knowledgeGet).toHaveBeenLastCalledWith(binding, expect.objectContaining({ cursor: "body-next", sectionIds: ["choice"], budgetChars: 2000 }));
});

it("keeps old metadata responses outside the new Workspace binding", async () => {
  let finish!: (value: AgentContextEntry) => void;
  mocks.contextGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...metadata, status: "not_built", overviewUpdatedAt: null });
  const { client, view } = panel({ binding, scope });
  await waitFor(() => expect(mocks.contextGet).toHaveBeenCalledOnce());
  const nextBinding = { ...binding, generation: "g2" };
  view.rerender(<QueryClientProvider client={client}><AgentKnowledgePanel binding={nextBinding} scope={scope} /></QueryClientProvider>);
  expect(await screen.findByText("尚无整理时间")).toBeVisible();
  await act(async () => { finish(metadata); });
  expect(screen.queryByText(/整理时间：/)).not.toBeInTheDocument();
  expect(mocks.contextGet).toHaveBeenLastCalledWith(nextBinding, { scope, budgetChars: 1000 });
});

it("uses real pause/resume progress and stops polling when the menu closes", async () => {
  vi.useFakeTimers();
  mocks.sourceMaintenance.mockImplementation(async (_binding: unknown, _scope: unknown, action: string | undefined) => ({ ...progress, cancelled: action === "cancel" }));
  const { view } = panel({ binding, scope });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  fireEvent.click(screen.getByRole("button", { name: "暂停资料处理" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole("button", { name: "继续处理资料" })).toBeVisible();
  expect(mocks.sourceMaintenance).toHaveBeenLastCalledWith(binding, scope, "cancel");
  fireEvent.click(screen.getByRole("button", { name: "继续处理资料" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole("button", { name: "暂停资料处理" })).toBeVisible();
  expect(mocks.sourceMaintenance).toHaveBeenLastCalledWith(binding, scope, "resume");
  const calls = mocks.sourceMaintenance.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(mocks.sourceMaintenance.mock.calls.length).toBeGreaterThan(calls);
  view.unmount();
  const closedCalls = mocks.sourceMaintenance.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(mocks.sourceMaintenance).toHaveBeenCalledTimes(closedCalls);
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentContextEntry, AgentScope, KnowledgeGetInput } from "../../lib/agent-types";
import { AgentKnowledgePanel } from "./AgentKnowledgePanel";

const mocks = vi.hoisted(() => ({ contextGet: vi.fn(), overviewGet: vi.fn(), knowledgeSearch: vi.fn(), knowledgeGet: vi.fn(), sourceMaintenance: vi.fn(), overviewMaintenance: vi.fn(), overviewCorrectionsGet: vi.fn(), overviewCorrectionUpsert: vi.fn(), overviewCorrectionDelete: vi.fn() }));
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
  mocks.overviewMaintenance.mockResolvedValue({ scope, cancelled: false, errorCode: null, batchId: null, pendingCount: 2, coverage, deletedCount: 0, directoryComplete: false, budgetExhausted: false, nextRunAt: null, foregroundBusy: false });
  mocks.overviewCorrectionsGet.mockResolvedValue({ scope, revision: 0, items: [] });
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
  expect(mocks.overviewCorrectionsGet).not.toHaveBeenCalled();
  expect(screen.getByText("部分覆盖")).toBeVisible();
  expect(screen.getByText(/整理时间：/)).toBeVisible();
  expect(screen.getByText("已处理 3 · 部分 1 · 待处理 2 · 已排除 1 · 不支持 0")).toBeVisible();
});

it("does not request project-only maintenance or corrections in Workspace knowledge", async () => {
  const workspaceScope: AgentScope = { kind: "workspace" };
  panel({ binding, scope: workspaceScope });
  expect(await screen.findByRole("heading", { name: "工作区知识" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "纠正理解" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "立即整理" })).not.toBeInTheDocument();
  expect(mocks.overviewMaintenance).not.toHaveBeenCalled();
  expect(mocks.overviewCorrectionsGet).not.toHaveBeenCalled();
});

it("reads corrections only when expanded, then saves and deletes with the returned revision", async () => {
  const saved = { id: "correction1", scope, itemId: null, text: "应以本周范围为准", revision: 1, deleted: false, createdAt: "2026-10-08T08:00:00Z", updatedAt: "2026-10-08T08:00:00Z" };
  mocks.overviewCorrectionUpsert.mockResolvedValue({ scope, revision: 1, items: [saved] });
  mocks.overviewCorrectionDelete.mockResolvedValue({ scope, revision: 2, items: [{ ...saved, revision: 2, deleted: true }] });
  panel({ binding, scope });
  expect(mocks.overviewCorrectionsGet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "纠正理解" }));
  expect(await screen.findByText("还没有纠正。")).toBeVisible();
  expect(screen.getByText(/独立于项目速记和记录/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("补充纠正"), { target: { value: saved.text } });
  fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
  await waitFor(() => expect(mocks.overviewCorrectionUpsert).toHaveBeenCalledWith(binding, expect.objectContaining({ scope, itemId: null, text: saved.text, expectedRevision: 0 })));
  expect(await screen.findByText(saved.text)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(mocks.overviewCorrectionDelete).toHaveBeenCalledWith(binding, { scope, id: saved.id, expectedRevision: 1 }));
  expect(await screen.findByText("还没有纠正。")).toBeVisible();
});

it("keeps a correction draft when revision CAS rejects a save", async () => {
  mocks.overviewCorrectionUpsert.mockRejectedValue({ code: "REVISION_CONFLICT", message: "纠正版本已经变化", retryable: false });
  panel({ binding, scope });
  fireEvent.click(screen.getByRole("button", { name: "纠正理解" }));
  const field = await screen.findByLabelText("补充纠正");
  fireEvent.change(field, { target: { value: "请按新范围整理" } });
  fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
  expect(await screen.findByText("纠正版本已经变化")).toBeVisible();
  expect(field).toHaveValue("请按新范围整理");
  fireEvent.click(screen.getByRole("button", { name: "刷新纠正版本" }));
  await waitFor(() => expect(mocks.overviewCorrectionsGet).toHaveBeenCalledTimes(2));
  expect(field).toHaveValue("请按新范围整理");
});

it("keeps knowledge maintenance separate from source extraction and never starts it on open", async () => {
  let cancelled = false;
  mocks.overviewMaintenance.mockImplementation(async (_binding: unknown, _scope: unknown, action: string | null) => {
    if (action === "cancel") cancelled = true;
    if (action === "resume") cancelled = false;
    return { scope, cancelled, errorCode: null, batchId: null, pendingCount: 2, coverage, deletedCount: 0, directoryComplete: false, budgetExhausted: false, nextRunAt: null, foregroundBusy: false };
  });
  panel({ binding, scope });
  expect(await screen.findByRole("button", { name: "立即整理" })).toBeVisible();
  expect(await screen.findByText("整理覆盖：已处理 3 · 部分 1 · 不支持 0 · 待处理 2")).toBeVisible();
  expect(mocks.overviewMaintenance).toHaveBeenCalledWith(binding, scope);
  expect(mocks.overviewMaintenance.mock.calls.every(([, , action]) => action == null)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "立即整理" }));
  await waitFor(() => expect(mocks.overviewMaintenance).toHaveBeenCalledWith(binding, scope, "refresh"));
  fireEvent.click(screen.getByRole("button", { name: "暂停整理" }));
  await waitFor(() => expect(mocks.overviewMaintenance).toHaveBeenCalledWith(binding, scope, "cancel"));
  expect(await screen.findByRole("button", { name: "继续整理" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "继续整理" }));
  await waitFor(() => expect(mocks.overviewMaintenance).toHaveBeenCalledWith(binding, scope, "resume"));
});

it("offers resume after a maintenance error and keeps the actual coverage counts visible", async () => {
  mocks.overviewMaintenance.mockResolvedValue({ scope, cancelled: false, errorCode: "PROFILE_UNAVAILABLE", batchId: "batch1", pendingCount: 2,
    coverage: { processed: 8, partial: 3, excluded: 1, unsupported: 2, pending: 4 }, deletedCount: 1, directoryComplete: true,
    budgetExhausted: false, nextRunAt: null, foregroundBusy: false });
  panel({ binding, scope });
  expect(await screen.findByText("请先配置可用模型。")).toBeVisible();
  expect(screen.getByText("整理覆盖：已处理 8 · 部分 3 · 不支持 2 · 待处理 4")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "继续整理" }));
  await waitFor(() => expect(mocks.overviewMaintenance).toHaveBeenCalledWith(binding, scope, "resume"));
  expect(screen.queryByRole("button", { name: "暂停整理" })).not.toBeInTheDocument();
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

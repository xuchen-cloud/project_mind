import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentMemoryCard, AgentMemoryDetail, AgentMemoryListInput, AgentMemoryUpdateInput } from "../../lib/agent-memory-types";
import type { AgentScope } from "../../lib/agent-types";
import { AgentMemoryPanel } from "./AgentMemoryPanel";

const mocks = vi.hoisted(() => ({ memoryList: vi.fn(), memoryGet: vi.fn(), memoryUpdate: vi.fn() }));
vi.mock("../../services/agentMemoryApi", () => ({ agentMemoryApi: mocks }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: ({ source }: { source: { title: string } }) =>
  <div data-testid="original-source">{source.title}</div> }));
vi.mock("./AgentPublishedSource", () => ({ AgentPublishedSource: ({ source }: { source: { revision: number } }) =>
  <div data-testid="published-source">概览版本 {source.revision}</div> }));

const binding = { workspaceId: "w1", generation: "g1" };
const scope: AgentScope = { kind: "workspace" };
const card: AgentMemoryCard = { nodeId: "node:memory-1", nodeRevision: 5, policyRevision: 3,
  category: "preference", title: "偏好远程协作", oneLine: "通常远程协作", confirmation: "inferred", status: "enabled",
  sourceState: "current", lastSupportedAt: "2026-10-09T08:00:00Z", suppressedBy: [] };
const detail: AgentMemoryDetail = { ...card, summary: "偏好远程协作。", bodySections: [{ id: "body-1", title: "具体习惯", text: "每周异步同步。" }],
  sourceRefs: [{ object: { workspaceId: "w1", scope, kind: "record", id: "12" }, revision: "sha256:raw",
    fileVersion: null, recordVersion: 1, blockId: null, locator: null, title: "原始记录", excerpt: "用户原话" }],
  publishedSources: [{ projectId: 7, revision: 2, itemId: "project-item", digest: "sha256:parent" }] };

function panel(currentScope = scope, currentBinding = binding, open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><AgentMemoryPanel binding={currentBinding} scope={currentScope} open={open} /></QueryClientProvider>);
  return { client, view };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.memoryList.mockResolvedValue({ items: [card], nextCursor: null });
  mocks.memoryGet.mockResolvedValue(detail);
  mocks.memoryUpdate.mockResolvedValue(detail);
});

it("loads bounded cards after opening and reads details and both evidence kinds only when expanded", async () => {
  const { client, view } = panel(scope, binding, false);
  expect(mocks.memoryList).not.toHaveBeenCalled();
  view.rerender(<QueryClientProvider client={client}><AgentMemoryPanel binding={binding} scope={scope} /></QueryClientProvider>);
  expect(await screen.findByRole("button", { name: card.title })).toBeVisible();
  expect(mocks.memoryList).toHaveBeenCalledWith(binding, { scope, cursor: null, limit: 20 });
  expect(mocks.memoryGet).not.toHaveBeenCalled();
  expect(screen.getByText("助手推断")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: card.title }));
  expect(await screen.findByText("每周异步同步。")).toBeVisible();
  expect(mocks.memoryGet).toHaveBeenCalledWith(binding, { scope, nodeId: card.nodeId });
  expect(screen.getByTestId("original-source")).toHaveTextContent("原始记录");
  expect(screen.getByTestId("published-source")).toHaveTextContent("概览版本 2");
});

it("paginates the list and invalidates it after confirming the exact viewed revisions", async () => {
  let current = detail;
  mocks.memoryList.mockImplementation(async (_binding: unknown, input: AgentMemoryListInput) => ({
    items: input.cursor ? [{ ...card, nodeId: "node:memory-2", title: "另一条记忆" }] : [current],
    nextCursor: input.cursor ? null : "next",
  }));
  mocks.memoryGet.mockImplementation(async () => current);
  mocks.memoryUpdate.mockImplementation(async (_binding: unknown, input: AgentMemoryUpdateInput) => {
    current = { ...current, confirmation: "user_confirmed", policyRevision: 4 };
    return current;
  });
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "更多记忆" }));
  expect(await screen.findByRole("button", { name: "另一条记忆" })).toBeVisible();
  expect(mocks.memoryList).toHaveBeenCalledWith(binding, { scope, cursor: "next", limit: 20 });
  fireEvent.click(screen.getByRole("button", { name: card.title }));
  fireEvent.click(await screen.findByRole("button", { name: "确认记忆" }));
  await waitFor(() => expect(mocks.memoryUpdate).toHaveBeenCalledWith(binding, {
    scope, nodeId: card.nodeId, expectedNodeRevision: 5, expectedPolicyRevision: 3, action: "confirm",
  }));
  await waitFor(() => expect(mocks.memoryList.mock.calls.length).toBeGreaterThan(2));
});

it("saves a simple correction with the opened versions and keeps a draft on CAS conflict", async () => {
  mocks.memoryUpdate.mockRejectedValue({ code: "REVISION_CONFLICT", message: "版本已变化" });
  panel();
  fireEvent.click(await screen.findByRole("button", { name: card.title }));
  fireEvent.click(await screen.findByRole("button", { name: "纠正记忆" }));
  fireEvent.change(screen.getByLabelText("记忆正文"), { target: { value: "改为每两周同步。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
  await waitFor(() => expect(mocks.memoryUpdate).toHaveBeenCalledWith(binding, {
    scope, nodeId: card.nodeId, expectedNodeRevision: 5, expectedPolicyRevision: 3, action: "correct",
    correction: { title: card.title, oneLine: card.oneLine, summary: detail.summary,
      bodySections: [{ id: "user-correction", title: "正文", text: "改为每两周同步。" }] },
  }));
  expect(await screen.findByText(/记忆版本已变化/)).toBeVisible();
  expect(screen.getByLabelText("记忆正文")).toHaveValue("改为每两周同步。");
  fireEvent.click(screen.getByRole("button", { name: "刷新记忆版本" }));
  await waitFor(() => expect(mocks.memoryGet).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText("记忆正文")).toHaveValue("改为每两周同步。");
});

it("saves a summary-only memory correction without inventing a body section", async () => {
  const summaryOnly = { ...detail, bodySections: [] };
  mocks.memoryGet.mockResolvedValue(summaryOnly);
  panel();
  fireEvent.click(await screen.findByRole("button", { name: card.title }));
  fireEvent.click(await screen.findByRole("button", { name: "纠正记忆" }));
  expect(screen.getByLabelText("记忆正文")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("记忆摘要"), { target: { value: "已核对的异步同步习惯。" } });
  expect(screen.getByRole("button", { name: "保存纠正" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "保存纠正" }));
  await waitFor(() => expect(mocks.memoryUpdate).toHaveBeenCalledWith(binding, {
    scope, nodeId: card.nodeId, expectedNodeRevision: 5, expectedPolicyRevision: 3, action: "correct",
    correction: { title: card.title, oneLine: card.oneLine, summary: "已核对的异步同步习惯。", bodySections: [] },
  }));
});

it("allows stop and reenable while unavailable, and explains other suppression owners", async () => {
  const unavailable = { ...detail, status: "disabled" as const, sourceState: "unavailable" as const,
    suppressedBy: [{ nodeId: "node:other", title: "另一条已停用记忆" }] };
  mocks.memoryList.mockResolvedValue({ items: [unavailable], nextCursor: null });
  mocks.memoryGet.mockResolvedValue(unavailable);
  panel();
  expect(await screen.findByText("已停用")).toBeVisible();
  expect(screen.getByText("依据不可用")).toBeVisible();
  fireEvent.click(await screen.findByRole("button", { name: card.title }));
  expect(await screen.findByText(/仍受其他停用记忆影响：另一条已停用记忆/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "确认记忆" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "纠正记忆" })).not.toBeInTheDocument();
  expect(screen.getByText(/不会恢复已变化或不可用的来源/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重新启用" }));
  await waitFor(() => expect(mocks.memoryUpdate).toHaveBeenCalledWith(binding, {
    scope, nodeId: card.nodeId, expectedNodeRevision: 5, expectedPolicyRevision: 3, action: "reenable",
  }));
});

it("offers correction for stale evidence but reserves confirmation for current evidence", async () => {
  const stale = { ...detail, sourceState: "stale" as const };
  mocks.memoryList.mockResolvedValue({ items: [stale], nextCursor: null });
  mocks.memoryGet.mockResolvedValue(stale);
  panel();
  fireEvent.click(await screen.findByRole("button", { name: card.title }));
  expect(await screen.findByRole("button", { name: "纠正记忆" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "确认记忆" })).not.toBeInTheDocument();
});

it("isolates delayed details across Workspace binding and scope changes", async () => {
  let finish!: (value: AgentMemoryDetail) => void;
  mocks.memoryGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ...detail, title: "项目记忆", summary: "项目独有理解" });
  const { client, view } = panel();
  fireEvent.click(await screen.findByRole("button", { name: card.title }));
  await waitFor(() => expect(mocks.memoryGet).toHaveBeenCalledTimes(1));
  const nextBinding = { ...binding, generation: "g2" };
  const projectScope: AgentScope = { kind: "project", projectId: 7 };
  mocks.memoryList.mockResolvedValue({ items: [{ ...card, title: "项目记忆" }], nextCursor: null });
  view.rerender(<QueryClientProvider client={client}><AgentMemoryPanel binding={nextBinding} scope={projectScope} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "项目记忆" }));
  expect(await screen.findByText("项目独有理解")).toBeVisible();
  await act(async () => { finish(detail); });
  expect(screen.queryByText(detail.summary)).not.toBeInTheDocument();
  expect(mocks.memoryGet).toHaveBeenLastCalledWith(nextBinding, { scope: projectScope, nodeId: card.nodeId });
});

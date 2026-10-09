import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionSearchMatch, AgentSessionSearchPage, AgentSourceRef } from "../../lib/agent-types";

const mocked = vi.hoisted(() => ({ search: vi.fn(), source: vi.fn() }));
vi.mock("../../services/agentApi", () => ({ agentApi: { sessionSearch: mocked.search } }));
vi.mock("./AgentMessageSource", () => ({ AgentMessageSource: ({ source }: { source: AgentSourceRef }) => {
  mocked.source(source); return <div>原文内容</div>;
} }));
import { AgentHistorySearch } from "./AgentHistorySearch";

const binding = { workspaceId: "workspace", generation: "one" };
const scope = { kind: "project", projectId: 1 } as const;
const match: AgentSessionSearchMatch = {
  sessionId: "session", messageId: "message", runtimeEntryId: "entry", ordinal: 4, role: "assistant",
  createdAt: "2026-10-09T10:00:00Z", contentHash: "sha256:abc", branchLeafId: "leaf", snippet: "讨论摘录", sessionTitle: "阶段会话",
};
const page = (matches: AgentSessionSearchMatch[], complete: boolean, nextCursor: string | null = null): AgentSessionSearchPage => ({
  matches, nextCursor, coverage: { indexedMessages: 20, remainingMessages: complete ? 0 : 10, backfilledThisRequest: 10, pendingSessions: complete ? 0 : 1, complete },
});
const open = vi.fn();
function view(currentBinding = binding, currentScope = scope, busySession = false) {
  return <AgentHistorySearch binding={currentBinding} scope={currentScope} busySession={busySession} onOpenSession={open}>
    <div>现有历史会话列表</div>
  </AgentHistorySearch>;
}
beforeEach(() => { vi.clearAllMocks(); });

it("submits explicitly, replaces partial results after backfill, and pages complete results without duplicates", async () => {
  mocked.search.mockResolvedValueOnce(page([match], false)).mockResolvedValueOnce(page([match], true, "cursor"))
    .mockResolvedValueOnce(page([match, { ...match, messageId: "next", snippet: "下一段" }], true));
  render(view());
  expect(screen.getByText("现有历史会话列表")).toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索历史讨论" }), "讨论");
  expect(mocked.search).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText("讨论摘录");
  expect(mocked.search).toHaveBeenCalledWith(binding, { scope, query: "讨论", afterMessageId: null, limit: 20 });
  expect(screen.getByText("正在整理较早的会话，当前结果可能不完整")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "继续查找" }));
  await screen.findByRole("button", { name: "更多匹配" });
  expect(mocked.search).toHaveBeenNthCalledWith(2, binding, { scope, query: "讨论", afterMessageId: null, limit: 20 });
  await userEvent.click(screen.getByRole("button", { name: "更多匹配" }));
  await screen.findByText("下一段");
  expect(screen.getAllByText("讨论摘录")).toHaveLength(1);
  expect(mocked.search).toHaveBeenNthCalledWith(3, binding, { scope, query: "讨论", afterMessageId: "cursor", limit: 20 });
});

it("opens the exact source without selecting a session and guards busy session switching", async () => {
  mocked.search.mockResolvedValue(page([match], true));
  render(view(binding, scope, true));
  await userEvent.type(screen.getByRole("searchbox"), "讨论{Enter}");
  await screen.findByText("讨论摘录");
  await userEvent.click(screen.getByRole("button", { name: "查看原文" }));
  expect(screen.getByText("原文内容")).toBeInTheDocument();
  expect(mocked.source).toHaveBeenCalledWith({
    object: { workspaceId: "workspace", scope, kind: "session_message", id: "message" },
    revision: "sha256:abc", fileVersion: null, recordVersion: null, blockId: null,
    locator: { kind: "messages", sessionId: "session", branchId: "leaf", startMessageId: "message", endMessageId: "message" },
    title: "阶段会话", excerpt: "讨论摘录",
  });
  expect(screen.getByRole("button", { name: "打开会话" })).toBeDisabled();
  expect(open).not.toHaveBeenCalled();
});

it("discards late responses after a query edit or binding change", async () => {
  let finish!: (value: AgentSessionSearchPage) => void;
  mocked.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(view());
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "旧词" } });
  await userEvent.click(screen.getByRole("button", { name: "搜索" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "新词" } });
  finish(page([match], true));
  await waitFor(() => expect(screen.queryByText("讨论摘录")).not.toBeInTheDocument());
  mocked.search.mockResolvedValueOnce(page([], true));
  await userEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText("暂未找到匹配内容");
  let finishBinding!: (value: AgentSessionSearchPage) => void;
  mocked.search.mockImplementationOnce(() => new Promise(resolve => { finishBinding = resolve; }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "切换前" } });
  await userEvent.click(screen.getByRole("button", { name: "搜索" }));
  rerender(view({ workspaceId: "other", generation: "two" }));
  finishBinding(page([match], true));
  await waitFor(() => expect(screen.queryByText("讨论摘录")).not.toBeInTheDocument());
  expect(screen.getByText("现有历史会话列表")).toBeInTheDocument();
});

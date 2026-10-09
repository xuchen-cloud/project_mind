import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionMessageFragment, AgentSourceRef } from "../../lib/agent-types";
import { AgentMessageSource } from "./AgentMessageSource";

const mocks = vi.hoisted(() => ({ statusGet: vi.fn(), sessionMessagesRead: vi.fn() }));
vi.mock("../../services/agentApi", () => ({ agentApi: mocks, AgentApiError: class AgentApiError extends Error {} }));
const binding = { workspaceId: "w1", generation: "g1" };
const source: AgentSourceRef = {
  object: { workspaceId: "w1", scope: { kind: "project", projectId: 7 }, kind: "session_summary", id: "summary-1" },
  revision: "sha256:cited", fileVersion: null, recordVersion: null, blockId: null,
  locator: { kind: "messages", sessionId: "s1", branchId: "b1", startMessageId: "m1", endMessageId: "m2" },
  title: "讨论摘要", excerpt: "依据片段",
};
const message: AgentSessionMessageFragment = {
  messageId: "m1", runtimeEntryId: "r1", ordinal: 1, role: "user", createdAt: "2026-10-08T10:00:00Z",
  text: "开头", contentHash: "hash", charStart: 0, charEnd: 2, totalChars: 4,
  messageRef: { workspaceId: "w1", scope: source.object.scope, sessionId: "s1", branchId: "b1", messageId: "m1", ordinal: 1, contentHash: "hash" },
};
const cursor = { branchId: "b1", fromMessageId: "m1", toMessageId: "m2", messageId: "m1", charOffset: 2 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.statusGet.mockResolvedValue({ binding });
});

it("reads the exact cited range and appends continuation fragments under one speaker", async () => {
  mocks.sessionMessagesRead.mockResolvedValueOnce({ sessionId: "s1", branchId: "b1", messages: [message], nextCursor: cursor, hasMore: true })
    .mockResolvedValueOnce({ sessionId: "s1", branchId: "b1", messages: [{ ...message, text: "结尾", charStart: 2, charEnd: 4 }], nextCursor: null, hasMore: false });
  render(<AgentMessageSource source={source} binding={binding} />);
  await screen.findByText("开头");
  expect(mocks.sessionMessagesRead).toHaveBeenCalledWith(binding, {
    sessionId: "s1", branchId: "b1", fromMessageId: "m1", toMessageId: "m2", limit: 50, maxChars: 12000,
  });
  fireEvent.click(screen.getByRole("button", { name: "继续查看引用范围" }));
  await screen.findByText("开头结尾");
  expect(screen.getAllByText(/你 ·/)).toHaveLength(1);
  expect(mocks.sessionMessagesRead).toHaveBeenLastCalledWith(binding, {
    sessionId: "s1", branchId: "b1", fromMessageId: "m1", toMessageId: "m2", cursor, limit: 50, maxChars: 12000,
  });
});

it("ignores an old page after the source or binding changes", async () => {
  let settleOld!: (value: unknown) => void;
  mocks.sessionMessagesRead.mockImplementationOnce(() => new Promise(resolve => { settleOld = resolve; }))
    .mockResolvedValueOnce({ sessionId: "s2", branchId: "b2", messages: [{ ...message, messageId: "new", text: "新来源", messageRef: { ...message.messageRef, sessionId: "s2", branchId: "b2", messageId: "new" } }], nextCursor: null, hasMore: false });
  const view = render(<AgentMessageSource source={source} binding={binding} />);
  await waitFor(() => expect(mocks.sessionMessagesRead).toHaveBeenCalledTimes(1));
  const newer = { ...source, locator: { kind: "messages" as const, sessionId: "s2", branchId: "b2", startMessageId: "new", endMessageId: "new" } };
  mocks.statusGet.mockResolvedValue({ binding: { ...binding, generation: "g2" } });
  view.rerender(<AgentMessageSource source={newer} binding={{ ...binding, generation: "g2" }} />);
  settleOld({ sessionId: "s1", branchId: "b1", messages: [message], nextCursor: null, hasMore: false });
  await screen.findByText("新来源");
  expect(screen.queryByText("开头")).not.toBeInTheDocument();
});

it("reports missing binding, missing history and API failures without showing source text as history", async () => {
  const view = render(<AgentMessageSource source={source} />);
  expect(screen.getByRole("alert")).toHaveTextContent("工作区不可用");
  expect(mocks.sessionMessagesRead).not.toHaveBeenCalled();
  mocks.sessionMessagesRead.mockRejectedValueOnce({ code: "NOT_FOUND" });
  view.rerender(<AgentMessageSource source={source} binding={binding} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("已删除或不可用");
  expect(screen.queryByText("依据片段")).not.toBeInTheDocument();
});

it("does not display a page when the workspace binding changes during the read", async () => {
  mocks.statusGet.mockResolvedValueOnce({ binding }).mockResolvedValueOnce({ binding: { ...binding, generation: "g2" } });
  mocks.sessionMessagesRead.mockResolvedValue({ sessionId: "s1", branchId: "b1", messages: [message], nextCursor: null, hasMore: false });
  render(<AgentMessageSource source={source} binding={binding} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(screen.queryByText("开头")).not.toBeInTheDocument();
});

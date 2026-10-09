import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentConversationMessage, AgentSourceRef } from "../../lib/agent-types";
import { AgentPiMessages } from "./AgentPiMessages";
import { StreamingMessageContainer } from "./pi-ui/StreamingMessageContainer";
import type { PiAssistantMessage } from "./pi-ui/types";
const mocks = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { openExternalUrl: mocks.open } }));
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: ({ source, binding }: { source: AgentSourceRef; binding: { generation: string } }) => <div data-testid={`source-${source.object.id}`} data-generation={binding.generation}>{source.title}</div> }));
const binding = { workspaceId: "w", generation: "g" };
const base: AgentConversationMessage = { id: "base", sessionId: "session", runId: "run1", runtimeEntryId: "entry", role: "assistant", content: "", ordinal: 1, createdAt: "now" };
const source: AgentSourceRef = { object: { workspaceId: "w", scope: { kind: "project", projectId: 1 }, kind: "record", id: "42" }, revision: "sha256:a", fileVersion: null, recordVersion: null, blockId: null, locator: null, title: "实际来源", excerpt: "依据" };
const assistant: AgentConversationMessage = { ...base, id: "assistant-call", content: [{ type: "text", text: "## 核对结论" }, { type: "toolCall", id: "actual-call-1", name: "mind_source_read", arguments: { objectId: "42" } }] };
const result: AgentConversationMessage = { ...base, id: "actual-result", role: "tool", toolCallId: "actual-call-1", toolName: "mind_source_read", content: [{ type: "text", text: JSON.stringify({ text: "工具原文", sources: [source] }) }] };
afterEach(() => { vi.unstubAllGlobals(); mocks.open.mockClear(); });

it("runs the adapted official list and paired tool components with closed sources at the actual result", async () => {
  const { container } = render(<AgentPiMessages binding={binding} messages={[{ ...base, id: "u", role: "user", content: "请核对" }, assistant, result]} />);
  expect(await screen.findByRole("heading", { name: "核对结论" })).toBeInTheDocument();
  expect(container.querySelectorAll("pm-pi-tool-message")).toHaveLength(1);
  expect(container.querySelector("pm-pi-orphan-tool-result")).toBeNull();
  const card = await screen.findByTestId("source-42");
  expect(card.closest("[data-pi-source-message]")).toHaveAttribute("data-pi-source-message", "actual-result");
  expect(card.closest(".pi-message-turn")).toHaveAttribute("data-pi-run-id", "run1");
  expect(card.closest("details")).not.toHaveAttribute("open");
  expect(card.closest("pm-pi-tool-message")?.querySelector("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("参考来源（1）"));
  expect(card).toBeVisible();
  expect(card.closest("pm-pi-tool-message")?.querySelector("details")).not.toHaveAttribute("open");
  expect(container.querySelector(".pi-tool-text")).not.toBeVisible();
  fireEvent.click(screen.getByText("读取来源完成"));
  expect(container.querySelector(".pi-tool-text")?.textContent).toContain('"objectId": "42"');
});

it("shows a paginated orphan's real result/error and source without manufacturing a tool call", async () => {
  const { container } = render(<AgentPiMessages binding={binding} messages={[{ ...result, isError: true }]} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("读取来源失败");
  expect(container.querySelector("pm-pi-tool-message")).toBeNull();
  expect(container.querySelectorAll("pm-pi-orphan-tool-result")).toHaveLength(1);
  expect(await screen.findByTestId("source-42")).toBeInTheDocument();
  expect(container.querySelector("pre")?.textContent).toContain("工具原文");
  expect(container.querySelector("details")).not.toHaveAttribute("open");
});

it.each([
  ["mind_session_search", "查找历史讨论"],
  ["mind_session_messages_read", "回读历史讨论"],
])("shows the historical discussion label for %s", async (toolName, label) => {
  const callId = `call-${toolName}`;
  const call: AgentConversationMessage = { ...assistant, id: `assistant-${toolName}`,
    content: [{ type: "toolCall", id: callId, name: toolName, arguments: {} }] };
  const toolResult: AgentConversationMessage = { ...result, id: `result-${toolName}`,
    toolCallId: callId, toolName, content: [{ type: "text", text: "{}" }] };
  render(<AgentPiMessages binding={binding} messages={[call, toolResult]} />);
  expect(await screen.findByText(`${label}完成`)).toBeInTheDocument();
});

it("preserves all historical user text blocks and full long assistant text through the safe Markdown leaf", async () => {
  const long = "正文".repeat(8000) + "历史最后一句";
  const { container } = render(<AgentPiMessages binding={binding} messages={[{ ...base, id: "u", role: "user", content: [{ type: "text", text: "第一块" }, { type: "text", text: "第二块" }] }, { ...base, id: "long", content: long }]} />);
  await waitFor(() => expect(container.textContent).toContain("历史最后一句"));
  expect(container.querySelector("pm-pi-user-message")?.textContent).toContain("第一块");
  expect(container.querySelector("pm-pi-user-message")?.textContent).toContain("第二块");
  expect(container.querySelector("pm-pi-assistant-message")?.textContent).toContain(long);
});

it("keeps raw HTML and images inert and allows only HTTP(S) desktop link clicks inside real Pi components", async () => {
  const { container } = render(<AgentPiMessages binding={binding} messages={[{ ...base, content: '<img src="https://remote.test/x" onerror="evil()">\n\n![示例](https://remote.test/image.png)\n\n[脚本](javascript:evil())\n\n[资料](https://example.test/)' }]} />);
  const link = await screen.findByRole("link", { name: "资料" });
  expect(container.querySelector("img,script,iframe,[src],[onerror]")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(mocks.open).not.toHaveBeenCalled();
  fireEvent.click(link);
  await waitFor(() => expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://example.test/"));
});

it("renders same-ID persisted/stream overlap once and pairs streamed calls with persisted results and sources", async () => {
  const { container } = render(<AgentPiMessages binding={binding} messages={[assistant, result]} streamMessage={assistant} isStreaming streamRunId="run1" />);
  await screen.findByRole("heading", { name: "核对结论" });
  expect(screen.getAllByRole("heading", { name: "核对结论" })).toHaveLength(1);
  expect(container.querySelectorAll("pm-pi-tool-message")).toHaveLength(1);
  expect(container.querySelector("pm-pi-orphan-tool-result")).toBeNull();
  const card = await screen.findByTestId("source-42");
  expect(card.closest("pm-pi-stream")).not.toBeNull();
  expect(container.querySelector("pm-pi-tool-message")?.textContent).toContain("工具原文");
});

it("places each run's controls once and puts preparing/null-run stream after history with its pending seam", async () => {
  const { container } = render(<AgentPiMessages binding={binding} messages={[{ ...base, id: "old-null", runId: null, content: "旧无运行消息" }, { ...base, id: "run2", runId: "run2", content: "第二轮" }]} isStreaming streamRunId={null} liveText="最新流式回复" renderBeforeStream={() => <p>待发送提示</p>} renderAfterRun={id => <p data-control={id ?? "null"}>运行控件 {id ?? "null"}</p>} />);
  await screen.findByText("最新流式回复");
  const turns = container.querySelectorAll(".pi-message-turn");
  expect(turns).toHaveLength(3);
  expect(turns[2].textContent).toMatch(/待发送提示\s*最新流式回复/u);
  expect(container.querySelectorAll('[data-control="null"]')).toHaveLength(1);
  expect(turns[0].textContent).not.toContain("最新流式回复");
  expect(container.querySelectorAll('[data-control="run2"]')).toHaveLength(1);
});

it("marks an aborted unmatched call stopped/incomplete without creating an error result", async () => {
  const { container } = render(<AgentPiMessages binding={binding} messages={[{ ...assistant, stopReason: "aborted" }]} />);
  expect(await screen.findByText("读取来源已停止，未完成")).toBeInTheDocument();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("[data-pi-source-message]")).toBeNull();
  expect(container.querySelector("pm-pi-tool-message")?.textContent).not.toContain("失败");
});

it("drops old source portals on generation switch and binds the new result to the new generation", async () => {
  const view = render(<AgentPiMessages binding={binding} messages={[result]} />);
  await screen.findByTestId("source-42");
  view.rerender(<AgentPiMessages binding={{ ...binding, generation: "next" }} messages={[]} />);
  await waitFor(() => expect(screen.queryByTestId("source-42")).not.toBeInTheDocument());
  view.rerender(<AgentPiMessages binding={{ ...binding, generation: "next" }} messages={[result]} />);
  expect(await screen.findByTestId("source-42")).toHaveAttribute("data-generation", "next");
});

it("keeps two runs' real sources in their own tool slots and emits each run seam once", async () => {
  const secondSource = { ...source, object: { ...source.object, id: "43" }, title: "第二轮来源" };
  const secondAssistant: AgentConversationMessage = { ...assistant, id: "second-call", runId: "run2", content: [{ type: "toolCall", id: "actual-call-2", name: "mind_file_source_read", arguments: { versionNumber: 3 } }] };
  const secondResult: AgentConversationMessage = { ...result, id: "second-result", runId: "run2", toolCallId: "actual-call-2", toolName: "mind_file_source_read", content: [{ type: "text", text: JSON.stringify({ sources: [secondSource] }) }] };
  const { container } = render(<AgentPiMessages binding={binding} messages={[assistant, result, secondAssistant, secondResult]} renderAfterRun={runId => <p data-run-control={runId}>原位成果</p>} />);
  const first = await screen.findByTestId("source-42"), second = await screen.findByTestId("source-43");
  expect(first.closest(".pi-message-turn")).toHaveAttribute("data-pi-run-id", "run1");
  expect(second.closest(".pi-message-turn")).toHaveAttribute("data-pi-run-id", "run2");
  expect(second.closest("[data-pi-source-message]")).toHaveAttribute("data-pi-source-message", "second-result");
  expect(second.closest("pm-pi-tool-message")?.textContent).toContain("读取文件原文完成");
  expect(container.querySelectorAll('[data-run-control="run1"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-run-control="run2"]')).toHaveLength(1);
});

function animationQueue() {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  return { frames, async flush() { await act(async () => { const queued = [...frames]; frames.clear(); queued.forEach(([, callback]) => callback(0)); }); } };
}
const streamingText = (text: string): PiAssistantMessage => ({ id: "stream", role: "assistant", content: [{ type: "text", text }] });
it.each(["immediate", "clear", "clear-pending"] as const)("applies the first normal streaming update after %s and retains one-frame batching", async sequence => {
  const queue = animationQueue(), element = new StreamingMessageContainer();
  document.body.append(element);
  try {
    await act(async () => {
      if (sequence === "immediate") element.setMessage(streamingText("立即回复"), true);
      if (sequence === "clear-pending") element.setMessage(streamingText("应被清除"));
      if (sequence !== "immediate") element.setMessage(null);
      element.setMessage(streamingText("第一段"));
      element.setMessage(streamingText("完整回复"));
    });
    expect(queue.frames.size).toBe(1);
    await queue.flush();
    await waitFor(() => expect(element.textContent).toContain("完整回复"));
    expect(element.textContent).not.toContain("应被清除");
  } finally { await act(async () => { element.remove(); await Promise.resolve(); }); }
});

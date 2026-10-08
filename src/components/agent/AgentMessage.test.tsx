import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversationMessage, AgentSourceRef } from "../../lib/agent-types";
vi.mock("./AgentSourceCard", () => ({ AgentSourceCard: () => <div>引用来源</div> }));
import { AgentMessage, agentContentText, agentMessageSources } from "./AgentMessage";
const binding = { workspaceId: "workspace", generation: "generation" };
const source: AgentSourceRef = { object: { workspaceId: "workspace", scope: { kind: "project", projectId: 1 }, kind: "record", id: "1" }, revision: "1", fileVersion: null, recordVersion: null, blockId: "block", locator: null, title: "真实记录", excerpt: "原文片段" };
const message: AgentConversationMessage = { id: "message", sessionId: "session", runId: "run", runtimeEntryId: "entry", role: "assistant", ordinal: 0, createdAt: "now", content: [] };
describe("agent message projections", () => {
  it("renders tool objects as inspectable JSON and collects structured tool sources", () => {
    const payload = { result: "工具结果", sources: [source] };
    render(<AgentMessage binding={binding} message={{ ...message, role: "tool", content: [{ type: "text", text: JSON.stringify(payload) }] }} />);
    fireEvent.click(screen.getByText("查看读取结果"));
    expect(document.querySelector("pre")?.textContent).toContain('"result":"工具结果"');
    expect(document.body.textContent).not.toContain("[object Object]");
    expect(screen.getByText("引用来源")).toBeInTheDocument();
    expect(agentMessageSources({ refs: [source, source] })).toEqual([source]);
  });
  it("keeps generated HTML as text and truncates large display chunks explicitly", () => {
    const content = "<script>evil()</script>" + "字".repeat(13000);
    render(<AgentMessage binding={binding} message={{ ...message, content }} />);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector(".agent-message__text")?.textContent).toHaveLength(12000);
    fireEvent.click(screen.getByRole("button", { name: "显示更多内容" }));
    expect(document.querySelector(".agent-message__text")?.textContent).toBe(content);
  });
  it("extracts text blocks without rendering tool-call arguments", () => {
    expect(agentContentText([{ type: "text", text: "回答" }, { type: "toolCall", name: "source.read", arguments: { secret: "hidden" } }, { type: "image" }])).toBe("回答\n[图片]");
    expect(agentContentText({ result: "可读" })).toContain('"result": "可读"');
    expect(agentMessageSources("普通正文")).toEqual([]);
    expect(agentMessageSources([{ type: "text", text: JSON.stringify({ text: JSON.stringify({ sourceRef: source }) }) }])).toEqual([]);
  });
});

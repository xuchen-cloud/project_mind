import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentConversationMessage, AgentJsonValue, AgentWorkspaceBinding } from "../../lib/agent-types";
import { agentMessageSources } from "./AgentMessage";
import { AgentSourceCard } from "./AgentSourceCard";
import type { MessageList } from "./pi-ui/MessageList";
import "./pi-ui/MessageList";
import type { StreamingMessageContainer } from "./pi-ui/StreamingMessageContainer";
import "./pi-ui/StreamingMessageContainer";
import type { PiContent, PiMessage, PiToolResultMessage } from "./pi-ui/types";
import "./pi-ui/pi-message-view.css";

export interface AgentPiMessagesProps {
  messages: AgentConversationMessage[];
  binding: AgentWorkspaceBinding;
  liveText?: string;
  isStreaming?: boolean;
  streamRunId?: string | null;
  streamMessage?: AgentConversationMessage | null;
  renderBeforeStream?: () => ReactNode;
  renderAfterRun?: (runId: string | null) => ReactNode;
}
function contentBlocks(content: AgentJsonValue): PiContent[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((value): PiContent => {
    if (typeof value === "string") return { type: "text", text: value };
    if (value && !Array.isArray(value) && typeof value === "object") {
      if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
      if (value.type === "thinking" && typeof value.thinking === "string") return { type: "thinking", thinking: value.thinking };
      if (value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string") return { type: "toolCall", id: value.id, name: value.name, arguments: value.arguments ?? null };
      if (value.type === "image") return { type: "text", text: "[图片，未自动加载]" };
    }
    return { type: "text", text: value === null ? "" : JSON.stringify(value, null, 2) };
  });
}
function toPiMessage(message: AgentConversationMessage): PiMessage {
  const content = contentBlocks(message.content);
  if (message.role === "tool") return { id: message.id, role: "toolResult", content, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError ?? false };
  if (message.role === "user") return { id: message.id, role: "user", content };
  return { id: message.id, role: "assistant", content, stopReason: message.stopReason };
}

function PiTurn({ messages, stream, active, beforeStream, showLive = false }: { messages: AgentConversationMessage[]; stream?: PiMessage | null; active: boolean; beforeStream?: ReactNode; showLive?: boolean }) {
  const list = useRef<MessageList | null>(null), live = useRef<StreamingMessageContainer | null>(null);
  const mapped = useMemo(() => messages.filter(message => !stream || message.id !== stream.id).map(toPiMessage), [messages, active, stream]);
  useEffect(() => {
    list.current!.messages = mapped;
    list.current!.isStreaming = active;
    const pending = new Set(stream?.role === "assistant" ? stream.content.filter(chunk => chunk.type === "toolCall").map(chunk => chunk.id) : []);
    list.current!.pendingToolCalls = pending;
    list.current!.externalCallIds = pending;
    if (live.current) {
      live.current.isStreaming = active;
      live.current.pendingToolCalls = pending;
      live.current.toolResultsById = new Map(mapped.filter((message): message is PiToolResultMessage => message.role === "toolResult" && !!message.toolCallId).map(message => [message.toolCallId!, message]));
      live.current.setMessage(stream ?? null);
    }
  }, [mapped, active, stream]);
  useEffect(() => { const element = live.current; return () => element?.setMessage(null, true); }, []);
  return <>{createElement("pm-pi-message-list", { ref: list })}{showLive ? beforeStream : null}{showLive ? createElement("pm-pi-stream", { ref: live }) : null}</>;
}
function PiMessagesBody(props: AgentPiMessagesProps) {
  const { messages, binding, liveText = "", isStreaming = false, streamMessage, renderAfterRun, renderBeforeStream } = props;
  const root = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<Array<{ id: string; element: Element }>>([]);
  const stream = useMemo<PiMessage | null>(() => streamMessage ? toPiMessage(streamMessage) : liveText ? { id: "current-stream-display", role: "assistant", content: [{ type: "text", text: liveText }] } : null, [streamMessage, liveText]);
  const streamRunId = streamMessage?.runId ?? props.streamRunId ?? null;
  const showStream = isStreaming || !!stream;
  const groups = useMemo(() => {
    const result: Array<{ key: string; runId: string | null; messages: AgentConversationMessage[] }> = [];
    for (const message of messages) {
      const previous = result[result.length - 1];
      if (previous && previous.runId === message.runId) previous.messages.push(message);
      else result.push({ key: message.id, runId: message.runId, messages: [message] });
    }
    return result;
  }, [messages]);
  const streamGroup = showStream && streamRunId !== null ? groups.map(group => group.runId).lastIndexOf(streamRunId) : -1;
  const sources = useMemo(() => new Map(messages.filter(message => message.role === "tool").map(message => [message.id, agentMessageSources(message.content)])), [messages]);
  useEffect(() => {
    const host = root.current!;
    const collect = () => {
      const next = Array.from(host.querySelectorAll("[data-pi-source-message]")).map(element => ({ id: element.getAttribute("data-pi-source-message")!, element })).filter(slot => sources.get(slot.id)?.length);
      setSlots(previous => previous.length === next.length && previous.every((slot, index) => slot.id === next[index].id && slot.element === next[index].element) ? previous : next);
    };
    const observer = new MutationObserver(collect);
    observer.observe(host, { childList: true, subtree: true });
    collect();
    return () => observer.disconnect();
  }, [sources]);
  return <div ref={root} className="pi-message-view">
    {groups.map((group, index) => {
      const hasStream = index === streamGroup;
      const lastForRun = groups.map(item => item.runId).lastIndexOf(group.runId) === index;
      return <section className="pi-message-turn" key={group.key} data-pi-run-id={group.runId ?? ""}>
        <PiTurn messages={group.messages} active={hasStream && isStreaming} showLive={hasStream} stream={hasStream ? stream : undefined} beforeStream={hasStream ? renderBeforeStream?.() : undefined} />
        {lastForRun && group.runId !== null ? renderAfterRun?.(group.runId) : null}
      </section>;
    })}
    {showStream && streamGroup === -1 ? <section className="pi-message-turn" data-pi-run-id={streamRunId ?? ""}>
      <PiTurn messages={[]} stream={stream} active={isStreaming} showLive beforeStream={renderBeforeStream?.()} />{renderAfterRun?.(streamRunId)}
    </section> : null}
    {slots.filter(slot => sources.has(slot.id)).map(slot => createPortal(<details className="pi-tool-sources"><summary>参考来源（{sources.get(slot.id)!.length}）</summary>{sources.get(slot.id)!.map(source => <AgentSourceCard key={JSON.stringify([source.object, source.revision, source.locator])} source={source} binding={binding} />)}</details>, slot.element, slot.id))}
  </div>;
}
/** Official Pi display logic, adapted to the existing native conversation DTO and React controls. */
export function AgentPiMessages(props: AgentPiMessagesProps) {
  return <PiMessagesBody key={`${props.binding.workspaceId}:${props.binding.generation}`} {...props} />;
}

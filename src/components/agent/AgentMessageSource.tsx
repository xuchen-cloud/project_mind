import { useEffect, useRef, useState } from "react";
import type { AgentSessionMessageFragment, AgentSessionMessagesReadCursor, AgentSourceRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import { agentApi } from "../../services/agentApi";
import { Button } from "../../ui/components";
import { agentFailureMessage } from "../../lib/agent-errors";

interface MessageView extends AgentSessionMessageFragment { parts: Array<{ start: number; end: number; text: string }> }

function appendFragments(current: MessageView[], fragments: AgentSessionMessageFragment[]): MessageView[] {
  const next = current.map(message => ({ ...message, parts: [...message.parts] }));
  for (const fragment of fragments) {
    let message = next.find(item => item.messageId === fragment.messageId);
    if (!message) {
      message = { ...fragment, parts: [] };
      next.push(message);
    }
    if (!message.parts.some(part => part.start === fragment.charStart && part.end === fragment.charEnd)) {
      message.parts.push({ start: fragment.charStart, end: fragment.charEnd, text: fragment.text });
      message.parts.sort((a, b) => a.start - b.start);
    }
  }
  return next.sort((a, b) => a.ordinal - b.ordinal);
}

function visibleText(message: MessageView): string {
  let end = 0;
  let result = "";
  for (const part of message.parts) {
    if (part.end <= end) continue;
    const overlap = Math.max(0, end - part.start);
    result += Array.from(part.text).slice(overlap).join("");
    end = part.end;
  }
  return result;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AgentMessageSource({ source, binding }: { source: AgentSourceRef; binding?: AgentWorkspaceBinding }) {
  const locator = source.locator;
  const identity = JSON.stringify([source.object, locator, binding]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [cursor, setCursor] = useState<AgentSessionMessagesReadCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const version = ++sequence.current;
    busyRef.current = false;
    setMessages([]); setCursor(null); setHasMore(false); setError(null);
    if (!binding) { setError("当前工作区不可用，无法查看原始讨论。"); return () => { sequence.current++; }; }
    if (locator?.kind !== "messages") { setError("此引用没有可用的消息范围。"); return () => { sequence.current++; }; }
    void read(null, version);
    return () => { sequence.current++; };
    // A new source range or binding invalidates every in-flight page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  async function read(nextCursor: AgentSessionMessagesReadCursor | null, version = sequence.current) {
    if (busyRef.current || !binding || locator?.kind !== "messages") return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const current = (await agentApi.statusGet()).binding;
      if (version !== sequence.current) return;
      if (!current || current.workspaceId !== binding.workspaceId || current.generation !== binding.generation
        || current.workspaceId !== source.object.workspaceId) throw new Error("工作区已切换，无法查看此引用。");
      const page = await agentApi.sessionMessagesRead(binding, {
        sessionId: locator.sessionId, branchId: locator.branchId,
        fromMessageId: locator.startMessageId, toMessageId: locator.endMessageId,
        ...(nextCursor ? { cursor: nextCursor } : {}), limit: 50, maxChars: 12000,
      });
      if (version !== sequence.current) return;
      const selected = (await agentApi.statusGet()).binding;
      if (version !== sequence.current) return;
      if (!selected || selected.workspaceId !== binding.workspaceId || selected.generation !== binding.generation) throw new Error("工作区已切换，未显示旧来源。");
      setMessages(previous => appendFragments(previous, page.messages));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      if (!page.messages.length && !nextCursor && !page.hasMore) setError("引用的原始讨论已删除或不可用。");
    } catch (failure) {
      if (version === sequence.current) {
        const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null;
        setError(code === "NOT_FOUND" ? "引用的原始讨论已删除或不可用。" : agentFailureMessage(failure));
      }
    } finally {
      if (version === sequence.current) { busyRef.current = false; setBusy(false); }
    }
  }

  return <section aria-label="引用的原始讨论" className="agent-message-source mt-3 rounded-lg border border-border p-3">
    <p className="text-ui font-medium text-text">引用的原始讨论</p>
    {messages.map(message => <article key={message.messageId} className="agent-message-source__entry mt-3">
      <div className="text-caption text-text-muted">{message.role === "user" ? "你" : "助手"} · <time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time></div>
      <p className="mt-1 whitespace-pre-wrap break-words text-body text-text">{visibleText(message)}</p>
      {message.parts[message.parts.length - 1]?.end !== message.totalChars && <p className="text-caption text-text-muted">消息未完，继续加载可查看后续内容</p>}
    </article>)}
    {busy && <p className="mt-2 text-caption text-text-muted">正在读取原始讨论…</p>}
    {error && <p role="alert" className="mt-2 text-caption text-danger">{error}</p>}
    {hasMore && cursor && <Button variant="ghost" size="sm" className="mt-2" disabled={busy} onClick={() => void read(cursor)}>继续查看引用范围</Button>}
  </section>;
}

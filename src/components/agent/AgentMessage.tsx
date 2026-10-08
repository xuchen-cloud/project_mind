import { useState } from "react";
import type { AgentConversationMessage, AgentJsonValue, AgentSourceRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import { Button } from "../../ui/components";
// Shared cards validate actual object ownership and resolve the requested version.
import { AgentSourceCard } from "./AgentSourceCard";

/** Pi content blocks remain text; generated HTML is never mounted into the page. */
export function agentContentText(content: AgentJsonValue): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  if (Array.isArray(content)) return content.map(agentContentText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.type === "image") return "[图片]";
    if (content.type === "toolCall") return "";
    return JSON.stringify(content, null, 2);
  }
  return String(content);
}
function sourceRef(value: unknown): value is AgentSourceRef {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<AgentSourceRef>;
  return !!source.object && typeof source.object.workspaceId === "string"
    && typeof source.object.id === "string" && !!source.object.scope
    && (source.object.scope.kind === "workspace" || (source.object.scope.kind === "project" && Number.isSafeInteger(source.object.scope.projectId) && source.object.scope.projectId > 0))
    && typeof source.object.kind === "string" && typeof source.revision === "string"
    && typeof source.title === "string" && typeof source.excerpt === "string";
}
/** Only structured references returned by tools produce source cards. */
export function agentMessageSources(content: AgentJsonValue): AgentSourceRef[] {
  const sources: AgentSourceRef[] = [];
  const seen = new Set<string>();
  let inspected = 0;
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || sources.length >= 20 || ++inspected > 2000) return;
    if (sourceRef(value)) {
      const key = JSON.stringify([value.object, value.revision, value.fileVersion, value.recordVersion, value.blockId, value.locator]);
      if (!seen.has(key)) { sources.push(value); seen.add(key); }
      return;
    }
    // Quoted source bodies remain text even when they happen to contain JSON.
    if (typeof value === "string") return;
    if (Array.isArray(value)) { value.forEach(child => visit(child, depth + 1)); return; }
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  };
  const parseToolEnvelope = (value: AgentJsonValue): unknown => {
    const text = typeof value === "string" ? value
      : value && !Array.isArray(value) && typeof value === "object" && value.type === "text" && typeof value.text === "string" ? value.text : null;
    if (text !== null && text.length <= 65536 && /^[\[{]/u.test(text.trim())) {
      try { return JSON.parse(text); } catch { return null; }
    }
    return text === null ? value : null;
  };
  if (Array.isArray(content)) content.forEach(block => visit(parseToolEnvelope(block), 0));
  else visit(parseToolEnvelope(content), 0);
  return sources;
}

export function AgentMessage({ message, binding }: { message: AgentConversationMessage; binding: AgentWorkspaceBinding }) {
  const [shown, setShown] = useState(12000);
  const text = agentContentText(message.content);
  const label = message.role === "user" ? "你" : message.role === "assistant" ? "助手" : message.isError ? "工具调用失败" : "工具调用完成";
  const sources = message.role === "tool" ? agentMessageSources(message.content) : [];
  if (message.role === "assistant" && !text.trim()) return null;
  return <article className={`agent-message agent-message--${message.role}`}>
    <div className="agent-message__label">{label}</div>
    {message.role === "tool" ? <details>
      <summary>{message.isError ? "查看调用错误" : "查看工具结果"}</summary>
      <pre className="agent-message__text">{text.slice(0, shown)}</pre>
      {shown < text.length ? <Button size="sm" variant="ghost" onClick={() => setShown(count => count + 12000)}>显示更多内容</Button> : null}
      {sources.length ? <details><summary>参考来源（{sources.length}）</summary>
        {sources.map(source => <AgentSourceCard key={JSON.stringify([source.object, source.revision, source.locator])} source={source} binding={binding} />)}
      </details> : null}
    </details> : <>
      <p className="agent-message__text">{text.slice(0, shown)}</p>
      {shown < text.length ? <Button size="sm" variant="ghost" onClick={() => setShown(count => count + 12000)}>显示更多内容</Button> : null}
    </>}
  </article>;
}

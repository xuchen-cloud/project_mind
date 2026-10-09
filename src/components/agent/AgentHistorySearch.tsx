import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AgentScope, AgentSessionSearchMatch, AgentSessionSearchPage, AgentSourceRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import { agentApi } from "../../services/agentApi";
import { Button } from "../../ui/components";
import { AgentMessageSource } from "./AgentMessageSource";
import { agentFailureMessage } from "./useAgentConversation";

function sourceForMatch(match: AgentSessionSearchMatch, binding: AgentWorkspaceBinding, scope: AgentScope): AgentSourceRef {
  return {
    object: { workspaceId: binding.workspaceId, scope, kind: "session_message", id: match.messageId },
    revision: match.contentHash, fileVersion: null, recordVersion: null, blockId: null,
    locator: { kind: "messages", sessionId: match.sessionId, branchId: match.branchLeafId,
      startMessageId: match.messageId, endMessageId: match.messageId },
    title: match.sessionTitle, excerpt: match.snippet,
  };
}

function uniqueMatches(matches: AgentSessionSearchMatch[]): AgentSessionSearchMatch[] {
  const seen = new Set<string>();
  return matches.filter(match => {
    const key = `${match.sessionId}:${match.messageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function AgentHistorySearch({ binding, scope, busySession, onOpenSession, children }: {
  binding: AgentWorkspaceBinding | null;
  scope: AgentScope;
  busySession: boolean;
  onOpenSession: (id: string) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [matches, setMatches] = useState<AgentSessionSearchMatch[]>([]);
  const [page, setPage] = useState<AgentSessionSearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sequence = useRef(0);
  const inputId = useId();
  const identity = JSON.stringify([binding, scope]);

  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => {
    ++sequence.current;
    setQuery(""); setActiveQuery(""); setMatches([]); setPage(null); setError(null); setExpanded(null); setLoading(false);
  }, [identity]);

  async function search(value: string, cursor: string | null = null, append = false) {
    if (!binding) return;
    const version = ++sequence.current;
    setLoading(true); setError(null);
    if (!append) setExpanded(null);
    try {
      const result = await agentApi.sessionSearch(binding, { scope, query: value, afterMessageId: cursor, limit: 20 });
      if (version !== sequence.current) return;
      setMatches(previous => uniqueMatches(append ? [...previous, ...result.matches] : result.matches));
      setPage(result);
    } catch (failure) {
      if (version === sequence.current) setError(agentFailureMessage(failure));
    } finally {
      if (version === sequence.current) setLoading(false);
    }
  }

  function submit() {
    const value = query.trim();
    ++sequence.current;
    setActiveQuery(value); setMatches([]); setPage(null); setError(null); setExpanded(null);
    if (value) void search(value);
    else setLoading(false);
  }

  return <>
    <form className="agent-history-search__form" role="search" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label htmlFor={inputId} className="sr-only">搜索历史讨论</label>
      <input id={inputId} type="search" value={query} placeholder="搜索历史讨论"
        onChange={event => { ++sequence.current; setQuery(event.target.value); setActiveQuery(""); setMatches([]); setPage(null);
          setExpanded(null); setError(null); setLoading(false); }} />
      <Button type="submit" size="sm" disabled={!binding || loading}>搜索</Button>
    </form>
    {!activeQuery ? children : <div className="agent-history-search__results" aria-label="历史搜索结果">
      {matches.map(match => {
        const identity = `${match.sessionId}:${match.messageId}`;
        return <article className="agent-history-search__match" key={identity}>
          <div className="agent-history-search__meta"><strong>{match.sessionTitle}</strong><time dateTime={match.createdAt}>{new Date(match.createdAt).toLocaleString()}</time></div>
          <p>{match.snippet}</p>
          <div className="agent-history-search__actions">
            <Button size="sm" variant="ghost" onClick={() => setExpanded(current => current === identity ? null : identity)}
              aria-expanded={expanded === identity}>查看原文</Button>
            <Button size="sm" variant="ghost" disabled={busySession} onClick={() => onOpenSession(match.sessionId)}>打开会话</Button>
          </div>
          {expanded === identity && binding ? <AgentMessageSource source={sourceForMatch(match, binding, scope)} binding={binding} /> : null}
        </article>;
      })}
      {loading ? <p className="agent-panel__hint" role="status">正在搜索历史讨论…</p> : null}
      {error ? <p className="agent-panel__hint" role="alert">{error}</p> : null}
      {!loading && !error && !matches.length ? <p className="agent-panel__hint">暂未找到匹配内容</p> : null}
      {page && !page.coverage.complete ? <div className="agent-history-search__coverage">
        <p className="agent-panel__hint">正在整理较早的会话，当前结果可能不完整</p>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void search(activeQuery)}>继续查找</Button>
      </div> : null}
      {page?.coverage.complete && page.nextCursor ? <Button size="sm" variant="ghost" disabled={loading}
        onClick={() => void search(activeQuery, page.nextCursor, true)}>更多匹配</Button> : null}
    </div>}
  </>;
}

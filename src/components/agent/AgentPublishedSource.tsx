import { useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { AgentPublishedSource as PublishedSource, AgentWorkspaceBinding } from "../../lib/agent-types";
import { agentQueryKeys } from "../../lib/agent-query-keys";
import { agentApi } from "../../services/agentApi";
import { Button, DisclosurePresence } from "../../ui/components";
import { AgentSourceCard } from "./AgentSourceCard";

/** A published Project item is a derived parent, never an original source reference. */
export function AgentPublishedSource({ binding, source }: { binding: AgentWorkspaceBinding; source: PublishedSource }) {
  const [expanded, setExpanded] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = { kind: "project" as const, projectId: source.projectId };
  const query = useInfiniteQuery({
    queryKey: [...agentQueryKeys.scope(binding, scope), "published-overview-source", source.revision, source.itemId, source.digest, readVersion],
    enabled: expanded,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.overviewGet(binding, {
      scope, version: source.revision, sections: [], itemIds: [source.itemId], cursor: pageParam, budgetChars: 2000,
    }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const pages = query.data?.pages ?? [];
  const available = pages.length > 0 && pages.every(page => page.revision === source.revision
    && page.items.every(({ item }) => item.id === source.itemId));
  const items = available ? pages.flatMap(page => page.items) : [];
  const unavailable = !!query.error || (pages.length > 0 && (!available || items.length === 0));
  const originalSources = [...new Map(items.flatMap(({ item }) => item.sourceRefs).map(ref =>
    [JSON.stringify([ref.object, ref.revision, ref.locator]), ref] as const)).values()];

  return <div className="space-y-2" data-disclosure-list>
    <button ref={trigger} type="button" className="text-left text-ui text-text-muted" aria-expanded={expanded}
      onClick={() => { if (!expanded) setReadVersion(value => value + 1); setExpanded(value => !value); }}>项目概览依据 · 版本 {source.revision}</button>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-2 space-y-2">
      {query.isLoading && <p className="text-caption text-text-muted">正在读取项目概览依据…</p>}
      {unavailable ? <p role="alert" className="text-caption text-text-muted">该项目概览依据已不可用，可能已变更或当前无权读取。</p> : <>
        {items.map(({ item, textOffset, complete }) => <div key={`${item.id}:${textOffset}`} className="space-y-1">
          <p className="whitespace-pre-wrap break-words text-body text-text">{item.text}</p>
          {!complete && <p className="text-caption text-text-muted">当前显示有界片段，可继续读取。</p>}
        </div>)}
        {originalSources.map((ref, index) => <AgentSourceCard key={index} source={ref} binding={binding} />)}
        {query.hasNextPage && <Button size="sm" disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}>继续读取项目概览依据</Button>}
      </>}
    </DisclosurePresence>
  </div>;
}

import { useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentScope, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { AgentMemoryCard, AgentMemoryDetail, AgentMemoryUpdateInput, MemoryCategory, MemorySourceState } from "../../lib/agent-memory-types";
import { agentQueryKeys } from "../../lib/agent-query-keys";
import { formatDateTime } from "../../lib/formatters";
import { getErrorMessage } from "../../lib/errors";
import { agentMemoryApi } from "../../services/agentMemoryApi";
import { Button, DisclosurePresence, EmptyState, StatusBadge, SurfaceCard } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { AgentPublishedSource } from "./AgentPublishedSource";
import { AgentSourceCard } from "./AgentSourceCard";

const categories: Record<MemoryCategory, string> = {
  background: "背景", domain: "领域", interest: "兴趣", method: "方法", preference: "偏好", knowledge_pointer: "知识线索",
};
const sourceStates: Record<MemorySourceState, string> = {
  current: "依据可用", stale: "依据已变化", unavailable: "依据不可用", archived: "来源已归档",
};
const queryOptions = { retry: false, refetchOnWindowFocus: false } as const;

export interface AgentMemoryPanelProps { binding: AgentWorkspaceBinding; scope: AgentScope; open?: boolean }

export function AgentMemoryPanel({ open = true, ...props }: AgentMemoryPanelProps) {
  if (!open) return null;
  return <MemoryContents key={JSON.stringify([props.binding, props.scope])} {...props} />;
}

function MemoryContents({ binding, scope }: Omit<AgentMemoryPanelProps, "open">) {
  const [readSession] = useState(() => crypto.randomUUID());
  const key = [...agentQueryKeys.scope(binding, scope), "memory-list", readSession];
  const list = useInfiniteQuery({
    queryKey: key, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentMemoryApi.memoryList(binding, { scope, cursor: pageParam, limit: 20 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions,
  });
  const cards = list.data?.pages.flatMap(page => page.items) ?? [];
  return <section aria-label="长期记忆" className="space-y-3">
    <h3 className="text-ui font-medium text-text">长期记忆</h3>
    <p className="text-caption text-text-muted">这里保留有长期价值的理解。推断会单独标明；确认和纠正只由你操作。</p>
    {list.isLoading && <p className="text-caption text-text-muted">正在读取记忆…</p>}
    {list.error && <p role="alert" className="text-caption text-danger">{getErrorMessage(list.error, "读取记忆失败")}</p>}
    <div className="agent-memory-list"><HomeSidebarList label="长期记忆条目">
      <div className="space-y-2" data-disclosure-list>
        {cards.map(card => <MemoryItem key={card.nodeId} binding={binding} scope={scope} card={card} readSession={readSession} />)}
        {!list.isLoading && !list.error && !cards.length && <EmptyState compact text="还没有长期记忆条目。" />}
        {list.hasNextPage && <Button size="sm" disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}>更多记忆</Button>}
      </div>
    </HomeSidebarList></div>
  </section>;
}

interface CorrectionDraft {
  expectedNodeRevision: number;
  expectedPolicyRevision: number;
  title: string;
  oneLine: string;
  summary: string;
  body: string;
}

function MemoryItem({ binding, scope, card, readSession }: { binding: AgentWorkspaceBinding; scope: AgentScope; card: AgentMemoryCard; readSession: string }) {
  const [expanded, setExpanded] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const base = agentQueryKeys.scope(binding, scope);
  const detailKey = [...base, "memory-detail", card.nodeId, card.nodeRevision, card.policyRevision, readSession, readVersion];
  const detail = useQuery({
    queryKey: detailKey, enabled: expanded,
    queryFn: () => agentMemoryApi.memoryGet(binding, { scope, nodeId: card.nodeId }), ...queryOptions,
  });
  const update = useMutation({
    mutationFn: (input: AgentMemoryUpdateInput) => agentMemoryApi.memoryUpdate(binding, input),
    onSuccess: value => {
      client.setQueryData(detailKey, value);
      void client.invalidateQueries({ queryKey: [...base, "memory-list"] });
      void client.invalidateQueries({ queryKey: [...base, "memory-detail", card.nodeId] });
      setDraft(null);
      setNotice("记忆已更新。");
    },
  });
  const value = detail.data;
  const otherSuppressors = value?.suppressedBy.filter(item => item.nodeId !== value.nodeId) ?? [];
  const canCorrect = value?.status === "enabled" && (value.sourceState === "current" || value.sourceState === "stale");
  const canConfirm = canCorrect && value?.sourceState === "current" && value.confirmation === "inferred";
  const conflict = (update.error as { code?: string } | null)?.code === "REVISION_CONFLICT";
  function act(action: AgentMemoryUpdateInput["action"], current: AgentMemoryDetail) {
    setNotice("");
    update.mutate({ scope, nodeId: current.nodeId, expectedNodeRevision: current.nodeRevision,
      expectedPolicyRevision: current.policyRevision, action });
  }
  function save() {
    if (!draft || !draft.title.trim() || !draft.oneLine.trim() || !draft.summary.trim()
      || draft.summary.length + draft.body.length > 8000) return;
    setNotice("");
    update.mutate({ scope, nodeId: card.nodeId, expectedNodeRevision: draft.expectedNodeRevision,
      expectedPolicyRevision: draft.expectedPolicyRevision, action: "correct",
      correction: { title: draft.title.trim(), oneLine: draft.oneLine.trim(), summary: draft.summary.trim(),
        bodySections: draft.body.trim() ? [{ id: "user-correction", title: "正文", text: draft.body.trim() }] : [] } });
  }
  return <SurfaceCard className="p-3" data-disclosure-list>
    <button ref={trigger} type="button" className="w-full text-left text-ui font-medium text-text" aria-expanded={expanded}
      onClick={() => { if (!expanded) setReadVersion(value => value + 1); setExpanded(value => !value); }}>{card.title}</button>
    <div className="mt-1 flex flex-wrap gap-2">
      <StatusBadge tone="neutral">{categories[card.category]}</StatusBadge>
      <StatusBadge tone={card.confirmation === "user_confirmed" ? "success" : "neutral"}>{card.confirmation === "user_confirmed" ? "用户已确认" : "助手推断"}</StatusBadge>
      {card.status === "disabled" && <StatusBadge tone="warning">已停用</StatusBadge>}
      <StatusBadge tone={card.sourceState === "current" ? "neutral" : "warning"}>{sourceStates[card.sourceState]}</StatusBadge>
    </div>
    <p className="mt-1 text-caption text-text-muted">{card.oneLine}</p>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-3 space-y-3">
      {detail.isLoading && <p className="text-caption text-text-muted">正在读取记忆详情…</p>}
      {detail.error && <p role="alert" className="text-caption text-danger">{getErrorMessage(detail.error, "读取记忆详情失败")}</p>}
      {value && <>
        <p className="text-caption text-text-muted">{sourceStates[value.sourceState]} · 最后有依据于 {formatDateTime(value.lastSupportedAt)}</p>
        <p className="whitespace-pre-wrap break-words text-body text-text">{value.summary}</p>
        {value.bodySections.map(section => <div key={section.id} className="space-y-1">
          <h4 className="text-ui font-medium text-text">{section.title}</h4>
          <p className="whitespace-pre-wrap break-words text-body text-text">{section.text}</p>
        </div>)}
        {value.sourceRefs.map((source, index) => <AgentSourceCard key={index} binding={binding} source={source} />)}
        {value.publishedSources.map(source => <AgentPublishedSource key={`${source.projectId}:${source.revision}:${source.itemId}:${source.digest}`}
          binding={binding} source={source} />)}
        {otherSuppressors.length > 0 && <p className="text-caption text-text-muted">仍受其他停用记忆影响：{otherSuppressors.map(item => item.title).join("、")}。重新启用本条不会解除这些决定。</p>}
        {value.sourceState !== "current" && value.sourceState !== "stale" && <p className="text-caption text-text-muted">当前依据无法核对，可停用或重新启用；确认和纠正需等依据可用。</p>}
        <div className="flex flex-wrap gap-2">
          {canConfirm && <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => act("confirm", value)}>确认记忆</Button>}
          {canCorrect && <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => {
            setDraft({ expectedNodeRevision: value.nodeRevision, expectedPolicyRevision: value.policyRevision,
              title: value.title, oneLine: value.oneLine, summary: value.summary,
              body: value.bodySections.map(section => section.text).join("\n\n") });
            setNotice("");
          }}>纠正记忆</Button>}
          {value.status === "enabled" ? <Button size="sm" variant="ghost" disabled={update.isPending}
            onClick={() => act("disable", value)}>停用记忆</Button>
            : <Button size="sm" variant="ghost" disabled={update.isPending}
              onClick={() => act("reenable", value)}>重新启用</Button>}
        </div>
        {value.status === "enabled" && <p className="text-caption text-text-muted">停用会抑制同一范围、同类记忆中使用相同原始来源的后续候选；原始资料仍保留。</p>}
        {value.status === "disabled" && <p className="text-caption text-text-muted">重新启用只撤回本条停用决定，不会恢复已变化或不可用的来源。</p>}
        {draft && <form className="space-y-2" onSubmit={event => { event.preventDefault(); save(); }}>
          <label className="block text-caption text-text-muted">标题<input aria-label="记忆标题" className="mt-1 w-full rounded border border-border bg-background p-2 text-body text-text"
            maxLength={200} value={draft.title} onChange={event => setDraft(current => current && { ...current, title: event.target.value })} /></label>
          <label className="block text-caption text-text-muted">一句话<input aria-label="记忆一句话" className="mt-1 w-full rounded border border-border bg-background p-2 text-body text-text"
            maxLength={300} value={draft.oneLine} onChange={event => setDraft(current => current && { ...current, oneLine: event.target.value })} /></label>
          <label className="block text-caption text-text-muted">摘要<textarea aria-label="记忆摘要" className="mt-1 w-full rounded border border-border bg-background p-2 text-body text-text"
            rows={2} maxLength={2000} value={draft.summary} onChange={event => setDraft(current => current && { ...current, summary: event.target.value })} /></label>
          <label className="block text-caption text-text-muted">正文<textarea aria-label="记忆正文" className="mt-1 w-full rounded border border-border bg-background p-2 text-body text-text"
            rows={4} maxLength={8000 - draft.summary.length} value={draft.body} onChange={event => setDraft(current => current && { ...current, body: event.target.value })} /></label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={update.isPending || !draft.title.trim() || !draft.oneLine.trim() || !draft.summary.trim()
              || draft.summary.length + draft.body.length > 8000}>保存纠正</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setDraft(null)}>取消编辑</Button>
          </div>
        </form>}
      </>}
      {update.error && <p role="alert" className="text-caption text-danger">{conflict ? "记忆版本已变化，请刷新后重新编辑；当前草稿仍保留。" : getErrorMessage(update.error, "更新记忆失败")}</p>}
      {conflict && <Button size="sm" variant="ghost" onClick={() => void detail.refetch()}>刷新记忆版本</Button>}
      {notice && <p role="status" className="text-caption text-text-muted">{notice}</p>}
    </DisclosurePresence>
  </SurfaceCard>;
}

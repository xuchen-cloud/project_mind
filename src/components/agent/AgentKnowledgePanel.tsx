import { useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentScope, AgentSourceCoverage, AgentWorkspaceBinding, AiOverviewItem, KnowledgeSearchCard } from "../../lib/agent-types";
import { agentQueryKeys } from "../../lib/agent-query-keys";
import { formatDateTime } from "../../lib/formatters";
import { getErrorMessage } from "../../lib/errors";
import { agentApi } from "../../services/agentApi";
import { Button, DisclosurePresence, EmptyState, SectionHeader, StatusBadge, SurfaceCard } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { AgentSourceCard } from "./AgentSourceCard";

export interface AgentKnowledgePanelProps { binding: AgentWorkspaceBinding; scope: AgentScope; open?: boolean }
const sections: Record<AiOverviewItem["section"], string> = { profile: "项目定位", progress: "进展", knowledgeMap: "知识线索", actions: "行动", openQuestions: "待确认问题" };
const statuses = { not_built: "尚未整理", partial: "部分覆盖", ready: "已整理", stale: "资料有更新" };
const validStates = { current: "当前依据", stale: "依据已变化", disputed: "有争议", unsupported: "缺少依据" };
const queryOptions = { retry: false, refetchOnWindowFocus: false } as const;

export function AgentKnowledgePanel({ open = true, ...props }: AgentKnowledgePanelProps) {
  if (!open) return null;
  return <KnowledgeContents key={JSON.stringify([props.binding, props.scope])} {...props} />;
}

function Coverage({ value }: { value: AgentSourceCoverage | null | undefined }) {
  return value ? <p className="text-caption text-text-muted">已处理 {value.processed} · 部分 {value.partial} · 待处理 {value.pending} · 已排除 {value.excluded} · 不支持 {value.unsupported}</p>
    : <p className="text-caption text-text-muted">尚无覆盖统计</p>;
}
function Failure({ error }: { error: unknown }) {
  return error ? <p role="alert" className="text-body text-danger">{getErrorMessage(error, "读取项目知识失败")}</p> : null;
}

function KnowledgeContents({ binding, scope }: Omit<AgentKnowledgePanelProps, "open">) {
  const client = useQueryClient();
  const base = agentQueryKeys.scope(binding, scope);
  const metadata = useQuery({ queryKey: [...base, "knowledge-metadata"], queryFn: () => agentApi.contextGet(binding, { scope, budgetChars: 1000 }), ...queryOptions });
  const overview = useQuery({ queryKey: [...base, "overview-directory"], queryFn: () => agentApi.overviewGet(binding, { scope, sections: [], itemIds: [], budgetChars: 1000 }), ...queryOptions });
  const directory = useInfiniteQuery({ queryKey: [...base, "knowledge-directory"], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.knowledgeSearch(binding, { scope, query: "", cursor: pageParam, limit: 10, budgetChars: 2000 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions });
  const maintenanceKey = [...base, "source-maintenance"];
  const progress = useQuery({ queryKey: maintenanceKey, queryFn: () => agentApi.sourceMaintenance(binding, scope), refetchInterval: 2000, ...queryOptions });
  const control = useMutation({ mutationFn: (action: "cancel" | "resume") => agentApi.sourceMaintenance(binding, scope, action),
    onSuccess: value => client.setQueryData(maintenanceKey, value) });
  const updated = metadata.data?.overviewUpdatedAt;
  const state = metadata.data?.status ?? (overview.data?.stale ? "stale" : overview.data?.revision == null ? "not_built" : "ready");
  const cards = directory.data?.pages.flatMap(page => page.items) ?? [];
  const currentProgress = progress.data;

  return <section aria-label={scope.kind === "project" ? "项目知识" : "工作区知识"} className="space-y-4 p-4">
    <SectionHeader title={scope.kind === "project" ? "项目知识" : "工作区知识"} actions={<Button size="sm" variant="ghost"
      disabled={metadata.isFetching || overview.isFetching || directory.isFetching} onClick={() => { void metadata.refetch(); void overview.refetch(); void directory.refetch(); void progress.refetch(); }}>刷新状态</Button>} />
    <div className="space-y-2">
      <StatusBadge tone={state === "ready" ? "success" : "neutral"}>{statuses[state]}</StatusBadge>
      <p className="text-caption text-text-muted">{updated ? `整理时间：${formatDateTime(updated)}` : "尚无整理时间"}</p>
      <Coverage value={overview.data?.coverage ?? metadata.data?.coverage} />
      {overview.data?.needsRebuild && <p className="text-caption text-text-muted">已有资料变更，整理内容需要更新。</p>}
      {(overview.data?.pendingCount ?? 0) > 0 && <p className="text-caption text-text-muted">还有 {overview.data?.pendingCount} 项变化尚未纳入整理。</p>}
      <Failure error={metadata.error || overview.error || directory.error} />
    </div>
    <SurfaceCard className="space-y-2 p-3">
      <h3 className="text-ui font-medium text-text">资料处理</h3>
      {progress.isLoading ? <p className="text-caption text-text-muted">正在读取处理状态…</p> : currentProgress ? <>
        <p className="text-caption text-text-muted">待处理 {currentProgress.pendingJobs} · 失败 {currentProgress.failedJobs} · 部分来源 {currentProgress.partialSources}</p>
        <p className="text-caption text-text-muted">{currentProgress.cancelled ? "已暂停" : currentProgress.foregroundBusy ? "正在等待当前助手任务" : currentProgress.budgetExhausted ? "本批处理额度已用完" : currentProgress.backfillComplete && !currentProgress.pendingJobs ? "本批资料处理结束；覆盖情况以上方统计为准" : "正在逐步处理资料"}</p>
        <Button size="sm" variant="ghost" disabled={control.isPending}
          onClick={() => control.mutate(currentProgress.cancelled || currentProgress.budgetExhausted ? "resume" : "cancel")}>
          {currentProgress.cancelled || currentProgress.budgetExhausted ? "继续处理资料" : "暂停资料处理"}</Button>
      </> : <p className="text-caption text-text-muted">当前没有资料处理批次。</p>}
      <Failure error={progress.error || control.error} />
    </SurfaceCard>
    <div className="max-h-[32rem] [&_.home-side__list]:max-h-[32rem]">
      <HomeSidebarList label="项目知识内容">
        <div className="space-y-3" data-disclosure-list>
          {overview.isLoading || directory.isLoading ? <p className="text-body text-text-muted">正在读取知识目录…</p> : null}
          {overview.data?.sections.filter(section => section.count > 0).map(section => <OverviewSection key={section.section}
            binding={binding} scope={scope} section={section.section} count={section.count} revision={overview.data?.revision ?? undefined} />)}
          {cards.map(card => <KnowledgeNode key={`${card.nodeId}:${card.revision}`} binding={binding} scope={scope} card={card} />)}
          {!overview.isLoading && !directory.isLoading && !overview.error && !directory.error && !cards.length && !overview.data?.sections.some(section => section.count > 0)
            && <EmptyState compact text="这里还没有整理好的知识；仍可在助手中询问真实资料。" />}
          {directory.data?.pages.some(page => page.sourceFallbackRequired) && <p className="text-caption text-text-muted">当前知识未覆盖全部问题，回答仍需核对原始资料。</p>}
          {directory.hasNextPage && <Button size="sm" disabled={directory.isFetchingNextPage} onClick={() => void directory.fetchNextPage()}>更多知识条目</Button>}
        </div>
      </HomeSidebarList>
    </div>
  </section>;
}

function OverviewSection({ binding, scope, section, count, revision }: { binding: AgentWorkspaceBinding; scope: AgentScope; section: AiOverviewItem["section"]; count: number; revision?: number }) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const query = useInfiniteQuery({ queryKey: [...agentQueryKeys.scope(binding, scope), "overview-section", section, revision], enabled: expanded,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.overviewGet(binding, { scope, version: revision, sections: [section], itemIds: [], cursor: pageParam, budgetChars: 2000 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions });
  return <SurfaceCard className="p-3">
    <button ref={trigger} type="button" className="w-full text-left text-ui font-medium text-text" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{sections[section]} · {count}</button>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-3 space-y-3">
      {query.isLoading && <p className="text-caption text-text-muted">正在读取…</p>}
      <Failure error={query.error} />
      {query.data?.pages.flatMap(page => page.items).map(({ item, textOffset, complete }) => <div key={`${item.id}:${textOffset}`} className="space-y-2">
        <StatusBadge tone={item.validState === "current" ? "neutral" : "warning"}>{validStates[item.validState]}</StatusBadge>
        <p className="whitespace-pre-wrap break-words text-body text-text">{item.text}</p>
        {!complete && <p className="text-caption text-text-muted">当前显示有界片段，可继续读取。</p>}
        <p className="text-caption text-text-muted">更新于 {formatDateTime(item.updatedAt)}</p>
        {item.sourceRefs.map((source, index) => <AgentSourceCard key={`${source.object.id}:${index}`} source={source} binding={binding} />)}
      </div>)}
      {query.hasNextPage && <Button size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>继续读取{sections[section]}</Button>}
    </DisclosurePresence>
  </SurfaceCard>;
}

function KnowledgeNode({ binding, scope, card }: { binding: AgentWorkspaceBinding; scope: AgentScope; card: KnowledgeSearchCard }) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const base = [...agentQueryKeys.scope(binding, scope), "knowledge-node", card.nodeId, card.revision];
  const summary = useInfiniteQuery({ queryKey: [...base, "summary"], enabled: expanded, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.knowledgeGet(binding, { scope, nodeId: card.nodeId, version: card.revision, view: "summary", cursor: pageParam, budgetChars: 2000 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions });
  const outline = useInfiniteQuery({ queryKey: [...base, "outline"], enabled: expanded, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.knowledgeGet(binding, { scope, nodeId: card.nodeId, version: card.revision, view: "outline", cursor: pageParam, budgetChars: 1000 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions });
  return <SurfaceCard className="p-3" data-disclosure-list>
    <button ref={trigger} type="button" className="w-full text-left text-ui font-medium text-text" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{card.title}</button>
    {card.stale && <StatusBadge tone="warning">依据已变化</StatusBadge>}
    <p className="mt-1 text-caption text-text-muted">{card.snippet}</p>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-3 space-y-3">
      {summary.isLoading && <p className="text-caption text-text-muted">正在读取摘要…</p>}
      <Failure error={summary.error || outline.error} />
      {summary.data?.pages.map((page, index) => <div key={index} className="space-y-2">
        <p className="whitespace-pre-wrap break-words text-body text-text">{page.summary}</p>
        <Coverage value={page.coverage} />
        {page.sourceRefs.map((source, sourceIndex) => <AgentSourceCard key={sourceIndex} source={source} binding={binding} />)}
      </div>)}
      {summary.hasNextPage && <Button size="sm" disabled={summary.isFetchingNextPage} onClick={() => void summary.fetchNextPage()}>更多摘要</Button>}
      {outline.data?.pages.flatMap(page => page.sections).map(section => <KnowledgeSection key={section.id} binding={binding} scope={scope} card={card} id={section.id} title={section.title} />)}
      {outline.hasNextPage && <Button size="sm" disabled={outline.isFetchingNextPage} onClick={() => void outline.fetchNextPage()}>更多章节</Button>}
    </DisclosurePresence>
  </SurfaceCard>;
}

function KnowledgeSection({ binding, scope, card, id, title }: { binding: AgentWorkspaceBinding; scope: AgentScope; card: KnowledgeSearchCard; id: string; title: string }) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useInfiniteQuery({ queryKey: [...agentQueryKeys.scope(binding, scope), "knowledge-section", card.nodeId, card.revision, id], enabled: expanded,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.knowledgeGet(binding, { scope, nodeId: card.nodeId, version: card.revision, view: "content", sectionIds: [id], cursor: pageParam, budgetChars: 2000 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions });
  return <div>
    <button ref={trigger} type="button" className="text-left text-ui text-text-muted" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>查看正文：{title}</button>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-2 space-y-2">
      {content.isLoading && <p className="text-caption text-text-muted">正在读取正文片段…</p>}
      <Failure error={content.error} />
      {content.data?.pages.flatMap(page => page.sections).map(section => <p key={`${section.id}:${section.textOffset}`} className="whitespace-pre-wrap break-words text-body text-text">{section.text}</p>)}
      {content.hasNextPage && <Button size="sm" disabled={content.isFetchingNextPage} onClick={() => void content.fetchNextPage()}>继续读取正文</Button>}
    </DisclosurePresence>
  </div>;
}

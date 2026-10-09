import { useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentErrorCode, AgentScope, AgentSessionMessageRef, AgentSourceCoverage, AgentSourceRef, AgentWorkspaceBinding, AiOverviewItem, KnowledgeGetPage, KnowledgeSearchCard, OverviewCorrections, SessionSummarySegment, SessionSummaryStatement } from "../../lib/agent-types";
import { agentQueryKeys } from "../../lib/agent-query-keys";
import { formatDateTime } from "../../lib/formatters";
import { getErrorMessage } from "../../lib/errors";
import { agentApi } from "../../services/agentApi";
import { Button, DisclosurePresence, EmptyState, SectionHeader, StatusBadge, SurfaceCard } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { AgentSourceCard } from "./AgentSourceCard";
import { AgentPublishedSource } from "./AgentPublishedSource";

export interface AgentKnowledgePanelProps { binding: AgentWorkspaceBinding; scope: AgentScope; open?: boolean }
const sections: Record<AiOverviewItem["section"], string> = { profile: "项目定位", progress: "进展", knowledgeMap: "知识线索", actions: "行动", openQuestions: "待确认问题" };
const statuses = { not_built: "尚未整理", partial: "部分覆盖", ready: "已整理", stale: "资料有更新" };
const validStates = { current: "当前依据", stale: "依据已变化", disputed: "有争议", unsupported: "缺少依据" };
const queryOptions = { retry: false, refetchOnWindowFocus: false } as const;
const statementLabels = { user_plan: "用户计划", user_decision: "用户决定", ai_suggestion: "助手建议",
  completed_operation: "已执行操作", user_reported_completion: "用户报告已完成" } as const;
function maintenanceIssue(code: AgentErrorCode): string {
  return code === "PROFILE_UNAVAILABLE" ? "请先配置可用模型。"
    : code === "SECRETS_LOCKED" ? "请先解锁模型密钥。"
    : code === "TIMED_OUT" ? "本次整理超时，已保存的进度保留；可稍后继续整理。"
    : code === "SOURCE_NOT_READY" || code === "FILE_CHANGED_UNREGISTERED" ? "请先完成项目资料整理或登记文件新版本，再继续。"
    : "本批整理遇到问题，可检查配置后继续。";
}

function discussionSource(ref: AgentSessionMessageRef): AgentSourceRef {
  return { object: { workspaceId: ref.workspaceId, scope: ref.scope, kind: "session_message", id: ref.messageId },
    revision: ref.contentHash, fileVersion: null, recordVersion: null, blockId: null,
    locator: { kind: "messages", sessionId: ref.sessionId, branchId: ref.branchId,
      startMessageId: ref.messageId, endMessageId: ref.messageId },
    title: "原始讨论", excerpt: "" };
}

function statementSources(statement: SessionSummaryStatement): AgentSourceRef[] {
  const key = (source: AgentSourceRef) => JSON.stringify([source.object.workspaceId, source.object.scope.kind,
    source.object.scope.kind === "project" ? source.object.scope.projectId : null,
    source.object.kind, source.object.id, source.revision]);
  const sources = new Map(statement.sourceRefs.map(source => [key(source), source] as const));
  for (const ref of statement.messageRefs) {
    const source = discussionSource(ref);
    if (!sources.has(key(source))) sources.set(key(source), source);
  }
  return [...sources.values()];
}

function DiscussionSummary({ segment, binding }: { segment: SessionSummarySegment; binding: AgentWorkspaceBinding }) {
  return <div className="space-y-2">
    {segment.topics.length > 0 && <p className="text-caption text-text-muted">讨论主题：{segment.topics.join("、")}</p>}
    {segment.supersededBy.length > 0 && <p className="text-caption text-text-muted">已被后续结论替代</p>}
    {segment.statements.map((statement, index) => <div key={`${segment.id}:${index}`} className="space-y-1">
      <p className="whitespace-pre-wrap break-words text-body text-text"><span className="font-medium">{statementLabels[statement.kind]}：</span>{statement.text}</p>
      {statementSources(statement).map((source, sourceIndex) => <AgentSourceCard key={sourceIndex} source={source} binding={binding} />)}
    </div>)}
  </div>;
}

function joinedSummary(pages: KnowledgeGetPage[]): string {
  let text = "";
  for (const page of pages) {
    if (!page.summary) continue;
    const chunk = Array.from(page.summary);
    const overlap = Math.max(0, text.length ? Array.from(text).length - page.summaryOffset : 0);
    text += chunk.slice(overlap).join("");
  }
  return text;
}

export function AgentKnowledgePanel({ open = true, ...props }: AgentKnowledgePanelProps) {
  if (!open) return null;
  return <KnowledgeContents key={JSON.stringify([props.binding, props.scope])} {...props} />;
}

function Coverage({ value }: { value: AgentSourceCoverage | null | undefined }) {
  return value ? <p className="text-caption text-text-muted">已处理 {value.processed} · 部分 {value.partial} · 待处理 {value.pending} · 已排除 {value.excluded} · 不支持 {value.unsupported}</p>
    : <p className="text-caption text-text-muted">尚无覆盖统计</p>;
}
function Failure({ error }: { error: unknown }) {
  return error ? <p role="alert" className="text-body text-danger">{getErrorMessage(error, "读取知识失败")}</p> : null;
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
    <OverviewMaintenance binding={binding} scope={scope} />
    <OverviewCorrectionsPanel binding={binding} scope={scope} />
    <div className="max-h-[32rem] [&_.home-side__list]:max-h-[32rem]">
      <HomeSidebarList label="知识内容">
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

function OverviewMaintenance({ binding, scope }: { binding: AgentWorkspaceBinding; scope: AgentScope }) {
  const client = useQueryClient();
  const base = agentQueryKeys.scope(binding, scope);
  const key = [...base, "overview-maintenance"];
  const [notice, setNotice] = useState("");
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const projectsTrigger = useRef<HTMLButtonElement>(null);
  const status = useQuery({ queryKey: key, queryFn: () => agentApi.overviewMaintenance(binding, scope), refetchInterval: 5000, ...queryOptions });
  const control = useMutation({ mutationFn: (action: "refresh" | "cancel" | "resume") => agentApi.overviewMaintenance(binding, scope, action),
    onSuccess: (value, action) => {
      client.setQueryData(key, value);
      setNotice(action === "cancel" ? "已暂停知识整理。" : "整理请求已排队，状态会继续更新。");
      void client.invalidateQueries({ queryKey: base });
    } });
  const value = status.data;
  const issue = value?.errorCode ? maintenanceIssue(value.errorCode) : null;
  const canResume = !!(value?.cancelled || value?.budgetExhausted || value?.errorCode || value?.deferredCount);
  return <SurfaceCard className="space-y-2 p-3" aria-label="整理知识">
    <h3 className="text-ui font-medium text-text">整理知识</h3>
    <p className="text-caption text-text-muted">根据已处理资料更新知识目录；与上方资料提取分开进行。</p>
    {status.isLoading ? <p className="text-caption text-text-muted">正在读取整理状态…</p> : value ? <>
      <p className="text-caption text-text-muted">待纳入 {value.pendingCount} 项 · 已删除 {value.deletedCount} 项 · {value.directoryComplete ? "目录已完成" : "目录未完成"}</p>
      <p className="text-caption text-text-muted">整理覆盖：已处理 {value.coverage.processed} · 部分 {value.coverage.partial} · 不支持 {value.coverage.unsupported} · 待处理 {value.coverage.pending}</p>
      <p className="text-caption text-text-muted">{value.cancelled ? "已暂停" : value.errorCode ? "整理遇到问题，等待继续" : value.foregroundBusy ? "正在等待当前助手任务" : value.budgetExhausted ? "本批整理额度已用完" : value.pendingCount ? "正在等待或处理变化" : "暂无待纳入变化"}</p>
      {value.nextRunAt && !value.cancelled && <p className="text-caption text-text-muted">下次尝试：{formatDateTime(value.nextRunAt)}</p>}
      {issue && <p role="alert" className="text-caption text-danger">{issue}</p>}
      {scope.kind === "workspace" && !!value.deferredCount && <div className="space-y-1 text-caption text-text-muted">
        <p>有 {value.deferredCount} 项项目资料暂时不可用，其他资料继续整理。</p>
        {value.deferredErrorCode && <p>{maintenanceIssue(value.deferredErrorCode)}</p>}
      </div>}
      {scope.kind === "workspace" && !!value.projectStatuses?.length && <div>
        <button ref={projectsTrigger} type="button" className="text-left text-caption text-text-muted" aria-expanded={projectsExpanded}
          onClick={() => setProjectsExpanded(current => !current)}>项目整理状态 · {value.projectStatuses.length}</button>
        <DisclosurePresence open={projectsExpanded} triggerRef={projectsTrigger} className="mt-2">
          <div className="max-h-48 [&_.home-side__list]:max-h-48"><HomeSidebarList label="项目整理状态">
            <div className="space-y-2" data-disclosure-list>
              {value.projectStatuses.map(project => <div key={project.projectId} className="text-caption text-text-muted">
                <p>{project.projectName} · {project.overviewRevision == null ? "尚无概览" : `概览版本 ${project.overviewRevision}`} · 待纳入 {project.pendingCount}</p>
                <p>{project.cancelled ? "已暂停" : project.errorCode ? "整理遇到问题" : project.directoryComplete ? "目录已完成" : "目录未完成"}</p>
                {project.errorCode && <p role="alert" className="text-danger">{maintenanceIssue(project.errorCode)}</p>}
              </div>)}
            </div>
          </HomeSidebarList></div>
        </DisclosurePresence>
      </div>}
    </> : <p className="text-caption text-text-muted">当前没有知识整理批次。</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={control.isPending || status.isLoading} onClick={() => control.mutate("refresh")}>立即整理</Button>
      <Button size="sm" variant="ghost" disabled={control.isPending || status.isLoading} onClick={() => control.mutate(canResume ? "resume" : "cancel")}>{canResume ? "继续整理" : "暂停整理"}</Button>
    </div>
    {notice && <p role="status" className="text-caption text-text-muted">{notice}</p>}
    <Failure error={status.error || control.error} />
  </SurfaceCard>;
}

function OverviewCorrectionsPanel({ binding, scope }: { binding: AgentWorkspaceBinding; scope: AgentScope }) {
  const client = useQueryClient();
  const base = agentQueryKeys.scope(binding, scope);
  const key = [...base, "overview-corrections"];
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const corrections = useQuery({ queryKey: key, queryFn: () => agentApi.overviewCorrectionsGet(binding, scope), enabled: expanded, ...queryOptions });
  function applied(value: OverviewCorrections) {
    client.setQueryData(key, value);
    setEditing(null); setText(""); setNotice("纠正已保存；下次整理会参考此内容。");
    void client.invalidateQueries({ queryKey: base, predicate: query => !query.queryKey.includes("overview-corrections") });
  }
  const save = useMutation({ mutationFn: () => agentApi.overviewCorrectionUpsert(binding, {
    scope, id: editing ?? crypto.randomUUID().replaceAll("-", ""),
    itemId: corrections.data?.items.find(item => item.id === editing)?.itemId ?? null,
    text: text.trim(), expectedRevision: corrections.data!.revision,
  }), onSuccess: applied });
  const remove = useMutation({ mutationFn: (id: string) => agentApi.overviewCorrectionDelete(binding, { scope, id, expectedRevision: corrections.data!.revision }),
    onSuccess: value => { applied(value); setNotice("纠正已删除；下次整理会更新理解。"); } });
  const active = corrections.data?.items.filter(item => !item.deleted) ?? [];
  return <SurfaceCard className="p-3">
    <button ref={trigger} type="button" className="w-full text-left text-ui font-medium text-text" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>纠正理解</button>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-3 space-y-3">
      <p className="text-caption text-text-muted">这里记录你对助手理解的纠正，独立于{scope.kind === "project" ? "项目速记" : "工作区速记"}和记录；不会改写原文。</p>
      {corrections.isLoading && <p className="text-caption text-text-muted">正在读取纠正…</p>}
      <Failure error={corrections.error || save.error || remove.error} />
      {corrections.error || save.error || remove.error ? <Button size="sm" variant="ghost" onClick={() => void corrections.refetch()}>刷新纠正版本</Button> : null}
      {corrections.data && <>
        <div className="max-h-48 [&_.home-side__list]:max-h-48"><HomeSidebarList label="已有纠正">
          <div className="space-y-2" data-disclosure-list>
            {active.length ? active.map(item => <div key={item.id} className="space-y-1 border-b border-border pb-2">
              <p className="whitespace-pre-wrap break-words text-body text-text">{item.text}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" disabled={save.isPending || remove.isPending} onClick={() => { setEditing(item.id); setText(item.text); setNotice(""); }}>编辑</Button>
                <Button size="sm" variant="ghost" disabled={save.isPending || remove.isPending} onClick={() => remove.mutate(item.id)}>删除</Button>
              </div>
            </div>) : <p className="text-caption text-text-muted">还没有纠正。</p>}
          </div>
        </HomeSidebarList></div>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (text.trim()) save.mutate(); }}>
          <label className="block text-caption text-text-muted" htmlFor="overview-correction-text">{editing ? "编辑纠正" : "补充纠正"}</label>
          <textarea id="overview-correction-text" className="w-full rounded border border-border bg-background p-2 text-body text-text" rows={3} maxLength={2000} value={text} onChange={event => setText(event.target.value)} placeholder="写下需要助手重新理解的内容" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={!text.trim() || save.isPending || remove.isPending}>保存纠正</Button>
            {editing && <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(null); setText(""); }}>取消编辑</Button>}
          </div>
        </form>
        {notice && <p role="status" className="text-caption text-text-muted">{notice}</p>}
      </>}
    </DisclosurePresence>
  </SurfaceCard>;
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
      onClick={() => setExpanded(value => !value)}>{scope.kind === "workspace" && section === "profile" ? "工作概况" : sections[section]} · {count}</button>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-3 space-y-3">
      {query.isLoading && <p className="text-caption text-text-muted">正在读取…</p>}
      <Failure error={query.error} />
      {query.data?.pages.flatMap(page => page.items).map(({ item, textOffset, complete }) => <div key={`${item.id}:${textOffset}`} className="space-y-2">
        <StatusBadge tone={item.validState === "current" ? "neutral" : "warning"}>{validStates[item.validState]}</StatusBadge>
        <p className="whitespace-pre-wrap break-words text-body text-text">{item.text}</p>
        {!complete && <p className="text-caption text-text-muted">当前显示有界片段，可继续读取。</p>}
        <p className="text-caption text-text-muted">更新于 {formatDateTime(item.updatedAt)}</p>
        {item.sourceRefs.map((source, index) => <AgentSourceCard key={`${source.object.id}:${index}`} source={source} binding={binding} />)}
        {item.publishedSources?.map(source => <AgentPublishedSource key={`${source.projectId}:${source.revision}:${source.itemId}:${source.digest}`} binding={binding} source={source} />)}
      </div>)}
      {query.hasNextPage && <Button size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>继续读取{scope.kind === "workspace" && section === "profile" ? "工作概况" : sections[section]}</Button>}
    </DisclosurePresence>
  </SurfaceCard>;
}

function KnowledgeNode({ binding, scope, card }: { binding: AgentWorkspaceBinding; scope: AgentScope; card: KnowledgeSearchCard }) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const base = [...agentQueryKeys.scope(binding, scope), "knowledge-node", card.nodeId, card.revision];
  const summary = useInfiniteQuery({ queryKey: [...base, "summary"], enabled: expanded, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.knowledgeGet(binding, { scope, nodeId: card.nodeId, version: card.revision, view: "summary", cursor: pageParam, budgetChars: 8000 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions });
  const outline = useInfiniteQuery({ queryKey: [...base, "outline"], enabled: expanded, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => agentApi.knowledgeGet(binding, { scope, nodeId: card.nodeId, version: card.revision, view: "outline", cursor: pageParam, budgetChars: 1000 }),
    getNextPageParam: page => page.nextCursor ?? undefined, ...queryOptions });
  const pages = summary.data?.pages ?? [];
  const prose = joinedSummary(pages);
  const metadata = pages.find(page => page.sessionSummary)?.sessionSummary;
  const numberedStatements = new Map<number, SessionSummaryStatement>();
  for (const page of pages) {
    const segment = page.sessionSummary;
    if (segment) segment.statements.forEach((statement, index) => {
      numberedStatements.set(segment.statementOffset + index, statement);
    });
  }
  const sessionSummary = metadata && { ...metadata, statements: [...numberedStatements].sort(([a], [b]) => a - b).map(([, statement]) => statement) };
  const summarySources = [...new Map(pages.flatMap(page => page.sourceRefs).map(source =>
    [JSON.stringify([source.object, source.revision, source.locator]), source] as const)).values()];
  const publishedSources = [...new Map(pages.flatMap(page => page.publishedSources ?? []).map(source =>
    [JSON.stringify([source.projectId, source.revision, source.itemId, source.digest]), source] as const)).values()];
  return <SurfaceCard className="p-3" data-disclosure-list>
    <button ref={trigger} type="button" className="w-full text-left text-ui font-medium text-text" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{card.title}</button>
    {card.stale && <StatusBadge tone="warning">依据已变化</StatusBadge>}
    <p className="mt-1 text-caption text-text-muted">{card.snippet}</p>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-3 space-y-3">
      {summary.isLoading && <p className="text-caption text-text-muted">正在读取摘要…</p>}
      <Failure error={summary.error || outline.error} />
      {pages.length > 0 && <div className="space-y-2">
        {prose && <p className="whitespace-pre-wrap break-words text-body text-text">{prose}</p>}
        {sessionSummary && <DiscussionSummary segment={sessionSummary} binding={binding} />}
        <Coverage value={pages[0].coverage} />
        {summarySources.map((source, sourceIndex) => <AgentSourceCard key={sourceIndex} source={source} binding={binding} />)}
        {publishedSources.map(source => <AgentPublishedSource key={`${source.projectId}:${source.revision}:${source.itemId}:${source.digest}`} binding={binding} source={source} />)}
      </div>}
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

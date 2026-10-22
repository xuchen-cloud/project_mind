import { useEffect, useId, useRef, useState } from "react";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { getErrorMessage } from "../../lib/errors";
import { memoryApi, type MemoryApplyResult, type MemoryCategory, type MemoryChange, type MemoryFact, type MemoryList, type MemoryRequest, type MemoryScope } from "../../services/memoryApi";
import { Button, Dialog, SidebarFilters, SidebarTabs, TextField } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { MemoryScheduleEditor } from "./MemoryScheduleEditor";
import { MemoryBehaviorEditor } from "./MemoryBehaviorEditor";
import "./memory.css";

const categoryLabels: Record<MemoryCategory, string> = { background: "背景", domain: "领域", interest: "兴趣", method: "方法", preference: "偏好", knowledge_pointer: "知识线索", agreement: "背景与约定", decision: "决策" };
const stateLabels = { active: "使用中", disabled: "已停用", forgotten: "已忘记", superseded: "已被替代" };
type View = "active" | "recent" | "pending" | "inactive";
const tabs: { value: View; label: string }[] = [{ value: "active", label: "使用中" }, { value: "recent", label: "最近 24 小时整理" }, { value: "pending", label: "待批准" }, { value: "inactive", label: "已停用与历史" }];
function sameScope(a: MemoryScope, b: MemoryScope) { return a.kind === b.kind && (a.kind === "workspace" || b.kind === "project" && a.projectId === b.projectId); }
function recent(fact: MemoryFact) { const timestamp = Date.parse(fact.autoOrganizedAt ?? ""); return Number.isFinite(timestamp) && Date.now() - timestamp >= 0 && Date.now() - timestamp <= 86_400_000; }
function validity(fact: MemoryFact) {
  if (fact.validFrom && Date.parse(fact.validFrom) > Date.now()) return "尚未生效";
  if (fact.validTo && Date.parse(fact.validTo) <= Date.now()) return "已过期";
  return null;
}
interface Props { scope: MemoryScope; workspaceRoot: string; onClose: () => void }
export function MemoryDialog(props: Props) {
  const key = JSON.stringify([props.workspaceRoot, props.scope]);
  return <MemoryDialogScope key={key} {...props} />;
}
function MemoryDialogScope({ scope, workspaceRoot, onClose }: Props) {
  const openReference = useInternalReferenceNavigation();
  const [capturedBinding, setCapturedBinding] = useState<AgentWorkspaceBinding | null>(null);
  const [behaviorOpen, setBehaviorOpen] = useState(false);
  const [behaviorMounted, setBehaviorMounted] = useState(false);
  const [data, setData] = useState<MemoryList | null>(null);
  const [view, setView] = useState<View>("active");
  const [category, setCategory] = useState<MemoryCategory | null>(null);
  const [editing, setEditing] = useState<MemoryFact | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());
  const sourcesId = useId();
  const alive = useRef(true);
  const categories: MemoryCategory[] = scope.kind === "project" ? ["agreement", "decision"] : ["background", "domain", "interest", "method", "preference", "knowledge_pointer"];
  const binding = useRef<Promise<AgentWorkspaceBinding> | null>(null);
  async function execute<T>(request: MemoryRequest) {
    const captured = await binding.current!;
    if (!alive.current) throw new Error("面板已关闭");
    setCapturedBinding(captured);
    return memoryApi.execute<T>(captured, scope, request);
  }
  async function load() {
    const result = await execute<MemoryList>({ operation: "list", scope, includeInactive: true });
    if (alive.current) setData(result);
  }
  useEffect(() => {
    alive.current = true;
    binding.current ??= recordDocumentApi.bindingGet(workspaceRoot);
    void load().catch(reason => { if (alive.current) setError(getErrorMessage(reason)); });
    return () => { alive.current = false; };
  }, []);
  async function run(request: MemoryRequest) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await execute<MemoryApplyResult>(request);
      if (!alive.current) return;
      if (request.operation !== "settings") setNotice(result.pending ? "已加入待批准列表" : request.operation === "rollback" ? "已撤销整组整理，恢复的记忆已锁定" : "已保存");
      setEditing(null);
      await load();
    } catch (reason) { if (alive.current) setError(getErrorMessage(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  function apply(changes: MemoryChange[]) { return run({ operation: "apply", requestId: crypto.randomUUID(), changes }); }
  const facts = (data?.facts ?? []).filter(f => sameScope(f.scope, scope));
  const shown = facts.filter(f => (!category || f.category === category) && (view === "active" ? f.state === "active" : view === "recent" ? recent(f) : f.state !== "active"));
  const proposals = (data?.proposals ?? []).filter(p => p.changes.some(change => sameScope(change.scope, scope)));
  return <Dialog open title={scope.kind === "project" ? "项目理解" : "工作区记忆"} onClose={onClose} widthClassName="max-w-3xl" bodyClassName="memory-dialog__body">
    <div className="memory-dialog__tools">
      <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={data?.settings.requireApproval ?? false} disabled={busy || !data || scope.kind !== "workspace"} title={scope.kind === "project" ? "请在工作区记忆中修改全局整理设置" : undefined} onChange={event => void run({ operation: "settings", requireApproval: event.target.checked })} />自动整理需我批准</label>
      <div className="flex gap-2">
        {scope.kind === "workspace" && <Button size="sm" variant="ghost" disabled={!capturedBinding} aria-expanded={behaviorOpen} aria-controls="memory-behavior-panel" onClick={() => { setBehaviorMounted(true); setBehaviorOpen(open => !open); }}>记忆与整理行为</Button>}
        <Button size="sm" disabled={busy || !data} onClick={() => setEditing("new")}>记住一条</Button>
      </div>
    </div>
    <p className="text-caption text-text-secondary">{scope.kind === "project" ? "本项目的背景、约定和决策。" : "工作区内可复用的长期记忆。"}停用后不再使用；忘记后会阻止自动重新记住。</p>
    <SidebarTabs ariaLabel="记忆状态" options={tabs} value={view} onValueChange={setView} />
    {view !== "pending" && <SidebarFilters ariaLabel="记忆分类" options={categories.map(value => ({ value, label: categoryLabels[value] }))} value={category} onValueChange={setCategory} />}
    {error && <p role="alert" className="text-ui text-danger">{error}<Button size="sm" disabled={busy} onClick={() => { setError(null); void load().catch(reason => setError(getErrorMessage(reason))); }}>重新加载</Button></p>}
    {notice && <p role="status" className="text-ui text-text-secondary">{notice}</p>}
    <HomeSidebarList label="记忆列表" variant="todo">
    {scope.kind === "workspace" && <div id="memory-behavior-panel" className="grid transition-[grid-template-rows] duration-[var(--duration-standard)] ease-[var(--ease-soft)] motion-reduce:transition-none" style={{ gridTemplateRows: behaviorOpen ? "1fr" : "0fr" }} inert={!behaviorOpen} aria-hidden={!behaviorOpen}>
      <div className="min-h-0 overflow-hidden">{behaviorMounted && capturedBinding && <><MemoryBehaviorEditor binding={capturedBinding} /><MemoryScheduleEditor binding={capturedBinding} /></>}</div>
    </div>}
    {editing !== null && <MemoryEditor key={editing === "new" ? "new" : editing.id} fact={editing === "new" ? undefined : editing} categories={categories} busy={busy} onCancel={() => setEditing(null)} onSave={fields => {
      if (editing === "new") void apply([{ action: "add", scope, ...fields }]);
      else { const { category: _category, ...patch } = fields; void apply([{ action: "patch", scope, id: editing.id, expectedRevision: editing.revision, ...patch }]); }
    }} />}
      {!data && !error && <p className="memory-dialog__empty" role="status">正在读取…</p>}
      {data && view === "pending" && <>
        {proposals.length === 0 && <p className="memory-dialog__empty">没有待批准的整理</p>}
        {proposals.map(proposal => <article className="memory-fact" key={proposal.id}>
          <p className="text-caption text-text-secondary">{new Date(proposal.createdAt).toLocaleString()} · 整组批准或拒绝</p>
          {proposal.changes.map((change, index) => <ProposalChange key={index} change={change} facts={facts} />)}
          <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void run({ operation: "approve", requestId: crypto.randomUUID(), proposalId: proposal.id })}>批准</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run({ operation: "reject", requestId: crypto.randomUUID(), proposalId: proposal.id })}>拒绝</Button></div>
        </article>)}
      </>}
      {data && view !== "pending" && <>
        {shown.length === 0 && <p className="memory-dialog__empty">没有符合条件的记忆</p>}
        {shown.map(fact => <article key={fact.id} className="memory-fact">
          <p className="text-caption text-text-secondary">{categoryLabels[fact.category]} · {stateLabels[fact.state]} · {fact.confirmation === "confirmed" ? "已确认" : "推断"}{fact.core && " · 核心"}{fact.locked && " · 整理已锁定"}{validity(fact) && ` · ${validity(fact)}`}</p>
          <p className="memory-fact__content">{fact.content}</p>
          {fact.condition && <p className="text-ui text-text-secondary">适用条件：{fact.condition}</p>}
          {(fact.validFrom || fact.validTo) && <p className="text-caption text-text-secondary">有效期：{fact.validFrom ?? "不限"} — {fact.validTo ?? "不限"}</p>}
          <div className="flex flex-wrap gap-1">
            {(fact.state === "active" || fact.state === "disabled") && <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(fact)}>编辑</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply([{ action: fact.state === "disabled" ? "enable" : "disable", scope, id: fact.id, expectedRevision: fact.revision }])}>{fact.state === "disabled" ? "启用" : "停用"}</Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void apply([{ action: "forget", scope, id: fact.id, expectedRevision: fact.revision }])}>忘记</Button>
            </>}
            {fact.rollbackId && recent(fact) && <Button size="sm" variant="ghost" disabled={busy} title="撤销整次原子整理，包括同时合并的其他记忆；后续编辑会阻止撤销" onClick={() => void run({ operation: "rollback", requestId: crypto.randomUUID(), rollbackId: fact.rollbackId! })}>撤销本次整理</Button>}
          </div>
          <button type="button" className="text-left text-ui text-text-secondary" aria-expanded={expandedSources.has(fact.id)} aria-controls={`${sourcesId}-${fact.id}`} onClick={() => setExpandedSources(current => {
            const next = new Set(current); if (next.has(fact.id)) next.delete(fact.id); else next.add(fact.id); return next;
          })}>来源（{fact.sources.length}）</button>
          <div id={`${sourcesId}-${fact.id}`} className="grid text-ui text-text-secondary transition-[grid-template-rows] duration-[var(--duration-standard)] ease-[var(--ease-soft)] motion-reduce:transition-none" style={{ gridTemplateRows: expandedSources.has(fact.id) ? "1fr" : "0fr" }} aria-hidden={!expandedSources.has(fact.id)} inert={!expandedSources.has(fact.id)}><div className="min-h-0 overflow-hidden">
            {fact.sources.length === 0 && <p>无关联来源</p>}
            {fact.sources.map((source, index) => <div key={`${source.kind}:${source.id}:${index}`} className="memory-fact__source"><p>{source.label} · {source.kind === "message" ? "对话" : source.kind === "file" ? "文件" : "笔记"}</p>
              <p>{source.availability === "source_removed" ? "源文件已移除，历史结论继续有效" : source.availability === "access_denied" ? "当前没有原文读取权限" : source.availability === "available" ? "原文可回读" : "当前可用性尚未核验"}</p>
              {source.excerpt && <><p className="text-caption">保存时的来源摘录</p><blockquote>{source.excerpt}</blockquote></>}
              {source.kind === "file" && source.reference && source.availability === "available" && <Button size="sm" variant="ghost" onClick={() => {
                void binding.current!.then(captured => openReference({ refKind: "document", refId: Number(source.reference!.object.id), label: source.label, sourceRef: source.reference! }, captured)).catch(reason => setError(getErrorMessage(reason)));
              }}>查看原文</Button>}
            </div>)}
          </div></div>
        </article>)}
      </>}
    </HomeSidebarList>
  </Dialog>;
}
function MemoryEditor({ fact, categories, busy, onSave, onCancel }: { fact?: MemoryFact; categories: MemoryCategory[]; busy: boolean; onSave: (fields: { content: string; condition: string | null; core: boolean; category: MemoryCategory }) => void; onCancel: () => void }) {
  const [content, setContent] = useState(fact?.content ?? "");
  const [condition, setCondition] = useState(fact?.condition ?? "");
  const [core, setCore] = useState(fact?.core ?? false);
  const [category, setCategory] = useState<MemoryCategory>(fact?.category ?? categories[0]);
  const workspace = !categories.includes("agreement");
  const canBeCore = workspace && !condition.trim();
  return <form className="memory-editor" onSubmit={event => { event.preventDefault(); if (content.trim()) onSave({ content: content.trim(), condition: condition.trim() || null, core: core && canBeCore, category }); }}>
    {!fact && <label className="text-ui text-text-secondary">分类<select aria-label="分类" className="memory-editor__select" value={category} onChange={event => setCategory(event.target.value as MemoryCategory)}>{categories.map(value => <option key={value} value={value}>{categoryLabels[value]}</option>)}</select></label>}
    <label className="text-ui text-text-secondary">内容<TextField aria-label="内容" value={content} onChange={event => setContent(event.target.value)} required /></label>
    <label className="text-ui text-text-secondary">适用条件<TextField aria-label="适用条件" value={condition} placeholder="留空表示无附加条件" onChange={event => setCondition(event.target.value)} /></label>
    {workspace && <label className="flex items-center gap-2 text-ui text-text-secondary"><input type="checkbox" checked={core && canBeCore} disabled={!canBeCore} onChange={event => setCore(event.target.checked)} />核心记忆{!canBeCore && "（仅适用于无场景限制的全局记忆）"}</label>}
    <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !content.trim()}>保存</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button></div>
  </form>;
}

function ProposalChange({ change, facts }: { change: MemoryChange; facts: MemoryFact[] }) {
  const targetId = "id" in change ? change.id : null;
  const target = facts.find(fact => fact.id === targetId);
  const actionLabels = { add: "新增", patch: "修改", merge: "合并", disable: "停用", enable: "启用", forget: "忘记" };
  return <div className="text-ui text-text-secondary">
    <p className="text-body text-text">{actionLabels[change.action]}：{"content" in change ? change.content ?? target?.content ?? targetId : target?.content ?? targetId}</p>
    {change.action === "add" && <p>分类：{categoryLabels[change.category]}</p>}
    {"condition" in change && <p>适用条件：{change.condition || "无附加条件"}</p>}
    {"core" in change && <p>核心记忆：{change.core ? "是" : "否"}</p>}
    {"validFrom" in change && <p>生效时间：{change.validFrom ?? "不限"}</p>}
    {"validTo" in change && <p>失效时间：{change.validTo ?? "不限"}</p>}
    {change.action === "merge" && <p>同时合并：{change.from.map(source => facts.find(fact => fact.id === source.id)?.content ?? source.id).join("；")}</p>}
  </div>;
}

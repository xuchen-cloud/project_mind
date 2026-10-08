import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentBlockInput, AgentOperationEntry, AgentRuntimeOutput, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { InternalReferenceResolveResult } from "../../lib/types";
import type { RecordVersionDifference } from "../../lib/record-version-compare";
import { agentApi } from "../../services/agentApi";
import { projectMindApi } from "../../services/projectMindApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { Button, Dialog, StatusBadge, SurfaceCard } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { AgentSourceCard } from "./AgentSourceCard";
import { agentFailureMessage } from "./useAgentConversation";

export interface AgentOutputCardProps {
  binding: AgentWorkspaceBinding; output: AgentRuntimeOutput; operation: AgentOperationEntry | null;
  runActive?: boolean;
  onCommit: () => Promise<void>; onUndo: () => Promise<void>; onRestore: () => Promise<void>;
}
const statusLabels = { staged: "待保存", committing: "正在保存", committed: "已保存", failed: "保存失败" };
const modeLabels = { collaborate: "协作 · 自动保存", review: "确认后保存", read_only: "只读" };
const operationLabels = { replace: "替换块", delete: "删除块", insert_after: "插入块", append: "追加块", append_inline: "追加文本" };
function blockText(block: AgentBlockInput): string {
  return block.text ?? block.content?.map(blockText).join("") ?? "";
}
export function recordCandidatePreview(output: AgentRuntimeOutput): string {
  if (output.intent.intent === "record_create") return output.intent.markdown;
  if (output.intent.intent === "record_patch") return output.intent.patch.operations.map(edit => {
    const text = edit.op === "replace" ? blockText(edit.block) : edit.op === "append_inline" ? edit.text
      : edit.op === "append" || edit.op === "insert_after" ? edit.blocks.map(blockText).join("\n") : "";
    return `${operationLabels[edit.op]}${text ? `\n${text}` : ""}`;
  }).join("\n\n");
  return "";
}

/** Keying on workspace generation prevents an old resolve or mutation from updating this card. */
export function AgentOutputCard(props: AgentOutputCardProps) {
  return <OutputCardBody key={`${props.binding.workspaceId}:${props.binding.generation}:${props.output.id}`} {...props} />;
}
function OutputCardBody({ binding, output, operation, runActive = false, onCommit, onUndo, onRestore }: AgentOutputCardProps) {
  const navigate = useNavigate();
  const [resolved, setResolved] = useState<InternalReferenceResolveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [shown, setShown] = useState(6000);
  const [diff, setDiff] = useState<RecordVersionDifference | null>(null);
  const [patchPreview, setPatchPreview] = useState<Awaited<ReturnType<typeof agentApi.outputPreview>> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setConfirmation(false); }, [output.revision, output.mode, output.state]);
  const reviewPatch = output.mode === "review" && output.intent.intent === "record_patch";
  useEffect(() => {
    setPatchPreview(null); setPreviewError(null); setPreviewLoading(false);
    if (!confirmation || !reviewPatch) return;
    let cancelled = false;
    setPreviewLoading(true);
    void agentApi.outputPreview(binding, { outputId: output.id, expectedRevision: output.revision })
      .then(result => { if (!cancelled && active.current) setPatchPreview(result); })
      .catch(failure => {
        if (cancelled || !active.current) return;
        const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null;
        setPreviewError(code === "REVISION_CONFLICT" || code === "SOURCE_CHANGED"
          ? "记录基线或候选已变化，无法确认保存。请刷新成果并重新生成候选。"
          : `真实差异加载失败：${agentFailureMessage(failure)} 请关闭后重试。`);
      }).finally(() => { if (!cancelled && active.current) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [confirmation, reviewPatch, output.id, output.revision, binding.workspaceId, binding.generation]);
  const record = output.object ?? (output.intent.intent === "record_patch" ? output.intent.patch.record : null);
  const recordIdentity = JSON.stringify(record);
  async function checkBinding() {
    const current = (await agentApi.statusGet()).binding;
    if (!active.current) return false;
    if (!current || current.workspaceId !== binding.workspaceId || current.generation !== binding.generation) throw new Error("工作区已切换，未操作旧成果。");
    return true;
  }
  async function resolveRecord() {
    if (!record || record.kind !== "record" || !(await checkBinding())) return null;
    const reference = await projectMindApi.internalReferenceResolve({ kind: record.scope.kind === "workspace" ? "workspace_record" : "note", id: Number(record.id) });
    if (!active.current || !(await checkBinding())) return null;
    if (!reference) throw new Error("记录已删除或已撤回，请查看成果状态。");
    if (reference.scope !== record.scope.kind || (record.scope.kind === "project" && reference.projectId !== record.scope.projectId)) throw new Error("记录所属范围已变化，未打开旧成果。");
    return reference;
  }
  useEffect(() => {
    if (!record || operation?.recovery?.withdrawn) return;
    let cancelled = false;
    void resolveRecord().then(reference => { if (!cancelled && active.current) setResolved(reference); })
      .catch(failure => { if (!cancelled && active.current) setError(agentFailureMessage(failure)); });
    return () => { cancelled = true; };
  }, [recordIdentity, operation?.recovery?.withdrawn]);

  async function action(callback: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await callback(); if (active.current) setConfirmation(false); }
    catch (failure) { if (active.current) { setError(agentFailureMessage(failure)); setConfirmation(false); } }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function openRecord() {
    const reference = await resolveRecord();
    if (reference && active.current) { setResolved(reference); navigate(reference.route); }
  }
  async function compare() {
    if (!record || !operation?.beforeSnapshotRef || !operation.afterSnapshotRef) return;
    const result = await recordDocumentApi.versionsCompare(binding, { scope: record.scope, recordId: Number(record.id) }, operation.beforeSnapshotRef, operation.afterSnapshotRef);
    if (active.current) setDiff(result);
  }
  const isRecord = output.intent.intent === "record_create" || output.intent.intent === "record_patch";
  if (!isRecord) return null;
  const title = output.intent.intent === "record_create" ? output.intent.title : resolved?.label ?? "现有记录";
  const preview = recordCandidatePreview(output);
  const canSave = output.mode !== "read_only" && (output.state === "staged" && (output.mode === "review" || !runActive) || output.state === "failed");
  const withdrawn = operation?.recovery?.withdrawn ?? false;
  const restored = !withdrawn && operation?.recovery?.withdrawalRevision != null;
  const patchPreviewReady = patchPreview?.outputId === output.id && patchPreview.revision === output.revision
    && output.intent.intent === "record_patch" && patchPreview.baseRevision === output.intent.patch.baseRevision;
  const save = () => output.mode === "review" ? setConfirmation(true) : void action(onCommit);
  const candidate = <><p className="agent-panel__hint">{output.intent.intent === "record_create" ? "新建记录候选正文" : `修改候选 · 基于修订 ${output.intent.intent === "record_patch" ? output.intent.patch.baseRevision : ""}`}</p>
    <pre className="agent-message__text">{preview.slice(0, shown)}</pre>
    {shown < preview.length ? <Button size="sm" variant="ghost" onClick={() => setShown(count => count + 6000)}>显示更多候选内容</Button> : null}</>;
  return <SurfaceCard as="article" className="agent-output">
    <div className="agent-output__heading"><strong>{title || "未命名记录"}</strong><StatusBadge tone={output.state === "failed" ? "danger" : output.state === "committed" ? "success" : "neutral"}>{statusLabels[output.state]}</StatusBadge></div>
    <p className="agent-panel__hint">{output.intent.intent === "record_create" ? "新建记录" : "修改记录"} · {modeLabels[output.mode]}{withdrawn ? " · 已撤回，可恢复" : restored ? " · 已恢复" : operation?.undoState === "undone" ? " · 已撤销" : ""}</p>
    {output.state === "committed" && output.mode === "collaborate" ? <p className="agent-panel__hint">本次运行已自动保存此成果。停止运行不会撤销已保存的修改。</p> : null}
    {output.state === "staged" && output.mode === "collaborate" ? <p className="agent-panel__hint">{runActive ? "等待助手保存，可刷新查看结果。" : "运行已结束，此候选尚未保存，可手动重试。"}</p> : null}
    {output.errorCode && output.state === "failed" ? <p role="alert" className="agent-output__error">{agentFailureMessage({ code: output.errorCode })}</p> : null}
    <details><summary>{output.state === "committed" ? "查看保存的候选内容" : "查看候选内容"}</summary>{candidate}</details>
    {operation?.beforeRevision != null && operation.afterRevision != null ? <p className="agent-panel__hint">记录修订 {operation.beforeRevision} → {operation.afterRevision}</p> : null}
    {diff ? <p className="agent-panel__hint">实际版本差异：新增 {diff.added.length} 块，删除 {diff.deleted.length} 块，修改 {diff.modified.length} 块，移动 {diff.moved.length} 块。</p> : null}
    {output.sources.length ? <details><summary>成果来源（{output.sources.length}）</summary>{output.sources.map((source, index) => <div key={`${index}:${source.revision}`}>
      {output.sourceChanged[index] ? <p className="agent-panel__hint">此来源在保存时已变化，请核对引用版本。</p> : null}<AgentSourceCard source={source} binding={binding} /></div>)}</details> : null}
    {error ? <p role="alert" className="agent-output__error">{error}</p> : null}
    <div className="agent-output__actions">
      {canSave ? <Button size="sm" disabled={busy} onClick={save}>{busy ? "正在保存…" : output.state === "failed" || output.mode === "collaborate" ? "重试保存" : "确认保存"}</Button> : null}
      {record && !withdrawn ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(openRecord)}>打开记录</Button> : null}
      {operation?.beforeSnapshotRef && operation.afterSnapshotRef ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(compare)}>查看实际版本差异</Button> : null}
      {operation?.undoState === "available" && operation.afterRevision != null ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(onUndo)}>{operation.kind === "record.create" ? "撤回创建" : "撤销修改"}</Button> : null}
      {operation?.recovery?.restoreAvailable && operation.recovery.withdrawalRevision != null ? <Button size="sm" disabled={busy} onClick={() => void action(onRestore)}>恢复记录</Button> : null}
    </div>
    <Dialog open={confirmation} onClose={() => { if (!pending.current) setConfirmation(false); }} title="确认保存成果"
      description="将此候选成果保存到记录。此确认使用成果所属运行的模式。"
      bodyClassName="agent-output-dialog-body"
      footer={<><Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmation(false)}>取消</Button><Button size="sm" variant="primary" disabled={busy || reviewPatch && !patchPreviewReady} onClick={() => { if (!reviewPatch || patchPreviewReady) void action(onCommit); }}>{busy ? "正在处理…" : "保存成果"}</Button></>}>
      <HomeSidebarList label="待确认成果">
        {reviewPatch && previewLoading ? <p className="agent-panel__hint" role="status">正在核对记录基线并计算真实差异…</p> : null}
        {reviewPatch && previewError ? <p className="agent-output__error" role="alert">{previewError}</p> : null}
        {reviewPatch && patchPreview && !patchPreviewReady ? <p className="agent-output__error" role="alert">差异对应的候选或记录基线已变化，请刷新成果后重新确认。</p> : null}
        {reviewPatch && patchPreviewReady ? <p className="agent-panel__hint">真实差异 · 基于修订 {patchPreview.baseRevision}：新增 {patchPreview.difference.added.length} 块，修改 {patchPreview.difference.modified.length} 块，删除 {patchPreview.difference.deleted.length} 块，移动 {patchPreview.difference.moved.length} 块。</p> : null}
        {candidate}
      </HomeSidebarList>
    </Dialog>
  </SurfaceCard>;
}

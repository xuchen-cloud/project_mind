import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentBlockInput, AgentOperationEntry, AgentRecordOutputPreview, AgentRuntimeOutput, AgentTodoMutation, AgentTodoNewChild, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { InternalReferenceResolveResult } from "../../lib/types";
import { todoPriorityOptionLabel } from "../../lib/todo-priority";
import { revealAgentObjectPage } from "../../lib/agent-panel-navigation";
import { agentApi } from "../../services/agentApi";
import { projectMindApi } from "../../services/projectMindApi";
import { isHtmlPreviewFile, openFilePreview } from "../../state/file-preview-store";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { Button, StatusBadge, SurfaceCard } from "../../ui/components";
import { AgentSourceCard } from "./AgentSourceCard";
import { agentFailureMessage } from "./useAgentConversation";

export interface AgentOutputCardProps {
  binding: AgentWorkspaceBinding; output: AgentRuntimeOutput; operation: AgentOperationEntry | null;
  recoveryOperation?: AgentOperationEntry | null; hideRestore?: boolean;
  runActive?: boolean;
  presentation?: "standalone" | "link" | "details";
  reviewCurrent?: boolean; groupBusy?: boolean; hideUndo?: boolean;
  failure?: unknown;
  onCommit: () => Promise<void>; onDismiss: () => Promise<void>; onUndo: () => Promise<void>; onRestore: () => Promise<void>;
}
const operationLabels = { replace: "替换块", delete: "删除块", insert_after: "插入块", append: "追加块", append_inline: "追加文本" };
function blockText(block: AgentBlockInput): string {
  return block.text ?? block.content?.map(blockText).join("") ?? "";
}
function deadlineText(dueDate: string | null): string { return dueDate ?? "无期限"; }
function tagText(tagIds: number[]): string { return tagIds.length ? tagIds.map(id => `#${id}`).join("、") : "无标签"; }
function childText(child: AgentTodoNewChild): string {
  return `${child.content}\n子项日期：${child.progressDate} · 期限：${deadlineText(child.dueDate)}`;
}
function todoChangeText(edit: AgentTodoMutation): string {
  switch (edit.change) {
    case "content": return `内容改为：\n${edit.content}`;
    case "deadline": return `期限改为：${deadlineText(edit.dueDate)}`;
    case "status": return `状态改为：${edit.status === "finished" ? "已完成" : "未完成"}`;
    case "priority": return `优先级改为：${todoPriorityOptionLabel(edit.priority)}`;
    case "tags": return `标签改为：${tagText(edit.tagIds)}`;
    case "child_create": return `新增子项：\n${childText(edit)}`;
    case "child_update": return `修改子项 #${edit.childId}：\n${childText(edit)}\n状态：${edit.status === "finished" ? "已完成" : "未完成"}`;
    case "child_delete": return `删除子项 #${edit.childId}`;
  }
}
export function outputCandidatePreview(output: AgentRuntimeOutput): string {
  if (output.intent.intent === "record_create") return output.intent.markdown;
  if (output.intent.intent === "record_patch") return output.intent.patch.operations.map(edit => {
    const text = edit.op === "replace" ? blockText(edit.block) : edit.op === "append_inline" ? edit.text
      : edit.op === "append" || edit.op === "insert_after" ? edit.blocks.map(blockText).join("\n") : "";
    return `${operationLabels[edit.op]}${text ? `\n${text}` : ""}`;
  }).join("\n\n");
  if (output.intent.intent === "todo_create") {
    const todo = output.intent;
    return `内容：\n${todo.content}\n\n优先级：${todoPriorityOptionLabel(todo.priority)}\n期限：${deadlineText(todo.dueDate)}\n标签：${tagText(todo.tagIds)}\n子项（${todo.children.length}）：${todo.children.length ? "\n" + todo.children.map(childText).join("\n\n") : "无"}`;
  }
  if (output.intent.intent === "todo_update") return output.intent.changes.map(todoChangeText).join("\n\n");
  if (output.intent.intent === "file_create") return output.intent.utf8Content;
  if (output.intent.intent === "file_update") return "上传内容已暂存，确认后保存到文件。";
  if (output.intent.intent === "file_patch") return output.intent.patch.edits?.map(edit => `替换内容：\n${edit.oldText}\n→\n${edit.newText}`).join("\n\n") ?? output.intent.patch.appendText ?? "";
  if (output.intent.intent === "file_restore") return "恢复选定历史版本的文件内容。";
  return "";
}

/** Keying on workspace generation prevents an old resolve or mutation from updating this card. */
export function AgentOutputCard(props: AgentOutputCardProps) {
  return <OutputCardBody key={`${props.binding.workspaceId}:${props.binding.generation}:${props.output.id}`} {...props} />;
}
function OutputCardBody({ binding, output, operation, recoveryOperation, hideRestore = false, runActive = false, presentation = "standalone", reviewCurrent = false, groupBusy = false, hideUndo = false, failure, onCommit, onDismiss, onUndo, onRestore }: AgentOutputCardProps) {
  const navigate = useNavigate();
  const [resolved, setResolved] = useState<InternalReferenceResolveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(6000);
  const [previewResult, setPreviewResult] = useState<AgentRecordOutputPreview | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const revision = useRef(output.revision);
  revision.current = output.revision;
  useEffect(() => { setError(null); setPreviewResult(null); }, [output.revision]);
  const isRecord = output.intent.intent === "record_create" || output.intent.intent === "record_patch";
  const isTodo = output.intent.intent === "todo_create" || output.intent.intent === "todo_update";
  const isFile = output.intent.intent === "file_create" || output.intent.intent === "file_update" || output.intent.intent === "file_patch" || output.intent.intent === "file_restore";
  const objectLabel = isFile ? "文件" : isTodo ? "待办" : "记录";
  const object = output.object ?? (output.intent.intent === "record_patch" ? output.intent.patch.record : output.intent.intent === "todo_update" || output.intent.intent === "file_update" ? output.intent.target : output.intent.intent === "file_patch" ? output.intent.patch.object : output.intent.intent === "file_restore" ? output.intent.restore.object : null);
  const objectIdentity = JSON.stringify(object);
  const recovery = (recoveryOperation ?? operation)?.recovery;
  const withdrawn = recovery?.withdrawn ?? false;
  const restored = !withdrawn && recovery?.withdrawalRevision != null;
  const undone = operation?.undoState === "undone";
  async function checkBinding() {
    const current = (await agentApi.statusGet()).binding;
    if (!active.current) return false;
    if (!current || current.workspaceId !== binding.workspaceId || current.generation !== binding.generation) throw new Error("工作区已切换，未操作旧成果。");
    return true;
  }
  async function resolveObject() {
    if (!object || !(isRecord || isTodo || isFile) || !(await checkBinding())) return null;
    const kind = isFile ? "document" : isTodo ? "todo" : object.scope.kind === "workspace" ? "workspace_record" : "note";
    const reference = await projectMindApi.internalReferenceResolve({ kind, id: Number(object.id) });
    if (!active.current || !(await checkBinding())) return null;
    if (!reference) throw new Error(`${objectLabel}已删除或已撤回，请查看成果状态。`);
    if (reference.kind !== kind || reference.id !== Number(object.id) || reference.scope !== object.scope.kind || (object.scope.kind === "project" && reference.projectId !== object.scope.projectId)) throw new Error(`${objectLabel}所属对象或范围已变化，未打开旧成果。`);
    return reference;
  }
  useEffect(() => {
    if (!object || withdrawn || presentation === "details") return;
    let stale = false;
    void resolveObject().then(reference => { if (!stale && active.current) setResolved(reference); })
      .catch(failure => { if (!stale && active.current) setError(agentFailureMessage(failure)); });
    return () => { stale = true; };
  }, [objectIdentity, withdrawn, presentation]);
  async function action(callback: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await callback(); }
    catch (failure) { if (active.current) setError(agentFailureMessage(failure)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function openObject() {
    const reference = await resolveObject();
    if (!reference || !active.current) return;
    if (isFile && isHtmlPreviewFile({ name: reference.label })) {
      const workspace = (await projectMindApi.workspaceStatusGet()).currentWorkspace;
      if (!workspace || !(await checkBinding())) throw new Error("工作区已切换，未打开旧成果。");
      if (reference.projectId === null) throw new Error("文件所属项目不可用。");
      setResolved(reference);
      openFilePreview({ workspaceRoot: workspace.rootPath, projectId: reference.projectId, documentId: reference.id, title: reference.label });
      return;
    }
    setResolved(reference); navigate(reference.route); revealAgentObjectPage();
  }
  async function continueDiscussion() {
    const reference = await resolveObject();
    if (!reference || !object || !active.current) return;
    if (!isFile || !isHtmlPreviewFile({ name: reference.label })) navigate(reference.route);
    if (!useAgentPanelStore.getState().setDiscussionTarget(binding, object, reference.label)) {
      throw new Error("请先在此对象所属范围打开助手，再继续讨论。");
    }
  }
  async function previewChanges() {
    if (output.intent.intent !== "record_patch" || !(await checkBinding())) return;
    const expectedRevision = output.revision;
    const actual = await agentApi.outputPreview(binding, { outputId: output.id, expectedRevision });
    if (!active.current || !(await checkBinding())) return;
    if (revision.current !== expectedRevision || actual.outputId !== output.id || actual.revision !== expectedRevision || actual.baseRevision !== output.intent.patch.baseRevision) throw new Error("候选或基线已变化，请读取当前成果后查看差异。");
    setPreviewResult(actual);
  }
  if (!isRecord && !isTodo && !isFile) return null;
  const created = output.intent.intent === "record_create" || output.intent.intent === "todo_create" || output.intent.intent === "file_create";
  const title = output.intent.intent === "record_create" ? output.intent.title : output.intent.intent === "todo_create"
    ? output.intent.content.length > 72 ? `${output.intent.content.slice(0, 72)}…` : output.intent.content
    : output.intent.intent === "file_create" ? output.intent.safeName : resolved?.label ?? `这条${objectLabel}`;
  let proposal: string;
  if (output.intent.intent === "record_create") proposal = `我将创建记录“${title || "未命名记录"}”。`;
  else if (output.intent.intent === "record_patch") proposal = `我将更新“${title}”，调整 ${output.intent.patch.operations.length} 处内容。`;
  else if (output.intent.intent === "todo_create") proposal = `我将新增待办“${title}”${output.intent.children.length ? `，并添加 ${output.intent.children.length} 个子项` : ""}。`;
  else if (output.intent.intent === "todo_update") {
    const fields = [...new Set(output.intent.changes.flatMap(change => change.change === "content" ? ["内容"] : change.change === "deadline" ? ["期限"]
      : change.change === "status" ? ["状态"] : change.change === "priority" ? ["优先级"] : change.change === "tags" ? ["标签"] : []))];
    const children = output.intent.changes.filter(change => change.change.startsWith("child_")).length;
    proposal = `我将更新“${title}”${fields.length ? `的${fields.join("、")}` : ""}${children ? `，调整 ${children} 个子项` : ""}。`;
  } else if (output.intent.intent === "file_create") proposal = `我将创建文件“${title}”。`;
  else if (output.intent.intent === "file_restore") proposal = `我将把“${title}”恢复为选定历史版本的内容。`;
  else if (isFile) proposal = `我将更新“${title}”的内容。`;
  else proposal = "";
  const writable = output.mode !== "read_only";
  const dismissed = output.dismissed;
  const canExecute = writable && !dismissed && (output.state === "failed" || output.state === "staged" && (output.mode === "review" || !runActive));
  const approved = output.reviewDecision?.decision === "confirm";
  const awaitingReview = canExecute && output.mode === "review" && !approved && presentation === "standalone";
  const canCommit = canExecute && !groupBusy && (presentation === "standalone" || output.mode !== "review" || approved && reviewCurrent && !runActive);
  const saved = output.state === "committed";
  const fileReceipt = isFile ? output.fileReceipt : undefined;
  const savedVersion = fileReceipt?.versionNumber ?? (isFile ? operation?.afterRevision : null);
  const noChange = fileReceipt?.noChange === true;
  const preview = outputCandidatePreview(output);
  if (presentation === "link") return saved && object && !withdrawn ? <>
    <Button size="sm" variant="ghost" disabled={busy || groupBusy} onClick={() => void action(openObject)}>{resolved?.label ?? title}</Button>
    {error ? <span role="alert" className="agent-output__error">{error}</span> : null}
  </> : null;
  return <SurfaceCard as="article" className="agent-output" aria-label={`${objectLabel}操作`}>
    <div className="agent-output__heading">
      <strong>{saved ? withdrawn ? "已撤回" : restored ? "已恢复" : undone ? "已撤销" : "已完成" : dismissed ? "已取消" : "操作提案"}</strong>
      {presentation === "details" ? <span>{title}</span> : null}
      {busy || output.state === "committing" ? <StatusBadge tone="neutral">正在执行…</StatusBadge> : null}
    </div>
    {presentation !== "details" && (saved ? <p className="agent-message__text">{withdrawn ? `已撤回创建的${objectLabel}，可以恢复。` : restored ? `${objectLabel}已恢复。` : undone ? "已撤销此次修改，后续内容保留。" : isFile ? noChange ? `内容已相同${savedVersion != null ? `，仍为 v${savedVersion}` : ""}。` : `文件已保存${savedVersion != null ? `为 v${savedVersion}` : ""}。` : `已${created ? "创建" : "更新"}${objectLabel}。`}
      {object && !withdrawn ? <> <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(openObject)}>{resolved?.label ?? title}</Button></> : null}</p>
      : <p className="agent-message__text">{dismissed ? "已取消，未作更改。" : proposal}</p>)}
    {awaitingReview ? <p className="agent-panel__hint">是否确认执行？</p> : null}
    {!saved && !dismissed && output.mode === "read_only" ? <p className="agent-panel__hint">当前为只读模式，此提案不会执行。</p> : null}
    {!saved && !dismissed && output.mode === "collaborate" ? <p className="agent-panel__hint">{output.state === "staged" && runActive ? "正在处理，可随时停止运行。" : output.state === "staged" ? "此次操作尚未完成，可重试。" : null}</p> : null}
    {output.errorCode && output.state === "failed" && !error && !dismissed ? <p role="alert" className="agent-output__error">{agentFailureMessage({ code: output.errorCode })}</p> : null}
    {failure && !output.errorCode && !error && !saved && !dismissed ? <p role="alert" className="agent-output__error">{agentFailureMessage(failure)}</p> : null}
    {error ? <p role="alert" className="agent-output__error">{error}</p> : null}
    <div className="agent-output__actions">
      {canCommit ? <Button size="sm" disabled={busy} onClick={() => void action(onCommit)}>{busy ? "正在执行…" : awaitingReview ? "确认执行" : "重试"}</Button> : null}
      {awaitingReview ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(onDismiss)}>取消</Button> : null}
      {!hideUndo && !noChange && operation?.undoState === "available" && operation.afterRevision != null ? <Button size="sm" variant="ghost" disabled={busy || groupBusy} onClick={() => void action(onUndo)}>{created ? "撤回创建" : "撤销修改"}</Button> : null}
      {!hideRestore && recovery?.restoreAvailable && recovery.withdrawalRevision != null ? <Button size="sm" disabled={busy || groupBusy} onClick={() => void action(onRestore)}>恢复{objectLabel}</Button> : null}
      {saved && object && !withdrawn ? <Button size="sm" variant="ghost" disabled={busy || groupBusy} onClick={() => void action(continueDiscussion)}>继续讨论</Button> : null}
    </div>
    <details><summary>查看详情</summary>
      {output.intent.intent === "record_patch" && !saved && !dismissed ? <>
        <Button size="sm" variant="ghost" disabled={busy || groupBusy} onClick={() => void action(previewChanges)}>查看实际差异</Button>
        {previewResult ? <p className="agent-panel__hint">基于 v{previewResult.baseRevision} 的实际差异：新增 {previewResult.difference.added.length} 块，修改 {previewResult.difference.modified.length} 块，移动 {previewResult.difference.moved.length} 块，删除 {previewResult.difference.deleted.length} 块。</p> : null}
      </> : null}
      <pre className="agent-message__text">{preview.slice(0, shown)}</pre>
      {shown < preview.length ? <Button size="sm" variant="ghost" onClick={() => setShown(count => count + 6000)}>显示更多候选内容</Button> : null}
    </details>
    {output.sources.length ? <details><summary>查看来源（{output.sources.length}）</summary>{output.sources.map((source, index) => <div key={`${index}:${source.revision}`}>
      {output.sourceChanged[index] ? <p className="agent-panel__hint">此来源已变化，可核对引用版本。</p> : null}<AgentSourceCard source={source} binding={binding} /></div>)}</details> : null}
  </SurfaceCard>;
}

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAgentReviewPlan, type AgentReviewHandle } from "../../hooks/useAgentReviewPlan";
import type { AgentOperationEntry, AgentRuntimeOutput, AgentWorkspaceBinding } from "../../lib/agent-types";
import { groupAgentOperations, type AgentOperationGroup } from "../../lib/agent-operation-groups";
import { queryKeys } from "../../lib/queryKeys";
import { agentApi } from "../../services/agentApi";
import { Button } from "../../ui/components";
import { AgentOutputCard } from "./AgentOutputCard";
import { agentFailureMessage } from "../../lib/agent-errors";

export interface AgentRunOutputsProps { binding: AgentWorkspaceBinding; runId: string; active?: boolean; current?: boolean; refreshToken?: string; onReviewChange?: (handle: AgentReviewHandle | null) => void }
export function AgentRunOutputs(props: AgentRunOutputsProps) {
  return <RunOutputsBody key={`${props.binding.workspaceId}:${props.binding.generation}:${props.runId}`} {...props} />;
}
function RunOutputsBody({ binding, runId, active: runActive = false, current: runCurrent = false, refreshToken, onReviewChange }: AgentRunOutputsProps) {
  const queryClient = useQueryClient();
  const [outputs, setOutputs] = useState<AgentRuntimeOutput[]>([]);
  const [operations, setOperations] = useState<AgentOperationEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [operationCursor, setOperationCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoFailures, setUndoFailures] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const undoing = useRef(false);
  const latest = useRef({ runActive, reviewBusy: false });
  latest.current.runActive = runActive;
  const reading = useRef(false);
  const refreshPending = useRef(false);
  const readVersion = useRef(0);
  const changing = useRef(new Set<string>());
  const requestIds = useRef(new Map<string, string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const merge = <T extends { id: string }>(existing: T[], incoming: T[]) => {
    const byId = new Map(existing.map(value => [value.id, value]));
    incoming.forEach(value => byId.set(value.id, value));
    return [...byId.values()];
  };
  const mergeOperations = (existing: AgentOperationEntry[], incoming: AgentOperationEntry[]) => {
    const byId = new Map(existing.map(value => [value.operationId, value]));
    incoming.forEach(value => byId.set(value.operationId, value));
    return [...byId.values()];
  };
  async function readAllOutputs() {
    let next: string | null = null;
    let values: AgentRuntimeOutput[] = [];
    do {
      const page = await agentApi.outputList(binding, { runId, cursor: next, limit: 50 });
      values = merge(values, page.outputs); next = page.nextCursor;
      if (values.length > 256 || values.length === 256 && next) throw new Error("此方案超过 256 项，请读取当前成果后调整方案。");
    } while (next);
    return values;
  }
  async function load(append = false, background = false) {
    if (reading.current) { if (!append && !background) refreshPending.current = true; return; }
    reading.current = true;
    const version = readVersion.current;
    if (!background) { setLoading(true); setError(null); setComplete(false); }
    try {
      const full = !runActive;
      const [page, receipts] = await Promise.all([
        full ? readAllOutputs().then(values => ({ outputs: values, nextCursor: null })) : agentApi.outputList(binding, { runId, cursor: append ? cursor : null, limit: 20 }),
        agentApi.operationList(binding, { runId, limit: 50 }),
      ]);
      let actualOperations = receipts.operations;
      let nextOperation = receipts.nextCursor;
      const committedRequests = page.outputs.filter(output => output.state === "committed" && !output.fileReceipt?.noChange).map(output => `output:${output.id}:${output.revision}`);
      // An original receipt resolves its current recovery state even when the
      // later undo receipt is on another page. Read only until every displayed
      // saved output has that evidence; retain remaining history pagination.
      while (nextOperation && committedRequests.some(requestId => !actualOperations.some(operation => operation.requestId === requestId))) {
        if (!mounted.current || version !== readVersion.current) return;
        const next = await agentApi.operationList(binding, { runId, cursor: nextOperation, limit: 50 });
        actualOperations = mergeOperations(actualOperations, next.operations);
        nextOperation = next.nextCursor;
      }
      if (!mounted.current || version !== readVersion.current) return;
      setOutputs(previous => append || background ? merge(previous, page.outputs) : page.outputs);
      if (!background) setCursor(page.nextCursor);
      else setCursor(previous => previous ?? page.nextCursor);
      setComplete(full || page.nextCursor === null);
      setOperations(previous => background || append ? mergeOperations(previous, actualOperations) : actualOperations);
      if (!background) setOperationCursor(nextOperation);
      else setOperationCursor(previous => previous ?? nextOperation);
    } catch (failure) { if (mounted.current && version === readVersion.current) setError(agentFailureMessage(failure)); }
    finally {
      reading.current = false;
      if (mounted.current && !background) setLoading(false);
      if (mounted.current && refreshPending.current) { refreshPending.current = false; void load(); }
    }
  }
  useEffect(() => { void load(); }, [runActive, runCurrent, refreshToken]);
  useEffect(() => {
    if (!runActive) return;
    const timer = window.setInterval(() => void load(false, true), 2000);
    return () => window.clearInterval(timer);
  }, [runActive]);
  async function moreOperations() {
    if (reading.current || !operationCursor) return;
    reading.current = true; setLoading(true); setError(null);
    const version = readVersion.current;
    try {
      const page = await agentApi.operationList(binding, { runId, cursor: operationCursor, limit: 50 });
      if (mounted.current && version === readVersion.current) { setOperations(previous => mergeOperations(previous, page.operations)); setOperationCursor(page.nextCursor); }
    } catch (failure) { if (mounted.current && version === readVersion.current) setError(agentFailureMessage(failure)); }
    finally {
      reading.current = false;
      if (mounted.current) setLoading(false);
      if (mounted.current && refreshPending.current) { refreshPending.current = false; void load(); }
    }
  }
  async function readAllOperations(): Promise<AgentOperationEntry[]> {
    let next: string | null = null;
    let all: AgentOperationEntry[] = [];
    do {
      const page = await agentApi.operationList(binding, { runId, cursor: next, limit: 50 });
      if (!mounted.current) return all;
      all = mergeOperations(all, page.operations);
      next = page.nextCursor;
    } while (next);
    return all;
  }
  function invalidateRef(object: AgentOperationEntry["object"]) {
    if (!mounted.current) return;
    void queryClient.invalidateQueries({ queryKey: object.scope.kind === "project" ? queryKeys.projectPage(object.scope.projectId) : queryKeys.workspacePage });
    if (object.kind === "todo") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.todoViews.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.todoCollections.all });
    }
    if (object.kind === "file") void queryClient.invalidateQueries({ queryKey: queryKeys.documentVersions(Number(object.id)) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.searchAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
  }
  async function undoGroups(selectedObjectKey?: string) {
    if (undoing.current || latest.current.runActive || latest.current.reviewBusy || changing.current.size) return;
    undoing.current = true; setUndoBusy(true); setError(null);
    const version = ++readVersion.current;
    try {
      // The visible page is only a preview. Native grouping needs every original receipt.
      const all = await readAllOperations();
      if (!mounted.current || version !== readVersion.current || latest.current.runActive || latest.current.reviewBusy || changing.current.size) return;
      const groups = groupAgentOperations(runId, all).filter(group => group.undo.available > 0 && (!selectedObjectKey || group.objectKey === selectedObjectKey));
      if (!groups.length) { setOperations(all); setOperationCursor(null); return; }
      const operationIds = groups.flatMap(group => group.operationIds);
      if (operationIds.length > 256) throw new Error("本次更改超过 256 条操作记录，无法一次撤销。");
      const status = await agentApi.statusGet();
      if (!mounted.current || version !== readVersion.current || latest.current.runActive || latest.current.reviewBusy) return;
      if (!status.binding || status.binding.workspaceId !== binding.workspaceId || status.binding.generation !== binding.generation) throw new Error("工作区已切换，未撤销旧成果。");
      const result = await agentApi.operationUndoBatch(binding, { runId, operationIds });
      if (!mounted.current || version !== readVersion.current) return;
      const failures: Record<string, string> = {};
      for (const item of result.results) {
        const key = groups.find(group => group.operationIds.some(id => item.operationIds.includes(id)))?.objectKey;
        if (key && item.outcome.status === "failed") failures[key] = agentFailureMessage(item.outcome.error);
        else if (item.outcome.status === "succeeded") invalidateRef(item.object);
      }
      setUndoFailures(previous => {
        const next = { ...previous };
        for (const group of groups) delete next[group.objectKey];
        return { ...next, ...failures };
      });
      // A batch result is per object; current receipt states remain authoritative.
      const actual = await readAllOperations();
      if (!mounted.current || version !== readVersion.current) return;
      setOperations(actual); setOperationCursor(null);
      if (Object.keys(failures).length) setError(`${Object.keys(failures).length} 项撤销未完成，可在下方逐项重试。`);
    } catch (failure) {
      if (mounted.current && version === readVersion.current) {
        setError(agentFailureMessage(failure));
        // A transport error can arrive after a durable native commit.
        try {
          const actual = await readAllOperations();
          if (mounted.current && version === readVersion.current) { setOperations(actual); setOperationCursor(null); }
        } catch { /* Keep the original actionable error. */ }
      }
    } finally {
      undoing.current = false;
      if (mounted.current) setUndoBusy(false);
    }
  }
  function invalidateObject(output: AgentRuntimeOutput) {
    const scope = output.object?.scope ?? (output.intent.intent === "record_create" ? output.intent.scope : output.intent.intent === "record_patch" ? output.intent.patch.record.scope : output.intent.intent === "todo_create" ? output.intent.scope : output.intent.intent === "todo_update" || output.intent.intent === "file_update" ? output.intent.target.scope : output.intent.intent === "file_create" ? { kind: "project" as const, projectId: output.intent.projectId } : output.intent.intent === "file_patch" ? output.intent.patch.object.scope : output.intent.intent === "file_restore" ? output.intent.restore.object.scope : null);
    if (!scope || !mounted.current) return;
    void queryClient.invalidateQueries({ queryKey: scope.kind === "project" ? queryKeys.projectPage(scope.projectId) : queryKeys.workspacePage });
    if (output.intent.intent === "todo_create" || output.intent.intent === "todo_update") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.todoViews.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.todoCollections.all });
    }
    if (output.object?.kind === "file") void queryClient.invalidateQueries({ queryKey: queryKeys.documentVersions(Number(output.object.id)) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.searchAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
  }
  async function mutation<T>(key: string, output: AgentRuntimeOutput, mutate: (requestId: string) => Promise<T>): Promise<T> {
    if (undoing.current) throw new Error("正在撤销本次更改，请等待结算后再操作。");
    if (changing.current.has(output.id)) throw new Error("正在保存此成果，请等待结算。");
    changing.current.add(output.id);
    readVersion.current++;
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID());
    try { return await mutate(requestIds.current.get(key)!); }
    finally { changing.current.delete(output.id); readVersion.current++; }
  }
  async function commit(output: AgentRuntimeOutput): Promise<AgentRuntimeOutput> {
    if (output.state === "committed") return output;
    if (output.dismissed || output.state === "committing" || output.mode === "read_only") throw new Error("此候选当前不可执行。");
    return mutation(`save:${output.id}:${output.revision}`, output, async requestId => {
      try {
        const result = await agentApi.outputCommit(binding, { outputId: output.id, expectedRevision: output.revision }, requestId);
        if (mounted.current) {
          invalidateObject(result.output);
          setOutputs(previous => previous.map(value => value.id === output.id ? result.output : value));
          if (result.operation) setOperations(previous => mergeOperations(previous, [result.operation!]));
        }
        return result.output;
      } catch (failure) {
        // Reconcile durable output state before offering retry; a committed result is never rewritten.
        try { const actual = await agentApi.outputGet(binding, { outputId: output.id });
          if (mounted.current) setOutputs(previous => previous.map(value => value.id === output.id ? actual : value));
        } catch { /* Preserve the original, actionable mutation failure. */ }
        throw failure;
      }
    });
  }
  async function dismiss(output: AgentRuntimeOutput) {
    if (output.dismissed || (output.state !== "staged" && output.state !== "failed")) return;
    await mutation(`dismiss:${output.id}:${output.revision}`, output, async requestId => {
      try {
        const actual = await agentApi.outputDismiss(binding, { outputId: output.id, expectedRevision: output.revision }, requestId);
        if (mounted.current) setOutputs(previous => previous.map(value => value.id === output.id ? actual : value));
      } catch (failure) {
        try { const actual = await agentApi.outputGet(binding, { outputId: output.id });
          if (mounted.current) setOutputs(previous => previous.map(value => value.id === output.id ? actual : value));
        } catch { /* Preserve the actionable dismissal failure. */ }
        throw failure;
      }
    });
  }
  async function undo(output: AgentRuntimeOutput, operation: AgentOperationEntry) {
    if (operation.undoState !== "available" || operation.afterRevision == null) return;
    await mutation(`undo:${operation.operationId}:${operation.afterRevision}`, output, async requestId => {
      await agentApi.operationUndo(binding, { operationId: operation.operationId, expectedHeadRevision: operation.afterRevision! }, requestId);
      if (!mounted.current) return;
      invalidateObject(output);
      const actual = await agentApi.operationGet(binding, { operationId: operation.operationId });
      if (mounted.current) setOperations(previous => mergeOperations(previous, [actual]));
    });
  }
  async function restore(output: AgentRuntimeOutput, operation: AgentOperationEntry) {
    if (!operation.recovery?.restoreAvailable || operation.recovery.withdrawalRevision == null) return;
    await mutation(`restore:${operation.operationId}:${operation.recovery.withdrawalRevision}`, output, async requestId => {
      await agentApi.operationRestoreCreated(binding, { creationOperationId: operation.operationId, expectedWithdrawalRevision: operation.recovery!.withdrawalRevision! }, requestId);
      if (!mounted.current) return;
      invalidateObject(output);
      const actual = await agentApi.operationGet(binding, { operationId: operation.operationId });
      if (mounted.current) setOperations(previous => mergeOperations(previous, [actual]));
    });
  }
  const review = useAgentReviewPlan({ binding, runId, current: true, terminal: !runActive, complete,
    outputs, commitOutput: commit, readOutputs: readAllOutputs,
    applyOutputs: actual => { if (mounted.current) { if (!undoing.current) readVersion.current++; setOutputs(previous => merge(previous, actual)); } },
  });
  latest.current.reviewBusy = review.busy;
  useEffect(() => { onReviewChange?.(review.handle); }, [onReviewChange, review.handle]);
  useEffect(() => () => { onReviewChange?.(null); }, [onReviewChange]);
  async function decide(decision: "confirm" | "cancel") {
    if (undoing.current) return;
    setError(null);
    try { await review.handle?.decide(decision); }
    catch (failure) { if (mounted.current) setError(agentFailureMessage(failure)); }
  }
  const groups = groupAgentOperations(runId, operations);
  function groupFor(output: AgentRuntimeOutput) {
    return output.object ? groups.find(group => JSON.stringify(group.object) === JSON.stringify(output.object)) : undefined;
  }
  function creationReceipt(group?: AgentOperationGroup) {
    return group?.change === "created" ? group.operations.find(entry => ["record.create", "todo.create", "file.create"].includes(entry.kind)) ?? null : null;
  }
  function recoveryStatus(output: AgentRuntimeOutput) {
    const group = groupFor(output);
    const recovery = creationReceipt(group)?.recovery ?? operationFor(output)?.recovery;
    if (recovery?.withdrawn) return "withdrawn";
    if (recovery?.withdrawalRevision != null) return "restored";
    if (group?.undo.state === "undone" || !group && operationFor(output)?.undoState === "undone") return "undone";
    return null;
  }
  const committedObjects = [...new Map(outputs.filter(output => output.state === "committed" && !output.fileReceipt?.noChange && output.object)
    .map(output => [JSON.stringify(output.object), output] as const)).values()];
  const ungroupedObjects = committedObjects.filter(output => !groupFor(output));
  const groupStatus = (group: AgentOperationGroup) => {
    const recovery = creationReceipt(group)?.recovery;
    return recovery?.withdrawn ? "withdrawn" : recovery?.withdrawalRevision != null ? "restored"
      : group.undo.state === "undone" ? "undone" : "saved";
  };
  const saved = groups.filter(group => groupStatus(group) === "saved").length + ungroupedObjects.filter(output => !recoveryStatus(output)).length;
  const unchanged = outputs.filter(output => output.state === "committed" && output.fileReceipt?.noChange).length;
  const withdrawn = groups.filter(group => groupStatus(group) === "withdrawn").length + ungroupedObjects.filter(output => recoveryStatus(output) === "withdrawn").length;
  const restored = groups.filter(group => groupStatus(group) === "restored").length + ungroupedObjects.filter(output => recoveryStatus(output) === "restored").length;
  const undone = groups.filter(group => groupStatus(group) === "undone").length + ungroupedObjects.filter(output => recoveryStatus(output) === "undone").length;
  const cancelled = outputs.filter(output => output.dismissed && output.reviewDecision?.decision === "cancel").length;
  const superseded = outputs.filter(output => output.dismissed && output.reviewDecision?.decision !== "cancel").length;
  const failed = outputs.filter(output => !output.dismissed && output.state !== "committed" && (output.state === "failed" || review.result?.failures.some(failure => failure.outputId === output.id))).length;
  const statuses = [saved ? `已保存 ${saved} 项` : "", unchanged ? `内容相同 ${unchanged} 项` : "", withdrawn ? `已撤回 ${withdrawn} 项` : "", restored ? `已恢复 ${restored} 项` : "", undone ? `已撤销 ${undone} 项` : "", cancelled ? `已取消 ${cancelled} 项` : "", superseded ? `方案已失效 ${superseded} 项` : "", failed ? `${failed} 项未保存` : ""].filter(Boolean);
  const decisions = [...new Map(outputs.flatMap(output => output.reviewDecision ? [[output.reviewDecision.requestId, output.reviewDecision] as const] : [])).values()];
  function operationFor(output: AgentRuntimeOutput) {
    return operations.find(entry => entry.requestId === `output:${output.id}:${output.revision}` && ["record.create", "record.patch", "todo.create", "todo.update", "file.create", "file.version.commit"].includes(entry.kind)) ?? null;
  }
  function latestOutput(group: AgentOperationGroup) {
    const values = outputs.filter(output => output.state === "committed" && output.object && JSON.stringify(output.object) === JSON.stringify(group.object));
    return values.reduce<AgentRuntimeOutput | null>((latest, output) => {
      if (!latest) return output;
      const position = (value: AgentRuntimeOutput) => operations.findIndex(entry => entry.requestId === `output:${value.id}:${value.revision}`);
      const a = position(latest); const b = position(output);
      if (a < 0 || b < 0) return output.ordinal > latest.ordinal ? output : latest;
      return b > a || b === a && output.ordinal > latest.ordinal ? output : latest;
    }, null);
  }
  function card(output: AgentRuntimeOutput, presentation: "link" | "details") {
    const operation = operationFor(output);
    const group = groupFor(output);
    const recoveryOperation = creationReceipt(group);
    return <AgentOutputCard key={output.id} binding={binding} output={output} operation={operation} recoveryOperation={recoveryOperation} hideRestore={!!group && latestOutput(group)?.id !== output.id} presentation={presentation} reviewCurrent={runCurrent} groupBusy={review.busy || undoBusy || runActive} runActive={runActive} hideUndo={!!group} failure={review.result?.failures.find(failure => failure.outputId === output.id)?.error}
      onCommit={async () => { await commit(output); }} onDismiss={() => dismiss(output)} onUndo={() => operation ? undo(output, operation) : Promise.resolve()} onRestore={() => recoveryOperation ? restore(output, recoveryOperation) : operation ? restore(output, operation) : Promise.resolve()} />;
  }
  const undoableGroups = groups.filter(group => group.undo.available > 0);
  function groupLabel(group: AgentOperationGroup) {
    const kind = group.object.kind === "record" ? "记录" : group.object.kind === "todo" ? "待办" : "文件";
    const values = outputs.filter(output => output.object && JSON.stringify(output.object) === JSON.stringify(group.object)).sort((a, b) => b.ordinal - a.ordinal);
    const title = values.map(output => output.intent.intent === "record_create" ? output.intent.title
      : output.intent.intent === "todo_create" ? output.intent.content
      : output.intent.intent === "todo_update" ? output.intent.changes.find(change => change.change === "content")?.content
      : output.intent.intent === "file_create" ? output.intent.safeName : null).find(Boolean);
    const latest = values[0];
    const summary = latest?.intent.intent === "record_patch" ? `调整 ${latest.intent.patch.operations.length} 处内容`
      : latest?.intent.intent === "file_restore" ? "恢复历史版本"
      : latest?.intent.intent === "file_patch" || latest?.intent.intent === "file_update" ? "更新内容" : null;
    return `${group.change === "created" ? "创建" : "修改"}${kind}${title ? `“${title.length > 64 ? `${title.slice(0, 64)}…` : title}”` : summary ? `（${summary}）` : ""}`;
  }
  const linkedOutputs = groups.map(latestOutput).filter((output): output is AgentRuntimeOutput => !!output);
  const seenObjects = new Set(linkedOutputs.map(output => JSON.stringify(output.object)));
  for (const output of outputs) {
    if (output.state !== "committed" || !output.object || seenObjects.has(JSON.stringify(output.object))) continue;
    const key = JSON.stringify(output.object);
    const latest = outputs.filter(value => value.state === "committed" && JSON.stringify(value.object) === key).sort((a, b) => b.ordinal - a.ordinal)[0];
    linkedOutputs.push(latest); seenObjects.add(key);
  }
  if (!outputs.length && !error) return null;
  return <section className="agent-run-outputs" aria-label="助手操作">
    {error ? <p className="agent-output__error" role="alert">{error}</p> : null}
    {review.handle ? <div>
      <p className="agent-message__text">{review.handle.summary}。{review.busy ? "正在处理方案。" : review.handle.confirmed ? "已确认，可继续保存剩余成果。" : "是否确认执行？"}</p>
      <div className="agent-output__actions">
        <Button size="sm" disabled={review.busy || undoBusy} onClick={() => void decide("confirm")}>{review.busy ? "正在执行…" : review.handle.confirmed ? "重试未保存项" : "确认执行"}</Button>
        {review.busy ? <Button size="sm" variant="ghost" disabled={review.stopping || undoBusy} onClick={() => { void review.handle?.stop().catch(failure => { if (mounted.current) setError(agentFailureMessage(failure)); }); }}>{review.stopping ? "正在停止…" : "停止剩余项"}</Button>
          : <Button size="sm" variant="ghost" disabled={undoBusy} onClick={() => void decide("cancel")}>取消方案</Button>}
      </div>
    </div> : null}
    {statuses.length ? <p className="agent-message__text" role="status">{operationCursor ? "已显示：" : ""}{statuses.join("，")}。</p> : null}
    {decisions.map(decision => <p className="agent-panel__hint" key={decision.requestId}>{decision.decision === "confirm" ? "已确认" : decision.decision === "revise" ? "已调整旧方案" : "已取消"}{decision.text ? `：${decision.text}` : "。"}</p>)}
    {groups.length ? <div className="agent-run-outputs__changes">
      <p className="agent-message__text">{operationCursor ? "本次更改（已显示）：" : "本次更改："}{groups.length} 个对象。</p>
      <div className="agent-output__actions">{linkedOutputs.map(output => card(output, "link"))}</div>
      {undoableGroups.length ? <Button size="sm" variant="ghost" disabled={undoBusy || runActive || review.busy || loading} onClick={() => void undoGroups()}>{undoBusy ? "正在撤销…" : "撤销本次更改"}</Button> : null}
      <details><summary>查看逐项更改（{groups.length}）</summary>{groups.map(group => <div key={group.objectKey} className="agent-output__actions">
        <span>{groupLabel(group)} · {group.recovery?.withdrawn ? "已撤回" : group.recovery?.withdrawalRevision != null ? "已恢复" : group.undo.state === "undone" ? "已撤销" : group.undo.available ? "可撤销" : "不可撤销"}</span>
        {group.undo.available ? <Button size="sm" variant="ghost" disabled={undoBusy || runActive || review.busy || loading} onClick={() => void undoGroups(group.objectKey)}>撤销此项</Button> : null}
        {undoFailures[group.objectKey] ? <span role="alert" className="agent-output__error">{undoFailures[group.objectKey]}</span> : null}
      </div>)}</details>
    </div> : <div className="agent-output__actions">{linkedOutputs.map(output => card(output, "link"))}</div>}
    {outputs.length ? <details><summary>查看成果详情（{outputs.length}）</summary>{outputs.map(output => card(output, "details"))}</details> : null}
    {cursor ? <Button size="sm" variant="ghost" disabled={loading || review.busy} onClick={() => void load(true)}>更多操作</Button> : null}
    {operationCursor ? <Button size="sm" variant="ghost" disabled={loading || review.busy} onClick={() => void moreOperations()}>更多操作记录</Button> : null}
  </section>;
}

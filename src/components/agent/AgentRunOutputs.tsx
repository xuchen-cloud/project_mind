import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAgentReviewPlan, type AgentReviewHandle } from "../../hooks/useAgentReviewPlan";
import type { AgentOperationEntry, AgentRuntimeOutput, AgentWorkspaceBinding } from "../../lib/agent-types";
import { queryKeys } from "../../lib/queryKeys";
import { agentApi } from "../../services/agentApi";
import { Button } from "../../ui/components";
import { AgentOutputCard } from "./AgentOutputCard";
import { agentFailureMessage } from "./useAgentConversation";

export interface AgentRunOutputsProps { binding: AgentWorkspaceBinding; runId: string; active?: boolean; current?: boolean; onReviewChange?: (handle: AgentReviewHandle | null) => void }
export function AgentRunOutputs(props: AgentRunOutputsProps) {
  return <RunOutputsBody key={`${props.binding.workspaceId}:${props.binding.generation}:${props.runId}`} {...props} />;
}
function RunOutputsBody({ binding, runId, active: runActive = false, current: runCurrent = false, onReviewChange }: AgentRunOutputsProps) {
  const queryClient = useQueryClient();
  const [outputs, setOutputs] = useState<AgentRuntimeOutput[]>([]);
  const [operations, setOperations] = useState<AgentOperationEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [operationCursor, setOperationCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
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
      const full = runCurrent && !runActive;
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
  useEffect(() => { void load(); }, [runActive, runCurrent]);
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
  const review = useAgentReviewPlan({ binding, runId, current: runCurrent, terminal: !runActive, complete,
    outputs, commitOutput: commit, readOutputs: readAllOutputs,
    applyOutputs: actual => { if (mounted.current) { readVersion.current++; setOutputs(previous => merge(previous, actual)); } },
  });
  useEffect(() => { onReviewChange?.(review.handle); }, [onReviewChange, review.handle]);
  useEffect(() => () => { onReviewChange?.(null); }, [onReviewChange]);
  async function decide(decision: "confirm" | "cancel") {
    setError(null);
    try { await review.handle?.decide(decision); }
    catch (failure) { if (mounted.current) setError(agentFailureMessage(failure)); }
  }
  function recoveryStatus(output: AgentRuntimeOutput) {
    const operation = operationFor(output);
    if (operation?.recovery?.withdrawn) return "withdrawn";
    if (operation?.recovery?.withdrawalRevision != null) return "restored";
    if (operation?.undoState === "undone") return "undone";
    return null;
  }
  const saved = outputs.filter(output => output.state === "committed" && !output.fileReceipt?.noChange && !recoveryStatus(output)).length;
  const unchanged = outputs.filter(output => output.state === "committed" && output.fileReceipt?.noChange && !recoveryStatus(output)).length;
  const withdrawn = outputs.filter(output => output.state === "committed" && recoveryStatus(output) === "withdrawn").length;
  const restored = outputs.filter(output => output.state === "committed" && recoveryStatus(output) === "restored").length;
  const undone = outputs.filter(output => output.state === "committed" && recoveryStatus(output) === "undone").length;
  const cancelled = outputs.filter(output => output.dismissed && output.reviewDecision?.decision === "cancel").length;
  const superseded = outputs.filter(output => output.dismissed && output.reviewDecision?.decision !== "cancel").length;
  const failed = outputs.filter(output => !output.dismissed && output.state !== "committed" && (output.state === "failed" || review.result?.failures.some(failure => failure.outputId === output.id))).length;
  const statuses = [saved ? `已保存 ${saved} 项` : "", unchanged ? `内容相同 ${unchanged} 项` : "", withdrawn ? `已撤回 ${withdrawn} 项` : "", restored ? `已恢复 ${restored} 项` : "", undone ? `已撤销 ${undone} 项` : "", cancelled ? `已取消 ${cancelled} 项` : "", superseded ? `方案已失效 ${superseded} 项` : "", failed ? `${failed} 项未保存` : ""].filter(Boolean);
  const decisions = [...new Map(outputs.flatMap(output => output.reviewDecision ? [[output.reviewDecision.requestId, output.reviewDecision] as const] : [])).values()];
  function operationFor(output: AgentRuntimeOutput) {
    return operations.find(entry => entry.requestId === `output:${output.id}:${output.revision}` && ["record.create", "record.patch", "todo.create", "todo.update", "file.create", "file.version.commit"].includes(entry.kind)) ?? null;
  }
  function card(output: AgentRuntimeOutput, presentation: "link" | "details") {
    const operation = operationFor(output);
    return <AgentOutputCard key={output.id} binding={binding} output={output} operation={operation} presentation={presentation} reviewCurrent={runCurrent} groupBusy={review.busy} runActive={runActive} failure={review.result?.failures.find(failure => failure.outputId === output.id)?.error}
      onCommit={async () => { await commit(output); }} onDismiss={() => dismiss(output)} onUndo={() => operation ? undo(output, operation) : Promise.resolve()} onRestore={() => operation ? restore(output, operation) : Promise.resolve()} />;
  }
  if (!outputs.length && !error) return null;
  return <section className="agent-run-outputs" aria-label="助手操作">
    {error ? <p className="agent-output__error" role="alert">{error}</p> : null}
    {review.handle ? <div>
      <p className="agent-message__text">{review.handle.summary}。{review.busy ? "正在处理方案。" : review.handle.confirmed ? "已确认，可继续保存剩余成果。" : "是否确认执行？"}</p>
      <div className="agent-output__actions">
        <Button size="sm" disabled={review.busy} onClick={() => void decide("confirm")}>{review.busy ? "正在执行…" : review.handle.confirmed ? "重试未保存项" : "确认执行"}</Button>
        {review.busy ? <Button size="sm" variant="ghost" disabled={review.stopping} onClick={() => { void review.handle?.stop().catch(failure => { if (mounted.current) setError(agentFailureMessage(failure)); }); }}>{review.stopping ? "正在停止…" : "停止剩余项"}</Button>
          : <Button size="sm" variant="ghost" onClick={() => void decide("cancel")}>取消方案</Button>}
      </div>
    </div> : null}
    {statuses.length ? <p className="agent-message__text" role="status">{statuses.join("，")}。</p> : null}
    {decisions.map(decision => <p className="agent-panel__hint" key={decision.requestId}>{decision.decision === "confirm" ? "已确认" : "已取消"}{decision.text ? `：${decision.text}` : "。"}</p>)}
    <div className="agent-output__actions">{outputs.filter(output => output.state === "committed").map(output => card(output, "link"))}</div>
    {outputs.length ? <details><summary>查看成果详情（{outputs.length}）</summary>{outputs.map(output => card(output, "details"))}</details> : null}
    {cursor ? <Button size="sm" variant="ghost" disabled={loading || review.busy} onClick={() => void load(true)}>更多操作</Button> : null}
    {operationCursor ? <Button size="sm" variant="ghost" disabled={loading || review.busy} onClick={() => void moreOperations()}>更多操作记录</Button> : null}
  </section>;
}

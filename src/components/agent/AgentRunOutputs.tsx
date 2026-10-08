import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AgentOperationEntry, AgentRuntimeOutput, AgentWorkspaceBinding } from "../../lib/agent-types";
import { queryKeys } from "../../lib/queryKeys";
import { agentApi } from "../../services/agentApi";
import { Button } from "../../ui/components";
import { AgentOutputCard } from "./AgentOutputCard";
import { agentFailureMessage } from "./useAgentConversation";

export interface AgentRunOutputsProps { binding: AgentWorkspaceBinding; runId: string; active?: boolean; current?: boolean }
export function AgentRunOutputs(props: AgentRunOutputsProps) {
  return <RunOutputsBody key={`${props.binding.workspaceId}:${props.binding.generation}:${props.runId}`} {...props} />;
}
function RunOutputsBody({ binding, runId, active: runActive = false }: AgentRunOutputsProps) {
  const queryClient = useQueryClient();
  const [outputs, setOutputs] = useState<AgentRuntimeOutput[]>([]);
  const [operations, setOperations] = useState<AgentOperationEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [operationCursor, setOperationCursor] = useState<string | null>(null);
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
  async function load(append = false, background = false) {
    if (reading.current) { if (!append && !background) refreshPending.current = true; return; }
    reading.current = true;
    const version = readVersion.current;
    if (!background) { setLoading(true); setError(null); }
    try {
      const [page, receipts] = await Promise.all([
        agentApi.outputList(binding, { runId, cursor: append ? cursor : null, limit: 20 }),
        agentApi.operationList(binding, { runId, limit: 50 }),
      ]);
      if (!mounted.current || version !== readVersion.current) return;
      setOutputs(previous => append || background ? merge(previous, page.outputs) : page.outputs);
      if (!background) setCursor(page.nextCursor);
      else setCursor(previous => previous ?? page.nextCursor);
      setOperations(previous => background || append ? mergeOperations(previous, receipts.operations) : receipts.operations);
      if (!background) setOperationCursor(receipts.nextCursor);
      else setOperationCursor(previous => previous ?? receipts.nextCursor);
    } catch (failure) { if (mounted.current && version === readVersion.current) setError(agentFailureMessage(failure)); }
    finally {
      reading.current = false;
      if (mounted.current && !background) setLoading(false);
      if (mounted.current && refreshPending.current) { refreshPending.current = false; void load(); }
    }
  }
  useEffect(() => { void load(); }, [runActive]);
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
  async function mutation(key: string, output: AgentRuntimeOutput, mutate: (requestId: string) => Promise<void>) {
    if (changing.current.has(output.id)) return;
    changing.current.add(output.id);
    readVersion.current++;
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID());
    try { await mutate(requestIds.current.get(key)!); }
    finally { changing.current.delete(output.id); readVersion.current++; }
  }
  async function commit(output: AgentRuntimeOutput) {
    if (output.dismissed || output.state === "committed" || output.state === "committing" || output.mode === "read_only") return;
    await mutation(`save:${output.id}:${output.revision}`, output, async requestId => {
      try {
        const result = await agentApi.outputCommit(binding, { outputId: output.id, expectedRevision: output.revision }, requestId);
        if (!mounted.current) return;
        invalidateObject(result.output);
        setOutputs(previous => previous.map(value => value.id === output.id ? result.output : value));
        if (result.operation) setOperations(previous => mergeOperations(previous, [result.operation!]));
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
  if (!outputs.length && !error) return null;
  return <section className="agent-run-outputs" aria-label="助手操作">
    {error ? <p className="agent-output__error" role="alert">{error}</p> : null}
    {outputs.map(output => {
      const operation = operations.find(entry => entry.requestId === `output:${output.id}:${output.revision}` && ["record.create", "record.patch", "todo.create", "todo.update", "file.create", "file.version.commit"].includes(entry.kind)) ?? null;
      return <AgentOutputCard key={output.id} binding={binding} output={output} operation={operation} runActive={runActive}
        onCommit={() => commit(output)} onDismiss={() => dismiss(output)} onUndo={() => operation ? undo(output, operation) : Promise.resolve()} onRestore={() => operation ? restore(output, operation) : Promise.resolve()} />;
    })}
    {cursor ? <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(true)}>更多操作</Button> : null}
    {operationCursor ? <Button size="sm" variant="ghost" disabled={loading} onClick={() => void moreOperations()}>更多操作记录</Button> : null}
  </section>;
}

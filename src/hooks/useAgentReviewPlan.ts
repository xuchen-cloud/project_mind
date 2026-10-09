import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeOutput, AgentWorkspaceBinding } from "../lib/agent-types";
import type { AgentOutputReviewInput, AgentReviewDecision, AgentReviewExecutionResult } from "../lib/agent-review-types";
import { agentApi, AgentApiError } from "../services/agentApi";

export interface AgentReviewPlanOptions {
  binding: AgentWorkspaceBinding;
  runId: string;
  current: boolean;
  terminal: boolean;
  /** True only after the controller has read every output page for this run. */
  complete: boolean;
  outputs: AgentRuntimeOutput[];
  /** Reuse the existing native commit, receipt reconciliation and invalidation. */
  commitOutput: (output: AgentRuntimeOutput) => Promise<AgentRuntimeOutput>;
  /** Full authoritative run collection, including a save that reported a later error. */
  readOutputs: () => Promise<AgentRuntimeOutput[]>;
  applyOutputs: (outputs: AgentRuntimeOutput[]) => void;
}
export interface AgentReviewHandle {
  runId: string;
  summary: string;
  pending: { outputId: string; expectedRevision: number }[];
  busy: boolean;
  confirmed: boolean;
  decide: (decision: AgentReviewDecision, text?: string) => Promise<AgentReviewExecutionResult>;
  stop: (text?: string) => Promise<AgentReviewExecutionResult | null>;
}
function pendingOutputs(outputs: AgentRuntimeOutput[], runId: string): AgentRuntimeOutput[] {
  return outputs.filter(output => output.runId === runId && output.mode === "review" && !output.dismissed && (output.state === "staged" || output.state === "failed"))
    .sort((a, b) => a.ordinal - b.ordinal);
}
export function agentReviewPlanSummary(outputs: AgentRuntimeOutput[]): string {
  const groups = new Map<string, string[]>();
  for (const output of outputs) {
    const intent = output.intent;
    const kind = intent.intent.startsWith("record_") ? "记录" : intent.intent.startsWith("todo_") ? "待办" : "文件";
    const action = intent.intent.endsWith("_create") ? "创建" : intent.intent === "file_restore" ? "恢复" : "更新";
    const target = intent.intent === "record_patch" ? intent.patch.record : intent.intent === "todo_update" || intent.intent === "file_update" ? intent.target
      : intent.intent === "file_patch" ? intent.patch.object : intent.intent === "file_restore" ? intent.restore.object : null;
    const sourceTitle = target ? output.sources.find(source => source.object.kind === target.kind && source.object.id === target.id)?.title : undefined;
    const title = intent.intent === "record_create" ? intent.title || "未命名记录" : intent.intent === "todo_create" ? intent.content
      : intent.intent === "file_create" ? intent.safeName : intent.intent === "todo_update" ? intent.changes.find(change => change.change === "content")?.content || sourceTitle || `待办 ${target?.id}`
      : sourceTitle || (target ? `${kind} ${target.id}` : "");
    const key = `${action}${kind}`;
    groups.set(key, [...groups.get(key) ?? [], title]);
  }
  return [...groups].map(([kind, titles]) => `${kind} ${titles.length} 项${titles.some(Boolean) ? `（${titles.filter(Boolean).slice(0, 3).map(title => title.length > 72 ? `${title.slice(0, 72)}…` : title).join("、")}${titles.filter(Boolean).length > 3 ? "等" : ""}）` : ""}`).join("，");
}
function unavailable(): AgentApiError {
  return new AgentApiError({ code: "REVISION_CONFLICT", message: "待确认方案已变化，请读取当前运行的完整成果。", retryable: true });
}

/** UI-independent sequencing. Pi GUI and React supply the same native controller. */
export function useAgentReviewPlan(options: AgentReviewPlanOptions) {
  const latest = useRef(options);
  latest.current = options;
  const alive = useRef(true);
  const requestIds = useRef(new Map<string, string>());
  const execution = useRef<Promise<AgentReviewExecutionResult> | null>(null);
  const stopRequested = useRef(false);
  const stopText = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [result, setResult] = useState<AgentReviewExecutionResult | null>(null);
  const [executionSummary, setExecutionSummary] = useState("");
  const identity = `${options.binding.workspaceId}:${options.binding.generation}:${options.runId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const epoch = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { execution.current = null; stopRequested.current = false; stopText.current = undefined; setBusy(false); setStopping(false); setResult(null); }, [identity]);
  const pending = pendingOutputs(options.outputs, options.runId);
  const eligible = options.current && options.terminal && options.complete;

  function requestId(input: AgentOutputReviewInput, capturedIdentity: string): string {
    const key = JSON.stringify([capturedIdentity, input]);
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID());
    return requestIds.current.get(key)!;
  }
  const decide = useCallback((decision: AgentReviewDecision, text?: string): Promise<AgentReviewExecutionResult> => {
    if (identityRef.current !== identity || !alive.current) return Promise.reject(unavailable());
    if (text !== undefined && new TextEncoder().encode(text).length > 4096) {
      return Promise.reject(new AgentApiError({ code: "BUDGET_EXCEEDED", message: "确认文字最多 4096 字节。", retryable: false }));
    }
    if (execution.current) {
      if (decision === "cancel") { stopRequested.current = true; stopText.current = text; setStopping(true); }
      return execution.current;
    }
    const captured = latest.current;
    const capturedIdentity = identityRef.current;
    const capturedEpoch = epoch.current;
    const valid = () => alive.current && capturedEpoch === epoch.current && capturedIdentity === identityRef.current && latest.current.current && latest.current.terminal && latest.current.complete;
    const frozen = pendingOutputs(captured.outputs, captured.runId);
    if (!valid() || !frozen.length) return Promise.reject(unavailable());
    if (frozen.length > 256 || text !== undefined && new TextEncoder().encode(text).length > 4096) {
      return Promise.reject(new AgentApiError({ code: "BUDGET_EXCEEDED", message: "审阅方案最多 256 项，确认文字最多 4096 字节。", retryable: false }));
    }
    stopRequested.current = false; stopText.current = undefined; setExecutionSummary(agentReviewPlanSummary(frozen)); setBusy(true); setStopping(false);
    const work = async (): Promise<AgentReviewExecutionResult> => {
      const input: AgentOutputReviewInput = { runId: captured.runId, outputs: frozen.map(output => ({ outputId: output.id, expectedRevision: output.revision })), decision, ...(text !== undefined ? { text } : {}) };
      // A persisted approval survives a failed native save. Retry that exact
      // candidate directly; keep its original approval text and timestamp.
      const reviewed = decision === "confirm" && frozen.every(output => output.reviewDecision?.decision === "confirm")
        ? { runId: captured.runId, decision, outputs: frozen }
        : await agentApi.outputReview(captured.binding, input, requestId(input, capturedIdentity));
      if (!valid()) throw unavailable();
      captured.applyOutputs(reviewed.outputs);
      const actual = new Map(reviewed.outputs.map(output => [output.id, output]));
      const failures: AgentReviewExecutionResult["failures"] = [];
      if (decision === "confirm") {
        for (const candidate of [...reviewed.outputs].sort((a, b) => a.ordinal - b.ordinal)) {
          if (!valid()) throw unavailable();
          if (stopRequested.current) break;
          if (!pendingOutputs([candidate], captured.runId).length) continue;
          try {
            const saved = await captured.commitOutput(candidate);
            if (!valid()) throw unavailable();
            actual.set(saved.id, saved); captured.applyOutputs([saved]);
          } catch (error) {
            if (!valid()) throw unavailable();
            failures.push({ outputId: candidate.id, error });
          }
        }
      }
      let finalDecision = decision;
      if (decision === "confirm" && (stopRequested.current || failures.length)) {
        // An in-flight save has settled. Read actual states before deciding
        // what remains; a save must never be guessed to have failed or cancelled.
        const refreshed = await captured.readOutputs();
        if (!valid()) throw unavailable();
        for (const output of refreshed) actual.set(output.id, output);
        captured.applyOutputs(refreshed);
        if (stopRequested.current) {
          const remaining = pendingOutputs(refreshed, captured.runId);
          if (remaining.length) {
            const cancel: AgentOutputReviewInput = { runId: captured.runId, outputs: remaining.map(output => ({ outputId: output.id, expectedRevision: output.revision })), decision: "cancel", ...(stopText.current !== undefined ? { text: stopText.current } : {}) };
            const cancelled = await agentApi.outputReview(captured.binding, cancel, requestId(cancel, capturedIdentity));
            if (!valid()) throw unavailable();
            for (const output of cancelled.outputs) actual.set(output.id, output);
            captured.applyOutputs(cancelled.outputs); finalDecision = "cancel";
          }
        }
      }
      const outcome = { decision: finalDecision, outputs: [...actual.values()].sort((a, b) => a.ordinal - b.ordinal), failures: failures.filter(failure => actual.get(failure.outputId)?.state !== "committed") };
      if (valid()) setResult(outcome);
      return outcome;
    };
    const promise = work().finally(() => {
      if (execution.current === promise) execution.current = null;
      if (alive.current && capturedEpoch === epoch.current && capturedIdentity === identityRef.current) { setBusy(false); setStopping(false); }
    });
    execution.current = promise;
    return promise;
  }, [identity]);
  const stop = useCallback((text?: string): Promise<AgentReviewExecutionResult | null> => {
    if (identityRef.current !== identity || !alive.current || !execution.current) return Promise.resolve(null);
    return decide("cancel", text);
  }, [identity, decide]);
  const summary = busy ? executionSummary : agentReviewPlanSummary(pending);
  const confirmed = pending.length > 0 && pending.every(output => output.reviewDecision?.decision === "confirm");
  const pendingKey = JSON.stringify(pending.map(output => [output.id, output.revision]));
  const decideForPlan = useCallback((decision: AgentReviewDecision, text?: string) => {
    const actualKey = JSON.stringify(pendingOutputs(latest.current.outputs, latest.current.runId).map(output => [output.id, output.revision]));
    if (!execution.current && actualKey !== pendingKey) return Promise.reject(unavailable());
    return decide(decision, text);
  }, [decide, pendingKey]);
  const handle = useMemo<AgentReviewHandle | null>(() => eligible && (pending.length > 0 || busy) ? {
    runId: options.runId, summary, pending: pending.map(output => ({ outputId: output.id, expectedRevision: output.revision })), busy, confirmed, decide: decideForPlan, stop,
  } : null, [eligible, busy, confirmed, options.runId, summary, pendingKey, decideForPlan, stop]);
  return { handle, busy, stopping, result };
}

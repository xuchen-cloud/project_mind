import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { agentApi } from "../services/agentApi";
import { recordDocumentApi } from "../services/recordDocumentApi";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type { RecordEditorState, RecordMetadata, RecordTarget } from "../lib/record-document-types";
import { projectRecordSaveKey, workspaceRecordSaveKey, type CommittedRecordBody, type RecordSaveCoordinator } from "../lib/record-save-coordinator";

function targetKey(target: RecordTarget) {
  return target.scope.kind === "project" ? projectRecordSaveKey(target.scope.projectId, target.recordId) : workspaceRecordSaveKey(target.recordId);
}

export function useCanonicalRecordEditor({ target, coordinator, enabled }: {
  target: RecordTarget | null;
  coordinator: RecordSaveCoordinator;
  enabled: boolean;
}) {
  const key = target ? targetKey(target) : null;
  const [loaded, setLoaded] = useState<{ key: string; state: RecordEditorState; binding: AgentWorkspaceBinding } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const baseline = useRef<{ key: string; binding: AgentWorkspaceBinding; revision: number; metadata: RecordMetadata; session: string } | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const ready = enabled && !!key && loaded?.key === key && baseline.current?.key === key;

  useEffect(() => {
    baseline.current = null;
    setLoaded(null);
    setError(null);
    if (!enabled || !key) return;
    let cancelled = false;
    const currentTarget = targetRef.current!;
    void (async () => {
      try {
        const status = await agentApi.statusGet();
        if (cancelled) return;
        if (!status.binding) throw new Error("工作区尚未打开，暂时无法编辑这条记录");
        const state = await recordDocumentApi.editorGet(status.binding, currentTarget);
        if (cancelled) return;
        if (targetKey(state.head.target) !== key) throw new Error("记录加载结果与当前编辑页面不一致");
        const pending = coordinator.getLatestSnapshot(key)?.canonicalBody;
        const resumed = pending?.binding.workspaceId === status.binding.workspaceId
          && pending.binding.generation === status.binding.generation ? pending : null;
        baseline.current = { key, binding: status.binding, revision: resumed?.baseRevision ?? state.head.headRevision,
          metadata: resumed?.metadataBase ?? state.metadata,
          session: resumed?.editSessionId ?? crypto.randomUUID().replaceAll("-", "") };
        setLoaded({ key, state, binding: status.binding });
      } catch (failure) {
        if (!cancelled) setError(failure);
      }
    })();
    return () => { cancelled = true; };
  }, [key, coordinator, enabled, attempt]);

  useEffect(() => coordinator.subscribeSaved((snapshot, result) => {
    const base = baseline.current;
    const body = snapshot.canonicalBody;
    if (!base || !body || snapshot.recordId !== targetRef.current?.recordId
      || (snapshot.scope === "project" ? projectRecordSaveKey(snapshot.projectId, snapshot.recordId) : workspaceRecordSaveKey(snapshot.recordId)) !== base.key
      || body.binding.workspaceId !== base.binding.workspaceId || body.binding.generation !== base.binding.generation
      || body.baseRevision !== base.revision || result.headRevision === undefined) return;
    base.revision = result.headRevision;
    if (result.metadata && body.metadataBase?.revision === base.metadata.revision) base.metadata = result.metadata;
  }), [coordinator]);

  const capture = useCallback((document: JSONContent, origin: CommittedRecordBody["origin"] = "manual"): CommittedRecordBody | null => {
    const base = baseline.current;
    if (!ready || !base || base.key !== key) return null;
    return { binding: { ...base.binding }, requestId: crypto.randomUUID(), baseRevision: base.revision,
      document, editSessionId: base.session, origin, metadataBase: structuredClone(base.metadata) };
  }, [key, ready]);

  const checkpoint = useCallback(async (reason: "leave_editor" | "open_history" | "shutdown") => {
    const base = baseline.current;
    const currentTarget = targetRef.current;
    if (!base || !currentTarget || targetKey(currentTarget) !== base.key) return;
    await coordinator.flush(base.key);
    await recordDocumentApi.checkpoint(base.binding, { target: currentTarget, baseRevision: base.revision, reason });
  }, [coordinator]);

  return { ready, state: loaded?.key === key ? loaded.state : null, error,
    recordKey: loaded?.key === key ? `${loaded.binding.workspaceId}:${key}` : undefined,
    capture, checkpoint, retry: () => setAttempt((value) => value + 1) };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { agentApi } from "../services/agentApi";
import { recordDocumentApi } from "../services/recordDocumentApi";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type { RecordEditorState, RecordMetadata, RecordTarget } from "../lib/record-document-types";
import { projectRecordSaveKey, workspaceRecordSaveKey, RecordSaveFailure, type CommittedRecordBody, type RecordSaveCoordinator } from "../lib/record-save-coordinator";
import { subscribeRecordHeadChanges } from "../lib/record-document-events";
import { registerCanonicalRecordEditor, type RecordEditorFlushOutcome } from "../lib/record-editor-registration";

function targetKey(target: RecordTarget) {
  return target.scope.kind === "project" ? projectRecordSaveKey(target.scope.projectId, target.recordId) : workspaceRecordSaveKey(target.recordId);
}

export function useCanonicalRecordEditor({ target, coordinator, enabled, receiveIncoming, flushEditor }: {
  target: RecordTarget | null;
  coordinator: RecordSaveCoordinator;
  enabled: boolean;
  receiveIncoming?: (state: RecordEditorState, previous: { metadata: RecordMetadata; codeLanguage: string | null }) => boolean;
  flushEditor?: () => Promise<RecordEditorFlushOutcome>;
}) {
  const key = target ? targetKey(target) : null;
  const [loaded, setLoaded] = useState<{ key: string; attempt: number; state: RecordEditorState; binding: AgentWorkspaceBinding } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [syncError, setSyncError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [incomingConflict, setIncomingConflict] = useState<RecordEditorState | null>(null);
  const refreshSequence = useRef(0);
  const incomingReceiver = useRef(receiveIncoming);
  incomingReceiver.current = receiveIncoming;
  const editorFlusher = useRef(flushEditor);
  editorFlusher.current = flushEditor;
  const baseline = useRef<{ key: string; binding: AgentWorkspaceBinding; revision: number; metadata: RecordMetadata; codeLanguage: string | null; session: string } | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const currentLoad = loaded?.key === key && loaded?.attempt === attempt;
  const ready = enabled && !!key && currentLoad && baseline.current?.key === key;

  useEffect(() => {
    baseline.current = null;
    setLoaded(null);
    setError(null);
    setSyncError(null);
    setIncomingConflict(null);
    if (!enabled || !key) return;
    let cancelled = false;
    let unregister: (() => void) | undefined;
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
          codeLanguage: state.head.projection.codeLanguage,
          session: resumed?.editSessionId ?? crypto.randomUUID().replaceAll("-", "") };
        const stop = await registerCanonicalRecordEditor({
          binding: status.binding, target: currentTarget, editorId: crypto.randomUUID().replaceAll("-", ""),
          flush: () => editorFlusher.current?.() ?? Promise.resolve("busy"),
        });
        if (cancelled) { stop(); return; }
        unregister = stop;
        setLoaded({ key, attempt, state, binding: status.binding });
      } catch (failure) {
        if (!cancelled) setError(failure);
      }
    })();
    return () => { cancelled = true; ++refreshSequence.current; unregister?.(); };
  }, [key, coordinator, enabled, attempt]);

  useEffect(() => coordinator.subscribeSaved((snapshot, result) => {
    const base = baseline.current;
    const body = snapshot.canonicalBody;
    if (!base || !body || snapshot.recordId !== targetRef.current?.recordId
      || (snapshot.scope === "project" ? projectRecordSaveKey(snapshot.projectId, snapshot.recordId) : workspaceRecordSaveKey(snapshot.recordId)) !== base.key
      || body.binding.workspaceId !== base.binding.workspaceId || body.binding.generation !== base.binding.generation
      || body.baseRevision !== base.revision || result.headRevision === undefined) return;
    base.revision = result.headRevision;
    base.codeLanguage = snapshot.defaultCodeLanguage;
    if (result.metadata && body.metadataBase?.revision === base.metadata.revision) base.metadata = result.metadata;
  }), [coordinator]);

  const refreshIncoming = useCallback(async () => {
    const base = baseline.current;
    const currentTarget = targetRef.current;
    if (!enabled || !key || !base || base.key !== key || !currentTarget) return;
    const sequence = ++refreshSequence.current;
    try {
      const state = await recordDocumentApi.editorGet(base.binding, currentTarget);
      if (sequence !== refreshSequence.current || baseline.current !== base || state.head.headRevision < base.revision) return;
      // A minutes panel can first observe a snapshot already present at load.
      // It is a committed-state hint, not a reason to reapply content or reject a draft.
      if (state.head.headRevision === base.revision && state.metadata.revision === base.metadata.revision) return;
      if (coordinator.getLatestSnapshot(base.key) || !incomingReceiver.current?.(state, { metadata: base.metadata, codeLanguage: base.codeLanguage })) {
        setIncomingConflict(state);
        return;
      }
      base.revision = state.head.headRevision;
      base.metadata = state.metadata;
      base.codeLanguage = state.head.projection.codeLanguage;
      setIncomingConflict(null);
      setSyncError(null);
      setLoaded({ key: base.key, attempt, binding: base.binding, state });
    } catch (failure) {
      if (sequence === refreshSequence.current && baseline.current === base) setSyncError(failure);
    }
  }, [coordinator, enabled, key, attempt]);

  useEffect(() => {
    if (!enabled || !key) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeRecordHeadChanges((change) => {
      const base = baseline.current;
      if (disposed || !base || targetKey(change.target) !== base.key
        || change.binding.workspaceId !== base.binding.workspaceId || change.binding.generation !== base.binding.generation
        || coordinator.ownsRequest(change.requestId)
        || ((change.headRevision === null || change.headRevision <= base.revision)
          && (change.metadataRevision === null || change.metadataRevision === base.metadata.revision))) return;
      void refreshIncoming();
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch((failure) => { if (!disposed) setSyncError(failure); });
    return () => { disposed = true; unlisten?.(); };
  }, [coordinator, enabled, key, refreshIncoming]);

  useEffect(() => {
    if (!enabled || !key || !ready) return;
    let disposed = false;
    let seenFailure: unknown;
    const stop = coordinator.subscribe(() => {
      const failure = coordinator.getRecordStatus(key).lastError;
      const base = baseline.current;
      const currentTarget = targetRef.current;
      if (disposed || !base || base.key !== key || !currentTarget || failure === seenFailure
        || !(failure instanceof RecordSaveFailure) || failure.code !== "REVISION_CONFLICT") return;
      seenFailure = failure;
      const sequence = ++refreshSequence.current;
      void recordDocumentApi.editorGet(base.binding, currentTarget).then((state) => {
        if (disposed || sequence !== refreshSequence.current || baseline.current !== base) return;
        setIncomingConflict(state);
        setSyncError(null);
      }).catch((failure) => { if (!disposed) setSyncError(failure); });
    });
    return () => { disposed = true; stop(); };
  }, [coordinator, enabled, key, ready, attempt]);

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
  const acknowledgeMetadata = useCallback((expectedRevision: string, metadata: RecordMetadata) => {
    const base = baseline.current;
    if (!base || base.key !== key || base.metadata.revision !== expectedRevision) return false;
    base.metadata = structuredClone(metadata);
    return true;
  }, [key]);

  return { ready, state: currentLoad && loaded ? loaded.state : null, error, syncError, incomingConflict,
    binding: currentLoad && loaded ? loaded.binding : null,
    loadIdentity: currentLoad && loaded ? `${loaded.binding.workspaceId}:${key}:${loaded.attempt}` : null,
    recordKey: loaded?.key === key ? `${loaded.binding.workspaceId}:${key}` : undefined,
    capture, checkpoint, acknowledgeMetadata, refreshIncoming, retry: () => setAttempt((value) => value + 1) };
}

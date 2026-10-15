import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Quote } from "lucide-react";
import type { AgentObjectRef, AgentSourceRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import { requestDshFileReference } from "../../lib/dsh-host-events";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { openProjectContent } from "../../services/projectContentApi";
import "./project-file-content.css";

interface ReferenceProps {
  workspaceRoot: string; projectId: number; fileId: number; versionNumber?: number; sourceRef: AgentSourceRef | null; visible?: boolean;
}
function sameObject(a: AgentObjectRef, b: AgentObjectRef) {
  return a.workspaceId === b.workspaceId && a.kind === "file" && a.id === b.id
    && a.scope.kind === "project" && b.scope.kind === "project" && a.scope.projectId === b.scope.projectId;
}

/** A click creates a new same-Project Session and inserts only the displayed, verified version. */
export function ProjectFileSessionReference(props: ReferenceProps) {
  const identity = JSON.stringify([props.workspaceRoot, props.projectId, props.fileId, props.versionNumber,
    props.sourceRef?.object, props.sourceRef?.fileVersion, props.sourceRef?.revision]);
  return <SessionReference key={identity} {...props} />;
}
function SessionReference({ workspaceRoot, projectId, fileId, versionNumber, sourceRef, visible = true }: ReferenceProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | null>(null);
  // A failed delivery may already have created a Session; retry that destination once verified again.
  const created = useRef<{ id: string; generation: string } | null>(null);
  useEffect(() => {
    setBusy(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [visible]);
  async function checkBinding(binding: AgentWorkspaceBinding, signal: AbortSignal) {
    const current = await recordDocumentApi.bindingGet(workspaceRoot);
    signal.throwIfAborted();
    if (current.workspaceId !== binding.workspaceId || current.generation !== binding.generation) throw new Error("工作区已切换，请重新读取文件。");
  }
  async function insert() {
    if (!visible || busy || pending.current || !sourceRef?.fileVersion) return;
    const controller = new AbortController(); pending.current = controller;
    const signal = controller.signal;
    setBusy(true); setError(undefined);
    try {
      if (versionNumber !== undefined && sourceRef.fileVersion !== versionNumber) throw new Error("预览版本已变化，请重新读取。");
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      signal.throwIfAborted();
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: { kind: "project", projectId }, kind: "file", id: String(fileId) };
      if (!sameObject(sourceRef.object, object)) throw new Error("预览文件归属已变化，请重新读取。");
      const file = await projectFileApi.resolve(binding, object);
      signal.throwIfAborted();
      if (!sameObject(file.object, object)) throw new Error("文件归属与引用目标不符。");
      const version = sourceRef.fileVersion;
      const history = await fileDocumentApi.versionsList(binding, { object, cursor: version + 1, limit: 1 });
      signal.throwIfAborted();
      if (!sameObject(history.object, object)) throw new Error("历史版本归属与引用目标不符。");
      const retained = history.versions.find(item => item.versionNumber === version);
      if (!retained?.contentHash || retained.contentHash !== sourceRef.revision) throw new Error("此版本没有可核验的内容，无法建立固定引用。");
      const bytes = await projectFileApi.readBytes(binding, { object, versionNumber: version, expectedContentHash: retained.contentHash });
      signal.throwIfAborted();
      if (!sameObject(bytes.object, object) || bytes.versionNumber !== version || bytes.contentHash !== retained.contentHash) throw new Error("文件版本与引用目标不符。");
      await checkBinding(binding, signal);
      await dshAssistantApi.start(`${binding.workspaceId}:${binding.generation}`, projectId);
      signal.throwIfAborted();
      await checkBinding(binding, signal);
      if (!created.current || created.current.generation !== binding.generation) {
        const id = await dshAssistantApi.selectSession(null, projectId);
        signal.throwIfAborted();
        created.current = { id, generation: binding.generation };
      }
      const destination = created.current.id;
      const source: AgentSourceRef = { object, revision: bytes.contentHash, fileVersion: version, recordVersion: null,
        blockId: null, locator: null, title: bytes.name, excerpt: "" };
      await openProjectContent({ workspaceRoot, projectId, object: { kind: "session", id: destination, title: "新会话" },
        expectedBinding: binding, signal, beforeOpen: () => {
          requestDshFileReference(projectId, file.relativePath, destination, source);
          created.current = null;
        } });
    } catch (reason) { if (!signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!signal.aborted) { setBusy(false); pending.current = null; } }
  }
  return <div className="project-file-content__reference">
    <button type="button" className="project-file-content__icon-button" disabled={!visible || !sourceRef || busy}
      aria-label="引用到新会话" title="引用当前查看版本到新会话（仅加入草稿）" aria-busy={busy || undefined} onClick={() => void insert()}>
      {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Quote size={14} aria-hidden="true" />}
    </button>
    {error ? <p role="alert" className="project-file-content__reference-error">{error}</p> : null}
  </div>;
}

import { useEffect, useRef, useState } from "react";
import type { AgentObjectRef, AgentSourceRef } from "../../lib/agent-types";
import { requestDshFileReference } from "../../lib/dsh-host-events";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { openProjectContent, PROJECT_CONTENT_OPEN_EVENT } from "../../services/projectContentApi";

/** Explicit destination; a different pane's active Session never determines the recipient. */
export function ProjectFileSessionReference({ workspaceRoot, projectId, fileId, versionNumber, sourceRef }: {
  workspaceRoot: string; projectId: number; fileId: number; versionNumber?: number; sourceRef: AgentSourceRef | null;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(undefined); setSessions([]); setSelected("");
    void (async () => {
      await dshAssistantApi.start(JSON.stringify([workspaceRoot, projectId]), projectId);
      controller.signal.throwIfAborted();
      const choices = await dshAssistantApi.sessions(projectId);
      controller.signal.throwIfAborted();
      setSessions(choices);
    })().catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) { setBusy(false); pending.current = undefined; } });
    return () => { controller.abort(); pending.current?.abort(); pending.current = undefined; };
  }, [open, workspaceRoot, projectId, fileId, versionNumber]);
  async function insert() {
    if (!selected || busy || pending.current || !sourceRef?.fileVersion) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(undefined);
    try {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      controller.signal.throwIfAborted();
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: { kind: "project", projectId }, kind: "file", id: String(fileId) };
      const file = await projectFileApi.resolve(binding, object);
      controller.signal.throwIfAborted();
      if (sourceRef.object.workspaceId !== binding.workspaceId || sourceRef.object.kind !== "file" || sourceRef.object.id !== object.id
        || sourceRef.object.scope.kind !== "project" || sourceRef.object.scope.projectId !== projectId) throw new Error("预览文件归属已变化，请重新读取。");
      const version = sourceRef.fileVersion;
      const history = await fileDocumentApi.versionsList(binding, { object, cursor: version + 1, limit: 1 });
      controller.signal.throwIfAborted();
      const retained = history.versions.find(item => item.versionNumber === version);
      if (!retained?.contentHash || retained.contentHash !== sourceRef.revision) throw new Error("此版本没有可核验的内容，无法建立固定引用。");
      const bytes = await projectFileApi.readBytes(binding, { object, versionNumber: version, expectedContentHash: retained.contentHash });
      controller.signal.throwIfAborted();
      if (bytes.object.id !== object.id || bytes.object.workspaceId !== binding.workspaceId
        || bytes.object.scope.kind !== "project" || bytes.object.scope.projectId !== projectId
        || bytes.versionNumber !== version || bytes.contentHash !== retained.contentHash) throw new Error("文件版本与引用目标不符。");
      const destination = sessions.find(item => item.id === selected);
      if (!destination) throw new Error("请选择目标会话。");
      const source: AgentSourceRef = { object, revision: bytes.contentHash, fileVersion: version, recordVersion: null,
        blockId: null, locator: null, title: bytes.name, excerpt: "" };
      const opened = await openProjectContent({ workspaceRoot, projectId, object: { kind: "session", id: selected, title: destination.title },
        expectedBinding: binding, signal: controller.signal, reveal: false });
      controller.signal.throwIfAborted();
      requestDshFileReference(projectId, file.relativePath, selected, source);
      window.dispatchEvent(new CustomEvent(PROJECT_CONTENT_OPEN_EVENT, { detail: opened }));
      setOpen(false);
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (!controller.signal.aborted) { setBusy(false); pending.current = undefined; } }
  }
  return <section className="project-file-identity">
    <button type="button" disabled={!sourceRef} aria-expanded={open} onClick={() => setOpen(value => !value)}>引用到会话</button>
    {open ? <div className="project-file-identity__panel">
      <label>目标会话<select aria-label="目标会话" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
        <option value="">请选择会话</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
      </select></label>
      <p className="project-file-identity__hint">插入正在查看版本的固定引用，发送时会核验并读取该版本。</p>
      {busy ? <p role="status">正在准备引用…</p> : null}
      {!busy && !error && !sessions.length ? <p>此项目暂无会话，请先在助手中创建会话。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={busy || !selected || !sourceRef} onClick={() => void insert()}>插入引用</button>
    </div> : null}
  </section>;
}

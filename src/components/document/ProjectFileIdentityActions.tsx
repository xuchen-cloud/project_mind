import { fileOwnerScope, sameFileOwner } from "../../lib/file-types";
import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentObjectRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { ProjectDirectoryFile } from "../../lib/file-types";
import { queryKeys } from "../../lib/queryKeys";
import { notifyProjectFilesChanged } from "../../lib/project-file-navigation";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import "./project-file-identity-actions.css";
import { HomeSidebarList } from "../home/HomeSidebarList";

export interface ProjectFileIdentityActionsProps {
  workspaceRoot: string;
  projectId: number | null;
  fileId: number;
  visible: boolean;
  onChanged?: () => void;
}
interface Resolved { binding: AgentWorkspaceBinding; file: ProjectDirectoryFile }
type Action = "move" | "rename" | "location" | "replacement";
const states = { ready: "位置已核对", missing: "文件缺失", ambiguous: "身份待确认", unavailable: "文件不可用" };
function message(error: unknown) {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}
function sameObject(a: AgentObjectRef, b: AgentObjectRef) {
  return a.workspaceId === b.workspaceId && a.kind === "file" && a.id === b.id
    && sameFileOwner(a.scope, b.scope);
}

/** Location is metadata of this File, never a substitute for its stable identity. */
export function ProjectFileIdentityActions(props: ProjectFileIdentityActionsProps) {
  return <IdentityActions key={JSON.stringify([props.workspaceRoot, props.projectId, props.fileId])} {...props} />;
}
function IdentityActions({ workspaceRoot, projectId, fileId, visible, onChanged }: ProjectFileIdentityActionsProps) {
  const ownerLabel = projectId === null ? "工作区" : "项目";
  const client = useQueryClient();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<Resolved>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const active = useRef(visible); active.current = visible;
  const callback = useRef(onChanged); callback.current = onChanged;

  function current(controller: AbortController) {
    return active.current && request.current === controller && !controller.signal.aborted;
  }
  function check(controller: AbortController) {
    if (!current(controller)) throw new DOMException("请求已失效", "AbortError");
  }
  async function checkBinding(controller: AbortController, binding: AgentWorkspaceBinding) {
    check(controller);
    const latest = await recordDocumentApi.bindingGet(workspaceRoot);
    check(controller);
    if (latest.workspaceId !== binding.workspaceId || latest.generation !== binding.generation) {
      setResolved(undefined);
      throw new Error("工作区代次已变化，请刷新核对后再操作。");
    }
  }
  function validate(file: ProjectDirectoryFile, object: AgentObjectRef) {
    if (!sameObject(file.object, object)) throw new Error("返回的文件身份或项目归属不符。");
  }
  async function changed(controller: AbortController, binding: AgentWorkspaceBinding) {
    check(controller);
    await Promise.all([
      client.invalidateQueries({ queryKey: projectId === null ? queryKeys.workspacePage : queryKeys.projectPage(projectId) }),
      client.invalidateQueries({ queryKey: queryKeys.documentVersions(fileId) }),
    ]);
    await checkBinding(controller, binding);
    notifyProjectFilesChanged(projectId, workspaceRoot);
    callback.current?.();
  }
  async function refresh() {
    if (!active.current || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined); setResolved(undefined);
    try {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      check(controller);
      const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(fileId) };
      const file = await projectFileApi.resolve(binding, object);
      check(controller); validate(file, object);
      await checkBinding(controller, binding);
      // Resolve can register newly confirmed external bytes as a new version.
      await changed(controller, binding);
      check(controller);
      setResolved({ binding, file });
    } catch (failure) { if (current(controller)) setError(message(failure)); }
    finally { if (current(controller)) { request.current = null; setBusy(false); } }
  }
  async function openCurrent() {
    if (!resolved || resolved.file.state !== "ready" || request.current || !active.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined);
    try {
      await checkBinding(controller, resolved.binding);
      await projectFileApi.openLocal(resolved.binding, resolved.file.object);
    } catch (failure) { if (current(controller)) setError(message(failure)); }
    finally { if (current(controller)) { request.current = null; setBusy(false); } }
  }
  useEffect(() => {
    if (visible && open) void refresh();
    return () => { request.current?.abort(); request.current = null; };
    // Identity changes remount the inner component; open/visible own its request lifetime.
  }, [visible, open]);

  async function perform(action: Action) {
    if (!active.current || !open || request.current || !resolved || !resolved.file.contentHash) return;
    if (action === "replacement" && !replacementConfirmed) return;
    const { binding, file } = resolved;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined);
    try {
      await checkBinding(controller, binding);
      const args = [binding, file.object] as const;
      const cas = [file.versionNumber, file.contentHash!] as const;
      const result = action === "rename" ? await projectFileApi.rename(...args, name, ...cas)
        : action === "move" ? await projectFileApi.move(...args, target, ...cas)
        : await projectFileApi.reconcile(...args, target, ...cas, action);
      check(controller); validate(result, file.object);
      await checkBinding(controller, binding);
      await changed(controller, binding);
      check(controller);
      setResolved({ binding, file: result });
      setReplacementConfirmed(false);
      // Unavailable is an actual failed registration, not a successful new version.
      if (result.state !== "ready") setError(result.reason ?? "文件核对未完成；未确认新版本。");
    } catch (failure) { if (current(controller)) setError(message(failure)); }
    finally { if (current(controller)) { request.current = null; setBusy(false); } }
  }
  const file = resolved?.file;
  const canWrite = !busy && !!file?.contentHash;
  const needsConfirmation = file?.state === "ambiguous" || file?.state === "missing";
  return <section className="project-file-identity" hidden={!visible} aria-label="文件身份与位置">
    <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => {
      request.current?.abort(); request.current = null; setBusy(false);
      setResolved(undefined); setError(undefined); setReplacementConfirmed(false); setOpen(value => !value);
    }}>文件位置</button>
    {open && visible ? <div id={panelId} className="project-file-identity__panel project-file-identity__panel--location" role="region" aria-label="文件位置核对">
      <HomeSidebarList label="文件位置操作">
      <header><strong>文件位置</strong><button type="button" disabled={busy} onClick={() => void refresh()}>刷新核对</button></header>
      {busy ? <p role="status">正在核对文件…</p> : null}
      {file ? <dl><dt>{ownerLabel}相对路径</dt><dd>{file.relativePath}</dd><dt>状态</dt><dd>{states[file.state]}</dd>
        {file.reason ? <><dt>原因</dt><dd>{file.reason}</dd></> : null}
        <dt>最新已登记版本</dt><dd>{file.contentHash ? `v${file.versionNumber}` : "尚未登记可核验的版本"}</dd></dl> : null}
      <button type="button" disabled={busy || file?.state !== "ready"} onClick={() => void openCurrent()}>在本地打开当前文件</button>
      <p className="project-file-identity__hint">此面板用于核对当前位置；文件缺失或身份待确认时，已保留的历史版本和引用仍可读取。</p>
      {file && !file.contentHash ? <p>缺少已登记内容校验信息，暂不能移动或确认身份。读取失败或超出原生快照预算不会建立新版本。</p> : null}
      {file?.state === "ready" || needsConfirmation ? <>
        <label>同{ownerLabel}目标相对路径<input value={target} disabled={busy} placeholder="例如：资料/说明.md" onChange={event => { setTarget(event.target.value); setReplacementConfirmed(false); }} /></label>
        <p className="project-file-identity__hint">目标必须位于当前{ownerLabel}内。操作前会核对文件内容和版本。</p>
        {file.state === "ready" ? <>
          <button type="button" disabled={!canWrite || !target.trim()} onClick={() => void perform("move")}>移动文件</button>
          <label>新文件名<input value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <button type="button" disabled={!canWrite || !name.trim()} onClick={() => void perform("rename")}>重命名文件</button>
        </> : <>
          <p>确认新位置时，内容须与已登记版本一致。内容发生变化时，请确认是否属于同一文件的内容更新。</p>
          <button type="button" disabled={!canWrite || !target.trim()} onClick={() => void perform("location")}>确认同一文件的新位置</button>
          <label className="project-file-identity__confirmation"><input type="checkbox" checked={replacementConfirmed} disabled={busy} onChange={event => setReplacementConfirmed(event.target.checked)} />我确认目标内容属于同一 File 的内容替换：登记新的不可变版本，保留旧版本和旧引用。</label>
          <button type="button" disabled={!canWrite || !target.trim() || !replacementConfirmed} onClick={() => void perform("replacement")}>确认这是同一File的内容替换</button>
        </>}
      </> : null}
      {error ? <p role="alert">{error}</p> : null}
      </HomeSidebarList>
    </div> : null}
  </section>;
}

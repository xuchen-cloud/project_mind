import { useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentObjectRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { FileVersionMetadata, FileVersionPage } from "../../lib/file-types";
import { readCompleteFileSource } from "../../lib/file-source";
import { queryKeys } from "../../lib/queryKeys";
import { AgentApiError } from "../../services/agentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { projectMindApi } from "../../services/projectMindApi";
import { commitDocumentVersion } from "../../services/documentVersionAction";
import { useAgentPanelStore, canDiscussObject } from "../../state/agent-panel-store";
import { Button } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import FileVersions from "./FileVersions";
import "./file-html-preview.css";

export interface FileHtmlPreviewRequest {
  workspaceRoot: string;
  projectId: number;
  documentId: number;
  title: string;
  /** Omitted follows committed head; supplied always remains a fixed version. */
  versionNumber?: number;
}
export interface FileHtmlPreviewProps { request: FileHtmlPreviewRequest; onClose: () => void }

function failureMessage(error: unknown) {
  const code = error instanceof AgentApiError ? error.code : undefined;
  if (code === "WORKSPACE_CHANGED") return "工作区已切换，请重新打开文件预览。";
  if (code === "SOURCE_NOT_READY" || code === "FILE_CHANGED_UNREGISTERED") return "此版本尚无可核验的完整原件。请在版本历史中登记当前内容为新版本，再重新读取。";
  if (code === "SOURCE_CHANGED") return "文件字节与已登记版本不同。请先在版本历史中登记当前内容，再重新读取。";
  if (code === "BUDGET_EXCEEDED") return "文件超过完整源码读取上限，不能执行截断内容。可在版本历史中查看原文。";
  return error instanceof Error ? error.message : String(error);
}
const versionKey = (binding: AgentWorkspaceBinding, documentId: number) => [...queryKeys.documentVersions(documentId), "html-preview", binding.workspaceId, binding.generation] as const;

/** Read-only committed source and history; executable preview awaits isolation verification. */
export function FileHtmlPreview(props: FileHtmlPreviewProps) {
  const request = props.request;
  return <PreviewBody key={`${request.workspaceRoot}:${request.projectId}:${request.documentId}:${request.versionNumber ?? "latest"}`} {...props} />;
}
function PreviewBody({ request, onClose }: FileHtmlPreviewProps) {
  const queryClient = useQueryClient();
  const [fixedVersion, setFixedVersion] = useState<number | null>(request.versionNumber ?? null);
  const [view, setView] = useState<"preview" | "source">("source");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The preview store creates a new request only for an explicit open action.
  // Reopening the same File must honor latest/fixed input, while query updates
  // and chat visibility changes keep the user's local historical selection.
  useLayoutEffect(() => {
    setFixedVersion(request.versionNumber ?? null);
    setView("source"); setHistoryOpen(false); setActionError(null);
  }, [request]);
  const bindingQuery = useQuery({ queryKey: [...queryKeys.documentVersions(request.documentId), "html-binding", request.workspaceRoot],
    queryFn: () => recordDocumentApi.bindingGet(request.workspaceRoot), retry: false });
  const binding = bindingQuery.data;
  const object: AgentObjectRef | null = binding ? { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: request.projectId }, kind: "file", id: String(request.documentId) } : null;
  const metadata = useQuery({ queryKey: binding ? [...versionKey(binding, request.documentId), "versions", fixedVersion] : ["html-preview-await-binding"],
    enabled: !!binding, retry: false,
    queryFn: async ({ signal }): Promise<FileVersionPage> => {
      const first = await fileDocumentApi.versionsList(binding!, { object: object!, limit: 50 });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (fixedVersion === null || first.versions.some(version => version.versionNumber === fixedVersion)) return first;
      // The native cursor is an exclusive version number, so a deep fixed
      // version can be located directly without scanning unrelated history.
      const older = await fileDocumentApi.versionsList(binding!, { object: object!, cursor: fixedVersion + 1, limit: 50 });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { ...older, versions: [...first.versions, ...older.versions.filter(version => !first.versions.some(existing => existing.id === version.id))] };
    },
  });
  const number = fixedVersion ?? metadata.data?.currentVersionNumber;
  const selected = metadata.data?.versions.find(version => version.versionNumber === number);
  const source = useQuery({ queryKey: binding ? [...versionKey(binding, request.documentId), "source", number, selected?.contentHash] : ["html-preview-await-source"],
    enabled: !!binding && !!object && !!selected?.contentHash, retry: false,
    queryFn: ({ signal }) => readCompleteFileSource(binding!, { object: object!, versionNumber: number!, expectedContentHash: selected!.contentHash! }, signal),
  });
  const fullSource = source.data && !source.error && !metadata.error && !bindingQuery.error ? source.data : null;
  const reading = bindingQuery.isPending || metadata.isFetching || source.isFetching;
  const error = actionError ?? (bindingQuery.error || metadata.error || source.error ? failureMessage(bindingQuery.error ?? metadata.error ?? source.error) : !reading && metadata.data && !selected ? "此历史版本不存在或已不可用，请重新选择版本。" : !reading && selected && !selected.contentHash ? "此版本尚未登记原件校验信息。请在版本历史中登记当前内容为新版本。" : null);

  async function currentBinding() {
    const current = await recordDocumentApi.bindingGet(request.workspaceRoot);
    if (!mounted.current) return false;
    if (!binding || current.workspaceId !== binding.workspaceId || current.generation !== binding.generation) throw new AgentApiError({ code: "WORKSPACE_CHANGED", message: "Workspace changed", retryable: true });
    return true;
  }
  async function actualFile() {
    if (!(await currentBinding())) return null;
    const reference = await projectMindApi.internalReferenceResolve({ kind: "document", id: request.documentId });
    if (!mounted.current || !(await currentBinding())) return null;
    if (!reference || reference.kind !== "document" || reference.id !== request.documentId || reference.scope !== "project" || reference.projectId !== request.projectId) throw new Error("文件已删除、已撤回或所属项目已变化，请重新打开实际文件。");
    return reference;
  }
  async function action(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setActionError(null);
    try { await work(); }
    catch (failure) { if (mounted.current) setActionError(failureMessage(failure)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function continueEditing() {
    const reference = await actualFile();
    if (!reference || !object || !binding || !mounted.current) return;
    const panel = useAgentPanelStore.getState();
    if (panel.binding && (panel.binding.workspaceRoot !== request.workspaceRoot || !canDiscussObject(panel.binding.scope, object.scope))) throw new Error("请先在此文件所属范围打开助手，再继续修改。现有草稿会保留。");
    panel.openPanel(request.workspaceRoot, panel.binding?.scope ?? object.scope);
    if (!useAgentPanelStore.getState().setDiscussionTarget(binding, object, reference.label)) throw new Error("未能选择此文件，请在所属项目打开助手后重试。");
  }
  async function changed() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.documentVersions(request.documentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(request.projectId) }), queryClient.invalidateQueries({ queryKey: queryKeys.searchAll })]);
  }
  async function registerCurrent(expectedVersionNumber: number) {
    const reference = await actualFile();
    if (!reference?.managedPath) throw new Error("当前原件不可用，请在项目文件菜单中登记新版本。");
    return commitDocumentVersion({ documentId: request.documentId, projectId: request.projectId, managedPath: reference.managedPath, expectedVersionNumber });
  }
  function chooseVersion(version: FileVersionMetadata) { setFixedVersion(version.versionNumber); setView("source"); setHistoryOpen(false); setActionError(null); }

  return <section className="file-html-preview" aria-label={`HTML 文件 · ${request.title}`}>
    <header className="file-html-preview__header"><div><h2>{fullSource?.title ?? request.title}</h2>
      <p className="file-html-preview__hint">{number ? `v${number}${fixedVersion === null ? " · 最新已提交版本" : ` · 固定版本${metadata.data ? `（当前 v${metadata.data.currentVersionNumber}）` : ""}`}` : "正在读取版本…"}</p></div>
      <div className="file-html-preview__actions"><Button size="sm" variant="ghost" disabled={busy || !binding} onClick={() => void action(continueEditing)}>继续修改</Button>
        <Button size="sm" variant="ghost" disabled={!binding} onClick={() => setHistoryOpen(true)}>版本历史</Button>
        <Button size="sm" variant="ghost" disabled={reading || busy} onClick={() => { setActionError(null); void changed(); }}>刷新</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>关闭文件</Button></div></header>
    <div className="file-html-preview__toolbar">
      <div className="file-html-preview__actions" aria-label="文件视图"><Button size="sm" variant="ghost" aria-pressed={view === "source"} onClick={() => setView("source")}>源码</Button><Button size="sm" variant="ghost" aria-pressed={view === "preview"} onClick={() => setView("preview")}>预览</Button></div>
      <label className="file-html-preview__field">版本<select aria-label="文件版本" value={fixedVersion ?? ""} onChange={event => { setFixedVersion(event.target.value ? Number(event.target.value) : null); setActionError(null); }}>
        <option value="">最新版本</option>{metadata.data?.versions.map(version => <option value={version.versionNumber} key={version.id}>v{version.versionNumber}{version.isCurrent ? " · 当前" : ""}{!version.contentHash ? " · 未经核验" : ""}</option>)}
      </select></label>
    </div>
    {error ? <p role="alert" className="file-html-preview__error">{error}</p> : null}
    {reading ? <p role="status" className="file-html-preview__hint">正在读取完整已提交源码…</p> : null}
    <div className="file-html-preview__content"><HomeSidebarList label={view === "source" ? "完整原始源码" : "HTML 文件状态"}>
      {view === "source" ? fullSource ? <pre className="file-html-preview__source" aria-label="完整原始源码文本">{fullSource.text}</pre> : null
        : <p className="file-html-preview__hint" role="status">交互预览暂不可用，可以查看源码或继续修改。</p>}
      {fullSource && fullSource.format !== "html" ? <p className="file-html-preview__hint">所选版本不是 HTML 文件，可在源码页查看原文。</p> : null}
    </HomeSidebarList></div>
    {historyOpen && binding && object ? <FileVersions binding={binding} object={object} title={fullSource?.title ?? request.title} mimeType="text/html" onClose={() => setHistoryOpen(false)} onRestored={changed} onRegisterCurrent={registerCurrent} onPreviewVersion={chooseVersion} /> : null}
  </section>;
}

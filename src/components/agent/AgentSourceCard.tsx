import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentSourceRef, AgentWorkspaceBinding } from "../../lib/agent-types";
import type { InternalReferenceKind } from "../../lib/types";
import { projectPath, workspacePath } from "../../lib/formatters";
import { getErrorMessage } from "../../lib/errors";
import { revealAgentObjectPage } from "../../lib/agent-panel-navigation";
import { withdrawnReference, type WithdrawnReference } from "../../lib/withdrawn-reference";
import { agentApi } from "../../services/agentApi";
import { desktopApi } from "../../services/desktopApi";
import { isHtmlPreviewFile, openFilePreview } from "../../state/file-preview-store";
import { projectMindApi } from "../../services/projectMindApi";
import { Button, DisclosurePresence, StatusBadge, SurfaceCard } from "../../ui/components";
import { AgentMessageSource } from "./AgentMessageSource";

export interface AgentSourceCardProps { source: AgentSourceRef; binding?: AgentWorkspaceBinding }

function time(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function location(source: AgentSourceRef) {
  if (source.locator?.kind === "page") return `第 ${source.locator.page} 页`;
  if (source.locator?.kind === "time") return `${time(source.locator.startMs)}–${time(source.locator.endMs)}`;
  if (source.locator?.kind === "messages") return "引用的原始讨论范围";
  if (source.blockId) return "引用记录块";
  if (source.locator?.kind === "paragraph") return `段落 ${source.locator.start + 1}–${source.locator.end}`;
  return null;
}
function limitation(source: AgentSourceRef) {
  if (source.object.kind === "record" && source.recordVersion != null) return "历史引用会核对保留快照；记录页显示当前正文，可在版本历史中查看所示版本。";
  if (source.object.kind === "file" && source.locator?.kind === "page") return "打开对应版本文件后，请在阅读器中定位所示页码。";
  return null;
}

/** Preview quoted evidence first; every path comes from the existing native resolver. */
export function AgentSourceCard(props: AgentSourceCardProps) {
  const identity = JSON.stringify([props.source.object, props.source.revision, props.source.fileVersion, props.source.recordVersion, props.source.blockId, props.source.locator, props.binding]);
  return <SourceCardBody key={identity} {...props} />;
}

function SourceCardBody({ source, binding }: AgentSourceCardProps) {
  const navigate = useNavigate();
  function openPage(route: string) {
    navigate(route);
    revealAgentObjectPage();
  }
  const [expanded, setExpanded] = useState(false);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [changedRevision, setChangedRevision] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState<{ details: WithdrawnReference; binding: AgentWorkspaceBinding } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const kind = source.object.kind;
  const refKind: InternalReferenceKind | null = kind === "record" ? source.object.scope.kind === "workspace" ? "workspace_record" : "note"
    : kind === "file" ? "document" : kind === "todo" ? "todo" : null;
  const opensScope = kind === "quick_note" || kind === "project";
  const opensRecord = kind === "record" || kind === "transcript";
  const locator = location(source);
  const note = limitation(source);
  const hasMessageRange = (kind === "session_message" || kind === "session_summary") && source.locator?.kind === "messages";

  async function open(afterRestore = false) {
    if (busy && !afterRestore) return;
    setBusy(true); setError(null); setWithdrawn(null);
    let openingBinding: AgentWorkspaceBinding | null = null;
    try {
      const current = (await agentApi.statusGet()).binding;
      if (!active.current) return;
      if (!current || current.workspaceId !== source.object.workspaceId
        || (binding && (current.workspaceId !== binding.workspaceId || current.generation !== binding.generation))) throw new Error("工作区已切换，请回到引用所属工作区。");
      openingBinding = current;
      const stillCurrent = async () => {
        if (!active.current) return false;
        const selected = (await agentApi.statusGet()).binding;
        if (!active.current) return false;
        if (!selected || selected.workspaceId !== current.workspaceId || selected.generation !== current.generation) throw new Error("工作区已切换，未打开旧来源。");
        return true;
      };
      if (opensScope) {
        if (await stillCurrent()) openPage(source.object.scope.kind === "project" ? projectPath(source.object.scope.projectId) : workspacePath());
        return;
      }
      let id = Number(source.object.id);
      let resolvedKind = refKind;
      let destinationScope = source.object.scope;
      let navigation: Awaited<ReturnType<typeof agentApi.sourceResolve>> | null = null;
      if (opensRecord) {
        navigation = await agentApi.sourceResolve(current, source);
        if (!active.current) return;
        if (navigation.status === "not_found") throw new Error("引用来源或保留版本已删除，无法打开原文。");
        if (navigation.status === "not_ready") throw new Error("记录正文尚未准备完成，暂时无法核对引用。");
        if (!navigation.recordTarget) throw new Error("此引用没有可用的所属记录。");
        id = navigation.recordTarget.recordId;
        destinationScope = navigation.recordTarget.scope;
        resolvedKind = destinationScope.kind === "workspace" ? "workspace_record" : "note";
        const notices: string[] = [];
        if (navigation.status === "changed") notices.push("引用内容已变化；当前记录可能与证据不同，不自动定位原引用");
        if (navigation.status === "historical") notices.push(`历史版本 v${navigation.recordVersion}，请在记录版本历史中核对`);
        if (navigation.blockStatus === "missing") notices.push("引用块已缺失，打开可用记录页");
        if (navigation.timeStatus === "missing") notices.push("引用时间片段已缺失，打开可用记录页");
        setStatus(notices.join(" · ") || null);
        if (navigation.status === "changed") {
          const revision = JSON.stringify([navigation.currentRevision, navigation.headRevision]);
          if (changedRevision !== revision) { setChangedRevision(revision); return; }
        } else setChangedRevision(null);
      }
      if (!resolvedKind || !Number.isSafeInteger(id) || id <= 0) throw new Error("此来源尚无可用的原文入口。");
      const resolved = await projectMindApi.internalReferenceResolve({ kind: resolvedKind, id });
      if (!resolved) throw new Error("来源已删除或不可用。");
      if (resolved.scope !== destinationScope.kind
        || (destinationScope.kind === "project" && resolved.projectId !== destinationScope.projectId)) throw new Error("来源已移动到其他范围，请重新查找资料。");
      if (kind === "file") {
        let filePath = resolved.managedPath;
        if (source.fileVersion != null) {
          const versions = await projectMindApi.documentListVersions({ documentId: id });
          const version = versions.find(entry => entry.versionNumber === source.fileVersion);
          if (!version) throw new Error(`引用版本 v${source.fileVersion} 已删除或不再保留。`);
          filePath = version.managedPath;
          const latest = Math.max(...versions.map(entry => entry.versionNumber));
          if (active.current && source.fileVersion < latest) setStatus(`旧版 v${source.fileVersion} · 当前 v${latest}`);
        }
        if (isHtmlPreviewFile({ name: resolved.label })) {
          const workspace = (await projectMindApi.workspaceStatusGet()).currentWorkspace;
          if (!workspace || resolved.projectId === null) throw new Error("文件所属工作区或项目不可用。");
          if (await stillCurrent()) {
            openFilePreview({ workspaceRoot: workspace.rootPath, projectId: resolved.projectId, documentId: id, title: resolved.label,
              ...(source.fileVersion !== null && source.fileVersion !== undefined ? { versionNumber: source.fileVersion } : {}) });
          }
          return;
        }
        if (!filePath) throw new Error("文件路径不可用。");
        if (await stillCurrent()) await desktopApi.openFile(filePath);
      } else if (await stillCurrent()) {
        const destination = new URL(resolved.route, window.location.origin);
        if (navigation && navigation.status !== "changed" && navigation.revisionMatches === true) {
          if (navigation.blockStatus === "available" && navigation.blockId && navigation.headRevision != null) {
            destination.searchParams.set("sourceBlock", navigation.blockId);
            destination.searchParams.set("sourceRevision", String(navigation.headRevision));
          }
          if (navigation.timeStatus === "available" && navigation.startMs != null) {
            destination.searchParams.set("sourceTimeMs", String(navigation.startMs));
          }
        }
        openPage(`${destination.pathname}${destination.search}${destination.hash}`);
      }
    } catch (failure) {
      if (active.current) {
        const details = withdrawnReference(failure);
        if (details) {
          setError(details.restoreAvailable ? "引用记录已撤回，恢复后可查看原文。" : "引用记录已撤回，暂时无法恢复。");
          if (details.restoreAvailable && openingBinding?.workspaceId === details.workspaceId) setWithdrawn({ details, binding: openingBinding });
        } else setError(getErrorMessage(failure, "打开来源失败"));
      }
    } finally { if (active.current) setBusy(false); }
  }

  async function restore() {
    if (busy || !withdrawn) return;
    setBusy(true);
    try {
      const current = (await agentApi.statusGet()).binding;
      if (!active.current) return;
      if (!current || current.workspaceId !== withdrawn.binding.workspaceId || current.generation !== withdrawn.binding.generation) throw new Error("工作区已切换，请回到引用所属工作区。");
      await agentApi.operationRestoreCreated(current, { creationOperationId: withdrawn.details.creationOperationId!, expectedWithdrawalRevision: withdrawn.details.withdrawalRevision! });
      const selected = (await agentApi.statusGet()).binding;
      if (!active.current) return;
      if (!selected || selected.workspaceId !== current.workspaceId || selected.generation !== current.generation) throw new Error("工作区已切换，记录已恢复，请重新打开来源。");
      setWithdrawn(null);
      await open(true);
    } catch (failure) {
      if (active.current) setError(`恢复引用失败：${getErrorMessage(failure, "请重新打开引用后重试。")}`);
    } finally { if (active.current) setBusy(false); }
  }

  return <SurfaceCard as="article" className="p-3" data-disclosure-list>
    <button ref={trigger} type="button" className="w-full text-left text-ui font-medium text-text" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{source.title || "未命名来源"}</button>
    <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-text-muted">
      {source.fileVersion != null && <span>文件 v{source.fileVersion}</span>}
      {source.recordVersion != null && <span>引用记录 v{source.recordVersion}</span>}
      {locator && <span>{locator}</span>}
      {!source.excerpt.trim() && <StatusBadge tone="warning">引用未含正文</StatusBadge>}
      {status && <StatusBadge tone="warning">{status}</StatusBadge>}
    </div>
    <DisclosurePresence open={expanded} triggerRef={trigger} className="mt-2">
      {source.excerpt.trim() ? <p className="whitespace-pre-wrap break-words text-body text-text-muted">{source.excerpt}</p>
        : <p className="text-body text-text-muted">此引用未提供已读取的正文片段。</p>}
      {note && <p className="mt-2 text-caption text-text-muted">{note}</p>}
      {error && <p role="alert" className="mt-2 text-caption text-danger">{error}</p>}
      {withdrawn && <Button variant="ghost" size="sm" className="mt-2" disabled={busy} onClick={() => void restore()}>恢复并打开</Button>}
      {hasMessageRange ? <>
        <Button variant="ghost" size="sm" className="mt-2" aria-expanded={discussionOpen} onClick={() => setDiscussionOpen(value => !value)}>
          {discussionOpen ? "收起原始讨论" : "查看原始讨论"}
        </Button>
        {discussionOpen && <AgentMessageSource source={source} binding={binding} />}
      </> : <>
        <Button variant="ghost" size="sm" className="mt-2" disabled={busy || (!refKind && !opensScope && !opensRecord)} onClick={() => void open()}>
          {busy ? "正在打开…" : changedRevision ? "打开当前记录" : opensScope ? "打开所属资料页" : "打开原文"}
        </Button>
        {!refKind && !opensScope && !opensRecord && <p className="mt-1 text-caption text-text-muted">此类来源的原文入口尚未接通。</p>}
      </>}
    </DisclosurePresence>
  </SurfaceCard>;
}

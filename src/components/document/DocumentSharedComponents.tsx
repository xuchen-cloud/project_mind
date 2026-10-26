import {
  lazy,
  Suspense,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { DocumentRecord, DocumentTagRecord, DocumentVersionRecord, TagColorKey, WorkspaceStatusSnapshot } from "../../lib/types";
import { tagColorValue } from "../../lib/constants";
import { queryKeys } from "../../lib/queryKeys";
import { openFilePreview } from "../../state/file-preview-store";
import { useFeedbackStore } from "../../state/feedback-store";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { fileOwnerScope } from "../../lib/file-types";
import { cn } from "../../ui/lib/cn";
import { FileVersionMenu } from "./FileVersionMenu";

const FileVersionHistory = lazy(() => import("./FileVersionHistory"));

/** Every managed File enters the same Project layout, including unsupported formats. */
export function useDocumentPreview() {
  const queryClient = useQueryClient();
  const pushToast = useFeedbackStore(state => state.pushToast);
  return (document: Pick<DocumentRecord, "id" | "projectId" | "name" | "baseName" | "mimeType">, versionNumber?: number) => {
    const workspaceRoot = queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
    if (!workspaceRoot) {
      pushToast({ tone: "error", title: "无法打开文件", detail: "工作区信息尚未就绪，请稍后重试。" });
      return true;
    }
    openFilePreview({ workspaceRoot, projectId: document.projectId, documentId: document.id, title: document.baseName,
      ...(versionNumber !== undefined ? { versionNumber } : {}) });
    return true;
  };
}

// Helper functions
export function canRenameDocument(document: DocumentRecord) {
  return document.health === "normal";
}

export function stopPropagation(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
  event.stopPropagation();
}

export function handleRenameKeyDown(
  document: DocumentRecord,
  event: KeyboardEvent<HTMLInputElement>,
  cancelRename: () => void,
  commitRename: (document: DocumentRecord) => void,
) {
  if (event.key === "Enter") {
    event.preventDefault();
    commitRename(document);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancelRename();
  }
}

export function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest("button, input, select, textarea, a, [data-document-interactive='true']"))
    : false;
}

// DocumentContextMenuAction component
export function DocumentContextMenuAction({
  icon,
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  icon: ReactElement;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        "context-menu__item",
        disabled
          ? "cursor-not-allowed text-text-soft"
          : danger
            ? "text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)]"
            : "text-text-muted hover:bg-bg-hover hover:text-text",
      )}
      data-tone={danger ? "danger" : undefined}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  );
}

// DocumentTagDots component
export function DocumentTagDots({ tags }: { tags: DocumentTagRecord[] }) {
  if (tags.length === 0) {
    return null;
  }

  const visibleTags = tags.slice(0, 6);
  const hiddenCount = tags.length - visibleTags.length;

  return (
    <div
      className="inline-flex items-center gap-1"
      title={tags.map((tag) => tag.label).join(" / ")}
      aria-label={`项目标签：${tags.map((tag) => tag.label).join("、")}`}
    >
      {visibleTags.map((tag) => (
        <span
          key={tag.id}
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: tagColorValue(tag.colorKey) }}
          aria-hidden="true"
        />
      ))}
      {hiddenCount > 0 ? <span className="text-[10px] leading-3.5 text-text-soft">+{hiddenCount}</span> : null}
    </div>
  );
}

// File list and content toolbar share the same compact version menu.
export function DocumentVersionDropdown({ document, onOpenVersion }: {
  document: DocumentRecord;
  onOpenVersion: (version: Pick<DocumentVersionRecord, "versionNumber">) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const workspace = useQuery<WorkspaceStatusSnapshot>({ queryKey: queryKeys.workspaceStatus, enabled: false });
  const root = workspace.data?.currentWorkspace?.rootPath;
  const bindingQuery = useQuery({
    queryKey: queryKeys.projectContentBinding(root ?? ""),
    queryFn: () => recordDocumentApi.bindingGet(root!),
    enabled: open && !!root,
    staleTime: Infinity,
    retry: false,
  });
  const binding = bindingQuery.data;
  const versionsQuery = useQuery({
    queryKey: [...queryKeys.documentVersions(document.id), "recent", root, binding, document.projectId],
    queryFn: () => fileDocumentApi.versionsList(binding!, { object: { workspaceId: binding!.workspaceId, scope: fileOwnerScope(document.projectId), kind: "file", id: String(document.id) }, limit: 50 }),
    enabled: open && !!root && !!binding,
    retry: false,
  });
  const versions = versionsQuery.data?.versions ?? [];
  const readError = !root ? "请先打开工作区" : bindingQuery.isError || versionsQuery.isError ? "无法读取文件版本" : undefined;
  return <>
    <FileVersionMenu key={document.id} label={`选择 ${document.baseName} 的版本`} triggerLabel={`v${document.currentVersionNumber}`}
      versions={versions.map(version => ({ ...version, id: String(version.id), isCurrent: version.versionNumber === document.currentVersionNumber }))}
      selectedVersion={document.currentVersionNumber} loading={bindingQuery.isLoading || versionsQuery.isLoading}
      error={readError} onRetry={() => { if (bindingQuery.isError) void bindingQuery.refetch(); else if (binding) void versionsQuery.refetch(); }}
      onOpenChange={setOpen} variant="badge" onSelect={versionNumber => {
        const version = versions.find(item => item.versionNumber === versionNumber);
        if (version) return onOpenVersion(version);
      }} onHistory={() => setHistoryOpen(true)} />
    {historyOpen ? <Suspense fallback={<p role="status" className="text-ui text-text-soft">正在加载版本历史…</p>}><FileVersionHistory document={document} onClose={() => setHistoryOpen(false)} /></Suspense> : null}
  </>;
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { FilePlus2, Star, Upload } from "lucide-react";

import type { DocumentRecord } from "../../lib/types";
import { formatDateTime } from "../../lib/formatters";
import { useDocumentMutations } from "../../hooks/useDocumentMutations";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  Button,
  EmptyState,
  IconButton,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
} from "../../ui/components";

type LayoutMode = "grid" | "list";

interface ManagedDocumentSectionProps {
  projectId: number;
  projectRootPath: string;
  documents: DocumentRecord[];
  layout?: LayoutMode;
  activityId?: number | null;
  importButtonLabel?: string;
  emptyText?: string;
  compactHeader?: boolean;
  pageDropActive?: boolean;
  pageDropMessage?: string;
  onDropFiles?: (paths: string[]) => void;
}

export function ManagedDocumentSection({
  projectId,
  projectRootPath,
  documents,
  layout = "grid",
  activityId = null,
  importButtonLabel = "导入文件",
  emptyText = "还没有关联文件。",
  compactHeader = false,
  pageDropActive = false,
  pageDropMessage,
  onDropFiles,
}: ManagedDocumentSectionProps) {
  const [dragActive, setDragActive] = useState(false);
  const [editingDocumentId, setEditingDocumentId] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const openTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const { documentImportMutation, documentMetaMutation } = useDocumentMutations();
  const { pushToast } = useFeedbackStore();

  const sortedDocuments = useMemo(
    () =>
      [...documents].sort((left, right) => {
        if (left.isStarred !== right.isStarred) {
          return Number(right.isStarred) - Number(left.isStarred);
        }

        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      }),
    [documents],
  );

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current);
      }
    },
    [],
  );

  const handleImport = (sourcePath: string) => {
    documentImportMutation.mutate({
      projectId,
      activityId: activityId ?? undefined,
      sourcePath,
      isStarred: false,
    });
  };

  const handleImportPaths = (paths: string[]) => {
    if (paths.length === 0) {
      pushToast({
        tone: "error",
        title: "无法读取拖拽文件",
        detail: "当前拖拽源没有暴露本地路径，请改用“选择文件”导入。",
      });
      return;
    }

    if (onDropFiles) {
      onDropFiles(paths);
      return;
    }

    paths.forEach((path) => handleImport(path));
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    handleImportPaths(readDroppedFilePaths(event));
  };

  const runDesktopAction = async (
    action: Promise<unknown>,
    title: string,
    detail?: string,
  ) => {
    try {
      await action;
    } catch (error) {
      pushToast({
        tone: "error",
        title,
        detail: detail ?? String(error),
      });
    }
  };

  const clearPendingOpen = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };

  const openDocument = (document: DocumentRecord) => {
    if (document.health === "missing") {
      pushToast({
        tone: "error",
        title: "文件已失效",
        detail: "当前文件路径已失效，请重新导入该文件。",
      });
      return;
    }

    void runDesktopAction(
      desktopApi.openFile(document.managedPath),
      "打开文件失败",
      document.managedPath,
    );
  };

  const beginRename = (document: DocumentRecord) => {
    clearPendingOpen();
    setEditingDocumentId(document.id);
    setNameDraft(document.baseName);
  };

  const cancelRename = () => {
    setEditingDocumentId(null);
    setNameDraft("");
  };

  const commitRename = (document: DocumentRecord) => {
    const nextBaseName = nameDraft.trim();
    setEditingDocumentId(null);
    setNameDraft("");

    if (!nextBaseName || nextBaseName === document.baseName) {
      return;
    }

    documentMetaMutation.mutate({
      documentId: document.id,
      baseName: nextBaseName,
    });
  };

  const handleRowClick = (
    document: DocumentRecord,
    event: MouseEvent<HTMLElement>,
  ) => {
    if (editingDocumentId === document.id || isInteractiveTarget(event.target)) {
      return;
    }

    clearPendingOpen();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      openDocument(document);
    }, 180);
  };

  const handleRowKeyDown = (
    document: DocumentRecord,
    event: KeyboardEvent<HTMLElement>,
  ) => {
    if (editingDocumentId === document.id || isInteractiveTarget(event.target)) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      clearPendingOpen();
      openDocument(document);
    }
  };

  const visibleDragActive = dragActive || pageDropActive;
  const isGridLayout = layout === "grid";

  return (
    <div className="grid gap-4">
      <SurfaceCard
        subtle
        className={[
          "overflow-visible transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)]",
          visibleDragActive
            ? "border-accent bg-bg-hover shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_40%,transparent)]"
            : "",
        ].join(" ")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        <div
          className={[
            "flex flex-wrap items-center justify-end gap-2 border-b border-border",
            compactHeader ? "px-3 py-2.5" : "px-4 py-3",
          ].join(" ")}
        >
          <Button
            type="button"
            size="sm"
            variant="primary"
            leadingIcon={<FilePlus2 size={14} />}
            onClick={async () => {
              const sourcePath = await desktopApi.pickFile({ title: "选择文件" });
              if (!sourcePath) return;
              handleImport(sourcePath);
            }}
          >
            {importButtonLabel}
          </Button>
        </div>

        {visibleDragActive ? (
          <div className="flex items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-3 py-2 text-ui text-text">
            <Upload size={13} />
            <span>{pageDropMessage ?? "松手即可把文件归入当前上下文"}</span>
          </div>
        ) : null}

        {sortedDocuments.length === 0 ? (
          <div className="px-3 py-3">
            <EmptyState text={emptyText} compact />
          </div>
        ) : (
          <div
            className={
              isGridLayout
                ? "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 p-2"
                : "grid gap-px bg-border"
            }
          >
            {sortedDocuments.map((document) => {
              const isEditing = editingDocumentId === document.id;
              const locationLabel = buildDocumentLocationLabel(document);
              const metaLine = `${locationLabel} · ${formatDateTime(document.updatedAt)}`;
              const starButtonClassName = [
                isGridLayout ? "h-5 w-5 rounded-[var(--radius-4)]" : "",
                document.isStarred
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-accent hover:border-[color-mix(in_srgb,var(--color-accent)_28%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] hover:text-accent"
                  : "",
              ]
                .filter(Boolean)
                .join(" ");
              const badges = (
                <>
                  {document.versionCount > 1 ? (
                    <StatusBadge
                      tone="neutral"
                      className="px-1 py-0 text-[10px] tracking-[0.1em]"
                    >
                      v{document.currentVersionNumber}
                    </StatusBadge>
                  ) : null}
                  {document.health === "missing" ? (
                    <StatusBadge
                      tone="danger"
                      className="px-1 py-0 text-[10px] tracking-[0.1em]"
                    >
                      失效
                    </StatusBadge>
                  ) : null}
                </>
              );

              return (
                <SurfaceCard
                  key={document.id}
                  id={`document-${document.id}`}
                  className={[
                    isGridLayout
                      ? "group grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-[var(--radius-8)] px-2 py-1.5 transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]"
                      : "group flex cursor-pointer items-center gap-2 rounded-none border-0 bg-bg px-2.5 py-2 transition-[background-color] duration-[160ms] ease-[var(--ease-soft)]",
                    document.health === "missing"
                      ? isGridLayout
                        ? "border-[color-mix(in_srgb,var(--color-danger)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-danger)_4%,var(--color-bg))]"
                        : "bg-[color-mix(in_srgb,var(--color-danger)_4%,var(--color-bg))]"
                      : isGridLayout
                        ? "border-border bg-bg hover:border-border-strong hover:bg-bg-subtle"
                        : "hover:bg-bg-subtle",
                  ].join(" ")}
                  role="button"
                  tabIndex={0}
                  onClick={(event) => handleRowClick(document, event)}
                  onKeyDown={(event) => handleRowKeyDown(document, event)}
                >
                  {isGridLayout ? (
                    <>
                      <div className="min-w-0 grid content-start gap-0.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                          {badges}
                        </div>

                        <div className="min-h-0 min-w-0">
                          {isEditing ? (
                            <input
                              data-document-interactive="true"
                              autoFocus
                              value={nameDraft}
                              onChange={(event) => setNameDraft(event.target.value)}
                              onClick={stopPropagation}
                              onDoubleClick={stopPropagation}
                              onBlur={() => commitRename(document)}
                              onKeyDown={(event) =>
                                handleRenameKeyDown(document, event, cancelRename, commitRename)
                              }
                              className="h-6 w-full rounded-[var(--radius-4)] border border-border bg-bg px-1.5 text-[12px] leading-4 text-text outline-none transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
                            />
                          ) : (
                            <p
                              className="overflow-hidden text-[12px] font-medium leading-4.5 text-text [display:-webkit-box] [overflow-wrap:anywhere] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]"
                              title={document.baseName}
                              onDoubleClick={(event) => {
                                stopPropagation(event);
                                beginRename(document);
                              }}
                            >
                              {document.baseName}
                            </p>
                          )}
                        </div>

                        <p className="truncate text-[10px] leading-3.5 text-text-soft" title={metaLine}>
                          {metaLine}
                        </p>
                      </div>

                      <IconButton
                        type="button"
                        size="sm"
                        className={starButtonClassName}
                        title={document.isStarred ? "取消标星" : "标星"}
                        aria-label={document.isStarred ? "取消标星" : "标星"}
                        onClick={(event) => {
                          stopPropagation(event);
                          documentMetaMutation.mutate({
                            documentId: document.id,
                            isStarred: !document.isStarred,
                          });
                        }}
                      >
                        <Star size={12} className={document.isStarred ? "fill-current" : ""} />
                      </IconButton>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {isEditing ? (
                            <input
                              data-document-interactive="true"
                              autoFocus
                              value={nameDraft}
                              onChange={(event) => setNameDraft(event.target.value)}
                              onClick={stopPropagation}
                              onDoubleClick={stopPropagation}
                              onBlur={() => commitRename(document)}
                              onKeyDown={(event) =>
                                handleRenameKeyDown(document, event, cancelRename, commitRename)
                              }
                              className="h-6 min-w-0 flex-1 rounded-[var(--radius-4)] border border-border bg-bg px-1.5 text-[12px] leading-4 text-text outline-none transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
                            />
                          ) : (
                            <p
                              className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4.5 text-text"
                              title={document.baseName}
                              onDoubleClick={(event) => {
                                stopPropagation(event);
                                beginRename(document);
                              }}
                            >
                              {document.baseName}
                            </p>
                          )}
                          {badges}
                        </div>
                        <p className="truncate text-[10px] leading-4 text-text-soft" title={metaLine}>
                          {metaLine}
                        </p>
                      </div>

                      <IconButton
                        type="button"
                        size="sm"
                        className={starButtonClassName}
                        title={document.isStarred ? "取消标星" : "标星"}
                        aria-label={document.isStarred ? "取消标星" : "标星"}
                        onClick={(event) => {
                          stopPropagation(event);
                          documentMetaMutation.mutate({
                            documentId: document.id,
                            isStarred: !document.isStarred,
                          });
                        }}
                      >
                        <Star size={12} className={document.isStarred ? "fill-current" : ""} />
                      </IconButton>
                    </>
                  )}
                </SurfaceCard>
              );
            })}
          </div>
        )}
      </SurfaceCard>

    </div>
  );
}

function buildDocumentLocationLabel(document: DocumentRecord) {
  return document.activityId
    ? document.sourceActivityTitle || "未命名 Activity"
    : "项目根目录";
}

function stopPropagation(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
) {
  event.stopPropagation();
}

function handleRenameKeyDown(
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

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest("button, input, select, textarea, a, [data-document-interactive='true']"))
    : false;
}

function readDroppedFilePaths(event: DragEvent<HTMLElement>) {
  const nativeFiles = Array.from(event.dataTransfer.files) as Array<File & { path?: string }>;
  const nativePaths = nativeFiles
    .map((file) => file.path?.trim())
    .filter((path): path is string => Boolean(path));

  if (nativePaths.length > 0) {
    return nativePaths;
  }

  const fileUriList = event.dataTransfer
    .getData("text/uri-list")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("file://"));

  return fileUriList
    .map((fileUri) => {
      try {
        return decodeURIComponent(fileUri.replace("file://", ""));
      } catch {
        return fileUri.replace("file://", "");
      }
    })
    .filter(Boolean);
}

export function ManagedDocumentSectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <SectionHeader eyebrow="Documents" title={title} description={description} />
  );
}

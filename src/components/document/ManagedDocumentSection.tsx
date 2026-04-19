import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Circle,
  FilePlus2,
  FolderOpen,
  Pencil,
  Star,
  Trash2,
  Upload,
} from "lucide-react";

import { fileTagColorValue, resolveActivityTitle } from "../../lib/constants";
import type {
  DocumentRecord,
  DocumentTagRecord,
  DocumentVersionRecord,
  FileTagColorKey,
} from "../../lib/types";
import { formatDateTime } from "../../lib/formatters";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import { useDocumentMutations } from "../../hooks/useDocumentMutations";
import { useDocumentImportFlow } from "../../hooks/useDocumentImportFlow";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  Button,
  EmptyState,
  PopoverPanel,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { DocumentImportTagDialog } from "./DocumentImportTagDialog";

type LayoutMode = "grid" | "list";

interface ManagedDocumentSectionProps {
  projectId: number;
  projectRootPath: string;
  documents: DocumentRecord[];
  layout?: LayoutMode;
  chrome?: "card" | "embedded";
  activityId?: number | null;
  importButtonLabel?: string;
  showImportButton?: boolean;
  emptyText?: string;
  compactHeader?: boolean;
  pageDropActive?: boolean;
  pageDropMessage?: string;
  onDropFiles?: (paths: string[]) => void | Promise<unknown>;
}

interface ContextMenuState {
  documentId: number;
  x: number;
  y: number;
}

const CONTEXT_MENU_WIDTH = 280;
const CONTEXT_MENU_HEIGHT = 464;
const CONTEXT_MENU_VIEWPORT_PADDING = 12;

export function ManagedDocumentSection({
  projectId,
  projectRootPath,
  documents,
  layout = "grid",
  chrome = "card",
  activityId = null,
  importButtonLabel = "导入文件",
  showImportButton = true,
  emptyText = "还没有关联文件。",
  compactHeader = false,
  pageDropActive = false,
  pageDropMessage,
  onDropFiles,
}: ManagedDocumentSectionProps) {
  const [dragActive, setDragActive] = useState(false);
  const [editingDocumentId, setEditingDocumentId] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [pendingTagIdsByDocumentId, setPendingTagIdsByDocumentId] = useState<Record<number, number[]>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const openTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const {
    documentMetaMutation,
    documentAddVersionMutation,
    documentDeleteMutation,
  } = useDocumentMutations();
  const { pushToast } = useFeedbackStore();
  const {
    fileTags,
    fileTagSettingsQuery,
    pendingImportPaths,
    pendingImportTagIds,
    requestImportPaths,
    togglePendingImportTag,
    closeImportTagDialog,
    confirmImportTagDialog,
    manageImportTags,
  } = useDocumentImportFlow({
    projectId,
    activityId,
  });
  const fileTagLookup = useMemo(
    () =>
      new Map(
        fileTags.map((tag) => [
          tag.id,
          {
            id: tag.id,
            label: tag.label,
            colorKey: tag.colorKey,
          },
        ]),
      ),
    [fileTags],
  );

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

  const effectiveDocumentTagsById = useMemo(
    () =>
      new Map(
        documents.map((document) => [
          document.id,
          buildEffectiveDocumentTags(document, pendingTagIdsByDocumentId[document.id], fileTagLookup),
        ]),
      ),
    [documents, fileTagLookup, pendingTagIdsByDocumentId],
  );

  const visibleFilterTags = useMemo(() => {
    const countById = new Map<number, number>();
    const metaById = new Map<number, { id: number; label: string; colorKey: FileTagColorKey }>();

    for (const document of sortedDocuments) {
      const tags = effectiveDocumentTagsById.get(document.id) ?? document.tags;
      for (const tag of tags) {
        metaById.set(tag.id, tag);
        countById.set(tag.id, (countById.get(tag.id) ?? 0) + 1);
      }
    }

    const orderedIds = [
      ...fileTags.map((tag) => tag.id).filter((tagId) => countById.has(tagId)),
      ...Array.from(metaById.keys()).filter((tagId) => !fileTagLookup.has(tagId)),
    ];

    return orderedIds.map((tagId) => {
      const meta = metaById.get(tagId) ?? fileTagLookup.get(tagId);
      return {
        id: tagId,
        label: meta?.label ?? `Tag ${tagId}`,
        colorKey: meta?.colorKey ?? "slate",
        count: countById.get(tagId) ?? 0,
      };
    });
  }, [effectiveDocumentTagsById, fileTagLookup, fileTags, sortedDocuments]);

  const filteredDocuments = useMemo(() => {
    if (selectedTagIds.length === 0) {
      return sortedDocuments;
    }

    return sortedDocuments.filter((document) =>
      (effectiveDocumentTagsById.get(document.id) ?? document.tags).some((tag) =>
        selectedTagIds.includes(tag.id),
      ),
    );
  }, [effectiveDocumentTagsById, selectedTagIds, sortedDocuments]);

  const contextMenuDocument = contextMenu
    ? sortedDocuments.find((document) => document.id === contextMenu.documentId) ?? null
    : null;

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    setPendingTagIdsByDocumentId((current) => {
      const next: Record<number, number[]> = {};
      let changed = false;

      for (const [documentIdText, tagIds] of Object.entries(current)) {
        const documentId = Number(documentIdText);
        const actualTagIds =
          documents.find((document) => document.id === documentId)?.tags.map((tag) => tag.id) ?? null;
        if (!actualTagIds) {
          changed = true;
          continue;
        }
        if (sameNumberArray(actualTagIds, tagIds)) {
          changed = true;
          continue;
        }
        next[documentId] = tagIds;
      }

      return changed ? next : current;
    });
  }, [documents]);

  useEffect(() => {
    const visibleIds = new Set(visibleFilterTags.map((tag) => tag.id));
    setSelectedTagIds((current) => {
      const next = current.filter((tagId) => visibleIds.has(tagId));
      return next.length === current.length ? current : next;
    });
  }, [visibleFilterTags]);

  useEffect(() => {
    if (contextMenu && !documents.some((document) => document.id === contextMenu.documentId)) {
      setContextMenu(null);
    }
  }, [contextMenu, documents]);

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

  const handleImportPaths = async (paths: string[]) => {
    if (onDropFiles) {
      await onDropFiles(paths);
      return;
    }

    await requestImportPaths(paths);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    void handleImportPaths(extractDroppedFilePaths(event.dataTransfer));
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

  const openDocumentLocation = (document: DocumentRecord) => {
    if (document.health === "missing") {
      return;
    }

    void runDesktopAction(
      desktopApi.revealInExplorer(document.managedPath),
      "打开文件所在位置失败",
      document.managedPath,
    );
  };

  const addDocumentVersionAndOpen = async (document: DocumentRecord) => {
    if (document.health === "missing") {
      return;
    }

    try {
      const nextDocument = await documentAddVersionMutation.mutateAsync({
        documentId: document.id,
      });
      await runDesktopAction(
        desktopApi.openFile(nextDocument.managedPath),
        "打开文件失败",
        nextDocument.managedPath,
      );
    } catch {
      return;
    }
  };

  const deleteDocument = (document: DocumentRecord) => {
    documentDeleteMutation.mutate({ documentId: document.id });
  };

  const beginRename = (document: DocumentRecord) => {
    if (!canRenameDocument(document)) {
      return;
    }
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

  const handleRowClick = (document: DocumentRecord, event: MouseEvent<HTMLElement>) => {
    if (editingDocumentId === document.id || isInteractiveTarget(event.target)) {
      return;
    }

    clearPendingOpen();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      openDocument(document);
    }, 180);
  };

  const handleRowMouseDownCapture = (document: DocumentRecord, event: MouseEvent<HTMLElement>) => {
    if (editingDocumentId === document.id || event.button !== 2 || isInteractiveTarget(event.target)) {
      return;
    }

    clearPendingOpen();
    event.preventDefault();
  };

  const openContextMenu = (documentId: number, x: number, y: number) => {
    clearPendingOpen();
    const maxX =
      typeof window === "undefined"
        ? Math.max(CONTEXT_MENU_VIEWPORT_PADDING, x)
        : Math.max(
            CONTEXT_MENU_VIEWPORT_PADDING,
            window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_VIEWPORT_PADDING,
          );
    const maxY =
      typeof window === "undefined"
        ? Math.max(CONTEXT_MENU_VIEWPORT_PADDING, y)
        : Math.max(
            CONTEXT_MENU_VIEWPORT_PADDING,
            window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_VIEWPORT_PADDING,
          );
    setContextMenu({
      documentId,
      x: Math.min(Math.max(CONTEXT_MENU_VIEWPORT_PADDING, x), maxX),
      y: Math.min(Math.max(CONTEXT_MENU_VIEWPORT_PADDING, y), maxY),
    });
  };

  const handleRowKeyDown = (document: DocumentRecord, event: KeyboardEvent<HTMLElement>) => {
    if (editingDocumentId === document.id || isInteractiveTarget(event.target)) {
      return;
    }

    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openContextMenu(document.id, rect.left + 12, rect.bottom + 6);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      clearPendingOpen();
      openDocument(document);
    }
  };

  const toggleDocumentTag = (document: DocumentRecord, tagId: number) => {
    const currentTagIds = (effectiveDocumentTagsById.get(document.id) ?? document.tags).map((tag) => tag.id);
    const nextTagIds = currentTagIds.includes(tagId)
      ? currentTagIds.filter((value) => value !== tagId)
      : [...currentTagIds, tagId];

    setPendingTagIdsByDocumentId((current) => ({
      ...current,
      [document.id]: nextTagIds,
    }));

    documentMetaMutation.mutate(
      {
        documentId: document.id,
        tagIds: nextTagIds,
      },
      {
        onError: () => {
          setPendingTagIdsByDocumentId((current) => ({
            ...current,
            [document.id]: currentTagIds,
          }));
        },
      },
    );
  };

  const visibleDragActive = dragActive || pageDropActive;
  const isGridLayout = layout === "grid";
  const showCardChrome = chrome === "card";
  const listContent = (
    <>
      {showCardChrome ? (
        <div
          className={[
            "flex flex-wrap items-center justify-between gap-2 border-b border-border",
            compactHeader ? "px-3 py-2.5" : "px-4 py-3",
          ].join(" ")}
        >
          <FileTagFilterBar
            tags={visibleFilterTags}
            selectedTagIds={selectedTagIds}
            onToggleTag={(tagId) =>
              setSelectedTagIds((current) =>
                current.includes(tagId)
                  ? current.filter((value) => value !== tagId)
                  : [...current, tagId],
              )
            }
            onClear={() => setSelectedTagIds([])}
          />

          {showImportButton ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              leadingIcon={<FilePlus2 size={14} />}
              onClick={async () => {
                const sourcePaths = await desktopApi.pickFiles({ title: `选择文件 · ${projectRootPath}` });
                if (sourcePaths.length === 0) {
                  return;
                }
                await handleImportPaths(sourcePaths);
              }}
            >
              {importButtonLabel}
            </Button>
          ) : null}
        </div>
      ) : null}

      {visibleDragActive ? (
        <div
          className={[
            "flex items-center gap-2 text-ui text-text",
            showCardChrome
              ? "border-b border-border bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-3 py-2"
              : "rounded-[var(--radius-8)] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-3 py-2",
          ].join(" ")}
        >
          <Upload size={13} />
          <span>{pageDropMessage ?? "松手即可把文件归入当前上下文"}</span>
        </div>
      ) : null}

      {filteredDocuments.length === 0 ? (
        <div className={showCardChrome ? "px-3 py-3" : ""}>
          <EmptyState
            text={selectedTagIds.length > 0 ? "当前筛选条件下没有文件。" : emptyText}
            compact
          />
        </div>
      ) : (
        <div
          className={
            isGridLayout
              ? "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 p-2"
              : showCardChrome
                ? "grid gap-1.5"
                : "grid gap-1.5"
          }
        >
          {filteredDocuments.map((document) => {
            const isEditing = editingDocumentId === document.id;
            const isContextOpen = contextMenu?.documentId === document.id;
            const locationLabel = buildDocumentLocationLabel(document);
            const tags = effectiveDocumentTagsById.get(document.id) ?? document.tags;
            const badges = (
              <>
                <DocumentTagDots tags={tags} />
                {document.health === "missing" ? (
                  <StatusBadge tone="danger" className="px-1 py-0 text-[10px] tracking-[0.1em]">
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
                  "relative",
                  isEditing ? "" : "context-menu-no-select",
                  isGridLayout
                    ? "group grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-[var(--radius-8)] px-2.5 py-2 transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)]"
                    : "group flex cursor-pointer items-center gap-2 rounded-[var(--radius-8)] px-2.5 py-2 transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)]",
                  document.health === "missing"
                    ? "border-[color-mix(in_srgb,var(--color-danger)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-danger)_4%,var(--color-bg))]"
                    : isContextOpen
                      ? "border-border-strong bg-[color-mix(in_srgb,var(--color-bg-subtle)_88%,var(--color-bg))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-text)_4%,transparent)]"
                      : "border-border bg-bg hover:border-border-strong hover:bg-[color-mix(in_srgb,var(--color-bg-subtle)_88%,var(--color-bg))]",
                ].join(" ")}
                role="button"
                tabIndex={0}
                aria-label={buildDocumentAriaLabel(document.baseName, tags)}
                onClick={(event) => handleRowClick(document, event)}
                onMouseDownCapture={(event) => handleRowMouseDownCapture(document, event)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openContextMenu(document.id, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => handleRowKeyDown(document, event)}
              >
                {isGridLayout ? (
                  <>
                    <div className="min-w-0 grid content-start gap-1">
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
                            className="inline-object-input h-6 w-full px-1.5 text-[12px] leading-4 text-text outline-none"
                          />
                        ) : (
                          <div className="flex min-w-0 items-center gap-1">
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
                            {document.versionCount > 1 ? (
                              <DocumentVersionDropdown
                                document={document}
                                onOpenVersion={(version) =>
                                  runDesktopAction(
                                    desktopApi.openFile(version.managedPath),
                                    "打开版本文件失败",
                                    version.managedPath,
                                  )
                                }
                              />
                            ) : null}
                          </div>
                        )}
                      </div>

                      <p className="truncate text-[10px] leading-3.5 text-text-soft" title={locationLabel}>
                        {locationLabel}
                      </p>
                    </div>
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
                            className="inline-object-input h-6 min-w-0 flex-1 px-1.5 text-[12px] leading-4 text-text outline-none"
                          />
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center gap-1">
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
                            {document.versionCount > 1 ? (
                              <DocumentVersionDropdown
                                document={document}
                                onOpenVersion={(version) =>
                                  runDesktopAction(
                                    desktopApi.openFile(version.managedPath),
                                    "打开版本文件失败",
                                    version.managedPath,
                                  )
                                }
                              />
                            ) : null}
                          </div>
                        )}
                        {badges}
                      </div>
                      <p className="truncate text-[10px] leading-4 text-text-soft" title={locationLabel}>
                        {locationLabel}
                      </p>
                    </div>
                  </>
                )}
              </SurfaceCard>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <div
      ref={rootRef}
      className={showCardChrome ? "grid gap-4" : "grid gap-3"}
    >
      {showCardChrome ? (
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
          {listContent}
        </SurfaceCard>
      ) : (
        <div
          className={[
            "grid gap-2",
            visibleDragActive
              ? "rounded-[var(--radius-8)] bg-bg-hover shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_22%,transparent)]"
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
          {listContent}
        </div>
      )}

      {contextMenuDocument && contextMenu ? (
        <PopoverPanel
          className="fixed z-30 min-w-[15rem] p-1.5"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          role="menu"
          aria-label="文件操作"
          data-document-interactive="true"
          onClick={stopPropagation}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="grid gap-1">
            <DocumentContextMenuAction
              icon={<FolderOpen size={14} />}
              label="打开文件所在位置"
              disabled={contextMenuDocument.health === "missing"}
              onClick={() => {
                setContextMenu(null);
                openDocumentLocation(contextMenuDocument);
              }}
            />
            <DocumentContextMenuAction
              icon={<Pencil size={14} />}
              label="重命名"
              disabled={!canRenameDocument(contextMenuDocument)}
              onClick={() => {
                setContextMenu(null);
                beginRename(contextMenuDocument);
              }}
            />
            <DocumentContextMenuAction
              icon={<FilePlus2 size={14} />}
              label="复制为新版本并打开"
              disabled={contextMenuDocument.health === "missing"}
              onClick={() => {
                setContextMenu(null);
                void addDocumentVersionAndOpen(contextMenuDocument);
              }}
            />
            <DocumentContextMenuAction
              icon={<Star size={14} className={contextMenuDocument.isStarred ? "fill-current" : ""} />}
              label={contextMenuDocument.isStarred ? "取消标星" : "标星"}
              onClick={() => {
                setContextMenu(null);
                documentMetaMutation.mutate({
                  documentId: contextMenuDocument.id,
                  isStarred: !contextMenuDocument.isStarred,
                });
              }}
            />
            <DocumentContextMenuAction
              icon={<Trash2 size={14} />}
              label="删除"
              danger
              disabled={documentDeleteMutation.isPending}
              onClick={() => {
                setContextMenu(null);
                deleteDocument(contextMenuDocument);
              }}
            />
          </div>

          {fileTagSettingsQuery.isLoading || fileTags.length > 0 ? (
            <div className="mt-1 grid gap-1 border-t border-border pt-1">
            {fileTagSettingsQuery.isLoading ? (
              <p className="px-2.5 py-2 text-ui text-text-soft">标签加载中...</p>
            ) : fileTags.length > 0 ? (
              fileTags.map((tag) => {
                const checked = (effectiveDocumentTagsById.get(contextMenuDocument.id) ?? contextMenuDocument.tags).some(
                  (item) => item.id === tag.id,
                );
                return (
                  <label
                    key={tag.id}
                    className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-6)] px-2.5 py-2 text-ui text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      data-document-interactive="true"
                      onChange={() => toggleDocumentTag(contextMenuDocument, tag.id)}
                    />
                    <Circle
                      size={10}
                      className="fill-current"
                      style={{ color: fileTagColorValue(tag.colorKey) }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{tag.label}</span>
                  </label>
                );
              })
            ) : null}
            </div>
          ) : null}
        </PopoverPanel>
      ) : null}

      {pendingImportPaths ? (
        <DocumentImportTagDialog
          paths={pendingImportPaths}
          tags={fileTags}
          selectedTagIds={pendingImportTagIds}
          onToggleTag={togglePendingImportTag}
          onClose={closeImportTagDialog}
          onConfirm={() => {
            void confirmImportTagDialog();
          }}
          onManageTags={manageImportTags}
        />
      ) : null}
    </div>
  );
}

function buildDocumentLocationLabel(document: DocumentRecord) {
  return document.activityId
    ? resolveActivityTitle(document.sourceActivityTitle, document.activityId)
    : "项目根目录";
}

function buildDocumentAriaLabel(baseName: string, tags: DocumentTagRecord[]) {
  if (tags.length === 0) {
    return baseName;
  }

  return `${baseName}，文件标签：${tags.map((tag) => tag.label).join("、")}`;
}

function canRenameDocument(document: DocumentRecord) {
  return document.health !== "missing";
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

function buildEffectiveDocumentTags(
  document: DocumentRecord,
  pendingTagIds: number[] | undefined,
  fileTagLookup: Map<number, { id: number; label: string; colorKey: FileTagColorKey }>,
): DocumentTagRecord[] {
  if (!pendingTagIds) {
    return document.tags;
  }

  return pendingTagIds
    .map((tagId) => {
      const tag = fileTagLookup.get(tagId) ?? document.tags.find((item) => item.id === tagId);
      return tag
        ? {
            id: tag.id,
            label: tag.label,
            colorKey: tag.colorKey,
          }
        : null;
    })
    .filter((tag): tag is DocumentTagRecord => Boolean(tag));
}

function sameNumberArray(left: number[], right: number[]) {
  if (left.length !== right.length) {
    return false;
  }

  const leftSorted = [...left].sort((a, b) => a - b);
  const rightSorted = [...right].sort((a, b) => a - b);
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function DocumentContextMenuAction({
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
        "flex w-full items-center gap-2 rounded-[var(--radius-6)] px-2.5 py-2 text-left text-ui transition-colors",
        disabled
          ? "cursor-not-allowed text-text-soft"
          : danger
            ? "text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_9%,transparent)]"
            : "text-text-muted hover:bg-bg-hover hover:text-text",
      )}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  );
}

function FileTagFilterBar({
  tags,
  selectedTagIds,
  onToggleTag,
  onClear,
}: {
  tags: Array<{ id: number; label: string; colorKey: FileTagColorKey; count: number }>;
  selectedTagIds: number[];
  onToggleTag: (tagId: number) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={cn(
            "rounded-[var(--radius-6)] border px-2.5 py-1 text-ui transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
            selectedTagIds.length === 0
              ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] text-accent"
              : "border-border bg-bg text-text-muted hover:border-border-strong hover:bg-bg-hover hover:text-text",
          )}
          onClick={onClear}
        >
          全部
        </button>

        {tags.map((tag) => {
          const selected = selectedTagIds.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              className={cn(
                "inline-flex items-center gap-2 rounded-[var(--radius-6)] border px-2.5 py-1 text-ui transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
                selected
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] text-text"
                  : "border-border bg-bg text-text-muted hover:border-border-strong hover:bg-bg-hover hover:text-text",
              )}
              onClick={() => onToggleTag(tag.id)}
            >
              <Circle
                size={10}
                className="fill-current"
                style={{ color: fileTagColorValue(tag.colorKey) }}
                aria-hidden="true"
              />
              <span>{tag.label}</span>
              <span className="text-text-soft">{tag.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DocumentTagDots({ tags }: { tags: DocumentTagRecord[] }) {
  if (tags.length === 0) {
    return null;
  }

  const visibleTags = tags.slice(0, 6);
  const hiddenCount = tags.length - visibleTags.length;

  return (
    <div
      className="inline-flex items-center gap-1"
      title={tags.map((tag) => tag.label).join(" / ")}
      aria-label={`文件标签：${tags.map((tag) => tag.label).join("、")}`}
    >
      {visibleTags.map((tag) => (
        <span
          key={tag.id}
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: fileTagColorValue(tag.colorKey) }}
          aria-hidden="true"
        />
      ))}
      {hiddenCount > 0 ? <span className="text-[10px] leading-3.5 text-text-soft">+{hiddenCount}</span> : null}
    </div>
  );
}

interface FloatingMenuPosition {
  left: number;
  top: number;
  width: number;
}

function DocumentVersionDropdown({
  document,
  onOpenVersion,
}: {
  document: DocumentRecord;
  onOpenVersion: (version: DocumentVersionRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<FloatingMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const versionsQuery = useQuery({
    queryKey: ["documentVersions", document.id],
    queryFn: () =>
      projectMindApi.documentListVersions({
        documentId: document.id,
      }),
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      if (!triggerRef.current) {
        return;
      }

      const viewportPadding = 12;
      const gap = 8;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const menuHeight = menuRef.current?.offsetHeight ?? 0;
      const menuWidth = Math.max(menuRef.current?.offsetWidth ?? 0, 220);
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const shouldOpenUp =
        menuHeight > 0 &&
        spaceBelow < menuHeight + gap + viewportPadding &&
        triggerRect.top > spaceBelow;

      const top = shouldOpenUp
        ? Math.max(viewportPadding, triggerRect.top - menuHeight - gap)
        : Math.max(
            viewportPadding,
            Math.min(
              triggerRect.bottom + gap,
              window.innerHeight - menuHeight - viewportPadding,
            ),
          );
      const left = Math.max(
        viewportPadding,
        Math.min(triggerRect.left, window.innerWidth - menuWidth - viewportPadding),
      );

      setMenuPosition({
        left,
        top,
        width: Math.max(triggerRect.width + 88, 220),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, versionsQuery.data, versionsQuery.isLoading]);

  const versions = versionsQuery.data ?? [];

  return (
    <div ref={rootRef} className="relative shrink-0" data-document-interactive="true">
      <button
        ref={triggerRef}
        type="button"
        data-document-interactive="true"
        className="inline-flex items-center gap-1 rounded-[var(--radius-4)]"
        title="选择版本"
        aria-label={`选择 ${document.baseName} 的版本`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          stopPropagation(event);
          setOpen((current) => !current);
        }}
      >
        <StatusBadge tone="neutral" className="px-1 py-0 text-[10px] tracking-[0.1em]">
          v{document.currentVersionNumber}
        </StatusBadge>
        <ChevronDown
          size={12}
          className={cn(
            "shrink-0 text-text-soft transition-transform duration-[160ms] ease-[var(--ease-soft)]",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="z-[120]"
              style={{
                position: "fixed",
                left: menuPosition?.left ?? 0,
                top: menuPosition?.top ?? 0,
                width: menuPosition?.width ?? 220,
                visibility: menuPosition ? "visible" : "hidden",
              }}
              data-document-interactive="true"
              onClick={stopPropagation}
            >
              <PopoverPanel className="min-w-[13.75rem] p-1.5">
                {versionsQuery.isLoading ? (
                  <p className="px-2.5 py-2 text-ui text-text-soft">正在加载版本...</p>
                ) : versions.length === 0 ? (
                  <p className="px-2.5 py-2 text-ui text-text-soft">没有可选版本</p>
                ) : (
                  <div className="grid gap-1" role="menu" aria-label={`${document.baseName} 版本列表`}>
                    {versions.map((version) => {
                      const isCurrent = version.versionNumber === document.currentVersionNumber;

                      return (
                        <button
                          key={version.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isCurrent}
                          className={cn(
                            "flex w-full items-start justify-between gap-3 rounded-[var(--radius-6)] px-2.5 py-2 text-left transition-colors",
                            isCurrent
                              ? "bg-bg-hover text-text"
                              : "text-text-muted hover:bg-bg-hover hover:text-text",
                          )}
                          onClick={() => {
                            onOpenVersion(version);
                            setOpen(false);
                          }}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="text-ui font-medium text-text">v{version.versionNumber}</span>
                              {isCurrent ? (
                                <span className="text-[10px] leading-4 text-text-soft">当前</span>
                              ) : null}
                            </span>
                            <span className="block truncate text-[11px] leading-4 text-text-soft">
                              {formatDateTime(version.createdAt)}
                            </span>
                          </span>
                          {isCurrent ? <Check size={14} className="mt-0.5 shrink-0 text-text-soft" /> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </PopoverPanel>
            </div>,
            globalThis.document.body,
          )
        : null}
    </div>
  );
}

export function ManagedDocumentSectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return <SectionHeader eyebrow="Documents" title={title} description={description} />;
}

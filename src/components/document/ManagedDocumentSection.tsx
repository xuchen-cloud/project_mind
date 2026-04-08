import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Circle, FilePlus2, Star, Upload } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import type { DocumentRecord, DocumentTagRecord, FileTagColorKey, FileTagRecord } from "../../lib/types";
import { fileUriToPath, formatDateTime } from "../../lib/formatters";
import { useDocumentMutations } from "../../hooks/useDocumentMutations";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import {
  Button,
  Dialog,
  EmptyState,
  IconButton,
  PopoverPanel,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";

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

interface ContextMenuState {
  documentId: number;
  x: number;
  y: number;
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
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [pendingTagIdsByDocumentId, setPendingTagIdsByDocumentId] = useState<Record<number, number[]>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pendingImportPaths, setPendingImportPaths] = useState<string[] | null>(null);
  const [pendingImportTagIds, setPendingImportTagIds] = useState<number[]>([]);
  const openTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openSettings = useUiStore((state) => state.openSettings);

  const { documentImportMutation, documentMetaMutation } = useDocumentMutations();
  const { pushToast } = useFeedbackStore();
  const fileTagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings"],
    queryFn: projectMindApi.fileTagSettingsGet,
  });

  const fileTags = fileTagSettingsQuery.data?.tags ?? [];
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

  const importFiles = (paths: string[], tagIds: number[]) => {
    for (const path of paths) {
      documentImportMutation.mutate({
        projectId,
        ...(activityId !== null ? { activityId } : {}),
        sourcePath: path,
        isStarred: false,
        ...(tagIds.length > 0 ? { tagIds } : {}),
      });
    }
  };

  const handleImportPaths = async (paths: string[]) => {
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

    let availableTags = fileTags;
    if (!fileTagSettingsQuery.data && !fileTagSettingsQuery.isError) {
      const result = await fileTagSettingsQuery.refetch();
      availableTags = result.data?.tags ?? [];
    }

    if (availableTags.length > 0) {
      setPendingImportPaths(paths);
      setPendingImportTagIds([]);
      return;
    }

    importFiles(paths, []);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    void handleImportPaths(readDroppedFilePaths(event));
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

  const openContextMenu = (documentId: number, x: number, y: number) => {
    clearPendingOpen();
    setContextMenu({
      documentId,
      x: Math.max(12, x),
      y: Math.max(12, y),
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

  return (
    <div ref={rootRef} className="grid gap-4">
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
        </div>

        {visibleDragActive ? (
          <div className="flex items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-3 py-2 text-ui text-text">
            <Upload size={13} />
            <span>{pageDropMessage ?? "松手即可把文件归入当前上下文"}</span>
          </div>
        ) : null}

        {filteredDocuments.length === 0 ? (
          <div className="px-3 py-3">
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
                : "grid gap-px bg-border"
            }
          >
            {filteredDocuments.map((document) => {
              const isEditing = editingDocumentId === document.id;
              const locationLabel = buildDocumentLocationLabel(document);
              const metaLine = `${locationLabel} · ${formatDateTime(document.updatedAt)}`;
              const tags = effectiveDocumentTagsById.get(document.id) ?? document.tags;
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
                  <DocumentTagDots tags={tags} />
                  {document.versionCount > 1 ? (
                    <StatusBadge tone="neutral" className="px-1 py-0 text-[10px] tracking-[0.1em]">
                      v{document.currentVersionNumber}
                    </StatusBadge>
                  ) : null}
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
                  aria-label={buildDocumentAriaLabel(document.baseName, tags)}
                  onClick={(event) => handleRowClick(document, event)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openContextMenu(document.id, event.clientX, event.clientY);
                  }}
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

      {contextMenuDocument && contextMenu ? (
        <PopoverPanel
          className="fixed z-30 min-w-[15rem] p-1.5"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          data-document-interactive="true"
          onClick={stopPropagation}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="px-2.5 py-1.5">
            <p className="truncate text-body font-medium text-text">{contextMenuDocument.baseName}</p>
            <p className="text-ui text-text-soft">选择这个文件要挂的 tag</p>
          </div>

          <div className="grid gap-1 border-t border-border pt-1">
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
            ) : (
              <p className="px-2.5 py-2 text-ui text-text-soft">还没有文件标签，先去设置里创建。</p>
            )}
          </div>

          <div className="mt-1 border-t border-border pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-full justify-start px-2.5"
              onClick={() => {
                openSettings("file-tags");
                setContextMenu(null);
              }}
            >
              管理标签
            </Button>
          </div>
        </PopoverPanel>
      ) : null}

      {pendingImportPaths ? (
        <ImportTagDialog
          paths={pendingImportPaths}
          tags={fileTags}
          selectedTagIds={pendingImportTagIds}
          onToggleTag={(tagId) =>
            setPendingImportTagIds((current) =>
              current.includes(tagId)
                ? current.filter((value) => value !== tagId)
                : [...current, tagId],
            )
          }
          onClose={() => {
            setPendingImportPaths(null);
            setPendingImportTagIds([]);
          }}
          onConfirm={() => {
            importFiles(pendingImportPaths, pendingImportTagIds);
            setPendingImportPaths(null);
            setPendingImportTagIds([]);
          }}
          onManageTags={() => {
            setPendingImportPaths(null);
            setPendingImportTagIds([]);
            openSettings("file-tags");
          }}
        />
      ) : null}
    </div>
  );
}

function buildDocumentLocationLabel(document: DocumentRecord) {
  return document.activityId ? document.sourceActivityTitle || "未命名 Activity" : "项目根目录";
}

function buildDocumentAriaLabel(baseName: string, tags: DocumentTagRecord[]) {
  if (tags.length === 0) {
    return baseName;
  }

  return `${baseName}，文件标签：${tags.map((tag) => tag.label).join("、")}`;
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
    .map((fileUri) => fileUriToPath(fileUri))
    .filter(Boolean);
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

function ImportTagDialog({
  paths,
  tags,
  selectedTagIds,
  onToggleTag,
  onClose,
  onConfirm,
  onManageTags,
}: {
  paths: string[];
  tags: FileTagRecord[];
  selectedTagIds: number[];
  onToggleTag: (tagId: number) => void;
  onClose: () => void;
  onConfirm: () => void;
  onManageTags: () => void;
}) {
  return (
    <Dialog
      open
      title="选择导入标签"
      description={`这次会把相同的 tag 一次性应用到 ${paths.length} 个待导入文件。`}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm}>
            开始导入
          </Button>
        </>
      }
      widthClassName="max-w-lg"
    >
      <div className="grid gap-4">
        <div className="rounded-[var(--radius-8)] border border-border bg-bg-subtle px-3 py-3">
          <p className="text-ui font-medium text-text-muted">本次文件</p>
          <div className="mt-2 grid gap-1 text-ui text-text-soft">
            {paths.slice(0, 4).map((path) => (
              <p key={path} className="truncate" title={path}>
                {path}
              </p>
            ))}
            {paths.length > 4 ? <p>另外还有 {paths.length - 4} 个文件</p> : null}
          </div>
        </div>

        <div className="grid gap-1">
          {tags.map((tag) => (
            <label
              key={tag.id}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-6)] border border-border px-3 py-2 text-ui text-text-muted transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text"
            >
              <input
                type="checkbox"
                checked={selectedTagIds.includes(tag.id)}
                onChange={() => onToggleTag(tag.id)}
              />
              <Circle
                size={10}
                className="fill-current"
                style={{ color: fileTagColorValue(tag.colorKey) }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{tag.label}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-ui text-text-soft">
            不选也可以，空选择代表这些文件暂时不挂 tag。
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onManageTags}>
            管理标签
          </Button>
        </div>
      </div>
    </Dialog>
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

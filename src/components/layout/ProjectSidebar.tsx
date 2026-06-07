import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  Files,
  FolderKanban,
  FolderOpen,
  NotebookText,
  Pencil,
  Presentation,
  Star,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";

import type { DocumentRecord, DocumentTagRecord, FileTagColorKey } from "../../lib/types";
import { fileTagColorValue } from "../../lib/constants";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import { useDocumentMutations } from "../../hooks/useDocumentMutations";
import { useDocumentImportFlow } from "../../hooks/useDocumentImportFlow";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton, PopoverPanel, SearchField, StatusBadge } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { DocumentImportTagDialog } from "../document/DocumentImportTagDialog";
import {
  DocumentContextMenuAction,
  DocumentVersionDropdown,
  canRenameDocument,
  handleRenameKeyDown,
  isInteractiveTarget,
  stopPropagation,
} from "../document/DocumentSharedComponents";

export interface ProjectSidebarRecordItem {
  id: number;
  title?: string | null;
  typeLabel: string;
  contentMarkdown: string;
  tags: Array<{ id: number; label: string; colorKey: FileTagColorKey }>;
  updatedAt: string;
}

export interface ProjectSidebarDocumentItem {
  id: number;
  projectId: number;
  name: string;
  baseName: string;
  mimeType: string;
  managedPath: string;
  originalPath: string;
  historyDirPath: string;
  isStarred: boolean;
  currentVersionNumber: number;
  versionCount: number;
  health: "normal" | "missing";
  tags: Array<{ id: number; label: string; colorKey: FileTagColorKey }>;
}

interface ProjectSidebarProps {
  project: {
    id: number;
    name: string;
    kind?: "normal" | "reference";
    rootPath: string;
    isArchived?: boolean;
  };
  records?: ProjectSidebarRecordItem[];
  documents?: ProjectSidebarDocumentItem[];
  activeRecordId?: number | null;
  onOpenProject: () => void;
  onOpenRecord?: (recordId: number) => void;
  onOpenDocument?: (document: ProjectSidebarDocumentItem) => void;
}

type ProjectSidebarTab = "records" | "files";

interface ContextMenuState {
  documentId: number;
  x: number;
  y: number;
}

const CONTEXT_MENU_WIDTH = 280;
const CONTEXT_MENU_HEIGHT = 464;
const CONTEXT_MENU_VIEWPORT_PADDING = 12;

export function ProjectSidebar({
  project,
  records: explicitRecords,
  documents = [],
  activeRecordId,
  onOpenProject,
  onOpenRecord,
  onOpenDocument,
}: ProjectSidebarProps) {
  const { projectSidebarCollapsed, projectSidebarWidthPx, toggleProjectSidebarCollapsed, setProjectSidebarWidthPx } = useUiStore();
  const { pushToast } = useFeedbackStore();
  const {
    documentMetaMutation,
    documentAddVersionMutation,
    documentDeleteMutation,
  } = useDocumentMutations();
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
    projectId: project.id,
  });

  const records = explicitRecords ?? [];
  const currentRecordId = activeRecordId;
  const openRecord = onOpenRecord ?? (() => undefined);

  // UI State
  const [activeTab, setActiveTab] = useState<ProjectSidebarTab>("records");
  const [query, setQuery] = useState("");
  const [activeTagId, setActiveTagId] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  // Document editing state
  const [editingDocumentId, setEditingDocumentId] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [pendingTagIdsByDocumentId, setPendingTagIdsByDocumentId] = useState<Record<number, number[]>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const openTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  const tagOptions = useMemo(() => {
    const map = new Map<number, { id: number; label: string; colorKey: FileTagColorKey; count: number }>();
    const items = activeTab === "records" ? records : documents;

    for (const item of items) {
      for (const tag of item.tags) {
        const current = map.get(tag.id);
        map.set(tag.id, { ...tag, count: (current?.count ?? 0) + 1 });
      }
    }
    return Array.from(map.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "zh-Hans-CN"),
    );
  }, [activeTab, documents, records]);

  // Sort documents: starred first, then by updated date
  const sortedDocuments = useMemo(
    () =>
      [...documents].sort((left, right) => {
        if (left.isStarred !== right.isStarred) {
          return Number(right.isStarred) - Number(left.isStarred);
        }
        // Assuming documents have updatedAt - if not available, keep original order
        return 0;
      }),
    [documents],
  );

  const effectiveDocumentTagsById = useMemo(
    () =>
      new Map(
        sortedDocuments.map((document) => [
          document.id,
          buildEffectiveDocumentTags(document, pendingTagIdsByDocumentId[document.id], fileTagLookup),
        ]),
      ),
    [sortedDocuments, fileTagLookup, pendingTagIdsByDocumentId],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRecords = records.filter((record) => {
    const matchesQuery =
      !normalizedQuery ||
      (record.title ?? "").toLowerCase().includes(normalizedQuery) ||
      record.typeLabel.toLowerCase().includes(normalizedQuery) ||
      record.contentMarkdown.toLowerCase().includes(normalizedQuery) ||
      record.tags.some((tag) => tag.label.toLowerCase().includes(normalizedQuery));
    const matchesTag = activeTagId === null || record.tags.some((tag) => tag.id === activeTagId);
    return matchesQuery && matchesTag;
  });

  const filteredDocuments = sortedDocuments.filter((document) => {
    const matchesQuery =
      !normalizedQuery ||
      document.name.toLowerCase().includes(normalizedQuery) ||
      (effectiveDocumentTagsById.get(document.id) ?? document.tags).some((tag) =>
        tag.label.toLowerCase().includes(normalizedQuery),
      );
    const matchesTag =
      activeTagId === null ||
      (effectiveDocumentTagsById.get(document.id) ?? document.tags).some((tag) => tag.id === activeTagId);
    return matchesQuery && matchesTag;
  });

  const contextMenuDocument = contextMenu
    ? sortedDocuments.find((document) => document.id === contextMenu.documentId) ?? null
    : null;

  // Debug: Global drag listeners
  useEffect(() => {
    const handleGlobalDragEnter = (e: globalThis.DragEvent) => {
      console.log('🌍 Global dragenter detected', e.target);
    };
    const handleGlobalDragOver = (e: globalThis.DragEvent) => {
      console.log('🌍 Global dragover detected', e.target);
    };
    const handleGlobalDrop = (e: globalThis.DragEvent) => {
      console.log('🌍 Global drop detected', e.target);
    };

    window.addEventListener('dragenter', handleGlobalDragEnter);
    window.addEventListener('dragover', handleGlobalDragOver);
    window.addEventListener('drop', handleGlobalDrop);

    console.log('✅ Global drag listeners attached to ProjectSidebar');

    return () => {
      window.removeEventListener('dragenter', handleGlobalDragEnter);
      window.removeEventListener('dragover', handleGlobalDragOver);
      window.removeEventListener('drop', handleGlobalDrop);
    };
  }, []);

  // Cleanup timer on unmount
  useEffect(
    () => () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current);
      }
    },
    [],
  );

  // Close context menu on outside click or Escape
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

  // Sync pending tags with actual document tags
  useEffect(() => {
    setPendingTagIdsByDocumentId((current) => {
      const next: Record<number, number[]> = {};
      let changed = false;

      for (const [documentIdText, tagIds] of Object.entries(current)) {
        const documentId = Number(documentIdText);
        const actualTagIds =
          sortedDocuments.find((document) => document.id === documentId)?.tags.map((tag) => tag.id) ?? null;
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
  }, [sortedDocuments]);

  // Close context menu if document is removed
  useEffect(() => {
    if (contextMenu && !sortedDocuments.some((document) => document.id === contextMenu.documentId)) {
      setContextMenu(null);
    }
  }, [contextMenu, sortedDocuments]);

  // Document operation handlers
  const runDesktopAction = async (action: Promise<unknown>, title: string, detail?: string) => {
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
    console.log('handleImportPaths called with:', paths);
    await requestImportPaths(paths);
    console.log('requestImportPaths completed');
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    console.log('handleDrop triggered', event); // Debug

    try {
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);

      console.log('DataTransfer object:', event.dataTransfer); // Debug
      console.log('DataTransfer.files:', event.dataTransfer.files); // Debug
      console.log('DataTransfer.items:', event.dataTransfer.items); // Debug

      const paths = extractDroppedFilePaths(event.dataTransfer);
      console.log('Dropped files:', paths); // Debug log

      if (paths.length === 0) {
        console.log('No paths extracted, showing error toast'); // Debug
        pushToast({
          tone: "error",
          title: "无法读取拖拽文件",
          detail: "请确保拖拽的是本地文件。",
        });
        return;
      }

      console.log('Calling handleImportPaths with paths:', paths); // Debug
      void handleImportPaths(paths);
    } catch (error) {
      console.error('Error in handleDrop:', error); // Debug
    }
  };

  const openDocument = (document: ProjectSidebarDocumentItem) => {
    if (document.health === "missing") {
      pushToast({
        tone: "error",
        title: "文件已失效",
        detail: "当前文件路径已失效，请重新导入该文件。",
      });
      return;
    }

    void runDesktopAction(desktopApi.openFile(document.managedPath), "打开文件失败", document.managedPath);
  };

  const openDocumentLocation = (document: ProjectSidebarDocumentItem) => {
    if (document.health === "missing") {
      return;
    }

    void runDesktopAction(
      desktopApi.revealInExplorer(document.managedPath),
      "打开文件所在位置失败",
      document.managedPath,
    );
  };

  const addDocumentVersionAndOpen = async (document: ProjectSidebarDocumentItem) => {
    if (document.health === "missing") {
      return;
    }

    try {
      const nextDocument = await documentAddVersionMutation.mutateAsync({
        documentId: document.id,
      });
      await runDesktopAction(desktopApi.openFile(nextDocument.managedPath), "打开文件失败", nextDocument.managedPath);
    } catch {
      return;
    }
  };

  const deleteDocument = (document: ProjectSidebarDocumentItem) => {
    documentDeleteMutation.mutate({ documentId: document.id });
  };

  const beginRename = (document: ProjectSidebarDocumentItem) => {
    if (!canRenameDocument(document as DocumentRecord)) {
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

  const commitRename = (document: ProjectSidebarDocumentItem) => {
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

  const handleDocumentClick = (document: ProjectSidebarDocumentItem, event: MouseEvent<HTMLElement>) => {
    if (editingDocumentId === document.id) {
      return;
    }

    // Check if clicking on specific interactive elements that should prevent opening
    const target = event.target as HTMLElement;

    // Allow clicking anywhere except:
    // 1. Input elements (rename input)
    // 2. Elements with data-document-interactive that are buttons or clickable (version dropdown, etc)
    const isInput = target.tagName === 'INPUT';
    const isInteractiveButton = target.closest('[data-document-interactive="true"]')?.tagName === 'BUTTON';

    if (isInput || isInteractiveButton) {
      return;
    }

    clearPendingOpen();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      if (onOpenDocument) {
        onOpenDocument(document);
      } else {
        openDocument(document);
      }
    }, 180);
  };

  const handleDocumentMouseDownCapture = (document: ProjectSidebarDocumentItem, event: MouseEvent<HTMLElement>) => {
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
        : Math.max(CONTEXT_MENU_VIEWPORT_PADDING, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_VIEWPORT_PADDING);
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

  const handleDocumentKeyDown = (document: ProjectSidebarDocumentItem, event: KeyboardEvent<HTMLElement>) => {
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
      if (onOpenDocument) {
        onOpenDocument(document);
      } else {
        openDocument(document);
      }
    }
  };

  const toggleDocumentTag = (document: ProjectSidebarDocumentItem, tagId: number) => {
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

  const toggleDocumentStar = (document: ProjectSidebarDocumentItem) => {
    documentMetaMutation.mutate({
      documentId: document.id,
      isStarred: !document.isStarred,
    });
  };

  // Resize handler
  const handleResizeStart = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const newWidth = event.clientX;
      setProjectSidebarWidthPx(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, setProjectSidebarWidthPx]);

  return (
    <aside
      ref={rootRef}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-border bg-[color-mix(in_srgb,var(--color-bg-subtle)_88%,var(--color-bg))]",
        projectSidebarCollapsed ? "" : "transition-[width] duration-[160ms] ease-[var(--ease-soft)]",
      )}
      style={{
        width: projectSidebarCollapsed ? "48px" : `${projectSidebarWidthPx}px`,
      }}
      aria-label="项目导航侧边栏"
    >
      {!projectSidebarCollapsed && (
        <div
          className={cn(
            "absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent/20",
            isResizing && "bg-accent/30",
          )}
          onMouseDown={handleResizeStart}
        />
      )}
      <div className={cn("relative border-b border-border px-3 py-3", projectSidebarCollapsed && "px-2")}>
        <button
          type="button"
          title={`${project.name}\n${project.rootPath}`}
          className={cn(
            "rounded-[var(--radius-8)] border border-transparent text-text transition-colors hover:border-border hover:bg-bg",
            projectSidebarCollapsed
              ? "flex h-9 w-9 items-center justify-center"
              : "flex w-full items-center gap-3 px-3 py-2.5 pr-12 text-left",
          )}
          onClick={onOpenProject}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-muted">
            <FolderKanban size={16} />
          </span>
          {!projectSidebarCollapsed ? (
            <span className="min-w-0">
              <span className="block truncate text-title font-medium">{project.name}</span>
              <span className="mt-1 flex items-center gap-2">
                <StatusBadge tone="neutral">{project.isArchived ? "archived" : "overview"}</StatusBadge>
              </span>
            </span>
          ) : null}
        </button>
        <IconButton
          type="button"
          size="sm"
          variant={projectSidebarCollapsed ? "ghost" : "secondary"}
          className={projectSidebarCollapsed ? undefined : "absolute right-3 top-3"}
          aria-label={projectSidebarCollapsed ? "展开项目侧边栏" : "收起项目侧边栏"}
          onClick={toggleProjectSidebarCollapsed}
        >
          {projectSidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </IconButton>
      </div>

      <div
        className={cn("flex min-h-0 flex-1 flex-col px-3 py-3", projectSidebarCollapsed && "px-2")}
        onDragOver={(event) => {
          if (activeTab === "files" && !projectSidebarCollapsed) {
            console.log('Container onDragOver triggered'); // Debug
            event.preventDefault();
            event.stopPropagation();
            setDragActive(true);
          }
        }}
        onDragEnter={(event) => {
          if (activeTab === "files" && !projectSidebarCollapsed) {
            console.log('Container onDragEnter triggered'); // Debug
            event.preventDefault();
            event.stopPropagation();
            setDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (activeTab === "files" && !projectSidebarCollapsed) {
            console.log('Container onDragLeave triggered'); // Debug
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX;
            const y = event.clientY;
            // Check if we're still inside the container
            if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
              setDragActive(false);
            }
          }
        }}
        onDrop={(event) => {
          if (activeTab === "files" && !projectSidebarCollapsed) {
            handleDrop(event);
          }
        }}
      >
        {projectSidebarCollapsed ? (
          <div className="flex flex-col items-center gap-2">
            {records.slice(0, 12).map((record) => (
              <button
                key={record.id}
                type="button"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-[var(--radius-8)] border text-ui font-medium",
                  record.id === currentRecordId
                    ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                    : "border-transparent text-text-muted hover:border-border hover:bg-bg-hover hover:text-text",
                )}
                title={record.title ?? record.typeLabel}
                onClick={() => openRecord(record.id)}
              >
                <NotebookText size={15} />
              </button>
            ))}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="grid shrink-0 gap-3">
              <div className="grid grid-cols-2 rounded-[var(--radius-8)] bg-bg p-1" role="tablist" aria-label="项目侧边栏视图">
                <TabButton active={activeTab === "records"} onClick={() => setActiveTab("records")}>
                  记录 {records.length}
                </TabButton>
                <TabButton active={activeTab === "files"} onClick={() => setActiveTab("files")}>
                  文件 {documents.length}
                </TabButton>
              </div>
              <div className="flex items-center gap-2">
                <SearchField
                  aria-label={activeTab === "records" ? "搜索记录" : "搜索文件"}
                  placeholder={activeTab === "records" ? "搜索记录或标签" : "搜索文件或标签"}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="flex-1"
                />
                {activeTab === "files" ? (
                  <IconButton
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label="导入文件"
                    onClick={async () => {
                      const sourcePaths = await desktopApi.pickFiles({ title: `选择文件 · ${project.rootPath}` });
                      if (sourcePaths.length === 0) {
                        return;
                      }
                      await handleImportPaths(sourcePaths);
                    }}
                  >
                    <FilePlus2 size={14} />
                  </IconButton>
                ) : null}
              </div>
              {tagOptions.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  <FilterPill active={activeTagId === null} onClick={() => setActiveTagId(null)}>
                    全部
                  </FilterPill>
                  {tagOptions.map((tag) => (
                    <FilterPill
                      key={tag.id}
                      active={activeTagId === tag.id}
                      onClick={() => setActiveTagId((current) => (current === tag.id ? null : tag.id))}
                    >
                      {tag.label}
                    </FilterPill>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeTab === "records" ? (
                <div className="grid gap-1.5">
                {filteredRecords.length > 0 ? (
                  filteredRecords.map((record) => (
                    <button
                      key={record.id}
                      type="button"
                      className={cn(
                        "flex min-w-0 items-start gap-2 rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-colors",
                        record.id === currentRecordId
                          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))]"
                          : "border-transparent hover:border-border hover:bg-bg",
                      )}
                      onClick={() => openRecord(record.id)}
                    >
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-6)] bg-bg text-text-soft">
                        <NotebookText size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <p className="truncate text-body font-medium text-text">{record.title || "未命名记录"}</p>
                        <TagPreview tags={record.tags} />
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-4 text-ui text-text-soft">
                    没有匹配的记录。
                  </p>
                )}
              </div>
            ) : (
              <div
                className={cn(
                  "grid gap-1.5 rounded-[var(--radius-8)] transition-colors",
                  dragActive && "bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))]",
                )}
              >
                {dragActive ? (
                  <div className="flex items-center gap-2 rounded-[var(--radius-8)] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-3 py-2 text-ui text-text">
                    <Upload size={13} />
                    <span>松手即可导入文件</span>
                  </div>
                ) : null}
                {filteredDocuments.length > 0 ? (
                  filteredDocuments.map((document) => {
                    const isEditing = editingDocumentId === document.id;
                    const isContextOpen = contextMenu?.documentId === document.id;
                    const tags = effectiveDocumentTagsById.get(document.id) ?? document.tags;

                    return (
                      <button
                        key={document.id}
                        type="button"
                        className={cn(
                          "group flex min-w-0 items-start gap-2 rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-colors",
                          isEditing ? "" : "context-menu-no-select",
                          document.health === "missing"
                            ? "border-[color-mix(in_srgb,var(--color-danger)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-danger)_4%,var(--color-bg))]"
                            : isContextOpen
                              ? "border-border-strong bg-[color-mix(in_srgb,var(--color-bg-subtle)_88%,var(--color-bg))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-text)_4%,transparent)]"
                              : "border-transparent hover:border-border hover:bg-bg",
                        )}
                        tabIndex={0}
                        aria-label={buildDocumentAriaLabel(document.baseName, tags)}
                        onClick={(event) => handleDocumentClick(document, event)}
                        onMouseDownCapture={(event) => handleDocumentMouseDownCapture(document, event)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          openContextMenu(document.id, event.clientX, event.clientY);
                        }}
                        onKeyDown={(event) => handleDocumentKeyDown(document, event)}
                      >
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-6)] bg-bg text-text-soft">
                          {resolveDocumentIcon(document)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {document.isStarred ? (
                              <Star size={12} className="shrink-0 fill-current text-amber-500" aria-label="标星" />
                            ) : null}
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
                                  handleRenameKeyDown(document as DocumentRecord, event, cancelRename, commitRename)
                                }
                                className="inline-object-input h-6 min-w-0 flex-1 px-1.5 text-[12px] leading-4 text-text outline-none"
                              />
                            ) : (
                              <>
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
                                    document={document as DocumentRecord}
                                    onOpenVersion={(version) => {
                                      void runDesktopAction(
                                        desktopApi.openFile(version.managedPath),
                                        "打开版本文件失败",
                                        version.managedPath,
                                      );
                                    }}
                                  />
                                ) : null}
                              </>
                            )}
                            {document.health === "missing" ? (
                              <StatusBadge tone="danger" className="shrink-0 px-1 py-0 text-[10px] tracking-[0.1em]">
                                失效
                              </StatusBadge>
                            ) : null}
                          </span>
                          <TagPreview tags={tags} />
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-4 text-ui text-text-soft">
                    没有匹配的文件。
                  </p>
                )}
              </div>
            )}
            </div>
          </div>
        )}
      </div>

      {/* Context Menu */}
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
              disabled={!canRenameDocument(contextMenuDocument as DocumentRecord)}
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
                toggleDocumentStar(contextMenuDocument);
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

      {/* Import Dialog */}
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
    </aside>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "rounded-[var(--radius-6)] px-2 py-1.5 text-ui font-medium transition-colors",
        active ? "bg-bg-subtle text-text shadow-[var(--shadow-sm)]" : "text-text-soft hover:text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FilterPill({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-[var(--radius-6)] border px-2 py-1 text-caption transition-colors",
        active
          ? "border-border-strong bg-bg text-text"
          : "border-transparent text-text-soft hover:border-border hover:bg-bg-hover hover:text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TagPreview({ tags }: { tags: ProjectSidebarRecordItem["tags"] }) {
  if (tags.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {tags.slice(0, 3).map((tag) => (
        <span key={tag.id} className="rounded-[var(--radius-6)] bg-bg px-1.5 py-0.5 text-caption text-text-soft">
          {tag.label}
        </span>
      ))}
    </span>
  );
}

function resolveDocumentIcon(document: ProjectSidebarDocumentItem) {
  const mimeType = document.mimeType.trim().toLowerCase();
  const extension = document.name.split(".").pop()?.trim().toLowerCase() ?? "";

  let Icon: LucideIcon = File;

  if (mimeType.startsWith("image/")) Icon = FileImage;
  else if (mimeType.includes("spreadsheet") || ["csv", "xls", "xlsx"].includes(extension)) Icon = FileSpreadsheet;
  else if (mimeType.includes("presentation") || ["ppt", "pptx", "key"].includes(extension)) Icon = Presentation;
  else if (mimeType.includes("zip") || mimeType.includes("compressed") || ["zip", "rar", "7z", "gz", "tar"].includes(extension)) Icon = FileArchive;
  else if (mimeType.includes("json") || mimeType.includes("xml") || ["js", "ts", "tsx", "jsx", "rs", "py", "json", "md"].includes(extension)) Icon = FileCode2;
  else if (mimeType.startsWith("text/") || ["txt", "pdf", "doc", "docx"].includes(extension)) Icon = FileText;

  return <Icon size={15} aria-hidden="true" />;
}

function buildDocumentAriaLabel(baseName: string, tags: DocumentTagRecord[]) {
  if (tags.length === 0) {
    return baseName;
  }

  return `${baseName}，文件标签：${tags.map((tag) => tag.label).join("、")}`;
}

function buildEffectiveDocumentTags(
  document: ProjectSidebarDocumentItem,
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

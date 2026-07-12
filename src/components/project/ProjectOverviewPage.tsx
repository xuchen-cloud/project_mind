import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save, Settings2, Trash2 } from "lucide-react";

import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  renderMarkdownToHtml,
  RichEditor,
  type RichEditorAssetHandlers,
  type RichEditorController,
  type RichEditorSelectionPayload,
  type RichEditorValue,
} from "../rich-editor";
import {
  buildProjectNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "../rich-editor/noteImageAssets";
import type {
  FileTagRecord,
  NoteRecord,
  ProjectPageData,
  TodoPriority,
} from "../../lib/types";
import {
  parseFocusRecordId,
  parseRouteId,
  projectPath,
  recordFocusId,
  recordPath,
} from "../../lib/formatters";
import {
  filterProjectRecords,
  parseRecordFilterTagId,
} from "../../lib/project-records";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import { withPageWidthClass } from "../../lib/pageWidth";
import { queryKeys } from "../../lib/queryKeys";
import {
  extractHashTagLabels,
  findTagByLabel,
  mergeUniqueTagIds,
  colorKeyForTagLabel,
} from "../../lib/tags";
import { extractTagMentionIds } from "../../lib/tagMentions";
import { resolveTodoContentTagSync, todoTagIds } from "../../lib/todo-tag-sync";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useDocumentImportFlow } from "../../hooks/useDocumentImportFlow";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import { projectMindApi } from "../../services/projectMindApi";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { ActionContextMenu, Button, EmptyState, IconButton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { DocumentImportTagDialog } from "../document/DocumentImportTagDialog";
import { appendMarkdownSection } from "../../lib/record-move";
import { MoveSelectionToRecordCard } from "../record/MoveSelectionToRecordCard";
import { RecordListItem } from "../record/RecordListItem";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { TodoRail } from "../todo";

const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

type ProjectPageView = "quick-note" | "record";

interface ProjectOverviewPageProps {
  projectIdOverride?: number | null;
  searchParamsOverride?: URLSearchParams;
  visible?: boolean;
  onSearchParamsOverride?: (
    nextSearchParams: URLSearchParams,
    options?: { replace?: boolean },
  ) => void;
}

export function ProjectOverviewPage({
  projectIdOverride,
  searchParamsOverride,
  visible = true,
  onSearchParamsOverride,
}: ProjectOverviewPageProps = {}) {
  const params = useParams();
  const [routeSearchParams, setRouteSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const searchParams = searchParamsOverride ?? routeSearchParams;
  const setProjectSearchParams = onSearchParamsOverride ?? setRouteSearchParams;
  const projectId = projectIdOverride ?? parseRouteId(params.projectId);
  const focusId = searchParams.get("focus");
  const focusedRecordId = parseFocusRecordId(focusId);
  const shouldAutoFocusProjectName = searchParams.get("renameProject") === "1";
  const explicitView = parseProjectPageView(searchParams.get("view"));
  const composeRecord = searchParams.get("compose") === "record";
  const routeView =
    explicitView ?? (focusedRecordId !== null ? "record" : "quick-note");
  const [buttonView, setButtonView] = useState<ProjectPageView | null>(null);
  const currentView = buttonView ?? routeView;
  const { pushToast } = useFeedbackStore();
  const { openSettings, pageWidthMode, projectSidebarCollapsed, todoRailCollapsed } = useUiStore();
  const openInternalReference = useInternalReferenceNavigation();
  const openContactMention = useContactMentionNavigation();
  const contactMentionOptions = useContactMentionOptions();

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: visible,
  });
  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );
  const activeProject = useMemo(
    () => (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null,
    [projectId, projectsQuery.data],
  );
  const projectQuickNoteAssetHandlers = useMemo<RichEditorAssetHandlers | undefined>(() => {
    if (!projectId) {
      return undefined;
    }

    return buildProjectNoteImageAssetHandlers(projectId, null);
  }, [projectId]);
  const projectPageQuery = useQuery({
    queryKey: queryKeys.projectPage(projectId),
    queryFn: () => projectMindApi.projectPageGet({ projectId: projectId as number }),
    enabled: visible && projectId !== null,
  });
  const tagSettingsQuery = useQuery({
    queryKey: queryKeys.fileTags.project(projectId),
    queryFn: () => projectMindApi.fileTagSettingsGet({ projectId: projectId as number }),
    enabled: visible && projectId !== null,
  });
  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
    enabled: visible,
  });
  const { projectUpdateMutation } = useProjectMutations(visibleProjects, (path) => navigate(path));
  const allTodos = [
    ...(projectPageQuery.data?.unfinishedTodos ?? []),
    ...(projectPageQuery.data?.finishedTodos ?? []),
  ];
  const {
    todoMutation,
    todoContentMutation,
    todoStatusMutation,
    todoPriorityMutation,
    todoTagMutation,
    todoProgressMutation,
    todoProgressUpdateMutation,
    todoProgressDeleteMutation,
    todoDeleteMutation,
  } = useTodoMutations(allTodos);

  const [nameDraft, setNameDraft] = useState("");
  const [quickNoteDraft, setQuickNoteDraft] = useState<RichEditorValue>(EMPTY_VALUE);
  const [quickNoteCodeLanguage, setQuickNoteCodeLanguage] = useState<string | null>(null);
  const [quickNoteMoveSelection, setQuickNoteMoveSelection] =
    useState<RichEditorSelectionPayload | null>(null);
  const [recordDraftOpen, setRecordDraftOpen] = useState(composeRecord);
  const [recordDraftTitle, setRecordDraftTitle] = useState("");
  const [recordDraftValue, setRecordDraftValue] = useState<RichEditorValue>(EMPTY_VALUE);
  const [recordDraftCodeLanguage, setRecordDraftCodeLanguage] = useState<string | null>(null);
  const [recordDraftTagIds, setRecordDraftTagIds] = useState<number[]>([]);
  const [savingRecordId, setSavingRecordId] = useState<number | null>(null);
  const [recordContextMenu, setRecordContextMenu] = useState<{
    x: number;
    y: number;
    noteId: number;
  } | null>(null);
  const [pageDragActive, setPageDragActive] = useState(false);
  const quickNoteEditorRef = useRef<RichEditorController | null>(null);
  const recordDraftEditorRef = useRef<RichEditorController | null>(null);
  const projectNameInputRef = useRef<HTMLInputElement | null>(null);
  const autoFocusedProjectNameIdRef = useRef<number | null>(null);
  const projectPage = projectPageQuery.data;
  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const aiSettings = aiSettingsQuery.data ?? null;
  const allRecords = useMemo(() => projectPage?.records ?? [], [projectPage?.records]);
  const recordSearchQuery = searchParams.get("recordQuery") ?? "";
  const recordFilterTagId = useMemo(
    () => parseRecordFilterTagId(searchParams.get("recordTag")),
    [searchParams],
  );
  const records = useMemo(
    () =>
      filterProjectRecords(allRecords, {
        query: recordSearchQuery,
        tagId: recordFilterTagId,
      }),
    [allRecords, recordFilterTagId, recordSearchQuery],
  );
  const visibleRecordFocusKey = useMemo(
    () => records.map((record) => record.id).join(","),
    [records],
  );
  const contextMenuRecord = recordContextMenu
    ? records.find((record) => record.id === recordContextMenu.noteId) ?? null
    : null;

  useEffect(() => {
    if (recordContextMenu && !contextMenuRecord) {
      setRecordContextMenu(null);
    }
  }, [contextMenuRecord, recordContextMenu]);

  useFocusTarget(
    visible && focusedRecordId !== null && currentView === "record"
      ? recordFocusId(focusedRecordId)
      : null,
    [currentView, visible, visibleRecordFocusKey],
  );

  const {
    fileTags,
    pendingImportPaths,
    pendingImportTagIds,
    requestImportPaths,
    togglePendingImportTag,
    closeImportTagDialog,
    confirmImportTagDialog,
    manageImportTags,
  } = useDocumentImportFlow({ projectId });

  useEffect(() => {
    if (buttonView === null || buttonView === routeView) {
      setButtonView(null);
    }
  }, [buttonView, routeView]);

  useEffect(() => {
    if (!activeProject) return;

    setNameDraft(activeProject.name);
    setQuickNoteCodeLanguage(activeProject.quickNoteCodeLanguage ?? null);

    if (!visible) {
      return;
    }

    const nextDraft = buildProjectQuickNoteDraft(activeProject);
    setQuickNoteDraft((current) => {
      if (
        current.html === nextDraft.html &&
        current.text === nextDraft.text &&
        current.markdown === nextDraft.markdown
      ) {
        return current;
      }

      return nextDraft;
    });
  }, [activeProject, visible]);

  useEffect(() => {
    setRecordDraftOpen(composeRecord);
  }, [composeRecord]);

  useEffect(() => {
    if (!visible || !activeProject || !shouldAutoFocusProjectName) {
      return;
    }

    if (autoFocusedProjectNameIdRef.current === activeProject.id) {
      return;
    }

    autoFocusedProjectNameIdRef.current = activeProject.id;

    const timeoutId = window.setTimeout(() => {
      projectNameInputRef.current?.focus();
      projectNameInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [activeProject, shouldAutoFocusProjectName, visible]);

  async function refreshProject() {
    if (!projectId) return;

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.fileTags.project(projectId) }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]);
  }

  function upsertRecordInProjectCache(record: NoteRecord) {
    queryClient.setQueryData<ProjectPageData | undefined>(
      queryKeys.projectPage(record.projectId),
      (current) => {
        if (!current) {
          return current;
        }

        const currentRecords = current.records ?? [];
        const existingIndex = currentRecords.findIndex((item) => item.id === record.id);
        const nextRecords =
          existingIndex >= 0
            ? currentRecords.map((item) => (item.id === record.id ? record : item))
            : [record, ...currentRecords];

        return {
          ...current,
          records: nextRecords,
        };
      },
    );
  }

  function removeRecordFromProjectCache(noteId: number) {
    queryClient.setQueryData<ProjectPageData | undefined>(
      queryKeys.projectPage(projectId),
      (current) => {
        if (!current?.records) {
          return current;
        }

        return {
          ...current,
          records: current.records.filter((item) => item.id !== noteId),
        };
      },
    );
  }

  async function ensureTagIdsFromText(markdown: string, explicitTagIds: number[]) {
    if (!projectId) return explicitTagIds;

    const mentionedTagIds = extractTagMentionIds(markdown);
    const hashLabels = extractHashTagLabels(markdown);
    const hashTagIds: number[] = [];

    for (const label of hashLabels) {
      const existing = findTagByLabel(availableTags, label);
      const tag =
        existing ??
        (await projectMindApi.fileTagOptionUpsert({
          projectId,
          label,
          colorKey: colorKeyForTagLabel(label),
        }));
      hashTagIds.push(tag.id);
    }

    return mergeUniqueTagIds(explicitTagIds, mentionedTagIds, hashTagIds);
  }

  function syncProjectTagCache(tag: FileTagRecord) {
    queryClient.setQueryData<{ tags: FileTagRecord[] } | undefined>(
      queryKeys.fileTags.project(projectId),
      (current) => {
        const tags = current?.tags ?? [];
        if (tags.some((item) => item.id === tag.id)) {
          return current ?? { tags };
        }

        return {
          tags: [...tags, tag].sort((left, right) =>
            left.label.localeCompare(right.label, "zh-Hans-CN"),
          ),
        };
      },
    );
  }

  async function saveProjectName() {
    if (!activeProject) return;

    const nextName = nameDraft.trim();
    if (!nextName || nextName === activeProject.name) return;

    await projectUpdateMutation.mutateAsync({
      projectId: activeProject.id,
      name: nextName,
      quickNote: activeProject.quickNote,
      quickNoteMarkdown: activeProject.quickNoteMarkdown,
      quickNoteHtml: activeProject.quickNoteHtml,
      quickNoteCodeLanguage: activeProject.quickNoteCodeLanguage ?? null,
      status: activeProject.status,
    });
  }

  async function saveProjectQuickNote(value: RichEditorValue) {
    if (!activeProject) return;

    const externalizedValue = await externalizeEmbeddedImageDataUrls(
      value,
      projectQuickNoteAssetHandlers,
    );
    const normalized = normalizeRichEditorValue(externalizedValue);
    await projectUpdateMutation.mutateAsync({
      projectId: activeProject.id,
      quickNote: normalized.text,
      quickNoteMarkdown: normalized.markdown,
      quickNoteHtml: normalized.html,
      quickNoteCodeLanguage,
      status: activeProject.status,
    });
  }

  async function createRecord() {
    const nextValue = recordDraftEditorRef.current?.getValue() ?? recordDraftValue;

    if (!projectId || !nextValue.markdown.trim()) return;

    const externalizedValue = await externalizeEmbeddedImageDataUrls(
      nextValue,
      projectQuickNoteAssetHandlers,
    );
    const normalized = normalizeRichEditorValue(externalizedValue);
    const tagIds = await ensureTagIdsFromText(normalized.markdown, recordDraftTagIds);
    const savedRecord = await projectMindApi.projectRecordUpsert({
      projectId,
      title: recordDraftTitle.trim() || undefined,
      markdown: normalized.markdown,
      html: normalized.html,
      defaultCodeLanguage: recordDraftCodeLanguage,
      tagIds,
    });
    upsertRecordInProjectCache(savedRecord);
    closeRecordDraft();
    setRecordDraftTitle("");
    setRecordDraftValue(EMPTY_VALUE);
    setRecordDraftCodeLanguage(null);
    setRecordDraftTagIds([]);
  }

  async function saveRecord(
    note: NoteRecord,
    value: RichEditorValue,
    title: string,
    tagIds: number[],
    defaultCodeLanguage: string | null,
  ) {
    setSavingRecordId(note.id);

    try {
      const recordAssetHandlers = buildProjectNoteImageAssetHandlers(
        note.projectId,
        note.activityId ?? null,
      );
      const externalizedValue = await externalizeEmbeddedImageDataUrls(value, recordAssetHandlers);
      const normalized = normalizeRichEditorValue(externalizedValue);
      const nextTagIds = await ensureTagIdsFromText(normalized.markdown, tagIds);
      const savedRecord = await projectMindApi.projectRecordUpsert({
        projectId: note.projectId,
        activityId: note.activityId ?? undefined,
        noteId: note.id,
        title: title.trim() || undefined,
        markdown: normalized.markdown,
        html: normalized.html,
        defaultCodeLanguage,
        tagIds: nextTagIds,
      });
      upsertRecordInProjectCache(savedRecord);
    } finally {
      setSavingRecordId(null);
    }
  }

  async function moveQuickNoteSelectionToProjectRecord(record: NoteRecord) {
    const selection = quickNoteMoveSelection;
    if (!selection) {
      return;
    }

    try {
      const markdown = appendMarkdownSection(record.contentMarkdown, selection.markdown);
      const html = renderMarkdownToHtml(markdown);
      const tagIds = await ensureTagIdsFromText(
        markdown,
        (record.tags ?? []).map((tag) => tag.id),
      );
      const savedRecord = await projectMindApi.projectRecordUpsert({
        projectId: record.projectId,
        activityId: record.activityId ?? undefined,
        noteId: record.id,
        title: record.title?.trim() || undefined,
        markdown,
        html,
        defaultCodeLanguage: record.defaultCodeLanguage ?? null,
        tagIds,
      });

      upsertRecordInProjectCache(savedRecord);
      await selection.removeSelectionAndSave();
      await refreshProject();
      pushToast({ tone: "success", title: "已移动到记录", detail: record.title?.trim() || "未命名记录" });
      setQuickNoteMoveSelection(null);
    } catch (error) {
      pushToast({ tone: "error", title: "移动到记录失败", detail: String(error) });
      throw error;
    }
  }

  async function createProjectRecordFromQuickNoteSelection(title?: string) {
    const selection = quickNoteMoveSelection;
    if (!selection || !projectId) {
      return;
    }

    try {
      const markdown = selection.markdown.trim();
      const html = renderMarkdownToHtml(markdown);
      const tagIds = await ensureTagIdsFromText(markdown, []);
      const savedRecord = await projectMindApi.projectRecordUpsert({
        projectId,
        title: title?.trim() || undefined,
        markdown,
        html,
        tagIds,
      });

      upsertRecordInProjectCache(savedRecord);
      await selection.removeSelectionAndSave();
      await refreshProject();
      pushToast({ tone: "success", title: "已创建记录", detail: savedRecord.title?.trim() || "未命名记录" });
      setQuickNoteMoveSelection(null);
    } catch (error) {
      pushToast({ tone: "error", title: "创建记录失败", detail: String(error) });
      throw error;
    }
  }

  async function deleteRecord(note: NoteRecord) {
    await projectMindApi.projectRecordDelete({ noteId: note.id });
    removeRecordFromProjectCache(note.id);
  }

  function openRecordContextMenu(event: ReactMouseEvent, noteId: number) {
    event.preventDefault();
    event.stopPropagation();
    setRecordContextMenu({ x: event.clientX, y: event.clientY, noteId });
  }

  async function createTodo(payload: { content: string; priority: TodoPriority }) {
    if (!projectId) return;

    const synced = await resolveTodoContentTagSync({
      projectId,
      content: payload.content,
      explicitTagIds: [],
      availableTags,
    });
    await todoMutation.mutateAsync({ projectId, ...payload, content: synced.content, tagIds: synced.tagIds });
  }

  async function updateTodoContent(todoId: number, content: string) {
    const currentTodo = allTodos.find((todo) => todo.id === todoId);
    if (!currentTodo) {
      await todoContentMutation.mutateAsync({ todoId, content });
      return;
    }

    const synced = await resolveTodoContentTagSync({
      projectId: currentTodo.projectId,
      content,
      explicitTagIds: todoTagIds(currentTodo.tags),
      availableTags,
    });
    await todoContentMutation.mutateAsync({
      todoId,
      content: synced.content,
      tagIds: synced.tagIds,
    });
  }

  function setProjectPageView(nextView: ProjectPageView) {
    setButtonView(nextView);
    const nextSearchParams = new URLSearchParams(searchParams);

    if (nextView === "quick-note") {
      if (focusedRecordId !== null) {
        nextSearchParams.set("view", "quick-note");
      } else {
        nextSearchParams.delete("view");
      }
    } else {
      nextSearchParams.set("view", "record");
    }

    setProjectSearchParams(nextSearchParams);
  }

  function clearRecordFocus() {
    if (focusedRecordId === null) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("focus");
    nextSearchParams.set("view", "record");
    setProjectSearchParams(nextSearchParams, { replace: true });
  }

  function closeRecordDraft() {
    setRecordDraftOpen(false);
    if (!composeRecord) return;

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("compose");
    setProjectSearchParams(nextSearchParams);
  }

  if (!activeProject || !projectPage) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载项目页...
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <div className="project-overview-focus flex-1" data-testid="project-overview-focus-page">
        <header className="project-overview-focus__chrome">
          <div
            className={cn(
              "project-overview-focus__chrome-inner",
              projectSidebarCollapsed && "project-overview-focus__chrome-inner--dock-left",
              todoRailCollapsed && "project-overview-focus__chrome-inner--dock-right",
            )}
          >
            <div className="project-overview-focus__meta">
                <input
                  ref={projectNameInputRef}
                  aria-label="项目名称"
                  autoFocus={shouldAutoFocusProjectName}
                  className="project-overview-focus__title"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onFocus={(event) => {
                    if (shouldAutoFocusProjectName) {
                      event.currentTarget.select();
                    }
                  }}
                  onBlur={() => void saveProjectName()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
              <button
                type="button"
                className="project-overview-focus__path"
                onClick={() => void desktopApi.openFolder(activeProject.rootPath)}
              >
                {activeProject.rootPath}
              </button>
            </div>

            <div className="project-overview-focus__header-actions">
              <IconButton
                type="button"
                size="sm"
                variant="secondary"
                aria-label="打开页面设置"
                title="页面设置"
                onClick={() => openSettings("page-width")}
              >
                <Settings2 size={14} />
              </IconButton>
              <div
                className="project-overview-focus__view-switch"
                data-testid="project-overview-view-switch"
              >
                <button
                  type="button"
                  className={cn(
                    "project-overview-focus__view-switch-button",
                    currentView === "quick-note" &&
                      "project-overview-focus__view-switch-button--active",
                  )}
                  data-testid="project-page-view-quick-note"
                  aria-pressed={currentView === "quick-note"}
                  onClick={() => setProjectPageView("quick-note")}
                >
                  QuickNote
                </button>
                <button
                  type="button"
                  className={cn(
                    "project-overview-focus__view-switch-button",
                    currentView === "record" &&
                      "project-overview-focus__view-switch-button--active",
                  )}
                  data-testid="project-page-view-record"
                  aria-pressed={currentView === "record"}
                  onClick={() => setProjectPageView("record")}
                >
                  Record
                </button>
              </div>
            </div>
          </div>
        </header>

        <div
          className={cn(
            "project-overview-focus__scroll",
            pageDragActive && "bg-[color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg))]",
          )}
          data-testid="project-overview-focus-scroll"
          onPointerDownCapture={() => clearRecordFocus()}
          onDragOver={(event) => {
            event.preventDefault();
            setPageDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setPageDragActive(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setPageDragActive(false);
            void requestImportPaths(extractDroppedFilePaths(event.dataTransfer));
          }}
        >
          {pendingImportPaths ? (
            <DocumentImportTagDialog
              projectId={projectId as number}
              paths={pendingImportPaths}
              tags={fileTags}
              selectedTagIds={pendingImportTagIds}
              onChangeSelectedTagIds={togglePendingImportTag}
              onClose={closeImportTagDialog}
              onConfirm={() => void confirmImportTagDialog()}
              onManageTags={manageImportTags}
            />
          ) : null}

          <section
            className={withPageWidthClass("project-overview-focus__page", pageWidthMode, "focus")}
            data-testid="project-page-body-quick-note"
            style={{ display: currentView === "quick-note" ? undefined : "none" }}
            aria-hidden={currentView === "quick-note" ? undefined : true}
          >
            <RichEditor
              html={quickNoteDraft.html}
              aiSettings={aiSettings}
              defaultCodeLanguage={quickNoteCodeLanguage}
              onDefaultCodeLanguageChange={setQuickNoteCodeLanguage}
              variant="page"
              showToolbar={false}
              assetHandlers={projectQuickNoteAssetHandlers}
              tagMentions={{
                projectId: activeProject.id,
                availableTags,
                onCreateTag: async (label) => {
                  const tag = await projectMindApi.fileTagOptionUpsert({
                    projectId: activeProject.id,
                    label,
                    colorKey: colorKeyForTagLabel(label),
                  });
                  syncProjectTagCache(tag);
                  return tag;
                },
              }}
              internalReferences={{
                context: { scope: "project", projectId: activeProject.id },
                onOpenReference: openInternalReference,
              }}
              contactMentions={contactMentionOptions}
              selectionActions={[
                {
                  key: "project-selection-move-to-record",
                  label: "移动到记录",
                  icon: null as never,
                  onSelect: (selection) => {
                    setQuickNoteMoveSelection(selection);
                  },
                },
              ]}
              autosave={{
                delay: 120000,
                onBlur: true,
                onWindowBlur: true,
                onVisibilityChange: true,
              }}
              controllerRef={quickNoteEditorRef}
              onOpenAiSettings={() => openSettings("ai-rewrite")}
              onSave={saveProjectQuickNote}
            />
          </section>
          <section
            className={withPageWidthClass(
              "project-overview-focus__page project-overview-focus__page--history",
              pageWidthMode,
              "history",
            )}
            data-testid="project-overview-body-history"
            style={{ display: currentView === "record" ? undefined : "none" }}
            aria-hidden={currentView === "record" ? undefined : true}
          >
              {recordDraftOpen ? (
                <article className="project-history-record project-history-record--draft project-history-record--editing">
                  <div className="project-history-record__editor">
                    <div className="project-history-record__header">
                      <div className="project-history-record__header-main">
                        <TextField
                          aria-label="记录标题"
                          value={recordDraftTitle}
                          placeholder="记录标题"
                          className="project-history-record__title-input"
                          onChange={(event) => setRecordDraftTitle(event.target.value)}
                        />
                      </div>
                      <div className="project-history-record__header-actions">
                        <span className="project-history-record__save-indicator">创建前不会保存</span>
                      </div>
                    </div>
                  <div className="project-history-record__tag-row">
                    <EntityTagEditor
                      projectId={activeProject.id}
                      availableTags={availableTags}
                      tags={availableTags.filter((tag) => recordDraftTagIds.includes(tag.id))}
                      onChange={(tagIds) => setRecordDraftTagIds(tagIds)}
                      onCreated={() => void refreshProject()}
                    />
                  </div>
                    <RichEditor
                      html={recordDraftValue.html}
                      aiSettings={aiSettings}
                      defaultCodeLanguage={recordDraftCodeLanguage}
                      onDefaultCodeLanguageChange={setRecordDraftCodeLanguage}
                      variant="bare"
                      autoFocus
                      assetHandlers={projectQuickNoteAssetHandlers}
                      placeholder="写记录，正文里的 #标签 会自动同步。"
                      tagMentions={{
                        projectId: activeProject.id,
                        availableTags,
                        onCreateTag: async (label) => {
                          const tag = await projectMindApi.fileTagOptionUpsert({
                            projectId: activeProject.id,
                            label,
                            colorKey: colorKeyForTagLabel(label),
                          });
                          syncProjectTagCache(tag);
                          return tag;
                        },
                      }}
                      internalReferences={{
                        context: { scope: "project", projectId: activeProject.id },
                        onOpenReference: openInternalReference,
                      }}
                      contactMentions={contactMentionOptions}
                      controllerRef={recordDraftEditorRef}
                      onOpenAiSettings={() => openSettings("ai-rewrite")}
                    />
                    <div className="project-history-record__composer-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={closeRecordDraft}
                      >
                        取消
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        leadingIcon={<Save size={14} />}
                        onClick={() => void createRecord()}
                      >
                        保存记录
                      </Button>
                    </div>
                  </div>
                </article>
              ) : null}

              {records.length > 0 ? (
                <div className="grid gap-2.5">
                  {records.map((note) => (
                    <div key={note.id}>
                      <RecordListItem
                        record={note}
                        scope={{
                          kind: "project",
                          projectId: note.projectId,
                          activityId: note.activityId ?? null,
                          assetHandlers: buildProjectNoteImageAssetHandlers(
                            note.projectId,
                            note.activityId ?? null,
                          ),
                        }}
                        focused={focusedRecordId === note.id}
                        availableTags={availableTags}
                        busy={savingRecordId === note.id}
                        onSave={saveRecord}
                        onOpenContextMenu={openRecordContextMenu}
                        onOpenFocusPage={(current) =>
                          navigate(recordPath(current.projectId, current.id))
                        }
                        onCreatedTag={() => {
                          void refreshProject();
                        }}
                        onOpenInternalReference={openInternalReference}
                        contactMentionOptions={contactMentionOptions}
                        active={visible && currentView === "record"}
                        aiSettings={aiSettings}
                        scrollParentSelector="[data-testid='project-overview-focus-scroll']"
                        onOpenAiSettings={() => openSettings("ai-rewrite")}
                      />
                    </div>
                  ))}
                </div>
              ) : allRecords.length === 0 ? (
                <EmptyState text="还没有记录。" compact />
              ) : (
                <EmptyState text="没有匹配的记录。" compact />
              )}
              {contextMenuRecord && recordContextMenu ? (
                <ActionContextMenu
                  x={recordContextMenu.x}
                  y={recordContextMenu.y}
                  ariaLabel="记录操作"
                  actions={[
                    {
                      label: "删除",
                      icon: Trash2,
                      tone: "danger",
                      onSelect: () => {
                        setRecordContextMenu(null);
                        void deleteRecord(contextMenuRecord);
                      },
                    },
                  ]}
                  onClose={() => setRecordContextMenu(null)}
                />
              ) : null}
          </section>
        </div>
      </div>

      <TodoRail
        projectId={activeProject.id}
        title="Todo List"
        scopeLabel={activeProject.name}
        unfinishedTodos={projectPage.unfinishedTodos}
        finishedTodos={projectPage.finishedTodos}
        createPlaceholder="写下一条需要推进的 Todo，可用 #标签"
        onCreateTodo={(payload) => void createTodo(payload)}
        onToggleStatus={(todoId, status) =>
          todoStatusMutation.mutateAsync({ todoId, status })
        }
        onUpdatePriority={(todoId, priority) =>
          todoPriorityMutation.mutateAsync({ todoId, priority })
        }
        onUpdateContent={updateTodoContent}
        onUpdateTags={(todoId, tagIds) =>
          todoTagMutation.mutateAsync({ todoId, tagIds })
        }
        onAddProgress={(todoId, payload) =>
          todoProgressMutation.mutateAsync({ todoId, ...payload })
        }
        onUpdateProgress={(progressId, payload) =>
          todoProgressUpdateMutation.mutateAsync({ progressId, ...payload })
        }
        onDeleteProgress={(progressId) =>
          todoProgressDeleteMutation.mutateAsync({ progressId })
        }
        onDeleteTodo={(todoId) => todoDeleteMutation.mutateAsync({ todoId })}
        onError={(message) =>
          pushToast({ tone: "error", title: "进展保存失败", detail: message })
        }
        onOpenInternalReference={openInternalReference}
        onOpenContactMention={openContactMention}
      />
      {quickNoteMoveSelection ? (
        <MoveSelectionToRecordCard
          records={allRecords}
          onClose={() => setQuickNoteMoveSelection(null)}
          onSelectRecord={moveQuickNoteSelectionToProjectRecord}
          onCreateRecord={createProjectRecordFromQuickNoteSelection}
        />
      ) : null}
    </div>
  );
}

function buildProjectQuickNoteDraft(project: {
  quickNote: string;
  quickNoteMarkdown?: string;
  quickNoteHtml?: string;
}): RichEditorValue {
  const markdown = project.quickNoteMarkdown?.trim() ? project.quickNoteMarkdown : project.quickNote;

  return {
    html: getRenderableRichTextHtml({ html: project.quickNoteHtml, markdown }),
    text: project.quickNote,
    markdown,
  };
}

function parseProjectPageView(value: string | null): ProjectPageView | null {
  if (value === "quick-note" || value === "record") {
    return value;
  }

  return null;
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, Save, Settings2, Trash2 } from "lucide-react";

import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  RichTextViewer,
  type RichEditorAssetHandlers,
  type RichEditorAutoFocusPoint,
  type RichEditorController,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import {
  buildProjectNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "../rich-editor/noteImageAssets";
import type { FileTagRecord, NoteRecord, ProjectPageData, TodoPriority } from "../../lib/types";
import { fileTagColorValue } from "../../lib/constants";
import {
  formatDateTime,
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
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
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
    queryKey: ["project-page", projectId],
    queryFn: () => projectMindApi.projectPageGet({ projectId: projectId as number }),
    enabled: projectId !== null,
  });
  const tagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings", projectId],
    queryFn: () => projectMindApi.fileTagSettingsGet({ projectId: projectId as number }),
    enabled: projectId !== null,
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
  const [recordDraftOpen, setRecordDraftOpen] = useState(composeRecord);
  const [recordDraftTitle, setRecordDraftTitle] = useState("");
  const [recordDraftValue, setRecordDraftValue] = useState<RichEditorValue>(EMPTY_VALUE);
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
      queryClient.invalidateQueries({ queryKey: ["project-page", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["projects", "all"] }),
      queryClient.invalidateQueries({ queryKey: ["file-tag-settings", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]);
  }

  function upsertRecordInProjectCache(record: NoteRecord) {
    queryClient.setQueryData<ProjectPageData | undefined>(
      ["project-page", record.projectId],
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
      ["project-page", projectId],
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
      ["file-tag-settings", projectId],
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
      tagIds,
    });
    upsertRecordInProjectCache(savedRecord);
    closeRecordDraft();
    setRecordDraftTitle("");
    setRecordDraftValue(EMPTY_VALUE);
    setRecordDraftTagIds([]);
  }

  async function saveRecord(
    note: NoteRecord,
    value: RichEditorValue,
    title: string,
    tagIds: number[],
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
        tagIds: nextTagIds,
      });
      upsertRecordInProjectCache(savedRecord);
    } finally {
      setSavingRecordId(null);
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
              variant="page"
              showToolbar={false}
              enableTables={false}
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
              autosave={{
                delay: 120000,
                onBlur: true,
                onWindowBlur: true,
                onVisibilityChange: true,
              }}
              controllerRef={quickNoteEditorRef}
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
                      <RecordRow
                        note={note}
                        focused={focusedRecordId === note.id}
                        availableTags={availableTags}
                        busy={savingRecordId === note.id}
                        onSave={saveRecord}
                        onOpenContextMenu={openRecordContextMenu}
                        onCreatedTag={() => void refreshProject()}
                        onOpenInternalReference={openInternalReference}
                        contactMentionOptions={contactMentionOptions}
                        pageVisible={visible && currentView === "record"}
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
    </div>
  );
}

function RecordRow({
  note,
  focused,
  availableTags,
  busy,
  onSave,
  onOpenContextMenu,
  onCreatedTag,
  onOpenInternalReference,
  contactMentionOptions,
  pageVisible,
}: {
  note: NoteRecord;
  focused: boolean;
  availableTags: FileTagRecord[];
  busy: boolean;
  onSave: (
    note: NoteRecord,
    value: RichEditorValue,
    title: string,
    tagIds: number[],
  ) => Promise<void>;
  onOpenContextMenu: (event: ReactMouseEvent, noteId: number) => void;
  onCreatedTag: () => void;
  onOpenInternalReference: ReturnType<typeof useInternalReferenceNavigation>;
  contactMentionOptions: ReturnType<typeof useContactMentionOptions>;
  pageVisible: boolean;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [autoFocusPoint, setAutoFocusPoint] = useState<RichEditorAutoFocusPoint | null>(null);
  const [title, setTitle] = useState(note.title ?? "");
  const [value, setValue] = useState<RichEditorValue>(() => buildNoteDraft(note));
  const [tagIds, setTagIds] = useState<number[]>((note.tags ?? []).map((tag) => tag.id));
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const exitScrollTopRef = useRef<number | null>(null);
  const pendingAnchorTopRef = useRef<number | null>(null);
  const saveSignatureRef = useRef(
    buildRecordSaveSignature(
      buildNoteDraft(note),
      note.title ?? "",
      (note.tags ?? []).map((tag) => tag.id),
    ),
  );

  const renderableHtml = getRenderableRichTextHtml({
    html: note.contentHtml,
    markdown: note.contentMarkdown,
  });
  const noteTags = note.tags ?? [];
  const noteTagIds = noteTags.map((tag) => tag.id);
  const noteSnapshotKey = `${note.id}:${note.updatedAt}:${note.title ?? ""}:${noteTagIds.join(",")}`;
  const titleDisplay = note.title?.trim() || "未命名记录";
  const assetHandlers = useMemo<RichEditorAssetHandlers>(
    () => buildProjectNoteImageAssetHandlers(note.projectId, note.activityId ?? null),
    [note.activityId, note.projectId],
  );

  function syncProjectTagCache(tag: FileTagRecord) {
    queryClient.setQueryData<{ tags: FileTagRecord[] } | undefined>(
      ["file-tag-settings", note.projectId],
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

  useEffect(() => {
    if (!editing) {
      setTitle(note.title ?? "");
      setValue(buildNoteDraft(note));
      setTagIds(noteTagIds);
      setPersistState("idle");
      setAutoFocusPoint(null);
      saveSignatureRef.current = buildRecordSaveSignature(
        buildNoteDraft(note),
        note.title ?? "",
        noteTagIds,
      );
    }
  }, [editing, note, noteSnapshotKey]);

  useEffect(() => {
    if (!editing || !pageVisible) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      const switchingToAnotherRecord =
        target instanceof Element &&
        Boolean(target.closest(".project-history-record__surface"));
      const nextValue = editorControllerRef.current?.getValue() ?? value;
      void persistRecord(nextValue, title, tagIds)
        .catch(() => {
          // Persist errors are surfaced by the save state.
        })
        .finally(() => {
          exitEditing({ preserveScroll: !switchingToAnotherRecord });
        });
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [editing, pageVisible, tagIds, title, value]);

  useEffect(() => {
    if (editing) {
      if (pendingAnchorTopRef.current === null || !scrollParentRef.current || !containerRef.current) {
        return;
      }

      const desiredTop = pendingAnchorTopRef.current;
      pendingAnchorTopRef.current = null;
      const parent = scrollParentRef.current;
      const applyAnchor = () => {
        if (!containerRef.current) {
          return;
        }

        const parentRect = parent.getBoundingClientRect();
        const nextTop = containerRef.current.getBoundingClientRect().top - parentRect.top;
        parent.scrollTop += nextTop - desiredTop;
      };

      applyAnchor();
      const frame = window.requestAnimationFrame(applyAnchor);
      return () => window.cancelAnimationFrame(frame);
    }

    if (exitScrollTopRef.current === null || !scrollParentRef.current) {
      return;
    }

    scrollParentRef.current.scrollTop = exitScrollTopRef.current;
    exitScrollTopRef.current = null;
  }, [editing]);

  async function persistRecord(
    nextValue: RichEditorValue,
    nextTitle: string,
    nextTagIds: number[],
  ) {
    const nextSignature = buildRecordSaveSignature(nextValue, nextTitle, nextTagIds);
    if (nextSignature === saveSignatureRef.current) return;
    await onSave(note, nextValue, nextTitle, nextTagIds);
    saveSignatureRef.current = nextSignature;
  }

  async function handleTitleBlur() {
    await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
  }

  async function handleTagChange(nextTagIds: number[]) {
    setTagIds(nextTagIds);
    await persistRecord(editorControllerRef.current?.getValue() ?? value, title, nextTagIds);
  }

  async function saveAndExitEditing() {
    await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
    exitEditing();
  }

  function handleEditingKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void saveAndExitEditing();
  }

  function enterEditing(point?: RichEditorAutoFocusPoint) {
    scrollParentRef.current =
      containerRef.current?.closest("[data-testid='project-overview-focus-scroll']") ?? null;
    if (scrollParentRef.current && containerRef.current) {
      const parentRect = scrollParentRef.current.getBoundingClientRect();
      pendingAnchorTopRef.current =
        containerRef.current.getBoundingClientRect().top - parentRect.top;
    } else {
      pendingAnchorTopRef.current = null;
    }
    setAutoFocusPoint(point ?? null);
    setEditing(true);
  }

  function exitEditing(options?: { preserveScroll?: boolean }) {
    if (options?.preserveScroll !== false && scrollParentRef.current) {
      exitScrollTopRef.current = scrollParentRef.current.scrollTop;
    }
    setEditing(false);
  }

  async function openFocusPage() {
    if (editing) {
      await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
    }

    navigate(recordPath(note.projectId, note.id));
  }

  return (
    <article
      id={`record-${note.id}`}
      ref={containerRef}
      onContextMenu={(event) => {
        if (editing && shouldLetRichEditorHandleContextMenu(event.target)) {
          return;
        }

        onOpenContextMenu(event, note.id);
      }}
      className={cn(
        "project-history-record",
        focused && "scroll-mt-6",
        editing && "project-history-record--editing",
      )}
    >
      {editing ? (
        <div className="project-history-record__editor" onKeyDownCapture={handleEditingKeyDown}>
          <div className="project-history-record__header">
            <div className="project-history-record__header-main">
              <TextField
                value={title}
                placeholder="记录标题"
                className="project-history-record__title-input"
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => void handleTitleBlur()}
              />
            </div>
            <div className="project-history-record__header-actions">
              <span
                className={cn(
                  "project-history-record__save-indicator",
                  persistState === "saving" && "project-history-record__save-indicator--saving",
                  persistState === "saved" && "project-history-record__save-indicator--saved",
                  persistState === "error" && "project-history-record__save-indicator--error",
                )}
              >
                {busy || persistState === "saving"
                  ? "保存中..."
                  : persistState === "saved"
                    ? "已保存"
                    : persistState === "error"
                      ? "保存失败"
                      : "自动保存"}
              </span>
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label="打开专注页"
                onClick={() => void openFocusPage()}
              >
                <ExternalLink size={15} />
              </IconButton>
            </div>
          </div>
          <div className="project-history-record__tag-row">
            <EntityTagEditor
              projectId={note.projectId}
              availableTags={availableTags}
              tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
              busy={busy}
              onChange={(nextTagIds) => void handleTagChange(nextTagIds)}
              onCreated={onCreatedTag}
            />
          </div>
          <div className="project-history-record__content">
            <RichEditor
              html={value.html}
              variant="bare"
              autoFocus={autoFocusPoint ?? true}
              placeholder="写记录，正文里的 #标签 会自动同步。"
              assetHandlers={assetHandlers}
              tagMentions={{
                projectId: note.projectId,
                availableTags,
                onCreateTag: async (label) => {
                  const tag = await projectMindApi.fileTagOptionUpsert({
                    projectId: note.projectId,
                    label,
                    colorKey: colorKeyForTagLabel(label),
                  });
                  syncProjectTagCache(tag);
                  return tag;
                },
              }}
              internalReferences={{
                context: { scope: "project", projectId: note.projectId },
                onOpenReference: onOpenInternalReference,
              }}
              contactMentions={contactMentionOptions}
              autosave={{
                delay: 120000,
                onBlur: true,
                onWindowBlur: true,
                onVisibilityChange: true,
              }}
              controllerRef={editorControllerRef}
              onPersistStateChange={setPersistState}
              onSave={(nextValue) => persistRecord(nextValue, title, tagIds)}
            />
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          className="project-history-record__surface"
          onMouseDown={(event) => {
            if (event.button !== 0) {
              return;
            }

            const contentSurface = event.currentTarget.querySelector(
              ".project-history-record__content .rich-editor__surface",
            ) as HTMLElement | null;

            if (!contentSurface) {
              enterEditing();
              return;
            }

            const contentRect = contentSurface.getBoundingClientRect();
            enterEditing({
              x: Math.max(0, event.clientX - contentRect.left),
              y: Math.max(0, event.clientY - contentRect.top),
              mode: "content-relative",
            });
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }

            event.preventDefault();
            enterEditing();
          }}
        >
          <div className="project-history-record__header">
            <div className="project-history-record__header-main">
              <p className="project-history-record__title">{titleDisplay}</p>
            </div>
            <div className="project-history-record__header-actions">
              <div className="project-history-record__meta">
                <span>更新于 {formatDateTime(note.updatedAt)}</span>
              </div>
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label="打开专注页"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void openFocusPage();
                }}
              >
                <ExternalLink size={15} />
              </IconButton>
            </div>
          </div>
          <div
            className={cn(
              "project-history-record__tag-row",
              noteTags.length === 0 && "project-history-record__tag-row--empty",
            )}
            aria-label={noteTags.length > 0 ? "记录标签" : undefined}
          >
            {noteTags.length > 0 ? (
              <div className="project-history-record__tag-list">
                {noteTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="project-history-record__tag"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${fileTagColorValue(tag.colorKey)} 12%, transparent)`,
                      color: fileTagColorValue(tag.colorKey),
                    }}
                  >
                    <span
                      className="project-history-record__tag-dot"
                      style={{ backgroundColor: fileTagColorValue(tag.colorKey) }}
                      aria-hidden="true"
                    />
                    {tag.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="project-history-record__content">
            <RichTextViewer
              html={renderableHtml}
              active={pageVisible}
              eagerManagedImages
            />
          </div>
        </div>
      )}
    </article>
  );
}

function shouldLetRichEditorHandleContextMenu(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        ".rich-editor__surface, .rich-editor__toolbar, .rich-editor__ai-menu, .rich-editor__table-toolbar, .context-menu__panel",
      ),
    )
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

function buildNoteDraft(note: NoteRecord): RichEditorValue {
  return {
    html: getRenderableRichTextHtml({
      html: note.contentHtml,
      markdown: note.contentMarkdown,
    }),
    text: note.contentMarkdown,
    markdown: note.contentMarkdown,
  };
}

function buildRecordSaveSignature(
  value: RichEditorValue,
  title: string,
  tagIds: number[],
) {
  const normalized = normalizeRichEditorValue(value);
  const normalizedTagIds = [...tagIds].sort((left, right) => left - right);
  return JSON.stringify({
    title: title.trim(),
    markdown: normalized.markdown,
    html: normalized.html,
    tagIds: normalizedTagIds,
  });
}

function parseProjectPageView(value: string | null): ProjectPageView | null {
  if (value === "quick-note" || value === "record") {
    return value;
  }

  return null;
}

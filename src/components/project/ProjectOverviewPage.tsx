import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, LoaderCircle, Plus, Save, Search, X } from "lucide-react";

import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import type { FileTagRecord, NoteRecord, TodoPriority } from "../../lib/types";
import { parseRouteId, projectPath, recordPath } from "../../lib/formatters";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import {
  extractHashTagLabels,
  findTagByLabel,
  mergeUniqueTagIds,
  colorKeyForTagLabel,
} from "../../lib/tags";
import { defaultNoteTemplateKey, noteTemplateLabel } from "../../lib/note-templates";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useDocumentImportFlow } from "../../hooks/useDocumentImportFlow";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { projectMindApi } from "../../services/projectMindApi";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button, EmptyState, IconButton, SurfaceCard, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { DocumentImportTagDialog } from "../document/DocumentImportTagDialog";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { TodoRail } from "../todo";

const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

export function ProjectOverviewPage() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectId = parseRouteId(params.projectId);
  const focusId = searchParams.get("focus");
  const focusedRecordId = parseFocusRecordId(focusId);
  const explicitView = parseProjectPageView(searchParams.get("view"));
  const currentView =
    explicitView ?? (focusedRecordId !== null ? "history" : "overview");
  const { pushToast } = useFeedbackStore();
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
  const overviewQuery = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => projectMindApi.projectGetOverview({ projectId: projectId as number }),
    enabled: projectId !== null,
  });
  const tagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings", projectId],
    queryFn: projectMindApi.fileTagSettingsGet,
    enabled: projectId !== null,
  });
  const recordTypeSettingsQuery = useQuery({
    queryKey: ["record-type-settings"],
    queryFn: projectMindApi.recordTypeSettingsGet,
  });
  const { summaryMutation } = useProjectMutations(visibleProjects, (path) => navigate(path));
  const allTodos = [
    ...(overviewQuery.data?.unfinishedTodos ?? []),
    ...(overviewQuery.data?.finishedTodos ?? []),
  ];
  const {
    todoMutation,
    todoContentMutation,
    todoStatusMutation,
    todoPriorityMutation,
    todoProgressMutation,
    todoProgressUpdateMutation,
    todoProgressDeleteMutation,
    todoDeleteMutation,
  } = useTodoMutations(allTodos);

  const [nameDraft, setNameDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState<RichEditorValue>(EMPTY_VALUE);
  const [summaryPersistState, setSummaryPersistState] =
    useState<RichEditorPersistState>("idle");
  const [recordDraftOpen, setRecordDraftOpen] = useState(false);
  const [recordDraftTitle, setRecordDraftTitle] = useState("");
  const [recordDraftValue, setRecordDraftValue] = useState<RichEditorValue>(EMPTY_VALUE);
  const [recordDraftTagIds, setRecordDraftTagIds] = useState<number[]>([]);
  const [savingRecordId, setSavingRecordId] = useState<number | null>(null);
  const [pageDragActive, setPageDragActive] = useState(false);
  const [recordSearchQuery, setRecordSearchQuery] = useState("");
  const [recordFilterTagId, setRecordFilterTagId] = useState<number | null>(null);

  const overview = overviewQuery.data;
  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const allRecords = useMemo(() => overview?.records ?? [], [overview?.records]);
  const records = useMemo(() => {
    const normalizedQuery = recordSearchQuery.trim().toLowerCase();

    return allRecords.filter((record) => {
      const matchesQuery =
        !normalizedQuery ||
        (record.title ?? "").toLowerCase().includes(normalizedQuery) ||
        record.contentMarkdown.toLowerCase().includes(normalizedQuery) ||
        (record.tags ?? []).some((tag) => tag.label.toLowerCase().includes(normalizedQuery));
      const matchesTag =
        recordFilterTagId === null ||
        (record.tags ?? []).some((tag) => tag.id === recordFilterTagId);

      return matchesQuery && matchesTag;
    });
  }, [allRecords, recordFilterTagId, recordSearchQuery]);
  const recordTagOptions = useMemo(() => {
    const tagMap = new Map<number, { id: number; label: string; colorKey: string }>();

    for (const record of allRecords) {
      for (const tag of record.tags ?? []) {
        if (!tagMap.has(tag.id)) {
          tagMap.set(tag.id, {
            id: tag.id,
            label: tag.label,
            colorKey: tag.colorKey,
          });
        }
      }
    }

    return Array.from(tagMap.values()).sort((a, b) =>
      a.label.localeCompare(b.label, "zh-Hans-CN"),
    );
  }, [allRecords]);

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
    if (!activeProject) return;

    setNameDraft(activeProject.name);
    setSummaryDraft(buildProjectSummaryDraft(activeProject));
    setSummaryPersistState("idle");
  }, [activeProject]);

  async function refreshProject() {
    if (!projectId) return;

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["projects", "all"] }),
      queryClient.invalidateQueries({ queryKey: ["file-tag-settings", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["file-tag-settings"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]);
  }

  async function ensureTagIdsFromText(markdown: string, explicitTagIds: number[]) {
    if (!projectId) return explicitTagIds;

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

    return mergeUniqueTagIds(explicitTagIds, hashTagIds);
  }

  async function saveProjectName() {
    if (!activeProject) return;

    const nextName = nameDraft.trim();
    if (!nextName || nextName === activeProject.name) return;

    await summaryMutation.mutateAsync({
      projectId: activeProject.id,
      name: nextName,
      summary: activeProject.summary,
      summaryMarkdown: activeProject.summaryMarkdown,
      summaryHtml: activeProject.summaryHtml,
      status: activeProject.status,
    });
  }

  async function saveProjectSummary(value: RichEditorValue) {
    if (!activeProject) return;

    const normalized = normalizeRichEditorValue(value);
    await summaryMutation.mutateAsync({
      projectId: activeProject.id,
      summary: normalized.text,
      summaryMarkdown: normalized.markdown,
      summaryHtml: normalized.html,
      status: activeProject.status,
    });
  }

  async function createRecord() {
    if (!projectId || !recordDraftValue.markdown.trim()) return;

    const tagIds = await ensureTagIdsFromText(recordDraftValue.markdown, recordDraftTagIds);
    await projectMindApi.noteUpsert({
      projectId,
      noteType: defaultNoteTemplateKey(recordTypeSettingsQuery.data),
      title: recordDraftTitle.trim() || undefined,
      markdown: recordDraftValue.markdown,
      html: recordDraftValue.html,
      tagIds,
    });
    setRecordDraftOpen(false);
    setRecordDraftTitle("");
    setRecordDraftValue(EMPTY_VALUE);
    setRecordDraftTagIds([]);
    await refreshProject();
  }

  async function saveRecord(
    note: NoteRecord,
    value: RichEditorValue,
    title: string,
    tagIds: number[],
  ) {
    setSavingRecordId(note.id);

    try {
      const normalized = normalizeRichEditorValue(value);
      const nextTagIds = await ensureTagIdsFromText(normalized.markdown, tagIds);
      await projectMindApi.noteUpsert({
        projectId: note.projectId,
        noteId: note.id,
        noteType: note.noteType,
        title: title.trim() || undefined,
        markdown: normalized.markdown,
        html: normalized.html,
        tagIds: nextTagIds,
      });
      await refreshProject();
    } finally {
      setSavingRecordId(null);
    }
  }

  async function deleteRecord(note: NoteRecord) {
    await projectMindApi.noteDelete({ noteId: note.id });
    await refreshProject();
  }

  async function createTodo(payload: { content: string; priority: TodoPriority }) {
    if (!projectId) return;

    const tagIds = await ensureTagIdsFromText(payload.content, []);
    await todoMutation.mutateAsync({ projectId, ...payload, tagIds });
  }

  async function updateTodoContent(todoId: number, content: string) {
    const tagIds = await ensureTagIdsFromText(content, []);
    await todoContentMutation.mutateAsync({ todoId, content, tagIds });
  }

  function setProjectPageView(nextView: ProjectPageView) {
    const nextSearchParams = new URLSearchParams(searchParams);

    if (nextView === "overview") {
      if (focusedRecordId !== null) {
        nextSearchParams.set("view", "overview");
      } else {
        nextSearchParams.delete("view");
      }
    } else {
      nextSearchParams.set("view", "history");
    }

    setSearchParams(nextSearchParams);
  }

  if (!activeProject || !overview) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载项目...
      </div>
    );
  }

  const pageStatusLabel =
    currentView === "overview"
      ? formatPersistStateLabel(summaryPersistState)
      : recordSearchQuery.trim() || recordFilterTagId !== null
        ? `筛选后 ${records.length} / ${allRecords.length}`
        : `共 ${allRecords.length} 条记录`;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="project-overview-focus flex-1" data-testid="project-overview-focus-page">
        <header className="project-overview-focus__chrome">
          <div className="project-overview-focus__chrome-inner">
            <div className="project-overview-focus__meta">
              <p className="project-overview-focus__eyebrow">Project</p>
              <input
                aria-label="项目名称"
                className="project-overview-focus__title"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
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
              <div
                className="project-overview-focus__view-switch"
                data-testid="project-overview-view-switch"
              >
                <button
                  type="button"
                  className={cn(
                    "project-overview-focus__view-switch-button",
                    currentView === "overview" &&
                      "project-overview-focus__view-switch-button--active",
                  )}
                  data-testid="project-overview-view-overview"
                  aria-pressed={currentView === "overview"}
                  onClick={() => setProjectPageView("overview")}
                >
                  Overview
                </button>
                <button
                  type="button"
                  className={cn(
                    "project-overview-focus__view-switch-button",
                    currentView === "history" &&
                      "project-overview-focus__view-switch-button--active",
                  )}
                  data-testid="project-overview-view-history"
                  aria-pressed={currentView === "history"}
                  onClick={() => setProjectPageView("history")}
                >
                  历史记录
                </button>
              </div>

              {currentView === "history" ? (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  leadingIcon={<Plus size={14} />}
                  onClick={() => setRecordDraftOpen(true)}
                >
                  新增记录
                </Button>
              ) : null}

              <span
                className={cn(
                  "project-overview-focus__status",
                  summaryPersistState === "saved" && currentView === "overview" && "text-green-600",
                  summaryPersistState === "error" && currentView === "overview" && "text-red-600",
                )}
              >
                {pageStatusLabel}
              </span>
            </div>
          </div>
        </header>

        <div
          className={cn(
            "project-overview-focus__scroll",
            pageDragActive && "bg-[color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg))]",
          )}
          data-testid="project-overview-focus-scroll"
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
              paths={pendingImportPaths}
              tags={fileTags}
              selectedTagIds={pendingImportTagIds}
              onToggleTag={togglePendingImportTag}
              onClose={closeImportTagDialog}
              onConfirm={() => void confirmImportTagDialog()}
              onManageTags={manageImportTags}
            />
          ) : null}

          {currentView === "overview" ? (
            <section
              className="project-overview-focus__page"
              data-testid="project-overview-body-overview"
            >
              <RichEditor
                html={summaryDraft.html}
                variant="page"
                enableTables={false}
                placeholder="记录项目目标、上下文、关键约束和阶段进展。"
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
                onChange={setSummaryDraft}
                onSave={saveProjectSummary}
                onPersistStateChange={setSummaryPersistState}
              />
            </section>
          ) : (
            <section
              className="project-overview-focus__page project-overview-focus__page--history"
              data-testid="project-overview-body-history"
            >
              <div className="project-overview-focus__history-header">
                <div>
                  <p className="project-overview-focus__eyebrow">History</p>
                  <h2 className="project-overview-focus__history-title">历史记录</h2>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  leadingIcon={<FilePlus2 size={14} />}
                  onClick={() => setRecordDraftOpen(true)}
                >
                  新增记录
                </Button>
              </div>

              <div className="project-overview-focus__history-tools">
                <div className="relative flex-1 min-w-[16rem]">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft"
                    size={16}
                  />
                  <TextField
                    aria-label="搜索记录"
                    value={recordSearchQuery}
                    placeholder="搜索记录标题、正文或标签..."
                    className="pl-10 pr-10"
                    onChange={(event) => setRecordSearchQuery(event.target.value)}
                  />
                  {recordSearchQuery ? (
                    <IconButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="清除搜索"
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                      onClick={() => setRecordSearchQuery("")}
                    >
                      <X size={14} />
                    </IconButton>
                  ) : null}
                </div>

                {recordTagOptions.length > 0 ? (
                  <div className="project-overview-focus__tag-filters">
                    <span className="text-caption text-text-soft">标签</span>
                    <button
                      type="button"
                      className={cn(
                        "project-overview-focus__tag-filter",
                        recordFilterTagId === null &&
                          "project-overview-focus__tag-filter--active",
                      )}
                      onClick={() => setRecordFilterTagId(null)}
                    >
                      全部
                    </button>
                    {recordTagOptions.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className={cn(
                          "project-overview-focus__tag-filter",
                          recordFilterTagId === tag.id &&
                            "project-overview-focus__tag-filter--active",
                        )}
                        onClick={() =>
                          setRecordFilterTagId(
                            recordFilterTagId === tag.id ? null : tag.id,
                          )
                        }
                      >
                        {tag.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {recordDraftOpen ? (
                <SurfaceCard className="grid gap-3 p-4">
                  <TextField
                    aria-label="记录标题"
                    value={recordDraftTitle}
                    placeholder="记录标题"
                    onChange={(event) => setRecordDraftTitle(event.target.value)}
                  />
                  <EntityTagEditor
                    projectId={activeProject.id}
                    availableTags={availableTags}
                    tags={availableTags.filter((tag) => recordDraftTagIds.includes(tag.id))}
                    onChange={(tagIds) => setRecordDraftTagIds(tagIds)}
                    onCreated={() => void refreshProject()}
                  />
                  <RichEditor
                    html={recordDraftValue.html}
                    variant="bare"
                    autoFocus
                    placeholder="写记录，正文里的 #标签 会自动同步。"
                    internalReferences={{
                      context: { scope: "project", projectId: activeProject.id },
                      onOpenReference: openInternalReference,
                    }}
                    contactMentions={contactMentionOptions}
                    onChange={setRecordDraftValue}
                  />
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRecordDraftOpen(false)}
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
                </SurfaceCard>
              ) : null}

              {records.length > 0 ? (
                <div className="grid gap-2.5">
                  {records.map((note) => (
                    <SurfaceCard key={note.id} as="article" className="px-4 py-2.5">
                      <RecordRow
                        note={note}
                        focused={focusId === `record-${note.id}`}
                        availableTags={availableTags}
                        recordTypeLabel={noteTemplateLabel(
                          note.noteType,
                          recordTypeSettingsQuery.data,
                        )}
                        busy={savingRecordId === note.id}
                        onSave={saveRecord}
                        onDelete={deleteRecord}
                        onCreatedTag={() => void refreshProject()}
                        onOpenInternalReference={openInternalReference}
                      />
                    </SurfaceCard>
                  ))}
                </div>
              ) : allRecords.length === 0 ? (
                <EmptyState text="还没有记录。" compact />
              ) : (
                <EmptyState text="没有匹配的记录。" compact />
              )}
            </section>
          )}
        </div>
      </div>

      <TodoRail
        projectId={activeProject.id}
        title="项目待办"
        scopeLabel={activeProject.name}
        unfinishedTodos={overview.unfinishedTodos}
        finishedTodos={overview.finishedTodos}
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
          projectMindApi.todoUpdateTags({ todoId, tagIds }).then(() => refreshProject())
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
        onOpenTodoSource={(todo) =>
          navigate(projectPath(activeProject.id, `todo-${todo.id}`))
        }
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
  recordTypeLabel,
  busy,
  onSave,
  onDelete,
  onCreatedTag,
  onOpenInternalReference,
}: {
  note: NoteRecord;
  focused: boolean;
  availableTags: FileTagRecord[];
  recordTypeLabel: string;
  busy: boolean;
  onSave: (
    note: NoteRecord,
    value: RichEditorValue,
    title: string,
    tagIds: number[],
  ) => Promise<void>;
  onDelete: (note: NoteRecord) => Promise<void>;
  onCreatedTag: () => void;
  onOpenInternalReference: ReturnType<typeof useInternalReferenceNavigation>;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(focused);
  const [title, setTitle] = useState(note.title ?? "");
  const [value, setValue] = useState<RichEditorValue>(() => buildNoteDraft(note));
  const contactMentionOptions = useContactMentionOptions();

  const renderableHtml = getRenderableRichTextHtml({
    html: note.contentHtml,
    markdown: note.contentMarkdown,
  });

  return (
    <article id={`record-${note.id}`} className={cn("py-2", focused && "scroll-mt-6")}>
      <div
        className={cn(
          "inline-object-item",
          focused &&
            "rounded-[var(--radius-8)] bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)]",
        )}
      >
        <div className="inline-object-rail" aria-hidden="true">
          <div className="inline-object-guide inline-object-guide--project" />
        </div>
        <div className="inline-object-panel inline-object-panel--interactive">
          {editing ? (
            <div className="relative grid gap-3">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="absolute right-0 top-0"
                onClick={async () => {
                  await onSave(note, value, title, (note.tags ?? []).map((tag) => tag.id));
                  navigate(recordPath(note.projectId, note.id));
                }}
              >
                打开专注页
              </Button>
              <div className="pr-28">
                <TextField
                  value={title}
                  placeholder="记录标题"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <EntityTagEditor
                projectId={note.projectId}
                availableTags={availableTags}
                tags={note.tags ?? []}
                busy={busy}
                onChange={(tagIds) => onSave(note, value, title, tagIds)}
                onCreated={onCreatedTag}
              />
              <div>
                <p className="mb-1 text-caption text-text-soft">{recordTypeLabel}</p>
                <RichEditor
                  html={value.html}
                  variant="bare"
                  autoFocus
                  placeholder="写记录，正文里的 #标签 会自动同步。"
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
                  onChange={setValue}
                  onSave={async (val) => {
                    await onSave(note, val, title, (note.tags ?? []).map((tag) => tag.id));
                    setEditing(false);
                  }}
                />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={async () => {
                    await onSave(note, value, title, (note.tags ?? []).map((tag) => tag.id));
                    setEditing(false);
                  }}
                >
                  保存
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="grid w-full gap-2 text-left"
              onClick={() => setEditing(true)}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-text">
                    {note.title || "未命名记录"}
                  </p>
                  <p className="mt-1 text-caption text-text-soft">{recordTypeLabel}</p>
                </div>
                <IconButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="删除记录"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onDelete(note);
                  }}
                >
                  ×
                </IconButton>
              </div>
              {(note.tags ?? []).length > 0 ? (
                <EntityTagEditor
                  projectId={note.projectId}
                  availableTags={availableTags}
                  tags={note.tags ?? []}
                  compact
                  onChange={(tagIds) => onSave(note, value, title, tagIds)}
                  onCreated={onCreatedTag}
                />
              ) : null}
              <RichEditor
                html={renderableHtml}
                variant="bare"
                readOnly
                internalReferences={{
                  context: { scope: "project", projectId: note.projectId },
                  onOpenReference: onOpenInternalReference,
                }}
                contactMentions={contactMentionOptions}
              />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function buildProjectSummaryDraft(project: {
  summary: string;
  summaryMarkdown?: string;
  summaryHtml?: string;
}): RichEditorValue {
  const markdown = project.summaryMarkdown?.trim() ? project.summaryMarkdown : project.summary;

  return {
    html: getRenderableRichTextHtml({ html: project.summaryHtml, markdown }),
    text: project.summary,
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

function formatPersistStateLabel(state: RichEditorPersistState) {
  switch (state) {
    case "saving":
      return "保存中...";
    case "saved":
      return "已保存";
    case "error":
      return "保存失败";
    case "dirty":
      return "未保存";
    default:
      return "项目概览";
  }
}

type ProjectPageView = "overview" | "history";

function parseProjectPageView(value: string | null): ProjectPageView | null {
  if (value === "overview" || value === "history") {
    return value;
  }

  return null;
}

function parseFocusRecordId(focus: string | null) {
  const match = focus?.match(/^record-(\d+)$/u);
  return match ? Number(match[1]) : null;
}

import { useQuery,useQueryClient } from "@tanstack/react-query";
import { Save,Trash2 } from "lucide-react";
import {
useEffect,
useMemo,
useRef,
useState,
type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate,useParams,useSearchParams } from "react-router-dom";
import { HomeRailDivider } from "../home/HomeRailDivider";

import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useDelayedPending } from "../../hooks/useDelayedPending";
import { useDocumentImportFlow } from "../../hooks/useDocumentImportFlow";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useKeyedPresence } from "../../hooks/useKeyedPresence";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import {
parseFocusRecordId,
parseFocusTodoId,
parseRouteId,
preserveRecordFilters,
recordFocusId,
recordPath,
} from "../../lib/formatters";
import { withPageWidthClass } from "../../lib/pageWidth";
import {
filterProjectRecords,
parseRecordFilterTagId,
} from "../../lib/project-records";
import { queryKeys } from "../../lib/queryKeys";
import { completeQuickNoteRecordMetadata } from "../../lib/quick-note-auto-metadata";
import { deriveQuickNoteMetadata } from "../../lib/quick-note-metadata";
import type { QuickNoteTransferTarget } from "../../lib/quick-note-transfer";
import { appendMarkdownSection,appendRichTextSection } from "../../lib/record-move";
import { RESIDENT_PROJECT_QUERY_OPTIONS } from "../../lib/resident-pages";
import { extractTagMentionIds } from "../../lib/tagMentions";
import {
colorKeyForTagLabel,
findTagByLabel,
mergeUniqueTagIds
} from "../../lib/tags";
import type {
NoteRecord,
ProjectPageData,
ProjectTagRecord,
} from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { TodoModuleRail } from "../../todo";
import { ActionContextMenu,Button,EmptyState,PageLoadingSkeleton,TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { DocumentImportTagDialog } from "../document/DocumentImportTagDialog";
import "../home/home.css";
import { HomeCover } from "../home/HomeCover";
import { HomeQuickNote } from "../home/HomeQuickNote";
import { HomeRecordFilters } from "../home/HomeRecordFilters";
import { ProjectSidebar } from "../layout/ProjectSidebar";
import { RecordListItem } from "../record/RecordListItem";
import {
getRenderableRichTextHtml,
normalizeRichEditorValue,
RichEditor,
type RichEditorAssetHandlers,
type RichEditorController,
type RichEditorValue
} from "../rich-editor";
import {
buildProjectNoteImageAssetHandlers,
externalizeEmbeddedImageDataUrls,
} from "../rich-editor/noteImageAssets";
import { EntityTagEditor } from "../tags/EntityTagEditor";

const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

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
  const wasProjectPageCachedAtMount = useRef(
    queryClient.getQueryData(queryKeys.projectPage(projectId)) !== undefined,
  );
  const focusId = searchParams.get("focus");
  const focusedRecordId = parseFocusRecordId(focusId);
  const focusedTodoId = parseFocusTodoId(focusId);
  const shouldAutoFocusProjectName = searchParams.get("renameProject") === "1";
  const composeRecord = searchParams.get("compose") === "record";
  const { pushToast } = useFeedbackStore();
  const {
    openSettings,
    pageWidthMode,
    projectSidebarCollapsed,
    todoRailCollapsed,
    todoRailWidthPx,
    projectTodoViewMode,
    setProjectTodoViewMode,
  } = useUiStore();
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

    return buildProjectNoteImageAssetHandlers(projectId);
  }, [projectId]);
  const projectPageQuery = useQuery({
    queryKey: queryKeys.projectPage(projectId),
    queryFn: () => projectMindApi.projectPageGet({ projectId: projectId as number }),
    enabled: visible && projectId !== null,
    ...RESIDENT_PROJECT_QUERY_OPTIONS,
  });
  const tagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.project(projectId),
    queryFn: () => projectMindApi.projectTagSettingsGet({ projectId: projectId as number }),
    enabled: visible && projectId !== null,
    ...RESIDENT_PROJECT_QUERY_OPTIONS,
  });
  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
    enabled: visible,
  });
  const { projectUpdateMutation } = useProjectMutations((path) => navigate(path), projectId);

  const [nameDraft, setNameDraft] = useState("");
  const [publishingQuickNote, setPublishingQuickNote] = useState(false);
  const nameSaveRef = useRef<Promise<unknown> | null>(null);
  const [quickNoteDraft, setQuickNoteDraft] = useState<RichEditorValue>(EMPTY_VALUE);
  const [quickNoteCodeLanguage, setQuickNoteCodeLanguage] = useState<string | null>(null);
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
  const recordPresence = useKeyedPresence(
    records,
    (record) => String(record.id),
    `${recordSearchQuery}|${recordFilterTagId ?? ""}`,
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
    focusedRecordId !== null
      ? recordFocusId(focusedRecordId)
      : null,
    [visibleRecordFocusKey],
    { enabled: visible, refocusOnEnable: false },
  );

  const {
    projectTags,
    pendingImportPaths,
    pendingImportTagIds,
    requestImportPaths,
    togglePendingImportTag,
    closeImportTagDialog,
    confirmImportTagDialog,
    manageImportTags,
  } = useDocumentImportFlow({
    projectId,
    enabled: visible,
    resident: true,
  });

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
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.project(projectId) }),
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
    const hashLabels = deriveQuickNoteMetadata(markdown).tagLabels;
    const hashTagIds: number[] = [];

    for (const label of hashLabels) {
      const existing = findTagByLabel(availableTags, label);
      const tag =
        existing ??
        (await projectMindApi.projectTagUpsert({
          projectId,
          label,
          colorKey: colorKeyForTagLabel(label),
        }));
      hashTagIds.push(tag.id);
    }

    return mergeUniqueTagIds(explicitTagIds, mentionedTagIds, hashTagIds);
  }

  function syncProjectTagCache(tag: ProjectTagRecord) {
    queryClient.setQueryData<{ tags: ProjectTagRecord[] } | undefined>(
      queryKeys.projectTags.project(projectId),
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

    const save = async () => {
      const value = normalizeRichEditorValue(await externalizeEmbeddedImageDataUrls(quickNoteDraft, projectQuickNoteAssetHandlers));
      return projectUpdateMutation.mutateAsync({
        projectId: activeProject.id,
        name: nextName,
        quickNote: value.text,
        quickNoteMarkdown: value.markdown,
        quickNoteHtml: value.html,
        quickNoteCodeLanguage,
        status: activeProject.status,
      });
    };
    const pending = save();
    nameSaveRef.current = pending;
    try { await pending; }
    finally { if (nameSaveRef.current === pending) nameSaveRef.current = null; }
  }

  async function saveProjectQuickNote(value: RichEditorValue) {
    if (!activeProject) return value;
    await nameSaveRef.current;

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
    return normalized;
  }

  async function commitProjectQuickNote(value: RichEditorValue, target: QuickNoteTransferTarget) {
    if (!projectId) throw new Error("当前 Project 不可用");
    const metadata = deriveQuickNoteMetadata(value.markdown);
    const targetRecord = target.kind === "append"
      ? allRecords.find((record) => record.id === target.recordId)
      : undefined;
    if (target.kind === "append" && (!targetRecord || targetRecord.projectId !== projectId)) {
      throw new Error("只能追加到当前 Project 的 Record");
    }
    const tagIds = mergeUniqueTagIds(
      targetRecord?.tags?.map((tag) => tag.id) ?? [],
      extractTagMentionIds(value.markdown),
    );
    for (const label of metadata.tagLabels) {
      const existing = findTagByLabel(availableTags, label);
      const tag = existing ?? await projectMindApi.projectTagUpsert({
        projectId,
        label,
        colorKey: colorKeyForTagLabel(label),
      });
      if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
    }
    const record = await projectMindApi.projectQuickNoteCommit({
      projectId,
      expectedMarkdown: value.markdown,
      recordId: targetRecord?.id,
      expectedRecordMarkdown: targetRecord?.contentMarkdown,
      expectedRecordUpdatedAt: targetRecord?.updatedAt,
      title: targetRecord ? targetRecord.title ?? undefined : metadata.title ?? (value.text.trim().split(/[。！？.!?\n]/u)[0]?.slice(0, 36) || "未命名记录"),
      markdown: targetRecord
        ? appendMarkdownSection(targetRecord.contentMarkdown, value.markdown)
        : value.markdown,
      html: targetRecord
        ? appendRichTextSection(
            { html: targetRecord.contentHtml, markdown: targetRecord.contentMarkdown },
            value.html,
          )
        : value.html,
      defaultCodeLanguage: targetRecord ? targetRecord.defaultCodeLanguage : quickNoteCodeLanguage,
      tagIds,
    });
    upsertRecordInProjectCache(record);
    if (!targetRecord) void completeQuickNoteRecordMetadata({ record, projectId, availableTags, aiSettings })
      .then(() => refreshProject()).catch(() => pushToast({ tone: "info", title: "记录已保存", detail: "AI 标题和标签未填写，可在记录中重试 AI 填写。" }));
    return record;
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
      const recordAssetHandlers = buildProjectNoteImageAssetHandlers(note.projectId);
      const externalizedValue = await externalizeEmbeddedImageDataUrls(value, recordAssetHandlers);
      const normalized = normalizeRichEditorValue(externalizedValue);
      const nextTagIds = await ensureTagIdsFromText(normalized.markdown, tagIds);
      const savedRecord = await projectMindApi.projectRecordUpsert({
        projectId: note.projectId,
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

  async function deleteRecord(note: NoteRecord) {
    await projectMindApi.projectRecordDelete({ noteId: note.id });
    removeRecordFromProjectCache(note.id);
  }

  function openRecordContextMenu(event: ReactMouseEvent, noteId: number) {
    event.preventDefault();
    event.stopPropagation();
    setRecordContextMenu({ x: event.clientX, y: event.clientY, noteId });
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

  const projectPagePending = !activeProject || !projectPage;
  const showProjectPageSkeleton = useDelayedPending(projectPagePending);

  if (projectPagePending) {
    if (!showProjectPageSkeleton) return null;
    return <PageLoadingSkeleton variant="overview" label="正在加载项目页" />;
  }

  return (
    <div
      className="home-page page-cold-entry relative flex h-full min-h-0 overflow-hidden"
      data-cold-entry={wasProjectPageCachedAtMount.current ? undefined : "true"}
    >
      <div className="project-overview-focus flex-1" data-testid="project-overview-focus-page">
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
              tags={projectTags}
              selectedTagIds={pendingImportTagIds}
              onChangeSelectedTagIds={togglePendingImportTag}
              onClose={closeImportTagDialog}
              onConfirm={() => void confirmImportTagDialog()}
              onManageTags={manageImportTags}
            />
          ) : null}

          <HomeCover identityKey={`project:${activeProject.rootPath}`} defaultIcon="Compass" canEditIcon
            title={<input ref={projectNameInputRef} aria-label="项目名称" disabled={publishingQuickNote} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onBlur={() => void saveProjectName()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />}
            subtitle={<button type="button" onClick={() => void desktopApi.openFolder(activeProject.rootPath)}>我的工作区 / {activeProject.name}</button>} />
          <HomeQuickNote
            key={activeProject.rootPath}
            identity={`project-quick-note:${activeProject.rootPath}`}
            initialValue={quickNoteDraft}
            records={allRecords}
            onBusyChange={setPublishingQuickNote}
            persist={saveProjectQuickNote}
            commit={commitProjectQuickNote}
            onClear={() => {
              setQuickNoteDraft(EMPTY_VALUE);
              setQuickNoteCodeLanguage(null);
            }}
            onCommitted={() => refreshProject()}
            renderEditor={({ controllerRef, onSave, onPersistStateChange, readOnly }) => (
              <RichEditor
                key={`project-quick-note-${activeProject.id}`}
                contentIdentity={`project-quick-note:${activeProject.id}`}
                html={quickNoteDraft.html}
                readOnly={!visible || readOnly}
                aiSettings={aiSettings}
                defaultCodeLanguage={quickNoteCodeLanguage}
                onDefaultCodeLanguageChange={setQuickNoteCodeLanguage}
                variant="toolbar"
                assetHandlers={projectQuickNoteAssetHandlers}
                tagMentions={{
                  projectId: activeProject.id,
                  availableTags,
                  onCreateTag: async (label) => {
                    const tag = await projectMindApi.projectTagUpsert({
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
                controllerRef={controllerRef}
                onOpenAiSettings={() => openSettings("ai-rewrite")}
                onSave={onSave}
                onPersistStateChange={onPersistStateChange}
              />
            )}
          />
          <HomeRecordFilters onClearFilters={() => { const next = new URLSearchParams(searchParams); next.delete("recordTag"); next.delete("recordQuery"); setProjectSearchParams(next); }} title="记录" query={recordSearchQuery} tag={availableTags.find((tag) => tag.id === recordFilterTagId)?.label}
            onQuery={(query) => { const next = new URLSearchParams(searchParams); if (query) next.set("recordQuery", query); else next.delete("recordQuery"); setProjectSearchParams(next, { replace: true }); }}
            onClearTag={() => { const next = new URLSearchParams(searchParams); next.delete("recordTag"); setProjectSearchParams(next); }}
            onCreate={() => setRecordDraftOpen(true)} />
          <section
            className={withPageWidthClass(
              "project-overview-focus__page project-overview-focus__page--history",
              pageWidthMode,
              "history",
            )}
            data-testid="project-overview-body-history"
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
                      contentIdentity={`project-record-draft:${activeProject.id}`}
                      html={recordDraftValue.html}
                      readOnly={!visible}
                      aiSettings={aiSettings}
                      defaultCodeLanguage={recordDraftCodeLanguage}
                      onDefaultCodeLanguageChange={setRecordDraftCodeLanguage}
                      variant="bare"
                      autoFocus={visible}
                      assetHandlers={projectQuickNoteAssetHandlers}
                      placeholder="写记录，正文里的 #标签 会自动同步。"
                      tagMentions={{
                        projectId: activeProject.id,
                        availableTags,
                        onCreateTag: async (label) => {
                          const tag = await projectMindApi.projectTagUpsert({
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

              {recordPresence.items.length > 0 ? (
                <div ref={recordPresence.containerRef} tabIndex={-1} className="grid gap-2.5" data-list-layout-motion>
                  {recordPresence.items.map(({ item: note, key, state }) => (
                    <div
                      key={key}
                      className="record-presence-item"
                      data-state={state}
                      data-layout-motion-id={`record-${key}`}
                      aria-hidden={state === "exiting" || undefined}
                      inert={state === "exiting" ? true : undefined}
                      onTransitionEnd={(event) => {
                        if (state === "exiting" && event.target === event.currentTarget) {
                          recordPresence.finishExit(key);
                        }
                      }}
                    >
                      <RecordListItem
              homepage
                        record={note}
                        scope={{
                          kind: "project",
                          projectId: note.projectId,
                          assetHandlers: buildProjectNoteImageAssetHandlers(note.projectId),
                        }}
                        focused={focusedRecordId === note.id}
                        availableTags={availableTags}
                        busy={savingRecordId === note.id}
                        onSave={saveRecord}
                        onOpenContextMenu={openRecordContextMenu}
                        onOpenFocusPage={(current) =>
                          navigate(
                            preserveRecordFilters(
                              recordPath(current.projectId, current.id),
                              searchParams,
                            ),
                          )
                        }
                        onCreatedTag={() => {
                          void refreshProject();
                        }}
                        onOpenInternalReference={openInternalReference}
                        contactMentionOptions={contactMentionOptions}
                        active={visible}
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

      <div style={{ width: todoRailCollapsed ? undefined : todoRailWidthPx }} className={`home-rail home-rail--project${todoRailCollapsed ? " is-collapsed" : ""}`}>
        <div className="home-rail__todo">
      <TodoModuleRail
        scope={
          projectTodoViewMode === "workspace"
            ? { kind: "workspace" }
            : { kind: "current-project", projectId: activeProject.id }
        }
        focusTodoId={focusedTodoId}
        enabled={visible}
        canCreateTodo={projectTodoViewMode === "workspace" || !activeProject.isArchived}
        availableTags={projectTodoViewMode === "current-project" ? availableTags : []}
        showViewModeSwitch
        onViewModeChange={setProjectTodoViewMode}
        onOpenInternalReference={openInternalReference}
        onOpenContactMention={openContactMention}
      />
        </div>
        {!todoRailCollapsed ? <HomeRailDivider key={activeProject.rootPath} identity={activeProject.rootPath} /> : null}
        {visible && !todoRailCollapsed ? <div className="home-rail__files"><h2>文件</h2><ProjectSidebar filesOnly project={activeProject} documents={(projectPage.projectDocuments ?? []).map((file) => ({ ...file, tags: file.tags ?? [] }))} resident onOpenProject={() => undefined} /></div> : null}
      </div>
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

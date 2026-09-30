import { HomeSaveIndicator } from "../home/HomeSaveIndicator";
import { TodoModuleRail } from "../../todo";
import { HomeWorkspaceRail } from "../home/HomeWorkspaceRail";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { HomeRecordHeader } from "../home/HomeRecordHeader";
import "../home/home.css";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type KeyboardEvent } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { useNavigate,useParams,useSearchParams } from "react-router-dom";

import { parseRouteId,preserveRecordFilters,projectPath } from "../../lib/formatters";
import {
PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
type ProjectRecordFocusSaveRequestDetail,
} from "../../lib/record-focus-save";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useDelayedPending } from "../../hooks/useDelayedPending";
import { useScrollPositionRestoration } from "../../hooks/useUtilityHooks";
import { colorKeyForTagLabel } from "../../lib/tags";
import { projectMindApi } from "../../services/projectMindApi";
import { queryKeys } from "../../lib/queryKeys";
import { RESIDENT_PROJECT_QUERY_OPTIONS } from "../../lib/resident-pages";
import {
createRecordSaveCoordinator,
useRecordSaveCoordinator,
} from "../../lib/record-save-runtime";
import { projectRecordSaveKey } from "../../lib/record-save-coordinator";
import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from "../../lib/richTextStyle";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { PageLoadingSkeleton,TextField } from "../../ui/components";
import {
getRenderableRichTextHtml,
normalizeRichEditorValue,
RichEditor,
type RichEditorAssetHandlers,
type RichEditorController,
type RichEditorPersistState,
type RichEditorValue,
} from "../rich-editor";
import {
buildProjectNoteImageAssetHandlers,
} from "../rich-editor/noteImageAssets";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { RecordExportAction } from "../../features/record-export/RecordExportAction";
import type { RecordExportRequest } from "../../features/record-export/recordExport";
import { createDesktopRecordExporter } from "../../features/record-export/desktopRecordExportPlatform";
import type { ProjectPageData,ProjectTagRecord } from "../../lib/types";
import type { RichTextStyleSettings } from "../../lib/types";
import {
recordFocusDraftFromRecord,
recordFocusDraftFromSnapshot,
} from "../record/recordFocusDraft";
import { RecordAiMetadataAction } from "../record/RecordAiMetadataAction";
import { VoiceRecordPanel } from "../voice/VoiceRecordPanel";
import { useCanonicalRecordEditor } from "../../hooks/useCanonicalRecordEditor";

interface ProjectRecordDraft {
  title: string;
  content: RichEditorValue;
  tagIds: number[];
  codeLanguage: string | null;
  updatedAt: string | null;
}

export function ProjectNoteFocusPage({
  projectIdOverride,
  recordIdOverride,
  visible = true,
}: {
  projectIdOverride?: number;
  recordIdOverride?: number;
  visible?: boolean;
} = {}) {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const workspaceSaveCoordinator = useRecordSaveCoordinator();
  const projectId = projectIdOverride ?? parseRouteId(params.projectId);
  const recordId = recordIdOverride ?? parseRouteId(params.noteId);
  const initialProjectPage = queryClient.getQueryData<ProjectPageData>(
    queryKeys.projectPage(projectId),
  );
  const latestSnapshot =
    projectId === null || recordId === null
      ? null
      : workspaceSaveCoordinator?.getLatestSnapshot(
          projectRecordSaveKey(projectId, recordId),
        ) ?? null;
  const initialSnapshot = latestSnapshot?.scope === "project" ? latestSnapshot : null;
  const initialDraft: ProjectRecordDraft | null = initialSnapshot
    ? recordFocusDraftFromSnapshot(initialSnapshot)
    : (() => {
        const record = initialProjectPage?.records?.find(
          (candidate) => candidate.id === recordId,
        );
        return record ? recordFocusDraftFromRecord(record) : null;
      })();
  const wasProjectPageCachedAtMount = useRef(
    initialProjectPage !== undefined,
  );
  const focusScrollRef = useRef<HTMLDivElement | null>(null);
  const { pushToast } = useFeedbackStore();
  const { openSettings, projectTodoViewMode, setProjectTodoViewMode } = useUiStore();
  const openContactMention = useContactMentionNavigation();
  const navigateInternalReference = useInternalReferenceNavigation();
  const contactMentionOptions = useContactMentionOptions();

  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [content, setContent] = useState<RichEditorValue>(
    initialDraft?.content ?? { html: "", text: "", markdown: "" },
  );
  const [tagIds, setTagIds] = useState<number[]>(initialDraft?.tagIds ?? []);
  const [codeLanguage, setCodeLanguage] = useState<string | null>(
    initialDraft?.codeLanguage ?? null,
  );
  const [loadedNoteId, setLoadedNoteId] = useState<number | null>(
    initialDraft ? recordId : null,
  );
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const lastSavedTitleRef = useRef(initialDraft?.title ?? "");
  const titleValueRef = useRef(initialDraft?.title ?? "");
  const tagIdsValueRef = useRef<number[]>(initialDraft?.tagIds ?? []);
  const codeLanguageValueRef = useRef<string | null>(initialDraft?.codeLanguage ?? null);
  const lastSavedUpdatedAtRef = useRef<string | null>(initialDraft?.updatedAt ?? null);
  const hasSubmittedSaveRef = useRef(false);

  const projectQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: visible && projectId !== null,
  });

  const projectPageQuery = useQuery({
    queryKey: queryKeys.projectPage(projectId),
    queryFn: () => projectMindApi.projectPageGet({ projectId: projectId as number }),
    enabled: visible && projectId !== null && recordId !== null && loadedNoteId === null,
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

  const project =
    projectId === null
      ? null
      : (projectQuery.data ?? []).find((item) => item.id === projectId) ??
        projectPageQuery.data?.project ??
        null;
  const fallbackSaveCoordinator = useMemo(
    () =>
      createRecordSaveCoordinator({
        workspaceKey: project?.rootPath ?? `project:${projectId ?? "unknown"}`,
        queryClient,
      }),
    [project?.rootPath, projectId, queryClient],
  );
  const saveCoordinator = workspaceSaveCoordinator ?? fallbackSaveCoordinator;
  const { scrollRef, hasSavedPosition } = useScrollPositionRestoration(
    `project-record:${project?.rootPath ?? `project-${projectId}`}:${recordId}`,
  );
  const setFocusScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      focusScrollRef.current = element;
      scrollRef(element);
    },
    [scrollRef],
  );

  const note = useMemo(() => {
    if (!projectPageQuery.data || recordId === null) return null;
    return (projectPageQuery.data.records ?? []).find((record) => record.id === recordId) ?? null;
  }, [projectPageQuery.data, recordId]);

  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const aiSettings = aiSettingsQuery.data;
  const draftReady = recordId !== null && loadedNoteId === recordId;
  const canonical = useCanonicalRecordEditor({
    target: projectId !== null && recordId !== null ? { scope: { kind: "project", projectId }, recordId } : null,
    coordinator: saveCoordinator, enabled: draftReady,
  });
  const [hydratedRecordKey, setHydratedRecordKey] = useState<string | null>(null);
  const editingReady = canonical.ready && hydratedRecordKey === canonical.recordKey;
  useLayoutEffect(() => {
    if (!canonical.state || !canonical.recordKey || hydratedRecordKey === canonical.recordKey) return;
    const pending = projectId !== null && recordId !== null
      ? saveCoordinator.getLatestSnapshot(projectRecordSaveKey(projectId, recordId)) : null;
    const draft = pending ? recordFocusDraftFromSnapshot(pending) : recordFocusDraftFromRecord(canonical.state.record);
    setTitle(draft.title); titleValueRef.current = draft.title;
    lastSavedTitleRef.current = canonical.state.metadata.title ?? "";
    setTagIds(draft.tagIds); tagIdsValueRef.current = draft.tagIds;
    setContent(draft.content);
    setCodeLanguage(draft.codeLanguage); codeLanguageValueRef.current = draft.codeLanguage;
    lastSavedUpdatedAtRef.current = canonical.state.record.updatedAt;
    setHydratedRecordKey(canonical.recordKey);
  }, [canonical.state, canonical.recordKey, hydratedRecordKey, projectId, recordId, saveCoordinator]);
  const assetHandlers = useMemo<RichEditorAssetHandlers | undefined>(() => {
    if (!projectId || !draftReady) {
      return undefined;
    }

    return buildProjectNoteImageAssetHandlers(projectId);
  }, [draftReady, projectId]);

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

  // Initialize state from note
  useLayoutEffect(() => {
    if (!note || loadedNoteId === note.id) return;

    setTitle(note.title ?? "");
    titleValueRef.current = note.title ?? "";
    lastSavedTitleRef.current = note.title ?? "";
    setContent({
      html: getRenderableRichTextHtml({ html: note.contentHtml, markdown: note.contentMarkdown }),
      text: note.contentMarkdown,
      markdown: note.contentMarkdown,
    });
    const nextTagIds = (note.tags ?? []).map((tag) => tag.id);
    setTagIds(nextTagIds);
    tagIdsValueRef.current = nextTagIds;
    setCodeLanguage(note.defaultCodeLanguage ?? null);
    codeLanguageValueRef.current = note.defaultCodeLanguage ?? null;
    setPersistState("idle");
    lastSavedUpdatedAtRef.current = note.updatedAt;
    setLoadedNoteId(note.id);
  }, [loadedNoteId, note]);

  const submitCurrentRecord = useCallback(
    (value?: RichEditorValue, origin: "manual" | "editor_ai" = "manual") => {
      if (!editingReady || projectId === null || recordId === null) return false;
      const document = editorControllerRef.current?.getCommittedDocumentJson();
      if (!document) return false;
      const canonicalBody = canonical.capture(document, origin);
      if (!canonicalBody) return false;
      const committed =
        value ??
        editorControllerRef.current?.getCommittedValue() ??
        Object.freeze({ ...content });
      // Keep the controlled prop in lockstep with the exact snapshot sent to
      // the save coordinator so a pending AI session cannot reconcile against
      // the focus page's mount-time HTML.
      setContent(committed);
      saveCoordinator.submit({
        scope: "project",
        workspaceKey: saveCoordinator.workspaceKey ?? project?.rootPath ?? `project:${projectId}`,
        projectId,
        recordId,
        title: titleValueRef.current,
        tagIds: [...tagIdsValueRef.current],
        defaultCodeLanguage: codeLanguageValueRef.current,
        committedContent: committed,
        canonicalBody,
      });
      hasSubmittedSaveRef.current = true;
      lastSavedTitleRef.current = titleValueRef.current;
      setPersistState("saving");
      return true;
    }, [content, editingReady, canonical.capture, recordId, project?.rootPath, projectId, saveCoordinator]);

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      if (!submitCurrentRecord(value)) return false;
      await saveCoordinator.flush();
      return true;
    },
    [saveCoordinator, submitCurrentRecord],
  );

  const leaveEditorRef = useRef<() => void>(() => undefined);
  leaveEditorRef.current = () => {
    if (!editingReady || !submitCurrentRecord()) return;
    void canonical.checkpoint("leave_editor").catch(() => setPersistState("error"));
  };
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current && !visible) leaveEditorRef.current();
    wasVisibleRef.current = visible;
  }, [visible]);
  useEffect(() => () => leaveEditorRef.current(), [projectId, recordId]);

  const saveCurrentRecord = useCallback(async () => {
    if (!submitCurrentRecord()) return false;
    try {
      await saveCoordinator.flush();
      setPersistState("saved");
      return true;
    } catch (error) {
      setPersistState("error");
      pushToast({ tone: "error", title: "保存失败", detail: String(error) });
      return false;
    }
  }, [pushToast, saveCoordinator, submitCurrentRecord]);

  useEffect(() => {
    if (projectId === null || recordId === null) {
      return;
    }
    return saveCoordinator.subscribe(() => {
      if (!hasSubmittedSaveRef.current) {
        return;
      }
      const status = saveCoordinator.getRecordStatus(
        projectRecordSaveKey(projectId, recordId),
      );
      setPersistState(
        status.phase === "error"
          ? "error"
          : status.phase === "saving"
            ? "saving"
            : "saved",
      );
    });
  }, [recordId, projectId, saveCoordinator]);

  useEffect(() => {
    const handleSaveRequest = (event: Event) => {
      const detail = (event as CustomEvent<ProjectRecordFocusSaveRequestDetail>).detail;
      if (!detail || detail.projectId !== projectId || detail.recordId !== recordId) {
        return;
      }

      detail.respond(submitCurrentRecord());
    };

    window.addEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
    return () => {
      window.removeEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
    };
  }, [recordId, projectId, submitCurrentRecord]);

  const saveTitleIfChanged = async () => {
    if (!draftReady || titleValueRef.current === lastSavedTitleRef.current) {
      return;
    }

    await saveCurrentRecord();
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || (event.key !== "Tab" && event.key !== "Enter")) {
      return;
    }

    event.preventDefault();
    void saveTitleIfChanged()
      .then(() => {
        tagInputRef.current?.focus();
      })
      .catch(() => undefined);
  };

  const handleBack = () => {
    if (projectId !== null) {
      navigate(
        preserveRecordFilters(projectPath(projectId, `record-${recordId}`), searchParams),
      );
    }
  };

  const handleTagsChange = async (newTagIds: number[]) => {
    if (!draftReady) return;
    setTagIds(newTagIds);
    tagIdsValueRef.current = newTagIds;
    try {
      submitCurrentRecord();
    } catch (error) {
      pushToast({ tone: "error", title: "标签更新失败", detail: String(error) });
    }
  };

  const openInternalReference = useCallback(
    async (reference: Parameters<typeof navigateInternalReference>[0]) => {
      return navigateInternalReference(reference);
    },
    [navigateInternalReference],
  );

  const runExport = useCallback((request: RecordExportRequest) => {
    const exportRecord = createDesktopRecordExporter(async () => {
      const saved = await saveCurrentRecord();
      if (!saved) throw new Error("导出前保存失败");
      const committed = editorControllerRef.current?.getCommittedValue?.() ?? normalizeRichEditorValue(content);
      const savedRecord = queryClient
        .getQueryData<ProjectPageData>(queryKeys.projectPage(projectId))
        ?.records?.find((record) => record.id === recordId);
      return {
        recordKind: "project" as const,
        title: titleValueRef.current,
        projectName: project?.name,
        tags: availableTags.filter((tag) => tagIdsValueRef.current.includes(tag.id)).map((tag) => tag.label),
        updatedAt: savedRecord?.updatedAt ?? lastSavedUpdatedAtRef.current ?? note?.updatedAt,
        committedHtml: committed.html,
        style: queryClient.getQueryData<RichTextStyleSettings>(queryKeys.richTextStyle) ?? DEFAULT_RICH_TEXT_STYLE_SETTINGS,
      };
    });
    return exportRecord(request);
  }, [availableTags, content, note?.updatedAt, recordId, project?.name, queryClient, saveCurrentRecord]);

  const showRecordSkeleton = useDelayedPending(!draftReady);

  if (projectId === null || recordId === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-text-soft">无效的记录ID</p>
      </div>
    );
  }

  if (!draftReady && (projectQuery.isLoading || projectPageQuery.isLoading)) {
    if (!showRecordSkeleton) return null;
    return <PageLoadingSkeleton variant="record" label="正在加载项目记录" />;
  }

  if (!draftReady && !note) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-text-soft">记录未找到</p>
      </div>
    );
  }

  if (!draftReady) {
    if (!showRecordSkeleton) return null;
    return <PageLoadingSkeleton variant="record" label="正在加载项目记录" />;
  }

  return (
    <div
      className="home-page home-note-page page-cold-entry relative flex h-full min-h-0 overflow-hidden"
      data-focus-page-key={`${projectId}:${recordId}`}
      data-cold-entry={wasProjectPageCachedAtMount.current ? undefined : "true"}
    >
      <div className="project-overview-focus relative h-full min-h-0 min-w-0 flex-1">

      {/* Content */}
      <div
        ref={setFocusScrollRef}
        className="project-overview-focus__scroll"
        data-testid="project-record-focus-scroll"
      >
        <div
          className="home-content home-note-content"
        >
          <div className="grid gap-4">
            {canonical.error ? <div role="alert" className="text-sm text-text-soft">
              <p>这条记录暂时只能阅读：{canonical.error instanceof Error ? canonical.error.message : String(canonical.error)}</p>
              <button type="button" onClick={canonical.retry}>重新加载编辑器</button>
            </div> : !editingReady ? <p role="status" className="text-sm text-text-soft">正在准备记录编辑器…</p> : null}
            <HomeRecordHeader onOpenHome={handleBack} identityKey={`project:${project?.rootPath}`} projectRoot={project?.rootPath} scopeName={project?.name || "项目"} title={title}>
            <div className="flex min-w-0 items-center gap-2">
              <TextField
                ref={titleInputRef}
                value={title}
                placeholder="记录标题"
                disabled={!editingReady || !visible}
                onChange={(event) => {
                  setTitle(event.target.value);
                  titleValueRef.current = event.target.value;
                }}
                onBlur={() => void saveTitleIfChanged().catch(() => undefined)}
                onKeyDown={handleTitleKeyDown}
                className="min-w-0 flex-1 text-lg font-medium"
              />
              <RecordAiMetadataAction
                target={{ scope: "project", projectId, recordId }}
                aiSettings={aiSettings}
                availableTags={availableTags}
                currentTagIds={tagIds}
                getCommittedMarkdown={() =>
                  editorControllerRef.current?.getCommittedValue().markdown ??
                  normalizeRichEditorValue(content).markdown
                }
                beforeApply={async () => {
                  if (!(await saveCurrentRecord())) {
                    throw new Error("应用标题和标签前保存正文失败");
                  }
                }}
                onApplied={(value) => {
                  setTitle(value.title);
                  titleValueRef.current = value.title;
                  lastSavedTitleRef.current = value.title;
                  const nextTagIds = value.tags.map((tag) => tag.id);
                  setTagIds(nextTagIds);
                  tagIdsValueRef.current = nextTagIds;
                  void queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) });
                  void queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.project(projectId) });
                }}
                onOpenAiSettings={() => openSettings("ai-rewrite")}
              />
              <RecordExportAction
              title={titleValueRef.current}
              getCommittedHtml={() => editorControllerRef.current?.getCommittedValue?.().html ?? content.html}
              exportTo={runExport}
            />
              <HomeSaveIndicator state={persistState} />
            </div>
            </HomeRecordHeader>
            <EntityTagEditor inputPlaceholder="新增标签"
              mode={editingReady && visible ? "full" : "display"}
              projectId={projectId}
              availableTags={availableTags}
              tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
              inputRef={tagInputRef}
              onChange={handleTagsChange}
              onCreated={() => tagSettingsQuery.refetch()}
              onCommitNavigation={(reason) => {
                if (reason === "enter") {
                  editorControllerRef.current?.focus("end");
                }
              }}
            />
            {note?.isVoice && projectId !== null && recordId !== null ? (
              <VoiceRecordPanel
                target={{ scope: "project", projectId, recordId }}
                visible={visible}
                onTitleUpdated={(nextTitle) => {
                  setTitle(nextTitle);
                  titleValueRef.current = nextTitle;
                  lastSavedTitleRef.current = nextTitle;
                }}
                onCopyMinutes={async (minutes) => {
                  const next = editorControllerRef.current?.appendMarkdown(minutes);
                  if (!next || !submitCurrentRecord(next)) throw new Error("未能写入正文");
                  setContent(next);
                  await saveCoordinator.flush();
                }}
              />
            ) : null}
            <RichEditor
              key={canonical.recordKey ?? `${projectId}:${recordId}:loading`}
              contentIdentity={`project-record:${projectId}:${recordId}`}
              recordKey={canonical.recordKey}
              html={content.html}
              aiSettings={aiSettings}
              defaultCodeLanguage={codeLanguage}
              onDefaultCodeLanguageChange={(language) => {
                setCodeLanguage(language);
                codeLanguageValueRef.current = language;
              }}
              variant="page"
              showToolbar={false}
              autoFocus={visible && !hasSavedPosition}
              readOnly={!visible || !editingReady}
              placeholder="写记录，正文里的 #标签 会自动同步。"
              assetHandlers={assetHandlers}
              tagMentions={{
                projectId,
                availableTags,
                onCreateTag: async (label) => {
                  const tag = await projectMindApi.projectTagUpsert({
                    projectId,
                    label,
                    colorKey: colorKeyForTagLabel(label),
                  });
                  syncProjectTagCache(tag);
                  return tag;
                },
              }}
              internalReferences={{
                context: { scope: "project", projectId },
                onOpenReference: openInternalReference,
              }}
              contactMentions={contactMentionOptions}
              autosave={{
                delay: 120000,
                onBlur: true,
                onWindowBlur: true,
                onVisibilityChange: true,
              }}
              controllerRef={editorControllerRef}
              onOpenAiSettings={() => openSettings("ai-rewrite")}
              onSave={handleSave}
              onBeforeAiCommit={() => submitCurrentRecord()}
              onAiCommit={(value) => { submitCurrentRecord(value, "editor_ai"); }}
              onPersistStateChange={setPersistState}
            />
          </div>
        </div>
      </div>
      </div>
      <HomeWorkspaceRail>
        <TodoModuleRail
          scope={projectTodoViewMode === "workspace" ? { kind: "workspace" } : { kind: "current-project", projectId }}
          enabled={visible}
          canCreateTodo={projectTodoViewMode === "workspace" || !project?.isArchived}
          availableTags={projectTodoViewMode === "workspace" ? [] : availableTags}
          showViewModeSwitch
          onViewModeChange={setProjectTodoViewMode}
          onOpenInternalReference={openInternalReference}
          onOpenContactMention={openContactMention}
        />
      </HomeWorkspaceRail>
    </div>
  );
}

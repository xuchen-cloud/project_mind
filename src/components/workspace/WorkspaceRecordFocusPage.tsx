import { ArrowLeft, Settings2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import {
  parseRouteId,
  preserveRecordFilters,
  projectPath,
  workspacePath,
} from "../../lib/formatters";
import { generateDefaultProjectName } from "../../lib/projectDefaultName";
import { withPageWidthClass } from "../../lib/pageWidth";
import { colorKeyForTagLabel } from "../../lib/tags";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useDelayedPending } from "../../hooks/useDelayedPending";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useScrollPositionRestoration } from "../../hooks/useUtilityHooks";
import { projectMindApi } from "../../services/projectMindApi";
import { queryKeys } from "../../lib/queryKeys";
import {
  WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT,
  type WorkspaceRecordFocusSaveRequestDetail,
} from "../../lib/record-focus-save";
import { workspaceRecordSaveKey } from "../../lib/record-save-coordinator";
import {
  createRecordSaveCoordinator,
  useRecordSaveCoordinator,
} from "../../lib/record-save-runtime";
import { prefetchProjectPageData } from "../../lib/project-prefetch";
import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from "../../lib/richTextStyle";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { IconButton, PageLoadingSkeleton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorController,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import { buildWorkspaceNoteImageAssetHandlers } from "../rich-editor/noteImageAssets";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { TodoModuleRail } from "../../todo";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";
import { RecordExportAction } from "../../features/record-export/RecordExportAction";
import type { RecordExportRequest } from "../../features/record-export/recordExport";
import { createDesktopRecordExporter } from "../../features/record-export/desktopRecordExportPlatform";
import type {
  ProjectTagRecord,
  RichTextStyleSettings,
  WorkspacePageData,
} from "../../lib/types";
import {
  recordFocusDraftFromRecord,
  recordFocusDraftFromSnapshot,
} from "../record/recordFocusDraft";
import { RecordAiMetadataAction } from "../record/RecordAiMetadataAction";

const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

export function WorkspaceRecordFocusPage({
  recordIdOverride,
  visible = true,
}: {
  recordIdOverride?: number;
  visible?: boolean;
} = {}) {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const workspaceSaveCoordinator = useRecordSaveCoordinator();
  const recordId = recordIdOverride ?? parseRouteId(params.noteId);
  const latestSnapshot = recordId === null
    ? null
    : workspaceSaveCoordinator?.getLatestSnapshot(workspaceRecordSaveKey(recordId)) ?? null;
  const initialSnapshot = latestSnapshot?.scope === "workspace" ? latestSnapshot : null;
  const initialWorkspacePage = queryClient.getQueryData<WorkspacePageData>(
    queryKeys.workspacePage,
  );
  const initialRecord = initialWorkspacePage?.records?.find(
    (candidate) => candidate.id === recordId,
  );
  const initialDraft = initialSnapshot
    ? recordFocusDraftFromSnapshot(initialSnapshot)
    : initialRecord
      ? recordFocusDraftFromRecord(initialRecord)
      : null;
  const wasWorkspacePageCachedAtMount = useRef(
    initialWorkspacePage !== undefined,
  );
  const { scrollRef, hasSavedPosition } = useScrollPositionRestoration(
    `workspace-record:${recordId}`,
  );
  const { pushToast } = useFeedbackStore();
  const {
    openSettings,
    pageWidthMode,
    projectRecentPaths,
    openProjectIds,
    closeProjectTab,
    projectSidebarCollapsed,
    todoRailCollapsed,
  } = useUiStore();
  const openInternalReference = useInternalReferenceNavigation();
  const openContactMention = useContactMentionNavigation();
  const contactMentionOptions = useContactMentionOptions();
  const workspaceAssetHandlers = useMemo(() => buildWorkspaceNoteImageAssetHandlers(), []);

  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [content, setContent] = useState<RichEditorValue>(initialDraft?.content ?? EMPTY_VALUE);
  const [tagIds, setTagIds] = useState<number[]>(initialDraft?.tagIds ?? []);
  const [codeLanguage, setCodeLanguage] = useState<string | null>(
    initialDraft?.codeLanguage ?? null,
  );
  const [loadedNoteId, setLoadedNoteId] = useState<number | null>(
    initialDraft ? recordId : null,
  );
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isSaving, setIsSaving] = useState(false);
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const lastSavedUpdatedAtRef = useRef<string | null>(initialDraft?.updatedAt ?? null);
  const titleValueRef = useRef(initialDraft?.title ?? "");
  const tagIdsValueRef = useRef<number[]>(initialDraft?.tagIds ?? []);
  const codeLanguageValueRef = useRef<string | null>(initialDraft?.codeLanguage ?? null);

  const workspacePageQuery = useQuery({
    queryKey: queryKeys.workspacePage,
    queryFn: projectMindApi.workspacePageGet,
    enabled: visible && recordId !== null && loadedNoteId === null,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: visible && recordId !== null,
  });
  const workspaceStatusQuery = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
    enabled: visible && recordId !== null,
  });

  const tagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.workspace,
    queryFn: () => projectMindApi.projectTagSettingsGet({}),
    enabled: visible,
  });
  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
    enabled: visible,
  });

  const note = useMemo(() => {
    if (!workspacePageQuery.data || recordId === null) return null;
    return (workspacePageQuery.data.records ?? []).find((record) => record.id === recordId) ?? null;
  }, [recordId, workspacePageQuery.data]);

  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const aiSettings = aiSettingsQuery.data;
  const draftReady = recordId !== null && loadedNoteId === recordId;
  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );
  const archivedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => project.isArchived),
    [projectsQuery.data],
  );
  const recordSearchQuery = searchParams.get("recordQuery") ?? "";
  const recordFilterTagId = useMemo(() => {
    const value = searchParams.get("recordTag");
    if (!value) return null;

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, [searchParams]);
  const currentWorkspace = workspaceStatusQuery.data?.currentWorkspace ?? null;
  const fallbackSaveCoordinator = useMemo(
    () => createRecordSaveCoordinator({
      workspaceKey: currentWorkspace?.rootPath ?? "workspace:unknown",
      queryClient,
    }),
    [currentWorkspace?.rootPath, queryClient],
  );
  const saveCoordinator = workspaceSaveCoordinator ?? fallbackSaveCoordinator;
  const prefetchProject = useCallback(
    (projectId: number) => {
      void prefetchProjectPageData(queryClient, projectId).catch(() => {
        // The destination query reports prefetch failures.
      });
    },
    [queryClient],
  );
  const { createProjectMutation, archiveMutation, deleteProjectMutation } = useProjectMutations(
    (path, options) => navigate(path, options),
  );

  function syncWorkspaceTagCache(tag: ProjectTagRecord) {
    queryClient.setQueryData<{ tags: ProjectTagRecord[] } | undefined>(
      queryKeys.projectTags.workspace,
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

  useLayoutEffect(() => {
    if (!note || loadedNoteId === note.id) return;

    const draft = recordFocusDraftFromRecord(note);
    setTitle(draft.title);
    titleValueRef.current = draft.title;
    setContent(draft.content);
    setTagIds(draft.tagIds);
    tagIdsValueRef.current = draft.tagIds;
    setCodeLanguage(draft.codeLanguage);
    codeLanguageValueRef.current = draft.codeLanguage;
    setPersistState("idle");
    lastSavedUpdatedAtRef.current = note.updatedAt;
    setLoadedNoteId(note.id);
  }, [loadedNoteId, note]);

  const submitCurrentRecord = useCallback(
    (value?: RichEditorValue) => {
      if (!draftReady || recordId === null) return false;
      saveCoordinator.submit({
        scope: "workspace",
        workspaceKey:
          saveCoordinator.workspaceKey ?? currentWorkspace?.rootPath ?? "workspace:unknown",
        recordId,
        title: titleValueRef.current,
        tagIds: tagIdsValueRef.current,
        defaultCodeLanguage: codeLanguageValueRef.current,
        committedContent:
          value ?? editorControllerRef.current?.getCommittedValue() ?? content,
      });
      setPersistState("saving");
      return true;
    }, [content, currentWorkspace?.rootPath, draftReady, recordId, saveCoordinator],
  );

  useEffect(() => {
    if (recordId === null) return;
    return saveCoordinator.subscribe(() => {
      const status = saveCoordinator.getRecordStatus(workspaceRecordSaveKey(recordId));
      setPersistState(
        status.phase === "saving" ? "saving" : status.phase === "error" ? "error" : "saved",
      );
    });
  }, [recordId, saveCoordinator]);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceRecordFocusSaveRequestDetail>).detail;
      if (!detail || detail.recordId !== recordId) return;
      detail.respond(submitCurrentRecord());
    };
    window.addEventListener(WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleRequest);
  }, [recordId, submitCurrentRecord]);

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      if (!submitCurrentRecord(value)) return false;
      setIsSaving(true);
      try {
        await saveCoordinator.flush();
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
        return true;
      } catch (error) {
        pushToast({ tone: "error", title: "保存失败", detail: String(error) });
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [pushToast, queryClient, saveCoordinator, submitCurrentRecord],
  );

  const saveCurrentRecord = useCallback(async () => {
    if (!draftReady) return false;
    const editorController = editorControllerRef.current;
    if (editorController) {
      const request = editorController.save({ force: true });
      if (request) return (await request) !== false;
    }
    return handleSave(content);
  }, [content, draftReady, handleSave]);

  const runExport = useCallback((request: RecordExportRequest) => {
    const exportRecord = createDesktopRecordExporter(async () => {
      const saved = await saveCurrentRecord();
      if (!saved) throw new Error("导出前保存失败");
      const committed = editorControllerRef.current?.getCommittedValue?.() ?? normalizeRichEditorValue(content);
      return {
        recordKind: "workspace" as const,
        title,
        projectName: null,
        tags: availableTags.filter((tag) => tagIds.includes(tag.id)).map((tag) => tag.label),
        updatedAt: lastSavedUpdatedAtRef.current ?? note?.updatedAt,
        committedHtml: committed.html,
        style: queryClient.getQueryData<RichTextStyleSettings>(queryKeys.richTextStyle) ?? DEFAULT_RICH_TEXT_STYLE_SETTINGS,
      };
    });
    return exportRecord(request);
  }, [availableTags, content, note?.updatedAt, queryClient, saveCurrentRecord, tagIds, title]);

  const handleBack = () => {
    if (recordId === null) return;
    navigate(
      preserveRecordFilters(`${workspacePath()}?view=record&focus=record-${recordId}`, searchParams),
    );
  };

  async function createWorkspaceRecordInFocus() {
    const record = await projectMindApi.workspaceRecordUpsert({
      markdown: "",
      html: "<p></p>",
      defaultCodeLanguage: null,
      tagIds: [],
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
    navigate(preserveRecordFilters(`/workspace/records/${record.id}`, searchParams));
  }

  function setWorkspaceRecordQuery(value: string) {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (value.trim()) {
      nextSearchParams.set("recordQuery", value);
    } else {
      nextSearchParams.delete("recordQuery");
    }
    setSearchParams(nextSearchParams, { replace: true });
  }

  function setWorkspaceRecordTagId(tagId: number | null) {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (tagId === null) {
      nextSearchParams.delete("recordTag");
    } else {
      nextSearchParams.set("recordTag", String(tagId));
    }
    setSearchParams(nextSearchParams);
  }

  async function openProject(projectId: number) {
    const focused = await desktopApi.focusProjectWindow(projectId);
    if (focused) {
      return;
    }

    navigate(projectPath(projectId));
  }

  async function openProjectInNewWindow(projectId: number) {
    const project = visibleProjects.find((item) => item.id === projectId);
    if (!project) {
      return;
    }

    const route = projectRecentPaths[projectId] ?? projectPath(projectId);
    try {
      await desktopApi.openProjectWindow({
        projectId,
        projectName: project.name,
        route,
      });

      if (openProjectIds.includes(projectId)) {
        closeProjectTab(projectId);
        navigate(workspacePath());
      }
    } catch (error) {
      pushToast({
        tone: "error",
        title: "打开项目新窗口失败",
        detail: String(error),
      });
    }
  }

  async function createProjectQuickly() {
    if (createProjectMutation.isPending) {
      return;
    }

    await createProjectMutation.mutateAsync({
      name: generateDefaultProjectName((projectsQuery.data ?? []).map((project) => project.name)),
      quickNote: "",
      status: "active",
    });
  }

  async function renameProject(projectId: number, name: string) {
    const project = visibleProjects.find((item) => item.id === projectId);
    if (!project) {
      return;
    }

    await projectMindApi.projectUpdate({
      projectId,
      name,
      quickNote: project.quickNote,
      quickNoteMarkdown: project.quickNoteMarkdown,
      quickNoteHtml: project.quickNoteHtml,
      quickNoteCodeLanguage: project.quickNoteCodeLanguage ?? null,
      status: project.status,
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
  }

  function deleteProject(projectId: number) {
    deleteProjectMutation.mutate({ projectId });
  }

  const handleTagsChange = async (newTagIds: number[]) => {
    if (!draftReady) return;
    setTagIds(newTagIds);
    tagIdsValueRef.current = newTagIds;
    try {
      const nextValue = editorControllerRef.current?.getValue() ?? content;
      await handleSave(nextValue);
    } catch (error) {
      pushToast({ tone: "error", title: "标签更新失败", detail: String(error) });
    }
  };

  const showRecordSkeleton = useDelayedPending(!draftReady);

  if (recordId === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-text-soft">无效的记录ID</p>
      </div>
    );
  }

  if (
    !draftReady &&
    (workspacePageQuery.isLoading || projectsQuery.isLoading || workspaceStatusQuery.isLoading)
  ) {
    if (!showRecordSkeleton) return null;
    return <PageLoadingSkeleton variant="record" label="正在加载工作区记录" />;
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
    return <PageLoadingSkeleton variant="record" label="正在加载工作区记录" />;
  }

  return (
    <div
      className="page-cold-entry relative flex h-full min-h-0 overflow-hidden"
      data-focus-page-key={`workspace:${recordId}`}
      data-cold-entry={wasWorkspacePageCachedAtMount.current ? undefined : "true"}
    >
      {currentWorkspace ? (
        <WorkspaceOverviewSidebar
          workspaceRootPath={currentWorkspace.rootPath}
          projects={visibleProjects}
          archivedProjects={archivedProjects}
          records={(workspacePageQuery.data?.records ?? []).map((record) => ({
            id: record.id,
            title: record.title,
            contentMarkdown: record.contentMarkdown,
            tags: record.tags ?? [],
            updatedAt: record.updatedAt,
          }))}
          activeRecordId={recordId}
          recordQuery={recordSearchQuery}
          onRecordQueryChange={setWorkspaceRecordQuery}
          activeRecordTagId={recordFilterTagId}
          onActiveRecordTagIdChange={setWorkspaceRecordTagId}
          onOpenOverview={() => navigate(preserveRecordFilters(workspacePath(), searchParams))}
          onOpenProject={(projectId) => {
            void openProject(projectId);
          }}
          onPrefetchProject={prefetchProject}
          onOpenProjectInNewWindow={(projectId) => {
            void openProjectInNewWindow(projectId);
          }}
          onCreateProject={() => {
            void createProjectQuickly();
          }}
          createProjectPending={createProjectMutation.isPending}
          onOpenArchivedProject={(projectId) => {
            void openProject(projectId);
          }}
          onRestoreArchivedProject={(projectId) => {
            archiveMutation.mutate({ projectId, isArchived: false });
          }}
          onRenameProject={(project, name) => renameProject(project.id, name)}
          onArchiveProject={(projectId) => archiveMutation.mutate({ projectId, isArchived: true })}
          onDeleteProject={(project) => deleteProject(project.id)}
          onOpenRecord={(nextRecordId) => {
            if (nextRecordId !== recordId) {
              navigate(preserveRecordFilters(`/workspace/records/${nextRecordId}`, searchParams));
            }
          }}
          onFocusRecord={(nextRecordId) => {
            if (nextRecordId !== recordId) {
              navigate(preserveRecordFilters(`/workspace/records/${nextRecordId}`, searchParams));
            }
          }}
          onCreateRecord={() => void createWorkspaceRecordInFocus()}
        />
      ) : null}

      <div className="project-overview-focus flex-1">
        <header className="project-overview-focus__chrome">
          <div
            className={cn(
              "project-overview-focus__chrome-inner",
              projectSidebarCollapsed && "project-overview-focus__chrome-inner--dock-left",
              todoRailCollapsed && "project-overview-focus__chrome-inner--dock-right",
            )}
          >
            <div className="project-overview-focus__meta">
              <div className="flex items-center gap-3">
                <IconButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="返回 Workspace"
                  onClick={handleBack}
                >
                  <ArrowLeft size={16} />
                </IconButton>
                <div>
                  <p className="text-caption text-text-soft">Workspace</p>
                  <p className="text-ui font-medium text-text">记录</p>
                </div>
              </div>
            </div>

            <div className="project-overview-focus__header-actions">
              <IconButton
                type="button"
                size="sm"
                variant="secondary"
                aria-label="打开页面设置"
                onClick={() => openSettings("page-width")}
              >
                <Settings2 size={14} />
              </IconButton>
              <RecordExportAction
                title={title}
                getCommittedHtml={() => editorControllerRef.current?.getCommittedValue?.().html ?? content.html}
                exportTo={runExport}
              />
              <span
                className={cn(
                  "text-caption",
                  persistState === "saving"
                    ? "text-text-soft"
                    : persistState === "saved"
                      ? "text-green-600"
                      : persistState === "error"
                        ? "text-red-600"
                        : "text-text-soft",
                )}
              >
                {persistState === "saving"
                  ? "保存中..."
                  : persistState === "saved"
                    ? "已保存"
                    : persistState === "error"
                      ? "保存失败"
                      : ""}
              </span>
            </div>
          </div>
        </header>

        <div ref={scrollRef} className="project-overview-focus__scroll">
          <div className={withPageWidthClass("mx-auto w-full px-6 py-6", pageWidthMode, "focus")}>
            <div className="grid gap-4">
              <div className="flex min-w-0 items-center gap-2">
                <TextField
                  value={title}
                  placeholder="记录标题"
                  onChange={(event) => {
                    setTitle(event.target.value);
                    titleValueRef.current = event.target.value;
                  }}
                  onBlur={() => {
                    if (draftReady && title !== (note?.title ?? initialDraft?.title ?? "")) {
                      void handleSave(editorControllerRef.current?.getValue() ?? content);
                    }
                  }}
                  className="min-w-0 flex-1 text-lg font-medium"
                />
                <RecordAiMetadataAction
                  target={{ scope: "workspace", recordId }}
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
                    const nextTagIds = value.tags.map((tag) => tag.id);
                    setTagIds(nextTagIds);
                    tagIdsValueRef.current = nextTagIds;
                    void queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
                    void queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
                  }}
                  onOpenAiSettings={() => openSettings("ai-rewrite")}
                />
              </div>
              <EntityTagEditor
                projectId={null}
                availableTags={availableTags}
                tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
                onChange={handleTagsChange}
                onCreated={syncWorkspaceTagCache}
              />
              <RichEditor
                key={recordId}
                contentIdentity={`workspace-record:${recordId}`}
                html={content.html}
                aiSettings={aiSettings}
                defaultCodeLanguage={codeLanguage}
                onDefaultCodeLanguageChange={(value) => {
                  setCodeLanguage(value);
                  codeLanguageValueRef.current = value;
                }}
                variant="page"
                showToolbar={false}
                autoFocus={visible && !hasSavedPosition}
                readOnly={!visible}
                assetHandlers={workspaceAssetHandlers}
                placeholder="写记录，正文里的 #标签 会自动同步。"
                tagMentions={{
                  projectId: null,
                  availableTags,
                  onCreateTag: async (label) => {
                    const tag = await projectMindApi.projectTagUpsert({
                      label,
                      colorKey: colorKeyForTagLabel(label),
                    });
                    syncWorkspaceTagCache(tag);
                    return tag;
                  },
                }}
                internalReferences={{
                  context: { scope: "workspace" },
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
                onPersistStateChange={setPersistState}
              />
            </div>
          </div>
        </div>
      </div>

      {workspacePageQuery.data ? (
        <TodoModuleRail
          scope={{ kind: "workspace" }}
          enabled={visible}
          availableTags={availableTags}
          onOpenInternalReference={openInternalReference}
          onOpenContactMention={openContactMention}
        />
      ) : null}
    </div>
  );
}

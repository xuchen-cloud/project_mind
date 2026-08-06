import { ArrowLeft, LoaderCircle, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { extractTagMentionIds } from "../../lib/tagMentions";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useScrollPositionRestoration } from "../../hooks/useUtilityHooks";
import { projectMindApi } from "../../services/projectMindApi";
import { queryKeys } from "../../lib/queryKeys";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { IconButton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorController,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import {
  buildWorkspaceNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "../rich-editor/noteImageAssets";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { TodoModuleRail } from "../../todo";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";
import type { ProjectTagRecord } from "../../lib/types";

const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

export function WorkspaceRecordFocusPage() {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const noteId = parseRouteId(params.noteId);
  const { scrollRef, hasSavedPosition } = useScrollPositionRestoration(
    `workspace-record:${noteId}`,
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

  const [title, setTitle] = useState("");
  const [content, setContent] = useState<RichEditorValue>(EMPTY_VALUE);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [codeLanguage, setCodeLanguage] = useState<string | null>(null);
  const [loadedNoteId, setLoadedNoteId] = useState<number | null>(null);
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isSaving, setIsSaving] = useState(false);
  const editorControllerRef = useRef<RichEditorController | null>(null);

  const workspacePageQuery = useQuery({
    queryKey: queryKeys.workspacePage,
    queryFn: projectMindApi.workspacePageGet,
    enabled: noteId !== null,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: noteId !== null,
  });
  const workspaceStatusQuery = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
    enabled: noteId !== null,
  });

  const tagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.workspace,
    queryFn: () => projectMindApi.projectTagSettingsGet({}),
  });
  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
  });

  const note = useMemo(() => {
    if (!workspacePageQuery.data || noteId === null) return null;
    return (workspacePageQuery.data.records ?? []).find((record) => record.id === noteId) ?? null;
  }, [noteId, workspacePageQuery.data]);

  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const aiSettings = aiSettingsQuery.data ?? null;
  const draftReady = Boolean(note && loadedNoteId === note.id);
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
  const { createProjectMutation, archiveMutation, deleteProjectMutation } = useProjectMutations(
    visibleProjects,
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

  useEffect(() => {
    if (!note) return;

    setTitle(note.title ?? "");
    setContent({
      html: getRenderableRichTextHtml({ html: note.contentHtml, markdown: note.contentMarkdown }),
      text: note.contentMarkdown,
      markdown: note.contentMarkdown,
    });
    setTagIds((note.tags ?? []).map((tag) => tag.id));
    setCodeLanguage(note.defaultCodeLanguage ?? null);
    setPersistState("idle");
    setLoadedNoteId(note.id);
  }, [note]);

  const persistWorkspaceRecord = useCallback(
    async (
      targetNote: NonNullable<typeof note>,
      value: RichEditorValue,
      nextTitle: string,
      nextTagIds: number[],
      nextCodeLanguage: string | null,
    ) => {
      setIsSaving(true);
      try {
        const externalizedValue = await externalizeEmbeddedImageDataUrls(
          value,
          workspaceAssetHandlers,
        );
        const normalized = normalizeRichEditorValue(externalizedValue);
        const mentionedTagIds = extractTagMentionIds(normalized.markdown);
        await projectMindApi.workspaceRecordUpsert({
          noteId: targetNote.id,
          title: nextTitle.trim() || undefined,
          markdown: normalized.markdown,
          html: normalized.html,
          defaultCodeLanguage: nextCodeLanguage,
          tagIds: Array.from(new Set([...nextTagIds, ...mentionedTagIds])),
        });
        await workspacePageQuery.refetch();
        await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
        return true;
      } catch (error) {
        pushToast({ tone: "error", title: "保存失败", detail: String(error) });
        throw error;
      } finally {
        setIsSaving(false);
      }
    },
    [pushToast, queryClient, workspaceAssetHandlers, workspacePageQuery],
  );

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      if (!note || !draftReady) return false;
      return persistWorkspaceRecord(note, value, title, tagIds, codeLanguage);
    },
    [codeLanguage, draftReady, note, persistWorkspaceRecord, tagIds, title],
  );

  const saveCurrentRecord = useCallback(async () => {
    if (!note || !draftReady) return false;
    return persistWorkspaceRecord(
      note,
      editorControllerRef.current?.getValue() ?? content,
      title,
      tagIds,
      codeLanguage,
    );
  }, [codeLanguage, content, draftReady, note, persistWorkspaceRecord, tagIds, title]);

  const handleBack = async () => {
    if (noteId === null) return;
    await saveCurrentRecord();
    navigate(
      preserveRecordFilters(`${workspacePath()}?view=record&focus=record-${noteId}`, searchParams),
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
    if (!note || !draftReady) return;
    setTagIds(newTagIds);
    try {
      const nextValue = editorControllerRef.current?.getValue() ?? content;
      await persistWorkspaceRecord(note, nextValue, title, newTagIds, codeLanguage);
    } catch (error) {
      pushToast({ tone: "error", title: "标签更新失败", detail: String(error) });
    }
  };

  if (noteId === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-text-soft">无效的记录ID</p>
      </div>
    );
  }

  if (workspacePageQuery.isLoading || projectsQuery.isLoading || workspaceStatusQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="animate-spin text-text-soft" size={24} />
      </div>
    );
  }

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-text-soft">记录未找到</p>
      </div>
    );
  }

  if (!draftReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="animate-spin text-text-soft" size={24} />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
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
          activeRecordId={noteId}
          recordQuery={recordSearchQuery}
          onRecordQueryChange={setWorkspaceRecordQuery}
          activeRecordTagId={recordFilterTagId}
          onActiveRecordTagIdChange={setWorkspaceRecordTagId}
          onOpenOverview={() => navigate(preserveRecordFilters(workspacePath(), searchParams))}
          onOpenProject={(projectId) => {
            void openProject(projectId);
          }}
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
          onOpenRecord={(recordId) => {
            void (async () => {
              if (recordId === noteId) {
                return;
              }

              try {
                const saved = await saveCurrentRecord();
                if (!saved) {
                  return;
                }
              } catch {
                return;
              }

              navigate(preserveRecordFilters(`/workspace/records/${recordId}`, searchParams));
            })();
          }}
          onFocusRecord={(recordId) => {
            void (async () => {
              if (recordId === noteId) {
                return;
              }

              try {
                const saved = await saveCurrentRecord();
                if (!saved) {
                  return;
                }
              } catch {
                return;
              }

              navigate(preserveRecordFilters(`/workspace/records/${recordId}`, searchParams));
            })();
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
                  onClick={() => void handleBack()}
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
              <TextField
                value={title}
                placeholder="记录标题"
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => {
                  if (note && draftReady && title !== (note.title ?? "")) {
                    void handleSave(editorControllerRef.current?.getValue() ?? content);
                  }
                }}
                className="text-lg font-medium"
              />
              <EntityTagEditor
                projectId={null}
                availableTags={availableTags}
                tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
                onChange={handleTagsChange}
                onCreated={syncWorkspaceTagCache}
              />
              <RichEditor
                key={note.id}
                html={content.html}
                aiSettings={aiSettings}
                defaultCodeLanguage={codeLanguage}
                onDefaultCodeLanguageChange={setCodeLanguage}
                variant="page"
                showToolbar={false}
                autoFocus={!hasSavedPosition}
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
          availableTags={availableTags}
          onOpenProject={openProject}
          onOpenInternalReference={openInternalReference}
          onOpenContactMention={openContactMention}
        />
      ) : null}
    </div>
  );
}

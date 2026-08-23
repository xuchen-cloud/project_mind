import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Settings2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import {
  parseRouteId,
  parseFocusTodoId,
  preserveRecordFilters,
  projectPath,
  recordFocusId,
  workspacePath,
} from "../../lib/formatters";
import { pageWidthContainerClass, withPageWidthClass } from "../../lib/pageWidth";
import { queryKeys } from "../../lib/queryKeys";
import {
  getRenderableRichTextHtml,
  renderMarkdownToHtml,
  type RichEditorSelectionPayload,
  type RichEditorValue,
} from "../rich-editor";
import { generateDefaultProjectName } from "../../lib/projectDefaultName";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { colorKeyForTagLabel, extractHashTagLabels, findTagByLabel, mergeUniqueTagIds } from "../../lib/tags";
import { extractTagMentionIds } from "../../lib/tagMentions";
import type { ProjectTagRecord, WorkspaceRecord } from "../../lib/types";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useWorkspaceQuickNoteMutations } from "../../hooks/useWorkspaceQuickNoteMutations";
import { useWorkspaceRecordMutations } from "../../hooks/useWorkspaceRecordMutations";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { desktopApi } from "../../services/desktopApi";
import { cn } from "../../ui/lib/cn";
import { IconButton } from "../../ui/components";
import { RichEditor } from "../rich-editor";
import {
  buildWorkspaceNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "../rich-editor/noteImageAssets";
import { TodoModuleRail } from "../../todo";
import { appendMarkdownSection, appendRichTextSection } from "../../lib/record-move";
import { MoveSelectionToRecordCard } from "../record/MoveSelectionToRecordCard";
import { WorkspaceOverviewHistory } from "./WorkspaceOverviewHistory";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";

type WorkspacePageView = "quick-note" | "record";
const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

interface WorkspacePageProps {
  activeProjectIdOverride?: number | null;
  searchParamsOverride?: URLSearchParams;
  visible?: boolean;
  onSearchParamsOverride?: (
    nextSearchParams: URLSearchParams,
    options?: { replace?: boolean },
  ) => void;
}

export function WorkspacePage({
  activeProjectIdOverride,
  searchParamsOverride,
  visible = true,
  onSearchParamsOverride,
}: WorkspacePageProps = {}) {
  const navigate = useNavigate();
  const params = useParams();
  const queryClient = useQueryClient();
  const [routeSearchParams, setRouteSearchParams] = useSearchParams();
  const searchParams = searchParamsOverride ?? routeSearchParams;
  const setWorkspaceSearchParams = onSearchParamsOverride ?? setRouteSearchParams;
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
  const activeProjectId =
    activeProjectIdOverride !== undefined
      ? activeProjectIdOverride
      : parseRouteId(params.projectId);

  const focusId = searchParams.get("focus");
  const focusedRecordId = parseFocusRecordId(focusId);
  const focusedTodoId = parseFocusTodoId(focusId);
  const explicitView = parseWorkspacePageView(searchParams.get("view"));
  const composeRecord = searchParams.get("compose") === "record";
  const routeView = explicitView ?? (focusedRecordId !== null ? "record" : "quick-note");
  const [buttonView, setButtonView] = useState<WorkspacePageView | null>(null);
  const currentView = buttonView ?? routeView;

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: visible,
  });
  const workspacePageQuery = useQuery({
    queryKey: queryKeys.workspacePage,
    queryFn: projectMindApi.workspacePageGet,
    enabled: visible,
  });
  const workspaceStatusQuery = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
    enabled: visible,
  });
  const workspaceTagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.workspace,
    queryFn: () => projectMindApi.projectTagSettingsGet({}),
    enabled: visible,
  });
  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
    enabled: visible,
  });

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );
  const archivedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => project.isArchived),
    [projectsQuery.data],
  );
  const workspacePage = workspacePageQuery.data;
  const currentWorkspace = workspaceStatusQuery.data?.currentWorkspace ?? null;
  const availableTags = workspaceTagSettingsQuery.data?.tags ?? [];
  const aiSettings = aiSettingsQuery.data ?? null;
  const [quickNoteDraft, setQuickNoteDraft] = useState<RichEditorValue>(EMPTY_VALUE);
  const [quickNoteCodeLanguage, setQuickNoteCodeLanguage] = useState<string | null>(null);
  const [quickNoteMoveSelection, setQuickNoteMoveSelection] =
    useState<RichEditorSelectionPayload | null>(null);
  const workspaceAssetHandlers = useMemo(() => buildWorkspaceNoteImageAssetHandlers(), []);
  const recordSearchQuery = searchParams.get("recordQuery") ?? "";
  const recordFilterTagId = useMemo(() => {
    const value = searchParams.get("recordTag");
    if (!value) {
      return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, [searchParams]);
  const { workspaceQuickNoteMutation } = useWorkspaceQuickNoteMutations();
  const { workspaceRecordMutation, workspaceRecordDeleteMutation } = useWorkspaceRecordMutations();
  const { createProjectMutation, archiveMutation, deleteProjectMutation } = useProjectMutations(
    visibleProjects,
    (path, options) => navigate(path, options),
  );

  useEffect(() => {
    if (buttonView === null || buttonView === routeView) {
      setButtonView(null);
    }
  }, [buttonView, routeView]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const quickNote = workspacePage?.quickNote;
    setQuickNoteCodeLanguage(quickNote?.defaultCodeLanguage ?? null);
    const nextDraft = {
      html: getRenderableRichTextHtml({
        html: quickNote?.contentHtml,
        markdown: quickNote?.contentMarkdown,
      }),
      text: quickNote?.contentMarkdown ?? "",
      markdown: quickNote?.contentMarkdown ?? "",
    };

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
  }, [
    visible,
    workspacePage?.quickNote?.contentHtml,
    workspacePage?.quickNote?.contentMarkdown,
    workspacePage?.quickNote?.defaultCodeLanguage,
  ]);

  const workspaceRecords = useMemo(() => workspacePage?.records ?? [], [workspacePage?.records]);
  const filteredWorkspaceRecords = useMemo(() => {
    const normalizedQuery = recordSearchQuery.trim().toLowerCase();

    return workspaceRecords.filter((record) => {
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
  }, [recordFilterTagId, recordSearchQuery, workspaceRecords]);
  const visibleRecordFocusKey = useMemo(
    () => filteredWorkspaceRecords.map((record) => record.id).join(","),
    [filteredWorkspaceRecords],
  );

  useFocusTarget(
    visible && focusedRecordId !== null && currentView === "record"
      ? recordFocusId(focusedRecordId)
      : null,
    [currentView, visible, visibleRecordFocusKey],
  );

  async function ensureWorkspaceTagIds(markdown: string, explicitTagIds: number[]) {
    const mentionedTagIds = extractTagMentionIds(markdown);
    const hashLabels = extractHashTagLabels(markdown);
    const hashTagIds: number[] = [];

    for (const label of hashLabels) {
      const existing = findTagByLabel(availableTags, label);
      const tag =
        existing ??
        (await projectMindApi.projectTagUpsert({
          label,
          colorKey: colorKeyForTagLabel(label),
        }));
      hashTagIds.push(tag.id);
    }

    return mergeUniqueTagIds(explicitTagIds, mentionedTagIds, hashTagIds);
  }

  async function moveQuickNoteSelectionToWorkspaceRecord(record: WorkspaceRecord) {
    const selection = quickNoteMoveSelection;
    if (!selection) {
      return;
    }

    try {
      const markdown = appendMarkdownSection(record.contentMarkdown, selection.markdown);
      const html = appendRichTextSection(
        { html: record.contentHtml, markdown: record.contentMarkdown },
        selection.html,
      );
      const tagIds = await ensureWorkspaceTagIds(
        markdown,
        (record.tags ?? []).map((tag) => tag.id),
      );

      await workspaceRecordMutation.mutateAsync({
        noteId: record.id,
        title: record.title?.trim() || undefined,
        markdown,
        html,
        defaultCodeLanguage: record.defaultCodeLanguage ?? null,
        tagIds,
      });
      await selection.removeSelectionAndSave();
      await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
      await queryClient.invalidateQueries({ queryKey: ["project-tag-settings", "workspace"] });
      pushToast({ tone: "success", title: "已移动到记录", detail: record.title?.trim() || "未命名记录" });
      setQuickNoteMoveSelection(null);
    } catch (error) {
      pushToast({ tone: "error", title: "移动到记录失败", detail: String(error) });
      throw error;
    }
  }

  async function createWorkspaceRecordFromQuickNoteSelection(title?: string) {
    const selection = quickNoteMoveSelection;
    if (!selection) {
      return;
    }

    try {
      const markdown = selection.markdown.trim();
      const html = selection.html.trim() || renderMarkdownToHtml(markdown);
      const tagIds = await ensureWorkspaceTagIds(markdown, []);
      const record = await workspaceRecordMutation.mutateAsync({
        title: title?.trim() || undefined,
        markdown,
        html,
        tagIds,
      });

      await selection.removeSelectionAndSave();
      await queryClient.invalidateQueries({ queryKey: ["workspace-page"] });
      await queryClient.invalidateQueries({ queryKey: ["project-tag-settings", "workspace"] });
      pushToast({ tone: "success", title: "已创建记录", detail: record.title?.trim() || "未命名记录" });
      setQuickNoteMoveSelection(null);
    } catch (error) {
      pushToast({ tone: "error", title: "创建记录失败", detail: String(error) });
      throw error;
    }
  }

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

  function setWorkspacePageView(nextView: WorkspacePageView) {
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

    setWorkspaceSearchParams(nextSearchParams);
  }

  function openRecord(recordId: number) {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("view", "record");
    nextSearchParams.set("focus", `record-${recordId}`);
    nextSearchParams.delete("compose");
    setWorkspaceSearchParams(nextSearchParams);
  }

  function setWorkspaceRecordQuery(value: string) {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (value.trim()) {
      nextSearchParams.set("recordQuery", value);
    } else {
      nextSearchParams.delete("recordQuery");
    }
    setWorkspaceSearchParams(nextSearchParams, { replace: true });
  }

  function setWorkspaceRecordTagId(tagId: number | null) {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (tagId === null) {
      nextSearchParams.delete("recordTag");
    } else {
      nextSearchParams.set("recordTag", String(tagId));
    }
    nextSearchParams.set("view", "record");
    setWorkspaceSearchParams(nextSearchParams);
  }

  async function createWorkspaceRecordInFocus() {
    const record = await workspaceRecordMutation.mutateAsync({
      markdown: "",
      html: "<p></p>",
      tagIds: [],
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
    navigate(preserveRecordFilters(`/workspace/records/${record.id}`, searchParams));
  }

  function closeComposeRecord() {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("compose");
    setWorkspaceSearchParams(nextSearchParams);
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

        if (activeProjectId === projectId) {
          navigate(workspacePath());
        }
      }
    } catch (error) {
      pushToast({
        tone: "error",
        title: "打开项目新窗口失败",
        detail: String(error),
      });
    }
  }

  async function openProject(projectId: number) {
    const focused = await desktopApi.focusProjectWindow(projectId);
    if (focused) {
      return;
    }

    navigate(projectPath(projectId));
  }

  async function createProjectQuickly() {
    if (createProjectMutation.isPending) {
      return;
    }

    const nextName = generateDefaultProjectName(
      (projectsQuery.data ?? []).map((project) => project.name),
    );

    await createProjectMutation.mutateAsync({
      name: nextName,
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

  if (!workspacePage || !currentWorkspace) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载工作区...
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <WorkspaceOverviewSidebar
        workspaceRootPath={currentWorkspace.rootPath}
        projects={visibleProjects}
        archivedProjects={archivedProjects}
        records={(workspacePage.records ?? []).map((record) => ({
          id: record.id,
          title: record.title,
          contentMarkdown: record.contentMarkdown,
          tags: record.tags ?? [],
          updatedAt: record.updatedAt,
        }))}
        activeRecordId={focusedRecordId}
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
        onOpenRecord={openRecord}
        onFocusRecord={(recordId) =>
          navigate(preserveRecordFilters(`/workspace/records/${recordId}`, searchParams))
        }
        onCreateRecord={() => void createWorkspaceRecordInFocus()}
      />

      <div className="project-overview-focus flex-1" data-testid="workspace-overview-focus-page">
        <header className="project-overview-focus__chrome">
          <div
            className={cn(
              "project-overview-focus__chrome-inner",
              projectSidebarCollapsed && "project-overview-focus__chrome-inner--dock-left",
              todoRailCollapsed && "project-overview-focus__chrome-inner--dock-right",
            )}
          >
            <div className="project-overview-focus__meta">
              <div className="min-w-0">
                <h1 className="project-overview-focus__title">Workspace</h1>
                <button
                  type="button"
                  className="project-overview-focus__path"
                  onClick={() =>
                    void desktopApi.openFolder(currentWorkspace.rootPath)
                  }
                >
                  {currentWorkspace.rootPath}
                </button>
              </div>
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
                data-testid="workspace-overview-view-switch"
              >
                <button
                  type="button"
                  className={cn(
                    "project-overview-focus__view-switch-button",
                    currentView === "quick-note" &&
                      "project-overview-focus__view-switch-button--active",
                  )}
                  data-testid="workspace-page-view-quick-note"
                  aria-pressed={currentView === "quick-note"}
                  onClick={() => setWorkspacePageView("quick-note")}
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
                  data-testid="workspace-page-view-record"
                  aria-pressed={currentView === "record"}
                  onClick={() => setWorkspacePageView("record")}
                >
                  Record
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className="project-overview-focus__scroll" data-testid="workspace-overview-focus-scroll">
          <div
            className={cn(
              "mx-auto w-full",
              currentView === "quick-note"
                ? pageWidthContainerClass(pageWidthMode, "overview")
                : "max-w-none",
            )}
          >
            <section
              className={withPageWidthClass("project-overview-focus__page", pageWidthMode, "focus")}
              data-testid="workspace-page-body-quick-note"
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
                assetHandlers={workspaceAssetHandlers}
                placeholder="记下当前最需要先抓住的背景、判断、候选行动或提醒。"
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
                selectionActions={[
                  {
                    key: "workspace-selection-move-to-record",
                    label: "移动到记录",
                    icon: null as never,
                    onSelect: (selection) => {
                      setQuickNoteMoveSelection(selection);
                    },
                  },
                ]}
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
                onOpenAiSettings={() => openSettings("ai-rewrite")}
                onSave={async (value) => {
                  const externalizedValue = await externalizeEmbeddedImageDataUrls(
                    value,
                    workspaceAssetHandlers,
                  );
                  const tagIds = await ensureWorkspaceTagIds(externalizedValue.markdown, []);
                  await workspaceQuickNoteMutation.mutateAsync({
                    markdown: externalizedValue.markdown,
                    html: externalizedValue.html,
                    defaultCodeLanguage: quickNoteCodeLanguage,
                    tagIds,
                  });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
                }}
              />
            </section>
            <div
              style={{ display: currentView === "record" ? undefined : "none" }}
              aria-hidden={currentView === "record" ? undefined : true}
            >
              <WorkspaceOverviewHistory
                notes={filteredWorkspaceRecords}
                hasAnyNotes={workspaceRecords.length > 0}
                focusId={focusId}
                composeRecord={composeRecord}
                pageWidthMode={pageWidthMode}
                availableTags={availableTags}
                aiSettings={aiSettings}
                saving={workspaceRecordMutation.isPending}
                onCreateRecord={async (input) => {
                  const externalizedValue = await externalizeEmbeddedImageDataUrls(
                    { html: input.html, markdown: input.markdown, text: input.markdown },
                    workspaceAssetHandlers,
                  );
                  const tagIds = await ensureWorkspaceTagIds(externalizedValue.markdown, input.tagIds ?? []);
                  await workspaceRecordMutation.mutateAsync({
                    ...input,
                    markdown: externalizedValue.markdown,
                    html: externalizedValue.html,
                    tagIds,
                  });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
                }}
                onUpdateRecord={async (note, input) => {
                  const externalizedValue = await externalizeEmbeddedImageDataUrls(
                    { html: input.html, markdown: input.markdown, text: input.markdown },
                    workspaceAssetHandlers,
                  );
                  const tagIds = await ensureWorkspaceTagIds(externalizedValue.markdown, input.tagIds ?? []);
                  await workspaceRecordMutation.mutateAsync({
                    noteId: note.id,
                    ...input,
                    markdown: externalizedValue.markdown,
                    html: externalizedValue.html,
                    tagIds,
                  });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
                }}
                onDeleteRecord={async (noteId) => {
                  await workspaceRecordDeleteMutation.mutateAsync({ noteId });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
                }}
                onCloseCompose={closeComposeRecord}
                contactMentionOptions={contactMentionOptions}
                onOpenInternalReference={openInternalReference as (reference: unknown) => Promise<boolean>}
                assetHandlers={workspaceAssetHandlers}
                active={visible && currentView === "record"}
                recordFilters={searchParams}
              />
            </div>
          </div>
        </div>
      </div>

      <TodoModuleRail
        scope={{ kind: "workspace" }}
        enabled={visible}
        focusTodoId={focusedTodoId}
        availableTags={availableTags}
        onOpenInternalReference={openInternalReference}
        onOpenContactMention={openContactMention}
      />
      {quickNoteMoveSelection ? (
        <MoveSelectionToRecordCard
          records={workspaceRecords}
          onClose={() => setQuickNoteMoveSelection(null)}
          onSelectRecord={moveQuickNoteSelectionToWorkspaceRecord}
          onCreateRecord={createWorkspaceRecordFromQuickNoteSelection}
        />
      ) : null}
    </div>
  );
}

function parseWorkspacePageView(value: string | null): WorkspacePageView | null {
  if (value === "quick-note" || value === "record") {
    return value;
  }

  return null;
}

function parseFocusRecordId(focus: string | null) {
  const match = focus?.match(/^record-(\d+)$/u);
  return match ? Number(match[1]) : null;
}

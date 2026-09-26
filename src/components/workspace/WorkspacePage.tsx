import { useQuery,useQueryClient } from "@tanstack/react-query";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { useNavigate,useParams,useSearchParams } from "react-router-dom";

import noriBust from "../../assets/home/nori-bust.png";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useDelayedPending } from "../../hooks/useDelayedPending";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import { useWorkspaceQuickNoteMutations } from "../../hooks/useWorkspaceQuickNoteMutations";
import { useWorkspaceRecordMutations } from "../../hooks/useWorkspaceRecordMutations";
import {
parseFocusTodoId,
parseRouteId,
preserveRecordFilters,
projectPath,
recordFocusId,
workspacePath,
} from "../../lib/formatters";
import { prefetchProjectPageData } from "../../lib/project-prefetch";
import { generateDefaultProjectName } from "../../lib/projectDefaultName";
import { queryKeys } from "../../lib/queryKeys";
import { completeQuickNoteRecordMetadata } from "../../lib/quick-note-auto-metadata";
import { deriveQuickNoteMetadata } from "../../lib/quick-note-metadata";
import type { QuickNoteTransferTarget } from "../../lib/quick-note-transfer";
import { appendMarkdownSection,appendRichTextSection } from "../../lib/record-move";
import { extractTagMentionIds } from "../../lib/tagMentions";
import { colorKeyForTagLabel,findTagByLabel,mergeUniqueTagIds } from "../../lib/tags";
import type { ProjectTagRecord } from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { TodoModuleRail } from "../../todo";
import { PageLoadingSkeleton } from "../../ui/components";
import "../home/home.css";
import { HomeCover } from "../home/HomeCover";
import { HomeQuickNote } from "../home/HomeQuickNote";
import { HomeRecordFilters } from "../home/HomeRecordFilters";
import {
getRenderableRichTextHtml,
RichEditor,
type RichEditorValue
} from "../rich-editor";
import {
buildWorkspaceNoteImageAssetHandlers,
externalizeEmbeddedImageDataUrls,
} from "../rich-editor/noteImageAssets";
import { WorkspaceOverviewHistory } from "./WorkspaceOverviewHistory";
import { WorkspaceOverviewSidebar } from "./WorkspaceOverviewSidebar";
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
  const wasWorkspacePageCachedAtMount = useRef(
    queryClient.getQueryData(queryKeys.workspacePage) !== undefined,
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
    todoRailWidthPx,
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
  const composeRecord = searchParams.get("compose") === "record";

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
  const prefetchProject = useCallback(
    (projectId: number) => {
      void prefetchProjectPageData(queryClient, projectId).catch(() => {
        // The destination query reports prefetch failures.
      });
    },
    [queryClient],
  );
  const [quickNoteDraft, setQuickNoteDraft] = useState<RichEditorValue>(EMPTY_VALUE);
  const [quickNoteCodeLanguage, setQuickNoteCodeLanguage] = useState<string | null>(null);
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
    (path, options) => navigate(path, options),
    activeProjectId,
  );

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
    visible && focusedRecordId !== null
      ? recordFocusId(focusedRecordId)
      : null,
    [visible, visibleRecordFocusKey],
  );

  async function ensureWorkspaceTagIds(markdown: string, explicitTagIds: number[]) {
    const mentionedTagIds = extractTagMentionIds(markdown);
    const hashLabels = deriveQuickNoteMetadata(markdown).tagLabels;
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

  async function saveWorkspaceQuickNote(value: RichEditorValue) {
    const externalizedValue = await externalizeEmbeddedImageDataUrls(value, workspaceAssetHandlers);
    const tagIds = await ensureWorkspaceTagIds(externalizedValue.markdown, []);
    await workspaceQuickNoteMutation.mutateAsync({
      markdown: externalizedValue.markdown,
      html: externalizedValue.html,
      defaultCodeLanguage: quickNoteCodeLanguage,
      tagIds,
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
    return externalizedValue;
  }

  async function commitWorkspaceQuickNote(value: RichEditorValue, target: QuickNoteTransferTarget) {
    const metadata = deriveQuickNoteMetadata(value.markdown);
    const targetRecord = target.kind === "append"
      ? workspaceRecords.find((record) => record.id === target.recordId)
      : undefined;
    if (target.kind === "append" && !targetRecord) {
      throw new Error("只能追加到当前 Workspace 的 Record");
    }
    const tagIds = mergeUniqueTagIds(
      targetRecord?.tags?.map((tag) => tag.id) ?? [],
      extractTagMentionIds(value.markdown),
    );
    for (const label of metadata.tagLabels) {
      const existing = findTagByLabel(availableTags, label);
      const tag = existing ?? await projectMindApi.projectTagUpsert({
        label,
        colorKey: colorKeyForTagLabel(label),
      });
      if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
    }
    const record = await projectMindApi.workspaceQuickNoteCommit({
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
    if (!targetRecord) void completeQuickNoteRecordMetadata({ record, availableTags, aiSettings })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage }))
      .catch(() => pushToast({ tone: "info", title: "记录已保存", detail: "AI 标题和标签未填写，可在记录中重试 AI 填写。" }));
    return record;
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

  async function renameWorkspaceSidebarRecord(recordId: number, title: string) {
    const record = workspaceRecords.find((candidate) => candidate.id === recordId);
    if (!record) {
      return;
    }

    await workspaceRecordMutation.mutateAsync({
      noteId: record.id,
      title: title.trim() || undefined,
      markdown: record.contentMarkdown,
      html: record.contentHtml,
      defaultCodeLanguage: record.defaultCodeLanguage ?? null,
      tagIds: (record.tags ?? []).map((tag) => tag.id),
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
  }

  async function deleteWorkspaceSidebarRecord(recordId: number) {
    await workspaceRecordDeleteMutation.mutateAsync({ noteId: recordId });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });

    if (focusedRecordId === recordId) {
      const nextSearchParams = new URLSearchParams(searchParams);
      nextSearchParams.set("view", "record");
      nextSearchParams.delete("focus");
      setWorkspaceSearchParams(nextSearchParams, { replace: true });
    }
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

  const workspacePagePending = !workspacePage || !currentWorkspace;
  const showWorkspacePageSkeleton = useDelayedPending(workspacePagePending);

  if (workspacePagePending) {
    if (!showWorkspacePageSkeleton) return null;
    return <PageLoadingSkeleton variant="overview" label="正在加载工作区" />;
  }

  return (
    <div
      className="home-page page-cold-entry relative flex h-full min-h-0 overflow-hidden"
      data-cold-entry={wasWorkspacePageCachedAtMount.current ? undefined : "true"}
    >
      <WorkspaceOverviewSidebar
        workspaceRootPath={currentWorkspace.rootPath}
        availableTags={availableTags}
        projects={visibleProjects}
        archivedProjects={archivedProjects}
        records={(workspacePage.records ?? []).map((record) => ({
          id: record.id,
          title: record.title,
          contentMarkdown: record.contentMarkdown,
          isVoice: record.isVoice,
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
        onOpenRecord={openRecord}
        onFocusRecord={(recordId) =>
          navigate(preserveRecordFilters(`/workspace/records/${recordId}`, searchParams))
        }
        onCreateRecord={() => void createWorkspaceRecordInFocus()}
        onRenameRecord={(record, title) => renameWorkspaceSidebarRecord(record.id, title)}
        onDeleteRecord={(record) => deleteWorkspaceSidebarRecord(record.id)}
      />

      <div className="project-overview-focus flex-1" data-testid="workspace-overview-focus-page">
        <div className="project-overview-focus__scroll" data-testid="workspace-overview-focus-scroll">
          <div className="home-content">
            <HomeCover identityKey={`workspace:${currentWorkspace.rootPath}`} defaultIcon="House" title={currentWorkspace.displayName || "我的工作区"} subtitle="工作区" />
            <HomeQuickNote
              key={currentWorkspace?.rootPath}
              identity={`workspace-quick-note:${currentWorkspace?.rootPath}`}
              initialValue={quickNoteDraft}
              records={workspaceRecords}
              persist={saveWorkspaceQuickNote}
              commit={commitWorkspaceQuickNote}
              onClear={() => {
                setQuickNoteDraft(EMPTY_VALUE);
                setQuickNoteCodeLanguage(null);
              }}
              onCommitted={async () => {
                await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
                await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
              }}
              renderEditor={({ controllerRef, onSave, onPersistStateChange, readOnly }) => (
                <RichEditor
                  contentIdentity="workspace-quick-note"
                  html={quickNoteDraft.html}
                  readOnly={!visible || readOnly}
                  aiSettings={aiSettings}
                  defaultCodeLanguage={quickNoteCodeLanguage}
                  onDefaultCodeLanguageChange={setQuickNoteCodeLanguage}
                  variant="toolbar"
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
                  controllerRef={controllerRef}
                  onOpenAiSettings={() => openSettings("ai-rewrite")}
                  onSave={onSave}
                  onPersistStateChange={onPersistStateChange}
                />
              )}
            />
            <HomeRecordFilters onClearFilters={() => { const next = new URLSearchParams(searchParams); next.delete("recordTag"); next.delete("recordQuery"); setWorkspaceSearchParams(next); }} title="工作区记录" query={recordSearchQuery} tag={availableTags.find((tag) => tag.id === recordFilterTagId)?.label}
              onQuery={setWorkspaceRecordQuery} onClearTag={() => setWorkspaceRecordTagId(null)} onCreate={() => void createWorkspaceRecordInFocus()} />
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
                active={visible}
                recordFilters={searchParams}
              />
          </div>
        </div>
      </div>

      <div style={{ width: todoRailCollapsed ? undefined : todoRailWidthPx }} className={`home-rail home-rail--workspace${todoRailCollapsed ? " is-collapsed" : ""}`}><div className="home-rail__todo">
      <TodoModuleRail
        scope={{ kind: "workspace" }}
        enabled={visible}
        focusTodoId={focusedTodoId}
        availableTags={availableTags}
        onOpenInternalReference={openInternalReference}
        onOpenContactMention={openContactMention}
      />
      </div>{!todoRailCollapsed ? <div className="home-brand"><p>“让好想法，<br />在有上下文的地方持续推进。”</p><small>— Nori Mind</small><img src={noriBust} alt="Nori 小熊" /></div> : null}</div>
    </div>
  );
}

function parseFocusRecordId(focus: string | null) {
  const match = focus?.match(/^record-(\d+)$/u);
  return match ? Number(match[1]) : null;
}

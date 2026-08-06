import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";

import type {
  DocumentRecord,
  NoteRecord,
  WorkspaceSearchResult,
  WorkspaceStatusSnapshot,
} from "./lib/types";
import { ensureAiJobSync, resetAiJobSync } from "./lib/aiJobs";
import {
  parseRouteId,
  parseFocusRecordId,
  preserveRecordFilters,
  projectPath,
  recordPath,
  recordFocusId,
  workspacePath,
} from "./lib/formatters";
import { generateDefaultProjectName } from "./lib/projectDefaultName";
import { requestProjectRecordFocusSave } from "./lib/record-focus-save";
import { queryKeys } from "./lib/queryKeys";
import {
  getCurrentWindowLabel,
  isProjectWindow,
  listenToProjectWindowNavigation,
  parseProjectWindowProjectId,
} from "./lib/project-window";
import {
  DEFAULT_RICH_TEXT_STYLE_SETTINGS,
  applyRichTextStyleVariables,
} from "./lib/richTextStyle";
import { projectMindApi } from "./services/projectMindApi";
import { desktopApi } from "./services/desktopApi";
import { useFeedbackStore } from "./state/feedback-store";
import { useUiStore } from "./state/ui-store";
import { useProjectMutations } from "./hooks/useProjectMutations";
import { useDebouncedValue } from "./hooks/useUtilityHooks";
import { useWorkspaceWindowSizeConstraints } from "./hooks/useWorkspaceWindowSizeConstraints";
import { useResidentProjectPages } from "./hooks/useResidentProjectPages";
import { useResidentWorkspacePage } from "./hooks/useResidentWorkspacePage";
import {
  ProjectSidebar,
  type ProjectSidebarDocumentItem,
  type ProjectSidebarRecordItem,
} from "./components/layout/ProjectSidebar";
import { StatusBar } from "./components/layout/StatusBar";
import { WorkspaceTopBar } from "./components/layout/WorkspaceTopBar";
import { ToastStack } from "./components/layout/ToastStack";
import { ProjectOverviewPage } from "./components/project/ProjectOverviewPage";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { WorkspacePage } from "./components/today/WorkspacePage";
import { WorkspaceGatePage } from "./components/workspace/WorkspaceGatePage";
import {
  CreateWorkspaceDialog,
  UnlockWorkspaceSecretsDialog,
} from "./components/workspace/WorkspaceDialogs";
import { Button, EmptyState } from "./ui/components";

function workspaceScopedQueryKeys() {
  return [
    ["projects"],
    ["project-page"],
    ["search"],
    ["workspace-todos"],
    ["workspace-page"],
    ["ai-settings"],
    ["ai-artifact"],
    ["rich-text-style"],
    ["project-tag-settings"],
  ] as const;
}

function toProjectSidebarRecords(
  records: NoteRecord[],
): ProjectSidebarRecordItem[] {
  return records.map((record) => ({
    id: record.id,
    projectId: record.projectId,
    activityId: record.activityId,
    title: record.title,
    typeLabel: "记录",
    contentMarkdown: record.contentMarkdown,
    contentHtml: record.contentHtml,
    defaultCodeLanguage: record.defaultCodeLanguage ?? null,
    tags: record.tags ?? [],
    updatedAt: record.updatedAt,
  }));
}

function toProjectSidebarDocuments(
  documents: DocumentRecord[],
): ProjectSidebarDocumentItem[] {
  return documents.map((document) => ({
    id: document.id,
    projectId: document.projectId,
    name: document.name,
    baseName: document.baseName,
    mimeType: document.mimeType,
    managedPath: document.managedPath,
    originalPath: document.originalPath,
    historyDirPath: document.historyDirPath,
    isStarred: document.isStarred,
    currentVersionNumber: document.currentVersionNumber,
    versionCount: document.versionCount,
    health: document.health,
    tags: document.tags ?? [],
  }));
}

function isProjectOverviewPath(pathname: string, projectId: number | null) {
  return projectId !== null && pathname === projectPath(projectId);
}

function getProjectOverviewSearchParams(route: string) {
  const [, search = ""] = route.split("?");
  return new URLSearchParams(search);
}

function getWorkspaceOverviewSearchParams(route: string) {
  const [, search = ""] = route.split("?");
  return new URLSearchParams(search);
}

function buildProjectOverviewRoute(projectId: number, searchParams: URLSearchParams) {
  const nextSearch = searchParams.toString();
  return `${projectPath(projectId)}${nextSearch ? `?${nextSearch}` : ""}`;
}

function buildWorkspaceOverviewRoute(searchParams: URLSearchParams) {
  const nextSearch = searchParams.toString();
  return `${workspacePath()}${nextSearch ? `?${nextSearch}` : ""}`;
}

export function workspaceSearchResultRoute(result: WorkspaceSearchResult) {
  switch (result.kind) {
    case "workspace_quick_note":
      return workspacePath();
    case "workspace_note":
      return `/workspace/records/${result.id}`;
    case "contact":
      return null;
    case "project":
      return null;
    case "activity":
      return `/projects/${result.projectId}/activities/${result.id}`;
    case "note":
      return projectPath(result.projectId, recordFocusId(result.id));
    case "conclusion":
      return projectPath(result.projectId, `conclusion-${result.id}`);
    case "todo":
      return result.scope === "workspace"
        ? `${workspacePath()}?focus=todo-${result.id}`
        : projectPath(result.projectId, `todo-${result.id}`);
    case "document":
      return projectPath(result.projectId, `document-${result.id}`);
  }
}

export function WorkspaceLayout({
  cacheProjectOverviewPages = false,
}: {
  cacheProjectOverviewPages?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const queryClient = useQueryClient();
  const projectWindow = isProjectWindow();
  const currentWindowLabel = getCurrentWindowLabel();
  const currentProjectWindowId = parseProjectWindowProjectId(currentWindowLabel);
  const activeProjectId = parseRouteId(params.projectId);
  const activeRecordId =
    parseRouteId(params.noteId) ??
    parseFocusRecordId(new URLSearchParams(location.search).get("focus"));
  const workspaceActive =
    location.pathname === workspacePath() ||
    location.pathname === "/today" ||
    /^\/workspace\/records\/\d+$/u.test(location.pathname);
  const projectRecordQuery = useMemo(
    () => new URLSearchParams(location.search).get("recordQuery") ?? "",
    [location.search],
  );
  const projectRecordTagId = useMemo(() => {
    const value = new URLSearchParams(location.search).get("recordTag");
    if (!value) {
      return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, [location.search]);

  const {
    settingsOpen,
    settingsSection,
    settingsProjectId,
    openSettings,
    closeSettings,
    openProjectIds,
    openProjectTab,
    closeProjectTab,
    setSettingsSection,
    projectRecentPaths,
    projectSidebarCollapsed,
    setCreateProjectOpen,
    rememberProjectRoute,
    clearWorkspaceScopedUiState,
    todoRailCollapsed,
    setTodoRailCollapsed,
  } = useUiStore();
  const { toasts, dismissToast, pushToast, setStatus } = useFeedbackStore();

  const workspaceStatusQuery = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
  });
  const currentWorkspace = workspaceStatusQuery.data?.currentWorkspace ?? null;
  const hasWorkspace = Boolean(currentWorkspace);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: hasWorkspace,
  });
  const richTextStyleQuery = useQuery({
    queryKey: queryKeys.richTextStyle,
    queryFn: projectMindApi.richTextStyleGet,
    enabled: hasWorkspace,
  });

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );
  const openedProjects = useMemo(
    () =>
      openProjectIds
        .map((projectId) =>
          (projectsQuery.data ?? []).find((project) => project.id === projectId) ??
          null,
        )
        .filter((project): project is NonNullable<typeof project> => project !== null),
    [openProjectIds, projectsQuery.data],
  );
  const activeProject = useMemo(
    () =>
      (projectsQuery.data ?? []).find(
        (project) => project.id === activeProjectId,
      ) ?? null,
    [activeProjectId, projectsQuery.data],
  );
  const projectSidebarOverviewQuery = useQuery({
    queryKey: queryKeys.projectPage(activeProjectId),
    queryFn: () =>
      projectMindApi.projectPageGet({ projectId: activeProjectId as number }),
    enabled: hasWorkspace && activeProjectId !== null,
  });
  const projectSidebarRecords = useMemo(
    () => toProjectSidebarRecords(projectSidebarOverviewQuery.data?.records ?? []),
    [projectSidebarOverviewQuery.data?.records],
  );
  const projectSidebarDocuments = useMemo(
    () =>
      toProjectSidebarDocuments(
        projectSidebarOverviewQuery.data?.projectDocuments ?? [],
      ),
    [projectSidebarOverviewQuery.data?.projectDocuments],
  );
  const showProjectSidebarShell =
    hasWorkspace && activeProjectId !== null && activeProject !== null;
  const showTodoRailShell =
    showProjectSidebarShell &&
    !location.pathname.endsWith("/summary") &&
    !/\/projects\/\d+\/records\/\d+$/u.test(location.pathname);
  const showLeftSidebarForWidthConstraint = workspaceActive || showProjectSidebarShell;
  const showRightSidebarForWidthConstraint = workspaceActive || showTodoRailShell;

  useWorkspaceWindowSizeConstraints({
    showProjectSidebar: showLeftSidebarForWidthConstraint,
    projectSidebarCollapsed,
    showTodoRail: showRightSidebarForWidthConstraint,
    todoRailCollapsed,
  });

  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 260);
  const searchQuery = useQuery({
    queryKey: queryKeys.search(debouncedSearch, activeProjectId),
    queryFn: () =>
      projectMindApi.workspaceSearch({
        query: debouncedSearch,
        projectId: activeProjectId,
      }),
    enabled: hasWorkspace && debouncedSearch.trim().length > 0,
  });
  const normalizedSearchInput = searchInput.trim();
  const searchQueryIsCurrent = debouncedSearch.trim() === normalizedSearchInput;
  const searchPending =
    normalizedSearchInput.length > 0 &&
    (!searchQueryIsCurrent || searchQuery.isFetching);

  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceRoot, setCreateWorkspaceRoot] = useState("");
  const [createWorkspacePassword, setCreateWorkspacePassword] = useState("");
  const [createWorkspacePending, setCreateWorkspacePending] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<
    string | null
  >(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockPending, setUnlockPending] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const unlockResolverRef = useRef<((value: boolean) => void) | null>(null);
  const [workspaceOverviewRoute, setWorkspaceOverviewRoute] = useState(workspacePath());

  const todayVisible = hasWorkspace;

  const { createProjectMutation, refreshProjectScope } = useProjectMutations(
    visibleProjects,
    (path, options) => navigate(path, options),
  );

  const createProjectQuickly = useCallback(async () => {
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
  }, [createProjectMutation, projectsQuery.data]);

  const applyWorkspaceStatus = useCallback(
    async (snapshot: WorkspaceStatusSnapshot, clearScopedState: boolean) => {
      if (clearScopedState) {
        for (const key of workspaceScopedQueryKeys()) {
          queryClient.removeQueries({ queryKey: key });
        }
        clearWorkspaceScopedUiState();
        resetAiJobSync();
      }
      queryClient.setQueryData(queryKeys.workspaceStatus, snapshot);
      if (!clearScopedState) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStatus }),
          queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings }),
          queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
        ]);
      }
      if (snapshot.currentWorkspace) {
        void ensureAiJobSync();
      }
    },
    [clearWorkspaceScopedUiState, queryClient],
  );

  const closeUnlockDialog = useCallback((unlocked: boolean) => {
    unlockResolverRef.current?.(unlocked);
    unlockResolverRef.current = null;
    setUnlockOpen(false);
    setUnlockPassword("");
    setUnlockError(null);
    setUnlockPending(false);
  }, []);

  const requestUnlockAiSecrets = useCallback(async () => {
    if (!currentWorkspace) {
      return false;
    }
    if (workspaceStatusQuery.data?.aiSecretsUnlocked) {
      return true;
    }

    setUnlockPassword("");
    setUnlockError(null);
    setUnlockOpen(true);

    return new Promise<boolean>((resolve) => {
      unlockResolverRef.current = resolve;
    });
  }, [currentWorkspace, workspaceStatusQuery.data?.aiSecretsUnlocked]);

  const handleUnlockSubmit = useCallback(async () => {
    if (!unlockPassword.trim()) {
      setUnlockError("请输入 workspace 密码。");
      return;
    }

    try {
      setUnlockPending(true);
      const snapshot = await projectMindApi.workspaceUnlock({
        password: unlockPassword,
      });
      await applyWorkspaceStatus(snapshot, false);
      closeUnlockDialog(true);
      setStatus({
        tone: "success",
        label: "Unlocked",
        message: "AI secrets 已解锁",
      });
    } catch (error) {
      setUnlockError(String(error));
      setStatus({
        tone: "error",
        label: "Error",
        message: "解锁 workspace secrets 失败",
      });
    } finally {
      setUnlockPending(false);
    }
  }, [applyWorkspaceStatus, closeUnlockDialog, setStatus, unlockPassword]);

  const openWorkspaceByRoot = useCallback(
    async (rootPath: string) => {
      const snapshot = await projectMindApi.workspaceOpen({ rootPath });
      await applyWorkspaceStatus(snapshot, true);
      setCreateProjectOpen(false);
      navigate(workspacePath(), { replace: true });
      return snapshot;
    },
    [applyWorkspaceStatus, navigate, setCreateProjectOpen],
  );

  const handleOpenExistingWorkspace = useCallback(
    async (presetRootPath?: string) => {
      try {
        const selectedRoot =
          presetRootPath ??
          (await desktopApi.pickDirectory("选择已有 Workspace"));
        if (!selectedRoot || typeof selectedRoot !== "string") {
          return;
        }
        const snapshot = await openWorkspaceByRoot(selectedRoot);
        setStatus({
          tone: "success",
          label: "Opened",
          message: `已打开 ${snapshot.currentWorkspace?.displayName ?? "workspace"}`,
        });
      } catch (error) {
        const detail = String(error);
        setStatus({
          tone: "error",
          label: "Error",
          message: "打开 workspace 失败",
        });
        pushToast({ tone: "error", title: "打开 workspace 失败", detail });
      }
    },
    [openWorkspaceByRoot, pushToast, setStatus],
  );

  const handlePickCreateWorkspaceRoot = useCallback(async () => {
    const selected =
      await desktopApi.pickDirectory("选择新 Workspace 的根目录");
    if (typeof selected === "string") {
      setCreateWorkspaceRoot(selected);
    }
  }, []);

  const saveActiveProjectFocusRecord = useCallback(async () => {
    if (
      activeRecordId === null ||
      activeProjectId === null ||
      !/^\/projects\/\d+\/records\/\d+$/u.test(location.pathname)
    ) {
      return true;
    }

    const saveResult = await requestProjectRecordFocusSave({
      projectId: activeProjectId,
      noteId: activeRecordId,
    });

    return saveResult === "saved";
  }, [activeProjectId, activeRecordId, location.pathname]);

  const handleCreateWorkspace = useCallback(async () => {
    if (!createWorkspaceRoot.trim()) {
      setCreateWorkspaceError("请选择 workspace 根目录。");
      return;
    }
    if (!createWorkspacePassword.trim()) {
      setCreateWorkspaceError("请输入 workspace 密码。");
      return;
    }

    try {
      setCreateWorkspacePending(true);
      setCreateWorkspaceError(null);
      const snapshot = await projectMindApi.workspaceCreate({
        rootPath: createWorkspaceRoot.trim(),
        password: createWorkspacePassword,
      });
      await applyWorkspaceStatus(snapshot, true);
      setCreateWorkspaceOpen(false);
      setCreateWorkspaceRoot("");
      setCreateWorkspacePassword("");
      navigate(workspacePath(), { replace: true });
      setStatus({
        tone: "success",
        label: "Created",
        message: `已创建 ${snapshot.currentWorkspace?.displayName ?? "workspace"}`,
      });
    } catch (error) {
      const detail = String(error);
      setCreateWorkspaceError(detail);
      setStatus({
        tone: "error",
        label: "Error",
        message: "创建 workspace 失败",
      });
      pushToast({ tone: "error", title: "创建 workspace 失败", detail });
    } finally {
      setCreateWorkspacePending(false);
    }
  }, [
    applyWorkspaceStatus,
    createWorkspacePassword,
    createWorkspaceRoot,
    navigate,
    pushToast,
    setStatus,
  ]);

  const resolveProjectNavigationPath = useCallback(
    (projectId: number) =>
      projectRecentPaths[projectId] ?? projectPath(projectId),
    [projectRecentPaths],
  );

  const openProjectInTab = useCallback(
    async (projectId: number) => {
      if (!(await saveActiveProjectFocusRecord())) {
        return;
      }

      if (!projectWindow) {
        const focused = await desktopApi.focusProjectWindow(projectId);
        if (focused) {
          return;
        }
      }

      openProjectTab(projectId);
      navigate(resolveProjectNavigationPath(projectId));
    },
    [
      navigate,
      openProjectTab,
      projectWindow,
      resolveProjectNavigationPath,
      saveActiveProjectFocusRecord,
    ],
  );

  const prefetchProject = useCallback(
    (projectId: number) => {
      void Promise.all([
        queryClient.prefetchQuery({
          queryKey: queryKeys.projectPage(projectId),
          queryFn: () => projectMindApi.projectPageGet({ projectId }),
        }),
        queryClient.prefetchQuery({
          queryKey: queryKeys.projectTags.project(projectId),
          queryFn: () => projectMindApi.projectTagSettingsGet({ projectId }),
        }),
      ]);
    },
    [queryClient],
  );

  const openProjectInNewWindow = useCallback(
    async (projectId: number, routeOverride?: string) => {
      const project = visibleProjects.find((item) => item.id === projectId);
      if (!project) {
        return;
      }

      const route =
        routeOverride ??
        (activeProjectId === projectId
          ? `${location.pathname}${location.search}`
          : resolveProjectNavigationPath(projectId));

      try {
        await desktopApi.openProjectWindow({
          projectId,
          projectName: project.name,
          route,
        });
      } catch (error) {
        pushToast({
          tone: "error",
          title: "打开项目新窗口失败",
          detail: String(error),
        });
        throw error;
      }
    },
    [
      activeProjectId,
      location.pathname,
      location.search,
      pushToast,
      resolveProjectNavigationPath,
      visibleProjects,
    ],
  );

  const detachProjectToNewWindow = useCallback(
    async (projectId: number) => {
      if (activeProjectId === projectId && !(await saveActiveProjectFocusRecord())) {
        return;
      }

      const route =
        activeProjectId === projectId
          ? `${location.pathname}${location.search}`
          : resolveProjectNavigationPath(projectId);

      try {
        await openProjectInNewWindow(projectId, route);
      } catch {
        return;
      }
      closeProjectTab(projectId);

      if (activeProjectId === projectId) {
        navigate(workspacePath());
      }
    },
    [
      activeProjectId,
      closeProjectTab,
      location.pathname,
      location.search,
      navigate,
      openProjectInNewWindow,
      resolveProjectNavigationPath,
      saveActiveProjectFocusRecord,
    ],
  );

  const closeProjectTabAndMaybeNavigate = useCallback(
    async (projectId: number) => {
      if (activeProjectId === projectId && !(await saveActiveProjectFocusRecord())) {
        return;
      }
      closeProjectTab(projectId);
      if (activeProjectId === projectId) {
        navigate(workspacePath());
      }
    },
    [activeProjectId, closeProjectTab, navigate, saveActiveProjectFocusRecord],
  );

  const updateProjectRecordFilters = useCallback(
    (updates: { query?: string; tagId?: number | null }) => {
      const nextSearchParams = new URLSearchParams(location.search);

      if (updates.query !== undefined) {
        const nextQuery = updates.query.trim();
        if (nextQuery) {
          nextSearchParams.set("recordQuery", updates.query);
        } else {
          nextSearchParams.delete("recordQuery");
        }
      }

      if (updates.tagId !== undefined) {
        if (updates.tagId === null) {
          nextSearchParams.delete("recordTag");
        } else {
          nextSearchParams.set("recordTag", String(updates.tagId));
        }
      }

      const nextSearch = nextSearchParams.toString();
      navigate(
        {
          pathname: location.pathname,
          search: nextSearch ? `?${nextSearch}` : "",
        },
        { replace: true },
      );
    },
    [location.pathname, location.search, navigate],
  );

  const renameProjectSidebarRecord = useCallback(
    async (record: ProjectSidebarRecordItem, title: string) => {
      const projectId = record.projectId ?? activeProjectId;
      if (projectId === null) {
        return;
      }

      await projectMindApi.projectRecordUpsert({
        projectId,
        activityId: record.activityId ?? undefined,
        noteId: record.id,
        title: title.trim() || undefined,
        markdown: record.contentMarkdown,
        html: record.contentHtml ?? "",
        defaultCodeLanguage: record.defaultCodeLanguage ?? null,
        tagIds: record.tags.map((tag) => tag.id),
      });
      await refreshProjectScope(queryClient, projectId);
    },
    [activeProjectId, queryClient, refreshProjectScope],
  );

  const createProjectSidebarRecord = useCallback(async () => {
    if (activeProjectId === null) {
      return;
    }
    if (!(await saveActiveProjectFocusRecord())) {
      return;
    }

    const record = await projectMindApi.projectRecordUpsert({
      projectId: activeProjectId,
      markdown: "",
      html: "<p></p>",
      defaultCodeLanguage: null,
      tagIds: [],
    });
    await refreshProjectScope(queryClient, activeProjectId);
    navigate(preserveRecordFilters(recordPath(activeProjectId, record.id), location.search));
  }, [activeProjectId, location.search, navigate, queryClient, refreshProjectScope, saveActiveProjectFocusRecord]);

  const deleteProjectSidebarRecord = useCallback(
    async (record: ProjectSidebarRecordItem) => {
      const projectId = record.projectId ?? activeProjectId;
      if (projectId === null) {
        return;
      }

      await projectMindApi.projectRecordDelete({ noteId: record.id });
      await refreshProjectScope(queryClient, projectId);
      if (activeRecordId === record.id) {
        navigate(projectPath(projectId));
      }
    },
    [activeProjectId, activeRecordId, navigate, queryClient, refreshProjectScope],
  );

  const handleSearchSelect = useCallback(
    async (result: WorkspaceSearchResult) => {
      setSearchInput("");
      if (result.kind === "project") {
        await openProjectInTab(result.projectId);
      } else if (result.kind === "contact") {
        openSettings("contacts", activeProjectId);
      } else if (
        result.kind === "workspace_quick_note" ||
        result.kind === "workspace_note" ||
        (result.kind === "todo" && result.scope === "workspace")
      ) {
        const route = workspaceSearchResultRoute(result);
        if (route && (await saveActiveProjectFocusRecord())) {
          if (result.kind === "todo") {
            setTodoRailCollapsed(false);
          }
          navigate(route);
        }
      } else if (result.projectId !== null) {
        const route = workspaceSearchResultRoute(result);
        if (route && (await saveActiveProjectFocusRecord())) {
          if (result.kind === "todo") {
            setTodoRailCollapsed(false);
          }
          openProjectTab(result.projectId);
          navigate(route);
        }
      }
    },
    [
      activeProjectId,
      navigate,
      openProjectInTab,
      openProjectTab,
      openSettings,
      saveActiveProjectFocusRecord,
      setTodoRailCollapsed,
    ],
  );

  const shouldShowEmpty =
    hasWorkspace &&
    !projectsQuery.isLoading &&
    visibleProjects.length === 0 &&
    !activeProjectId &&
    !workspaceActive;
  const projectOverviewActive =
    cacheProjectOverviewPages &&
    isProjectOverviewPath(location.pathname, activeProjectId);
  const workspaceOverviewActive =
    cacheProjectOverviewPages && location.pathname === workspacePath();

  useEffect(() => {
    if (!hasWorkspace) {
      setStatus({
        tone: "neutral",
        label: "Workspace",
        message: "选择或创建一个 workspace 后继续使用",
      });
      return;
    }

    if (!projectsQuery.isLoading) {
      setStatus({
        tone: "neutral",
        label: "Ready",
        message:
          visibleProjects.length > 0
            ? "当前 workspace 已就绪，可继续记录与整理"
            : "workspace 已打开，需要时再创建项目",
      });
    }
  }, [
    hasWorkspace,
    projectsQuery.isLoading,
    setStatus,
    visibleProjects.length,
  ]);

  useEffect(() => {
    if (activeProjectId !== null) {
      openProjectTab(activeProjectId);
    }
  }, [activeProjectId, openProjectTab]);

  const residentProjectOverviewIds = useResidentProjectPages({
    activeProjectId,
    enabled: cacheProjectOverviewPages,
    hasWorkspace,
    openProjectIds,
  });
  const workspaceOverviewResident = useResidentWorkspacePage({
    active: workspaceOverviewActive,
    enabled: cacheProjectOverviewPages,
    workspaceKey: currentWorkspace?.rootPath ?? null,
  });

  useEffect(() => {
    if (!hasWorkspace || !cacheProjectOverviewPages) {
      setWorkspaceOverviewRoute(workspacePath());
      return;
    }

    if (!workspaceOverviewActive) {
      return;
    }

    setWorkspaceOverviewRoute(`${location.pathname}${location.search}`);
  }, [
    cacheProjectOverviewPages,
    hasWorkspace,
    location.pathname,
    location.search,
    workspaceOverviewActive,
  ]);

  useEffect(() => {
    if (
      activeProjectId === null ||
      !location.pathname.startsWith(`/projects/${activeProjectId}`)
    ) {
      return;
    }

    rememberProjectRoute(
      activeProjectId,
      `${location.pathname}${location.search}`,
    );
  }, [
    activeProjectId,
    location.pathname,
    location.search,
    rememberProjectRoute,
  ]);

  useEffect(() => {
    if (!projectWindow || currentProjectWindowId === null) {
      return;
    }

    if (activeProjectId === currentProjectWindowId) {
      return;
    }

    navigate(projectPath(currentProjectWindowId), { replace: true });
  }, [activeProjectId, currentProjectWindowId, navigate, projectWindow]);

  useEffect(() => {
    if (!projectWindow) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenToProjectWindowNavigation((route) => {
      void (async () => {
        if (!disposed && (await saveActiveProjectFocusRecord())) {
          navigate(route);
        }
      })();
    })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten?.();
          return;
        }

        unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate, projectWindow, saveActiveProjectFocusRecord]);

  useEffect(() => {
    if (typeof document === "undefined" || !hasWorkspace) {
      return;
    }

    applyRichTextStyleVariables(
      document.documentElement,
      richTextStyleQuery.data ?? DEFAULT_RICH_TEXT_STYLE_SETTINGS,
    );
  }, [hasWorkspace, richTextStyleQuery.data]);

  useEffect(() => {
    if (!hasWorkspace) {
      return;
    }

    void ensureAiJobSync();
  }, [hasWorkspace]);

  useEffect(() => {
    return () => {
      unlockResolverRef.current?.(false);
      unlockResolverRef.current = null;
    };
  }, []);

  if (!currentWorkspace) {
    return (
      <>
        <WorkspaceGatePage
          loading={workspaceStatusQuery.isLoading}
          recentWorkspaces={workspaceStatusQuery.data?.recentWorkspaces ?? []}
          onOpenExisting={() => void handleOpenExistingWorkspace()}
          onCreateWorkspace={() => {
            setCreateWorkspaceError(null);
            setCreateWorkspaceOpen(true);
          }}
          onOpenRecent={(rootPath) =>
            void handleOpenExistingWorkspace(rootPath)
          }
        />

        <CreateWorkspaceDialog
          open={createWorkspaceOpen}
          rootPath={createWorkspaceRoot}
          password={createWorkspacePassword}
          pending={createWorkspacePending}
          error={createWorkspaceError}
          onRootPathChange={setCreateWorkspaceRoot}
          onPasswordChange={setCreateWorkspacePassword}
          onPickRoot={() => void handlePickCreateWorkspaceRoot()}
          onClose={() => setCreateWorkspaceOpen(false)}
          onSubmit={() => void handleCreateWorkspace()}
        />

        <UnlockWorkspaceSecretsDialog
          open={unlockOpen}
          pending={unlockPending}
          error={unlockError}
          password={unlockPassword}
          onPasswordChange={setUnlockPassword}
          onClose={() => closeUnlockDialog(false)}
          onSubmit={() => void handleUnlockSubmit()}
        />
      </>
    );
  }

  const workspaceTopBar = (
    <WorkspaceTopBar
      projects={openedProjects}
      activeProjectId={activeProjectId}
      todayActive={workspaceActive}
      showToday={todayVisible}
      settingsActive={settingsOpen}
      searchInput={searchInput}
      onSearchInput={setSearchInput}
      searchResults={searchQueryIsCurrent ? (searchQuery.data ?? []) : []}
      searching={searchPending}
      searchError={searchQueryIsCurrent && searchQuery.isError}
      onOpenProject={(projectId) => {
        void openProjectInTab(projectId);
      }}
      onPrefetchProject={prefetchProject}
      onCloseProject={(projectId) => {
        void closeProjectTabAndMaybeNavigate(projectId);
      }}
      onOpenToday={() => {
        void (async () => {
          if (await saveActiveProjectFocusRecord()) {
            navigate(workspacePath());
          }
        })();
      }}
      onOpenSettings={() => openSettings("project-tags", activeProjectId)}
      onSearchSelect={handleSearchSelect}
      onDetachProject={(projectId) => {
        void detachProjectToNewWindow(projectId);
      }}
    />
  );
  const mainContent = shouldShowEmpty ? (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <EmptyState
        title="Project Mind"
        text="当前还没有项目。需要开始整理时再创建即可，后续活动、结论、待办和文件都会围绕项目组织。"
        icon={<FolderKanban size={18} />}
        action={
          <Button
            type="button"
            variant="primary"
            disabled={createProjectMutation.isPending}
            onClick={() => {
              void createProjectQuickly();
            }}
          >
            {createProjectMutation.isPending ? "创建中..." : "创建项目"}
          </Button>
        }
        className="w-full max-w-xl"
      />
    </div>
  ) : (
    <Outlet />
  );
  const cachedWorkspaceOverviewPage =
    cacheProjectOverviewPages &&
    hasWorkspace &&
    (workspaceOverviewActive || workspaceOverviewResident) ? (
      <div
        className="h-full min-h-0"
        style={{ display: workspaceOverviewActive ? undefined : "none" }}
        aria-hidden={workspaceOverviewActive ? undefined : true}
        inert={!workspaceOverviewActive}
      >
        <WorkspacePage
          key={currentWorkspace.rootPath}
          activeProjectIdOverride={null}
          searchParamsOverride={getWorkspaceOverviewSearchParams(
            workspaceOverviewActive
              ? `${location.pathname}${location.search}`
              : workspaceOverviewRoute,
          )}
          visible={workspaceOverviewActive}
          onSearchParamsOverride={(nextSearchParams, options) => {
            const nextRoute = buildWorkspaceOverviewRoute(nextSearchParams);
            setWorkspaceOverviewRoute(nextRoute);

            if (workspaceOverviewActive) {
              navigate(nextRoute, options);
            }
          }}
        />
      </div>
    ) : null;
  const cachedProjectOverviewPages =
    cacheProjectOverviewPages && hasWorkspace && openedProjects.length > 0 ? (
      <>
        {openedProjects.map((project) => {
          const active = projectOverviewActive && activeProjectId === project.id;
          const resident =
            active || residentProjectOverviewIds.includes(project.id);

          if (!resident) {
            return null;
          }

          const route = active
            ? `${location.pathname}${location.search}`
            : (projectRecentPaths[project.id] ?? projectPath(project.id));
          const cachedSearchParams = getProjectOverviewSearchParams(route);

          return (
            <div
              key={project.id}
              className="h-full min-h-0"
              style={{ display: active ? undefined : "none" }}
              aria-hidden={active ? undefined : true}
              inert={!active}
            >
              <ProjectOverviewPage
                projectIdOverride={project.id}
                searchParamsOverride={cachedSearchParams}
                visible={active}
                onSearchParamsOverride={(nextSearchParams, options) => {
                  const nextRoute = buildProjectOverviewRoute(
                    project.id,
                    nextSearchParams,
                  );
                  rememberProjectRoute(project.id, nextRoute);

                  if (active) {
                    navigate(nextRoute, options);
                  }
                }}
              />
            </div>
          );
        })}
      </>
    ) : null;
  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-bg-subtle">
      {projectWindow ? null : workspaceTopBar}

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {showProjectSidebarShell ? (
          <ProjectSidebar
            project={{
              id: activeProject.id,
              name: activeProject.name,
              kind: activeProject.kind,
              rootPath: activeProject.rootPath,
              isArchived: activeProject.isArchived,
            }}
            records={projectSidebarRecords}
            documents={projectSidebarDocuments}
            activeRecordId={activeRecordId}
            recordQuery={projectRecordQuery}
            onRecordQueryChange={(value) => updateProjectRecordFilters({ query: value })}
            activeRecordTagId={projectRecordTagId}
            onActiveRecordTagIdChange={(tagId) => updateProjectRecordFilters({ tagId })}
            onOpenProject={() => {
              void (async () => {
                if (await saveActiveProjectFocusRecord()) {
                  navigate(
                    preserveRecordFilters(projectPath(activeProject.id), location.search),
                  );
                }
              })();
            }}
            onCreateRecord={() => {
              void createProjectSidebarRecord();
            }}
            onOpenRecord={(recordId) => {
              void (async () => {
                const isProjectRecordFocusPage =
                  /^\/projects\/\d+\/records\/\d+$/u.test(location.pathname);

                if (
                  activeRecordId !== null &&
                  activeRecordId !== recordId &&
                  activeProjectId === activeProject.id
                ) {
                  const saved = await saveActiveProjectFocusRecord();
                  if (!saved) {
                    return;
                  }
                }

                navigate(
                  preserveRecordFilters(
                    isProjectRecordFocusPage
                      ? recordPath(activeProject.id, recordId)
                      : projectPath(activeProject.id, recordFocusId(recordId)),
                    location.search,
                  ),
                );
              })();
            }}
            onFocusRecord={(recordId) => {
              void (async () => {
                if (
                  activeRecordId !== null &&
                  activeRecordId !== recordId &&
                  activeProjectId === activeProject.id
                ) {
                  const saved = await saveActiveProjectFocusRecord();
                  if (!saved) {
                    return;
                  }
                }

                navigate(
                  preserveRecordFilters(recordPath(activeProject.id, recordId), location.search),
                );
              })();
            }}
            onRenameRecord={renameProjectSidebarRecord}
            onDeleteRecord={deleteProjectSidebarRecord}
            onOpenDocument={(document) => {
              void desktopApi.openFile(document.managedPath).catch((error) => {
                pushToast({
                  tone: "error",
                  title: "打开文件失败",
                  detail: String(error),
                });
              });
            }}
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <main className="min-h-0 flex-1 overflow-hidden">
            {cachedWorkspaceOverviewPage}
            {cachedProjectOverviewPages}
            {projectOverviewActive || workspaceOverviewActive ? null : mainContent}
          </main>

          <StatusBar
            context={
              workspaceActive
                ? "Workspace"
                : activeProjectId !== null
                  ? (activeProject?.name ?? null)
                  : currentWorkspace.displayName
            }
            detail={`${visibleProjects.length} projects`}
          />
        </div>
      </div>
      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        rootPath={createWorkspaceRoot}
        password={createWorkspacePassword}
        pending={createWorkspacePending}
        error={createWorkspaceError}
        onRootPathChange={setCreateWorkspaceRoot}
        onPasswordChange={setCreateWorkspacePassword}
        onPickRoot={() => void handlePickCreateWorkspaceRoot()}
        onClose={() => setCreateWorkspaceOpen(false)}
        onSubmit={() => void handleCreateWorkspace()}
      />

      <UnlockWorkspaceSecretsDialog
        open={unlockOpen}
        pending={unlockPending}
        error={unlockError}
        password={unlockPassword}
        onPasswordChange={setUnlockPassword}
        onClose={() => closeUnlockDialog(false)}
        onSubmit={() => void handleUnlockSubmit()}
      />

      <SettingsDialog
        open={settingsOpen}
        activeSection={settingsSection}
        projectId={settingsProjectId}
        onSectionChange={setSettingsSection}
        onUnlockAiSecrets={requestUnlockAiSecrets}
        onClose={closeSettings}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default WorkspaceLayout;

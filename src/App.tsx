import { isDebugBuild } from "./lib/build-mode";
import { ProjectContentWorkspace, projectContentTabRoute } from "./components/project/ProjectContentWorkspace";
import { openProjectContent, PROJECT_CONTENT_OPEN_EVENT, type ProjectContentOpenResult } from "./services/projectContentApi";
import { prepareProjectContentClose, prepareWorkspaceContentClose } from "./lib/project-content-lifecycle";
import { useFilePreviewStore } from "./state/file-preview-store";
import { AgentWorkspacePanel } from "./components/agent/AgentWorkspacePanel";
import { setDshWorkspaceRoot, showDshBusyFeedback } from "./lib/dsh-host-events";
import { useAgentPanelStore } from "./state/agent-panel-store";
import { useSidebarTextFade } from "./hooks/useSidebarTextFade";
import { useWorkspaceBusinessChanges } from "./hooks/useWorkspaceBusinessChanges";
import { useSourceMaintenanceSelection } from "./hooks/useSourceMaintenanceSelection";
import { HomeWorkspaceActionsContext } from "./components/home/HomeWorkspaceIdentity";
import { flushQuickNotes } from "./lib/quick-note-transfer";
import { cancelAllQuickNoteRecordMetadata, cancelQuickNoteRecordMetadata } from "./lib/quick-note-auto-metadata";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { Outlet, useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import type { BlockerFunction } from "react-router-dom";

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
import {
  requestProjectRecordFocusSave,
  requestWorkspaceRecordFocusSave,
  canLeaveRecordFocus,
} from "./lib/record-focus-save";
import { parseRecordFocusRoute } from "./lib/record-focus-route";
import type { RecordSaveCoordinator } from "./lib/record-save-coordinator";
import {
  createRecordSaveCoordinator,
  RecordSaveCoordinatorProvider,
  useRecordSaveStatus,
} from "./lib/record-save-runtime";
import { queryKeys } from "./lib/queryKeys";
import { prefetchProjectPageData } from "./lib/project-prefetch";
import { scheduleRecordFocusPageModulesPreload } from "./routes/record-focus-modules";
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
import { useResidentProjectShells } from "./hooks/useResidentProjectShells";
import { RESIDENT_PROJECT_QUERY_OPTIONS } from "./lib/resident-pages";
import { useResidentWorkspacePage } from "./hooks/useResidentWorkspacePage";
import { createTodoModule, productionTodoTransport } from "./todo/todo-module";
import {
  ProjectSidebar,
  type ProjectSidebarDocumentItem,
  type ProjectSidebarRecordItem,
} from "./components/layout/ProjectSidebar";
import { WorkspaceTopBar } from "./components/layout/WorkspaceTopBar";
import { ProjectFilePreviewLayer } from "./components/home/ProjectFilePreviewLayer";
import { ToastStack } from "./components/layout/ToastStack";
import { VoiceFloatingPanel } from "./components/voice/VoiceFloatingPanel";
import { ProjectOverviewPage } from "./components/project/ProjectOverviewPage";
import { rememberProjectRecord } from "./components/home/project-record-history";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { WorkspacePage } from "./components/workspace/WorkspacePage";
import { WorkspaceGatePage } from "./components/workspace/WorkspaceGatePage";
import { clearAllTodoComposerDrafts } from "./components/todo/todo-draft-storage";
import {
  CreateWorkspaceDialog,
  UnlockWorkspaceSecretsDialog,
} from "./components/workspace/WorkspaceDialogs";
import { Button, EmptyState } from "./ui/components";
import {
  RecordFocusResidencyProvider,
  RecordFocusResidentPages,
} from "./components/record/RecordFocusResidentPages";

const HomeProjectSidebar = lazy(() => import("./components/home/HomeProjectSidebar").then(module => ({ default: module.HomeProjectSidebar })));

function toProjectSidebarRecords(
  records: NoteRecord[],
): ProjectSidebarRecordItem[] {
  return records.map((record) => ({
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    typeLabel: "记录",
    contentMarkdown: record.contentMarkdown,
    isVoice: record.isVoice,
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
    case "note":
      return recordPath(result.projectId, result.id);
    case "todo":
      return result.scope === "workspace"
        ? `${workspacePath()}?focus=todo-${result.id}`
        : projectPath(result.projectId, `todo-${result.id}`);
    case "document":
      return projectPath(result.projectId);
  }
}

export function WorkspaceLayout({
  cacheProjectOverviewPages = false,
  recordSaveCoordinator: injectedRecordSaveCoordinator,
}: {
  cacheProjectOverviewPages?: boolean;
  recordSaveCoordinator?: RecordSaveCoordinator;
}) {
  useSidebarTextFade();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const queryClient = useQueryClient();
  const todoModule = useMemo(
    () => createTodoModule({ queryClient, transport: productionTodoTransport }),
    [queryClient],
  );
  const projectWindow = isProjectWindow();
  const currentWindowLabel = getCurrentWindowLabel();
  const currentProjectWindowId = parseProjectWindowProjectId(currentWindowLabel);
  const activeProjectId = parseRouteId(params.projectId);
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const activeRecordId =
    parseRouteId(params.noteId) ??
    parseFocusRecordId(new URLSearchParams(location.search).get("focus"));
  const activeRecordFocusRoute = useMemo(
    () => parseRecordFocusRoute(location.pathname),
    [location.pathname],
  );
  useEffect(() => {
    if (activeRecordFocusRoute) cancelQuickNoteRecordMetadata(activeRecordFocusRoute.recordId,
      activeRecordFocusRoute.kind === "project" ? activeRecordFocusRoute.projectId : undefined);
  }, [activeRecordFocusRoute]);
  const skipFocusSaveRouteRef = useRef<string | null>(null);
  const submitActiveFocusRecord = useCallback(() => {
    const route = activeRecordFocusRoute;
    if (!route) return true;
    const saveResult = route.kind === "project"
      ? requestProjectRecordFocusSave({
          projectId: route.projectId,
          recordId: route.recordId,
        })
      : requestWorkspaceRecordFocusSave({ recordId: route.recordId });
    return canLeaveRecordFocus(saveResult);
  }, [activeRecordFocusRoute]);
  const routeSaveBlocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) => {
        const route = parseRecordFocusRoute(currentLocation.pathname);
        if (
          !route ||
          (currentLocation.pathname === nextLocation.pathname &&
            currentLocation.search === nextLocation.search)
        ) {
          return false;
        }
        const currentRoute = `${currentLocation.pathname}${currentLocation.search}`;
        if (skipFocusSaveRouteRef.current === currentRoute) {
          skipFocusSaveRouteRef.current = null;
          return false;
        }
        const result = route.kind === "project"
          ? requestProjectRecordFocusSave({
              projectId: route.projectId,
              recordId: route.recordId,
            })
          : requestWorkspaceRecordFocusSave({ recordId: route.recordId });
        return !canLeaveRecordFocus(result);
      },
      [],
    ),
  );
  const workspaceActive =
    location.pathname === workspacePath() ||
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
    openSettings,
    closeSettings,
    openProjectIds,
    openProjectTab,
    closeProjectTab,
    setSettingsSection,
    projectRecentPaths,
    projectSidebarCollapsed,
    projectSidebarWidthPx,
    setProjectSidebarCollapsed,
    setProjectSidebarTab,
    setCreateProjectOpen,
    rememberProjectRoute,
    clearWorkspaceScopedUiState,
    todoRailCollapsed,
    todoRailWidthPx,
    setTodoRailCollapsed,
  } = useUiStore();
  const { toasts, dismissToast, pushToast, setStatus } = useFeedbackStore();

  useEffect(() => {
    if (routeSaveBlocker.state !== "blocked") {
      return;
    }
    setStatus({
      tone: "error",
      label: "Save failed",
      message: "无法捕获当前 Project Record，导航已取消",
    });
    routeSaveBlocker.reset();
  }, [routeSaveBlocker, setStatus]);

  const workspaceStatusQuery = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
  });
  const currentWorkspace = workspaceStatusQuery.data?.currentWorkspace ?? null;
  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<ProjectContentOpenResult>).detail;
      if (!request || request.workspaceRoot !== currentWorkspace?.rootPath) return;
      openProjectTab(request.scope.projectId);
      navigate(projectContentTabRoute(request.scope.projectId, { id: request.tabId, object: request.object, view: request.view ?? {} }));
    };
    window.addEventListener(PROJECT_CONTENT_OPEN_EVENT, open);
    return () => window.removeEventListener(PROJECT_CONTENT_OPEN_EVENT, open);
  }, [currentWorkspace?.rootPath, navigate, openProjectTab]);
  useEffect(() => { setDshWorkspaceRoot(currentWorkspace?.rootPath ?? null); }, [currentWorkspace?.rootPath]);
  const agentPanelBinding = useAgentPanelStore(state => state.binding);
  const agentPanelOpen = useAgentPanelStore(state => state.open);
  const agentPanelExpanded = useAgentPanelStore(state => state.expanded);
  const agentPanelVisible = agentPanelOpen && agentPanelBinding?.workspaceRoot === currentWorkspace?.rootPath
    && activeProjectId !== null && agentPanelBinding?.scope.kind === "project" && agentPanelBinding.scope.projectId === activeProjectId;
  const filePreviewRequest = useFilePreviewStore(state => state.request);
  useEffect(() => {
    if (!filePreviewRequest || filePreviewRequest.workspaceRoot !== currentWorkspace?.rootPath) return;
    const controller = new AbortController();
    void openProjectContent({ workspaceRoot: filePreviewRequest.workspaceRoot, projectId: filePreviewRequest.projectId,
      object: { kind: "file", id: filePreviewRequest.documentId, title: filePreviewRequest.title },
      ...(filePreviewRequest.versionNumber !== undefined ? { view: { versionNumber: filePreviewRequest.versionNumber } } : {}), signal: controller.signal,
    }).then(() => useFilePreviewStore.getState().closePreview(), reason => {
      if (!controller.signal.aborted) {
        useFilePreviewStore.getState().closePreview();
        pushToast({ tone: "error", title: "无法打开文件", detail: String(reason) });
      }
    });
    return () => controller.abort();
  }, [filePreviewRequest, currentWorkspace?.rootPath, pushToast]);
  const previousPreviewNavigation = useRef(location.key);
  useEffect(() => {
    if (previousPreviewNavigation.current === location.key) return;
    previousPreviewNavigation.current = location.key;
    useFilePreviewStore.getState().closePreview();
  }, [location.key]);
  useEffect(() => {
    if (!currentWorkspace && filePreviewRequest) useFilePreviewStore.getState().closePreview();
  }, [currentWorkspace, filePreviewRequest]);
  useEffect(() => {
    if (!currentWorkspace && agentPanelBinding) useAgentPanelStore.getState().clearWorkspace();
  }, [currentWorkspace, agentPanelBinding]);
  const businessChangeError = useWorkspaceBusinessChanges(currentWorkspace?.rootPath);
  useSourceMaintenanceSelection(currentWorkspace?.rootPath, activeProjectId);
  useEffect(() => {
    if (businessChangeError) setStatus({ tone: "error", label: "Refresh failed", message: "工作区变更同步失败，重新切回窗口后会重试" });
  }, [businessChangeError, setStatus]);
  useEffect(() => () => cancelAllQuickNoteRecordMetadata(), [currentWorkspace?.rootPath]);
  useEffect(() => {
    if (currentWorkspace && activeProjectId && activeRecordId) {
      rememberProjectRecord(currentWorkspace.rootPath, activeProjectId, activeRecordId);
    }
  }, [currentWorkspace?.rootPath, activeProjectId, activeRecordId]);
  const hasWorkspace = Boolean(currentWorkspace);
  const internalRecordSaveCoordinator = useMemo(
    () =>
      createRecordSaveCoordinator({
        workspaceKey: currentWorkspace?.rootPath ?? "workspace:unavailable",
        queryClient,
      }),
    [currentWorkspace?.rootPath, queryClient],
  );
  const recordSaveCoordinator =
    injectedRecordSaveCoordinator ?? internalRecordSaveCoordinator;
  const recordSaveStatus = useRecordSaveStatus(recordSaveCoordinator);
  const flushRecordSaves = useCallback(async () => {
    if (currentWorkspace) await prepareWorkspaceContentClose(currentWorkspace.rootPath);
    if (!submitActiveFocusRecord()) {
      throw new Error("无法捕获当前 Record 的 Committed Content");
    }
    await recordSaveCoordinator.flush();
    await flushQuickNotes();
  }, [recordSaveCoordinator, submitActiveFocusRecord, currentWorkspace?.rootPath]);

  useEffect(() => {
    if (!hasWorkspace) {
      return;
    }

    return scheduleRecordFocusPageModulesPreload(window);
  }, [hasWorkspace]);

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
  const residentProjectIds = useResidentProjectShells({
    activeProjectId,
    enabled: cacheProjectOverviewPages,
    hasWorkspace,
    openProjectIds,
  });
  const projectSidebarOverviewQuery = useQuery({
    queryKey: queryKeys.projectPage(activeProjectId),
    queryFn: () => projectMindApi.projectPageGet({ projectId: activeProjectId as number }),
    enabled: hasWorkspace && activeProjectId !== null,
    ...(cacheProjectOverviewPages || activeRecordFocusRoute?.kind === "project"
      ? RESIDENT_PROJECT_QUERY_OPTIONS
      : {}),
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
    !location.pathname.endsWith("/summary");
  const showLeftSidebarForWidthConstraint = workspaceActive || showProjectSidebarShell;
  const showRightSidebarForWidthConstraint = workspaceActive || showTodoRailShell;

  useWorkspaceWindowSizeConstraints({
    overlayHomePanels: location.pathname === workspacePath() || isProjectOverviewPath(location.pathname, activeProjectId) || activeRecordFocusRoute !== null,
    showProjectSidebar: showLeftSidebarForWidthConstraint,
    projectSidebarCollapsed,
    projectSidebarWidthPx,
    showTodoRail: showRightSidebarForWidthConstraint,
    todoRailCollapsed,
    todoRailWidthPx,
    setProjectSidebarCollapsed,
    setTodoRailCollapsed,
  });

  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 260);
  const searchQuery = useQuery({
    queryKey: queryKeys.search(debouncedSearch),
    queryFn: () =>
      projectMindApi.workspaceSearch({
        query: debouncedSearch,
      }),
    enabled: hasWorkspace && debouncedSearch.trim().length > 0,
    refetchInterval: 5_000,
  });
  const normalizedSearchInput = searchInput.trim();
  const searchQueryIsCurrent = debouncedSearch.trim() === normalizedSearchInput;
  const searchPending =
    normalizedSearchInput.length > 0 &&
    (!searchQueryIsCurrent || searchQuery.isFetching);
  const currentSearchResults = useMemo(
    () =>
      searchQueryIsCurrent
        ? (searchQuery.data ?? [])
        : [],
    [searchQuery.data, searchQueryIsCurrent],
  );

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
  const previousRecordSavePhaseRef = useRef(recordSaveStatus.phase);
  const reportedRecordSaveErrorRef = useRef<unknown>(null);
  const projectRecordCreationRef = useRef<import("./lib/canonical-record-creation").CanonicalRecordCreation | null>(null);
  const [workspaceOverviewRoute, setWorkspaceOverviewRoute] = useState(workspacePath());

  const workspaceVisible = hasWorkspace;

  const { createProjectMutation, refreshProjectScope } = useProjectMutations(
    (path, options) => navigate(path, options),
    activeProjectId,
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
        for (const key of queryKeys.workspaceScoped) {
          queryClient.removeQueries({ queryKey: key });
        }
        clearWorkspaceScopedUiState();
        clearAllTodoComposerDrafts();
        resetAiJobSync();
        setSearchInput("");
        setWorkspaceOverviewRoute(workspacePath());
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
      if (useAgentPanelStore.getState().runningBinding) {
        showDshBusyFeedback();
        return null;
      }
      if (!(await desktopApi.prepareVoiceLeave())) return null;
      await flushRecordSaves();
      if (useAgentPanelStore.getState().runningBinding) {
        showDshBusyFeedback();
        return null;
      }
      const snapshot = await projectMindApi.workspaceOpen({ rootPath });
      await applyWorkspaceStatus(snapshot, true);
      setCreateProjectOpen(false);
      skipFocusSaveRouteRef.current = `${location.pathname}${location.search}`;
      navigate(workspacePath(), { replace: true });
      return snapshot;
    },
    [
      applyWorkspaceStatus,
      navigate,
      flushRecordSaves,
      location.pathname,
      location.search,
      setCreateProjectOpen,
    ],
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
        if (!snapshot) return;
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

  const handleSwitchWorkspace = useCallback(async () => {
    try {
      if (useAgentPanelStore.getState().runningBinding) {
        showDshBusyFeedback();
        return;
      }
      if (!(await desktopApi.prepareVoiceLeave())) return;
      await flushRecordSaves();
      await desktopApi.flushOtherWorkspaceWindows();
      if (useAgentPanelStore.getState().runningBinding) {
        showDshBusyFeedback();
        return;
      }
      await desktopApi.destroyOtherWorkspaceWindows();
      const snapshot = await projectMindApi.workspaceClose();
      await applyWorkspaceStatus(snapshot, true);
      closeUnlockDialog(false);
      setCreateWorkspaceOpen(false);
      skipFocusSaveRouteRef.current = `${location.pathname}${location.search}`;
      navigate(workspacePath(), { replace: true });
    } catch (error) {
      const detail = String(error);
      setStatus({
        tone: "error",
        label: "Save failed",
        message: "切换 Workspace 已暂停；请重试 Record 保存",
      });
      pushToast({
        tone: "error",
        title: "切换 Workspace 失败",
        detail,
      });
    }
  }, [
    applyWorkspaceStatus,
    closeUnlockDialog,
    flushRecordSaves,
    location.pathname,
    location.search,
    navigate,
    pushToast,
    setStatus,
  ]);

  const handleCreateWorkspace = useCallback(async () => {
    if (!createWorkspaceRoot.trim()) {
      setCreateWorkspaceError("请选择 workspace 根目录。");
      return;
    }
    if (!isDebugBuild && !createWorkspacePassword.trim()) {
      setCreateWorkspaceError("请输入 workspace 密码。");
      return;
    }

    try {
      setCreateWorkspacePending(true);
      setCreateWorkspaceError(null);
      await flushRecordSaves();
      if (useAgentPanelStore.getState().runningBinding) {
        showDshBusyFeedback();
        return;
      }
      const snapshot = await projectMindApi.workspaceCreate({
        rootPath: createWorkspaceRoot.trim(),
        password: isDebugBuild ? "" : createWorkspacePassword,
      });
      await applyWorkspaceStatus(snapshot, true);
      setCreateWorkspaceOpen(false);
      setCreateWorkspaceRoot("");
      setCreateWorkspacePassword("");
      skipFocusSaveRouteRef.current = `${location.pathname}${location.search}`;
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
    location.pathname,
    location.search,
    pushToast,
    flushRecordSaves,
    setStatus,
  ]);

  const resolveProjectNavigationPath = useCallback(
    (projectId: number) =>
      projectRecentPaths[projectId] ?? projectPath(projectId),
    [projectRecentPaths],
  );

  const openProjectInTab = useCallback(
    async (projectId: number) => {
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
    ],
  );

  const prefetchProject = useCallback(
    (projectId: number) => {
      if (residentProjectIds.includes(projectId)) {
        return;
      }
      void Promise.all([
        todoModule.load({ kind: "current-project", projectId }),
        prefetchProjectPageData(queryClient, projectId),
      ]).catch(() => {
        // Prefetch failures are surfaced by the destination page query.
      });
    },
    [queryClient, residentProjectIds, todoModule],
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
      const route =
        activeProjectId === projectId
          ? `${location.pathname}${location.search}`
          : resolveProjectNavigationPath(projectId);

      try {
        if (currentWorkspace) await prepareProjectContentClose(currentWorkspace.rootPath, projectId);
        await openProjectInNewWindow(projectId, route);
      } catch {
        return;
      }
      closeProjectTab(projectId);

      if (activeProjectIdRef.current === projectId) {
        navigate(workspacePath());
      }
    },
    [
      activeProjectId,
      currentWorkspace?.rootPath,
      closeProjectTab,
      location.pathname,
      location.search,
      navigate,
      openProjectInNewWindow,
      resolveProjectNavigationPath,
    ],
  );

  const closeProjectTabAndMaybeNavigate = useCallback(
    async (projectId: number) => {
      try {
        if (currentWorkspace) await prepareProjectContentClose(currentWorkspace.rootPath, projectId);
      } catch (reason) {
        pushToast({ tone: "error", title: "项目内容尚不能关闭", detail: String(reason) });
        return;
      }
      closeProjectTab(projectId);
      if (activeProjectIdRef.current === projectId) {
        navigate(workspacePath());
      }
    },
    [closeProjectTab, navigate, currentWorkspace?.rootPath, pushToast],
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

      const { renameCanonicalRecord } = await import("./lib/canonical-record-metadata");
      await renameCanonicalRecord(currentWorkspace?.rootPath ?? "", { scope: { kind: "project", projectId }, recordId: record.id }, title);
      await refreshProjectScope(queryClient, projectId);
    },
    [activeProjectId, currentWorkspace?.rootPath, queryClient, refreshProjectScope],
  );

  const createProjectSidebarRecord = useCallback(async () => {
    if (activeProjectId === null) {
      return;
    }
    try {
      const { CanonicalRecordCreation, createBlankCanonicalRecord } = await import("./lib/canonical-record-creation");
      const creation = projectRecordCreationRef.current ??= new CanonicalRecordCreation();
      const { record } = await createBlankCanonicalRecord(currentWorkspace?.rootPath ?? "", { kind: "project", projectId: activeProjectId }, creation);
      await refreshProjectScope(queryClient, activeProjectId);
      creation.reset();
      navigate(preserveRecordFilters(recordPath(activeProjectId, record.id), location.search));
    } catch (error) { pushToast({ tone: "error", title: "新建记录失败", detail: String(error) }); }
  }, [activeProjectId, currentWorkspace?.rootPath, location.search, navigate, pushToast, queryClient, refreshProjectScope]);

  const deleteProjectSidebarRecord = useCallback(
    async (record: ProjectSidebarRecordItem) => {
      const projectId = record.projectId ?? activeProjectId;
      if (projectId === null) {
        return;
      }

      if (
        activeRecordId === record.id &&
        /^\/projects\/\d+\/records\/\d+$/u.test(location.pathname)
      ) {
        try {
          await flushRecordSaves();
        } catch (error) {
          pushToast({
            tone: "error",
            title: "删除前保存失败",
            detail: String(error),
          });
          return;
        }
      }

      await projectMindApi.projectRecordDelete({ noteId: record.id });
      await refreshProjectScope(queryClient, projectId);
      if (activeRecordId === record.id) {
        skipFocusSaveRouteRef.current = `${location.pathname}${location.search}`;
        navigate(projectPath(projectId));
      }
    },
    [
      activeProjectId,
      activeRecordId,
      flushRecordSaves,
      location.pathname,
      location.search,
      navigate,
      pushToast,
      queryClient,
      refreshProjectScope,
    ],
  );

  const handleSearchSelect = useCallback(
    async (result: WorkspaceSearchResult) => {
      setSearchInput("");
      if (result.kind === "project") {
        await openProjectInTab(result.projectId);
      } else if (result.kind === "contact") {
        openSettings("contacts");
      } else if (
        result.kind === "workspace_quick_note" ||
        result.kind === "workspace_note" ||
        (result.kind === "todo" && result.scope === "workspace")
      ) {
        const route = workspaceSearchResultRoute(result);
        if (route) {
          if (result.kind === "todo") {
            setTodoRailCollapsed(false);
          }
          navigate(route);
        }
      } else if (result.projectId !== null) {
        if (result.kind === "document" && currentWorkspace) {
          try {
            await openProjectContent({ workspaceRoot: currentWorkspace.rootPath, projectId: result.projectId,
              object: { kind: "file", id: result.id, title: result.title } });
          } catch (reason) { pushToast({ tone: "error", title: "打开文件失败", detail: String(reason) }); }
          return;
        }
        const route = workspaceSearchResultRoute(result);
        if (route) {
          if (result.kind === "todo") {
            setTodoRailCollapsed(false);
          } else if (result.kind === "document") {
            setProjectSidebarTab("files");
            setProjectSidebarCollapsed(false);
          }
          openProjectTab(result.projectId);
          navigate(route);
        }
      }
    },
    [
      activeProjectId,
      currentWorkspace?.rootPath,
      pushToast,
      navigate,
      openProjectInTab,
      openProjectTab,
      openSettings,
      setProjectSidebarCollapsed,
      setProjectSidebarTab,
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
  const recordFocusResidencyActive =
    cacheProjectOverviewPages && activeRecordFocusRoute !== null;

  useEffect(() => {
    if (recordSaveStatus.phase !== "idle") {
      return;
    }
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
    recordSaveStatus.phase,
    setStatus,
    visibleProjects.length,
  ]);

  useEffect(() => {
    const previousPhase = previousRecordSavePhaseRef.current;
    previousRecordSavePhaseRef.current = recordSaveStatus.phase;
    if (recordSaveStatus.phase === "saving") {
      reportedRecordSaveErrorRef.current = null;
      setStatus({
        tone: "warning",
        label: "Saving",
        message: `正在后台保存 ${recordSaveStatus.pendingCount} 条 Record 变更`,
      });
      return;
    }
    if (recordSaveStatus.phase === "error") {
      setStatus({
        tone: "error",
        label: "Save failed",
        message:
          recordSaveStatus.retryableFailedCount > 0
            ? `${recordSaveStatus.failedCount} 条 Record 保存失败，可重试`
            : `${recordSaveStatus.failedCount} 条 Record 保存失败，需要修正后重试`,
      });
      if (reportedRecordSaveErrorRef.current !== recordSaveStatus.lastError) {
        reportedRecordSaveErrorRef.current = recordSaveStatus.lastError;
        pushToast({
          tone: "error",
          title: "后台保存失败",
          detail: String(recordSaveStatus.lastError),
          action: recordSaveStatus.retryableFailedCount > 0
            ? { label: "重试保存", onClick: () => recordSaveCoordinator.retryFailed() }
            : undefined,
        });
      }
      return;
    }
    reportedRecordSaveErrorRef.current = null;
    if (previousPhase !== "idle") {
      setStatus({
        tone: "success",
        label: "Saved",
        message: "Record 后台保存已完成",
      });
    }
  }, [pushToast, recordSaveCoordinator, recordSaveStatus, setStatus]);

  useEffect(() => {
    if (activeProjectId !== null) {
      openProjectTab(activeProjectId);
    }
  }, [activeProjectId, openProjectTab]);

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
        if (!disposed) {
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
  }, [navigate, projectWindow]);

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
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void desktopApi
      .listenForWorkspaceLifecycleFlush(flushRecordSaves)
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushRecordSaves, hasWorkspace]);

  useEffect(() => {
    if (!hasWorkspace) {
      return;
    }

    void ensureAiJobSync();
  }, [hasWorkspace]);

  useEffect(() => {
    if (!hasWorkspace) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void desktopApi
      .listenForCloseRequest(async () => {
        try {
          if (!projectWindow && !(await desktopApi.prepareVoiceLeave())) return false;
          await flushRecordSaves();
          if (!projectWindow) {
            await desktopApi.flushOtherWorkspaceWindows();
          }
          return true;
        } catch (error) {
          setStatus({
            tone: "error",
            label: "Save failed",
            message: "退出已暂停；请重试 Record 保存",
          });
          pushToast({
            tone: "error",
            title: "退出前保存失败",
            detail: String(error),
          });
          return false;
        }
      })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    hasWorkspace,
    projectWindow,
    pushToast,
    flushRecordSaves,
    setStatus,
  ]);

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
      homePanels={location.pathname === workspacePath() || isProjectOverviewPath(location.pathname, activeProjectId) || activeRecordFocusRoute !== null ? { rightWidth: todoRailWidthPx, leftWidth: projectSidebarWidthPx, workspaceName: currentWorkspace.displayName || "Workspace", leftOpen: !projectSidebarCollapsed, rightOpen: !todoRailCollapsed, toggleLeft: () => setProjectSidebarCollapsed(!projectSidebarCollapsed), toggleRight: () => setTodoRailCollapsed(!todoRailCollapsed) } : undefined}
      projects={openedProjects}
      activeProjectId={activeProjectId}
      workspaceActive={workspaceActive}
      showWorkspace={workspaceVisible}
      settingsActive={settingsOpen}
      searchInput={searchInput}
      onSearchInput={setSearchInput}
      searchResults={currentSearchResults}
      searching={searchPending}
      searchError={searchQueryIsCurrent && searchQuery.isError}
      onOpenProject={(projectId) => {
        void openProjectInTab(projectId);
      }}
      onPrefetchProject={prefetchProject}
      onCloseProject={(projectId) => {
        void closeProjectTabAndMaybeNavigate(projectId);
      }}
      onOpenWorkspace={() => {
        navigate(workspacePath());
      }}
      onSwitchWorkspace={() => {
        void handleSwitchWorkspace();
      }}
      onOpenSettings={() => openSettings("page-width")}
      onSearchSelect={handleSearchSelect}
      onDetachProject={(projectId) => {
        void detachProjectToNewWindow(projectId);
      }}
    />
  );
  const mainContent = shouldShowEmpty ? (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <EmptyState
        title="ProjectMind"
        text="当前还没有项目。需要开始整理时再创建即可，后续记录、Todo 和文件都会围绕项目组织。"
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
  const workspaceResidentShellActive =
    workspaceOverviewActive || activeRecordFocusRoute?.kind === "workspace";
  const cachedWorkspaceResidentShell =
    cacheProjectOverviewPages && hasWorkspace ? (
      <div
        className="h-full min-h-0"
        data-workspace-resident-shell
        style={{ display: workspaceResidentShellActive ? undefined : "none" }}
        aria-hidden={workspaceResidentShellActive ? undefined : true}
        inert={!workspaceResidentShellActive}
      >
        {workspaceOverviewActive || workspaceOverviewResident ? (
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
        ) : null}
        <RecordFocusResidentPages projectId={null} />
      </div>
    ) : null;
  const cachedProjectResidentShells =
    cacheProjectOverviewPages && hasWorkspace && openedProjects.length > 0 ? (
      <>
        {openedProjects.map((project) => {
          const overviewActive =
            projectOverviewActive && activeProjectId === project.id;
          const focusActive =
            activeRecordFocusRoute?.kind === "project" &&
            activeRecordFocusRoute.projectId === project.id;
          const active = overviewActive || focusActive;
          const resident =
            active || residentProjectIds.includes(project.id);

          const route = active
            ? `${location.pathname}${location.search}`
            : (projectRecentPaths[project.id] ?? projectPath(project.id));
          const cachedSearchParams = getProjectOverviewSearchParams(route);

          return (
            <div
              key={project.id}
              className="h-full min-h-0"
              data-project-resident-id={project.id}
              data-project-resident-active={active ? "true" : "false"}
              style={{ display: active ? undefined : "none" }}
              aria-hidden={active ? undefined : true}
              inert={!active}
            >
              <ProjectContentWorkspace workspaceRoot={currentWorkspace.rootPath} projectId={project.id} active={active}
                overview={visible => resident ? (
                <ProjectOverviewPage
                  projectIdOverride={project.id}
                  searchParamsOverride={cachedSearchParams}
                  visible={visible}
                  onSearchParamsOverride={(nextSearchParams, options) => {
                    const nextRoute = buildProjectOverviewRoute(
                      project.id,
                      nextSearchParams,
                    );
                    rememberProjectRoute(project.id, nextRoute);

                    if (overviewActive) {
                      navigate(nextRoute, options);
                    }
                  }}
                />
                ) : null} />
            </div>
          );
        })}
      </>
    ) : null;
  return (
    <HomeWorkspaceActionsContext.Provider value={{ workspaceName: currentWorkspace.displayName || "Workspace", switchWorkspace: () => { void handleSwitchWorkspace(); }, openSettings: () => openSettings("page-width") }}>
    <RecordSaveCoordinatorProvider
      coordinator={recordSaveCoordinator}
      flushBarrier={flushRecordSaves}
    >
    <RecordFocusResidencyProvider
      residentProjectIds={residentProjectIds}
      workspaceKey={
        cacheProjectOverviewPages ? (currentWorkspace?.rootPath ?? null) : null
      }
    >
    <div className={`flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-bg-subtle${!projectWindow && (workspaceOverviewActive || projectOverviewActive || activeRecordFocusRoute !== null) ? " home-window-shell" : ""}`}>
      {projectWindow ? null : workspaceTopBar}

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {showProjectSidebarShell && (projectOverviewActive || activeRecordFocusRoute?.kind === "project") ? (
          <Suspense fallback={<aside className="home-side" style={{ width: projectSidebarWidthPx }} aria-label="项目导航侧边栏" />}><HomeProjectSidebar key={`${currentWorkspace.rootPath}:${activeProject.id}`}
            projectId={activeProject.id} projectName={activeProject.name} workspaceRoot={currentWorkspace.rootPath}
            project={activeProject} documents={projectSidebarDocuments}
            records={projectSidebarOverviewQuery.data?.records ?? []} selectedTagId={projectRecordTagId}
            activeRecordId={activeRecordId}
            onTagChange={(tagId) => updateProjectRecordFilters({ tagId })}
            onOpenWorkspace={() => navigate(workspacePath())}
            onOpenRecord={(recordId) => navigate(preserveRecordFilters(recordPath(activeProject.id, recordId), location.search))}
            onCreateRecord={() => void createProjectSidebarRecord()}
            onRenameRecord={async (id, title) => { const record = projectSidebarRecords.find(record => record.id === id); if (record) await renameProjectSidebarRecord(record, title); }}
            onDeleteRecord={async (id) => { const record = projectSidebarRecords.find(record => record.id === id); if (record) await deleteProjectSidebarRecord(record); }} /></Suspense>
        ) : showProjectSidebarShell ? (
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
            resident={cacheProjectOverviewPages}
            onActiveRecordTagIdChange={(tagId) => updateProjectRecordFilters({ tagId })}
            onOpenProject={() => {
              navigate(
                preserveRecordFilters(projectPath(activeProject.id), location.search),
              );
            }}
            onCreateRecord={() => {
              void createProjectSidebarRecord();
            }}
            onOpenRecord={(recordId) => {
              void (async () => {
                const isProjectRecordFocusPage =
                  parseRecordFocusRoute(location.pathname)?.kind === "project";

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

        <div className={`workspace-content-shell${agentPanelVisible ? " workspace-content-shell--agent" : ""}${agentPanelVisible && agentPanelExpanded ? " workspace-content-shell--expanded" : ""}`}>
          <main className="workspace-content-main" inert={agentPanelVisible && agentPanelExpanded}>
            <div className="h-full min-h-0 overflow-hidden">
              {cachedWorkspaceResidentShell}
              {cachedProjectResidentShells}
              {projectOverviewActive || workspaceOverviewActive || recordFocusResidencyActive
                ? null
                : mainContent}
            </div>
          </main>
          <AgentWorkspacePanel workspaceRoot={currentWorkspace.rootPath} workspaceName={currentWorkspace.displayName} currentProjectId={activeProjectId} />
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
        onSectionChange={setSettingsSection}
        onUnlockAiSecrets={requestUnlockAiSecrets}
        onClose={closeSettings}
      />

      <VoiceFloatingPanel
        target={activeProjectId === null ? { scope: "workspace" } : { scope: "project", projectId: activeProjectId }}
        targetLabel={activeProjectId === null ? " Workspace" : `项目「${activeProject?.name ?? "未命名"}」`}
        onOpenRecord={(snapshot) => {
          if (snapshot.projectNoteId !== null && activeProjectId !== null) {
            navigate(recordPath(activeProjectId, snapshot.projectNoteId));
          } else if (snapshot.workspaceNoteId !== null) {
            navigate(`/workspace/records/${snapshot.workspaceNoteId}`);
          }
        }}
        onChanged={async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
          await queryClient.invalidateQueries({ queryKey: ["voice-playback"] });
          if (activeProjectId !== null) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(activeProjectId) });
          }
        }}
      />

      <ProjectFilePreviewLayer currentProjectId={activeProjectId ?? null} workspaceRoot={currentWorkspace.rootPath} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
    </RecordFocusResidencyProvider>
    </RecordSaveCoordinatorProvider>
    </HomeWorkspaceActionsContext.Provider>
  );
}

export default WorkspaceLayout;

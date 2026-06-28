import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FolderKanban,
  FolderOpen,
  LockKeyhole,
  ShieldEllipsis,
  Sparkles,
} from "lucide-react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";

import type {
  DocumentRecord,
  NoteRecord,
  WorkspaceSearchResult,
  WorkspaceStatusSnapshot,
  WorkspaceSummary,
} from "./lib/types";
import { ensureAiJobSync, resetAiJobSync } from "./lib/aiJobs";
import {
  parseRouteId,
  parseFocusRecordId,
  projectPath,
  recordPath,
  recordFocusId,
  workspacePath,
} from "./lib/formatters";
import { generateDefaultProjectName } from "./lib/projectDefaultName";
import {
  getCurrentWindowLabel,
  isProjectWindow,
  parseProjectWindowProjectId,
  PROJECT_WINDOW_NAVIGATE_EVENT,
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
import {
  Button,
  Dialog,
  EmptyState,
  SurfaceCard,
  TextField,
} from "./ui/components";

function workspaceScopedQueryKeys() {
  return [
    ["projects"],
    ["project-page"],
    ["dashboard"],
    ["search"],
    ["workspace-todos"],
    ["workspace-page"],
    ["ai-settings"],
    ["ai-artifact"],
    ["rich-text-style"],
    ["file-tag-settings"],
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

function buildProjectOverviewRoute(projectId: number, searchParams: URLSearchParams) {
  const nextSearch = searchParams.toString();
  return `${projectPath(projectId)}${nextSearch ? `?${nextSearch}` : ""}`;
}

function WorkspaceGatePage({
  loading,
  recentWorkspaces,
  onOpenExisting,
  onCreateWorkspace,
  onOpenRecent,
}: {
  loading: boolean;
  recentWorkspaces: WorkspaceSummary[];
  onOpenExisting: () => void;
  onCreateWorkspace: () => void;
  onOpenRecent: (rootPath: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.12),_transparent_42%),linear-gradient(180deg,var(--color-bg)_0%,var(--color-bg-subtle)_100%)] px-6">
        <SurfaceCard className="w-full max-w-xl p-8 text-center">
          <p className="text-body text-text-soft">
            正在检查最近使用的 workspace...
          </p>
        </SurfaceCard>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.12),_transparent_42%),linear-gradient(180deg,var(--color-bg)_0%,var(--color-bg-subtle)_100%)] px-6 py-10">
      <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.9fr)]">
        <SurfaceCard className="grid gap-6 p-8">
          <div className="grid gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-[1.1rem] bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))] text-accent">
              <FolderKanban size={24} />
            </div>
            <div className="grid gap-2">
              <p className="text-caption font-medium uppercase tracking-[0.18em] text-text-soft">
                Workspace First
              </p>
              <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.03em] text-text">
                先打开一个 Workspace，再继续整理项目。
              </h1>
              <p className="max-w-2xl text-body leading-7 text-text-soft">
                所有项目、数据库、AI 缓存、日志和设置都会存放在同一个 workspace
                里的
                <code className="mx-1 rounded bg-bg-subtle px-1.5 py-0.5 text-ui">
                  .project-mind
                </code>
                隐藏目录中。复制整个 workspace
                后，另一台电脑也可以直接继续使用。
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="primary"
              size="md"
              leadingIcon={<FolderOpen size={16} />}
              onClick={onOpenExisting}
            >
              打开已有 Workspace
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="md"
              leadingIcon={<Sparkles size={16} />}
              onClick={onCreateWorkspace}
            >
              新建 Workspace
            </Button>
          </div>

          <div className="grid gap-3 rounded-[var(--radius-8)] border border-dashed border-border bg-bg-subtle/80 p-4">
            <p className="text-ui font-medium text-text">
              旧版本本地数据已清理
            </p>
            <p className="text-ui leading-6 text-text-soft">
              当前版本不再读取系统 app data
              中的历史业务库。后续请直接打开或创建新的 workspace。
            </p>
          </div>
        </SurfaceCard>

        <SurfaceCard className="grid gap-4 p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-caption font-medium uppercase tracking-[0.18em] text-text-soft">
                Recent
              </p>
              <h2 className="mt-1 text-title font-semibold text-text">
                最近使用的 Workspace
              </h2>
            </div>
            <ShieldEllipsis size={18} className="text-text-soft" />
          </div>

          {recentWorkspaces.length > 0 ? (
            <div className="grid gap-2">
              {recentWorkspaces.map((workspace) => (
                <button
                  key={workspace.rootPath}
                  type="button"
                  className="grid gap-1 rounded-[var(--radius-8)] border border-border bg-bg px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-bg-hover"
                  onClick={() => onOpenRecent(workspace.rootPath)}
                >
                  <p className="truncate text-body font-medium text-text">
                    {workspace.displayName}
                  </p>
                  <p className="break-all text-ui leading-6 text-text-soft">
                    {workspace.rootPath}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              title="还没有最近记录"
              text="先创建一个 workspace，或者打开一个已有目录。"
              icon={<FolderOpen size={16} />}
              className="min-h-40"
            />
          )}
        </SurfaceCard>
      </div>
    </div>
  );
}

function CreateWorkspaceDialog({
  open,
  rootPath,
  password,
  pending,
  error,
  onRootPathChange,
  onPasswordChange,
  onPickRoot,
  onClose,
  onSubmit,
}: {
  open: boolean;
  rootPath: string;
  password: string;
  pending: boolean;
  error: string | null;
  onRootPathChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onPickRoot: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建 Workspace"
      description="会在所选目录下创建 .project-mind 隐藏目录，并初始化数据库与配置。"
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={onSubmit}
          >
            {pending ? "创建中..." : "创建 Workspace"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <label className="grid gap-1.5">
          <span className="text-ui font-medium text-text-muted">
            Workspace 根目录
          </span>
          <div className="flex gap-2">
            <TextField
              value={rootPath}
              onChange={(event) => onRootPathChange(event.target.value)}
              placeholder="例如：/Users/alex/workspaces/customer-success"
              className="flex-1"
            />
            <Button type="button" variant="secondary" onClick={onPickRoot}>
              选择
            </Button>
          </div>
        </label>

        <label className="grid gap-1.5">
          <span className="text-ui font-medium text-text-muted">
            Workspace 密码
          </span>
          <TextField
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="用于加密保存的 AI API Key"
          />
        </label>

        {error ? (
          <div className="rounded-[var(--radius-8)] border border-danger/30 bg-danger/8 px-3 py-2 text-ui text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function UnlockWorkspaceSecretsDialog({
  open,
  pending,
  error,
  password,
  onPasswordChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  password: string;
  onPasswordChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="解锁 Workspace Secrets"
      description="输入当前 workspace 密码后，可以继续使用已保存的 AI API Key。"
      widthClassName="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={onSubmit}
          >
            {pending ? "解锁中..." : "解锁"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-ui font-medium text-text-muted">
            Workspace 密码
          </span>
          <TextField
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="输入密码后继续"
          />
        </label>

        {error ? (
          <div className="rounded-[var(--radius-8)] border border-danger/30 bg-danger/8 px-3 py-2 text-ui text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
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
    location.pathname === workspacePath() || /^\/workspace\/records\/\d+$/u.test(location.pathname);
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
    clearProjectRecentPaths,
    todoRailCollapsed,
  } = useUiStore();
  const { toasts, dismissToast, pushToast, setStatus } = useFeedbackStore();

  const workspaceStatusQuery = useQuery({
    queryKey: ["workspace-status"],
    queryFn: projectMindApi.workspaceStatusGet,
  });
  const currentWorkspace = workspaceStatusQuery.data?.currentWorkspace ?? null;
  const hasWorkspace = Boolean(currentWorkspace);

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: hasWorkspace,
  });
  const richTextStyleQuery = useQuery({
    queryKey: ["rich-text-style"],
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
    queryKey: ["project-page", activeProjectId],
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
    queryKey: ["search", debouncedSearch],
    queryFn: () => projectMindApi.workspaceSearch({ query: debouncedSearch }),
    enabled: hasWorkspace && debouncedSearch.trim().length > 0,
  });

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
        clearProjectRecentPaths();
        resetAiJobSync();
      }
      queryClient.setQueryData(["workspace-status"], snapshot);
      if (!clearScopedState) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["workspace-status"] }),
          queryClient.invalidateQueries({ queryKey: ["ai-settings"] }),
          queryClient.invalidateQueries({ queryKey: ["projects", "all"] }),
        ]);
      }
      if (snapshot.currentWorkspace) {
        void ensureAiJobSync();
      }
    },
    [clearProjectRecentPaths, queryClient],
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
      if (!projectWindow) {
        const focused = await desktopApi.focusProjectWindow(projectId);
        if (focused) {
          return;
        }
      }

      openProjectTab(projectId);
      navigate(resolveProjectNavigationPath(projectId));
    },
    [navigate, openProjectTab, projectWindow, resolveProjectNavigationPath],
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
    ],
  );

  const closeProjectTabAndMaybeNavigate = useCallback(
    (projectId: number) => {
      closeProjectTab(projectId);
      if (activeProjectId === projectId) {
        navigate(workspacePath());
      }
    },
    [activeProjectId, closeProjectTab, navigate],
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

    const record = await projectMindApi.projectRecordUpsert({
      projectId: activeProjectId,
      markdown: "",
      html: "<p></p>",
      tagIds: [],
    });
    await refreshProjectScope(queryClient, activeProjectId);
    navigate(recordPath(activeProjectId, record.id));
  }, [activeProjectId, navigate, queryClient, refreshProjectScope]);

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
    (result: WorkspaceSearchResult) => {
      setSearchInput("");
      if (result.kind === "project") {
        openProjectInTab(result.projectId);
      } else if (result.kind === "note") {
        openProjectTab(result.projectId);
        navigate(projectPath(result.projectId, recordFocusId(result.id)));
      } else if (result.kind === "todo") {
        openProjectTab(result.projectId);
        navigate(projectPath(result.projectId, `todo-${result.id}`));
      } else if (result.kind === "document") {
        openProjectTab(result.projectId);
        navigate(projectPath(result.projectId, `document-${result.id}`));
      }
    },
    [navigate, openProjectInTab, openProjectTab],
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
    if (!projectWindow || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void import("@tauri-apps/api")
      .then((api) =>
        api.webviewWindow.getCurrentWebviewWindow().listen<{ route: string }>(
          PROJECT_WINDOW_NAVIGATE_EVENT,
          ({ payload }: { payload: { route: string } }) => {
            if (disposed || !payload?.route) {
              return;
            }

            navigate(payload.route);
          },
        ),
      )
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
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
      searchResults={searchQuery.data ?? []}
      searching={searchQuery.isLoading}
      onOpenProject={(projectId) => {
        void openProjectInTab(projectId);
      }}
      onCloseProject={closeProjectTabAndMaybeNavigate}
      onOpenToday={() => navigate(workspacePath())}
      onOpenSettings={() => openSettings("file-tags", activeProjectId)}
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
  const cachedProjectOverviewPages =
    cacheProjectOverviewPages && hasWorkspace && openedProjects.length > 0 ? (
      <>
        {openedProjects.map((project) => {
          const active = projectOverviewActive && activeProjectId === project.id;
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
            onOpenProject={() => navigate(projectPath(activeProject.id))}
            onCreateRecord={() => {
              void createProjectSidebarRecord();
            }}
            onOpenRecord={(recordId) =>
              navigate(projectPath(activeProject.id, recordFocusId(recordId)))
            }
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
            {cachedProjectOverviewPages}
            {projectOverviewActive ? null : mainContent}
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import type { WorkspaceSearchResult } from "./lib/types";
import { activityPath, parseRouteId, projectPath } from "./lib/formatters";
import {
  DEFAULT_RICH_TEXT_STYLE_SETTINGS,
  applyRichTextStyleVariables,
} from "./lib/richTextStyle";
import { projectMindApi } from "./services/projectMindApi";
import { useFeedbackStore } from "./state/feedback-store";
import { useUiStore } from "./state/ui-store";
import { useProjectMutations } from "./hooks/useProjectMutations";
import { useDebouncedValue } from "./hooks/useUtilityHooks";
import { StatusBar } from "./components/layout/StatusBar";
import { WorkspaceTopBar } from "./components/layout/WorkspaceTopBar";
import { ToastStack } from "./components/layout/ToastStack";
import { CreateProjectModal } from "./components/project/CreateProjectModal";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { Button, EmptyState } from "./ui/components";

export function WorkspaceLayout() {
  const navigate = useNavigate();
  const params = useParams();
  const activeProjectId = parseRouteId(params.projectId);

  const {
    createProjectOpen,
    setCreateProjectOpen,
    settingsOpen,
    settingsSection,
    openSettings,
    closeSettings,
    setSettingsSection,
  } = useUiStore();
  const { toasts, dismissToast, setStatus } = useFeedbackStore();

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
  });
  const richTextStyleQuery = useQuery({
    queryKey: ["rich-text-style"],
    queryFn: projectMindApi.richTextStyleGet,
  });

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((p) => !p.isArchived),
    [projectsQuery.data],
  );

  const archivedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((p) => p.isArchived),
    [projectsQuery.data],
  );

  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 260);
  const searchQuery = useQuery({
    queryKey: ["search", debouncedSearch],
    queryFn: () => projectMindApi.workspaceSearch({ query: debouncedSearch }),
    enabled: debouncedSearch.trim().length > 0,
  });

  const searchGroups = useMemo(() => {
    if (!searchQuery.data) return [];
    const groups = new Map<string, WorkspaceSearchResult[]>();
    for (const result of searchQuery.data) {
      const group = groups.get(result.kind) ?? [];
      group.push(result);
      groups.set(result.kind, group);
    }
    return Array.from(groups.entries());
  }, [searchQuery.data]);

  const [archiveOpen, setArchiveOpen] = useState(false);

  const { createProjectMutation, archiveMutation } = useProjectMutations(
    visibleProjects,
    (path, options) => navigate(path, options),
  );

  const handleSearchSelect = useCallback(
    (result: WorkspaceSearchResult) => {
      setSearchInput("");
      if (result.kind === "project") {
        navigate(projectPath(result.projectId));
      } else if (result.kind === "activity") {
        navigate(activityPath(result.projectId, result.id));
      } else if (result.kind === "todo") {
        if (result.activityId) {
          navigate(activityPath(result.projectId, result.activityId, `todo-${result.id}`));
        } else {
          navigate(projectPath(result.projectId, `todo-${result.id}`));
        }
      } else if (result.kind === "conclusion") {
        if (result.activityId) {
          navigate(
            activityPath(result.projectId, result.activityId, `conclusion-${result.id}`),
          );
        } else {
          navigate(projectPath(result.projectId, `conclusion-${result.id}`));
        }
      } else if (result.kind === "document") {
        if (result.activityId) {
          navigate(
            activityPath(result.projectId, result.activityId, `document-${result.id}`),
          );
        } else {
          navigate(projectPath(result.projectId, `document-${result.id}`));
        }
      }
    },
    [navigate],
  );

  const shouldShowEmpty = !projectsQuery.isLoading && visibleProjects.length === 0 && !activeProjectId;
  const shouldAutoNavigate =
    !projectsQuery.isLoading && visibleProjects.length > 0 && !activeProjectId;

  useEffect(() => {
    if (!projectsQuery.isLoading) {
      setStatus({
        tone: "neutral",
        label: "Ready",
        message:
          visibleProjects.length > 0
            ? "工作台已就绪，可继续记录与整理"
            : "工作台已就绪，需要时再创建项目",
      });
    }
  }, [projectsQuery.isLoading, setStatus, visibleProjects.length]);

  useEffect(() => {
    if (shouldAutoNavigate) {
      const first = visibleProjects[0];
      navigate(projectPath(first.id), { replace: true });
    }
  }, [navigate, shouldAutoNavigate, visibleProjects]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    applyRichTextStyleVariables(
      document.documentElement,
      richTextStyleQuery.data ?? DEFAULT_RICH_TEXT_STYLE_SETTINGS,
    );
  }, [richTextStyleQuery.data]);

  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-bg-subtle">
      <WorkspaceTopBar
        projects={visibleProjects}
        activeProjectId={activeProjectId}
        settingsActive={settingsOpen}
        archivedProjects={archivedProjects}
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        searchGroups={searchGroups}
        searching={searchQuery.isLoading}
        archiveOpen={archiveOpen}
        onToggleArchive={() => setArchiveOpen(!archiveOpen)}
        onCloseArchive={() => setArchiveOpen(false)}
        onOpenProject={(id) => navigate(projectPath(id))}
        onRestoreProject={(id) => archiveMutation.mutate({ projectId: id, isArchived: false })}
        onCreateProject={() => setCreateProjectOpen(true)}
        onOpenSettings={() => openSettings("activity")}
        onSearchSelect={handleSearchSelect}
      />

      <main className="min-h-0 flex-1 overflow-hidden">
        {shouldShowEmpty ? (
          <div className="flex h-full items-center justify-center px-6 py-10">
            <EmptyState
              title="Project Mind"
              text="当前还没有项目。需要开始整理时再创建即可，后续活动、结论、待办和文件都会围绕项目组织。"
              icon={<FolderKanban size={18} />}
              action={
                <Button type="button" variant="primary" onClick={() => setCreateProjectOpen(true)}>
                  创建项目
                </Button>
              }
              className="w-full max-w-xl"
            />
          </div>
        ) : (
          <Outlet />
        )}
      </main>

      {createProjectOpen ? (
        <CreateProjectModal
          onClose={() => setCreateProjectOpen(false)}
          onSubmit={(input) => createProjectMutation.mutate(input)}
          isPending={createProjectMutation.isPending}
        />
      ) : null}

      <SettingsDialog
        open={settingsOpen}
        activeSection={settingsSection}
        onSectionChange={setSettingsSection}
        onClose={closeSettings}
      />

      <StatusBar
        context={
          activeProjectId !== null
            ? visibleProjects.find((project) => project.id === activeProjectId)?.name ?? null
            : null
        }
        detail={`${visibleProjects.length} projects`}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default WorkspaceLayout;

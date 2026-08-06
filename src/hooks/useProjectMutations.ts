import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { useUiStore } from "../state/ui-store";
import type { ProjectListItem } from "../lib/types";
import { queryKeys } from "../lib/queryKeys";
import { syncProjectArchiveCaches } from "./project-archive-query-cache";

function refreshProjectScope(queryClient: ReturnType<typeof useQueryClient>, projectId: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage }),
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTodos }),
    queryClient.invalidateQueries({ queryKey: ["ai-artifact"] }),
  ]);
}

export function useProjectMutations(
  visibleProjects: ProjectListItem[],
  navigate: (path: string, options?: { replace?: boolean }) => void,
) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const { setCreateProjectOpen } = useUiStore();

  const createProjectMutation = useMutation({
    mutationFn: projectMindApi.projectCreate,
    onSuccess: async (project) => {
      setStatus({ tone: "success", label: "Created", message: `项目 ${project.name} 已创建` });
      pushToast({ tone: "success", title: "项目已创建", detail: project.name });
      setCreateProjectOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      navigate(`/projects/${project.id}?renameProject=1`);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "创建项目失败" });
      pushToast({ tone: "error", title: "创建项目失败", detail: String(error) });
    },
  });

  const projectUpdateMutation = useMutation({
    mutationFn: projectMindApi.projectUpdate,
    onSuccess: async (_, input) => {
      setStatus({ tone: "success", label: "Synced", message: "项目信息已同步" });
      await refreshProjectScope(queryClient, input.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存项目信息失败" });
      pushToast({ tone: "error", title: "保存项目信息失败", detail: String(error) });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: projectMindApi.projectSetArchive,
    onSuccess: async (project) => {
      syncProjectArchiveCaches(queryClient, project);
      setStatus({
        tone: "success",
        label: project.isArchived ? "Archived" : "Restored",
        message: project.isArchived ? "项目已归档" : "项目已恢复",
      });
      pushToast({
        tone: "success",
        title: project.isArchived ? "项目已归档" : "项目已恢复",
        detail: project.name,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(project.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTodos });
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiArtifacts });
      if (project.isArchived) {
        const nextProject = visibleProjects.find((item) => item.id !== project.id);
        if (nextProject) navigate(`/projects/${nextProject.id}`);
      } else {
        navigate(`/projects/${project.id}`);
      }
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新归档状态失败" });
      pushToast({ tone: "error", title: "更新归档状态失败", detail: String(error) });
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: projectMindApi.projectDelete,
    onSuccess: async (project) => {
      setStatus({ tone: "success", label: "Deleted", message: "项目已删除" });
      pushToast({ tone: "success", title: "项目已删除", detail: project.name });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTodos });
      await queryClient.invalidateQueries({ queryKey: ["ai-artifact"] });
      navigate("/workspace");
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除项目失败" });
      pushToast({ tone: "error", title: "删除项目失败", detail: String(error) });
    },
  });

  return {
    createProjectMutation,
    projectUpdateMutation,
    archiveMutation,
    deleteProjectMutation,
    refreshProjectScope,
  };
}

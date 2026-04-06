import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { useUiStore } from "../state/ui-store";
import type { ProjectListItem } from "../lib/types";

function refreshProjectScope(queryClient: ReturnType<typeof useQueryClient>, projectId: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["projects", "all"] }),
    queryClient.invalidateQueries({ queryKey: ["overview", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["activities", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard", projectId] }),
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
      await queryClient.invalidateQueries({ queryKey: ["projects", "all"] });
      navigate(`/projects/${project.id}`);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "创建项目失败" });
      pushToast({ tone: "error", title: "创建项目失败", detail: String(error) });
    },
  });

  const summaryMutation = useMutation({
    mutationFn: projectMindApi.projectUpdateSummary,
    onSuccess: async (_, input) => {
      setStatus({ tone: "success", label: "Saved", message: "项目摘要已保存" });
      await refreshProjectScope(queryClient, input.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存摘要失败" });
      pushToast({ tone: "error", title: "保存摘要失败", detail: String(error) });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: projectMindApi.projectSetArchive,
    onSuccess: async (project) => {
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
      await queryClient.invalidateQueries({ queryKey: ["projects", "all"] });
      await queryClient.invalidateQueries({ queryKey: ["overview", project.id] });
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

  return { createProjectMutation, summaryMutation, archiveMutation, refreshProjectScope };
}

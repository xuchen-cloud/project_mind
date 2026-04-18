import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { refreshAll } from "./shared";
import type { TodoRecord } from "../lib/types";

export function useTodoMutations(allTodos?: TodoRecord[]) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const todoMutation = useMutation({
    mutationFn: projectMindApi.todoCreate,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Created", message: "待办已创建" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "新增待办失败" });
      pushToast({ tone: "error", title: "新增待办失败", detail: String(error) });
    },
  });

  const todoContentMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateContent,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Saved", message: "待办内容已更新" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新待办内容失败" });
      pushToast({ tone: "error", title: "更新待办内容失败", detail: String(error) });
    },
  });

  const todoActivityMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateActivity,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Moved", message: "待办归属已更新" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新待办归属失败" });
      pushToast({ tone: "error", title: "更新待办归属失败", detail: String(error) });
    },
  });

  const todoStatusMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateStatus,
    onSuccess: async (todo) => {
      setStatus({
        tone: "success",
        label: todo.status === "finished" ? "Completed" : "Active",
        message: "待办状态已更新",
      });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新待办失败" });
      pushToast({ tone: "error", title: "更新待办失败", detail: String(error) });
    },
  });

  const todoPriorityMutation = useMutation({
    mutationFn: projectMindApi.todoUpdatePriority,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Priority", message: "待办优先级已更新" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新待办优先级失败" });
      pushToast({ tone: "error", title: "更新待办优先级失败", detail: String(error) });
    },
  });

  const todoProgressMutation = useMutation({
    mutationFn: projectMindApi.todoAddProgress,
    onSuccess: async (_, variables) => {
      const source = allTodos?.find((t) => t.id === variables.todoId);
      if (!source) return;
      setStatus({ tone: "success", label: "Updated", message: "进展已追加" });
      await refreshAll(queryClient, source.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "追加进展失败" });
      pushToast({ tone: "error", title: "追加进展失败", detail: String(error) });
    },
  });

  const todoProgressUpdateMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateProgress,
    onSuccess: async (_, variables) => {
      const source = allTodos?.find((todo) =>
        todo.progresses.some((progress) => progress.id === variables.progressId),
      );
      if (!source) return;
      setStatus({ tone: "success", label: "Updated", message: "进展已更新" });
      await refreshAll(queryClient, source.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新进展失败" });
      pushToast({ tone: "error", title: "更新进展失败", detail: String(error) });
    },
  });

  const todoProgressDeleteMutation = useMutation({
    mutationFn: projectMindApi.todoDeleteProgress,
    onSuccess: async (_, variables) => {
      const source = allTodos?.find((todo) =>
        todo.progresses.some((progress) => progress.id === variables.progressId),
      );
      if (!source) return;
      setStatus({ tone: "success", label: "Deleted", message: "进展已删除" });
      await refreshAll(queryClient, source.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除进展失败" });
      pushToast({ tone: "error", title: "删除进展失败", detail: String(error) });
    },
  });

  const todoDeleteMutation = useMutation({
    mutationFn: projectMindApi.todoDelete,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Deleted", message: "待办已删除" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除待办失败" });
      pushToast({ tone: "error", title: "删除待办失败", detail: String(error) });
    },
  });

  return {
    todoMutation,
    todoContentMutation,
    todoActivityMutation,
    todoStatusMutation,
    todoPriorityMutation,
    todoProgressMutation,
    todoProgressUpdateMutation,
    todoProgressDeleteMutation,
    todoDeleteMutation,
  };
}
